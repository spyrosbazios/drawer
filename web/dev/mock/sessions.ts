/**
 * Agent sessions and a scripted fake agent. A message queues the session; the fake runner picks it up,
 * goes `working`, writes assistant text and tool calls (`running`, then `ok` under the same callId),
 * every other turn asks a question (`waiting` until answered), fixes the first draft part it finds, and
 * goes `idle`. It also thinks aloud: `reasoning` items that grow, then close under the same reasoningId. Messages sent meanwhile stay pending and start another turn. Stop interrupts it.
 */
import type { FileAttachmentResult, NewSessionItem, ProviderKind, RunnerInfo, Session, SessionAttachment, SessionItem, SessionRef, Settings } from "../../../shared/src/api";
import { isModelId, MAX_ATTACHMENTS } from "../../../shared/src/api";
import { png } from "./geometry";
import { HttpError, broadcast } from "./http";
import { agentSetParams, currentReport, listParts, onPartFileWritten, paramsOf } from "./parts";
import { decoder, getProject, head, kindOf, now, put, textOf, validPath } from "./store";
import { getSettings } from "./settings";

const STEP_MS = Number(process.env.MOCK_AGENT_MS ?? 900);

interface StoredSession {
  session: Session;
  items: SessionItem[];
  /** Bumped on every turn start and on stop: a running script checks it and gives up when it changed. */
  turn: number;
  turnsDone: number;
  /** The question a running turn waits for, with what to do when it is answered. */
  waiting: { questionId: string; resume: (answers: string[]) => void } | null;
}

/** A small picture a tool call "rendered", as a data URL so the mock needs no file for it. */
const PREVIEW = `data:image/png;base64,${Buffer.from(png(240, 150, 20)).toString("base64")}`;

const sessions = new Map<string, StoredSession>();
let ids = 0;

/** Two runners with providers in every state the settings page shows. */
export const RUNNERS: RunnerInfo[] = [
  {
    id: "workshop",
    accepting: true,
    lastSeen: now(),
    providers: [
      { kind: "claude", state: "ready", version: "2.1.329", models: ["sonnet", "opus", "haiku"], message: null, binary: "/home/me/.local/bin/claude" },
      { kind: "codex", state: "signed_out", version: "0.170.0", models: [], message: "Sign in once for drawer: `CODEX_HOME=/home/me/.local/state/drawer-agent/codex-home codex login`", binary: "/home/me/.local/bin/codex" },
      { kind: "pi", state: "ready", version: "1.5.2", models: ["openai/gpt-5.1", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"], message: null, binary: "/home/me/.local/bin/pi" },
      { kind: "gemini", state: "disabled", version: null, models: [], message: null, binary: null },
    ],
  },
  {
    id: "laptop",
    accepting: false,
    lastSeen: now(),
    providers: [
      { kind: "claude", state: "unavailable", version: null, models: [], message: "`claude --version` failed: exit 1", binary: "/home/me/.local/bin/claude" },
      { kind: "codex", state: "ready", version: "0.171.0", models: ["gpt-6.2-sol", "gpt-6.1-terra"], message: null, binary: "/home/me/.local/bin/codex" },
      { kind: "pi", state: "not_installed", version: null, models: [], message: "Install pi on the runner's host.", binary: null },
      { kind: "gemini", state: "disabled", version: null, models: [], message: null, binary: null },
    ],
  },
];

/** What each runner finds for each provider when it is on; the gemini CLI is installed on `workshop` only. */
const FOUND: Record<string, RunnerInfo["providers"]> = {
  workshop: RUNNERS[0]?.providers.map((p) => (p.kind === "gemini" ? { ...p, state: "ready", version: "0.9.1", models: ["gemini-3-pro", "gemini-3-flash"], binary: "/home/me/.local/bin/gemini" } : p)) ?? [],
  laptop: RUNNERS[1]?.providers.map((p) => (p.kind === "gemini" ? { ...p, state: "not_installed", message: "Install gemini on the runner's host." } : p)) ?? [],
};

/** A runner reports on its next poll, not at once: after the settings changed, what it says follows them a few seconds later. */
export function reportAfterPoll(settings: Settings, delayMs = 4000): void {
  setTimeout(() => {
    for (const runner of RUNNERS) {
      runner.providers = (FOUND[runner.id] ?? []).map((p) => (settings.providers[p.kind].enabled ? p : { ...p, state: "disabled", message: null }));
    }
  }, delayMs);
}

function emit(s: StoredSession): void {
  const x = s.session;
  broadcast({ type: "session", id: x.id, project: x.project, status: x.status, activity: x.activity, version: x.version, deleted: false });
}

function touch(s: StoredSession): number {
  s.session.version++;
  s.session.updatedAt = now();
  return s.session.version;
}

type UserBody = { type: "user"; text: string; refs: SessionRef[]; attachments: SessionAttachment[]; author: string };

function append(s: StoredSession, item: NewSessionItem | UserBody): SessionItem {
  // A tool item with a known callId (a reasoning item with a known reasoningId) replaces the earlier one, keeping its seq.
  if (item.type === "tool" || item.type === "reasoning") {
    const i = s.items.findIndex((x) => (item.type === "tool" ? x.type === "tool" && x.callId === item.callId : x.type === "reasoning" && x.reasoningId === item.reasoningId));
    const old = s.items[i];
    if (old) {
      const next: SessionItem = { ...item, seq: old.seq, version: touch(s), at: old.at };
      s.items[i] = next;
      emit(s);
      return next;
    }
    if (item.type === "tool") s.session.toolCalls++;
  }
  // A new question has no answer yet; the runner never sends that field.
  const full = { ...item, ...(item.type === "question" ? { answers: null } : {}), seq: ++s.session.seq, version: touch(s), at: now() } as SessionItem;
  s.items.push(full);
  emit(s);
  return full;
}

function patch(s: StoredSession, p: Partial<Pick<Session, "status" | "activity" | "error">>): void {
  Object.assign(s.session, p);
  touch(s);
  emit(s);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One turn of the fake agent. Every await may find the turn stopped (`alive()` false). */
async function runTurn(s: StoredSession): Promise<void> {
  const turn = ++s.turn;
  const alive = () => s.turn === turn;
  s.session.pending = 0;
  patch(s, { status: "working", activity: "reading the project", error: null });
  const slug = s.session.project;
  let call = 0;
  const tool = async (name: string, summary: string, result: string, activity: string, outcome: { status?: "ok" | "error"; images?: string[]; running?: string } = {}) => {
    if (!alive()) return false;
    const callId = `call-${s.session.id}-${turn}-${++call}`;
    patch(s, { activity });
    append(s, { type: "tool", callId, name, summary: outcome.running ?? summary, status: "running", result: null, images: [] });
    await sleep(STEP_MS);
    if (!alive()) return false;
    append(s, { type: "tool", callId, name, summary, status: outcome.status ?? "ok", result, images: outcome.images ?? [] });
    return true;
  };

  // A thought grows paragraph by paragraph (the runner streams coarse updates), then closes as done.
  let thoughts = 0;
  const think = async (paragraphs: string[]) => {
    if (!alive()) return false;
    const reasoningId = `think-${s.session.id}-${turn}-${++thoughts}`;
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 1000);
    let text = "";
    for (const p of paragraphs) {
      text = text === "" ? p : `${text}\n\n${p}`;
      append(s, { type: "reasoning", reasoningId, text, status: "running", seconds: seconds() });
      await sleep(STEP_MS * 1.5);
      if (!alive()) return false;
    }
    append(s, { type: "reasoning", reasoningId, text, status: "done", seconds: seconds() });
    return true;
  };

  await sleep(STEP_MS / 2);
  const parts = listParts(slug);
  if (!(await think(["The request is about the project's parts. Read the overview first to see which are drafts.", `${parts.length} part(s) to look at, so measure before changing anything.`]))) return;
  if (!(await tool("overview", `overview: ${parts.length} part(s)`, parts.map((p) => `${p.id}: ${p.status} ${p.passed}/${p.total}`).join("\n") || "No parts yet.", "reading the project"))) return;
  if (!alive()) return;
  append(s, { type: "assistant", text: "I read the brief, the project memory and the library profile. Measuring the parts first." });

  // The first attachment not filed yet goes to refs/, like the real agent does with a reference.
  const unfiled = s.items.flatMap((i) => (i.type === "user" ? i.attachments : [])).find((a) => a.filedAs === null);
  if (unfiled) {
    const dest = `refs/${unfiled.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-")}`;
    if (!(await tool("file_attachment", `filed ${unfiled.name} as ${dest}`, `Filed "${unfiled.name}" as ${dest}.`, `filing ${unfiled.name}`, { running: `filing an attachment as ${dest}` }))) return;
    try {
      fileAttachment(unfiled.id, dest, "*", "agent", undefined);
    } catch {
      // the person filed it meanwhile
    }
  }

  const draft = parts.find((p) => p.status === "draft" && p.model);
  if (draft) {
    const report = currentReport(slug, draft.id);
    const failing = report.gates.filter((g) => g.status === "fail");
    // A render that fails first, then one that returns a picture: the thread shows both.
    if (!(await tool("render", `render ${draft.id}.scad`, `ERROR: Parser error in file ${draft.id}.scad, line 7: syntax error`, `rendering ${draft.id}`, { status: "error" }))) return;
    if (!(await tool("render", `render ${draft.id}.scad again`, "Rendered 1 body in 1.2 s.", `rendering ${draft.id}`, { images: [PREVIEW] }))) return;
    if (!(await tool("report", `${draft.id}: draft ${report.passed}/${report.total}, failing ${failing.map((g) => g.label).join(", ")}`, report.next.join("\n"), `measuring ${draft.id}`))) return;
  }

  // Every other turn asks before it changes anything, like the real agent does once per project: which sizes
  // to hold while it changes the part, several at once (a multiple question; the seeded one is single).
  if (s.turnsDone % 2 === 0) {
    if (!alive()) return;
    const questionId = `q-${s.session.id}-${turn}`;
    append(s, {
      type: "question",
      questionId,
      text: draft
        ? `Before I change **${draft.id}**: I will thicken the thinnest wall to meet the minimum. Which sizes must stay as they are?`
        : "Before I start: PETG, standard strictness. Which sizes must I hold exactly?",
      options: ["Outer width", "Slot width", "Overall height", "Mounting holes"],
      multiple: true,
    });
    patch(s, { status: "waiting", activity: null });
    const answers = await new Promise<string[]>((resolve) => {
      s.waiting = { questionId, resume: resolve };
    });
    if (!alive()) return;
    patch(s, { status: "working", activity: "applying your answer" });
    if (!(await think(["The answer settles it. Apply the change to the one parameter that drives the failing gate, then measure again."]))) return;
    append(s, { type: "assistant", text: `Noted, holding ${answers.length}: ${answers.map((a) => `"${a}"`).join(", ")}. Adjusting the plan.` });
  }

  if (draft) {
    const text = textOf(getProject(slug), `parts/${draft.id}.scad`) ?? "";
    const wall = paramsOf(text).find((p) => /_t$|wall|thick/.test(p.name));
    if (wall && typeof wall.value === "number") {
      const next = Math.round((wall.value + 0.6) * 10) / 10;
      if (!(await tool("set_params", `${draft.id}.scad ${wall.name} ${wall.value} -> ${next}`, `Wrote ${wall.name} = ${next}.`, `editing ${draft.id}`))) return;
      agentSetParams(slug, draft.id, { [wall.name]: next }, `${wall.name} ${wall.value} -> ${next}`);
      if (!(await tool("evaluate", `measure ${draft.id}`, "Evaluation queued.", `measuring ${draft.id}`))) return;
    }
  } else if (!(await tool("measure", "measure every part", "Nothing to change: every gate passes.", "measuring"))) return;

  if (!alive()) return;
  append(s, {
    type: "assistant",
    text: draft
      ? `Done: **${draft.id}** should now pass its wall gate.\n\n- The arm is thicker where it joins the body.\n- The slot still fits the tray edge.\n\n\`\`\`openscad\ncube([24, arm_t + slot + 4, height]);\n\`\`\`\n\nReview it and tune the parameters if you like.`
      : "Everything passes. Tell me what to change next.",
  });
  s.turnsDone++;
  if (s.session.pending > 0) {
    patch(s, { status: "queued", activity: null });
    void startSoon(s);
  } else patch(s, { status: "idle", activity: null });
}

function startSoon(s: StoredSession): Promise<void> {
  return sleep(STEP_MS / 2).then(() => (s.session.status === "queued" ? runTurn(s) : undefined));
}

function find(id: string): StoredSession {
  const s = sessions.get(id);
  if (!s) throw new HttpError("not_found", `No session ${id}`);
  return s;
}

// ---- routes' logic -------------------------------------------------------------------------------

export function listSessions(project: string | null): Session[] {
  return [...sessions.values()]
    .map((s) => s.session)
    .filter((s) => !project || s.project === project)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createSession(project: string, message: string, refs: SessionRef[], attachmentIds: string[], author: string, requested?: ProviderKind, requestedModel?: string): Session {
  getProject(project);
  const settings = getSettings();
  const provider = requested ?? settings.defaultProvider;
  if (!settings.providers[provider].enabled) throw new HttpError("invalid", `${provider} is turned off in settings`);
  if (requestedModel !== undefined && !isModelId(requestedModel)) throw new HttpError("invalid", "model must be a model id");
  const model = requestedModel ?? settings.providers[provider].defaultModel;
  if (!message.trim() && attachmentIds.length === 0) throw new HttpError("invalid", "A session starts with a message");
  const id = (++ids).toString(16).padStart(12, "a");
  const taken = take(attachmentIds, project, id);
  const at = now();
  const s: StoredSession = {
    session: { id, project, title: (message.trim() || taken[0]?.attachment.name || "").slice(0, 80), provider, model, status: "queued", activity: null, pending: 1, toolCalls: 0, seq: 0, version: 0, error: null, createdAt: at, updatedAt: at },
    items: [],
    turn: 0,
    turnsDone: 0,
    waiting: null,
  };
  sessions.set(id, s);
  bind(taken, append(s, { type: "user", text: message, refs, attachments: taken.map((t) => ({ ...t.attachment })), author }).seq);
  void startSoon(s);
  return { ...s.session };
}

export function detail(id: string, since: number | null): { session: Session; items: SessionItem[] } {
  const s = find(id);
  return { session: { ...s.session }, items: since === null ? [...s.items] : s.items.filter((i) => i.version > since) };
}

export function message(id: string, text: string, refs: SessionRef[], attachmentIds: string[], author: string): Session {
  const s = find(id);
  if (!text.trim() && attachmentIds.length === 0) throw new HttpError("invalid", "Empty message");
  const taken = take(attachmentIds, s.session.project, id);
  bind(taken, append(s, { type: "user", text, refs, attachments: taken.map((t) => ({ ...t.attachment })), author }).seq);
  s.session.pending++;
  if (s.session.status === "working" || s.session.status === "waiting") {
    touch(s);
    emit(s);
  } else {
    patch(s, { status: "queued", activity: null });
    void startSoon(s);
  }
  return { ...s.session };
}

export function answer(id: string, questionId: string, answers: string[]): Session {
  const s = find(id);
  const i = s.items.findIndex((x) => x.type === "question" && x.questionId === questionId);
  const q = s.items[i];
  if (!q || q.type !== "question") throw new HttpError("not_found", `No question ${questionId}`);
  if (q.answers !== null) throw new HttpError("conflict", "Already answered");
  if (!Array.isArray(answers) || answers.length === 0 || (!q.multiple && answers.length !== 1)) throw new HttpError("invalid", q.multiple ? "Give at least one answer" : "Give exactly one answer");
  s.items[i] = { ...q, answers, version: touch(s) };
  emit(s);
  const w = s.waiting;
  s.waiting = null;
  if (w?.questionId === questionId) w.resume(answers);
  return { ...s.session };
}

export function stop(id: string): Session {
  const s = find(id);
  if (s.session.status === "working" || s.session.status === "waiting" || s.session.status === "queued") {
    s.turn++;
    s.waiting = null;
    // A tool call left running is interrupted; a thought left running is closed.
    for (const [i, item] of s.items.entries()) {
      if (item.type === "tool" && item.status === "running") s.items[i] = { ...item, status: "error", result: "interrupted", version: touch(s) };
      else if (item.type === "reasoning" && item.status === "running") s.items[i] = { ...item, status: "done", version: touch(s) };
    }
    append(s, { type: "notice", level: "info", text: "Stopped by a person." });
    patch(s, { status: "stopped", activity: null });
  }
  return { ...s.session };
}

export function remove(id: string): void {
  const s = find(id);
  s.turn++;
  sessions.delete(id);
  for (const [key, a] of attachments) if (a.session === id) attachments.delete(key);
  broadcast({ type: "session", id, project: s.session.project, status: s.session.status, activity: null, version: s.session.version + 1, deleted: true });
}

/** A finished conversation for the seed: items are written as if a turn ran, without timers. */
export interface SeedUser {
  type: "user";
  text: string;
  /** Files the person attached; `filedAs` has the fake agent's file land there for real. */
  attachments?: { name: string; bytes: Uint8Array; filedAs?: string }[];
  refs?: SessionRef[];
}

/** `activity` is what a seeded `working` session is doing (its tail row). */
export function seedSession(project: string, title: string, items: (NewSessionItem | SeedUser)[], status: Session["status"], minutesAgo: number, activity: string | null = null): StoredSession {
  const id = (++ids).toString(16).padStart(12, "a");
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const s: StoredSession = {
    session: { id, project, title, provider: "claude", model: "sonnet", status, activity: null, pending: 0, toolCalls: 0, seq: 0, version: 0, error: null, createdAt: at, updatedAt: at },
    items: [],
    turn: 0,
    turnsDone: 1,
    waiting: null,
  };
  sessions.set(id, s);
  for (const item of items) {
    if (item.type !== "user") {
      append(s, item);
      continue;
    }
    const taken = take((item.attachments ?? []).map((a) => uploadAttachment(project, a.name, a.bytes).id), project, id);
    const user = append(s, { type: "user", text: item.text, refs: item.refs ?? [], attachments: taken.map((t) => ({ ...t.attachment })), author: "web" });
    bind(taken, user.seq);
    for (const [i, a] of (item.attachments ?? []).entries()) {
      const t = taken[i];
      if (a.filedAs && t) fileAttachment(t.attachment.id, a.filedAs, undefined, "agent", undefined);
    }
  }
  s.session.createdAt = at;
  s.session.activity = activity;
  if (status === "working") s.session.pending = 0;
  // A seeded open question: answering it runs the rest of a turn.
  const open = [...s.items].reverse().find((x) => x.type === "question" && x.answers === null);
  if (open?.type === "question" && status === "waiting") {
    const turn = ++s.turn;
    s.waiting = {
      questionId: open.questionId,
      resume: () => {
        if (s.turn !== turn) return;
        s.turnsDone = 1;
        patch(s, { status: "queued", activity: null });
        void startSoon(s);
      },
    };
  }
  return s;
}

// ---- attachments -------------------------------------------------------------------------------

interface StoredAttachment {
  attachment: SessionAttachment;
  project: string;
  session: string | null;
  seq: number | null;
  bytes: Uint8Array;
}

const attachments = new Map<string, StoredAttachment>();
let attachmentIds = 0;

const MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  stl: "model/stl",
  "3mf": "model/3mf",
  obj: "model/obj",
};

export function uploadAttachment(project: string, rawName: string, bytes: Uint8Array): SessionAttachment {
  getProject(project);
  if (bytes.length === 0) throw new HttpError("invalid", "the attachment is empty");
  const name = rawName.split(/[\\/]/).pop()?.trim() || "attachment";
  const id = (++attachmentIds).toString(16).padStart(16, "0");
  const kind = kindOf(name);
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const mediaType = MEDIA[ext] ?? (kind === "text" || kind === "markdown" || kind === "scad" ? "text/plain; charset=utf-8" : "application/octet-stream");
  const attachment: SessionAttachment = { id, name, mediaType, size: bytes.length, kind, url: `/api/attachments/${id}`, filedAs: null };
  attachments.set(id, { attachment, project, session: null, seq: null, bytes });
  return { ...attachment };
}

export function attachmentBytes(id: string): StoredAttachment {
  const a = attachments.get(id);
  if (!a) throw new HttpError("not_found", `no such attachment: ${id}`);
  return a;
}

function take(ids: string[], project: string, session: string): StoredAttachment[] {
  if (ids.length > MAX_ATTACHMENTS) throw new HttpError("invalid", `a message may carry at most ${MAX_ATTACHMENTS} attachments`);
  const taken = ids.map((id) => {
    const a = attachments.get(id);
    if (!a) throw new HttpError("invalid", `no such attachment: ${id}`);
    if (a.project !== project) throw new HttpError("invalid", `attachment ${id} was uploaded to another project`);
    if (a.session !== null) throw new HttpError("invalid", `attachment ${id} was already sent`);
    return a;
  });
  for (const a of taken) a.session = session;
  return taken;
}

function bind(taken: StoredAttachment[], seq: number): void {
  for (const a of taken) a.seq = seq;
}

/** Same rules as a file write: no rev creates, a rev (or "*") replaces. */
export function fileAttachment(id: string, rawPath: string, rev: string | undefined, author: string, message: string | undefined): FileAttachmentResult {
  const a = attachmentBytes(id);
  const path = validPath(rawPath);
  const p = getProject(a.project);
  const current = head(p, path);
  if (current && rev === undefined) throw new HttpError("conflict", `${path} exists: send its current rev`, current.rev);
  if (current && rev !== "*" && rev !== current.rev) throw new HttpError("conflict", "The file changed since you read it", current.rev);
  const msg = message ?? `file ${a.attachment.name} from ${a.session ? `session ${a.session}` : "an upload"}`;
  const res = put(p, path, a.bytes, author, msg);
  broadcast({ type: "file", action: "written", project: a.project, path, rev: res.rev, author });
  const part = onPartFileWritten(a.project, path, res.revisionId, author, msg);
  a.attachment = { ...a.attachment, filedAs: path };
  const s = a.session ? sessions.get(a.session) : undefined;
  const index = s ? s.items.findIndex((i) => i.seq === a.seq) : -1;
  const item = s?.items[index];
  if (s && item?.type === "user") {
    s.items[index] = { ...item, attachments: item.attachments.map((x) => (x.id === id ? { ...a.attachment } : x)), version: touch(s) };
    emit(s);
  }
  const check = kindOf(path) === "scad" ? { ok: !decoder.decode(a.bytes).includes("FAIL"), diagnostics: [] } : null;
  return { attachment: { ...a.attachment }, write: { project: a.project, path, rev: res.rev, created: res.created, revisionId: res.revisionId, check, part } };
}
