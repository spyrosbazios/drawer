/**
 * Google's Gemini CLI as an Agent Client Protocol agent (`gemini --acp`; JSON-RPC over stdio,
 * https://agentclientprotocol.com/protocol/prompt-turn), one process per turn, with drawer's tools as
 * its only MCP server.
 *
 * How the model is kept to drawer's tools (from the Gemini CLI source, packages/cli/src/acp and
 * packages/core/src/config; not run on this host, where Gemini is not installed):
 * - A system settings file (GEMINI_CLI_SYSTEM_SETTINGS_PATH, which overrides every other settings
 *   layer) with `tools.core: []` (no built-in tool is registered), `mcp.allowed: ["drawer"]` (no other
 *   MCP server connects) and extensions off.
 * - An admin policy that denies every tool and allows drawer's MCP server only (`--admin-policy`), and
 *   `--allowed-mcp-server-names drawer`.
 * - GEMINI_SYSTEM_MD replaces the system prompt with drawer's.
 * - The client advertises no file system or terminal capability, and sends inline image blocks (a
 *   `resource_link` would make Gemini read the file itself).
 * - At run time: a permission request is rejected and fails the turn; a tool call of any kind but
 *   `other` (MCP tools are `other`; reading, editing, running, fetching are not) fails the turn.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startMcpToolServer, MCP_SERVER_NAME } from "../mcp-server.ts";
import { ForeignToolError, type Provider, type ProviderCheck, type Turn } from "../provider.ts";
import { capture, compareVersions, findBinary, isRecord, JsonRpcPeer, literalPrompt, readJsonLines, RpcError, str, versionOf, withScratchDir } from "./process.ts";

/** `--acp` (not the older `--experimental-acp`) and the settings above are from this release on. */
export const GEMINI_MIN_VERSION = "0.70.0";
/** Gemini's model ids (packages/core/src/config/models.ts); `auto` lets Gemini route. */
export const GEMINI_MODELS = ["auto", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-pro-preview", "gemini-3-flash-preview"];
const SIGN_IN = "Sign in on the runner's host: run `gemini` once and choose a login.";

/** Settings that leave Gemini with no built-in tool and no MCP server but drawer's. */
export function systemSettings(): unknown {
  return {
    tools: { core: [] },
    mcp: { allowed: [MCP_SERVER_NAME] },
    admin: { extensions: { enabled: false } },
  };
}

/** The admin policy: everything denied, drawer's MCP server allowed. */
export function adminPolicy(): string {
  return [
    "[[rule]]",
    'toolName = "*"',
    'decision = "deny"',
    "priority = 100",
    "",
    "[[rule]]",
    `mcpName = "${MCP_SERVER_NAME}"`,
    'decision = "allow"',
    "priority = 200",
    "",
  ].join("\n");
}

/** Why a `session/update` shows a tool drawer did not give, or null. */
export function foreignUpdate(update: unknown): string | null {
  if (!isRecord(update)) return null;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
  const kind = str(update.kind);
  if (kind === null || kind === "other") return null;
  return `tried to use a ${kind} tool (${str(update.title) ?? "untitled"})`;
}

/** The answer to `session/request_permission`: reject once (or cancel when no reject option exists). */
export function rejectPermission(params: unknown): unknown {
  const options = isRecord(params) && Array.isArray(params.options) ? params.options : [];
  const reject = options.find((o) => isRecord(o) && (o.kind === "reject_once" || o.kind === "reject_always"));
  const optionId = isRecord(reject) ? str(reject.optionId) : null;
  return { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } };
}

/** How Gemini can be signed in, without a model call: an API key, Vertex settings, or a saved Google login. */
export async function geminiSignedIn(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI || env.GOOGLE_GENAI_USE_GCA) return true;
  const home = env.GEMINI_CLI_HOME || env.HOME || homedir();
  return Bun.file(join(home, ".gemini", "oauth_creds.json")).exists();
}

export interface GeminiOptions {
  stateDir: string;
  /** The CLI as the runner's host configured it (DRAWER_AGENT_GEMINI_BIN); unset = found on the PATH. */
  binary?: string;
}

export class GeminiProvider implements Provider {
  readonly kind = "gemini";

  constructor(private readonly opts: GeminiOptions) {}

  async check(): Promise<ProviderCheck> {
    const configured = this.opts.binary ?? null;
    const bin = await findBinary("gemini", configured);
    if (bin === null) return { state: "not_installed", version: null, models: [], message: configured ? `${configured} is not an executable` : "Install the Gemini CLI on the runner's host (npm i -g @google/gemini-cli).", binary: null };
    const v = await capture([bin, "--version"]);
    const version = versionOf(v.stdout);
    if (v.code !== 0 || version === null) return { state: "unavailable", version: null, models: [], message: `\`gemini --version\` failed: ${(v.stderr || v.stdout).trim().slice(0, 200)}`, binary: bin };
    if (compareVersions(version, GEMINI_MIN_VERSION) < 0) return { state: "unavailable", version, models: [], message: `drawer needs Gemini CLI ${GEMINI_MIN_VERSION} or newer.`, binary: bin };
    if (!(await geminiSignedIn())) return { state: "signed_out", version, models: GEMINI_MODELS, message: SIGN_IN, binary: bin };
    return { state: "ready", version, models: GEMINI_MODELS, message: null, binary: bin };
  }

  async run(turn: Turn): Promise<void> {
    const bin = await findBinary("gemini", this.opts.binary ?? null);
    if (bin === null) throw new Error("the Gemini CLI is not installed on the runner's host");
    // Gemini keys saved sessions by working directory: the same empty one every turn of a drawer session.
    const cwd = join(this.opts.stateDir, "sessions", turn.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    await mkdir(cwd, { recursive: true, mode: 0o700 });

    await withScratchDir(this.opts.stateDir, async (dir) => {
      await writeFile(join(dir, "settings.json"), JSON.stringify(systemSettings()));
      await mkdir(join(dir, "policy"), { mode: 0o700 });
      await writeFile(join(dir, "policy", "drawer.toml"), adminPolicy());
      await writeFile(join(dir, "system.md"), turn.systemPrompt);
      const mcp = startMcpToolServer({ tools: turn.tools, onEvent: (e) => turn.onEvent(e) });
      const proc = Bun.spawn(
        [bin, "--acp", "--admin-policy", join(dir, "policy"), "--allowed-mcp-server-names", MCP_SERVER_NAME, "--approval-mode", "default", ...(turn.model ? ["--model", turn.model] : [])],
        {
          cwd,
          env: { ...process.env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(dir, "settings.json"), GEMINI_SYSTEM_MD: join(dir, "system.md") },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = new Response(proc.stderr).text();
      const { promise: failed, reject: fail } = Promise.withResolvers<never>();
      failed.catch(() => undefined);

      let sessionId: string | null = null;
      // `session/load` replays the history as updates; they are not this turn's.
      let replaying = false;
      let text = "";
      const flush = () => {
        const t = text.trim();
        text = "";
        if (t) turn.onEvent({ type: "assistant_text", text: t });
      };

      const peer = new JsonRpcPeer(
        { write: (line) => void proc.stdin.write(line) },
        {
          onRequest: async (method, params) => {
            if (method === "session/request_permission") {
              fail(new ForeignToolError("asked for permission to use a tool"));
              return rejectPermission(params);
            }
            throw new RpcError(-32601, `drawer does not offer ${method}`);
          },
          onNotification: (method, params) => {
            if (method !== "session/update" || !isRecord(params) || replaying) return;
            const update = params.update;
            const why = foreignUpdate(update);
            if (why !== null) {
              if (sessionId !== null) peer.notify("session/cancel", { sessionId });
              fail(new ForeignToolError(why));
              return;
            }
            if (!isRecord(update)) return;
            if (update.sessionUpdate === "agent_message_chunk") {
              const meta = isRecord(update._meta) ? update._meta : {};
              // A retried or reset response replaces what came before.
              if (meta.retry === true || meta.reset === true) text = "";
              const content = update.content;
              if (isRecord(content) && content.type === "text") text += str(content.text) ?? "";
            } else if (update.sessionUpdate === "tool_call") flush();
          },
        },
      );
      const reading = readJsonLines(proc.stdout, (v) => peer.receive(v)).then(async () => {
        const tail = (await stderr).trim().split("\n").slice(-3).join(" ").slice(0, 400);
        const err = new Error(`Gemini exited before the turn ended${tail ? `: ${tail}` : ""}`);
        peer.close(err);
        fail(err);
      });
      const onAbort = () => {
        if (sessionId !== null) peer.notify("session/cancel", { sessionId });
        fail(new Error("aborted"));
      };
      turn.signal.addEventListener("abort", onAbort, { once: true });
      const race = <T>(p: Promise<T>) => Promise.race([p, failed]);
      try {
        if (turn.signal.aborted) throw new Error("aborted");
        const initialized = await race(peer.request<unknown>("initialize", { protocolVersion: 1, clientCapabilities: {} }));
        const capabilities = isRecord(initialized) && isRecord(initialized.agentCapabilities) ? initialized.agentCapabilities : {};
        // ACP agents without the image prompt capability receive the attachment descriptions only.
        const supportsImages = isRecord(capabilities.promptCapabilities) && capabilities.promptCapabilities.image === true;
        const mcpServers = [{ type: "http", name: MCP_SERVER_NAME, url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }] }];
        if (turn.resume) {
          replaying = true;
          await race(peer.request("session/load", { sessionId: turn.resume, cwd, mcpServers }));
          replaying = false;
          sessionId = turn.resume;
        } else {
          const created = await race(peer.request<unknown>("session/new", { cwd, mcpServers }));
          sessionId = isRecord(created) ? str(created.sessionId) : null;
          if (sessionId === null) throw new Error("Gemini started no session");
        }
        turn.onEvent({ type: "resume", handle: sessionId });
        turn.onEvent({ type: "activity", text: "thinking" });
        const result = await race(peer.request<unknown>("session/prompt", { sessionId, prompt: [{ type: "text", text: literalPrompt(turn.messages.map((m) => m.text).join("\n\n")) }, ...turn.messages.flatMap((m) => supportsImages ? m.images.map((i) => ({ type: "image", mimeType: i.mediaType, data: Buffer.from(i.data).toString("base64") })) : [])] }));
        flush();
        const stop = isRecord(result) ? str(result.stopReason) : null;
        if (stop === "cancelled") throw new Error("aborted");
        if (stop === "refusal") throw new Error("Gemini refused the request");
        if (stop !== "end_turn") throw new Error(`Gemini ended the turn: ${stop ?? "no stop reason"}`);
      } finally {
        turn.signal.removeEventListener("abort", onAbort);
        proc.stdin.end();
        proc.kill();
        await Promise.allSettled([proc.exited, reading]);
        await mcp.close();
      }
    });
  }
}
