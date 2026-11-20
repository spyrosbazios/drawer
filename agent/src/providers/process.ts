/** What the CLI providers share: finding the binary, short probe runs, JSON lines and JSON-RPC over stdio. */
import { constants } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Where a CLI is: the path the runner's host configured (DRAWER_AGENT_<KIND>_BIN) when there is one,
 * else the PATH plus the per-user install directories (a systemd user unit's PATH holds none of them).
 */
export async function findBinary(name: string, override: string | null, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (override !== null) return (await isExecutable(override)) ? override : null;
  const home = env.HOME ?? homedir();
  const dirs = [...(env.PATH ?? "").split(delimiter), join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin")];
  for (const dir of dirs) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a short command (a version or login probe) to the end, or kills it after `timeoutMs`. */
export async function capture(cmd: string[], opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<Captured> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code: timedOut ? null : code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** The first `x.y.z` in a version banner, or its first line. */
export function versionOf(text: string): string | null {
  const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(text);
  if (match) return match[0];
  const line = text.trim().split("\n")[0]?.trim();
  return line ? line.slice(0, 100) : null;
}

/** Splits a byte stream into lines and hands each parsed JSON value on; other lines go to `onOther`. */
export async function readJsonLines(stream: ReadableStream<Uint8Array>, onValue: (value: unknown) => void, onOther: (line: string) => void = () => {}): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      onOther(trimmed);
      return;
    }
    onValue(value);
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      flush(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  flush(buffer + decoder.decode());
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** A line sink: one JSON value per line. */
export interface LineWriter {
  write(line: string): void;
}

/**
 * JSON-RPC over newline-delimited JSON, both ways. `jsonrpc: "2.0"` is sent only when `strict` (ACP
 * wants it; Codex's app-server leaves it out). Requests from the other side go to `onRequest`, whose
 * value or thrown RpcError becomes the answer.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private closedWith: Error | null = null;

  constructor(
    private readonly out: LineWriter,
    private readonly handlers: {
      onNotification(method: string, params: unknown): void;
      onRequest(method: string, params: unknown): Promise<unknown>;
    },
    private readonly strict = true,
  ) {}

  private send(message: Record<string, unknown>): void {
    this.out.write(`${JSON.stringify(this.strict ? { jsonrpc: "2.0", ...message } : message)}\n`);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closedWith) this.send({ method, params });
  }

  /** Feed one parsed line from the other side. */
  receive(msg: unknown): void {
    if (!isRecord(msg)) return;
    const method = str(msg.method);
    if (method !== null && msg.id !== undefined && msg.id !== null) {
      const id = msg.id;
      this.handlers.onRequest(method, msg.params).then(
        (result) => this.send({ id, result: result ?? null }),
        (err: unknown) => this.send({ id, error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } }),
      );
      return;
    }
    if (method !== null) {
      this.handlers.onNotification(method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (isRecord(msg.error)) waiter.reject(new RpcError(typeof msg.error.code === "number" ? msg.error.code : -32603, str(msg.error.message) ?? "error"));
    else waiter.resolve(msg.result);
  }

  /** Fails every open request: the other side is gone. */
  close(reason: Error): void {
    this.closedWith = reason;
    for (const waiter of this.pending.values()) waiter.reject(reason);
    this.pending.clear();
  }
}

/** An empty working directory for one turn, removed afterwards: the CLI starts with nothing to read. */
export async function withScratchDir<T>(root: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(root, "scratch", crypto.randomUUID());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rejects as soon as `signal` aborts, with the signal's reason. */
export function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * The person's message as the CLI must read it: plain text. Pi and Gemini run their own commands for a
 * prompt that starts with `/` (Gemini also `$`, pi `!`), so such a message gets a neutral first line.
 */
export function literalPrompt(text: string): string {
  return /^\s*[/$!]/.test(text) ? `Message:\n${text}` : text;
}

/** -1, 0, 1 for dotted numeric versions; missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
