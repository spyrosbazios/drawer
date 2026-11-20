/**
 * The pi coding agent in RPC mode (JSON lines over stdio; docs/rpc.md of the installed package), one
 * process per turn, with drawer's tools as its only MCP server.
 *
 * How the model is kept to drawer's tools:
 * - Each turn gets its own throw-away pi agent directory (PI_CODING_AGENT_DIR): an `mcp.json` naming
 *   only drawer, and `auth.json` as a symlink to the person's own. Pi locks the resolved file, so a
 *   token refresh through the symlink is shared safely with the person's own pi (auth-storage.js,
 *   "symlinked aliases of auth.json share one lock"). None of the person's extensions, skills,
 *   prompts, AGENTS.md or MCP servers are in that directory.
 * - `--tools mcp__drawer__*` is the tool allow-list (built-ins and every other tool off); `-ne -e
 *   builtin:mcp` loads no extension but MCP itself; `-nc -ns -np -na` load no context files, skills,
 *   prompt templates or project files. `--no-tools` is not used: it would switch MCP tools off too.
 * - drawer's server is `exposure: "direct"`, so its tools are declared to the model as they are.
 * - At run time a tool call whose name is not `mcp__drawer__…` fails the turn.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startMcpToolServer, MCP_SERVER_NAME } from "../mcp-server.ts";
import { ForeignToolError, type Provider, type ProviderCheck, type Turn } from "../provider.ts";
import { Thoughts } from "./thoughts.ts";
import { abortable, capture, findBinary, isRecord, literalPrompt, readJsonLines, str, versionOf, withScratchDir } from "./process.ts";

export const PI_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const TOKEN_ENV = "DRAWER_MCP_TOKEN";
const SIGN_IN = "Sign in on the runner's host: run `pi`, then `/login`.";

/** The person's own pi agent directory, where their login lives. */
export function personalAgentDir(env: Record<string, string | undefined> = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(env.HOME ?? homedir(), ".pi", "agent");
}

/** The `mcp.json` of a turn: drawer only, tools declared directly. */
export function mcpConfig(url: string): unknown {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        url,
        headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
        exposure: "direct",
        // ask_user waits for a person's answer.
        timeout: 21600,
      },
    },
  };
}

/** Command-line flags that leave pi with drawer's tools only. */
export function piArgs(opts: { systemPromptFile: string; sessionDir: string; sessionId: string; model: string | null }): string[] {
  return [
    "--mode", "rpc",
    "--no-extensions", "--extension", "builtin:mcp",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-approve",
    "--tools", `${PI_TOOL_PREFIX}*`,
    "--system-prompt", opts.systemPromptFile,
    "--session-dir", opts.sessionDir,
    "--session-id", opts.sessionId,
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}

/** A throw-away agent directory: the person's login (symlinked) and, for a turn, drawer's MCP server. */
async function agentDir(dir: string, mcpUrl: string | null): Promise<string> {
  const agent = join(dir, "agent");
  await mkdir(agent, { recursive: true, mode: 0o700 });
  await symlink(join(personalAgentDir(), "auth.json"), join(agent, "auth.json"));
  await writeFile(join(agent, "mcp.json"), JSON.stringify(mcpUrl === null ? { mcpServers: {} } : mcpConfig(mcpUrl)));
  return agent;
}

/** `provider/id` for each model pi can use with the logins it has. */
export function modelIds(data: unknown): string[] {
  const models = isRecord(data) && Array.isArray(data.models) ? data.models : [];
  return models
    .map((m) => (isRecord(m) && str(m.provider) && str(m.id) ? `${str(m.provider)}/${str(m.id)}` : null))
    .filter((m): m is string => m !== null);
}

/** The text of a finished assistant message, or null for other messages. */
export function assistantText(message: unknown): string | null {
  if (!isRecord(message) || message.role !== "assistant") return null;
  const content = message.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((c) => (isRecord(c) && c.type === "text" ? (str(c.text) ?? "") : ""))
    .join("")
    .trim();
  return text || null;
}

/** An assistant message that ended in an error: its message. */
export function assistantError(message: unknown): string | null {
  if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "error") return null;
  return str(message.errorMessage) ?? "the model call failed";
}

/** One pi process in RPC mode: commands with ids, events to a listener. */
class PiRpc {
  private next = 1;
  private readonly waiting = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  readonly closed: Promise<void>;
  private readonly stderr: Promise<string>;

  constructor(
    private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    onEvent: (event: Record<string, unknown>) => void,
  ) {
    this.stderr = new Response(proc.stderr).text();
    this.closed = readJsonLines(proc.stdout, (v) => {
      if (!isRecord(v)) return;
      if (v.type === "response" && typeof v.id === "string") {
        const w = this.waiting.get(v.id);
        if (!w) return;
        this.waiting.delete(v.id);
        if (v.success === true) w.resolve(v.data);
        else w.reject(new Error(`pi: ${str(v.error) ?? `${str(v.command) ?? "command"} failed`}`));
      } else if (v.type === "extension_ui_request" && typeof v.id === "string") {
        // drawer offers no interactive UI; a dialog gets "cancelled" (fire-and-forget ones need no answer).
        if (["select", "confirm", "input", "editor"].includes(str(v.method) ?? "")) this.write({ type: "extension_ui_response", id: v.id, cancelled: true });
      } else onEvent(v);
    }).then(async () => {
      const tail = (await this.stderr).trim().split("\n").slice(-3).join(" ").slice(0, 400);
      const err = new Error(`pi exited${tail ? `: ${tail}` : ""}`);
      for (const w of this.waiting.values()) w.reject(err);
      this.waiting.clear();
    });
  }

  write(record: Record<string, unknown>): void {
    void this.proc.stdin.write(`${JSON.stringify(record)}\n`);
  }

  command<T = unknown>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    const id = `d${this.next++}`;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: (v) => resolve(v as T), reject });
      this.write({ id, type, ...fields });
    });
  }

  /** Orderly shutdown (stdin EOF), then a kill if it does not go. */
  async stop(): Promise<void> {
    void this.proc.stdin.end();
    const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) this.proc.kill();
    await Promise.allSettled([this.proc.exited, this.closed]);
  }
}

export interface PiOptions {
  /** The runner's state directory: pi's sessions and the per-turn agent directories live here. */
  stateDir: string;
  /** The CLI as the runner's host configured it (DRAWER_AGENT_PI_BIN); unset = found on the PATH. */
  binary?: string;
}

export class PiProvider implements Provider {
  readonly kind = "pi";

  constructor(private readonly opts: PiOptions) {}

  async check(): Promise<ProviderCheck> {
    const configured = this.opts.binary ?? null;
    const bin = await findBinary("pi", configured);
    if (bin === null) return { state: "not_installed", version: null, models: [], message: configured ? `${configured} is not an executable` : "Install pi on the runner's host.", binary: null };
    const v = await capture([bin, "--version"]);
    const version = versionOf(`${v.stdout}\n${v.stderr}`);
    if (v.code !== 0) return { state: "unavailable", version, models: [], message: `\`pi --version\` failed: ${(v.stderr || v.stdout).trim().slice(0, 200)}`, binary: bin };
    if (!(await Bun.file(join(personalAgentDir(), "auth.json")).exists())) return { state: "signed_out", version, models: [], message: SIGN_IN, binary: bin };
    const models = await withScratchDir(this.opts.stateDir, async (dir) => {
      const agent = await agentDir(dir, null);
      // --offline: no start-up refresh of logins, so stopping this short process loses no rotated token.
      const proc = Bun.spawn([bin, "--mode", "rpc", "--offline", "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-approve", "--no-tools"], {
        cwd: dir,
        env: { ...process.env, PI_CODING_AGENT_DIR: agent },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const rpc = new PiRpc(proc, () => {});
      try {
        return modelIds(await abortable(AbortSignal.timeout(20_000), rpc.command("get_available_models")));
      } finally {
        await rpc.stop();
      }
    });
    if (models.length === 0) return { state: "signed_out", version, models, message: SIGN_IN, binary: bin };
    return { state: "ready", version, models, message: null, binary: bin };
  }

  async run(turn: Turn): Promise<void> {
    const bin = await findBinary("pi", this.opts.binary ?? null);
    if (bin === null) throw new Error("pi is not installed on the runner's host");
    const session = join(this.opts.stateDir, "sessions", turn.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    // Pi keys a session by its working directory: the same empty one every turn of a drawer session.
    const cwd = join(session, "cwd");
    const sessionDir = join(session, "pi");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const sessionId = turn.resume ?? crypto.randomUUID();

    await withScratchDir(this.opts.stateDir, async (dir) => {
      const mcp = startMcpToolServer({ tools: turn.tools, onEvent: (e) => turn.onEvent(e) });
      try {
        const agent = await agentDir(dir, mcp.url);
        const promptFile = join(dir, "system.md");
        await writeFile(promptFile, turn.systemPrompt);
        const proc = Bun.spawn([bin, ...piArgs({ systemPromptFile: promptFile, sessionDir, sessionId, model: turn.model })], {
          cwd,
          env: { ...process.env, PI_CODING_AGENT_DIR: agent, [TOKEN_ENV]: mcp.token },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });

        const { promise: settled, resolve } = Promise.withResolvers<void>();
        const { promise: failed, reject: fail } = Promise.withResolvers<never>();
        failed.catch(() => undefined);
        const race = <T>(p: Promise<T>) => Promise.race([p, failed]);
        let modelError: string | null = null;
        const thoughts = new Thoughts((e) => turn.onEvent(e));
        // A content index repeats in every message of the turn: number the thoughts instead.
        const openThoughts = new Map<number, string>();
        let thoughtCount = 0;
        const rpc = new PiRpc(proc, (ev) => {
          switch (ev.type) {
            case "tool_execution_start": {
              const name = str(ev.toolName) ?? "";
              if (!name.startsWith(PI_TOOL_PREFIX)) {
                rpc.write({ type: "abort" });
                fail(new ForeignToolError(`tried to use ${name || "an unknown tool"}`));
              }
              break;
            }
            case "message_update": {
              const update = isRecord(ev.assistantMessageEvent) ? ev.assistantMessageEvent : {};
              const index = typeof update.contentIndex === "number" ? update.contentIndex : -1;
              if (update.type === "thinking_start") openThoughts.set(index, `t${thoughtCount++}`);
              else if (update.type === "thinking_delta") {
                const key = openThoughts.get(index);
                if (key !== undefined) thoughts.append(key, str(update.delta) ?? "");
              } else if (update.type === "thinking_end") {
                const key = openThoughts.get(index);
                if (key !== undefined) thoughts.end(key, str(update.content) ?? undefined);
                openThoughts.delete(index);
              }
              break;
            }
            case "message_end": {
              const text = assistantText(ev.message);
              if (text) turn.onEvent({ type: "assistant_text", text });
              modelError = assistantError(ev.message) ?? modelError;
              break;
            }
            case "agent_settled":
              if (ev.aborted === true) fail(new Error("aborted"));
              else if (modelError !== null) fail(new Error(`pi: ${modelError}`));
              else resolve();
              break;
          }
        });
        void rpc.closed.then(() => fail(new Error("pi exited before the turn ended")));

        const onAbort = () => {
          rpc.write({ type: "abort" });
          fail(new Error("aborted"));
        };
        turn.signal.addEventListener("abort", onAbort, { once: true });
        try {
          if (turn.signal.aborted) throw new Error("aborted");
          const state = await race(rpc.command<unknown>("get_state"));
          turn.onEvent({ type: "resume", handle: (isRecord(state) ? str(state.sessionId) : null) ?? sessionId });
          turn.onEvent({ type: "activity", text: "thinking" });
          const accepted = await race(rpc.command<unknown>("prompt", { message: literalPrompt(turn.messages.map((m) => m.text).join("\n\n")), images: turn.messages.flatMap((m) => m.images.map((i) => ({ type: "image", mimeType: i.mediaType, data: Buffer.from(i.data).toString("base64") }))) }));
          if (isRecord(accepted) && accepted.disposition === "handled") resolve();
          await race(settled);
        } finally {
          turn.signal.removeEventListener("abort", onAbort);
          thoughts.endAll();
          await rpc.stop();
        }
      } finally {
        await mcp.close();
      }
    });
  }
}
