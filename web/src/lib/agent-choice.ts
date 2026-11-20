/**
 * Which agent (provider and model) a new session starts with. The default is the server's settings
 * (`defaultProvider` and its `defaultModel`); a person may pick another one for the next session only.
 * That pick lives here, outside React, for this page; it is cleared once a session starts with it.
 * Sessions that exist keep their own provider and model.
 */
import type { CreateSessionBody, ProviderKind, RunnerInfo, Settings } from "@drawer/shared/api";
import { useSyncExternalStore } from "react";

export interface AgentChoice {
  provider: ProviderKind;
  /** null = the provider's default model. */
  model: string | null;
}

export const PROVIDER_LABELS: Record<ProviderKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", gemini: "Gemini" };

export const sameChoice = (a: AgentChoice | null, b: AgentChoice | null): boolean => a !== null && b !== null && a.provider === b.provider && a.model === b.model;

export const agentLabel = (c: AgentChoice): string => `${PROVIDER_LABELS[c.provider]}${c.model ? ` · ${c.model}` : ""}`;

/** The settings' default for a new session. */
export const defaultChoice = (settings: Settings): AgentChoice => ({ provider: settings.defaultProvider, model: settings.providers[settings.defaultProvider].defaultModel });

/**
 * Every provider/model pair a connected runner can run now, once each: a provider that is `ready` on some
 * runner and enabled in settings, first with its default model, then each model it offers.
 */
export function agentOptions(runners: readonly RunnerInfo[], settings: Settings | undefined): AgentChoice[] {
  const seen = new Set<string>();
  const out: AgentChoice[] = [];
  const add = (c: AgentChoice) => {
    const key = `${c.provider}/${c.model ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const r of runners) {
    for (const p of r.providers) {
      if (p.state !== "ready" || settings?.providers[p.kind].enabled === false) continue;
      add({ provider: p.kind, model: null });
      for (const model of p.models) add({ provider: p.kind, model });
    }
  }
  return out;
}

/** The pick while a runner still offers it, else the default. */
export function effectiveChoice(pick: AgentChoice | null, options: readonly AgentChoice[], fallback: AgentChoice | null): AgentChoice | null {
  if (pick && options.some((o) => sameChoice(o, pick))) return pick;
  return fallback;
}

/** What a create-session request says: nothing for the default (the server applies it), the pick otherwise. */
export function sessionAgentBody(choice: AgentChoice | null, fallback: AgentChoice | null): Pick<CreateSessionBody, "provider" | "model"> {
  if (choice === null || sameChoice(choice, fallback)) return {};
  return { provider: choice.provider, ...(choice.model ? { model: choice.model } : {}) };
}

// ---- the pick for the next session -----------------------------------------------------------

const listeners = new Set<() => void>();
let pick: AgentChoice | null = null;

export function pickAgent(choice: AgentChoice | null): void {
  pick = choice;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useAgentPick = (): AgentChoice | null => useSyncExternalStore(subscribe, () => pick);
