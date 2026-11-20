/**
 * drawer's tools as an MCP server on 127.0.0.1, one per turn, for the providers that run as a separate
 * CLI (Codex, Gemini, and Pi through its bridge extension). It holds the bound tools of that turn and
 * nothing else, answers only requests that carry its random bearer token, and goes away with the turn.
 *
 * Because the runner hosts the tools, it also records every call itself: `tool_started` and
 * `tool_finished` come from here, with the call's own output and images, whatever the provider says.
 *
 * Streamable HTTP, stateless: each POST carries JSON-RPC and gets a JSON answer; there is no SSE
 * stream, so GET is 405 (allowed by the transport spec,
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http).
 */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BoundTool, ProviderEvent } from "./provider.ts";
import type { ToolOutput } from "./tools.ts";

export const MCP_SERVER_NAME = "drawer";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpToolServer {
  /** e.g. http://127.0.0.1:41234/mcp */
  url: string;
  /** Sent by the client as `Authorization: Bearer <token>`. */
  token: string;
  close(): Promise<void>;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON Schema of a tool's input, as MCP lists it. No tuples: drawer's shapes use fixed-length arrays. */
export function inputSchema(tool: BoundTool): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(tool.input), { target: "draft-07", io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** An MCP `tools/call` result from a drawer tool's output. */
export function callResult(out: ToolOutput): { content: Json[]; isError: boolean } {
  return {
    content: [
      { type: "text", text: out.text },
      ...out.images.map((img) => ({ type: "image", data: Buffer.from(img).toString("base64"), mimeType: "image/png" })),
    ],
    isError: !out.ok,
  };
}

export interface McpHandlerOptions {
  tools: readonly BoundTool[];
  onEvent(event: ProviderEvent): void;
  /** Ids for the calls this server records. */
  callId?: () => string;
}

/**
 * One JSON-RPC message → its response, or null for a notification. Pure apart from running tools:
 * tested without a socket.
 */
export async function handleRpc(msg: RpcMessage, opts: McpHandlerOptions): Promise<Json | null> {
  const id = msg.id ?? null;
  const ok = (result: Json): Json => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): Json => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (typeof msg.method !== "string") return null; // a response to us: we never ask anything
  if (msg.id === undefined) return null; // a notification
  const params = isRecord(msg.params) ? msg.params : {};
  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : (PROTOCOLS[0] as string),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: "1" },
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) }) as Json) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = opts.tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `no such tool: ${name}`);
      const input = isRecord(params.arguments) ? params.arguments : {};
      const callId = opts.callId?.() ?? crypto.randomUUID();
      opts.onEvent({ type: "tool_started", callId, name, input });
      opts.onEvent({ type: "activity", text: `running ${name}` });
      const out = await tool.call(input);
      opts.onEvent({ type: "tool_finished", callId, name, ok: out.ok, summary: out.summary, text: out.text, images: out.imageUrls });
      opts.onEvent({ type: "activity", text: "thinking" });
      return ok(callResult(out) as Json);
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/** The bearer token, compared in constant time. */
export function bearerMatches(header: string | null, token: string): boolean {
  const got = Buffer.from(header ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Only a request addressed to this server by its loopback address: a web page in a browser on this
 * host that rebinds a name to 127.0.0.1 sends its own name as Host (and its Origin), and is refused
 * before the token is even looked at.
 */
export function addressedHere(req: Request, port: number): boolean {
  if (req.headers.get("host") !== `127.0.0.1:${port}`) return false;
  const origin = req.headers.get("origin");
  return origin === null || origin === `http://127.0.0.1:${port}`;
}

const jsonResponse = (body: Json, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Starts the server on a free loopback port. A tool that throws (an abort) answers that call with an error. */
export function startMcpToolServer(opts: McpHandlerOptions): McpToolServer {
  // 256 random bits; handed to the CLI through its environment or stdin, never its argv.
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req, srv) {
      if (!addressedHere(req, srv.port ?? 0)) return new Response("forbidden", { status: 403 });
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
      if (!bearerMatches(req.headers.get("authorization"), token)) return new Response("unauthorized", { status: 401 });
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
      }
      const messages = (Array.isArray(body) ? body : [body]).filter(isRecord) as RpcMessage[];
      const answers: Json[] = [];
      for (const msg of messages) {
        try {
          const answer = await handleRpc(msg, opts);
          if (answer !== null) answers.push(answer);
        } catch (err) {
          answers.push({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
        }
      }
      if (answers.length === 0) return new Response(null, { status: 202 });
      return jsonResponse(Array.isArray(body) ? answers : (answers[0] as Json));
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    token,
    close: () => server.stop(true),
  };
}
