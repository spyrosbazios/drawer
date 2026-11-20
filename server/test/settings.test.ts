import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DrawerEvent, Settings } from "@drawer/shared/api";
import { EventBus } from "../src/events.ts";
import { applySettingsPatch, defaultSettings, SETTINGS_FILE, SettingsStore } from "../src/settings.ts";
import { harness, type Harness } from "./helpers.ts";

const WEB = { "x-drawer-author": "web" };
const patch = (body: unknown, headers: Record<string, string> = WEB) => h.call<Settings>("PATCH", "/api/settings", { body, headers });

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

describe("settings routes", () => {
  test("defaults: every provider enabled, claude the default", async () => {
    const res = await h.get<Settings>("/api/settings");
    expect(res.status).toBe(200);
    expect(res.json).toEqual(defaultSettings());
    expect(Object.keys(res.json.providers)).toEqual(["claude", "codex", "pi", "gemini"]);
  });

  test("an agent may not change them", async () => {
    expect((await patch({ defaultProvider: "pi" }, {})).status).toBe(403);
    expect((await patch({ defaultProvider: "pi" }, { "x-drawer-author": "agent" })).json).toMatchObject({ error: "forbidden" });
  });

  test("a person changes only the fields sent; the file holds the result", async () => {
    const res = await patch({ defaultProvider: "pi", providers: { pi: { defaultModel: "openai/gpt-x", customModels: ["deepseek/v4", "deepseek/v4"] } } });
    expect(res.status).toBe(200);
    expect(res.json.defaultProvider).toBe("pi");
    expect(res.json.providers.pi).toEqual({ enabled: true, defaultModel: "openai/gpt-x", customModels: ["deepseek/v4"] });
    expect(res.json.providers.claude).toEqual(defaultSettings().providers.claude);
    expect(JSON.parse(await readFile(join(h.dataDir, SETTINGS_FILE), "utf8"))).toEqual(res.json);
    const cleared = await patch({ providers: { pi: { defaultModel: null } } });
    expect(cleared.json.providers.pi.defaultModel).toBeNull();
  });

  test("a session started without a provider gets the default one", async () => {
    await h.newProject("set");
    await patch({ defaultProvider: "codex", providers: { codex: { defaultModel: "gpt-a" } } });
    const created = await h.post("/api/projects/set/sessions", { message: "hi" }, WEB);
    expect(created.json).toMatchObject({ provider: "codex", model: "gpt-a" });
  });

  test("a session request with a model that is not a model id is refused", async () => {
    await h.newProject("bad-model");
    for (const model of ["--config=x", "-m", "a b", "x\ny", "../x", "", " "]) {
      const res = await h.post("/api/projects/bad-model/sessions", { message: "hi", model }, WEB);
      expect(res.status).toBe(400);
    }
    expect((await h.post("/api/projects/bad-model/sessions", { message: "hi", provider: "pi", model: "openai/gpt-5.1" }, WEB)).status).toBe(201);
  });

  test("invalid changes are refused and change nothing", async () => {
    const before = (await h.get<Settings>("/api/settings")).json;
    for (const body of [
      { providers: { openai: { enabled: true } } },
      // Which CLI the runner executes is the runner's host's decision, never a setting.
      { providers: { pi: { binaryPath: "/tmp/evil.js" } } },
      { providers: { pi: { binaryPath: null } } },
      { providers: { pi: { defaultModel: "has space" } } },
      { providers: { pi: { defaultModel: "--config=x" } } },
      { providers: { pi: { defaultModel: "-m" } } },
      { providers: { pi: { defaultModel: "a\nb" } } },
      { providers: { pi: { defaultModel: "../../etc/passwd" } } },
      { providers: { codex: { customModels: ["ok", "-c"] } } },
      { providers: { pi: { customModels: "x" } } },
      { providers: { pi: { enabled: "yes" } } },
      { providers: { pi: { color: "red" } } },
      { defaultProvider: "openai" },
      { theme: "dark" },
      { providers: { [before.defaultProvider]: { enabled: false } } },
    ]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
    }
    expect((await h.get<Settings>("/api/settings")).json).toEqual(before);
  });
});

describe("the settings file", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "drawer-settings-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a change is written, announced, and read back by a new store", async () => {
    const bus = new EventBus();
    const events: DrawerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const store = new SettingsStore(dir, bus);
    await store.init();
    await store.patch({ providers: { gemini: { enabled: false } } });
    expect(events).toEqual([{ type: "settings" }]);
    const again = new SettingsStore(dir, new EventBus());
    await again.init();
    expect(again.get().providers.gemini.enabled).toBe(false);
  });

  test("a file missing fields gets the defaults for them; a broken file stops start-up", async () => {
    await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ providers: { pi: { defaultModel: "openai/gpt-x" } } }));
    const store = new SettingsStore(dir, new EventBus());
    await store.init();
    expect(store.get().providers.pi.defaultModel).toBe("openai/gpt-x");
    expect(store.get().providers.claude.enabled).toBe(true);
    await writeFile(join(dir, SETTINGS_FILE), "{ nope");
    await expect(new SettingsStore(dir, new EventBus()).init()).rejects.toThrow("not valid JSON");
    await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ defaultProvider: "openai" }));
    await expect(new SettingsStore(dir, new EventBus()).init()).rejects.toThrow("defaultProvider");
  });

  test("a file from an older version that holds binaryPath loads, and the key is gone after the next write", async () => {
    await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ defaultProvider: "pi", providers: { pi: { enabled: true, binaryPath: "/opt/pi", defaultModel: "openai/gpt-x", customModels: [] }, codex: { binaryPath: null } } }));
    const store = new SettingsStore(dir, new EventBus());
    await store.init();
    expect(store.get().defaultProvider).toBe("pi");
    expect(store.get().providers.pi).toEqual({ enabled: true, defaultModel: "openai/gpt-x", customModels: [] });
    expect(store.get().providers.codex).not.toHaveProperty("binaryPath");
    await store.patch({ providers: { gemini: { enabled: false } } });
    const text = await readFile(join(dir, SETTINGS_FILE), "utf8");
    expect(text).not.toContain("binaryPath");
    expect(JSON.parse(text)).toEqual(store.get());
  });

  test("a file still has its known values validated", async () => {
    await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ providers: { pi: { defaultModel: "-x" } } }));
    await expect(new SettingsStore(dir, new EventBus()).init()).rejects.toThrow("model id");
  });

  test("the default provider cannot be switched off", () => {
    expect(() => applySettingsPatch(defaultSettings(), { providers: { claude: { enabled: false } } })).toThrow("must stay enabled");
    const moved = applySettingsPatch(defaultSettings(), { defaultProvider: "pi", providers: { claude: { enabled: false } } });
    expect(moved.defaultProvider).toBe("pi");
  });
});
