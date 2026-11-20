/**
 * The runner loop: long-polls the server for session work, runs one provider turn per session, and
 * records what happens as session items. It knows providers only through `Provider`.
 */
import { ApiFailure, type Client, type RunnerIdentity } from "@drawer/cli/client";
import { isModelId, isResumeHandle, type NewSessionItem, type ProviderStatus, type RunnerSessionPatch, type RunnerWork, type SessionAttachment, type SessionItem, type Settings } from "@drawer/shared/api";
import { ReasoningRecorder } from "./reasoning.ts";
import { formatAttachment, formatRef, oneLine, truncate } from "./format.ts";
import type { BoundTool, Provider, ProviderCheck, ProviderEvent, TurnImage, TurnMessage } from "./provider.ts";
import { drawerTools, executeTool, MAX_IMAGE_BYTES, MAX_IMAGES, toolsSection, type DrawerTool, type ToolClient, type ToolContext } from "./tools.ts";

export type RunnerClient = Pick<Client, "runnerWork" | "appendItem" | "patchSession" | "settings" | "attachmentBytes">;
import { imageMediaType } from "./images.ts";

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface RunnerOptions {
  client: RunnerClient;
  toolClient: ToolClient;
  /** This process: the configured runner id and a boot nonce picked at start. */
  identity: RunnerIdentity;
  providers: Provider[];
  /** Turns that may run at once. */
  concurrency: number;
  log: Logger;
  /** How long a provider check stays fresh. Default 5 minutes. */
  checkTtlMs?: number;
  /** Clock for check freshness (tests). */
  now?: () => number;
  tools?: readonly DrawerTool[];
  /** Seconds per work poll. */
  pollWait?: number;
  /** Least time between two writes of one streaming thought. Default 1 second. */
  reasoningIntervalMs?: number;
  /** Seconds per answer poll inside ask_user. */
  answerWait?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RESULT_CHARS = 400;
const CHECK_TTL_MS = 5 * 60_000;
const REASONING_INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/** The server's limits on item fields (server/src/sessions/input.ts); the runner trims to fit. */
const TEXT_CHARS = 99_000;
const ITEM_IMAGES = 16;

interface ActiveTurn {
  abort: AbortController;
  done: Promise<void>;
  /** Set when the runner itself is shutting down, not a person's stop. */
  shutdown: boolean;
  /** Set when the server refused a write (409): the session is no longer this turn's. */
  lost: boolean;
  /** The provider's handle as the turn left it, for a next turn of the session that waited on this one. */
  resume: string | null;
}

/** Runs async tasks one after another; a failure is logged and does not stop the chain. Once closed, tasks are skipped. */
class Serial {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly onError: (err: unknown) => void) {}
  close(): void {
    this.closed = true;
  }
  push(task: () => Promise<unknown>): Promise<void> {
    const next = this.tail.then(() => (this.closed ? undefined : task())).then(
      () => undefined,
      (err: unknown) => this.onError(err),
    );
    this.tail = next;
    return next;
  }
  drain(): Promise<void> {
    return this.tail;
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isConflict = (err: unknown): boolean => err instanceof ApiFailure && err.code === "conflict";

/** A person's message as the agent reads it: the text, what it points at, what is attached. `shown` = attachment ids that follow as images. */
export function renderUserItem(item: SessionItem, shown: ReadonlySet<string> = new Set()): string | null {
  if (item.type !== "user") return null;
  const refs = item.refs.map(formatRef);
  const attached = item.attachments.map((a) => formatAttachment(a, shown.has(a.id)));
  return [item.text, ...refs, ...attached].filter((line) => line !== "").join("\n");
}

/**
 * The turn's messages with attached images as image input: PNG, JPEG, GIF or WebP by their bytes, at
 * most MAX_IMAGE_BYTES each and MAX_IMAGES in all, the newest kept. The model's API takes up to 10 MB
 * base64 per image and scales large ones down itself. Anything else is named in the text only.
 */
export async function turnMessages(items: SessionItem[], client: Pick<RunnerClient, "attachmentBytes">, signal: AbortSignal): Promise<TurnMessage[]> {
  const candidates = items.flatMap((item) => (item.type === "user" ? item.attachments.filter((a) => a.kind === "image" && a.size <= MAX_IMAGE_BYTES) : []));
  const picked = new Map<string, TurnImage>();
  for (const a of candidates.slice(-MAX_IMAGES)) {
    if (signal.aborted) break;
    const image = await fetchImage(client, a);
    if (image !== null) picked.set(a.id, image);
  }
  const shown = new Set(picked.keys());
  return items.flatMap((item) => {
    const text = renderUserItem(item, shown);
    if (text === null || item.type !== "user") return [];
    const images = item.attachments.map((a) => picked.get(a.id)).filter((i): i is TurnImage => i !== undefined);
    return text.trim() === "" && images.length === 0 ? [] : [{ text, images }];
  });
}

async function fetchImage(client: Pick<RunnerClient, "attachmentBytes">, a: SessionAttachment): Promise<TurnImage | null> {
  try {
    const { bytes } = await client.attachmentBytes(a.id);
    const mediaType = imageMediaType(bytes);
    return mediaType === null || bytes.byteLength > MAX_IMAGE_BYTES ? null : { mediaType, data: bytes };
  } catch {
    return null; // named in the text; the agent can try view_attachment
  }
}

export function buildSystemPrompt(guide: string, project: string, tools: readonly DrawerTool[]): string {
  return `${guide.trim()}\n\n${toolsSection(tools)}\n\nYou are working on the drawer project \`${project}\`.\n`;
}

/** A short description of a call for the session's record. */
function callSummary(name: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return name;
  const record = input as Record<string, unknown>;
  const subject = ["part", "path", "query", "url", "title", "question", "id"].map((k) => record[k]).find((v) => typeof v === "string");
  return typeof subject === "string" ? oneLine(`${name} ${subject}`, 120) : name;
}

export class Runner {
  private readonly active = new Map<string, ActiveTurn>();
  private running = false;
  private readonly tools: readonly DrawerTool[];
  private readonly sleep: (ms: number) => Promise<void>;
  /** Provider checks by kind; a stale one is refreshed in the background while it still answers. */
  private readonly checks = new Map<string, { at: number; check: Promise<ProviderCheck> }>();

  constructor(private readonly opts: RunnerOptions) {
    this.tools = opts.tools ?? drawerTools;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Sessions with a turn in progress. */
  get busy(): string[] {
    return [...this.active.keys()];
  }

  /** Polls until `stop()`. Network and server errors back off; nothing here throws. */
  async run(): Promise<void> {
    this.running = true;
    let failures = 0;
    while (this.running) {
      try {
        await this.pollOnce();
        if (failures > 0) this.opts.log.info("server reachable again");
        failures = 0;
      } catch (err) {
        failures++;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures - 1, 5));
        if (failures === 1 || failures % 10 === 0) this.opts.log.error(`poll failed (${failures}): ${errorText(err)}; retrying in ${delay} ms`);
        await this.sleep(delay);
      }
    }
  }

  /** Stops polling and aborts every running turn, marking those sessions failed. */
  async stop(): Promise<void> {
    this.running = false;
    for (const turn of this.active.values()) {
      turn.shutdown = true;
      turn.abort.abort();
    }
    await this.idle();
  }

  /** Resolves when no turn is running. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((t) => t.done));
  }

  /** One long poll; dispatches what it gets without waiting for a turn to finish. */
  async pollOnce(): Promise<void> {
    const settings = await this.opts.client.settings();
    const providers = await this.statuses(settings);
    // While full, the server hands out stops but no new turns.
    const accepting = this.active.size < this.opts.concurrency;
    const work = await this.opts.client.runnerWork({ ...this.opts.identity, providers, accepting, wait: this.opts.pollWait ?? 25 });
    this.dispatch(work);
  }

  /** Every provider's status under these settings. Checks run even for a disabled one, so the settings page can show what is installed. */
  async statuses(settings: Settings): Promise<ProviderStatus[]> {
    return Promise.all(
      this.opts.providers.map(async (p): Promise<ProviderStatus> => {
        const own = settings.providers[p.kind];
        const check = await this.check(p);
        const models = [...new Set([...check.models, ...own.customModels.filter(isModelId)])];
        if (!own.enabled) return { kind: p.kind, state: "disabled", version: check.version, models, message: null, binary: check.binary };
        return { kind: p.kind, state: check.state, version: check.version, models, message: check.message, binary: check.binary };
      }),
    );
  }

  private check(p: Provider): Promise<ProviderCheck> {
    const key = p.kind;
    const clock = this.opts.now ?? Date.now;
    const now = clock();
    const cached = this.checks.get(key);
    if (cached && now - cached.at < (this.opts.checkTtlMs ?? CHECK_TTL_MS)) return cached.check;
    const fresh = p.check().catch((err: unknown): ProviderCheck => ({ state: "unavailable", version: null, models: [], message: errorText(err), binary: null }));
    this.checks.set(key, { at: now, check: cached ? cached.check : fresh });
    if (cached) void fresh.then((check) => this.checks.set(key, { at: clock(), check: Promise.resolve(check) }));
    return cached ? cached.check : fresh;
  }

  dispatch(work: RunnerWork): void {
    if (!work) return;
    if (work.kind === "stop") {
      const turn = this.active.get(work.sessionId);
      if (turn) {
        this.opts.log.info(`stop ${work.sessionId}`);
        turn.abort.abort();
      }
      return;
    }
    const id = work.session.id;
    // A claimed turn is never dropped. The server handed out a new turn, so the previous one of this
    // session is over (stopped, usually): make sure it ends, wait for it, then run this one.
    const previous = this.active.get(id);
    if (previous) {
      this.opts.log.info(`session ${id}: new turn waits for the previous one to finish`);
      previous.abort.abort();
    } else if (this.active.size >= this.opts.concurrency) {
      this.opts.log.error(`over capacity: running ${id} anyway, since the server already handed it out`);
    }
    const entry: ActiveTurn = { abort: new AbortController(), shutdown: false, lost: false, resume: work.resume, done: Promise.resolve() };
    const start = previous
      ? previous.done.then(() => this.runTurn({ ...work, resume: previous.resume ?? work.resume }, entry))
      : this.runTurn(work, entry);
    entry.done = start.finally(() => {
      if (this.active.get(id) === entry) this.active.delete(id);
    });
    this.active.set(id, entry);
  }

  /** After a stop: keep a new provider handle so the next turn continues the conversation; never touch the status. */
  private async keepResume(sessionId: string, before: string | null, after: string | null): Promise<void> {
    if (after === null || after === before) return;
    try {
      await this.opts.client.patchSession(sessionId, { resume: after }, this.opts.identity);
    } catch (err) {
      if (isConflict(err)) return;
      this.opts.log.error(`session ${sessionId}: could not keep the resume handle: ${errorText(err)}`);
    }
  }

  private async runTurn(work: Extract<RunnerWork, { kind: "turn" }>, entry: ActiveTurn): Promise<void> {
    const { client, log, identity } = this.opts;
    const session = work.session;
    const signal = entry.abort.signal;
    // A 409 means another turn or process holds the session now: this turn stops quietly, no retries.
    const lose = () => {
      if (entry.lost) return;
      entry.lost = true;
      queue.close();
      log.info(`turn ${session.id}: the session is no longer this runner's; stopping the turn`);
      entry.abort.abort();
    };
    const queue = new Serial((err) => {
      if (isConflict(err)) lose();
      else log.error(`session ${session.id}: could not record: ${errorText(err)}`);
    });
    const append = (item: NewSessionItem) => queue.push(() => client.appendItem(session.id, item, identity));
    const patch = (body: RunnerSessionPatch) => queue.push(() => client.patchSession(session.id, body, identity));
    let resume = work.resume;
    const finalPatch = async (body: RunnerSessionPatch): Promise<void> => {
      try {
        await client.patchSession(session.id, body, identity);
      } catch (err) {
        if (isConflict(err)) lose();
        else throw err;
      }
    };
    log.info(`turn ${session.id} (${session.project}, ${session.provider})`);

    try {
      const provider = this.opts.providers.find((p) => p.kind === session.provider);
      if (!provider) throw new Error(`this runner has no provider "${session.provider}"`);
      // Both reach the provider CLI's arguments: whatever the server let through, only plain ids go on.
      if (session.model !== null && !isModelId(session.model)) throw new Error(`refusing to run: "${oneLine(session.model, 60)}" is not a model id`);
      if (work.resume !== null && !isResumeHandle(work.resume)) throw new Error("refusing to run: the session's resume handle is not a provider session id");
      void patch({ activity: "reading the request" });

      const ctx: ToolContext = {
        client: this.opts.toolClient,
        project: session.project,
        sessionId: session.id,
        signal,
        append,
        answerWait: this.opts.answerWait,
      };
      const tools: BoundTool[] = this.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input: t.input,
        call: (input) => executeTool(t, ctx, input),
      }));
      const messages = await turnMessages(work.messages, client, signal);
      if (messages.length === 0) messages.push({ text: "Continue.", images: [] });

      const reasoning = new ReasoningRecorder((item) => void append(item), this.opts.reasoningIntervalMs ?? REASONING_INTERVAL_MS, this.opts.now ?? Date.now);
      const onEvent = (e: ProviderEvent) => {
        if (signal.aborted) return;
        switch (e.type) {
          case "resume":
            resume = e.handle;
            break;
          case "assistant_text":
            void append({ type: "assistant", text: truncate(e.text, TEXT_CHARS) });
            break;
          case "reasoning":
            reasoning.update(e.id, e.text, e.done);
            break;
          case "tool_started":
            void append({ type: "tool", callId: e.callId, name: e.name, summary: callSummary(e.name, e.input), status: "running", result: null, images: [] });
            break;
          case "tool_finished":
            void append({
              type: "tool",
              callId: e.callId,
              name: e.name,
              summary: oneLine(e.summary, 200),
              status: e.ok ? "ok" : "error",
              result: truncate(e.text, RESULT_CHARS),
              images: e.images.filter((url) => url.startsWith("/api/")).slice(0, ITEM_IMAGES),
            });
            break;
          case "activity":
            void patch({ activity: oneLine(e.text, 80) });
            break;
        }
      };

      try {
        await provider.run({
          sessionId: session.id,
          systemPrompt: buildSystemPrompt(work.guide, session.project, this.tools),
          messages,
          resume: work.resume,
          model: session.model,
          tools,
          signal,
          onEvent,
        });
      } finally {
        reasoning.finish();
      }
      await queue.drain();
      entry.resume = resume;
      if (entry.lost) return;
      if (signal.aborted && !entry.shutdown) {
        await this.keepResume(session.id, work.resume, resume);
        return;
      }
      if (entry.shutdown) throw new Error("the agent runner shut down");
      await finalPatch({ resume, status: "idle", activity: null, error: null });
      if (!entry.lost) log.info(`turn ${session.id} done`);
    } catch (err) {
      await queue.drain();
      entry.resume = resume;
      if (entry.lost) return;
      if (signal.aborted && !entry.shutdown) {
        log.info(`turn ${session.id} stopped`);
        await this.keepResume(session.id, work.resume, resume);
        return;
      }
      const message = entry.shutdown ? "the agent runner shut down" : errorText(err);
      log.error(`turn ${session.id} failed: ${message}`);
      try {
        await finalPatch({ resume, status: "failed", activity: null, error: truncate(message, TEXT_CHARS) });
      } catch (patchErr) {
        log.error(`session ${session.id}: could not mark failed: ${errorText(patchErr)}`);
      }
    }
  }
}
