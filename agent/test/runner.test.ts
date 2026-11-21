import { describe, expect, test } from "bun:test";
import type { NewSessionItem, ProviderSettings, RunnerPoll, RunnerSessionPatch, RunnerWork, Session, SessionItem, Settings } from "@drawer/shared/api";
import type { Provider, ProviderCheck, Turn } from "../src/provider.ts";
import { ApiFailure } from "@drawer/cli/client";
import { Runner, renderUserItem, turnMessages, type RunnerClient } from "../src/runner.ts";
import { fakeClient } from "./fakes.ts";

type Rec = { kind: "item"; id: string; item: NewSessionItem } | { kind: "patch"; id: string; body: RunnerSessionPatch };

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project: "clip",
    title: "t",
    provider: "claude",
    model: "sonnet",
    status: "working",
    activity: null,
    pending: 0,
    toolCalls: 0,
    seq: 1,
    version: 1,
    error: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const userItem = (text: string): Extract<SessionItem, { type: "user" }> => ({
  seq: 1,
  version: 1,
  at: "",
  type: "user",
  text,
  refs: [{ kind: "point", part: "cable-clip", position: [1, 2, 3], normal: [0, 0, 1] }],
  attachments: [],
  author: "web",
});

const noAttachments = async (): Promise<never> => {
  throw new Error("no attachments in this test");
};

const turn = (id: string, text = "make a clip"): Extract<RunnerWork, { kind: "turn" }> => ({ kind: "turn", session: session(id), messages: [userItem(text)], resume: null, guide: "# Guide" });

const identity = { runner: "r", boot: "b1" };

function settingsWith(claude: Partial<ProviderSettings> = {}): Settings {
  const fresh = (): ProviderSettings => ({ enabled: true, defaultModel: null, customModels: [] });
  return { defaultProvider: "claude", providers: { claude: { ...fresh(), ...claude }, codex: fresh(), pi: fresh(), gemini: fresh() } };
}
const SETTINGS = settingsWith();

function recorder() {
  const log: Rec[] = [];
  const client: RunnerClient = {
    settings: async () => SETTINGS,
    runnerWork: async () => null,
    attachmentBytes: noAttachments,
    appendItem: async (id, item, by) => {
      expect(by).toEqual(identity);
      log.push({ kind: "item", id, item });
      return { seq: log.length, version: log.length, at: "", ...item } as SessionItem;
    },
    patchSession: async (id, body, by) => {
      expect(by).toEqual(identity);
      log.push({ kind: "patch", id, body });
      return session(id);
    },
  };
  return { log, client };
}

const quiet = { info: () => {}, error: () => {} };

function runnerWith(provider: Provider, client: RunnerClient, concurrency = 2, extra: { reasoningIntervalMs?: number } = {}) {
  return new Runner({ client, toolClient: fakeClient({}), identity, providers: [provider], concurrency, log: quiet, ...extra });
}

const READY: ProviderCheck = { state: "ready", version: "1.2.3", models: ["m1"], message: null, binary: "/host/claude" };

/** A provider whose turns are scripted by the test. */
function scripted(script: (t: Turn) => Promise<void>, check: () => Promise<ProviderCheck> = async () => READY): Provider & { turns: Turn[] } {
  const turns: Turn[] = [];
  return {
    kind: "claude",
    turns,
    check,
    run: async (t) => {
      turns.push(t);
      await script(t);
    },
  };
}

const untilAborted = (t: Turn) =>
  new Promise<void>((_, reject) => {
    t.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

test("renders refs as plain text", () => {
  expect(renderUserItem(userItem("here"))).toBe("here\n[points at part cable-clip, position (1, 2, 3), face normal (0, 0, 1)]");
});

describe("attachments in a turn", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const att = (id: string, name: string, kind: "image" | "mesh", size = 10) => ({
    id,
    name,
    mediaType: kind === "image" ? "image/png" : "model/stl",
    size,
    kind,
    url: `/api/attachments/${id}`,
    filedAs: null,
  });

  test("images go as image input; every attachment is named in the text", async () => {
    const item: SessionItem = { ...userItem(""), refs: [], attachments: [att("a1", "photo.png", "image"), att("a2", "fan.stl", "mesh"), att("a3", "fake.png", "image")] };
    const fetched: string[] = [];
    const client = {
      attachmentBytes: async (id: string) => {
        fetched.push(id);
        return { bytes: id === "a1" ? PNG : new Uint8Array([1, 2, 3]), name: id };
      },
    };
    const [message, ...rest] = await turnMessages([item], client, new AbortController().signal);
    expect(rest).toEqual([]);
    expect(fetched).toEqual(["a1", "a3"]);
    expect(message?.images).toEqual([{ mediaType: "image/png", data: PNG }]);
    expect(message?.text.split("\n")).toEqual([
      '[attached a1: "photo.png", image, image/png, 10 B, not filed yet, shown below]',
      '[attached a2: "fan.stl", mesh, model/stl, 10 B, not filed yet]',
      '[attached a3: "fake.png", image, image/png, 10 B, not filed yet]',
    ]);
  });

  test("at most the newest 8 images are sent", async () => {
    const items: SessionItem[] = Array.from({ length: 10 }, (_, i) => ({ ...userItem(`m${i}`), seq: i + 1, refs: [], attachments: [att(`i${i}`, `${i}.png`, "image")] }));
    const messages = await turnMessages(items, { attachmentBytes: async (id) => ({ bytes: PNG, name: id }) }, new AbortController().signal);
    expect(messages.map((m) => m.images.length)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("turn lifecycle", () => {
  test("items in order, resume kept, then idle", async () => {
    const { log, client } = recorder();
    const provider = scripted(async (t) => {
      t.onEvent({ type: "resume", handle: "claude-1" });
      t.onEvent({ type: "assistant_text", text: "Reading the brief." });
      t.onEvent({ type: "tool_started", callId: "c1", name: "write_model", input: { part: "cable-clip" } });
      t.onEvent({ type: "tool_finished", callId: "c1", name: "write_model", ok: true, summary: "cable-clip: draft 5/6", text: "x".repeat(1000), images: ["/api/renders/k/sheet.png"] });
      t.onEvent({ type: "assistant_text", text: "Not done: bore fails." });
    });
    const runner = runnerWith(provider, client);
    runner.dispatch(turn("s1"));
    await runner.idle();

    const t = provider.turns[0];
    expect(t?.systemPrompt).toContain("# Guide");
    expect(t?.systemPrompt).toContain("`write_model`");
    expect(t?.systemPrompt).toContain("`clip`");
    expect(t?.messages[0]?.text).toContain("[points at part cable-clip");
    expect(t?.model).toBe("sonnet");

    const items = log.filter((r) => r.kind === "item").map((r) => (r as { item: NewSessionItem }).item);
    expect(items.map((i) => i.type)).toEqual(["assistant", "tool", "tool", "assistant"]);
    expect(items[1]).toMatchObject({ callId: "c1", status: "running", summary: "writing cable-clip" });
    const finished = items[2] as Extract<NewSessionItem, { type: "tool" }>;
    expect(finished).toMatchObject({ callId: "c1", status: "ok", images: ["/api/renders/k/sheet.png"] });
    expect((finished.result ?? "").length).toBeLessThan(500);

    const last = log.at(-1);
    expect(last).toEqual({ kind: "patch", id: "s1", body: { resume: "claude-1", status: "idle", activity: null, error: null } });
  });

  test("reasoning: opens in place, streams at most once per interval, closes as done, and never moves other items", async () => {
    const { log, client } = recorder();
    const provider = scripted(async (t) => {
      t.onEvent({ type: "reasoning", id: "t1", text: "", done: false });
      t.onEvent({ type: "reasoning", id: "t1", text: "Look", done: false });
      t.onEvent({ type: "reasoning", id: "t1", text: "Look at", done: false });
      t.onEvent({ type: "reasoning", id: "t1", text: "Look at the overview", done: false });
      t.onEvent({ type: "assistant_text", text: "Reading." });
      await Bun.sleep(120);
      t.onEvent({ type: "reasoning", id: "t1", text: "Look at the overview, then answer", done: true });
      t.onEvent({ type: "reasoning", id: "t1", text: "ignored: already closed", done: false });
      t.onEvent({ type: "reasoning", id: "t2", text: "   ", done: true });
      t.onEvent({ type: "assistant_text", text: "Done." });
    });
    const runner = runnerWith(provider, client, 2, { reasoningIntervalMs: 50 });
    runner.dispatch(turn("s1"));
    await runner.idle();
    const items = log.filter((r) => r.kind === "item").map((r) => (r as { item: NewSessionItem }).item);
    expect(items.map((i) => (i.type === "reasoning" ? `${i.reasoningId}:${i.status}:${i.text}` : i.type))).toEqual([
      "t1:running:Look",
      "assistant",
      "t1:running:Look at the overview",
      "t1:done:Look at the overview, then answer",
      "assistant",
    ]);
  });

  test("reasoning: a long thought keeps its tail, and an open one is closed when the turn ends or fails", async () => {
    const { log, client } = recorder();
    const long = `${"a".repeat(5000)}END`;
    const provider = scripted(async (t) => {
      t.onEvent({ type: "reasoning", id: "t1", text: long, done: false });
      t.onEvent({ type: "reasoning", id: "t2", text: "never closed by the provider", done: false });
      throw new Error("boom");
    });
    const runner = runnerWith(provider, client);
    runner.dispatch(turn("s1"));
    await runner.idle();
    const items = log.filter((r) => r.kind === "item").map((r) => (r as { item: Extract<NewSessionItem, { type: "reasoning" }> }).item);
    const closing = items.filter((i) => i.status === "done");
    expect(closing.map((i) => i.reasoningId).sort()).toEqual(["t1", "t2"]);
    const t1 = closing.find((i) => i.reasoningId === "t1");
    expect(t1?.text.length).toBe(4000);
    expect(t1?.text.startsWith("…")).toBe(true);
    expect(t1?.text.endsWith("END")).toBe(true);
    expect(log.at(-1)).toMatchObject({ kind: "patch", body: { status: "failed" } });
  });

  test("a provider error marks the session failed", async () => {
    const { log, client } = recorder();
    const runner = runnerWith(
      scripted(async () => {
        throw new Error("Claude: rate limited");
      }),
      client,
    );
    runner.dispatch(turn("s1"));
    await runner.idle();
    expect(log.at(-1)).toMatchObject({ kind: "patch", body: { status: "failed", error: "Claude: rate limited" } });
  });

  test("stop aborts the turn and does not patch the status", async () => {
    const { log, client } = recorder();
    const provider = scripted(untilAborted);
    const runner = runnerWith(provider, client);
    runner.dispatch(turn("s1"));
    await Bun.sleep(5);
    runner.dispatch({ kind: "stop", sessionId: "s1" });
    await runner.idle();
    expect(provider.turns[0]?.signal.aborted).toBe(true);
    const statuses = log.filter((r) => r.kind === "patch" && r.body.status !== undefined);
    expect(statuses).toEqual([]);
  });

  test("an unknown provider fails the session", async () => {
    const { log, client } = recorder();
    const runner = runnerWith(scripted(async () => {}), client);
    runner.dispatch({ ...(turn("s1") as Extract<RunnerWork, { kind: "turn" }>), session: session("s1", { provider: "codex" }) });
    await runner.idle();
    expect(log.at(-1)).toMatchObject({ kind: "patch", body: { status: "failed" } });
  });
});

describe("polling", () => {
  test("stops accepting at the concurrency cap and still reports every provider", async () => {
    const polls: RunnerPoll[] = [];
    const works: RunnerWork[] = [turn("a"), turn("b"), null];
    const { client: base } = recorder();
    const client: RunnerClient = {
      ...base,
      runnerWork: async (poll) => {
        polls.push(poll);
        return works.shift() ?? null;
      },
    };
    const provider = scripted(untilAborted);
    const runner = runnerWith(provider, client, 2);
    await runner.pollOnce();
    await runner.pollOnce();
    await runner.pollOnce();
    expect(polls.map((p) => p.accepting)).toEqual([true, true, false]);
    expect(polls.every((p) => p.runner === "r" && p.boot === "b1" && p.providers.length === 1)).toBe(true);
    expect(runner.busy.sort()).toEqual(["a", "b"]);
    await runner.stop();
    expect(runner.busy).toEqual([]);
  });

  test("survives poll failures with backoff", async () => {
    let calls = 0;
    const { client: base } = recorder();
    const sleeps: number[] = [];
    let runner: Runner | null = null;
    const client: RunnerClient = {
      ...base,
      runnerWork: async () => {
        calls++;
        if (calls >= 4) void runner?.stop();
        if (calls < 3) throw new Error("ECONNREFUSED");
        return null;
      },
    };
    runner = new Runner({
      client,
      toolClient: fakeClient({}),
      identity,
      providers: [scripted(async () => {})],
      concurrency: 1,
      log: quiet,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await runner.run();
    expect(sleeps).toEqual([1000, 2000]);
    expect(calls).toBe(4);
  });
});

describe("provider status", () => {
  test("enabled: the provider's check plus the custom models; disabled: still checked, state disabled", async () => {
    const { client } = recorder();
    const runner = runnerWith(scripted(async () => {}), client);
    expect(await runner.statuses(settingsWith({ customModels: ["m1", "my-model"] }))).toEqual([
      { kind: "claude", state: "ready", version: "1.2.3", models: ["m1", "my-model"], message: null, binary: "/host/claude" },
    ]);
    expect(await runner.statuses(settingsWith({ enabled: false }))).toEqual([{ kind: "claude", state: "disabled", version: "1.2.3", models: ["m1"], message: null, binary: "/host/claude" }]);
  });

  test("checks are cached, refreshed in the background once stale, and a throwing check is unavailable", async () => {
    const seen: string[] = [];
    let fail = false;
    const provider = scripted(
      async () => {},
      async () => {
        seen.push("check");
        if (fail) throw new Error("boom");
        return READY;
      },
    );
    const { client } = recorder();
    let now = 0;
    const runner = new Runner({ client, toolClient: fakeClient({}), identity, providers: [provider], concurrency: 1, log: quiet, checkTtlMs: 1000, now: () => now });
    await runner.statuses(SETTINGS);
    await runner.statuses(SETTINGS);
    expect(seen).toEqual(["check"]);
    // A settings change is no reason to probe again: nothing in settings names what runs.
    await runner.statuses(settingsWith({ customModels: ["x"] }));
    expect(seen).toEqual(["check"]);
    now = 5000;
    fail = true;
    // Stale: the old answer still serves while a refresh runs; the refresh's answer serves next time.
    expect((await runner.statuses(SETTINGS))[0]?.state).toBe("ready");
    await Bun.sleep(1);
    expect((await runner.statuses(SETTINGS))[0]).toMatchObject({ state: "unavailable", message: "boom" });
  });

  test("the status reports the CLI the host resolved; a binaryPath from the server is ignored", async () => {
    const { client: base } = recorder();
    const hostile = { ...SETTINGS, providers: { ...SETTINGS.providers, claude: { ...SETTINGS.providers.claude, binaryPath: "/data/projects/x/evil.js" } } } as Settings;
    let polled: RunnerPoll | null = null;
    const client: RunnerClient = {
      ...base,
      settings: async () => hostile,
      runnerWork: async (q) => {
        polled = q;
        return turn("s1");
      },
    };
    const provider = scripted(async () => {});
    const runner = runnerWith(provider, client);
    await runner.pollOnce();
    await runner.idle();
    expect((polled as RunnerPoll | null)?.providers[0]?.binary).toBe("/host/claude");
    expect(JSON.stringify(provider.turns[0])).not.toContain("evil.js");
  });

  test("a model or resume handle that is not an id fails the turn before the provider runs", async () => {
    for (const work of [
      { ...turn("s1"), session: session("s1", { model: "--dangerously-skip-permissions" }) },
      { ...turn("s1"), session: session("s1", { model: "a b" }) },
      { ...turn("s1"), resume: "--fork-session" },
    ] satisfies RunnerWork[]) {
      const { client: base, log } = recorder();
      const client: RunnerClient = { ...base, runnerWork: async () => work };
      const provider = scripted(async () => {});
      const runner = runnerWith(provider, client);
      await runner.pollOnce();
      await runner.idle();
      expect(provider.turns).toEqual([]);
      expect(log.find((r) => r.kind === "patch" && r.body.status === "failed")).toBeDefined();
    }
  });
});

describe("holding the session", () => {
  test("a 409 on the runner's own write ends the turn quietly: no retry, no status", async () => {
    const log: Rec[] = [];
    let appends = 0;
    const client: RunnerClient = {
      settings: async () => SETTINGS,
      runnerWork: async () => null,
      attachmentBytes: noAttachments,
      appendItem: async () => {
        appends++;
        throw new ApiFailure(409, "conflict", "not held");
      },
      patchSession: async (id, body) => {
        log.push({ kind: "patch", id, body });
        return session(id);
      },
    };
    const provider = scripted(async (t) => {
      t.onEvent({ type: "assistant_text", text: "one" });
      t.onEvent({ type: "assistant_text", text: "two" });
      await untilAborted(t);
    });
    const errors: string[] = [];
    const runner = new Runner({ client, toolClient: fakeClient({}), identity, providers: [provider], concurrency: 1, log: { info: () => {}, error: (m) => errors.push(m) } });
    runner.dispatch(turn("s1"));
    await runner.idle();
    expect(provider.turns[0]?.signal.aborted).toBe(true);
    expect(appends).toBe(1);
    expect(log.filter((r) => r.kind === "patch" && (r.body.status !== undefined || r.body.resume !== undefined))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a 409 on the final patch is not a failure", async () => {
    const statuses: (string | undefined)[] = [];
    const client: RunnerClient = {
      settings: async () => SETTINGS,
      runnerWork: async () => null,
      attachmentBytes: noAttachments,
      appendItem: async (_id, item) => ({ seq: 1, version: 1, at: "", ...item }) as SessionItem,
      patchSession: async (id, body) => {
        statuses.push(body.status);
        if (body.status !== undefined) throw new ApiFailure(409, "conflict", "not held");
        return session(id);
      },
    };
    const runner = runnerWith(scripted(async () => {}), client);
    runner.dispatch(turn("s1"));
    await runner.idle();
    expect(statuses.filter((x) => x !== undefined)).toEqual(["idle"]);
  });
});

describe("a new turn while the previous one is tearing down", () => {
  test("waits for it, then runs with its resume handle; nothing is dropped", async () => {
    const { log, client } = recorder();
    let release: () => void = () => {};
    const slowTeardown = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = scripted(async (t) => {
      if (provider.turns.length === 1) {
        t.onEvent({ type: "resume", handle: "h-old" });
        await untilAborted(t).catch(async (err: unknown) => {
          await slowTeardown;
          throw err;
        });
      }
    });
    const runner = runnerWith(provider, client);
    runner.dispatch(turn("s1", "first"));
    await Bun.sleep(5);
    runner.dispatch({ kind: "stop", sessionId: "s1" });
    runner.dispatch(turn("s1", "second"));
    await Bun.sleep(5);
    expect(provider.turns.length).toBe(1);
    release();
    await runner.idle();
    expect(provider.turns.length).toBe(2);
    expect(provider.turns[1]?.messages[0]?.text).toStartWith("second");
    expect(provider.turns[1]?.resume).toBe("h-old");
    expect(log.at(-1)).toMatchObject({ kind: "patch", body: { status: "idle" } });
  });
});

describe("item limits", () => {
  test("long text and many images are trimmed before they are sent", async () => {
    const { log, client } = recorder();
    const provider = scripted(async (t) => {
      t.onEvent({ type: "assistant_text", text: "a".repeat(150_000) });
      t.onEvent({ type: "tool_finished", callId: "c", name: "view_part", ok: true, summary: "s".repeat(1000), text: "t", images: Array.from({ length: 20 }, (_, i) => `/api/renders/k/${i}.png`) });
    });
    const runner = runnerWith(provider, client);
    runner.dispatch(turn("s1"));
    await runner.idle();
    const items = log.filter((r) => r.kind === "item").map((r) => (r as { item: NewSessionItem }).item);
    const text = items[0] as Extract<NewSessionItem, { type: "assistant" }>;
    expect(text.text.length).toBeLessThanOrEqual(100_000);
    const tool = items[1] as Extract<NewSessionItem, { type: "tool" }>;
    expect(tool.images.length).toBe(16);
    expect(tool.summary.length).toBeLessThanOrEqual(300);
  });
});
