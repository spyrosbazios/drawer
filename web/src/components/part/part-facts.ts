import type { GateResult, ParamValue, PartReport } from "@drawer/shared/api";

/** The minimum wall a gate asks for, mm: the spec's own `min_wall` dimension, else the `min_wall` gate's expectation. */
export function requiredMinWall(report: Pick<PartReport, "spec" | "gates">): number | null {
  const dim = report.spec.dimensions.find((d) => d.kind === "min_wall");
  if (dim) return dim.min ?? (dim.nominal !== undefined ? dim.nominal - (dim.tol ?? 0) : null);
  const gate = report.gates.find((g) => g.id === "min_wall");
  const m = gate?.expected?.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

const FAILING: ReadonlySet<GateResult["status"]> = new Set(["fail", "warn"]);
export const isFailing = (g: GateResult): boolean => FAILING.has(g.status);

/** Gates that failed and say where. */
export function locatedFailures(gates: readonly GateResult[]): (GateResult & { at: [number, number, number] })[] {
  return gates.filter((g): g is GateResult & { at: [number, number, number] } => isFailing(g) && g.at !== null);
}

export interface ParamChange {
  name: string;
  a: ParamValue | undefined;
  b: ParamValue | undefined;
}

const same = (x: ParamValue | undefined, y: ParamValue | undefined) => JSON.stringify(x) === JSON.stringify(y);

/** Parameters whose values differ between A and B (added or removed ones included), in B's order then A's. */
export function paramChanges(a: Pick<PartReport, "params">, b: Pick<PartReport, "params">): ParamChange[] {
  const av = new Map(a.params.map((p) => [p.name, p.value]));
  const bv = new Map(b.params.map((p) => [p.name, p.value]));
  const names = [...new Set([...b.params.map((p) => p.name), ...a.params.map((p) => p.name)])];
  return names.filter((n) => !same(av.get(n), bv.get(n))).map((name) => ({ name, a: av.get(name), b: bv.get(name) }));
}

export interface GateChange {
  id: string;
  label: string;
  a: GateResult["status"] | null;
  b: GateResult["status"] | null;
}

/** Gates whose status differs between A and B, and how many did not change. */
export function gateChanges(a: Pick<PartReport, "gates">, b: Pick<PartReport, "gates">): { changed: GateChange[]; unchanged: number } {
  const as = new Map(a.gates.map((g) => [g.id, g]));
  const bs = new Map(b.gates.map((g) => [g.id, g]));
  const ids = [...new Set([...b.gates.map((g) => g.id), ...a.gates.map((g) => g.id)])];
  const changed: GateChange[] = [];
  let unchanged = 0;
  for (const id of ids) {
    const ga = as.get(id);
    const gb = bs.get(id);
    if (ga?.status === gb?.status) unchanged++;
    else changed.push({ id, label: gb?.label ?? ga?.label ?? id, a: ga?.status ?? null, b: gb?.status ?? null });
  }
  return { changed, unchanged };
}

export function formatParam(v: ParamValue | undefined): string {
  if (v === undefined) return "none";
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  return String(v);
}
