import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DrawerEvent, ProviderKind, ProviderStatus, RunnersResponse, RunnerWork, Session, SessionDetail, SessionItem, SessionsResponse, Settings } from "@drawer/shared/api";
import { ApiException } from "../src/errors.ts";
import { EventBus } from "../src/events.ts";
import { Router } from "../src/http/router.ts";
import { createSessions, registerSessionRoutes, type Sessions } from "../src/sessions/index.ts";
import { defaultSettings } from "../src/settings.ts";

/** The session routes alone, on their own data dir, called like the real app calls them. */
interface Api {
  dataDir: string;
  bus: EventBus;
  sessions: Sessions;
  events: DrawerEvent[];
  call<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; json: T; headers: Headers }>;
  get<T = any>(path: string): Promise<{ status: number; json: T; headers: Headers }>;
  post<T = any>(path: string, body?: unknown): Promise<{ status: number; json: T; headers: Headers }>;
  /** A runner poll, by process `boot-<runner>` unless `boot` is given; every provider named is `ready`. */
  work(runner: string, wait?: number, providers?: string[], signal?: AbortSignal, boot?: string, extra?: { accepting?: boolean; statuses?: ProviderStatus[] }): Promise<RunnerWork>;
  /** What the sessions read as the current settings; change it in place. */
  settings: Settings;
  /** A runner's append, by default as runner r1 (boot-r1). */
  item<T = any>(id: string, body: unknown, runner?: string, boot?: string): Promise<{ status: number; json: T; headers: Headers }>;
  /** A runner's patch, by default as runner r1 (boot-r1). */
  patch<T = any>(id: string, body: unknown, runner?: string, boot?: string): Promise<{ status: number; json: T; headers: Headers }>;
  /** Starts a session in project `alpha` and returns it. */
  start(message: string, extra?: Record<string, unknown>): Promise<Session>;
  close(): void;
}

const dirs: string[] = [];
const open: Api[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drawer-sessions-"));
  dirs.push(dir);
  return dir;
}

async function makeApi(dataDir?: string, opts: { runnerTtlMs?: number; sweepMs?: number } = {}): Promise<Api> {
  const dir = dataDir ?? (await tempDir());
  const bus = new EventBus();
  const events: DrawerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const settings = defaultSettings();
  const sessions = createSessions({
    dataDir: dir,
    bus,
    settings: () => settings,
    projectExists: async (slug) => slug === "alpha" || slug === "beta",
    // Filing is covered against the real app in sessions-app.test.ts.
    writeFile: async () => {
      throw new Error("no project store in this test");
    },
    ...opts,
  });
  await sessions.init();
  const router = new Router();
  registerSessionRoutes(router, sessions);

  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal) {
    const url = new URL(`http://drawer.test${path}`);
    const req = new Request(url.href, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal,
    });
    try {
      const match = router.match(method, url.pathname.slice("/api".length));
      if (!match) return { status: 404, json: null as T, headers: new Headers() };
      const res = await match.handler({ req, url, params: match.params, rest: match.rest });
      const text = await res.text();
      const isJson = (res.headers.get("content-type") ?? "").includes("json");
      return { status: res.status, json: (isJson && text !== "" ? JSON.parse(text) : text) as T, headers: res.headers };
    } catch (err) {
      if (err instanceof ApiException) return { status: err.status, json: err.toBody() as T, headers: new Headers() };
      throw err;
    }
  }

  const api: Api = {
    dataDir: dir,
    bus,
    sessions,
    events,
    call,
    get: (path) => call("GET", `/api${path}`),
    post: (path, body) => call("POST", `/api${path}`, body ?? {}),
    async work(runner, wait = 0, providers = ["claude"], signal, boot = `boot-${runner}`, extra = {}) {
      const statuses = extra.statuses ?? providers.map((kind) => ready(kind as ProviderKind));
      const res = await call<RunnerWork>("POST", "/api/runner/work", { runner, boot, providers: statuses, accepting: extra.accepting ?? true, wait }, signal);
      expect(res.status).toBe(200);
      return res.json;
    },
    settings,
    item: (id, body, runner = "r1", boot = `boot-${runner}`) => call("POST", `/api/sessions/${id}/items?runner=${runner}&boot=${boot}`, body),
    patch: (id, body, runner = "r1", boot = `boot-${runner}`) => call("PATCH", `/api/sessions/${id}?runner=${runner}&boot=${boot}`, body),
    async start(message, extra = {}) {
      const res = await api.post<Session>("/projects/alpha/sessions", { message, ...extra });
      expect(res.status).toBe(201);
      return res.json;
    },
    close: () => sessions.close(),
  };
  open.push(api);
  return api;
}

afterEach(() => {
  for (const api of open.splice(0)) api.close();
});
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const ready = (kind: ProviderKind): ProviderStatus => ({ kind, state: "ready", version: "1.0.0", models: [`${kind}-model`], message: null, binary: null });

function turn(work: RunnerWork): Extract<NonNullable<RunnerWork>, { kind: "turn" }> {
  if (work === null || work.kind !== "turn") throw new Error(`expected a turn, got ${JSON.stringify(work)}`);
  return work;
}

const tool = (callId: string, status: "running" | "ok" | "error", summary = "render part") => ({
  type: "tool",
  callId,
  name: "render",
  summary,
  status,
  result: status === "running" ? null : "done",
  images: [],
});

describe("create, list, detail", () => {
  test("a new session is queued with its first message as title and pending item", async () => {
    const api = await makeApi();
    const res = await api.post<Session>("/projects/alpha/sessions", { message: "  Design a hook\nwith two screws and a long story  " });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ project: "alpha", title: "Design a hook", provider: "claude", model: null, status: "queued", pending: 1, toolCalls: 0, seq: 1, error: null, activity: null });
    expect(res.json.id).toMatch(/^[a-z0-9]{8,}$/);

    const long = await api.start("x".repeat(200), { provider: "codex", model: "m1" });
    expect(long.title).toHaveLength(80);
    expect(long).toMatchObject({ provider: "codex", model: "m1" });
  });

  test("a message needs text, and the project must exist", async () => {
    const api = await makeApi();
    expect((await api.post("/projects/alpha/sessions", { message: "   " })).status).toBe(400);
    expect((await api.post("/projects/alpha/sessions", {})).status).toBe(400);
    expect((await api.post("/projects/alpha/sessions", { message: "hi", refs: [{ kind: "nope" }] })).status).toBe(400);
    expect((await api.post("/projects/alpha/sessions", { message: "hi", refs: [{ kind: "point", part: "p", position: [1, 2], normal: null }] })).status).toBe(400);
    expect((await api.post("/projects/alpha/sessions", "{not json")).status).toBe(400);
    const missing = await api.post("/projects/nope/sessions", { message: "hi" });
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: "not_found" });
  });

  test("list is newest first and filters by project", async () => {
    const api = await makeApi();
    const a = await api.start("first");
    const b = await api.post<Session>("/projects/beta/sessions", { message: "second" });
    const c = await api.start("third");
    const all = await api.get<SessionsResponse>("/sessions");
    expect(all.json.sessions.map((s) => s.id)).toEqual([c.id, b.json.id, a.id]);
    const onlyAlpha = await api.get<SessionsResponse>("/sessions?project=alpha");
    expect(onlyAlpha.json.sessions.map((s) => s.id)).toEqual([c.id, a.id]);
    expect((await api.get<SessionsResponse>("/sessions?project=gamma")).json.sessions).toEqual([]);
  });

  test("detail returns the items after a seq, with refs and author kept on user items", async () => {
    const api = await makeApi();
    const refs = [
      { kind: "part", part: "hook" },
      { kind: "point", part: "hook", position: [1, 2, 3], normal: [0, 0, 1] },
      { kind: "file", path: "notes/a.md" },
    ];
    const s = await api.start("look here", { refs });
    await api.post(`/sessions/${s.id}/messages`, { text: "and here" });
    const all = await api.get<SessionDetail>(`/sessions/${s.id}`);
    expect(all.json.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(all.json.items[0]).toMatchObject({ type: "user", text: "look here", refs, attachments: [], author: "web" });
    expect(all.json.session.pending).toBe(2);
    const later = await api.get<SessionDetail>(`/sessions/${s.id}?since=1`);
    expect(later.json.items.map((i) => i.seq)).toEqual([2]);
    expect((await api.get(`/sessions/${s.id}?since=-1`)).status).toBe(400);
    expect((await api.get("/sessions/missing")).status).toBe(404);
  });
});

describe("a turn", () => {
  test("claim, items, tool replace by callId, idle, and the next turn", async () => {
    const api = await makeApi();
    const s = await api.start("make a hook");
    expect(await api.work("r1")).not.toBeNull();
    // Claimed once: nothing else to take.
    expect(await api.work("r1")).toBeNull();

    // (the first poll consumed the claim, so look at the session state it left)
    let detail = (await api.get<SessionDetail>(`/sessions/${s.id}`)).json;
    expect(detail.session).toMatchObject({ status: "working", pending: 0, error: null });

    const a1 = await api.item<SessionItem>(s.id, { type: "assistant", text: "On it." });
    expect(a1.json).toMatchObject({ type: "assistant", text: "On it.", seq: 2 });
    const t1 = await api.item<SessionItem>(s.id, tool("c1", "running"));
    expect(t1.json).toMatchObject({ type: "tool", callId: "c1", status: "running", seq: 3 });
    await api.item(s.id, { type: "notice", level: "info", text: "fyi" });
    const t2 = await api.item<SessionItem>(s.id, tool("c1", "ok", "rendered part"));
    expect(t2.json).toMatchObject({ seq: 3, status: "ok", summary: "rendered part", result: "done" });
    await api.item(s.id, tool("c2", "running"));

    detail = (await api.get<SessionDetail>(`/sessions/${s.id}`)).json;
    expect(detail.session.toolCalls).toBe(2);
    expect(detail.session.seq).toBe(5);
    expect(detail.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(detail.items[2]).toMatchObject({ type: "tool", callId: "c1", status: "ok", summary: "rendered part" });

    for (const resume of ["--resume", "a b", "../x", "x\ny"]) expect((await api.patch<Session>(s.id, { resume })).status).toBe(400);
    const patched = await api.patch<Session>(s.id, { activity: "rendering", resume: "provider-1" });
    expect(patched.json).toMatchObject({ status: "working", activity: "rendering" });
    const idle = await api.patch<Session>(s.id, { status: "idle", activity: "still here?" });
    expect(idle.json).toMatchObject({ status: "idle", activity: null, pending: 0 });

    // A follow-up queues it again; the turn carries only the new message and the stored resume handle.
    await api.post(`/sessions/${s.id}/messages`, { text: "make it wider" });
    const second = turn(await api.work("r1"));
    expect(second.resume).toBe("provider-1");
    expect(second.messages.map((m) => (m.type === "user" ? m.text : null))).toEqual(["make it wider"]);
    expect(second.session).toMatchObject({ id: s.id, status: "working" });
  });

  test("a reasoning item is replaced by its reasoningId and does not count as a tool call", async () => {
    const api = await makeApi();
    const s = await api.start("think");
    await api.work("r1");
    const thought = (text: string, status: "running" | "done", seconds: number) => ({ type: "reasoning", reasoningId: "t1", text, status, seconds });
    const first = await api.item<SessionItem>(s.id, thought("Looking", "running", 0));
    expect(first.json).toMatchObject({ type: "reasoning", reasoningId: "t1", status: "running", seq: 2 });
    await api.item(s.id, { type: "assistant", text: "between" });
    const done = await api.item<SessionItem>(s.id, thought("Looking at the tray", "done", 4));
    expect(done.json).toMatchObject({ seq: 2, status: "done", text: "Looking at the tray", seconds: 4 });
    await api.item(s.id, { ...thought("Next", "running", 0), reasoningId: "t2" });
    const detail = (await api.get<SessionDetail>(`/sessions/${s.id}`)).json;
    expect(detail.items.map((i) => i.seq)).toEqual([1, 2, 3, 4]);
    expect(detail.session.toolCalls).toBe(0);
  });

  test("the first turn carries the pending messages, the guide and no resume handle", async () => {
    const api = await makeApi();
    const s = await api.start("one");
    await api.post(`/sessions/${s.id}/messages`, { text: "two" });
    const first = turn(await api.work("r1"));
    expect(first.resume).toBeNull();
    expect(first.messages.map((m) => (m.type === "user" ? m.text : null))).toEqual(["one", "two"]);
    expect(first.guide).toContain("# Modelling guide");
    expect(first.session.pending).toBe(0);
  });

  test("a message during a turn stays pending and re-queues the session when the turn ends", async () => {
    const api = await makeApi();
    const s = await api.start("start");
    turn(await api.work("r1"));
    const during = await api.post<Session>(`/sessions/${s.id}/messages`, { text: "also this" });
    expect(during.json).toMatchObject({ status: "working", pending: 1 });
    // Nobody else takes it while it works.
    expect(await api.work("r2")).toBeNull();

    const end = await api.patch<Session>(s.id, { status: "idle" });
    expect(end.json).toMatchObject({ status: "queued", pending: 1 });
    const next = turn(await api.work("r2"));
    expect(next.messages.map((m) => (m.type === "user" ? m.text : null))).toEqual(["also this"]);
    expect(next.session.pending).toBe(0);
  });

  test("a failed turn keeps its error; a new message queues it again", async () => {
    const api = await makeApi();
    const s = await api.start("start");
    turn(await api.work("r1"));
    const failed = await api.patch<Session>(s.id, { status: "failed", error: "provider exploded" });
    expect(failed.json).toMatchObject({ status: "failed", error: "provider exploded", activity: null });
    expect(await api.work("r1")).toBeNull();
    const again = await api.post<Session>(`/sessions/${s.id}/messages`, { text: "try again" });
    expect(again.json).toMatchObject({ status: "queued", error: null });
  });

  test("the oldest queued session goes first", async () => {
    const api = await makeApi();
    const a = await api.start("a");
    const b = await api.start("b");
    expect(turn(await api.work("r1")).session.id).toBe(a.id);
    expect(turn(await api.work("r1")).session.id).toBe(b.id);
  });

  test("a runner polling now gets work that arrives during the wait", async () => {
    const api = await makeApi();
    const polling = api.work("r1", 5);
    await Bun.sleep(30);
    const s = await api.start("late");
    expect(turn(await polling).session.id).toBe(s.id);
  });
});

describe("questions", () => {
  test("a question waits for the answer, which the long poll returns", async () => {
    const api = await makeApi();
    const s = await api.start("ask me");
    turn(await api.work("r1"));
    const q = await api.item<SessionItem>(s.id, { type: "question", questionId: "q1", text: "Which screw?", options: ["M3", "M4"] });
    expect(q.json).toMatchObject({ type: "question", questionId: "q1", options: ["M3", "M4"], answer: null });
    expect((await api.get<SessionDetail>(`/sessions/${s.id}`)).json.session.status).toBe("waiting");

    // Unanswered: the poll ends with null.
    const started = Date.now();
    const none = await api.get<{ answer: string | null }>(`/sessions/${s.id}/answer?question=q1&wait=0.2`);
    expect(none.json).toEqual({ answer: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);

    const waiting = api.get<{ answer: string | null }>(`/sessions/${s.id}/answer?question=q1&wait=5`);
    await Bun.sleep(30);
    const answered = await api.post<Session>(`/sessions/${s.id}/answer`, { questionId: "q1", answer: "M3" });
    expect(answered.json.status).toBe("working");
    expect((await waiting).json).toEqual({ answer: "M3" });
    // An answered question answers at once.
    expect((await api.get(`/sessions/${s.id}/answer?question=q1`)).json).toEqual({ answer: "M3" });
    const items = (await api.get<SessionDetail>(`/sessions/${s.id}`)).json.items;
    expect(items.find((i) => i.type === "question")).toMatchObject({ answer: "M3" });

    expect((await api.post(`/sessions/${s.id}/answer`, { questionId: "q1", answer: "M4" })).status).toBe(409);
    expect((await api.post(`/sessions/${s.id}/answer`, { questionId: "nope", answer: "M4" })).status).toBe(404);
    expect((await api.get(`/sessions/${s.id}/answer?question=nope`)).status).toBe(404);
    expect((await api.post(`/sessions/${s.id}/answer`, { questionId: "q1" })).status).toBe(400);
    expect((await api.get(`/sessions/${s.id}/answer`)).status).toBe(400);
  });

  test("a stop ends the answer long poll", async () => {
    const api = await makeApi();
    const s = await api.start("ask me");
    turn(await api.work("r1"));
    await api.item(s.id, { type: "question", questionId: "q1", text: "?", options: [] });
    const waiting = api.get(`/sessions/${s.id}/answer?question=q1&wait=5`);
    await Bun.sleep(30);
    const stopped = await api.post<Session>(`/sessions/${s.id}/stop`);
    expect(stopped.json.status).toBe("stopped");
    expect((await waiting).json).toEqual({ answer: null });
  });
});

describe("stop", () => {
  test("a working session is stopped at once, its runner gets stop, and a late patch changes nothing", async () => {
    const api = await makeApi();
    const s = await api.start("go");
    turn(await api.work("r1"));
    // The runner keeps polling while it works; the stop reaches that poll.
    const polling = api.work("r1", 5);
    await Bun.sleep(30);
    const stopped = await api.post<Session>(`/sessions/${s.id}/stop`);
    expect(stopped.json).toMatchObject({ status: "stopped", activity: null });
    expect(await polling).toEqual({ kind: "stop", sessionId: s.id });
    // Told once.
    expect(await api.work("r1")).toBeNull();

    const late = await api.patch<Session>(s.id, { status: "idle", activity: "late", error: "late", resume: "kept" });
    expect(late.json).toMatchObject({ status: "stopped", activity: null, error: null });
    const lateFail = await api.patch<Session>(s.id, { status: "failed", error: "interrupted" });
    expect(lateFail.json).toMatchObject({ status: "stopped", error: null });
    await api.item(s.id, { type: "question", questionId: "late", text: "?", options: [] });
    expect((await api.get<SessionDetail>(`/sessions/${s.id}`)).json.session.status).toBe("stopped");

    // A new message queues it again, and the resume handle sent with the late patch was kept.
    const again = await api.post<Session>(`/sessions/${s.id}/messages`, { text: "continue" });
    expect(again.json.status).toBe("queued");
    expect(turn(await api.work("r2")).resume).toBe("kept");
  });

  test("a waiting session stops too", async () => {
    const api = await makeApi();
    const s = await api.start("go");
    turn(await api.work("r1"));
    await api.item(s.id, { type: "question", questionId: "q", text: "?", options: [] });
    expect((await api.post<Session>(`/sessions/${s.id}/stop`)).json.status).toBe("stopped");
    expect(await api.work("r1")).toEqual({ kind: "stop", sessionId: s.id });
  });

  test("a queued or idle session becomes stopped directly; stopping twice is harmless", async () => {
    const api = await makeApi();
    const queued = await api.start("q");
    expect((await api.post<Session>(`/sessions/${queued.id}/stop`)).json.status).toBe("stopped");
    expect(await api.work("r1")).toBeNull();
    expect((await api.post<Session>(`/sessions/${queued.id}/stop`)).json.status).toBe("stopped");

    const s = await api.start("i");
    turn(await api.work("r1"));
    await api.patch(s.id, { status: "idle" });
    expect((await api.post<Session>(`/sessions/${s.id}/stop`)).json.status).toBe("stopped");
    expect(await api.work("r1")).toBeNull();
    expect((await api.post("/sessions/missing/stop")).status).toBe(404);
  });

  test("deleting a working session tells its runner to stop", async () => {
    const api = await makeApi();
    const s = await api.start("go");
    turn(await api.work("r1"));
    expect((await api.call("DELETE", `/api/sessions/${s.id}`)).status).toBe(204);
    expect((await api.get(`/sessions/${s.id}`)).status).toBe(404);
    expect(await api.work("r1")).toEqual({ kind: "stop", sessionId: s.id });
    expect((await api.call("DELETE", `/api/sessions/${s.id}`)).status).toBe(404);
  });
});

describe("runners", () => {
  test("only a runner that offers the provider claims the session", async () => {
    const api = await makeApi();
    const s = await api.start("hello", { provider: "codex" });
    expect(await api.work("claude-runner", 0, ["claude"])).toBeNull();
    expect((await api.get<SessionDetail>(`/sessions/${s.id}`)).json.session.status).toBe("queued");
    expect(turn(await api.work("codex-runner", 0, ["claude", "codex"])).session.id).toBe(s.id);
  });

  test("a turn goes only to a ready provider, only while the runner accepts, and only while settings enable it", async () => {
    const api = await makeApi();
    const s = await api.start("hello");
    const signedOut: ProviderStatus = { ...ready("claude"), state: "signed_out", message: "log in" };
    expect(await api.work("r1", 0, [], undefined, undefined, { statuses: [signedOut] })).toBeNull();
    expect(await api.work("r1", 0, ["claude"], undefined, undefined, { accepting: false })).toBeNull();
    api.settings.providers.claude.enabled = false;
    expect(await api.work("r1", 0, ["claude"])).toBeNull();
    api.settings.providers.claude.enabled = true;
    expect(turn(await api.work("r1", 0, ["claude"])).session.id).toBe(s.id);
    const listed = (await api.get<RunnersResponse>("/runners")).json.runners[0];
    expect(listed?.providers).toEqual([ready("claude")]);
  });

  test("a settings change wakes a waiting poll", async () => {
    const api = await makeApi();
    api.settings.providers.codex.enabled = false;
    const s = await api.start("hello", { provider: "claude" });
    api.settings.providers.claude.enabled = false;
    const poll = api.work("r1", 5, ["claude"]);
    await Bun.sleep(50);
    api.settings.providers.claude.enabled = true;
    api.bus.emit({ type: "settings" });
    const started = Date.now();
    expect(turn(await poll).session.id).toBe(s.id);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a new session gets the default provider and its default model from settings; a disabled one is refused", async () => {
    const api = await makeApi();
    api.settings.defaultProvider = "pi";
    api.settings.providers.pi.defaultModel = "openai/gpt-x";
    expect(await api.start("hello")).toMatchObject({ provider: "pi", model: "openai/gpt-x" });
    expect(await api.start("hello", { provider: "pi", model: "deepseek/v4" })).toMatchObject({ provider: "pi", model: "deepseek/v4" });
    expect(await api.start("hello", { provider: "claude" })).toMatchObject({ provider: "claude", model: null });
    api.settings.providers.gemini.enabled = false;
    const refused = await api.post("/projects/alpha/sessions", { message: "hi", provider: "gemini" });
    expect(refused.status).toBe(400);
    expect(refused.json.message).toContain("gemini is turned off");
  });

  test("a poll with nothing to do returns null after the wait", async () => {
    const api = await makeApi();
    const started = Date.now();
    expect(await api.work("r1", 0.2)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("an aborted request ends the long poll", async () => {
    const api = await makeApi();
    const controller = new AbortController();
    const started = Date.now();
    const polling = api.work("r1", 30, ["claude"], controller.signal);
    await Bun.sleep(30);
    controller.abort();
    expect(await polling).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("close ends every pending long poll", async () => {
    const api = await makeApi();
    const s = await api.start("ask");
    turn(await api.work("r1"));
    await api.item(s.id, { type: "question", questionId: "q", text: "?", options: [] });
    const poll = api.work("r2", 30);
    const answer = api.get(`/sessions/${s.id}/answer?question=q&wait=30`);
    await Bun.sleep(30);
    const started = Date.now();
    api.close();
    expect(await poll).toBeNull();
    expect((await answer).json).toEqual({ answer: null });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("runners are listed with their providers and refreshed by every poll", async () => {
    const api = await makeApi();
    expect((await api.get<RunnersResponse>("/runners")).json.runners).toEqual([]);
    await api.work("r1", 0, ["claude"]);
    await api.work("r2", 0, ["claude", "codex"]);
    const first = (await api.get<RunnersResponse>("/runners")).json.runners;
    expect(first.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    expect(first.find((r) => r.id === "r2")?.providers).toEqual([ready("claude"), ready("codex")]);
    expect(first.find((r) => r.id === "r2")?.accepting).toBe(true);
    await Bun.sleep(20);
    await api.work("r1", 0, ["codex"]);
    const second = (await api.get<RunnersResponse>("/runners")).json.runners.find((r) => r.id === "r1");
    expect(second?.providers.map((p) => p.kind)).toEqual(["codex"]);
    expect(Date.parse(second?.lastSeen ?? "")).toBeGreaterThan(Date.parse(first.find((r) => r.id === "r1")?.lastSeen ?? ""));
  });

  test("a runner that goes quiet is forgotten and its working sessions fail", async () => {
    const api = await makeApi(undefined, { runnerTtlMs: 150, sweepMs: 25 });
    const working = await api.start("working");
    turn(await api.work("gone"));
    const waiting = await api.start("waiting");
    turn(await api.work("gone"));
    await api.item(waiting.id, { type: "question", questionId: "q", text: "?", options: [] }, "gone");
    const done = await api.start("done");
    turn(await api.work("gone"));
    await api.patch(done.id, { status: "idle" }, "gone");
    const queued = await api.start("queued");

    // A second runner keeps polling, so only the first one expires.
    for (let i = 0; i < 8; i++) {
      await api.work("alive");
      await Bun.sleep(30);
    }
    const runners = (await api.get<RunnersResponse>("/runners")).json.runners;
    expect(runners.map((r) => r.id)).toEqual(["alive"]);

    const sessions = (await api.get<SessionsResponse>("/sessions")).json.sessions;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect(byId.get(working.id)).toMatchObject({ status: "failed", error: "the agent runner went away" });
    expect(byId.get(waiting.id)).toMatchObject({ status: "failed", error: "the agent runner went away" });
    expect(byId.get(done.id)?.status).toBe("idle");
    expect(byId.get(queued.id)?.status).not.toBe("failed");
  });
});

describe("validation", () => {
  test("bad items, patches and queries are 400; unknown sessions are 404", async () => {
    const api = await makeApi();
    const s = await api.start("go");
    const bad = [
      {},
      { type: "banana" },
      { type: "assistant" },
      { type: "tool", callId: "c", name: "n", summary: "s", status: "weird" },
      { type: "tool", name: "n", summary: "s", status: "ok" },
      { type: "question", text: "?", options: [] },
      { type: "question", questionId: "q", text: "?", options: [1] },
      { type: "notice", level: "loud", text: "x" },
      { type: "reasoning", text: "x", status: "running", seconds: 0 },
      { type: "reasoning", reasoningId: "t", text: "x", status: "weird", seconds: 0 },
      { type: "reasoning", reasoningId: "t", text: "x", status: "done", seconds: -1 },
      { type: "reasoning", reasoningId: "t", text: "x", status: "done" },
    ];
    for (const body of bad) expect((await api.item(s.id, body)).status).toBe(400);
    expect((await api.item(s.id, "[]")).status).toBe(400);
    expect((await api.item("nope", { type: "assistant", text: "x" })).status).toBe(404);

    expect((await api.patch(s.id, { status: "sleeping" })).status).toBe(400);
    expect((await api.patch(s.id, { activity: 3 })).status).toBe(400);
    expect((await api.patch("nope", { status: "idle" })).status).toBe(404);

    expect((await api.post(`/sessions/${s.id}/messages`, { text: " " })).status).toBe(400);
    expect((await api.post("/sessions/nope/messages", { text: "hi" })).status).toBe(404);
    expect((await api.post("/sessions/nope/answer", { questionId: "q", answer: "a" })).status).toBe(404);

    const poll = { runner: "r", boot: "b", providers: [], accepting: true, wait: 0 };
    expect((await api.post("/runner/work", {})).status).toBe(400);
    expect((await api.post("/runner/work", poll)).status).toBe(200);
    expect((await api.post("/runner/work", { ...poll, wait: -1 })).status).toBe(400);
    expect((await api.call("POST", "/api/runner/work", "[not")).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, runner: "" })).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, boot: undefined })).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, accepting: undefined })).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, providers: [{ kind: 3 }] })).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, providers: [{ ...ready("claude"), state: "great" }] })).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, providers: [{ ...ready("claude"), kind: "openai" }] })).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, providers: [ready("claude"), ready("claude")] })).status).toBe(400);
    expect((await api.post("/projects/alpha/sessions", { message: "hi", provider: "openai" })).status).toBe(400);
    expect((await api.get("/runner/work")).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, wait: "1" })).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, providers: "[]" })).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, runner: undefined })).status).toBe(400);
    expect((await api.post("/runner/work", { ...poll, extra: 1 })).status).toBe(400);
  });

  test("a duplicate question id is rejected", async () => {
    const api = await makeApi();
    const s = await api.start("go");
    turn(await api.work("r1"));
    const q = { type: "question", questionId: "q", text: "?", options: [] };
    expect((await api.item(s.id, q)).status).toBe(200);
    expect((await api.item(s.id, q)).status).toBe(400);
  });
});

describe("events", () => {
  test("every state change and appended item emits a session event with the newest version", async () => {
    const api = await makeApi();
    const s = await api.start("go");
    turn(await api.work("r1"));
    await api.item(s.id, { type: "assistant", text: "hi" });
    await api.item(s.id, tool("c", "running"));
    await api.item(s.id, tool("c", "ok"));
    await api.patch(s.id, { status: "idle" });
    const mine = api.events.filter((e) => e.type === "session" && e.id === s.id).map((e) => (e.type === "session" ? [e.status, e.version] : null));
    expect(mine).toEqual([
      ["queued", 1],
      ["working", 1],
      ["working", 2],
      ["working", 3],
      ["working", 4],
      ["idle", 4],
    ]);
    const first = api.events[0];
    expect(first).toMatchObject({ type: "session", project: "alpha", activity: null });
  });
});

describe("persistence", () => {
  test("sessions, items and the resume handle survive a restart; running turns fail", async () => {
    const first = await makeApi();
    const dataDir = first.dataDir;

    const idle = await first.start("idle one");
    turn(await first.work("r1"));
    await first.item(idle.id, tool("c1", "running"));
    await first.item(idle.id, tool("c1", "ok"));
    await first.item(idle.id, { type: "assistant", text: "done" });
    await first.patch(idle.id, { status: "idle", resume: "handle-1" });
    await first.post(`/sessions/${idle.id}/messages`, { text: "one more" });
    turn(await first.work("r1"));
    await first.patch(idle.id, { status: "idle" });

    const working = await first.start("working one");
    turn(await first.work("r1"));
    await first.item(working.id, { type: "question", questionId: "q", text: "?", options: [] });
    const queued = await first.start("queued one");
    await first.post(`/sessions/${queued.id}/messages`, { text: "queued two" });

    const before = (await first.get<SessionDetail>(`/sessions/${idle.id}`)).json;
    first.close();

    // On disk: the state, and one line per append (a replaced tool item appears twice, once per version).
    const files = (await readdir(join(dataDir, "sessions"))).sort();
    expect(files).toContain(`${idle.id}.json`);
    expect(files).toContain(`${idle.id}.jsonl`);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    const lines = (await readFile(join(dataDir, "sessions", `${idle.id}.jsonl`), "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThan(before.items.length);
    expect(lines.map((l) => JSON.parse(l).seq)).toContain(3);

    const second = await makeApi(dataDir);
    const after = (await second.get<SessionDetail>(`/sessions/${idle.id}`)).json;
    expect(after.items).toEqual(before.items);
    expect(after.session).toEqual(before.session);
    expect(after.session.status).toBe("idle");

    const failed = (await second.get<SessionDetail>(`/sessions/${working.id}`)).json;
    expect(failed.session).toMatchObject({ status: "failed", error: "the server restarted during the turn", activity: null });
    expect(failed.items.find((i) => i.type === "question")).toMatchObject({ questionId: "q", answer: null });

    // The queued session keeps both pending messages and is claimable; the idle one resumes with its handle.
    const q = turn(await second.work("r1"));
    expect(q.session.id).toBe(queued.id);
    expect(q.messages.map((m) => (m.type === "user" ? m.text : null))).toEqual(["queued one", "queued two"]);
    expect((await second.get<SessionsResponse>("/sessions")).json.sessions.map((s) => s.id)).toEqual([queued.id, working.id, idle.id]);

    await second.post(`/sessions/${idle.id}/messages`, { text: "after restart" });
    const resumed = turn(await second.work("r1"));
    expect(resumed.resume).toBe("handle-1");
    expect(resumed.messages.map((m) => (m.type === "user" ? m.text : null))).toEqual(["after restart"]);
    // seq carries on where it stopped.
    expect(resumed.messages[0]?.seq).toBe(before.session.seq + 1);
  });

  test("a session is removed from disk with its items", async () => {
    const api = await makeApi();
    const s = await api.start("bye");
    expect((await readdir(join(api.dataDir, "sessions"))).filter((f) => f.startsWith(s.id)).length).toBe(2);
    await api.call("DELETE", `/api/sessions/${s.id}`);
    expect((await readdir(join(api.dataDir, "sessions"))).filter((f) => f.startsWith(s.id))).toEqual([]);
  });
});

describe("project deletion", () => {
  test("deleting a project deletes its sessions", async () => {
    const api = await makeApi();
    const a = await api.start("in alpha");
    const b = await api.post<Session>("/projects/beta/sessions", { message: "in beta" });
    turn(await api.work("r1"));
    api.bus.emit({ type: "project", action: "deleted", slug: "alpha" });
    expect((await api.get(`/sessions/${a.id}`)).status).toBe(404);
    expect((await api.get<SessionsResponse>("/sessions")).json.sessions.map((s) => s.id)).toEqual([b.json.id]);
    // Its files go too.
    const deadline = Date.now() + 2000;
    let left: string[] = [];
    do {
      left = (await readdir(join(api.dataDir, "sessions"))).filter((f) => f.startsWith(a.id));
      if (left.length > 0) await Bun.sleep(10);
    } while (left.length > 0 && Date.now() < deadline);
    expect(left).toEqual([]);
    // Other event types and other actions change nothing.
    api.bus.emit({ type: "project", action: "updated", slug: "beta" });
    expect((await api.get(`/sessions/${b.json.id}`)).status).toBe(200);
  });
});

describe("only the holder writes", () => {
  test("runner and boot are required; anyone but the holding process gets 409", async () => {
    const api = await makeApi();
    const s = await api.start("go");
    // Nobody holds a queued session.
    expect((await api.item(s.id, { type: "assistant", text: "x" })).status).toBe(409);
    turn(await api.work("r1"));
    expect((await api.post(`/sessions/${s.id}/items`, { type: "assistant", text: "x" })).status).toBe(400);
    expect((await api.call("POST", `/api/sessions/${s.id}/items?runner=r1`, { type: "assistant", text: "x" })).status).toBe(400);
    expect((await api.call("PATCH", `/api/sessions/${s.id}?boot=boot-r1`, { activity: "x" })).status).toBe(400);
    expect((await api.item(s.id, { type: "assistant", text: "x" }, "r2")).status).toBe(409);
    expect((await api.item(s.id, { type: "assistant", text: "x" }, "r1", "other-boot")).status).toBe(409);
    expect((await api.patch(s.id, { status: "idle" }, "r2")).status).toBe(409);
    expect((await api.item(s.id, { type: "assistant", text: "mine" })).status).toBe(200);

    // After a stop the holder may still store its resume handle.
    await api.post(`/sessions/${s.id}/stop`);
    expect((await api.patch<Session>(s.id, { resume: "h1" })).status).toBe(200);
    expect((await api.patch(s.id, { resume: "h2" }, "r2")).status).toBe(409);

    // A new claim by another runner takes the session: the old holder's late writes are refused.
    await api.post(`/sessions/${s.id}/messages`, { text: "again" });
    expect(turn(await api.work("r2")).resume).toBe("h1");
    expect((await api.patch(s.id, { status: "idle" })).status).toBe(409);
    expect((await api.item(s.id, { type: "assistant", text: "late" })).status).toBe(409);
    expect((await api.get<SessionDetail>(`/sessions/${s.id}`)).json.session.status).toBe("working");
  });

  test("a runner that comes back with a new boot fails what its old process held", async () => {
    const api = await makeApi();
    const working = await api.start("working");
    turn(await api.work("r1", 0, ["claude"], undefined, "old"));
    const waiting = await api.start("waiting");
    turn(await api.work("r1", 0, ["claude"], undefined, "old"));
    await api.item(waiting.id, { type: "question", questionId: "q", text: "?", options: [] }, "r1", "old");
    await api.post(`/sessions/${working.id}/stop`);
    const other = await api.start("other runner");
    turn(await api.work("r9"));

    // The stop for `working` was meant for the old process; the new one is not told.
    expect(await api.work("r1", 0, ["claude"], undefined, "new")).toBeNull();
    const byId = new Map((await api.get<SessionsResponse>("/sessions")).json.sessions.map((x) => [x.id, x]));
    expect(byId.get(waiting.id)).toMatchObject({ status: "failed", error: "the agent runner restarted" });
    expect(byId.get(working.id)?.status).toBe("stopped");
    expect(byId.get(other.id)?.status).toBe("working");
    expect((await api.item(waiting.id, { type: "assistant", text: "late" }, "r1", "old")).status).toBe(409);
    // The same boot again changes nothing.
    expect(await api.work("r1", 0, ["claude"], undefined, "new")).toBeNull();
  });
});

describe("a claim whose response is lost", () => {
  test("is undone: the session is queued again with its messages, and the next poll gets it", async () => {
    const api = await makeApi();
    const s = await api.start("first");
    await api.post(`/sessions/${s.id}/messages`, { text: "second" });
    const controller = new AbortController();
    // The request goes away the moment the claim happens, before its write lands.
    const off = api.bus.subscribe((e) => {
      if (e.type === "session" && e.id === s.id && e.status === "working") controller.abort();
    });
    const lost = await api.sessions.work({ runner: "r1", boot: "boot-r1", providers: [ready("claude")], accepting: true, wait: 1 }, controller.signal);
    off();
    expect(lost).toBeNull();
    expect((await api.get<SessionDetail>(`/sessions/${s.id}`)).json.session).toMatchObject({ status: "queued", pending: 2 });
    const again = turn(await api.work("r2"));
    expect(again.messages.map((m) => (m.type === "user" ? m.text : null))).toEqual(["first", "second"]);
  });
});

describe("a failed turn with messages pending", () => {
  test("is queued again once, and the error stays as a notice", async () => {
    const api = await makeApi();
    const s = await api.start("start");
    turn(await api.work("r1"));
    await api.post(`/sessions/${s.id}/messages`, { text: "and this" });
    const failed = await api.patch<Session>(s.id, { status: "failed", error: "provider exploded" });
    expect(failed.json).toMatchObject({ status: "queued", pending: 1 });
    const items = (await api.get<SessionDetail>(`/sessions/${s.id}`)).json.items;
    expect(items.at(-1)).toMatchObject({ type: "notice", level: "error", text: "The turn failed: provider exploded" });
    const next = turn(await api.work("r1"));
    expect(next.messages.map((m) => (m.type === "user" ? m.text : null))).toEqual(["and this"]);
    // Nothing pending this time: it rests as failed.
    expect((await api.patch<Session>(s.id, { status: "failed", error: "again" })).json).toMatchObject({ status: "failed", error: "again" });
  });
});

describe("size limits", () => {
  test("bodies over 2 MB and oversized item fields are 400", async () => {
    const api = await makeApi();
    const s = await api.start("go");
    turn(await api.work("r1"));
    expect((await api.post(`/sessions/${s.id}/messages`, { text: "x".repeat(2 * 1024 * 1024) })).status).toBe(400);
    expect((await api.post(`/sessions/${s.id}/messages`, { text: "x".repeat(100_001) })).status).toBe(400);
    const okTool = { type: "tool", callId: "c", name: "n", summary: "s", status: "ok", result: "r", images: ["/api/renders/k/iso.png"] };
    const bad = [
      { type: "assistant", text: "x".repeat(100_001) },
      { ...okTool, summary: "s".repeat(301) },
      { ...okTool, result: "r".repeat(20_001) },
      { ...okTool, images: Array.from({ length: 17 }, (_, i) => `/api/renders/k/${i}.png`) },
      { ...okTool, images: ["https://example.com/x.png"] },
      { type: "question", questionId: "q", text: "?", options: Array.from({ length: 13 }, (_, i) => `o${i}`) },
      { type: "question", questionId: "q", text: "?", options: ["o".repeat(201)] },
    ];
    for (const body of bad) expect({ body: JSON.stringify(body).slice(0, 60), status: (await api.item(s.id, body)).status }).toMatchObject({ status: 400 });
    expect((await api.item(s.id, { ...okTool, summary: "s".repeat(300), result: "r".repeat(20_000) })).status).toBe(200);
  });
});
