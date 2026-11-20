/** Claude Code through the Claude Agent SDK, with drawer's tools as an in-process MCP server and nothing else. */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TOOL_NAMES, createSdkMcpServer, query, tool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ForeignToolError, type BoundTool, type Provider, type ProviderCheck, type ProviderEvent, type Turn, type TurnMessage } from "../provider.ts";
import { imageMediaType } from "../images.ts";
import type { ToolOutput } from "../tools.ts";
import { capture, isRecord, str, versionOf } from "./process.ts";
import { Thoughts } from "./thoughts.ts";

export const SERVER_NAME = "drawer";
export const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

/** What one SDK message means for the turn, independent of how the runner records it. */
export type SdkEvent =
  | { kind: "init"; sessionId: string; model: string; tools: string[] }
  | { kind: "text"; text: string }
  /** Streamed thinking (`includePartialMessages`): a block of this index starts, grows, ends. */
  | { kind: "thinking_start"; index: number }
  | { kind: "thinking_delta"; index: number; text: string }
  | { kind: "thinking_stop"; index: number }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; isError: boolean; text: string }
  | { kind: "result"; ok: boolean; error: string | null };


function blocks(message: unknown): unknown[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  return Array.isArray(content) ? content : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (isRecord(c) && c.type === "text" ? (str(c.text) ?? "") : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

/** Thinking out of a Messages API streaming event; text and tool blocks arrive whole in their assistant message. */
function mapStreamEvent(event: unknown): SdkEvent[] {
  if (!isRecord(event) || typeof event.index !== "number") return [];
  const index = event.index;
  if (event.type === "content_block_start") return isRecord(event.content_block) && event.content_block.type === "thinking" ? [{ kind: "thinking_start", index }] : [];
  if (event.type === "content_block_delta") {
    const text = isRecord(event.delta) && event.delta.type === "thinking_delta" ? str(event.delta.thinking) : null;
    return text ? [{ kind: "thinking_delta", index, text }] : [];
  }
  return event.type === "content_block_stop" ? [{ kind: "thinking_stop", index }] : [];
}

/** Pure: an SDK message (as received; typed loosely so tests can pass literals) → turn events. Subagent messages are ignored. */
export function mapSdkMessage(msg: unknown): SdkEvent[] {
  if (!isRecord(msg)) return [];
  if (msg.type === "system" && msg.subtype === "init") {
    const tools = Array.isArray(msg.tools) ? msg.tools.filter((t): t is string => typeof t === "string") : [];
    return [{ kind: "init", sessionId: str(msg.session_id) ?? "", model: str(msg.model) ?? "", tools }];
  }
  if (msg.parent_tool_use_id) return [];
  if (msg.type === "stream_event") return mapStreamEvent(msg.event);
  if (msg.type === "assistant") {
    const events: SdkEvent[] = [];
    for (const b of blocks(msg.message)) {
      if (!isRecord(b)) continue;
      if (b.type === "text") {
        const text = str(b.text)?.trim();
        if (text) events.push({ kind: "text", text });
      } else if (b.type === "tool_use") {
        events.push({ kind: "tool_use", id: str(b.id) ?? "", name: str(b.name) ?? "", input: b.input });
      }
    }
    return events;
  }
  if (msg.type === "user") {
    const events: SdkEvent[] = [];
    for (const b of blocks(msg.message)) {
      if (!isRecord(b) || b.type !== "tool_result") continue;
      events.push({ kind: "tool_result", id: str(b.tool_use_id) ?? "", isError: b.is_error === true, text: resultText(b.content) });
    }
    return events;
  }
  if (msg.type === "result") {
    if (msg.subtype === "success" && msg.is_error !== true) return [{ kind: "result", ok: true, error: null }];
    const errors = Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === "string") : [];
    const detail = errors.join("; ") || str(msg.result) || str(msg.subtype) || "unknown error";
    return [{ kind: "result", ok: false, error: `Claude: ${detail}` }];
  }
  return [];
}

/** Tools present in a session that are not drawer's; non-empty means the turn must not run. */
export function foreignTools(tools: string[]): string[] {
  return tools.filter((t) => !t.startsWith(TOOL_PREFIX));
}

/**
 * The tool_use id of an in-process MCP call. Claude Code sends it in the request's `_meta` under
 * this key, and the SDK hands the request's `_meta` to the handler in `extra`.
 */
export const TOOL_USE_ID_META = "claudecode/toolUseId";

export function toolUseIdOf(extra: unknown): string | null {
  if (!isRecord(extra) || !isRecord(extra._meta)) return null;
  return str(extra._meta[TOOL_USE_ID_META]);
}

/** The SDK handler for one drawer tool: runs it and keeps its output under the call's tool_use id. */
export function toolHandler(t: BoundTool, outputs: Map<string, ToolOutput>) {
  return async (args: unknown, extra: unknown) => {
    const out = await t.call(args);
    const id = toolUseIdOf(extra);
    if (id !== null) outputs.set(id, out);
    return { content: toContent(out), isError: !out.ok };
  };
}

/** The finished event for a tool_result: from the call's own output when there is one, else from the result text. */
export function toolFinished(ev: { id: string; isError: boolean; text: string }, name: string, out: ToolOutput | undefined): ProviderEvent {
  return {
    type: "tool_finished",
    callId: ev.id,
    name,
    ok: out ? out.ok : !ev.isError,
    summary: out?.summary ?? ev.text.split("\n")[0] ?? name,
    text: out?.text ?? ev.text,
    images: out?.imageUrls ?? [],
  };
}

const toContent = (out: ToolOutput) => [
  { type: "text" as const, text: out.text },
  ...out.images.map((img) => ({ type: "image" as const, data: Buffer.from(img).toString("base64"), mimeType: imageMediaType(img) ?? "image/png" })),
];

/** The person's messages as one user message: each message's text, then its images. */
export function promptMessage(messages: TurnMessage[]): SDKUserMessage {
  const content = messages.flatMap((m, i) => [
    { type: "text" as const, text: i === 0 ? m.text : `\n\n${m.text}` },
    ...m.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: Buffer.from(img.data).toString("base64") } })),
  ]);
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

async function* once<T>(value: T): AsyncIterable<T> {
  yield value;
}

export interface ClaudeOptions {
  /** Where each session gets an empty working directory. */
  stateDir: string;
  /** Claude Code as the runner's host configured it (DRAWER_AGENT_CLAUDE_BIN); unset = the SDK's own. */
  binary?: string;
  /** Test seam and smoke-test override. */
  maxTurns?: number;
}

/** The aliases Claude Code resolves to its current models. */
export const CLAUDE_MODELS = ["sonnet", "opus", "haiku"];
const SIGN_IN = "Run `claude auth login` on the runner's host.";

/** The Claude Code binary the SDK ships in its per-platform package, next to the SDK's own folder. */
export async function bundledClaude(): Promise<string | null> {
  const sdkDir = dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")));
  const base = `claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of [base, `${base}-musl`]) {
    const path = join(dirname(sdkDir), pkg, "claude");
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}

/** `claude auth status --json` → signed in or not; null when the output is not that. */
export function parseAuthStatus(stdout: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) && typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null;
  } catch {
    return null;
  }
}

export class ClaudeProvider implements Provider {
  readonly kind = "claude";

  constructor(private readonly opts: ClaudeOptions) {}

  async check(): Promise<ProviderCheck> {
    const configured = this.opts.binary ?? null;
    const bin = configured ?? (await bundledClaude());
    if (bin === null || !(await Bun.file(bin).exists())) {
      return { state: "not_installed", version: null, models: [], message: configured ? `${configured} does not exist` : "the Agent SDK's Claude Code binary is missing: run bun install", binary: null };
    }
    const version = await capture([bin, "--version"], { timeoutMs: 20_000 });
    if (version.code !== 0) return { state: "unavailable", version: null, models: [], message: `\`${bin} --version\` failed: ${(version.stderr || version.stdout).trim().slice(0, 200)}`, binary: bin };
    const auth = await capture([bin, "auth", "status", "--json"], { timeoutMs: 20_000 });
    const signedIn = parseAuthStatus(auth.stdout);
    const base = { version: versionOf(version.stdout), models: CLAUDE_MODELS, binary: bin };
    if (signedIn === false) return { ...base, state: "signed_out", message: SIGN_IN };
    return { ...base, state: "ready", message: signedIn === null ? "Sign-in not checked." : null };
  }

  async run(turn: Turn): Promise<void> {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (turn.signal.aborted) abort.abort();
    turn.signal.addEventListener("abort", onAbort, { once: true });

    // A finished output waits here, under its tool_use id, until the tool_result message for that id
    // arrives; two calls of one tool running side by side cannot swap results.
    const outputs = new Map<string, ToolOutput>();
    const names = new Map<string, string>();

    const server = createSdkMcpServer({
      name: SERVER_NAME,
      version: "1",
      alwaysLoad: true,
      tools: turn.tools.map((t: BoundTool) =>
        tool(t.name, t.description, t.input, toolHandler(t, outputs)),
      ),
    });

    const cwd = join(this.opts.stateDir, "sessions", sanitize(turn.sessionId));
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const allowed = turn.tools.map((t) => `${TOOL_PREFIX}${t.name}`);

    const q = query({
      prompt: once(promptMessage(turn.messages)),
      options: {
        systemPrompt: turn.systemPrompt,
        tools: [],
        disallowedTools: [...BUILTIN_TOOL_NAMES],
        allowedTools: allowed,
        mcpServers: { [SERVER_NAME]: server },
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: "dontAsk",
        // Adaptive is the SDK's own default where the model has it; asking for the summary is what makes
        // the model's thinking come back as text, and the partial messages are how it arrives as it grows.
        thinking: { type: "adaptive", display: "summarized" },
        includePartialMessages: true,
        cwd,
        abortController: abort,
        ...(turn.resume ? { resume: turn.resume } : {}),
        ...(turn.model ? { model: turn.model } : {}),
        ...(this.opts.binary ? { pathToClaudeCodeExecutable: this.opts.binary } : {}),
        ...(this.opts.maxTurns !== undefined ? { maxTurns: this.opts.maxTurns } : {}),
      },
    });

    const emit = (e: ProviderEvent) => turn.onEvent(e);
    const thoughts = new Thoughts(emit);
    // An index repeats in every API call of the turn: number the thoughts instead.
    const openThoughts = new Map<number, string>();
    let thoughtCount = 0;
    let finished = false;
    try {
      for await (const msg of q) {
        for (const ev of mapSdkMessage(msg)) {
          if (ev.kind === "init") {
            const foreign = foreignTools(ev.tools);
            if (foreign.length > 0) {
              abort.abort();
              throw new ForeignToolError(`would have tools other than drawer's (${foreign.join(", ")})`);
            }
            if (ev.sessionId) emit({ type: "resume", handle: ev.sessionId });
          } else if (ev.kind === "thinking_start") {
            openThoughts.set(ev.index, `t${thoughtCount++}`);
          } else if (ev.kind === "thinking_delta") {
            const key = openThoughts.get(ev.index);
            if (key !== undefined) thoughts.append(key, ev.text);
          } else if (ev.kind === "thinking_stop") {
            const key = openThoughts.get(ev.index);
            if (key !== undefined) thoughts.end(key);
            openThoughts.delete(ev.index);
          } else if (ev.kind === "text") {
            emit({ type: "assistant_text", text: ev.text });
          } else if (ev.kind === "tool_use") {
            const name = ev.name.startsWith(TOOL_PREFIX) ? ev.name.slice(TOOL_PREFIX.length) : ev.name;
            names.set(ev.id, name);
            emit({ type: "tool_started", callId: ev.id, name, input: ev.input });
            emit({ type: "activity", text: `running ${name}` });
          } else if (ev.kind === "tool_result") {
            const out = outputs.get(ev.id);
            outputs.delete(ev.id);
            emit(toolFinished(ev, names.get(ev.id) ?? "tool", out));
            emit({ type: "activity", text: "thinking" });
          } else {
            finished = true;
            if (!ev.ok) throw new Error(ev.error ?? "Claude failed");
          }
        }
      }
      if (!finished && !turn.signal.aborted) throw new Error("Claude ended the turn without a result");
    } finally {
      turn.signal.removeEventListener("abort", onAbort);
      thoughts.endAll();
      q.close();
    }
  }
}

const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
