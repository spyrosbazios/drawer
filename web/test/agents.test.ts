import type { ProviderSettings, RunnerInfo, Settings } from "@drawer/shared/api";
import { describe, expect, test } from "bun:test";
import { codeSpans, providerView } from "@/components/settings/model";
import { agentLabel, agentOptions, defaultChoice, effectiveChoice, sessionAgentBody } from "@/lib/agent-choice";

const fresh = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({ enabled: true, defaultModel: null, customModels: [], ...over });
const settings = (over: Partial<Settings["providers"]> = {}, defaultProvider: Settings["defaultProvider"] = "claude"): Settings => ({
  defaultProvider,
  providers: { claude: fresh({ defaultModel: "sonnet" }), codex: fresh(), pi: fresh(), gemini: fresh(), ...over },
});

const runners: RunnerInfo[] = [
  {
    id: "workshop",
    accepting: true,
    lastSeen: "",
    providers: [
      { kind: "claude", state: "ready", version: "2.1", models: ["sonnet", "opus"], message: null, binary: null },
      { kind: "codex", state: "signed_out", version: "0.170.0", models: [], message: "Sign in: `codex login`", binary: null },
      { kind: "pi", state: "ready", version: "1.5", models: ["openai/gpt-x"], message: null, binary: null },
    ],
  },
  { id: "laptop", accepting: false, lastSeen: "", providers: [{ kind: "codex", state: "ready", version: "0.171.0", models: ["gpt-a"], message: null, binary: null }, { kind: "claude", state: "ready", version: "2.1", models: ["sonnet"], message: null, binary: null }] },
];

describe("agent options", () => {
  test("ready and enabled providers only, each with its default first, pairs once", () => {
    const opts = agentOptions(runners, settings({ pi: fresh({ enabled: false }) }));
    expect(opts.map(agentLabel)).toEqual(["Claude Code", "Claude Code · sonnet", "Claude Code · opus", "Codex", "Codex · gpt-a"]);
  });

  test("the default comes from settings; a pick wins while it is offered", () => {
    const s = settings();
    const opts = agentOptions(runners, s);
    const fallback = defaultChoice(s);
    expect(fallback).toEqual({ provider: "claude", model: "sonnet" });
    expect(effectiveChoice(null, opts, fallback)).toEqual(fallback);
    expect(effectiveChoice({ provider: "pi", model: "openai/gpt-x" }, opts, fallback)).toEqual({ provider: "pi", model: "openai/gpt-x" });
    expect(effectiveChoice({ provider: "gemini", model: null }, opts, fallback)).toEqual(fallback);
  });

  test("a session request names the agent only when it is not the default", () => {
    const fallback = { provider: "claude" as const, model: "sonnet" };
    expect(sessionAgentBody(fallback, fallback)).toEqual({});
    expect(sessionAgentBody({ provider: "pi", model: null }, fallback)).toEqual({ provider: "pi" });
    expect(sessionAgentBody({ provider: "codex", model: "gpt-a" }, fallback)).toEqual({ provider: "codex", model: "gpt-a" });
  });
});

describe("settings view", () => {
  test("a provider shows the best state any runner found, and off when disabled", () => {
    expect(providerView("codex", settings(), runners)).toMatchObject({ state: "ready", version: "0.171.0", models: ["gpt-a"], isDefault: false });
    expect(providerView("pi", settings(), [{ id: "workshop", accepting: true, lastSeen: "", providers: [{ kind: "pi", state: "ready", version: "1.5", models: [], message: null, binary: "/opt/pi" }] }]).findings).toEqual([
      { runner: "workshop", state: "ready", version: "1.5", message: null, binary: "/opt/pi" },
    ]);
    expect(providerView("codex", settings({ codex: fresh({ enabled: false }) }), runners).state).toBe("disabled");
    expect(providerView("gemini", settings(), runners).state).toBeNull();
    expect(providerView("claude", settings(), runners)).toMatchObject({ isDefault: true, models: ["sonnet", "opus"] });
    expect(providerView("pi", settings({ pi: fresh({ customModels: ["x/y"], defaultModel: "z/w" }) }), runners).models).toEqual(["openai/gpt-x", "x/y", "z/w"]);
  });

  test("backticks in a runner's message become code", () => {
    expect(codeSpans("Sign in: `codex login` now")).toEqual([
      { code: false, text: "Sign in: " },
      { code: true, text: "codex login" },
      { code: false, text: " now" },
    ]);
  });
});
