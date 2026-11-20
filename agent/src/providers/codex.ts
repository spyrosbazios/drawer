/**
 * OpenAI Codex through `codex app-server` (JSON-RPC over stdio; https://developers.openai.com/codex/app-server),
 * one process per turn, with drawer's tools as the only MCP server and every built-in tool removed.
 *
 * How the model is kept to drawer's tools (each verified on Codex 0.170 with `codex debug prompt-input`,
 * which renders the model-visible tool list without a model call):
 * - Codex runs with its own CODEX_HOME (an empty config.toml): none of the person's MCP servers, hooks,
 *   skills, plugins or memories exist there. It is signed in once, separately, so the person's own
 *   login is never shared (Codex coordinates token refresh with lock files inside its home).
 * - A model catalog with `tool_mode: "direct"` (no JS `exec` code mode), `shell_type: "disabled"`, no
 *   `apply_patch_tool_type`, no experimental tools and no search tool. `apply_patch` has no switch of
 *   its own any more; only the catalog removes it.
 * - Feature switches off: shell, view_image, apps (hosted connectors), plugins, sleep, sub-agents,
 *   request_user_input, hooks, memories, skills; `web_search = "disabled"`.
 * - What is left: the `mcp__drawer` tools and Codex's three MCP resource readers, which cannot be
 *   switched off. They could reach only drawer's server (the only one configured, serving no
 *   resources), and using one still fails the turn.
 * - Sandbox `read-only` and approval policy `never`; every approval request is declined. The host has
 *   no bubblewrap, so the sandbox is not relied on: the tools are simply not there.
 * - At run time any item that is not a message, reasoning or a drawer MCP call fails the turn.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMcpToolServer, MCP_SERVER_NAME } from "../mcp-server.ts";
import { ForeignToolError, type Provider, type ProviderCheck, type Turn } from "../provider.ts";
import { abortable, capture, compareVersions, findBinary, isRecord, JsonRpcPeer, readJsonLines, str, versionOf } from "./process.ts";

/** The lockdown above was verified on this version; an older Codex may not know every switch. */
export const CODEX_MIN_VERSION = "0.170.0";
const CATALOG_FILE = "drawer-models.json";
const TOKEN_ENV = "DRAWER_MCP_TOKEN";

/** Items a drawer turn may produce. Anything else is a tool drawer did not give. */
const ALLOWED_ITEMS = new Set(["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction", "mcpToolCall"]);

/** Codex's model catalog (`codex debug models`) with every built-in tool switched off in each model. */
export function lockCatalog(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.models)) throw new Error("codex debug models: not a model catalog");
  return {
    ...raw,
    models: raw.models.map((m: unknown) => {
      if (!isRecord(m)) return m;
      const { apply_patch_tool_type: _patch, ...rest } = m;
      return { ...rest, tool_mode: "direct", shell_type: "disabled", experimental_supported_tools: [], node_repl_disabled: true, supports_search_tool: false };
    }),
  };
}

/** The `-c` overrides for `codex app-server`: only drawer's MCP server, no built-in tools. */
export function lockdownArgs(catalogPath: string, mcpUrl: string): string[] {
  const settings: [string, string][] = [
    ["model_catalog_json", JSON.stringify(catalogPath)],
    ["web_search", '"disabled"'],
    ["features.shell_tool", "false"],
    ["features.view_image", "false"],
    ["features.apps", "false"],
    ["features.plugins", "false"],
    ["features.sleep_tool", "false"],
    ["features.hooks", "false"],
    ["features.memories", "false"],
    ["features.skip_host_skill_discovery", "true"],
    ["agents.enabled", "false"],
    ["tools.experimental_request_user_input.enabled", "false"],
    ["skills.include_instructions", "false"],
    ["skills.bundled.enabled", "false"],
    ["include_permissions_instructions", "false"],
    ["include_apps_instructions", "false"],
    ["include_collaboration_mode_instructions", "false"],
    ["project_doc_max_bytes", "0"],
    ["history.persistence", '"none"'],
    [`mcp_servers.${MCP_SERVER_NAME}.url`, JSON.stringify(mcpUrl)],
    [`mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var`, JSON.stringify(TOKEN_ENV)],
    [`mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode`, '"approve"'],
    [`mcp_servers.${MCP_SERVER_NAME}.required`, "true"],
    // ask_user waits for a person's answer.
    [`mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec`, "21600"],
  ];
  return settings.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

/** Why an item started in a turn is not allowed, or null when it is. */
export function foreignItem(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const type = str(item.type) ?? "";
  if (!ALLOWED_ITEMS.has(type)) return `tried to use ${type || "an unknown tool"}`;
  if (type === "mcpToolCall" && item.server !== MCP_SERVER_NAME) return `tried to use the MCP server ${str(item.server) ?? "?"}`;
  return null;
}

/** Answers to Codex's requests: decline everything. `foreign` is set for a request to run something. */
export function answerServerRequest(method: string): { result: unknown; foreign: string | null } {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { result: { decision: "decline" }, foreign: "asked to run a command" };
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" }, foreign: "asked to change files" };
    case "execCommandApproval":
      return { result: { decision: { denied: { rejection: "drawer allows its own tools only" } } }, foreign: "asked to run a command" };
    case "applyPatchApproval":
      return { result: { decision: { denied: { rejection: "drawer allows its own tools only" } } }, foreign: "asked to change files" };
    case "item/permissions/requestApproval":
      return { result: { permissions: {}, scope: "turn" }, foreign: "asked for more permissions" };
    case "item/tool/requestUserInput":
      return { result: { answers: {} }, foreign: null };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline", content: null, _meta: null }, foreign: null };
    default:
      return { result: null, foreign: `sent an unknown request (${method})` };
  }
}

export interface CodexOptions {
  /** The runner's state directory: Codex's home and the per-session working directories live here. */
  stateDir: string;
  /** The CLI as the runner's host configured it (DRAWER_AGENT_CODEX_BIN); unset = found on the PATH. */
  binary?: string;
}

const SIGN_IN = (home: string) => `Sign in once for drawer: CODEX_HOME=${home} codex login`;

export class CodexProvider implements Provider {
  readonly kind = "codex";
  private readonly home: string;

  constructor(private readonly opts: CodexOptions) {
    this.home = join(opts.stateDir, "codex-home");
  }

  private env(extra: Record<string, string> = {}): Record<string, string | undefined> {
    return { ...process.env, CODEX_HOME: this.home, ...extra };
  }

  private async ensureHome(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    // drawer's own home: nothing configured, so nothing of the person's leaks into a turn.
    await writeFile(join(this.home, "config.toml"), "# Written by the drawer agent runner. Settings come from its -c flags.\n");
  }

  /** Writes the locked catalog for this Codex binary; returns its path. */
  private async writeCatalog(bin: string): Promise<string> {
    const out = await capture([bin, "debug", "models"], { env: this.env(), timeoutMs: 30_000 });
    if (out.code !== 0) throw new Error(`codex debug models failed: ${(out.stderr || out.stdout).trim().slice(0, 300)}`);
    const path = join(this.home, CATALOG_FILE);
    await writeFile(path, JSON.stringify(lockCatalog(JSON.parse(out.stdout))));
    return path;
  }

  async check(): Promise<ProviderCheck> {
    const configured = this.opts.binary ?? null;
    const bin = await findBinary("codex", configured);
    if (bin === null) return { state: "not_installed", version: null, models: [], message: configured ? `${configured} is not an executable` : "Install the Codex CLI on the runner's host.", binary: null };
    const v = await capture([bin, "--version"]);
    const version = versionOf(v.stdout);
    if (v.code !== 0 || version === null) return { state: "unavailable", version: null, models: [], message: `\`codex --version\` failed: ${(v.stderr || v.stdout).trim().slice(0, 200)}`, binary: bin };
    if (compareVersions(version, CODEX_MIN_VERSION) < 0) {
      return { state: "unavailable", version, models: [], message: `drawer needs Codex ${CODEX_MIN_VERSION} or newer to switch off its built-in tools.`, binary: bin };
    }
    await this.ensureHome();
    await this.writeCatalog(bin);
    const login = await capture([bin, "login", "status"], { env: this.env() });
    if (login.code !== 0) return { state: "signed_out", version, models: [], message: SIGN_IN(this.home), binary: bin };
    return { state: "ready", version, models: await this.listModels(bin), message: null, binary: bin };
  }

  /** `model/list` from a short-lived app-server. */
  private async listModels(bin: string): Promise<string[]> {
    const proc = Bun.spawn([bin, "app-server"], { env: this.env(), stdin: "pipe", stdout: "pipe", stderr: "ignore", cwd: this.home });
    const peer = new JsonRpcPeer({ write: (line) => void proc.stdin.write(line) }, { onNotification: () => {}, onRequest: async () => null }, false);
    const reading = readJsonLines(proc.stdout, (v) => peer.receive(v));
    try {
      const timeout = AbortSignal.timeout(20_000);
      await abortable(timeout, peer.request("initialize", { clientInfo: { name: "drawer", title: null, version: "1" }, capabilities: { experimentalApi: false } }));
      peer.notify("initialized", undefined);
      const list = await abortable(timeout, peer.request<unknown>("model/list", { includeHidden: false }));
      const data = isRecord(list) && Array.isArray(list.data) ? list.data : [];
      return data.filter((m): m is Record<string, unknown> => isRecord(m) && m.hidden !== true).map((m) => str(m.model) ?? str(m.id) ?? "").filter((m) => m !== "");
    } finally {
      peer.close(new Error("closed"));
      proc.stdin.end();
      proc.kill();
      await reading.catch(() => undefined);
    }
  }

  async run(turn: Turn): Promise<void> {
    const bin = await findBinary("codex", this.opts.binary ?? null);
    if (bin === null) throw new Error("the Codex CLI is not installed on the runner's host");
    await this.ensureHome();
    const catalog = await this.writeCatalog(bin);
    const cwd = join(this.opts.stateDir, "sessions", turn.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    await mkdir(cwd, { recursive: true, mode: 0o700 });

    const mcp = startMcpToolServer({ tools: turn.tools, onEvent: (e) => turn.onEvent(e) });
    const proc = Bun.spawn([bin, "app-server", "--strict-config", ...lockdownArgs(catalog, mcp.url)], {
      cwd,
      env: this.env({ [TOKEN_ENV]: mcp.token }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(proc.stderr).text();

    let threadId: string | null = null;
    let turnId: string | null = null;
    let lastError: string | null = null;
    const { promise: completed, resolve } = Promise.withResolvers<void>();
    const { promise: failed, reject: fail } = Promise.withResolvers<never>();
    // A failure before anyone awaits is not an unhandled rejection; the first outcome wins.
    failed.catch(() => undefined);
    const race = <T>(p: Promise<T>) => Promise.race([p, failed]);

    const peer = new JsonRpcPeer(
      { write: (line) => void proc.stdin.write(line) },
      {
        onRequest: async (method) => {
          const { result, foreign } = answerServerRequest(method);
          if (foreign !== null) fail(new ForeignToolError(foreign));
          return result;
        },
        onNotification: (method, params) => {
          if (!isRecord(params)) return;
          if (method === "item/started") {
            const why = foreignItem(params.item);
            if (why !== null) fail(new ForeignToolError(why));
          } else if (method === "item/completed") {
            const item = params.item;
            if (isRecord(item) && item.type === "agentMessage") {
              const text = (str(item.text) ?? "").trim();
              if (text) turn.onEvent({ type: "assistant_text", text });
            }
          } else if (method === "turn/started") {
            if (isRecord(params.turn)) turnId = str(params.turn.id) ?? turnId;
          } else if (method === "error") {
            if (params.willRetry !== true && isRecord(params.error)) lastError = str(params.error.message);
          } else if (method === "turn/completed") {
            const t = isRecord(params.turn) ? params.turn : {};
            if (t.status === "completed") resolve();
            else if (t.status === "interrupted") fail(new Error("the turn was interrupted"));
            else {
              const err = isRecord(t.error) ? str(t.error.message) : null;
              fail(new Error(`Codex: ${err ?? lastError ?? `the turn ended ${str(t.status) ?? "without a result"}`}`));
            }
          }
        },
      },
      false,
    );
    const reading = readJsonLines(proc.stdout, (v) => peer.receive(v)).then(async () => {
      const tail = (await stderr).trim().split("\n").slice(-3).join(" ").slice(0, 400);
      const err = new Error(`Codex exited before the turn ended${tail ? `: ${tail}` : ""}`);
      peer.close(err);
      fail(err);
    });

    const onAbort = () => {
      if (threadId !== null && turnId !== null) void peer.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      fail(new Error("aborted"));
    };
    turn.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (turn.signal.aborted) throw new Error("aborted");
      await race(peer.request("initialize", { clientInfo: { name: "drawer", title: null, version: "1" }, capabilities: { experimentalApi: false } }));
      peer.notify("initialized", undefined);
      const threadParams = {
        cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: turn.systemPrompt,
        ...(turn.model ? { model: turn.model } : {}),
      };
      const started = await race(peer.request<unknown>(turn.resume ? "thread/resume" : "thread/start", turn.resume ? { threadId: turn.resume, ...threadParams } : threadParams));
      threadId = isRecord(started) && isRecord(started.thread) ? str(started.thread.id) : null;
      if (threadId === null) throw new Error("Codex started no thread");
      turn.onEvent({ type: "resume", handle: threadId });
      turn.onEvent({ type: "activity", text: "thinking" });
      const res = await race(peer.request<unknown>("turn/start", { threadId, input: turn.messages.flatMap((m) => [{ type: "text", text: m.text, text_elements: [] }, ...m.images.map((i) => ({ type: "image", url: `data:${i.mediaType};base64,${Buffer.from(i.data).toString("base64")}` }))]) }));
      if (isRecord(res) && isRecord(res.turn)) turnId = str(res.turn.id) ?? turnId;
      if (turn.signal.aborted) onAbort();
      await race(completed);
    } finally {
      turn.signal.removeEventListener("abort", onAbort);
      // Give an interrupt a moment to reach Codex, then end the process.
      if (turn.signal.aborted) await Bun.sleep(200);
      proc.stdin.end();
      proc.kill();
      await Promise.allSettled([proc.exited, reading]);
      await mcp.close();
    }
  }
}
