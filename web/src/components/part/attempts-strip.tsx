import type { Attempt } from "@drawer/shared/api";
import { HistoryIcon } from "lucide-react";
import { statusText } from "@/components/status/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative } from "@/core/format";
import { useAttempts } from "@/hooks/parts";
import { useProjectNav } from "@/lib/nav";
import { cn } from "@/lib/utils";
import type { TreeLayout, TreeNode } from "./attempt-tree";

const COL = 92; // px per column
const LANE = 34; // px per lane
const NODE_W = 76;
const NODE_H = 26;

interface Props {
  slug: string;
  part: string;
  layout: TreeLayout;
  /** The attempt on show: the `at` one, or the current. */
  selected: TreeNode | undefined;
  /** The revision compared against (A), if any. */
  compare: string | undefined;
  /** A failed "make current". */
  restoreError: string | null;
}

/** The part's attempts as a compact tree: a click shows that attempt (`at`). The menus' History holds the actions. */
export function AttemptsStrip({ slug, part, layout, selected, compare, restoreError }: Props) {
  const nav = useProjectNav(slug);
  const attempts = useAttempts(slug, part);

  return (
    <section aria-label="Attempts" className="shrink-0 border-t border-line bg-card">
      <header className="flex items-center gap-2 px-3 pt-2 text-xs">
        <HistoryIcon className="size-3.5 text-dim" aria-hidden />
        <span className="font-medium tracking-wide text-dim uppercase">Attempts</span>
        <span className="text-faint">{layout.nodes.length}</span>
      </header>

      <div className="overflow-x-auto overscroll-x-contain px-3 pt-1 pb-2">
        {attempts.isPending ? (
          <Skeleton className="h-8 w-64" />
        ) : attempts.isError ? (
          <p className="py-1 text-xs text-down">{attempts.error.message}</p>
        ) : layout.nodes.length === 0 ? (
          <p className="py-1 text-xs text-dim">No attempts yet: the agent has not written a model.</p>
        ) : (
          <div className="relative" style={{ width: (layout.cols - 1) * COL + NODE_W, height: (layout.lanes - 1) * LANE + NODE_H }}>
            <svg className="absolute inset-0 overflow-visible text-line" width="100%" height="100%" aria-hidden>
              {layout.edges.map((e) => {
                const x1 = e.from.col * COL + NODE_W;
                const y1 = e.from.lane * LANE + NODE_H / 2;
                const x2 = e.to.col * COL;
                const y2 = e.to.lane * LANE + NODE_H / 2;
                return <path key={`${e.from.attempt.revisionId}-${e.to.attempt.revisionId}`} d={`M${x1} ${y1} C${x1 + 10} ${y1} ${x2 - 10} ${y2} ${x2} ${y2}`} fill="none" stroke="currentColor" strokeWidth={1.5} />;
              })}
            </svg>
            {layout.nodes.map((n) => (
              <AttemptNode
                key={n.attempt.revisionId}
                node={n}
                selected={n === selected}
                side={n.attempt.revisionId === compare ? "A" : compare && n === selected ? "B" : null}
                onSelect={() => nav.setAt(n.attempt.current ? undefined : n.attempt.revisionId)}
              />
            ))}
          </div>
        )}
      </div>
      {restoreError && <p className="px-3 pb-2 text-xs text-down">Restore failed: {restoreError}</p>}
    </section>
  );
}

function AttemptNode({ node, selected, side, onSelect }: { node: TreeNode; selected: boolean; side: "A" | "B" | null; onSelect: () => void }) {
  const a: Attempt = node.attempt;
  const tone = a.status ? statusText({ kind: "report", status: a.status }) : "text-faint";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      title={`${node.label} · ${a.message} · ${a.author} · ${formatRelative(a.date)}`}
      className={cn(
        "absolute flex items-center gap-1 rounded-md border px-1.5 text-xs transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected ? "border-brand bg-raised" : "border-line bg-card",
      )}
      style={{ left: node.col * COL, top: node.lane * LANE, width: NODE_W, height: NODE_H }}
    >
      <span className="font-medium">{node.label}</span>
      <span className={cn("tabular-nums", tone)}>{a.passed !== null ? `${a.passed}/${a.total}` : "-"}</span>
      {a.current && <span className="ml-auto size-1.5 rounded-full bg-run" aria-label="current" />}
      {side && <span className="ml-auto rounded bg-fg px-1 text-[10px] leading-4 text-bg">{side}</span>}
    </button>
  );
}
