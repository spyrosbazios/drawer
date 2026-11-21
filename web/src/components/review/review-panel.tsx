import type { GateResult, PartReport } from "@drawer/shared/api";
import { DownloadIcon, FlagIcon, PencilIcon, PrinterIcon, RotateCcwIcon, SendIcon } from "lucide-react";
import { useState } from "react";
import { ErrorView } from "@/components/error-view";
import { GateList } from "@/components/status/gate-list";
import { StatusChip } from "@/components/status/status-chip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMass, formatRelative } from "@/core/format";
import { usePartReport, usePartSummary } from "@/hooks/parts";
import { pointing } from "@/lib/pointing";
import { Fold, Folds, reviewFolds } from "@/components/workspace/folds";
import { MoreMenu, PanelFooter } from "@/components/workspace/panel-footer";
import type { MoreItem } from "@/components/workspace/panel-footer";
import { PrintDialog, SendBackDialog, WaiveDialog } from "./action-dialogs";
import { ParamsSection, useParamEdits } from "./params-section";
import { dimensionRows, dimensionUnit, formatExpectation, gatesSummary, isFailing, isWaivable, reviewDefaults, specSummary } from "./review-model";
import { SpecDialog } from "./spec-dialog";

/**
 * SLOT (feature: part review). The right panel `review` (laptop) and the phone's review sheet, for the
 * selected part. Reads `usePartReport(slug, part)`, `usePartSummary`, `useLibraryProfile`.
 *
 * Renders foldable sections, each saying what it holds when closed (open state is per browser; a failing
 * thing starts open): the verdict (status, set by the server at a revision), the spec (dimensions with their
 * expectation and what was measured), the gates (`GateList`, failing first; locating a gate adds a point to
 * the next message), the parameters (sliders running `useWhatIf`), the prints, and the next steps.
 * Every action sits in a footer pinned below the scrolling sections: send back to the agent (a message with a
 * `part` ref to the current session, or a new one), Apply and Reset while parameters are edited, and in the
 * menu: edit the spec, waive a gate, record a print result, export the mesh.
 * The panel scrolls its sections itself; it is 300 to 640 px wide on a laptop.
 */
export interface ReviewPanelProps {
  slug: string;
  /** Part id of the selected part. */
  part: string;
}

type Dialog = "spec" | "waive" | "print" | "send" | null;

export function ReviewPanel({ slug, part }: ReviewPanelProps) {
  const report = usePartReport(slug, part);
  if (report.isPending) {
    return (
      <div className="space-y-3 p-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (report.isError) return <ErrorView error={report.error} reset={() => void report.refetch()} />;
  return <ReviewBody slug={slug} part={part} report={report.data} />;
}

function ReviewBody({ slug, part, report: r }: { slug: string; part: string; report: PartReport }) {
  const summary = usePartSummary(slug, part);
  const edits = useParamEdits(slug, part, r, summary?.model ?? `parts/${part}.scad`);
  const [dialog, setDialog] = useState<Dialog>(null);
  const evaluating = summary?.evaluating ?? false;
  const close = (open: boolean) => !open && setDialog(null);
  const locate = (g: GateResult) => g.at && pointing.add(slug, { kind: "point", part, position: g.at, normal: null });

  const gates = gatesSummary(r);
  const spec = specSummary(r);
  const lastPrint = r.spec.prints.at(-1);
  const showParams = r.status !== "empty" && r.status !== "failed";
  const sendBack: MoreItem = { key: "send", label: "Send back to agent", icon: SendIcon, onSelect: () => setDialog("send") };
  const more: MoreItem[] = [
    ...(edits.count > 0 ? [sendBack] : []),
    { key: "spec", label: "Edit spec", icon: PencilIcon, onSelect: () => setDialog("spec") },
    { key: "waive", label: "Waive a gate", icon: FlagIcon, disabled: !r.gates.some(isWaivable) && r.spec.waivers.length === 0, onSelect: () => setDialog("waive") },
    { key: "print", label: "Record a print", icon: PrinterIcon, disabled: r.mesh === null && r.spec.prints.length === 0, onSelect: () => setDialog("print") },
    { key: "export", label: "Export STL", icon: DownloadIcon, disabled: !r.render, href: r.render?.mesh, download: `${part}.stl` },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scroll-contain" data-scroll-restoration-id={`panel|review|${slug}|${part}`}>
        <Folds prefs={reviewFolds} defaults={reviewDefaults(r)}>
          <Fold id="verdict" title="Verdict" summary={<StatusChip kind="report" status={r.status} busy={evaluating} label={r.total > 0 ? `${r.status} ${r.passed}/${r.total}` : undefined} />}>
            <Verdict report={r} />
          </Fold>

          <Fold id="spec" title="Spec" summary={spec.text} status={spec.failing ? { kind: "gate", status: "fail" } : undefined}>
            <Spec report={r} />
          </Fold>

          <Fold id="gates" title="Gates" summary={gates.text} status={gates.failing ? { kind: "gate", status: "fail" } : undefined}>
            {r.spec.source !== "printed" && <p className="px-3 pb-2 text-xs text-dim">{r.spec.source === "scanned" ? "Scanned part" : "Bought part"}. No printability gates.</p>}
            {r.gates.length === 0 ? <p className="px-3 text-sm text-dim">None yet.</p> : <GateList gates={r.gates} failingFirst onLocate={locate} expanded={(g) => isFailing(g) || g.status === "waived"} />}
          </Fold>

          {showParams && (
            <Fold id="params" title="Parameters" summary={edits.count > 0 ? <span className="text-run">{edits.count} changed</span> : r.params.length === 0 ? "none" : r.params.length}>
              <ParamsSection report={r} edits={edits} />
            </Fold>
          )}

          {r.spec.prints.length > 0 && (
            <Fold id="prints" title="Prints" summary={lastPrint ? `last ${lastPrint.outcome === "ok" ? "ok" : "issue"}, ${formatRelative(lastPrint.at)}` : undefined} status={lastPrint?.outcome === "ok" ? undefined : { kind: "gate", status: "warn" }}>
              <ul className="space-y-1.5 px-3 text-sm">
                {[...r.spec.prints].reverse().map((p) => (
                  <li key={`${p.revisionId}-${p.at}`}>
                    <span className="font-medium">{p.outcome === "ok" ? "ok" : "issue"}</span> <span className="text-xs text-faint">{formatRelative(p.at)}</span>
                    {p.note && <p className="text-xs text-dim">{p.note}</p>}
                  </li>
                ))}
              </ul>
            </Fold>
          )}

          {r.next.length > 0 && (
            <Fold id="next" title="Next" summary={r.next.length}>
              <ol className="list-decimal space-y-1 pr-3 pl-8 text-sm">
                {r.next.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ol>
            </Fold>
          )}
        </Folds>
      </div>

      <PanelFooter>
        {edits.count > 0 ? (
          <>
            <Button size="sm" onClick={() => void edits.apply()} disabled={edits.applying}>
              {edits.applying ? "Applying" : `Apply ${edits.count}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={edits.reset}>
              <RotateCcwIcon /> Reset
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setDialog("send")}>
            <SendIcon /> Send back
          </Button>
        )}
        <MoreMenu items={more} />
      </PanelFooter>

      <SpecDialog slug={slug} part={part} spec={r.spec} open={dialog === "spec"} onOpenChange={close} />
      <WaiveDialog slug={slug} part={part} report={r} open={dialog === "waive"} onOpenChange={close} />
      <PrintDialog slug={slug} part={part} report={r} open={dialog === "print"} onOpenChange={close} />
      <SendBackDialog slug={slug} part={part} report={r} open={dialog === "send"} onOpenChange={close} />
    </div>
  );
}

function Verdict({ report: r }: { report: PartReport }) {
  const parses = r.gates.find((g) => g.id === "parses");
  return (
    <div className="space-y-2 px-3">
      <p className="text-xs text-faint">
        {formatRelative(r.evaluatedAt)}
        {r.massG !== null && ` · ${formatMass(r.massG)} ${r.spec.material}`}
      </p>
      {r.whatIf && <p className="rounded-md border border-run/40 bg-run/8 px-2 py-1 text-xs text-run">What-if numbers. Nothing is written.</p>}
      {r.status === "empty" && <p className="text-sm text-dim">No model yet.</p>}
      {r.status === "pending" && <p className="text-sm text-dim">Not measured yet.</p>}
      {r.status === "failed" && parses?.status === "fail" && (
        <div className="space-y-1">
          <p className="text-sm text-down">The model does not build.</p>
          {parses.detail && <pre className="max-h-48 overflow-auto rounded-md border border-line bg-raised p-2 font-mono text-[11px] whitespace-pre-wrap text-dim">{parses.detail}</pre>}
        </div>
      )}
    </div>
  );
}

function Spec({ report: r }: { report: PartReport }) {
  const rows = dimensionRows(r);
  const s = r.spec;
  return (
    <>
      <div className="flex flex-wrap gap-1.5 px-3 pb-2 text-xs">
        {s.class && <Tag>{s.class}</Tag>}
        <Tag>{s.material || "no material"}</Tag>
        <Tag>{s.strictness}</Tag>
        <Tag>{s.source}</Tag>
      </div>
      {s.description && <p className="px-3 pb-2 text-xs text-dim">{s.description}</p>}
      {rows.length === 0 ? (
        <p className="px-3 text-sm text-dim">No dimensions.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-faint">
              <th className="py-1 pl-3 font-normal">dimension</th>
              <th className="py-1 font-normal">expected</th>
              <th className="py-1 font-normal">measured</th>
              <th className="py-1 pr-3" aria-label="status" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ dim, gate }) => (
              <tr key={dim.id}>
                <td className="py-1.5 pr-2 pl-3 break-words" title={`${dim.label} (${dim.kind})`}>
                  {dim.label}
                </td>
                <td className="py-1.5 pr-2 text-xs text-dim tabular-nums">
                  {formatExpectation(dim)} <span className="text-faint">{dimensionUnit(dim)}</span>
                </td>
                <td className="py-1.5 pr-2 text-xs tabular-nums">{gate?.measured ?? "-"}</td>
                <td className="py-1.5 pr-3 text-right">{gate && <StatusChip kind="gate" status={gate.status} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const Tag = ({ children }: { children: React.ReactNode }) => <span className="rounded-full border border-line bg-raised px-2 py-0.5 text-dim">{children}</span>;
