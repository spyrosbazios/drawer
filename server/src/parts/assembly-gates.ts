/**
 * Assembly maths and gates (docs/SPEC.md → Assembly) as pure functions.
 */
import type { AssemblyInstance, AssemblySpec, BomLine, GateResult, Mate, ReportStatus, Vec3 } from "@drawer/shared/api";
import { LIBRARY_SLUG } from "@drawer/shared/api";
import { fmt } from "./gates.ts";

export const PAIR_DISTANCE_MM = 1;
export const CLASH_MM3 = 0.5;
export const CONTACT_MM = 0.05;
export const FLOATING_MM = 0.5;

export type Matrix = number[];

const rad = (deg: number): number => (deg * Math.PI) / 180;

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r * 4 + c] = (out[r * 4 + c] ?? 0) + (a[r * 4 + k] ?? 0) * (b[k * 4 + c] ?? 0);
  return out;
}

/** 4×4 row-major placement: rotate about x, then y, then z (OpenSCAD `rotate([x,y,z])`), then translate. */
export function placement(rotate: Vec3, translate: Vec3): Matrix {
  const [ax, ay, az] = rotate.map(rad) as Vec3;
  const rx = [1, 0, 0, 0, 0, Math.cos(ax), -Math.sin(ax), 0, 0, Math.sin(ax), Math.cos(ax), 0, 0, 0, 0, 1];
  const ry = [Math.cos(ay), 0, Math.sin(ay), 0, 0, 1, 0, 0, -Math.sin(ay), 0, Math.cos(ay), 0, 0, 0, 0, 1];
  const rz = [Math.cos(az), -Math.sin(az), 0, 0, Math.sin(az), Math.cos(az), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // Column vectors: p' = T · Rz · Ry · Rx · p.
  const r = multiply(rz, multiply(ry, rx));
  const m = r.map((v) => (Math.abs(v) < 1e-12 ? 0 : v));
  m[3] = translate[0];
  m[7] = translate[1];
  m[11] = translate[2];
  return m;
}

export function apply(m: Matrix, p: Vec3): Vec3 {
  const row = (r: number): number => (m[r * 4] ?? 0) * p[0] + (m[r * 4 + 1] ?? 0) * p[1] + (m[r * 4 + 2] ?? 0) * p[2] + (m[r * 4 + 3] ?? 0);
  return [row(0), row(1), row(2)];
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

/** Axis-aligned bounds of a box after a placement. */
export function transformBox(box: Box, m: Matrix): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]];
    const p = apply(m, corner);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, p[k] as number);
      max[k] = Math.max(max[k] as number, p[k] as number);
    }
  }
  return { min, max };
}

/** Distance between two boxes (0 when they touch or overlap). */
export function boxDistance(a: Box, b: Box): number {
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const gap = Math.max(0, (a.min[k] as number) - (b.max[k] as number), (b.min[k] as number) - (a.max[k] as number));
    sum += gap * gap;
  }
  return Math.sqrt(sum);
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Pairs to measure: every mate, plus every pair whose placed boxes come within 1 mm. Only instances with a box take part. */
export function candidatePairs(spec: AssemblySpec, boxes: Map<string, Box>): [string, string][] {
  const out = new Map<string, [string, string]>();
  for (const m of spec.mates) if (boxes.has(m.a) && boxes.has(m.b)) out.set(pairKey(m.a, m.b), [m.a, m.b]);
  const ids = spec.instances.map((i) => i.id).filter((id) => boxes.has(id));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i] as string;
      const b = ids[j] as string;
      if (boxDistance(boxes.get(a) as Box, boxes.get(b) as Box) <= PAIR_DISTANCE_MM) out.set(pairKey(a, b), [a, b]);
    }
  }
  return [...out.values()];
}

export interface PairMeasure {
  a: string;
  b: string;
  gapMm: number;
  overlapCm3: number;
}

export interface InstancePart {
  instance: AssemblyInstance;
  /** Null when the part does not exist. */
  status: ReportStatus | null;
  title: string;
  source: "printed" | "bought";
  material: string | null;
  massG: number | null;
  /** Whether the instance has a mesh to measure (its part built). Only these take part in `floating`. */
  meshed: boolean;
}

export interface AssemblyGateInput {
  spec: AssemblySpec;
  parts: InstancePart[];
  pairs: PairMeasure[];
}

function g(id: string, label: string, status: GateResult["status"], f: Partial<Pick<GateResult, "measured" | "expected" | "detail" | "hint" | "at">> = {}): GateResult {
  return { id, label, status, measured: f.measured ?? null, expected: f.expected ?? null, detail: f.detail ?? null, hint: status === "pass" ? null : (f.hint ?? null), at: f.at ?? null };
}

function findPair(pairs: PairMeasure[], a: string, b: string): PairMeasure | undefined {
  return pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
}

const overlapMm3 = (p: PairMeasure): number => p.overlapCm3 * 1000;

function mateGate(m: Mate, pair: PairMeasure | undefined): GateResult {
  const id = `mate:${m.id}`;
  if (!pair) return g(id, m.label, "skipped", { detail: `${m.a} or ${m.b} has no mesh to measure` });
  const overlap = overlapMm3(pair);
  const measured = overlap > 0 ? `overlap ${fmt(overlap, 3)} mm³` : `gap ${fmt(pair.gapMm, 3)} mm`;
  if (m.fit === "press") {
    const ok = overlap > 0 || pair.gapMm <= CONTACT_MM;
    return g(id, m.label, ok ? "pass" : "fail", { measured, expected: "overlap or touch", hint: `Press fit ${m.a}/${m.b}: close the ${fmt(pair.gapMm, 3)} mm gap so the parts overlap slightly.` });
  }
  if (overlap > 0) return g(id, m.label, "fail", { measured, expected: m.fit === "contact" ? `gap ≤ ${CONTACT_MM} mm, no overlap` : "no overlap", hint: `${m.a} and ${m.b} intersect by ${fmt(overlap, 3)} mm³: move them apart or reduce the mating feature.` });
  if (m.fit === "contact") {
    const ok = pair.gapMm <= CONTACT_MM;
    return g(id, m.label, ok ? "pass" : "fail", { measured, expected: `gap ≤ ${CONTACT_MM} mm`, hint: `Bring ${m.a} and ${m.b} into contact: close the ${fmt(pair.gapMm, 3)} mm gap.` });
  }
  const min = m.min ?? 0;
  const max = m.max ?? Infinity;
  const ok = pair.gapMm >= min - 1e-9 && pair.gapMm <= max + 1e-9;
  const expected = m.max === undefined ? `gap ≥ ${fmt(min, 3)} mm` : `gap ${fmt(min, 3)}–${fmt(max, 3)} mm`;
  const hint = pair.gapMm < min ? `Open the clearance between ${m.a} and ${m.b} by ${fmt(min - pair.gapMm, 3)} mm.` : `Tighten the clearance between ${m.a} and ${m.b} by ${fmt(pair.gapMm - max, 3)} mm.`;
  return g(id, m.label, ok ? "pass" : "fail", { measured, expected, hint });
}

export function assemblyGates(input: AssemblyGateInput): GateResult[] {
  const { spec, parts, pairs } = input;
  const out: GateResult[] = [];

  const missing = parts.filter((p) => p.status === null || p.status === "empty" || p.status === "failed");
  const drafts = parts.filter((p) => p.status === "draft" || p.status === "pending");
  out.push(
    missing.length > 0
      ? g("parts", "Parts are modelled", "fail", {
          measured: `${parts.length - missing.length} of ${parts.length}`,
          expected: "every instance's part exists, has a model and builds",
          detail: missing.map((p) => `${p.instance.id} (${p.instance.part}): ${p.status === null ? "no such part" : p.status === "empty" ? "no model" : "does not build"}`).join("; "),
          hint: `Create or fix ${[...new Set(missing.map((p) => p.instance.part))].join(", ")}.`,
        })
      : drafts.length > 0
        ? g("parts", "Parts are modelled", "warn", { measured: `${drafts.length} not passed yet`, expected: "every part passed", detail: [...new Set(drafts.map((p) => p.instance.part))].join(", "), hint: "Make the draft parts pass their own gates." })
        : g("parts", "Parts are modelled", "pass", { measured: `${parts.length} of ${parts.length}` }),
  );

  const pressed = new Set(spec.mates.filter((m) => m.fit === "press").map((m) => pairKey(m.a, m.b)));
  const clashes = pairs.filter((p) => overlapMm3(p) > CLASH_MM3 && !pressed.has(pairKey(p.a, p.b)));
  out.push(
    clashes.length > 0
      ? g("clash", "No collisions", "fail", {
          measured: clashes.map((p) => `${p.a}/${p.b} ${fmt(overlapMm3(p), 2)} mm³`).join(", "),
          expected: `≤ ${CLASH_MM3} mm³ shared`,
          hint: `Separate the colliding instances (${clashes.map((p) => `${p.a} and ${p.b}`).join("; ")}), or mate them as press if the interference is intended.`,
        })
      : g("clash", "No collisions", "pass", { measured: `${pairs.length} pair${pairs.length === 1 ? "" : "s"} checked` }),
  );

  for (const m of spec.mates) out.push(mateGate(m, findPair(pairs, m.a, m.b)));

  // Instances without a mesh cannot be placed against anything; the `parts` gate already names them.
  const meshed = parts.filter((p) => p.meshed).map((p) => p.instance);
  if (spec.instances.length < 2) out.push(g("floating", "Nothing floats", "skipped", { detail: "a single instance" }));
  else if (meshed.length < 2) out.push(g("floating", "Nothing floats", "skipped", { detail: "fewer than two instances have a mesh" }));
  else {
    const withMesh = new Set(meshed.map((i) => i.id));
    const floating = meshed.filter((i) => !pairs.some((p) => (p.a === i.id || p.b === i.id) && withMesh.has(p.a) && withMesh.has(p.b) && p.gapMm <= FLOATING_MM));
    out.push(
      floating.length > 0
        ? g("floating", "Nothing floats", "fail", {
            measured: floating.map((i) => i.id).join(", "),
            expected: `every instance within ${FLOATING_MM} mm of another`,
            hint: `Move ${floating.map((i) => i.id).join(", ")} into contact with the rest: check its translate and rotate.`,
            at: floating[0]?.translate ?? null,
          })
        : g("floating", "Nothing floats", "pass"),
    );
  }

  const strayBought = [...new Set(parts.filter((p) => p.source === "bought" && !p.instance.part.startsWith(`${LIBRARY_SLUG}/`)).map((p) => p.instance.part))];
  out.push(
    strayBought.length > 0
      ? g("bom", "Bought parts come from the library", "fail", { measured: strayBought.join(", "), expected: "bought parts under _library/", hint: `Move the bought part${strayBought.length > 1 ? "s" : ""} ${strayBought.join(", ")} into the library and refer to ${strayBought.length > 1 ? "them" : "it"} as _library/<id>.` })
      : g("bom", "Bought parts come from the library", "pass"),
  );
  return out;
}

export function assemblyStatus(gates: GateResult[]): ReportStatus {
  if (gates.some((x) => x.id === "parts" && x.status === "fail")) return "failed";
  return gates.some((x) => x.status === "fail") ? "draft" : "passed";
}

export function bom(parts: InstancePart[]): { lines: BomLine[]; totalPrintedMassG: number | null } {
  const lines = new Map<string, BomLine>();
  for (const p of parts) {
    const line = lines.get(p.instance.part);
    if (line) line.count++;
    else lines.set(p.instance.part, { part: p.instance.part, title: p.title, count: 1, source: p.source, material: p.source === "printed" ? p.material : null, massG: p.source === "printed" ? p.massG : null });
  }
  const printed = [...lines.values()].filter((l) => l.source === "printed");
  const total = printed.length === 0 || printed.some((l) => l.massG === null) ? null : printed.reduce((sum, l) => sum + (l.massG ?? 0) * l.count, 0);
  return { lines: [...lines.values()], totalPrintedMassG: total === null ? null : Math.round(total * 100) / 100 };
}

export function assemblyNext(gates: GateResult[]): string[] {
  const order = ["parts", "clash", "mate:", "floating", "bom"];
  const rank = (id: string): number => order.findIndex((o) => (o.endsWith(":") ? id.startsWith(o) : id === o));
  return gates
    .filter((x) => x.status === "fail")
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((x) => `${x.label}: ${x.hint ?? x.detail ?? "fix this gate"}`);
}
