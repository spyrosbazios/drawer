import type { PartReport, PartSummary } from "@drawer/shared/api";
import { ClipboardCheckIcon, LoaderCircleIcon } from "lucide-react";
import { StatusChip } from "@/components/status/status-chip";
import { Button } from "@/components/ui/button";
import { formatGates } from "@/core/format";
import type { RenderProgressState } from "@/hooks/render-progress";
import { useProjectNav } from "@/lib/nav";
import { isFailing } from "./part-facts";

interface Props {
  slug: string;
  summary: PartSummary | undefined;
  report: PartReport | undefined;
  /** Viewing an old revision: the bar describes that report, not the part's status. */
  at: string | undefined;
  progress: RenderProgressState | undefined;
}

const STAGE: Record<RenderProgressState["stage"], string> = {
  queued: "queued",
  analysing: "checking the model",
  geometry: "building mesh",
  views: "drawing views",
  sheet: "contact sheet",
};

/** Status, "6 of 7 gates pass", the first failing gates, Open review; then, while the server evaluates, what it is doing. The agent's own status lives in the agent panel only. */
export function GateBar({ slug, summary, report, at, progress }: Props) {
  const nav = useProjectNav(slug);
  const status = report?.status ?? summary?.status;
  const passed = report?.passed ?? summary?.passed ?? 0;
  const total = report?.total ?? summary?.total ?? 0;
  const failing = report ? report.gates.filter(isFailing).map((g) => (g.measured ? `${g.label} ${g.measured}${g.expected ? ` (needs ${g.expected})` : ""}` : g.label)) : (summary?.failing ?? []);
  const evaluating = summary?.evaluating === true && !at;

  const activity = evaluating ? `Evaluating${progress ? ` · ${STAGE[progress.stage]}${progress.total > 1 ? ` · step ${progress.step} of ${progress.total}` : ""}` : ""}` : null;

  return (
    <footer className="shrink-0 border-t border-line bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        {status && <StatusChip kind="report" status={status} busy={evaluating} />}
        {total > 0 && <span className="text-sm tabular-nums">{formatGates(passed, total)}</span>}
        {failing.length > 0 && (
          <span className="min-w-0 flex-1 basis-48 truncate text-xs text-down" title={failing.join("; ")}>
            failing: {failing.slice(0, 2).join("; ")}
            {failing.length > 2 ? ` and ${failing.length - 2} more` : ""}
          </span>
        )}
        <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => nav.openReview()}>
          <ClipboardCheckIcon /> Open review
        </Button>
      </div>
      {activity && (
        <p className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs text-dim" aria-live="polite">
          <LoaderCircleIcon className="size-3.5 animate-spin text-run" aria-hidden />
          <span className="min-w-0 truncate">{activity}</span>
        </p>
      )}
    </footer>
  );
}
