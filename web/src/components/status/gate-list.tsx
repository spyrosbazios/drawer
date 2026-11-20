import type { GateResult } from "@drawer/shared/api";
import { CrosshairIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusChip } from "./status-chip";

interface GateRowProps {
  gate: GateResult;
  /** Shows detail and hint under the row. */
  expanded?: boolean;
  /** Offered when the gate has a place (`gate.at`): e.g. fly the viewer there. */
  onLocate?: (gate: GateResult) => void;
  /** Extra controls at the end of the row (waive, ...). */
  actions?: React.ReactNode;
  className?: string;
}

/** One gate: label and status, then what was measured against what was expected on its own line (both can be long); detail and hint when expanded. */
export function GateRow({ gate, expanded = false, onLocate, actions, className }: GateRowProps) {
  const failing = gate.status === "fail" || gate.status === "warn";
  return (
    <li className={cn("flex flex-col gap-1 px-3 py-2", className)}>
      <div className="flex items-start gap-2 text-sm">
        <span className="min-w-0 flex-1 break-words" title={gate.id}>
          {gate.label}
        </span>
        {onLocate && gate.at && (
          <Button variant="ghost" size="icon" className="size-6" aria-label={`Show where: ${gate.label}`} onClick={() => onLocate(gate)}>
            <CrosshairIcon />
          </Button>
        )}
        <StatusChip kind="gate" status={gate.status} />
        {actions}
      </div>
      {(gate.measured || gate.expected) && (
        <p className="break-words text-xs text-dim tabular-nums">
          {gate.measured ?? "-"}
          {gate.expected && <span className="text-faint"> / {gate.expected}</span>}
        </p>
      )}
      {expanded && (gate.detail || (failing && gate.hint)) && (
        <div className="space-y-0.5 text-xs">
          {gate.detail && <p className="text-dim">{gate.detail}</p>}
          {failing && gate.hint && <p className="text-fg">{gate.hint}</p>}
        </div>
      )}
    </li>
  );
}

interface GateListProps {
  gates: readonly GateResult[];
  /** Failing gates first, then the rest in server order. */
  failingFirst?: boolean;
  /** Expanded rows show detail and hint; default: the failing and warning ones. */
  expanded?: (gate: GateResult) => boolean;
  onLocate?: (gate: GateResult) => void;
  actions?: (gate: GateResult) => React.ReactNode;
  className?: string;
}

const RANK: Record<GateResult["status"], number> = { fail: 0, warn: 1, waived: 2, pass: 3, skipped: 4 };

export function GateList({ gates, failingFirst = false, expanded, onLocate, actions, className }: GateListProps) {
  const rows = failingFirst ? [...gates].sort((a, b) => RANK[a.status] - RANK[b.status]) : gates;
  return (
    <ul className={cn("divide-y divide-line", className)}>
      {rows.map((g) => (
        <GateRow key={g.id} gate={g} expanded={expanded ? expanded(g) : g.status === "fail" || g.status === "warn"} onLocate={onLocate} actions={actions?.(g)} />
      ))}
    </ul>
  );
}
