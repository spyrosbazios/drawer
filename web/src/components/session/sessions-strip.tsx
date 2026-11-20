import type { Session } from "@drawer/shared/api";
import { Link } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { useMemo } from "react";
import { StatusChip } from "@/components/status/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { formatElapsed, formatRelative } from "@/core/format";
import { useProjects } from "@/hooks/projects";
import { useSession, useSessions } from "@/hooks/sessions";
import { cn } from "@/lib/utils";
import { firstLine, groupStrip, pinnedQuestion } from "./model";

/** A waiting session's open question, first line (reads the session detail; only waiting ones do). */
function QuestionLine({ id }: { id: string }) {
  const detail = useSession(id);
  const q = detail.data ? pinnedQuestion(detail.data.items) : undefined;
  return <>{q ? firstLine(q.text) : "waiting for you"}</>;
}

function Line({ s }: { s: Session }) {
  if (s.status === "waiting") return <QuestionLine id={s.id} />;
  if (s.status === "working") return <>{[s.activity ?? "working", formatElapsed(s.updatedAt)].join(" · ")}</>;
  if (s.status === "queued") return <>queued{s.pending > 0 ? ` · ${s.pending} message${s.pending === 1 ? "" : "s"}` : ""}</>;
  if (s.status === "failed") return <>{s.error ?? "failed"}</>;
  return <>{formatRelative(s.updatedAt)}</>;
}

const GROUPS = [
  { key: "waiting", label: "Waiting for you", tone: "border-warn/60 bg-warn/10" },
  { key: "working", label: "Working", tone: "border-run/50 bg-run/10" },
  { key: "queued", label: "Queued", tone: "border-line bg-card" },
  { key: "recent", label: "Recently finished", tone: "border-line bg-card" },
] as const;

/**
 * Home's Sessions strip, grouped by what needs the person: waiting for an answer, working, queued, recently
 * finished. The group heading is the state; only "recently finished" mixes states, so only its cards carry a chip.
 * Each card opens its project with that session in the right panel.
 */
export function SessionsStrip() {
  const sessions = useSessions();
  const projects = useProjects();
  const titles = useMemo(() => new Map((projects.data ?? []).map((p) => [p.slug, p.title])), [projects.data]);
  // "Recent" is measured from when the list was fetched: render stays pure, and a refetch moves it on.
  const groups = groupStrip(sessions.data ?? [], sessions.dataUpdatedAt);
  const empty = GROUPS.every((g) => groups[g.key].length === 0);

  if (!sessions.isPending && empty) return null;
  return (
    <section aria-labelledby="sessions-heading" className="space-y-2">
      <div className="flex items-center gap-2">
        <BotIcon className="size-4 text-dim" />
        <h2 id="sessions-heading" className="text-sm font-medium">
          Sessions
        </h2>
      </div>
      {sessions.isPending ? (
        <div className="flex gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-64 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-1 scroll-contain" data-scroll-restoration-id="list|home-sessions">
          {GROUPS.filter((g) => groups[g.key].length > 0).map((g) => (
            <div key={g.key} className="shrink-0 space-y-1">
              <h3 className="text-[11px] font-medium tracking-wide text-dim uppercase">{g.label}</h3>
              <ul className="flex gap-2">
                {groups[g.key].map((s) => (
                  <li key={s.id}>
                    <Link
                      to="/p/$slug"
                      params={{ slug: s.project }}
                      search={{ session: s.id }}
                      className={cn("flex h-16 w-64 flex-col justify-center gap-0.5 rounded-lg border px-3 text-sm transition-colors hover:border-faint", g.tone)}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{titles.get(s.project) ?? s.project}</span>
                        {g.key === "recent" && <StatusChip kind="session" status={s.status} />}
                      </span>
                      <span className="truncate text-xs text-dim">
                        <Line s={s} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
