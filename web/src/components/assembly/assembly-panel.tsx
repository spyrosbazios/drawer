import type { AssemblyReport } from "@drawer/shared/api";
import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon, SendIcon } from "lucide-react";
import { GateList } from "@/components/status/gate-list";
import { StatusChip } from "@/components/status/status-chip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Fold, Folds, assemblyFolds } from "@/components/workspace/folds";
import { MoreMenu, PanelFooter } from "@/components/workspace/panel-footer";
import { formatGates, formatLength, formatMass } from "@/core/format";
import { useAssembly, useEvaluateAssembly } from "@/hooks/assembly";
import { useLibraryParts } from "@/hooks/library";
import { useParts } from "@/hooks/parts";
import { useStartAgent } from "@/hooks/start-agent";
import { cn } from "@/lib/utils";
import { useOpenPart } from "./assembly-actions";
import { bomCsv, clashingPairs, formatOverlap, isPressFit, partHome, partSlots, sendBackMessage } from "./assembly-model";
import { assemblySelection, useAssemblySelection } from "./assembly-selection";

/**
 * SLOT (feature: assembly). The right panel `review` when the assembly is selected.
 * Reads `useAssembly(slug)`, `useParts(slug)`, `useLibraryParts()`.
 *
 * Renders foldable sections like the part review (open state per browser, a failing one starts open): the
 * verdict, the next steps, the parts table (count, source, material, mass, the part's own status, a link), the
 * assembly gates (failing first), every measured pair, the bill of materials. The actions sit in a footer
 * pinned below them: Send back to agent (session message), and in its menu Export BOM (CSV) and Re-evaluate
 * (`useEvaluateAssembly`). Editing placements is the agent's job; a person changes intent through the session.
 */
export interface AssemblyPanelProps {
  slug: string;
}

export function AssemblyPanel({ slug }: AssemblyPanelProps) {
  const q = useAssembly(slug);
  if (q.status === "pending") return <Skeleton className="m-3 h-40" aria-label="Loading assembly" />;
  if (q.status === "error") return <p className="p-3 text-sm text-down">{q.error.message}</p>;
  if (q.data === null) return <p className="p-3 text-sm text-dim">No assembly yet.</p>;
  return <PanelBody slug={slug} report={q.data} />;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function PanelBody({ slug, report }: { slug: string; report: AssemblyReport }) {
  const evaluate = useEvaluateAssembly(slug);
  const agent = useStartAgent(slug);
  const openPart = useOpenPart(slug);
  const parts = useParts(slug);
  const library = useLibraryParts();
  const selected = useAssemblySelection(slug);
  const failingGates = report.gates.filter((g) => g.status === "fail" || g.status === "warn");
  const clashes = clashingPairs(report);
  const slots = partSlots(report.instances);
  const bomByPart = new Map(report.bom.map((b) => [b.part, b]));
  const summaryOf = (part: string) => {
    const h = partHome(part);
    return (h.library ? library.data : parts.data)?.find((p) => p.id === h.id);
  };
  const printed = report.bom.filter((b) => b.source === "printed");
  const bought = report.bom.filter((b) => b.source === "bought");
  const printedPieces = printed.reduce((n, b) => n + b.count, 0);
  const error = evaluate.error;

  const failing = { kind: "gate", status: "fail" } as const;
  const defaults = { verdict: report.status !== "passed", next: report.next.length > 0, parts: true, gates: failingGates.length > 0, pairs: clashes.length > 0, bom: false };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scroll-contain" data-scroll-restoration-id={`panel|assembly|${slug}`}>
        <Folds prefs={assemblyFolds} defaults={defaults}>
          <Fold id="verdict" title="Verdict" summary={<StatusChip kind="report" status={report.status} busy={evaluate.isPending} label={report.total > 0 ? `${report.status} ${report.passed}/${report.total}` : undefined} />}>
            <p className="px-3 text-sm text-dim">
              {formatGates(report.passed, report.total)}
              {report.status === "draft" && failingGates.length > 0 && `. Failing: ${failingGates.map((g) => g.label.toLowerCase()).join(", ")}.`}
            </p>
          </Fold>

          {report.next.length > 0 && (
            <Fold id="next" title="Next" summary={report.next.length}>
              <ul className="list-disc space-y-0.5 pr-3 pl-7 text-sm">
                {report.next.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Fold>
          )}

          <Fold id="parts" title="Parts" summary={slots.size}>
            <ul className="divide-y divide-line">
              {[...slots].map(([part, { slot, count }]) => {
                const s = summaryOf(part);
                const line = bomByPart.get(part);
                const inst = report.instances.filter((i) => i.part === part);
                const on = inst.some((i) => selected.includes(i.id));
                return (
                  <li key={part} className={cn("flex items-center gap-2 px-3 py-1.5 text-sm", on && "bg-raised")}>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: `var(--app-cat${slot + 1})` }} aria-hidden />
                    <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => assemblySelection.set(slug, inst.map((i) => i.id))}>
                      {s?.title ?? line?.title ?? part}
                      <span className="ml-1 text-xs text-faint">{partHome(part).library ? "library" : ""}</span>
                    </button>
                    <span className="text-xs text-dim tabular-nums">×{count}</span>
                    <span className="hidden text-xs text-dim sm:inline">
                      {(line?.source ?? s?.source) === "bought" ? "bought" : `printed${line?.material ? ` · ${line.material}` : ""}${line?.massG != null ? ` · ${formatMass(line.massG)}` : ""}`}
                    </span>
                    <button type="button" onClick={() => openPart(part)} aria-label={`Open ${part}`}>
                      <StatusChip kind="report" status={s?.status ?? inst[0]?.partStatus ?? "pending"} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </Fold>

          <Fold id="gates" title="Gates" summary={failingGates.length > 0 ? `${failingGates.length} failing` : `${report.passed} of ${report.total} pass`} status={failingGates.length > 0 ? failing : undefined}>
            <GateList gates={report.gates} failingFirst />
          </Fold>

          <Fold id="pairs" title="Pairs" summary={clashes.length > 0 ? `${clashes.length} ${clashes.length === 1 ? "clash" : "clashes"}` : report.pairs.length} status={clashes.length > 0 ? failing : undefined}>
            {report.pairs.length === 0 ? (
              <p className="px-3 text-sm text-dim">None within 1 mm.</p>
            ) : (
              <ul className="divide-y divide-line">
                {report.pairs.map((p) => {
                  const clash = clashes.includes(p);
                  const on = selected.length === 2 && selected.includes(p.a) && selected.includes(p.b);
                  return (
                    <li key={`${p.a}|${p.b}`}>
                      <button
                        type="button"
                        onClick={() => assemblySelection.set(slug, on ? [] : [p.a, p.b])}
                        className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm", on && "bg-raised")}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {p.a} × {p.b}
                          {isPressFit(report.spec.mates, p) && <span className="ml-1 text-xs text-faint">press fit</span>}
                        </span>
                        <span className="text-xs text-dim tabular-nums">gap {formatLength(p.gapMm)}</span>
                        <span className={cn("text-xs tabular-nums", clash ? "text-down" : "text-dim")}>{formatOverlap(p.overlapCm3)}</span>
                        {clash && <StatusChip kind="gate" status="fail" label="clash" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Fold>

          <Fold id="bom" title="Bill of materials" summary={printed.length + bought.length > 0 ? `${printedPieces} printed, ${formatMass(report.totalPrintedMassG)}` : "none"}>
            <div className="space-y-2 px-3 text-sm">
              <ul className="space-y-0.5">
                {printed.map((b) => (
                  <li key={b.part} className="flex gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {b.count} × {b.title}
                    </span>
                    <span className="text-dim">{b.material ?? "-"}</span>
                    <span className="w-16 text-right text-dim tabular-nums">{formatMass(b.massG)}</span>
                  </li>
                ))}
              </ul>
              {bought.length > 0 && <p className="text-xs text-dim">Bought: {bought.map((b) => `${b.count} × ${b.title}`).join(", ")}</p>}
            </div>
          </Fold>
        </Folds>
      </div>

      {error && <p className="shrink-0 border-t border-line px-3 py-1.5 text-xs text-down">{error.message}</p>}
      <PanelFooter>
        <Button size="sm" onClick={() => agent.start(sendBackMessage(report))} disabled={agent.pending}>
          {agent.pending ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />} Send back
        </Button>
        <MoreMenu
          items={[
            { key: "bom", label: "Export BOM", icon: DownloadIcon, disabled: report.bom.length === 0, onSelect: () => download(`${slug}-bom.csv`, bomCsv(report.bom, report.totalPrintedMassG)) },
            { key: "evaluate", label: "Re-evaluate", icon: RefreshCwIcon, disabled: evaluate.isPending, onSelect: () => evaluate.mutate() },
          ]}
        />
      </PanelFooter>
    </div>
  );
}
