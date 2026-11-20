import type { CreateSessionBody } from "@drawer/shared/api";
import { agentOptions, defaultChoice, effectiveChoice, pickAgent, sessionAgentBody, useAgentPick, type AgentChoice } from "@/lib/agent-choice";
import { useRunners } from "./sessions";
import { useSettings } from "./settings";

export interface AgentOptions {
  /** Provider/model pairs a connected runner can run now. */
  options: AgentChoice[];
  /** The settings' default for a new session; null until settings load. */
  defaultChoice: AgentChoice | null;
  /** What the next session starts with: the pick, or the default. */
  choice: AgentChoice | null;
  /** Picks for the next session only; null goes back to the default. */
  pick(choice: AgentChoice | null): void;
  /** The provider/model fields of a create-session request for `choice`. */
  request: Pick<CreateSessionBody, "provider" | "model">;
  /** Runners or settings still loading. */
  isPending: boolean;
  /** Loaded, and no runner is connected. */
  noRunner: boolean;
}

/** Available provider+model options and the current default, for whatever starts a session. */
export function useAgentOptions(): AgentOptions {
  const runners = useRunners();
  const settings = useSettings();
  const options = agentOptions(runners.data ?? [], settings.data);
  const fallback = settings.data ? defaultChoice(settings.data) : null;
  const choice = effectiveChoice(useAgentPick(), options, fallback);
  return {
    options,
    defaultChoice: fallback,
    choice,
    pick: pickAgent,
    request: sessionAgentBody(choice, fallback),
    isPending: runners.isPending || settings.isPending,
    noRunner: runners.isSuccess && runners.data.length === 0,
  };
}
