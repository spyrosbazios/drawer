/**
 * Stand-ins for the codex, pi and gemini CLIs, speaking each one's protocol over stdio. Run as
 * `bun fake-cli.ts <codex|pi|gemini> ...args`. FAKE_SCENARIO picks the behaviour: `ok` (text, one
 * drawer tool call through the real MCP server, done), `foreign` (a built-in tool shows up), `hang`
 * (the turn never ends until aborted), `permission` (gemini asks for permission), `think` (as `ok`, with the
 * provider's own reasoning events around the tool call).
 * FAKE_LOG, when set, gets one JSON line per received message and per argv.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [kind, ...args] = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? "ok";
const log = (v: unknown) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(v)}\n`);
};
log({ argv: [kind, ...args], cwd: process.cwd() });

const send = (v: unknown): void => {
  process.stdout.write(`${JSON.stringify(v)}\n`);
};

async function callTool(url: string, token: string, name: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: {} } }),
  });
  return res.json();
}

async function lines(onLine: (msg: Record<string, unknown>) => Promise<void> | void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        log(msg);
        await onLine(msg);
      }
    }
  }
}

const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function codex(): Promise<void> {
  if (args[0] === "--version") return void console.log("codex-cli 0.170.0");
  if (args[0] === "debug" && args[1] === "models") return void console.log(JSON.stringify({ models: [{ slug: "m", tool_mode: "code_mode_only", apply_patch_tool_type: "freeform", shell_type: "unified_exec" }] }));
  if (args[0] === "login") return void process.exit(process.env.FAKE_SIGNED_OUT ? 1 : 0);
  if (args[0] !== "app-server") process.exit(2);
  const urlArg = args.find((a) => a.startsWith("mcp_servers.drawer.url="));
  const url = urlArg ? (JSON.parse(urlArg.slice("mcp_servers.drawer.url=".length)) as string) : "";
  await lines(async (msg) => {
    const id = msg.id;
    switch (msg.method) {
      case "initialize":
        return send({ id, result: { userAgent: "codex/0.170.0" } });
      case "model/list":
        return send({ id, result: { data: [{ id: "gpt-a", model: "gpt-a", hidden: false }, { id: "gpt-h", model: "gpt-h", hidden: true }], nextCursor: null } });
      case "thread/start":
      case "thread/resume":
        return send({ id, result: { thread: { id: msg.method === "thread/resume" ? (msg.params as { threadId: string }).threadId : "th-1" } } });
      case "turn/interrupt":
        send({ id, result: {} });
        return send({ method: "turn/completed", params: { threadId: "th-1", turn: { id: "tu-1", status: "interrupted", error: null } } });
      case "turn/start": {
        send({ id, result: { turn: { id: "tu-1" } } });
        send({ method: "turn/started", params: { turn: { id: "tu-1" } } });
        if (scenario === "foreign") return send({ method: "item/started", params: { item: { type: "commandExecution", id: "x" } } });
        if (scenario === "hang") return;
        if (scenario === "think") {
          send({ method: "item/started", params: { item: { type: "reasoning", id: "r1", summary: [], content: [] } } });
          send({ method: "item/reasoning/summaryPartAdded", params: { itemId: "r1", summaryIndex: 0 } });
          send({ method: "item/reasoning/summaryTextDelta", params: { itemId: "r1", summaryIndex: 0, delta: "Check the " } });
          send({ method: "item/reasoning/summaryTextDelta", params: { itemId: "r1", summaryIndex: 0, delta: "overview" } });
          send({ method: "item/reasoning/summaryTextDelta", params: { itemId: "r1", summaryIndex: 1, delta: "Then answer" } });
          send({ method: "item/completed", params: { item: { type: "reasoning", id: "r1", summary: ["Check the overview", "Then answer"], content: [] } } });
        }
        send({ method: "item/completed", params: { item: { type: "agentMessage", id: "a1", text: "Looking." } } });
        send({ method: "item/started", params: { item: { type: "mcpToolCall", id: "m1", server: "drawer", tool: "overview" } } });
        log({ toolResult: await callTool(url, process.env.DRAWER_MCP_TOKEN ?? "", "overview") });
        send({ method: "item/completed", params: { item: { type: "agentMessage", id: "a2", text: "Done." } } });
        return send({ method: "turn/completed", params: { threadId: "th-1", turn: { id: "tu-1", status: "completed", error: null } } });
      }
    }
  });
}

async function pi(): Promise<void> {
  if (args[0] === "--version") return void console.error("1.5.2");
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  await lines(async (msg) => {
    const id = msg.id;
    switch (msg.type) {
      case "get_available_models":
        return send({ id, type: "response", command: msg.type, success: true, data: { models: [{ provider: "openai", id: "gpt-x" }] } });
      case "get_state":
        return send({ id, type: "response", command: msg.type, success: true, data: { sessionId: flag("--session-id"), sessionFile: "/x.jsonl" } });
      case "abort":
        send({ id, type: "response", command: "abort", success: true });
        return send({ type: "agent_settled", aborted: true });
      case "prompt": {
        send({ id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
        if (scenario === "foreign") return send({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
        if (scenario === "hang") return;
        const config = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")) as { mcpServers: { drawer: { url: string } } };
        if (scenario === "think") {
          const update = (assistantMessageEvent: unknown) => send({ type: "message_update", assistantMessageEvent });
          update({ type: "thinking_start", contentIndex: 0 });
          update({ type: "thinking_delta", contentIndex: 0, delta: "Check the " });
          update({ type: "thinking_delta", contentIndex: 0, delta: "overview" });
          update({ type: "thinking_end", contentIndex: 0, content: "Check the overview first." });
        }
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Looking." }], stopReason: "toolUse" } });
        send({ type: "tool_execution_start", toolCallId: "t1", toolName: "mcp__drawer__overview", args: {} });
        log({ toolResult: await callTool(config.mcpServers.drawer.url, process.env.DRAWER_MCP_TOKEN ?? "", "overview") });
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } });
        return send({ type: "agent_settled", aborted: false });
      }
    }
  });
}

async function gemini(): Promise<void> {
  if (args[0] === "--version") return void console.log("0.70.1");
  let pendingPrompt: unknown = null;
  await lines(async (msg) => {
    const id = msg.id;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method === undefined && id === 99) {
      // The client's answer to our permission request.
      return send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "end_turn" } });
    }
    switch (msg.method) {
      case "initialize":
        return send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: { promptCapabilities: { image: process.env.FAKE_NO_IMAGES !== "1" } } } });
      case "session/new":
      case "session/load": {
        const servers = params.mcpServers as { url: string; headers: { name: string; value: string }[] }[];
        process.env.FAKE_URL = servers[0]?.url;
        process.env.FAKE_TOKEN = servers[0]?.headers[0]?.value.replace("Bearer ", "");
        if (msg.method === "session/load") send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old history" } } } });
        return send({ jsonrpc: "2.0", id, result: msg.method === "session/new" ? { sessionId: "gs-1" } : null });
      }
      case "session/cancel":
        return send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "cancelled" } });
      case "session/prompt": {
        pendingPrompt = id;
        const update = (u: unknown) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: u } });
        if (scenario === "foreign") return update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "ls", kind: "execute", status: "pending" });
        if (scenario === "permission") return send({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "gs-1", options: [{ optionId: "proceed_once", kind: "allow_once" }, { optionId: "cancel", kind: "reject_once" }] } });
        if (scenario === "hang") return;
        if (scenario === "think") {
          update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Check the " } });
          update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "overview" } });
        }
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Look" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ing." } });
        update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "overview (drawer MCP Server)", kind: "other", status: "in_progress" });
        log({ toolResult: await callTool(process.env.FAKE_URL ?? "", process.env.FAKE_TOKEN ?? "", "overview") });
        update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", kind: "other" });
        if (scenario === "think") update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Now answer" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
        return send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      }
    }
  });
}

if (kind === "codex") await codex();
else if (kind === "pi") await pi();
else if (kind === "gemini") await gemini();
else process.exit(2);
