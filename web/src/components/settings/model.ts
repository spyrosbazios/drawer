import type { ProviderKind, ProviderState, RunnerInfo, Settings } from "@drawer/shared/api";

/** What one runner found for a provider. */
export interface RunnerFinding {
  runner: string;
  state: ProviderState;
  version: string | null;
  message: string | null;
  /** The CLI path the runner's host resolved; set there, never here. */
  binary: string | null;
}

export interface ProviderView {
  kind: ProviderKind;
  enabled: boolean;
  isDefault: boolean;
  /** The state to show: `disabled` when off, else the best a runner found; null while no runner has reported it. */
  state: ProviderState | null;
  /** On, with a runner connected, but none has reported it yet: the runner picks a change up on its next poll. */
  awaitingRunner: boolean;
  version: string | null;
  findings: RunnerFinding[];
  /** Models to pick a default from: what the runners offer, plus the current default. */
  models: string[];
}

const RANK: Record<ProviderState, number> = { ready: 0, signed_out: 1, unavailable: 2, not_installed: 3, disabled: 4 };

export function providerView(kind: ProviderKind, settings: Settings, runners: readonly RunnerInfo[]): ProviderView {
  const own = settings.providers[kind];
  // A runner reports `disabled` for a provider that was off at its last poll: once it is on, that is stale.
  const findings: RunnerFinding[] = runners.flatMap((r) =>
    r.providers
      .filter((p) => p.kind === kind && (!own.enabled || p.state !== "disabled"))
      .map((p) => ({ runner: r.id, state: p.state, version: p.version, message: p.message, binary: p.binary })),
  );
  const best = [...findings].sort((a, b) => RANK[a.state] - RANK[b.state])[0];
  const offered = runners.flatMap((r) => r.providers.filter((p) => p.kind === kind).flatMap((p) => p.models));
  const models = [...new Set([...offered, ...own.customModels, ...(own.defaultModel ? [own.defaultModel] : [])])];
  return {
    kind,
    enabled: own.enabled,
    isDefault: settings.defaultProvider === kind,
    state: own.enabled ? (best?.state ?? null) : "disabled",
    awaitingRunner: own.enabled && runners.length > 0 && findings.length === 0,
    version: best?.version ?? null,
    findings,
    models,
  };
}

/** Splits a message into plain text and `code` spans (provider messages quote commands in backticks). */
export function codeSpans(text: string): { code: boolean; text: string }[] {
  return text
    .split(/(`[^`]+`)/)
    .filter((part) => part !== "")
    .map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? { code: true, text: part.slice(1, -1) } : { code: false, text: part }));
}
