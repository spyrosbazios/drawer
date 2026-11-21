/**
 * Pure helpers over an `AssemblyReport`: placement matrices, explode offsets, which instances a failing
 * gate touches, mate rows, the BOM as CSV and the "send back" message. No React, no three.js: unit-tested.
 */
import { LIBRARY_SLUG } from "@drawer/shared/api";
import { formatNumber } from "@/core/format";
import type { AssemblyReport, BomLine, GateResult, Mate, Vec3 } from "@drawer/shared/api";

export type AssemblyPair = AssemblyReport["pairs"][number];
export type ReportInstance = AssemblyReport["instances"][number];

/** The clash gate's tolerance: a pair may share up to 0.5 mm³ (SPEC "Assembly"). */
export const CLASH_TOLERANCE_CM3 = 0.0005;

/** A row-major 4x4 (the report's `matrix`) as the column-major array three.js `Matrix4.fromArray` reads. */
export function toColumnMajor(m: readonly number[]): number[] {
  if (m.length !== 16) throw new Error(`a placement matrix has 16 numbers, got ${m.length}`);
  const out = new Array<number>(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = m[r * 4 + c] ?? 0;
  return out;
}

/**
 * How far each instance moves when exploded: away from the assembly's centre (the mean of the instance
 * centres) along its own direction, scaled by `factor` (0 = assembled). An instance at the centre moves up.
 */
export function explodeOffsets(centers: ReadonlyMap<string, Vec3>, factor: number, spread = 1): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  if (centers.size === 0) return out;
  const mid: Vec3 = [0, 0, 0];
  for (const c of centers.values()) {
    mid[0] += c[0] / centers.size;
    mid[1] += c[1] / centers.size;
    mid[2] += c[2] / centers.size;
  }
  for (const [id, c] of centers) {
    const d: Vec3 = [c[0] - mid[0], c[1] - mid[1], c[2] - mid[2]];
    const len = Math.hypot(...d);
    const dir: Vec3 = len < 1e-6 ? [0, 0, 1] : [d[0] / len, d[1] / len, d[2] / len];
    // Distance grows with how far out the instance already is, with a floor so central parts still separate.
    const dist = factor * Math.max(len, spread * 0.25);
    out.set(id, [dir[0] * dist, dir[1] * dist, dir[2] * dist]);
  }
  return out;
}

const samePair = (p: { a: string; b: string }, a: string, b: string) => (p.a === a && p.b === b) || (p.a === b && p.b === a);

/** The measured pair of two instances, in either order. */
export function pairOf(report: Pick<AssemblyReport, "pairs">, a: string, b: string): AssemblyPair | undefined {
  return report.pairs.find((p) => samePair(p, a, b));
}

/** Whether a pair is mated as `press` (exempt from the clash gate). */
export function isPressFit(mates: readonly Mate[], p: { a: string; b: string }): boolean {
  return mates.some((m) => m.fit === "press" && samePair(p, m.a, m.b));
}

/** Pairs that collide: they share more than the tolerance and are not a press fit. */
export function clashingPairs(report: Pick<AssemblyReport, "pairs" | "spec">): AssemblyPair[] {
  return report.pairs.filter((p) => (p.penetration ? p.penetration.depthMm > p.penetration.limitMm : (p.overlapCm3 ?? 0) > CLASH_TOLERANCE_CM3) && !isPressFit(report.spec.mates, p));
}

const failing = (g: GateResult | undefined) => g !== undefined && (g.status === "fail" || g.status === "warn");

export const mateGate = (report: Pick<AssemblyReport, "gates">, mateId: string) => report.gates.find((g) => g.id === `mate:${mateId}`);

/** Pairs (as instance-id couples) behind the failing gates: clashing pairs and failing mates. */
export function failingPairs(report: Pick<AssemblyReport, "pairs" | "spec" | "gates">): { a: string; b: string; why: string }[] {
  const out: { a: string; b: string; why: string }[] = [];
  for (const p of clashingPairs(report)) out.push({ a: p.a, b: p.b, why: "clash" });
  for (const m of report.spec.mates) {
    if (failing(mateGate(report, m.id)) && !out.some((o) => samePair(o, m.a, m.b))) out.push({ a: m.a, b: m.b, why: `mate:${m.id}` });
  }
  return out;
}

/** Every instance in a failing pair: what the Clashes mode draws in the danger colour. */
export function failingInstances(report: Pick<AssemblyReport, "pairs" | "spec" | "gates">): Set<string> {
  const ids = new Set<string>();
  for (const p of failingPairs(report)) {
    ids.add(p.a);
    ids.add(p.b);
  }
  return ids;
}

/** What a mate requires, in words. */
export function mateExpected(m: Mate): string {
  switch (m.fit) {
    case "contact":
      return "contact (gap ≤ 0.05 mm)";
    case "press":
      return "press (overlap or touch)";
    case "clearance":
      if (m.min !== undefined && m.max !== undefined) return `gap ${m.min}–${m.max} mm`;
      if (m.min !== undefined) return `gap ≥ ${m.min} mm`;
      if (m.max !== undefined) return `gap ≤ ${m.max} mm`;
      return "clearance";
  }
}

export interface MateRow {
  mate: Mate;
  expected: string;
  pair: AssemblyPair | undefined;
  gate: GateResult | undefined;
}

export function mateRows(report: Pick<AssemblyReport, "pairs" | "spec" | "gates">): MateRow[] {
  return report.spec.mates.map((mate) => ({ mate, expected: mateExpected(mate), pair: pairOf(report, mate.a, mate.b), gate: mateGate(report, mate.id) }));
}

const LIB_PREFIX = `${LIBRARY_SLUG}/`;

/** Where a part id of an assembly lives: this project, or the library ("_library/<id>"). */
export function partHome(part: string): { library: boolean; id: string } {
  return part.startsWith(LIB_PREFIX) ? { library: true, id: part.slice(LIB_PREFIX.length) } : { library: false, id: part };
}

/** Distinct parts in placement order, each with its palette slot (0..5) and instance count. */
export function partSlots(instances: readonly { part: string }[]): Map<string, { slot: number; count: number }> {
  const out = new Map<string, { slot: number; count: number }>();
  for (const i of instances) {
    const have = out.get(i.part);
    if (have) have.count++;
    else out.set(i.part, { slot: out.size % 6, count: 1 });
  }
  return out;
}

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The bill of materials as CSV (RFC 4180): one row per line, then the total printed mass. */
export function bomCsv(bom: readonly BomLine[], totalPrintedMassG: number | null): string {
  const rows: (string | number | null)[][] = [["part", "title", "count", "source", "material", "mass_g_each", "mass_g_total"]];
  for (const l of bom) rows.push([l.part, l.title, l.count, l.source, l.material, l.massG, l.massG === null ? null : Math.round(l.massG * l.count * 100) / 100]);
  if (totalPrintedMassG !== null) rows.push(["", "total printed", null, null, null, null, totalPrintedMassG]);
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** A short message for the agent naming the failing gates and the failing pairs. */
export function sendBackMessage(report: Pick<AssemblyReport, "pairs" | "spec" | "gates">): string {
  const gates = report.gates.filter(failing);
  const pairs = failingPairs(report);
  if (gates.length === 0 && pairs.length === 0) return "Please review the assembly: every gate passes. Check it is what the brief asks for.";
  const lines = ["The assembly does not pass yet. Please fix:"];
  for (const g of gates) lines.push(`- ${g.label} (${g.id}): ${g.status}${g.measured ? `, measured ${g.measured}` : ""}${g.expected ? `, expected ${g.expected}` : ""}`);
  for (const p of pairs) {
    const m = pairOf(report, p.a, p.b);
    lines.push(`- pair ${p.a} × ${p.b}${m ? `: gap ${fmt(m.gapMm)} mm, ${formatOverlap(m.overlapCm3, m.penetration)}` : ""}`);
  }
  return lines.join("\n");
}

/** Shared volume of a pair, in mm³: clash-sized overlaps vanish when written in cm³. */
export function formatOverlap(cm3: number | null, penetration?: AssemblyReport["pairs"][number]["penetration"]): string {
  if (penetration) return `${formatNumber(penetration.depthMm)} mm behind (limit ${formatNumber(penetration.limitMm)} mm)`;
  return cm3 === null ? "—" : `${formatNumber(cm3 * 1000)} mm³`;
}
