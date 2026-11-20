import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { addressedHere, bearerMatches, callResult, handleRpc, inputSchema, startMcpToolServer } from "../src/mcp-server.ts";
import { ForeignToolError, type BoundTool, type Provider, type ProviderEvent, type Turn } from "../src/provider.ts";
import { answerServerRequest, CodexProvider, foreignItem, lockCatalog, lockdownArgs } from "../src/providers/codex.ts";
import { adminPolicy, foreignUpdate, GeminiProvider, rejectPermission, systemSettings } from "../src/providers/gemini.ts";
import { assistantError, assistantText, mcpConfig, modelIds, piArgs, PiProvider } from "../src/providers/pi.ts";
import { compareVersions, JsonRpcPeer, literalPrompt, versionOf } from "../src/providers/process.ts";
import type { ToolOutput } from "../src/tools.ts";

const PNG = new Uint8Array([137, 80, 78, 71]);
const out = (text: string, extra: Partial<ToolOutput> = {}): ToolOutput => ({ ok: true, text, summary: `${text} summary`, images: [], imageUrls: [], ...extra });

const overview: BoundTool = {
  name: "overview",
  description: "Project overview",
  input: {},
  call: async () => out("the overview", { images: [PNG], imageUrls: ["/api/renders/k/sheet.png"] }),
};
const placed: BoundTool = { name: "place", description: "Place", input: { at: z.array(z.number()).length(3), part: z.string() }, call: async () => out("placed") };

describe("drawer's MCP server", () => {
  test("lists the tools with draft-07 schemas and no tuples", async () => {
    const res = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { tools: [overview, placed], onEvent: () => {} })) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    expect(res.result.tools.map((t) => t.name)).toEqual(["overview", "place"]);
    const schema = JSON.stringify(inputSchema(placed));
    expect(schema).not.toContain("prefixItems");
    expect(schema).not.toContain('"items":[');
    expect(schema).not.toContain("$schema");
  });

  test("initialize agrees on a protocol version; notifications get no answer", async () => {
    const init = (await handleRpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, { tools: [], onEvent: () => {} })) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-03-26");
    const newer = (await handleRpc({ id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }, { tools: [], onEvent: () => {} })) as { result: { protocolVersion: string } };
    expect(newer.result.protocolVersion).toBe("2025-06-18");
    expect(await handleRpc({ method: "notifications/initialized" }, { tools: [], onEvent: () => {} })).toBeNull();
  });

  test("a call records tool_started and tool_finished with the call's own images", async () => {
    const events: ProviderEvent[] = [];
    const res = await handleRpc({ id: 3, method: "tools/call", params: { name: "overview", arguments: {} } }, { tools: [overview], onEvent: (e) => events.push(e), callId: () => "c1" });
    expect(res).toEqual({ jsonrpc: "2.0", id: 3, result: callResult(await overview.call({})) });
    expect(events).toEqual([
      { type: "tool_started", callId: "c1", name: "overview", input: {} },
      { type: "activity", text: "running overview" },
      { type: "tool_finished", callId: "c1", name: "overview", ok: true, summary: "the overview summary", text: "the overview", images: ["/api/renders/k/sheet.png"] },
      { type: "activity", text: "thinking" },
    ]);
    expect(callResult(await overview.call({})).content[1]).toEqual({ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" });
  });

  test("an unknown tool is an error, not a call", async () => {
    const events: ProviderEvent[] = [];
    const res = (await handleRpc({ id: 4, method: "tools/call", params: { name: "bash" } }, { tools: [overview], onEvent: (e) => events.push(e) })) as { error: { code: number } };
    expect(res.error.code).toBe(-32602);
    expect(events).toEqual([]);
  });

  test("over HTTP: the bearer token is required; GET is not served", async () => {
    const server = startMcpToolServer({ tools: [overview], onEvent: () => {} });
    try {
      const post = (token: string) =>
        fetch(server.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
      expect((await post("wrong")).status).toBe(401);
      const ok = await post(server.token);
      expect(await ok.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
      expect((await fetch(server.url, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(405);
      const note = await fetch(server.url, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
      expect(note.status).toBe(202);
      expect(new URL(server.url).hostname).toBe("127.0.0.1");
      expect(server.token).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  test("a request by another name (DNS rebinding) or from a web origin is refused; the token compares exactly", () => {
    const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:4000/mcp", { method: "POST", headers });
    expect(addressedHere(req({ host: "127.0.0.1:4000" }), 4000)).toBe(true);
    expect(addressedHere(req({ host: "evil.example:4000" }), 4000)).toBe(false);
    expect(addressedHere(req({ host: "localhost:4000" }), 4000)).toBe(false);
    expect(addressedHere(req({ host: "127.0.0.1:4000", origin: "http://evil.example" }), 4000)).toBe(false);
    expect(bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerMatches("Bearer abd", "abc")).toBe(false);
    expect(bearerMatches("Bearer abcd", "abc")).toBe(false);
    expect(bearerMatches(null, "abc")).toBe(false);
  });
});

describe("process helpers", () => {
  test("versions", () => {
    expect(versionOf("codex-cli 0.170.0\n")).toBe("0.170.0");
    expect(compareVersions("0.170.0", "0.170.0")).toBe(0);
    expect(compareVersions("0.169.9", "0.170.0")).toBe(-1);
    expect(compareVersions("1.0", "0.170.0")).toBe(1);
  });

  test("a message that starts like a CLI command is passed as text", () => {
    expect(literalPrompt("/init")).toBe("Message:\n/init");
    expect(literalPrompt("  $x")).toBe("Message:\n  $x");
    expect(literalPrompt("make a clip /2")).toBe("make a clip /2");
  });

  test("JSON-RPC peer: requests, errors, and requests from the other side", async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer({ write: (l) => sent.push(JSON.parse(l)) }, { onNotification: () => {}, onRequest: async (m) => ({ echo: m }) });
    const p = peer.request("a", {});
    peer.receive({ jsonrpc: "2.0", id: 1, result: 5 });
    expect(await p).toBe(5);
    const q = peer.request("b", {});
    peer.receive({ id: 2, error: { code: -1, message: "nope" } });
    await expect(q).rejects.toThrow("nope");
    peer.receive({ jsonrpc: "2.0", id: "x", method: "ask", params: {} });
    await Bun.sleep(1);
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: "x", result: { echo: "ask" } });
    const r = peer.request("c", {});
    peer.close(new Error("gone"));
    await expect(r).rejects.toThrow("gone");
  });
});

describe("codex lockdown", () => {
  test("the catalog switches every built-in off in every model", () => {
    const locked = lockCatalog({ models: [{ slug: "m", tool_mode: "code_mode_only", apply_patch_tool_type: "freeform", shell_type: "unified_exec", experimental_supported_tools: ["clock"] }] }) as { models: Record<string, unknown>[] };
    expect(locked.models[0]).toEqual({ slug: "m", tool_mode: "direct", shell_type: "disabled", experimental_supported_tools: [], node_repl_disabled: true, supports_search_tool: false });
    expect(() => lockCatalog({})).toThrow();
  });

  test("the -c flags name drawer as the only MCP server and switch the tools off", () => {
    const args = lockdownArgs("/s/cat.json", "http://127.0.0.1:1/mcp");
    const values = Object.fromEntries(args.filter((_, i) => i % 2 === 1).map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
    expect(values["features.shell_tool"]).toBe("false");
    expect(values["web_search"]).toBe('"disabled"');
    expect(values["model_catalog_json"]).toBe('"/s/cat.json"');
    expect(values["mcp_servers.drawer.url"]).toBe('"http://127.0.0.1:1/mcp"');
    expect(Object.keys(values).filter((k) => k.startsWith("mcp_servers.") && !k.startsWith("mcp_servers.drawer."))).toEqual([]);
  });

  test("only messages, reasoning and drawer's MCP calls may happen", () => {
    expect(foreignItem({ type: "agentMessage" })).toBeNull();
    expect(foreignItem({ type: "mcpToolCall", server: "drawer" })).toBeNull();
    expect(foreignItem({ type: "functionCallOutput", name: "list_mcp_resources" })).toContain("functionCallOutput");
    expect(foreignItem({ type: "mcpToolCall", server: "github" })).toContain("github");
    expect(foreignItem({ type: "commandExecution" })).toContain("commandExecution");
    expect(foreignItem({ type: "webSearch" })).toContain("webSearch");
    expect(foreignItem({ type: "fileChange" })).toContain("fileChange");
  });

  test("approval requests are declined, and running something fails the turn", () => {
    expect(answerServerRequest("item/commandExecution/requestApproval")).toEqual({ result: { decision: "decline" }, foreign: "asked to run a command" });
    expect(answerServerRequest("item/fileChange/requestApproval").foreign).not.toBeNull();
    expect(answerServerRequest("mcpServer/elicitation/request")).toEqual({ result: { action: "decline", content: null, _meta: null }, foreign: null });
    expect(answerServerRequest("something/new").foreign).toContain("something/new");
  });
});

describe("pi and gemini lockdown", () => {
  test("pi: drawer's tools only, no extensions, context files, skills or templates", () => {
    const args = piArgs({ systemPromptFile: "/p.md", sessionDir: "/s", sessionId: "id", model: "openai/gpt-x" });
    expect(args).toContain("--no-extensions");
    expect(args.join(" ")).toContain("--extension builtin:mcp");
    expect(args.join(" ")).toContain("--tools mcp__drawer__*");
    for (const f of ["--no-context-files", "--no-skills", "--no-prompt-templates", "--no-approve"]) expect(args).toContain(f);
    expect(args).not.toContain("--no-tools");
    expect(mcpConfig("http://x/mcp")).toEqual({ mcpServers: { drawer: { url: "http://x/mcp", headers: { Authorization: "Bearer ${DRAWER_MCP_TOKEN}" }, exposure: "direct", timeout: 21600 } } });
  });

  test("pi: models and messages", () => {
    expect(modelIds({ models: [{ provider: "openai", id: "gpt-x" }, { id: "bad" }] })).toEqual(["openai/gpt-x"]);
    expect(assistantText({ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: " Hi " }] })).toBe("Hi");
    expect(assistantText({ role: "user", content: "x" })).toBeNull();
    expect(assistantError({ role: "assistant", stopReason: "error", errorMessage: "429" })).toBe("429");
  });

  test("gemini: no built-in tools, drawer's MCP server only, every other tool denied", () => {
    expect(systemSettings()).toEqual({ tools: { core: [] }, mcp: { allowed: ["drawer"] }, admin: { extensions: { enabled: false } } });
    expect(adminPolicy()).toContain('toolName = "*"\ndecision = "deny"');
    expect(adminPolicy()).toContain('mcpName = "drawer"\ndecision = "allow"');
    expect(foreignUpdate({ sessionUpdate: "tool_call", kind: "other" })).toBeNull();
    expect(foreignUpdate({ sessionUpdate: "tool_call", kind: "execute", title: "ls" })).toContain("execute");
    expect(foreignUpdate({ sessionUpdate: "agent_message_chunk" })).toBeNull();
    expect(rejectPermission({ options: [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] })).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(rejectPermission({})).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

// ---- the adapters against fake CLIs ------------------------------------------------------------

let dir = "";
let logFile = "";
const before = { pi: process.env.PI_CODING_AGENT_DIR, gemini: process.env.GEMINI_CLI_HOME };

async function fakeBin(kind: string): Promise<string> {
  const path = join(dir, `fake-${kind}`);
  await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-cli.ts")}" ${kind} "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawer-providers-"));
  logFile = join(dir, "log.jsonl");
  process.env.FAKE_LOG = logFile;
  // pi's own agent directory, with a login file the turn's directory links to.
  await writeFile(join(dir, "auth.json"), "{}");
  process.env.PI_CODING_AGENT_DIR = dir;
  // A saved Google login for gemini's sign-in check.
  await mkdir(join(dir, ".gemini"));
  await writeFile(join(dir, ".gemini", "oauth_creds.json"), "{}");
  process.env.GEMINI_CLI_HOME = dir;
});

afterAll(async () => {
  for (const [key, value] of [["PI_CODING_AGENT_DIR", before.pi], ["GEMINI_CLI_HOME", before.gemini]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_SCENARIO;
  await rm(dir, { recursive: true, force: true });
});

function turnFor(events: ProviderEvent[], overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: "s1",
    systemPrompt: "# Guide",
    messages: [{ text: "/list the parts", images: [] }],
    resume: null,
    model: null,
    tools: [overview],
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    ...overrides,
  };
}

async function logged(): Promise<Record<string, unknown>[]> {
  const text = await readFile(logFile, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A provider of `kind` whose CLI is `binary`, as the runner's host configured it. */
const providers: [string, (stateDir: string, binary: string) => Provider][] = [
  ["codex", (stateDir, binary) => new CodexProvider({ stateDir, binary })],
  ["pi", (stateDir, binary) => new PiProvider({ stateDir, binary })],
  ["gemini", (stateDir, binary) => new GeminiProvider({ stateDir, binary })],
];

describe.each(providers)("%s against a fake CLI", (kind, make) => {
  test("check: installed, version, ready", async () => {
    const bin = await fakeBin(kind);
    const check = await make(join(dir, "state"), bin).check();
    expect(check.state).toBe("ready");
    expect(check.binary).toBe(bin);
    expect(check.version).not.toBeNull();
    expect(check.models.length).toBeGreaterThan(0);
  });

  test("check: a missing binary is not installed", async () => {
    expect(await make(join(dir, "state"), join(dir, "nope")).check()).toMatchObject({ state: "not_installed", binary: null });
  });

  test("a turn: text, the drawer call recorded by the MCP server, resume handle", async () => {
    process.env.FAKE_SCENARIO = "ok";
    const events: ProviderEvent[] = [];
    await make(join(dir, "state"), await fakeBin(kind)).run(turnFor(events));
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("resume");
    expect(events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text)).toEqual(["Looking.", "Done."]);
    expect(events.find((e) => e.type === "tool_finished")).toMatchObject({ name: "overview", ok: true, images: ["/api/renders/k/sheet.png"] });
    const results = (await logged()).filter((l) => "toolResult" in l).at(-1) as { toolResult: { result: { content: { type: string }[] } } };
    expect(results.toolResult.result.content.map((c) => c.type)).toEqual(["text", "image"]);
  });

  test("a built-in tool fails the turn", async () => {
    process.env.FAKE_SCENARIO = "foreign";
    const run = make(join(dir, "state"), await fakeBin(kind)).run(turnFor([]));
    await expect(run).rejects.toBeInstanceOf(ForeignToolError);
  });

  test("abort ends a turn that would never end", async () => {
    process.env.FAKE_SCENARIO = "hang";
    const abort = new AbortController();
    const run = make(join(dir, "state"), await fakeBin(kind)).run(turnFor([], { signal: abort.signal }));
    await Bun.sleep(400);
    abort.abort();
    await expect(run).rejects.toThrow();
  });
});

test("codex: a signed-out home says how to sign in, with drawer's CODEX_HOME", async () => {
  process.env.FAKE_SIGNED_OUT = "1";
  try {
    const check = await new CodexProvider({ stateDir: join(dir, "state"), binary: await fakeBin("codex") }).check();
    expect(check.state).toBe("signed_out");
    expect(check.message).toContain(`CODEX_HOME=${join(dir, "state", "codex-home")}`);
  } finally {
    delete process.env.FAKE_SIGNED_OUT;
  }
});

test("codex: runs app-server in its own home with the lockdown flags, and resumes the thread", async () => {
  process.env.FAKE_SCENARIO = "ok";
  await rm(logFile, { force: true });
  const events: ProviderEvent[] = [];
  await new CodexProvider({ stateDir: join(dir, "state"), binary: await fakeBin("codex") }).run(turnFor(events, { resume: "th-9", model: "gpt-a" }));
  const lines = await logged();
  const argv = lines.find((l) => Array.isArray(l.argv) && (l.argv as string[])[1] === "app-server")?.argv as string[];
  expect(argv).toContain("--strict-config");
  expect(argv).toContain("features.shell_tool=false");
  const resume = lines.find((l) => l.method === "thread/resume") as { params: Record<string, unknown> };
  expect(resume.params).toMatchObject({ threadId: "th-9", approvalPolicy: "never", sandbox: "read-only", baseInstructions: "# Guide", model: "gpt-a" });
  expect(events[0]).toEqual({ type: "resume", handle: "th-9" });
});

test("pi: the person's message is sent as text, and the session id is kept", async () => {
  process.env.FAKE_SCENARIO = "ok";
  await rm(logFile, { force: true });
  const events: ProviderEvent[] = [];
  await new PiProvider({ stateDir: join(dir, "state"), binary: await fakeBin("pi") }).run(turnFor(events, { resume: "sess-1" }));
  const lines = await logged();
  expect(lines.find((l) => l.type === "prompt")).toMatchObject({ message: "Message:\n/list the parts" });
  const argv = lines.find((l) => Array.isArray(l.argv))?.argv as string[];
  expect(argv.join(" ")).toContain("--session-id sess-1");
  expect(events.find((e) => e.type === "resume")).toEqual({ type: "resume", handle: "sess-1" });
});

test("gemini: a permission request fails the turn", async () => {
  process.env.FAKE_SCENARIO = "permission";
  const run = new GeminiProvider({ stateDir: join(dir, "state"), binary: await fakeBin("gemini") }).run(turnFor([]));
  await expect(run).rejects.toBeInstanceOf(ForeignToolError);
});

test("gemini: a resumed session swallows the replayed history", async () => {
  process.env.FAKE_SCENARIO = "ok";
  const events: ProviderEvent[] = [];
  await new GeminiProvider({ stateDir: join(dir, "state"), binary: await fakeBin("gemini") }).run(turnFor(events, { resume: "gs-1" }));
  expect(events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text)).toEqual(["Looking.", "Done."]);
});


describe.each(providers)("%s attachment image transport", (kind, make) => {
  test("sends inline image bytes alongside readable text", async () => {
    process.env.FAKE_SCENARIO = "ok";
    await rm(logFile, { force: true });
    await make(join(dir, "state"), await fakeBin(kind)).run(turnFor([], {
      messages: [{ text: "Attached sample.png", images: [{ mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }] }],
    }));
    const lines = await logged();
    if (kind === "pi") expect(lines.find((l) => l.type === "prompt")).toMatchObject({ message: "Attached sample.png", images: [{ type: "image", mimeType: "image/png", data: "AQID" }] });
    else {
      const request = lines.find((l) => l.method === (kind === "codex" ? "turn/start" : "session/prompt")) as { params: { input?: unknown[]; prompt?: unknown[] } };
      expect(kind === "codex" ? request.params.input : request.params.prompt).toContainEqual(kind === "codex" ? { type: "image", url: "data:image/png;base64,AQID" } : { type: "image", mimeType: "image/png", data: "AQID" });
    }
  });
});

test("gemini without image capability keeps the attachment text", async () => {
  process.env.FAKE_NO_IMAGES = "1";
  process.env.FAKE_SCENARIO = "ok";
  try {
    await rm(logFile, { force: true });
    await new GeminiProvider({ stateDir: join(dir, "state"), binary: await fakeBin("gemini") }).run(turnFor([], { messages: [{ text: "Attached sample.png", images: [{ mediaType: "image/png", data: new Uint8Array([1]) }] }] }));
    const request = (await logged()).find((l) => l.method === "session/prompt") as { params: { prompt: unknown[] } };
    expect(request.params.prompt).toEqual([{ type: "text", text: "Attached sample.png" }]);
  } finally {
    delete process.env.FAKE_NO_IMAGES;
  }
});
