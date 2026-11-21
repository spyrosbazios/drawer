import type { ProviderKind, ProviderState, RunnerInfo, Settings } from "@drawer/shared/api";
import { describe, expect, test } from "bun:test";
import { providerView } from "@/components/settings/model";

const provider = (kind: ProviderKind, state: ProviderState) => ({ kind, state, version: null, models: [], message: null, binary: null });
const runner = (...states: [ProviderKind, ProviderState][]): RunnerInfo => ({ id: "workshop", accepting: true, lastSeen: "2026-11-20T10:00:00Z", providers: states.map(([k, s]) => provider(k, s)) });
const settings = (geminiOn: boolean): Settings => ({
  defaultProvider: "claude",
  providers: {
    claude: { enabled: true, defaultModel: null, customModels: [] },
    codex: { enabled: false, defaultModel: null, customModels: [] },
    pi: { enabled: false, defaultModel: null, customModels: [] },
    gemini: { enabled: geminiOn, defaultModel: null, customModels: [] },
  },
});

describe("a provider's row", () => {
  test("off says disabled at once, whatever the runner last reported", () => {
    const v = providerView("gemini", settings(false), [runner(["gemini", "ready"])]);
    expect(v.state).toBe("disabled");
    expect(v.awaitingRunner).toBeFalse();
  });

  test("just turned on: the runner still says disabled, so the row waits for its next report", () => {
    const v = providerView("gemini", settings(true), [runner(["gemini", "disabled"])]);
    expect(v.state).toBeNull();
    expect(v.findings).toEqual([]);
    expect(v.awaitingRunner).toBeTrue();
  });

  test("once a runner reports it, the row shows that", () => {
    const v = providerView("gemini", settings(true), [runner(["gemini", "ready"])]);
    expect(v.state).toBe("ready");
    expect(v.awaitingRunner).toBeFalse();
  });

  test("on with no runner connected is not waiting for a report: nothing will come", () => {
    const v = providerView("gemini", settings(true), []);
    expect(v.state).toBeNull();
    expect(v.awaitingRunner).toBeFalse();
  });
});
