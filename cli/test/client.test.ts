import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "../src/client.ts";

const seen: { method: string; path: string; type: string | null; body: unknown }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const text = await req.text();
    seen.push({ method: req.method, path: new URL(req.url).pathname + new URL(req.url).search, type: req.headers.get("content-type"), body: text === "" ? null : JSON.parse(text) });
    return Response.json(null);
  },
});
afterAll(() => {
  server.stop(true);
});

describe("Client", () => {
  test("runnerWork is a POST with a JSON body, never a GET with the identity in the query", async () => {
    const client = new Client(`http://127.0.0.1:${server.port}`, "runner");
    expect(await client.runnerWork({ runner: "r1", boot: "b1", providers: [{ kind: "claude", state: "ready", version: null, message: null, binary: null, models: ["m"] }], accepting: true, wait: 25 })).toBeNull();
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/api/runner/work",
        type: "application/json",
        body: { runner: "r1", boot: "b1", providers: [{ kind: "claude", state: "ready", version: null, message: null, binary: null, models: ["m"] }], accepting: true, wait: 25 },
      },
    ]);
  });
});
