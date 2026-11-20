import { Link } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAgentOptions } from "@/hooks/agents";
import { agentLabel, sameChoice, type AgentChoice } from "@/lib/agent-choice";
import { cn } from "@/lib/utils";

const keyOf = (c: AgentChoice) => `${c.provider}/${c.model ?? ""}`;

/** Picks the provider and model the next session starts with; the default comes from Settings. */
export function AgentPicker({ className, id }: { className?: string; id?: string }) {
  const agent = useAgentOptions();
  const { options, choice, defaultChoice } = agent;

  if (agent.isPending) return <span className={cn("text-xs text-faint", className)}>Looking for agents</span>;
  if (agent.noRunner) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-xs text-warn", className)} title="Start the agent runner (drawer-agent) on the host; sessions stay queued until one connects.">
        <BotIcon className="size-3.5" /> No agent runner connected
      </span>
    );
  }
  if (options.length === 0) {
    return (
      <Link to="/settings" className={cn("inline-flex items-center gap-1.5 text-xs text-warn hover:underline", className)}>
        <BotIcon className="size-3.5" /> No agent ready
      </Link>
    );
  }
  // The default may not be runnable right now (signed out, say); it stays listed so the trigger reads true.
  const listed = choice && !options.some((o) => sameChoice(o, choice)) ? [choice, ...options] : options;
  return (
    <Select
      value={choice ? keyOf(choice) : undefined}
      onValueChange={(v) => {
        const next = listed.find((o) => keyOf(o) === v) ?? null;
        agent.pick(next && sameChoice(next, defaultChoice) ? null : next);
      }}
    >
      <SelectTrigger id={id} size="sm" aria-label="Agent for the next session" className={cn("min-w-40", className)}>
        <BotIcon />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {listed.map((o) => (
          <SelectItem key={keyOf(o)} value={keyOf(o)}>
            {agentLabel(o)}
            {sameChoice(o, defaultChoice) && <span className="text-faint"> (default)</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
