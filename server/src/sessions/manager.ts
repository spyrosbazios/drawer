/**
 * The session state machine (docs/SPEC.md → Agent sessions).
 *
 *   queued ──claim──▶ working ◀──answer── waiting
 *      ▲                 │  └──question──▶ ▲
 *      │                 ├──▶ idle / failed (runner patch); queued again if messages are pending
 *      └── message ◀── stopped / idle / failed          stop: working|waiting|queued|idle ──▶ stopped
 *
 * A failed turn with messages pending is queued again (the error stays as a `notice` item). Only the
 * runner process that claimed a session (its id and boot nonce) may write to it.
 *
 * Every mutation is synchronous on the in-memory record; the disk writes are queued per session, in
 * order, and a request answers only after its writes landed.
 */
import type {
  AnswerBody,
  Author,
  CreateSessionBody,
  DrawerEvent,
  FileAttachmentBody,
  FileAttachmentResult,
  NewSessionItem,
  RunnerInfo,
  RunnerSessionPatch,
  RunnersResponse,
  RunnerWork,
  Session,
  SessionDetail,
  SessionAttachment,
  SessionItem,
  SessionMessageBody,
  SessionRef,
} from "@drawer/shared/api";
import { ApiException, invalid, notFound } from "../errors.ts";
import { errorMessage, randomId } from "../util.ts";
import { Attachments, type StoredAttachment } from "./attachments.ts";
import { SessionFiles, type LoadedSession, type StoredSession } from "./storage.ts";
import type { RunnerIdentity, RunnerQuery, Sessions, SessionsOptions } from "./types.ts";

const DEFAULT_RUNNER_TTL_MS = 60_000;
const DEFAULT_SWEEP_MS = 5_000;
const TITLE_MAX = 80;

/** Items a later append of the same thing replaces: a tool call by its callId, a thought by its reasoningId. */
type Replaceable = Extract<NewSessionItem, { type: "tool" | "reasoning" }>;

const isReplaceable = (item: NewSessionItem): item is Replaceable => item.type === "tool" || item.type === "reasoning";

const replaceKey = (item: Replaceable): string => (item.type === "tool" ? `tool:${item.callId}` : `reasoning:${item.reasoningId}`);

/** An item before the server gives it its `seq` and `at`. */
type ItemBody = SessionItem extends infer T ? (T extends unknown ? Omit<T, "seq" | "version" | "at"> : never) : never;

interface Rec {
  session: Session;
  /** Ordered by seq. */
  items: SessionItem[];
  /** Items a later append replaces (tool calls, reasoning) by `replaceKey` → their index in `items`. */
  replaceable: Map<string, number>;
  resume: string | null;
  /**
   * The runner process that claimed the latest turn. It stays after the turn ends or is stopped (a
   * stopped turn may still store its resume handle) and goes when another claim replaces it or the
   * process is known to be gone.
   */
  holder: RunnerIdentity | null;
  /** Counts claims, so an undo can tell its claim is still the latest. */
  claims: number;
  handedSeq: number;
  /** Position in the queue of sessions waiting for a runner. */
  queueOrder: number;
  /** The last disk write; the next one starts after it. */
  chain: Promise<void>;
}

interface Runner {
  info: RunnerInfo;
  boot: string;
  seenAt: number;
}

/** What a claim changed, to put back when its response never reached the runner. */
interface Claim {
  rec: Rec;
  claim: number;
  handedSeq: number;
  queueOrder: number;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? text;
  return line.trim().slice(0, TITLE_MAX);
}

export class SessionManager implements Sessions {
  private readonly files: SessionFiles;
  private readonly attachments: Attachments;
  private readonly recs = new Map<string, Rec>();
  private readonly runnerMap = new Map<string, Runner>();
  /** Stops a person asked for, per runner, not yet handed to it. */
  private readonly stops = new Map<string, Set<string>>();
  private readonly wakers = new Set<() => void>();
  private readonly ttlMs: number;
  private readonly sweepMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private lastStamp = 0;
  private queueCounter = 0;

  constructor(private readonly opts: SessionsOptions) {
    this.files = new SessionFiles(`${opts.dataDir}/sessions`);
    this.attachments = new Attachments(`${opts.dataDir}/sessions/attachments`);
    this.ttlMs = opts.runnerTtlMs ?? DEFAULT_RUNNER_TTL_MS;
    this.sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS;
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  async init(): Promise<void> {
    await this.files.ensureDir();
    const loaded = (await this.files.loadAll()).sort((a, b) => a.session.updatedAt.localeCompare(b.session.updatedAt));
    for (const entry of loaded) {
      const rec = this.fromDisk(entry);
      this.recs.set(rec.session.id, rec);
      if (rec.session.status === "working" || rec.session.status === "waiting") {
        this.failTurn(rec, "the server restarted during the turn");
      } else if (rec.session.status === "queued") {
        rec.queueOrder = ++this.queueCounter;
      }
    }
    await this.attachments.init();
    await this.sweepAttachments();
    this.unsubscribe = this.opts.bus.subscribe((event) => {
      if (event.type === "project" && event.action === "deleted") this.dropProject(event.slug);
      // A provider turned on may have queued sessions waiting for it.
      if (event.type === "settings") this.wake();
    });
    this.sweepTimer = setInterval(() => {
      this.expireRunners();
      void this.sweepAttachments();
    }, this.sweepMs);
    this.sweepTimer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.wake();
  }

  /** Drops unsent uploads past their time and attachments of sessions that are gone. Never throws. */
  private async sweepAttachments(): Promise<void> {
    try {
      await this.attachments.sweep((id) => this.recs.has(id));
    } catch (err) {
      console.error(`sessions: sweeping attachments failed: ${errorMessage(err)}`);
    }
  }

  private fromDisk(entry: LoadedSession): Rec {
    const { items, ...stored } = entry;
    const session: Session = { ...stored.session };
    session.seq = items.reduce((max, item) => Math.max(max, item.seq), 0);
    session.version = items.reduce((max, item) => Math.max(max, item.version), 0);
    session.pending = items.filter((i) => i.type === "user" && i.seq > stored.handedSeq).length;
    this.lastStamp = Math.max(this.lastStamp, Date.parse(session.updatedAt) || 0);
    const replaceable = new Map<string, number>();
    for (const [index, item] of items.entries()) if (item.type === "tool" || item.type === "reasoning") replaceable.set(replaceKey(item), index);
    return { session, items, replaceable, resume: stored.resume, holder: null, claims: 0, handedSeq: stored.handedSeq, queueOrder: 0, chain: Promise.resolve() };
  }

  // ---- for people ---------------------------------------------------------------------------

  list(project: string | null): Session[] {
    return [...this.recs.values()]
      .filter((rec) => project === null || rec.session.project === project)
      .map((rec) => ({ ...rec.session }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(project: string, body: CreateSessionBody, author: Author): Promise<Session> {
    const settings = this.opts.settings();
    const provider = body.provider ?? settings.defaultProvider;
    const chosen = settings.providers[provider];
    if (!chosen.enabled) throw invalid(`${provider} is turned off in settings`);
    if (!(await this.opts.projectExists(project))) throw notFound(`no such project: ${project}`);
    const now = this.stamp();
    let id = randomId().slice(0, 12);
    while (this.recs.has(id)) id = randomId().slice(0, 12);
    const taken = this.attachments.take(body.attachments ?? [], project, id);
    const rec: Rec = {
      session: {
        id,
        project,
        title: firstLine(body.message) || (taken[0]?.attachment.name ?? "").slice(0, TITLE_MAX),
        provider,
        model: body.model ?? chosen.defaultModel,
        status: "queued",
        activity: null,
        pending: 0,
        toolCalls: 0,
        seq: 0,
        version: 0,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
      items: [],
      replaceable: new Map(),
      resume: null,
      holder: null,
      claims: 0,
      handedSeq: 0,
      queueOrder: ++this.queueCounter,
      chain: Promise.resolve(),
    };
    this.recs.set(id, rec);
    this.addUserItem(rec, body.message, body.refs ?? [], taken, author);
    this.changed(rec);
    this.save(rec);
    await rec.chain;
    return { ...rec.session };
  }

  detail(id: string, since: number): SessionDetail {
    const rec = this.get(id);
    return { session: { ...rec.session }, items: rec.items.filter((item) => item.version > since) };
  }

  async addMessage(id: string, body: SessionMessageBody, author: Author): Promise<Session> {
    const rec = this.get(id);
    const taken = this.attachments.take(body.attachments ?? [], rec.session.project, id);
    this.addUserItem(rec, body.text, body.refs ?? [], taken, author);
    const status = rec.session.status;
    if (status === "stopped" || status === "idle" || status === "failed") this.queue(rec);
    this.changed(rec);
    this.save(rec);
    await rec.chain;
    return { ...rec.session };
  }

  async stop(id: string): Promise<Session> {
    const rec = this.get(id);
    const status = rec.session.status;
    if (status === "working" || status === "waiting") {
      if (rec.holder !== null) this.requestStop(rec.holder.runner, id);
      this.settle(rec, "stopped");
    } else if (status === "queued" || status === "idle") {
      this.settle(rec, "stopped");
    } else {
      return { ...rec.session };
    }
    this.changed(rec);
    this.save(rec);
    await rec.chain;
    return { ...rec.session };
  }

  async answer(id: string, body: AnswerBody): Promise<Session> {
    const rec = this.get(id);
    const index = rec.items.findIndex((item) => item.type === "question" && item.questionId === body.questionId);
    const item = rec.items[index];
    if (item === undefined || item.type !== "question") throw notFound(`no such question: ${body.questionId}`);
    if (item.answer !== null) throw new ApiException("conflict", `question ${body.questionId} was already answered`);
    rec.items[index] = { ...item, answer: body.answer, version: this.nextVersion(rec) };
    const open = rec.items.some((i) => i.type === "question" && i.answer === null);
    if (rec.session.status === "waiting" && !open) rec.session.status = "working";
    this.changed(rec);
    this.saveItem(rec, rec.items[index] as SessionItem);
    this.save(rec);
    await rec.chain;
    return { ...rec.session };
  }

  async remove(id: string): Promise<void> {
    const rec = this.get(id);
    this.drop(rec);
    await rec.chain.catch(() => undefined);
    await this.files.remove(id);
    await this.attachments.removeWhere((s) => s.session === id);
  }

  async upload(project: string, name: string, bytes: Uint8Array): Promise<SessionAttachment> {
    if (!(await this.opts.projectExists(project))) throw notFound(`no such project: ${project}`);
    return this.attachments.upload(project, name, bytes);
  }

  attachment(id: string): { attachment: SessionAttachment; file: string } {
    return { attachment: { ...this.attachments.get(id).attachment }, file: this.attachments.data(id) };
  }

  async fileAttachment(id: string, body: FileAttachmentBody, author: Author): Promise<FileAttachmentResult> {
    const stored = this.attachments.get(id);
    const bytes = await Bun.file(this.attachments.data(id)).bytes();
    const from = stored.session === null ? "an upload" : `session ${stored.session}`;
    const message = body.message ?? `file ${stored.attachment.name} from ${from}`;
    const write = await this.opts.writeFile(stored.project, body.path, bytes, { rev: body.rev, author, message });
    const attachment = await this.attachments.markFiled(stored, write.path);
    const rec = stored.session === null ? undefined : this.recs.get(stored.session);
    const index = rec === undefined ? -1 : rec.items.findIndex((item) => item.seq === stored.seq);
    const item = rec?.items[index];
    if (rec !== undefined && item?.type === "user") {
      const updated: SessionItem = { ...item, attachments: item.attachments.map((a) => (a.id === id ? attachment : a)), version: this.nextVersion(rec) };
      rec.items[index] = updated;
      this.changed(rec);
      this.saveItem(rec, updated);
      this.save(rec);
      await rec.chain;
    }
    return { attachment, write };
  }

  private dropProject(slug: string): void {
    for (const rec of [...this.recs.values()]) {
      if (rec.session.project !== slug) continue;
      this.drop(rec);
      void rec.chain
        .catch(() => undefined)
        .then(() => this.files.remove(rec.session.id))
        .then(() => this.attachments.removeWhere((s) => s.session === rec.session.id))
        .catch((err: unknown) => console.error(`sessions: removing ${rec.session.id} failed: ${errorMessage(err)}`));
    }
    void this.attachments
      .removeWhere((s) => s.project === slug && s.session === null)
      .catch((err: unknown) => console.error(`sessions: removing uploads of ${slug} failed: ${errorMessage(err)}`));
  }

  /** Forgets a session; a runner still holding it is told to stop. */
  private drop(rec: Rec): void {
    this.recs.delete(rec.session.id);
    const s = rec.session;
    if ((s.status === "working" || s.status === "waiting") && rec.holder !== null) this.requestStop(rec.holder.runner, s.id);
    this.opts.bus.emit({ type: "session", id: s.id, project: s.project, status: s.status, activity: null, version: s.version, deleted: true });
    this.wake();
  }

  // ---- runners ------------------------------------------------------------------------------

  runners(): RunnersResponse {
    this.expireRunners();
    return { runners: [...this.runnerMap.values()].map((r) => ({ ...r.info, providers: r.info.providers.map((p) => ({ ...p, models: [...p.models] })) })) };
  }

  async work(query: RunnerQuery, signal: AbortSignal): Promise<RunnerWork> {
    this.seen(query);
    const guide = await this.guide();
    const last: { claim: Claim | null } = { claim: null };
    const work = await this.pollUntil(query.wait, signal, () => {
      this.seen(query);
      const next = this.nextWork(query, guide);
      last.claim = next?.claim ?? null;
      return next?.work ?? null;
    });
    this.seen(query);
    if (work?.kind === "turn") await this.recs.get(work.session.id)?.chain;
    // The runner went away before it could get the answer: nobody runs this work, so put it back.
    if (work !== null && signal.aborted) {
      if (work.kind === "stop") this.requestStop(query.runner, work.sessionId);
      if (last.claim !== null) await this.unclaim(last.claim);
      return null;
    }
    return work;
  }

  /** Records a poll. A known runner id with a new boot means its old process is gone, with its turns. */
  private seen(query: RunnerQuery): void {
    const now = Date.now();
    const known = this.runnerMap.get(query.runner);
    if (known === undefined || known.boot !== query.boot) this.restarted(query);
    this.runnerMap.set(query.runner, {
      info: { id: query.runner, providers: query.providers.map((p) => ({ ...p, models: [...p.models] })), accepting: query.accepting, lastSeen: new Date(now).toISOString() },
      boot: query.boot,
      seenAt: now,
    });
  }

  /** Fails what another process with this runner id still held, and drops the stops meant for it. */
  private restarted(current: RunnerIdentity): void {
    let stale = false;
    for (const rec of this.recs.values()) {
      if (rec.holder === null || rec.holder.runner !== current.runner || rec.holder.boot === current.boot) continue;
      stale = true;
      if (rec.session.status !== "working" && rec.session.status !== "waiting") continue;
      this.failTurn(rec, "the agent runner restarted");
    }
    if (stale) this.stops.delete(current.runner);
  }

  private nextWork(query: RunnerQuery, guide: string): { work: RunnerWork; claim: Claim | null } | null {
    const stops = this.stops.get(query.runner);
    const stopped = stops?.values().next();
    if (stops !== undefined && stopped !== undefined && !stopped.done) {
      stops.delete(stopped.value);
      if (stops.size === 0) this.stops.delete(query.runner);
      return { work: { kind: "stop", sessionId: stopped.value }, claim: null };
    }
    if (!query.accepting) return null;
    // A turn goes only to a provider the runner can run now and settings still allow.
    const enabled = this.opts.settings().providers;
    const offered = new Set(query.providers.filter((p) => p.state === "ready" && enabled[p.kind].enabled).map((p) => p.kind));
    let next: Rec | null = null;
    for (const rec of this.recs.values()) {
      if (rec.session.status !== "queued" || !offered.has(rec.session.provider)) continue;
      if (next === null || rec.queueOrder < next.queueOrder) next = rec;
    }
    if (next === null) return null;
    return this.claim(next, query, guide);
  }

  private claim(rec: Rec, by: RunnerIdentity, guide: string): { work: RunnerWork; claim: Claim } {
    const claim: Claim = { rec, claim: ++rec.claims, handedSeq: rec.handedSeq, queueOrder: rec.queueOrder };
    const messages = rec.items.filter((item) => item.type === "user" && item.seq > rec.handedSeq);
    const last = messages[messages.length - 1];
    if (last !== undefined) rec.handedSeq = last.seq;
    rec.holder = { runner: by.runner, boot: by.boot };
    rec.session.status = "working";
    rec.session.pending = 0;
    rec.session.activity = null;
    rec.session.error = null;
    this.changed(rec);
    this.save(rec);
    return { work: { kind: "turn", session: { ...rec.session }, messages, resume: rec.resume, guide }, claim };
  }

  /** Undoes a claim whose turn never reached a runner, unless something happened to the session since. */
  private async unclaim(claim: Claim): Promise<void> {
    const rec = claim.rec;
    if (this.recs.get(rec.session.id) !== rec || rec.claims !== claim.claim || rec.session.status !== "working") return;
    rec.holder = null;
    rec.handedSeq = claim.handedSeq;
    rec.queueOrder = claim.queueOrder;
    rec.session.status = "queued";
    rec.session.activity = null;
    rec.session.pending = rec.items.filter((item) => item.type === "user" && item.seq > rec.handedSeq).length;
    this.changed(rec);
    this.save(rec);
    await rec.chain;
  }

  private requestStop(runner: string, sessionId: string): void {
    const set = this.stops.get(runner) ?? new Set<string>();
    set.add(sessionId);
    this.stops.set(runner, set);
  }

  private expireRunners(): void {
    const limit = Date.now() - this.ttlMs;
    for (const [id, runner] of this.runnerMap) {
      if (runner.seenAt >= limit) continue;
      this.runnerMap.delete(id);
      this.stops.delete(id);
      for (const rec of this.recs.values()) {
        if (rec.holder?.runner !== id) continue;
        if (rec.session.status !== "working" && rec.session.status !== "waiting") continue;
        this.failTurn(rec, "the agent runner went away");
      }
    }
  }

  // ---- for a runner -------------------------------------------------------------------------

  async appendItem(id: string, item: NewSessionItem, by: RunnerIdentity): Promise<SessionItem> {
    const rec = this.held(id, by);
    const at = this.stamp();
    let stored: SessionItem;
    if (isReplaceable(item) && rec.replaceable.has(replaceKey(item))) {
      const index = rec.replaceable.get(replaceKey(item)) as number;
      const old = rec.items[index] as SessionItem;
      stored = { ...item, seq: old.seq, version: this.nextVersion(rec), at: old.at };
      rec.items[index] = stored;
    } else {
      if (item.type === "question" && rec.items.some((i) => i.type === "question" && i.questionId === item.questionId)) {
        throw invalid(`question ${item.questionId} already exists`);
      }
      stored = this.pushItem(rec, item.type === "question" ? { ...item, answer: null } : item, at);
      if (isReplaceable(item)) rec.replaceable.set(replaceKey(item), rec.items.length - 1);
      if (item.type === "tool") rec.session.toolCalls += 1;
      if (item.type === "question" && rec.session.status === "working") rec.session.status = "waiting";
    }
    this.changed(rec);
    this.saveItem(rec, stored);
    this.save(rec);
    await rec.chain;
    return stored;
  }

  async patch(id: string, patch: RunnerSessionPatch, by: RunnerIdentity): Promise<Session> {
    const rec = this.held(id, by);
    const s = rec.session;
    if (patch.resume !== undefined) rec.resume = patch.resume;
    // Only a session a runner is on takes status, activity and error from it: a patch that arrives
    // after a stop (or a restart, or a new turn) must not undo what happened since.
    if (s.status === "working" || s.status === "waiting") {
      if (patch.status === "idle") {
        this.settle(rec, rec.session.pending > 0 ? "queued" : "idle");
      } else if (patch.status === "failed") {
        this.endFailed(rec, patch.error ?? "the turn failed");
      } else {
        if (patch.status === "working" || patch.status === "waiting") s.status = patch.status;
        if (patch.activity !== undefined) s.activity = patch.activity;
        if (patch.error !== undefined) s.error = patch.error;
      }
    }
    this.changed(rec);
    this.save(rec);
    await rec.chain;
    return { ...rec.session };
  }

  async waitAnswer(id: string, questionId: string, wait: number, signal: AbortSignal): Promise<string | null> {
    const isQuestion = (item: SessionItem): item is Extract<SessionItem, { type: "question" }> => item.type === "question" && item.questionId === questionId;
    if (!this.get(id).items.some(isQuestion)) throw notFound(`no such question: ${questionId}`);
    const check = (): { answer: string | null } | null => {
      const rec = this.recs.get(id);
      if (rec === undefined) return { answer: null };
      const answer = rec.items.find(isQuestion)?.answer ?? null;
      if (answer !== null) return { answer };
      // Nothing more will come for a session that was stopped or failed.
      return rec.session.status === "stopped" || rec.session.status === "failed" ? { answer: null } : null;
    };
    return (await this.pollUntil(wait, signal, check))?.answer ?? null;
  }

  async guide(): Promise<string> {
    return Bun.file(new URL("../guide.md", import.meta.url)).text();
  }

  // ---- state helpers ------------------------------------------------------------------------

  private get(id: string): Rec {
    const rec = this.recs.get(id);
    if (rec === undefined) throw notFound(`no such session: ${id}`);
    return rec;
  }

  /** The session, if `by` is the runner process that holds it; 409 for anyone else. */
  private held(id: string, by: RunnerIdentity): Rec {
    const rec = this.get(id);
    if (rec.holder === null || rec.holder.runner !== by.runner || rec.holder.boot !== by.boot) {
      throw new ApiException("conflict", `session ${id} is not held by runner ${by.runner} (boot ${by.boot})`);
    }
    return rec;
  }

  private stamp(): string {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }

  private addUserItem(rec: Rec, text: string, refs: SessionRef[], taken: StoredAttachment[], author: Author): void {
    const attachments = taken.map((s) => ({ ...s.attachment }));
    const stored = this.pushItem(rec, { type: "user", text, refs, attachments, author }, this.stamp());
    rec.session.pending += 1;
    this.attachments.bind(taken, stored.seq);
    if (taken.length > 0) this.enqueue(rec, () => this.attachments.persist(taken));
    this.saveItem(rec, stored);
  }

  private nextVersion(rec: Rec): number {
    rec.session.version += 1;
    return rec.session.version;
  }

  private pushItem(rec: Rec, item: ItemBody, at: string): SessionItem {
    rec.session.seq += 1;
    const stored = { ...item, seq: rec.session.seq, version: this.nextVersion(rec), at } as SessionItem;
    rec.items.push(stored);
    return stored;
  }

  /** Back in line for a runner. */
  private queue(rec: Rec): void {
    rec.session.status = "queued";
    rec.session.activity = null;
    rec.session.error = null;
    rec.queueOrder = ++this.queueCounter;
  }

  /** A status the session rests in: no turn is going on. */
  private settle(rec: Rec, status: "idle" | "stopped" | "queued"): void {
    if (status === "queued") {
      this.queue(rec);
      return;
    }
    rec.session.status = status;
    rec.session.activity = null;
    rec.session.error = null;
  }

  /**
   * A turn ended in failure. With messages pending the session is queued again, like a turn that
   * ended, and the error stays visible as a notice; otherwise it rests as `failed`.
   */
  private endFailed(rec: Rec, error: string): void {
    if (rec.session.pending > 0) {
      const notice = this.pushItem(rec, { type: "notice", level: "error", text: `The turn failed: ${error}` }, this.stamp());
      this.saveItem(rec, notice);
      this.settle(rec, "queued");
      return;
    }
    rec.session.status = "failed";
    rec.session.activity = null;
    rec.session.error = error;
  }

  /** The process running the turn is gone: no write from it is taken any more. Saves, and logs a failed save. */
  private failTurn(rec: Rec, error: string): void {
    rec.holder = null;
    this.endFailed(rec, error);
    this.changed(rec);
    this.save(rec);
    rec.chain.catch((err: unknown) => console.error(`sessions: saving ${rec.session.id} failed: ${errorMessage(err)}`));
  }

  /** After a state change: bump `updatedAt`, tell watchers, wake long polls. */
  private changed(rec: Rec): void {
    rec.session.updatedAt = this.stamp();
    const s = rec.session;
    const event: DrawerEvent = { type: "session", id: s.id, project: s.project, status: s.status, activity: s.activity, version: s.version, deleted: false };
    this.opts.bus.emit(event);
    this.wake();
  }

  // ---- disk ---------------------------------------------------------------------------------

  /** Queues a write of the state file; the snapshot is taken now. */
  private save(rec: Rec): void {
    const stored: StoredSession = { session: { ...rec.session }, resume: rec.resume, handedSeq: rec.handedSeq };
    const text = `${JSON.stringify(stored, null, 2)}\n`;
    const id = rec.session.id;
    this.enqueue(rec, () => this.files.writeState(id, text));
  }

  private saveItem(rec: Rec, item: SessionItem): void {
    const id = rec.session.id;
    this.enqueue(rec, () => this.files.appendItem(id, item));
  }

  private enqueue(rec: Rec, write: () => Promise<void>): void {
    rec.chain = rec.chain.catch(() => undefined).then(write);
  }

  // ---- long polls ---------------------------------------------------------------------------

  private wake(): void {
    for (const waker of [...this.wakers]) waker();
  }

  /** Resolves on the next wake, when `ms` pass, or when `signal` aborts. */
  private nextWake(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wakers.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Runs `check` now and after every change until it gives a value, `waitSeconds` pass, or the request ends. */
  private async pollUntil<T>(waitSeconds: number, signal: AbortSignal, check: () => T | null): Promise<T | null> {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      if (this.closed || signal.aborted) return null;
      const value = check();
      if (value !== null) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.nextWake(remaining, signal);
    }
  }
}
