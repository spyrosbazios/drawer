import { afterAll, expect, test } from "bun:test";
import { type ProviderSettings, type Settings } from "@drawer/shared/api";
import { sandbox } from "./helpers.ts";

const provider = (): ProviderSettings => ({ enabled: true, defaultModel: null, customModels: [] });
const settings: Settings = { defaultProvider: "pi", providers: { claude: provider(), codex: provider(), pi: provider(), gemini: provider() } };
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  return Response.json(new URL(req.url).pathname === "/api/settings" ? settings : { runners: [{ id: "test", providers: [{ kind: "pi", state: "ready", version: "1.5.2", models: ["deepseek/deepseek-flash"], message: null, binary: null }], accepting: true, lastSeen: new Date().toISOString() }] });
} });
const sb = sandbox(`http://127.0.0.1:${server.port}`);
afterAll(() => { server.stop(); sb.dispose(); });
test("agents returns settings and runner status", async () => {
  const r = await sb.run(["agents"]);
  expect(r.code).toBe(0);
  expect(r.json<{ settings: Settings }>().settings.defaultProvider).toBe("pi");
  expect(r.json<{ runners: { providers: { state: string }[] }[] }>().runners[0]?.providers[0]?.state).toBe("ready");
});
test("agents rejects positional arguments", async () => {
  const r = await sb.run(["agents", "extra"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: drawer agents");
});
test("ask rejects an unknown provider before making a session", async () => {
  const r = await sb.run(["ask", "box", "hello", "--provider", "unknown"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("--provider must be one of claude, codex, pi, gemini");
});
