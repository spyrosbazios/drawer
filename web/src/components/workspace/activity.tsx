import type { Session } from "@drawer/shared/api";
import { statusText } from "@/components/status/status-chip";
import { cn } from "@/lib/utils";

/** What the agent is doing in a project, as far as a person who is not looking at its panel needs to know. */
export type Activity = "working" | "waiting";

/** `waiting` (the agent asked you something) outranks `working`; nothing running or asked = null. */
export function projectActivity(sessions: readonly Session[] | undefined, project: string): Activity | null {
  let working = false;
  for (const s of sessions ?? []) {
    if (s.project !== project) continue;
    if (s.status === "waiting") return "waiting";
    if (s.status === "working") working = true;
  }
  return working ? "working" : null;
}

const LABEL: Record<Activity, string> = { working: "Agent is working", waiting: "Agent is waiting for you" };

/**
 * The only copy of the agent's state outside the agent panel: a dot, no text. Tone comes from the session
 * status tokens, so it matches the chip inside the panel.
 */
export function ActivityDot({ activity, className }: { activity: Activity | null; className?: string }) {
  if (!activity) return null;
  return (
    <span className={cn("size-2 shrink-0 rounded-full bg-current", statusText({ kind: "session", status: activity }), activity === "working" && "motion-safe:animate-pulse", className)}>
      <span className="sr-only">{LABEL[activity]}</span>
    </span>
  );
}
