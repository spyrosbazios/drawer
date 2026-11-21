import { UNWAIVABLE_GATES } from "@drawer/shared/api";
import type { Dimension, GateResult, ParamValue, ParamValues, PartReport, ScadParam } from "@drawer/shared/api";
import { formatNumber } from "@/core/format";

// ---- dimensions ----------------------------------------------------------------------------

/** The unit a dimension is measured in. */
export const dimensionUnit = (d: Pick<Dimension, "kind">): string => (d.kind === "volume" ? "cm³" : "mm");

/** What a dimension must be, as a person reads it: "6.4 ± 0.1", "≥ 1.6", "2 – 3", "≤ 30 × 20 × 15". No unit. */
export function formatExpectation(d: Dimension): string {
  if (d.kind === "envelope") return d.box ? `≤ ${d.box.map(formatNumber).join(" × ")}` : "-";
  if (d.nominal !== undefined) return d.tol !== undefined && d.tol > 0 ? `${formatNumber(d.nominal)} ± ${formatNumber(d.tol)}` : formatNumber(d.nominal);
  if (d.min !== undefined && d.max !== undefined) return `${formatNumber(d.min)} – ${formatNumber(d.max)}`;
  if (d.min !== undefined) return `≥ ${formatNumber(d.min)}`;
  if (d.max !== undefined) return `≤ ${formatNumber(d.max)}`;
  return "-";
}

/** A spec dimension next to the gate that measured it (`dim:<id>`), if the report has one. */
export function dimensionRows(report: Pick<PartReport, "spec" | "gates">): { dim: Dimension; gate: GateResult | undefined }[] {
  const byId = new Map(report.gates.map((g) => [g.id, g]));
  return report.spec.dimensions.map((dim) => ({ dim, gate: byId.get(`dim:${dim.id}`) }));
}

// ---- gates ---------------------------------------------------------------------------------

/** Gates a person may waive: the failing and warning ones, except `parses` and `solid`. */
export const isWaivable = (g: GateResult): boolean => (g.status === "fail" || g.status === "warn") && !UNWAIVABLE_GATES.includes(g.id);

export const isFailing = (g: GateResult): boolean => g.status === "fail" || g.status === "warn";

/** Gates of a what-if whose status or measured value differ from the current report, with the current one. */
export function changedGates(current: readonly GateResult[], whatIf: readonly GateResult[]): { gate: GateResult; was: GateResult | undefined }[] {
  const byId = new Map(current.map((g) => [g.id, g]));
  return whatIf.flatMap((gate) => {
    const was = byId.get(gate.id);
    return was && was.status === gate.status && was.measured === gate.measured ? [] : [{ gate, was }];
  });
}

/** The short message "send back to agent" starts from: which gates fail and what they measured. */
export function sendBackMessage(part: string, report: Pick<PartReport, "status" | "passed" | "total" | "gates">): string {
  const failing = report.gates.filter(isFailing);
  if (failing.length === 0) return `Part ${part}: please take another look.`;
  const lines = failing.map((g) => {
    const numbers = g.measured || g.expected ? ` (${g.measured ?? "-"}${g.expected ? `, needs ${g.expected}` : ""})` : "";
    return `- ${g.label}${numbers}`;
  });
  return `Part ${part} is ${report.status} (${report.passed}/${report.total}). Make these gates pass:\n${lines.join("\n")}`;
}

// ---- sections ------------------------------------------------------------------------------

/** The sections of a part review, by the id their fold is remembered under. */
export type ReviewSection = "verdict" | "spec" | "gates" | "params" | "prints" | "next";

/** Which sections start open: the verdict, and whatever needs a person's eye (a failing dimension or gate, open steps). */
export function reviewDefaults(report: Pick<PartReport, "spec" | "gates" | "next">): Record<ReviewSection, boolean> {
  const rows = dimensionRows(report);
  return {
    verdict: true,
    spec: rows.length === 0 || rows.some(({ gate }) => gate !== undefined && isFailing(gate)),
    gates: report.gates.some(isFailing),
    params: false,
    prints: false,
    next: report.next.length > 0,
  };
}

/** What a closed Gates section says: "2 failing", else "7 of 7 pass". `failing` colours it. */
export function gatesSummary(report: Pick<PartReport, "gates" | "passed" | "total">): { text: string; failing: boolean } {
  const failing = report.gates.filter(isFailing).length;
  if (failing > 0) return { text: `${failing} failing`, failing: true };
  return { text: report.total === 0 ? "none" : `${report.passed} of ${report.total} pass`, failing: false };
}

/** What a closed Spec section says: "4 dimensions", or how many of them fail. */
export function specSummary(report: Pick<PartReport, "spec" | "gates">): { text: string; failing: boolean } {
  const rows = dimensionRows(report);
  const failing = rows.filter(({ gate }) => gate !== undefined && isFailing(gate)).length;
  if (failing > 0) return { text: `${failing} of ${rows.length} failing`, failing: true };
  return { text: rows.length === 0 ? "none" : `${rows.length} ${rows.length === 1 ? "dimension" : "dimensions"}`, failing: false };
}

// ---- parameters ----------------------------------------------------------------------------

/** Parameters grouped by their `[Group]`, in file order; ungrouped ones first. */
export function groupParams(params: readonly ScadParam[]): { group: string; params: ScadParam[] }[] {
  const groups = new Map<string, ScadParam[]>();
  for (const p of params) {
    const list = groups.get(p.group);
    if (list) list.push(p);
    else groups.set(p.group, [p]);
  }
  return [...groups].map(([group, list]) => ({ group, params: list })).sort((a, b) => (a.group === "" ? -1 : b.group === "" ? 1 : 0));
}

export function paramEquals(a: ParamValue, b: ParamValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** Only the overrides that differ from the model's current values, for parameters the model still has. */
export function diffParams(params: readonly ScadParam[], overrides: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const p of params) {
    const v = overrides[p.name];
    if (v !== undefined && !paramEquals(v, p.value)) out[p.name] = v;
  }
  return out;
}

/** Number of decimals a step implies (0.1 → 1, 0.25 → 2, 1 → 0). */
export function stepDecimals(step: number | null): number {
  if (step === null || !Number.isFinite(step) || step <= 0) return 3;
  const s = String(step);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Keeps a number inside the parameter's range, rounded to its step's precision. */
export function clampParam(p: Pick<ScadParam, "min" | "max" | "step">, n: number): number {
  let v = n;
  if (p.min !== null) v = Math.max(p.min, v);
  if (p.max !== null) v = Math.min(p.max, v);
  return Number(v.toFixed(stepDecimals(p.step)));
}

/** A typed number as a parameter value; null when it is not a finite number. Range is not enforced here. */
export function parseNumberInput(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (t === "" || t === "-" || t === ".") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Sets one component of a vector value, leaving the others. */
export function setVectorComponent(value: ParamValue, index: number, n: number): number[] {
  const base = Array.isArray(value) ? [...value] : [];
  base[index] = n;
  return base.map((x) => (Number.isFinite(x) ? x : 0));
}

/** A value as shown beside a parameter: "6.4", "true", "[1, 2, 3]", "\"text\"". */
export function formatParamValue(v: ParamValue): string {
  if (Array.isArray(v)) return `[${v.map(formatNumber).join(", ")}]`;
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}
