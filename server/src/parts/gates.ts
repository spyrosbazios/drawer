/**
 * The part gates (docs/SPEC.md → Parts and gates) as pure functions: measurements in, gate results,
 * status and next steps out. Nothing here touches the disk or the renderer.
 */
import { UNWAIVABLE_GATES } from "@drawer/shared/api";
import type { Dimension, GateResult, GateStatus, Material, MeshAnalysis, MeshInfo, PartSpec, PrinterProfile, ReportStatus, ScadParam, Strictness, Vec3 } from "@drawer/shared/api";

/** What was measured for one dimension. `size` for an envelope; `value` otherwise. */
export type DimMeasurement =
  | { ok: true; value: number; at: Vec3 | null }
  | { ok: true; size: Vec3; at: null }
  /** `hint` replaces the generic "make it measurable" when the fix is known. */
  | { ok: false; error: string; hint?: string; at: Vec3 | null };

export interface LintResult {
  /** Hard problems: each fails the gate. */
  problems: string[];
  /** Numeric literals inside modules without an explaining comment. */
  unexplained: number;
  /** Line of the first unexplained literal, for the hint. */
  firstLiteralLine: number | null;
}

/** The analysis the gates read (the thickness field is not needed). */
export type GateAnalysis = Omit<MeshAnalysis, "thickness">;

export interface PartGateInput {
  spec: PartSpec;
  printer: PrinterProfile;
  material: Material | null;
  /** Whether OpenSCAD built a solid; `error` is its first error. */
  build: { ok: true } | { ok: false; error: string };
  mesh: MeshInfo | null;
  analysis: GateAnalysis | null;
  dimensions: Record<string, DimMeasurement>;
  lint: LintResult | null;
}

export const LINT_MAX_FN = 128;
export const LINT_MAX_LITERALS = 6;
export const BASE_MIN_MM2 = 20;
export const BASE_MIN_FRACTION = 0.05;

const RANK: Record<Strictness, number> = { quick: 0, standard: 1, functional: 2 };

export function fmt(n: number, digits = 2): string {
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

const mm = (n: number): string => `${fmt(n)} mm`;
const mm2 = (n: number): string => `${fmt(n, 1)} mm²`;
const vec = (v: Vec3): string => v.map((n) => fmt(n)).join(" × ");
const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

function gate(id: string, label: string, status: GateStatus, fields: Partial<Pick<GateResult, "measured" | "expected" | "detail" | "hint" | "at">> = {}): GateResult {
  return { id, label, status, measured: fields.measured ?? null, expected: fields.expected ?? null, detail: fields.detail ?? null, hint: status === "pass" ? null : (fields.hint ?? null), at: fields.at ?? null };
}

function skipped(id: string, label: string, detail: string): GateResult {
  return gate(id, label, "skipped", { detail });
}

// ---- dimensions ----------------------------------------------------------------------------

/** The accepted range of a dimension, as [low, high] (either may be unbounded). */
export function dimensionRange(d: Dimension): [number, number] {
  if (d.nominal !== undefined) {
    const tol = d.tol ?? 0;
    return [d.nominal - tol, d.nominal + tol];
  }
  return [d.min ?? -Infinity, d.max ?? Infinity];
}

function unit(d: Dimension): string {
  return d.kind === "volume" ? "cm³" : "mm";
}

function rangeText(d: Dimension): string {
  const u = unit(d);
  if (d.nominal !== undefined) return d.tol ? `${fmt(d.nominal)} ± ${fmt(d.tol)} ${u}` : `${fmt(d.nominal)} ${u}`;
  if (d.min !== undefined && d.max !== undefined) return `${fmt(d.min)}–${fmt(d.max)} ${u}`;
  if (d.min !== undefined) return `≥ ${fmt(d.min)} ${u}`;
  return `≤ ${fmt(d.max ?? 0)} ${u}`;
}

function where(d: Dimension): string {
  switch (d.kind) {
    case "size":
      return `the extent along ${d.axis}`;
    case "hole":
      return `the hole cut at ${d.axis} = ${fmt(d.at ?? 0)}`;
    case "boss":
      return `the round outline cut at ${d.axis} = ${fmt(d.at ?? 0)}`;
    case "gap":
      return `the gap through [${vec(d.from ?? [0, 0, 0]).replaceAll(" × ", ", ")}] along ${d.axis}`;
    case "wall":
      return `the wall through [${vec(d.from ?? [0, 0, 0]).replaceAll(" × ", ", ")}] along ${d.axis}`;
    case "min_wall":
      return "the thinnest wall";
    case "volume":
      return "the volume";
    case "envelope":
      return "the bounding box";
  }
}

export function dimensionGate(d: Dimension, m: DimMeasurement | undefined): GateResult {
  const id = `dim:${d.id}`;
  if (m === undefined) return skipped(id, d.label, "not measured: the model did not build");
  if (!m.ok) return gate(id, d.label, "fail", { expected: d.kind === "envelope" ? `≤ ${vec(d.box ?? [0, 0, 0])} mm` : rangeText(d), detail: m.error, hint: m.hint ?? `Make ${where(d)} measurable: ${m.error}`, at: m.at });
  if ("size" in m) {
    const box = d.box ?? [0, 0, 0];
    const over = m.size.map((s, i) => s - (box[i] ?? 0));
    const ok = over.every((o) => o <= 1e-6);
    const worst = over.map((o, i) => ({ o, axis: "xyz"[i] })).filter((x) => x.o > 1e-6);
    return gate(id, d.label, ok ? "pass" : "fail", {
      measured: `${vec(m.size)} mm`,
      expected: `≤ ${vec(box)} mm`,
      hint: `Shrink the part by ${worst.map((w) => `${mm(w.o)} along ${w.axis}`).join(", ")} to fit the ${vec(box)} mm envelope.`,
    });
  }
  const [low, high] = dimensionRange(d);
  const u = unit(d);
  const measured = `${fmt(m.value)} ${u}`;
  const eps = 1e-9;
  if (m.value >= low - eps && m.value <= high + eps) return gate(id, d.label, "pass", { measured, expected: rangeText(d), at: m.at });
  const target = d.nominal ?? (m.value < low ? low : high);
  const delta = target - m.value;
  const verb = delta > 0 ? (d.kind === "hole" || d.kind === "gap" ? "Widen" : "Increase") : d.kind === "hole" || d.kind === "gap" ? "Narrow" : "Reduce";
  return gate(id, d.label, "fail", {
    measured,
    expected: rangeText(d),
    detail: `${fmt(Math.abs(delta))} ${u} ${delta > 0 ? "too small" : "too large"}`,
    hint: `${verb} ${where(d)} by ${fmt(Math.abs(delta))} ${u} (measured ${measured}, needs ${rangeText(d)}).`,
    at: m.at,
  });
}

// ---- lint ----------------------------------------------------------------------------------

/** Numbers that need no explanation in a module body. */
const OBVIOUS = new Set(["0", "1", "2", "0.5", "90", "180", "270", "360", "-1"]);

/** Text-only checks of a model's source. `params` are its Customizer parameters. */
export function lintSource(source: string, params: ScadParam[]): LintResult {
  const problems: string[] = [];
  const lines = source.split("\n");
  if (!/^\s*\/\//.test(lines[0] ?? "")) problems.push("the first line is not a `//` comment saying what the part is");
  if (params.length === 0) problems.push("there is no Customizer parameter (a top-level `name = value;` before the first module)");

  let depth = 0;
  let inModule = false;
  let moduleDepth = 0;
  let unexplained = 0;
  let firstLiteralLine: number | null = null;
  let blockComment = false;
  lines.forEach((raw, i) => {
    let line = raw;
    if (blockComment) {
      const end = line.indexOf("*/");
      if (end < 0) return;
      line = line.slice(end + 2);
      blockComment = false;
    }
    line = line.replace(/\/\*.*?\*\//g, " ");
    const open = line.indexOf("/*");
    if (open >= 0) {
      line = line.slice(0, open);
      blockComment = true;
    }
    const commentAt = line.indexOf("//");
    const explained = commentAt >= 0;
    const code = (explained ? line.slice(0, commentAt) : line).replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (depth === 0) {
      const fn = /^\s*\$fn\s*=\s*([0-9.]+)/.exec(code);
      if (fn?.[1] && Number(fn[1]) > LINT_MAX_FN) problems.push(`top-level $fn = ${fn[1]} on line ${i + 1} is above ${LINT_MAX_FN}`);
      if (/^\s*module\b/.test(code)) {
        inModule = true;
        moduleDepth = 0;
      }
    }
    if (inModule && depth > 0 && !explained) {
      for (const lit of code.replace(/\$fn\s*=\s*[0-9.]+/g, "").match(/(?<![\w.$])-?\d+(?:\.\d+)?(?![\w.])/g) ?? []) {
        if (OBVIOUS.has(lit)) continue;
        unexplained++;
        firstLiteralLine ??= i + 1;
      }
    }
    for (const ch of code) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth = Math.max(0, depth - 1);
        if (inModule && depth === moduleDepth) inModule = false;
      }
    }
  });
  return { problems, unexplained, firstLiteralLine };
}

function lintGate(lint: LintResult): GateResult {
  if (lint.problems.length > 0) {
    return gate("lint", "Model hygiene", "fail", {
      measured: `${lint.problems.length} problem${lint.problems.length > 1 ? "s" : ""}`,
      expected: "description comment, Customizer parameters, $fn ≤ 128",
      detail: lint.problems.join("; "),
      hint: `Fix the source: ${lint.problems.join("; ")}.`,
    });
  }
  if (lint.unexplained > LINT_MAX_LITERALS) {
    return gate("lint", "Model hygiene", "warn", {
      measured: `${lint.unexplained} unexplained numbers in modules`,
      expected: `≤ ${LINT_MAX_LITERALS}`,
      detail: `numeric literals inside modules without a comment${lint.firstLiteralLine === null ? "" : `, first on line ${lint.firstLiteralLine}`}`,
      hint: "Move the magic numbers into named top-level parameters, or explain each with a `//` comment on its line.",
    });
  }
  return gate("lint", "Model hygiene", "pass", { measured: "clean" });
}

// ---- the gate list -------------------------------------------------------------------------

export function minWallRequired(printer: PrinterProfile, material: Material | null): number {
  return material?.minWallMm ?? printer.minWallMm;
}

/** Every gate that applies to the part, in a stable order, with strictness and waivers applied. */
export function partGates(input: PartGateInput): GateResult[] {
  const { spec, printer, mesh, analysis } = input;
  const printed = spec.source === "printed";
  const scanned = spec.source === "scanned";
  const standard = RANK[spec.strictness] >= RANK.standard;
  const built = input.build.ok && mesh !== null;
  const out: GateResult[] = [];

  out.push(
    input.build.ok
      ? mesh && mesh.triangles > 0
        ? gate("parses", "Builds", "pass", { measured: `${mesh.triangles} triangles` })
        : gate("parses", "Builds", "fail", { measured: "empty", expected: "a non-empty solid", detail: "the model evaluates but builds no geometry", hint: "The top level draws nothing: call the part's module, and check that no difference() removes everything." })
      : gate("parses", "Builds", "fail", { expected: "no errors", detail: input.build.error, hint: scanned ? "Check that scan.file points to an uploaded mesh with faces." : `Fix the OpenSCAD error first, nothing else can be measured until it builds: ${input.build.error}` }),
  );
  const solid = built && (mesh?.triangles ?? 0) > 0;

  if (!scanned && (!solid || !analysis)) out.push(skipped("solid", "One closed body", "no mesh to analyse"));
  else if (!scanned && analysis) {
    const ok = analysis.shells === 1 && analysis.watertight;
    const problems = [analysis.shells !== 1 ? `${analysis.shells} separate bodies` : null, analysis.watertight ? null : "not watertight"].filter((p): p is string => p !== null);
    out.push(
      gate("solid", "One closed body", ok ? "pass" : "fail", {
        measured: ok ? "1 body, watertight" : problems.join(", "),
        expected: "1 body, watertight",
        detail: ok ? null : problems.join(", "),
        hint:
          analysis.shells > 1
            ? `The model is ${analysis.shells} separate bodies: union them and make touching pieces overlap by at least 0.01 mm, or delete the stray piece.`
            : "The mesh has open edges: avoid coincident faces in difference()/union() by extending cutters 0.01 mm past the surface.",
      }),
    );
  }

  if (printed) {
    if (!solid || !mesh) out.push(skipped("fits_bed", "Fits the bed", "no mesh to measure"));
    else {
      const [x, y, z] = mesh.bbox.size;
      const [bx, by, bz] = printer.bed;
      const fits = z <= bz && ((x <= bx && y <= by) || (x <= by && y <= bx));
      out.push(
        gate("fits_bed", "Fits the bed", fits ? "pass" : "fail", {
          measured: `${vec(mesh.bbox.size)} mm`,
          expected: `≤ ${vec(printer.bed)} mm`,
          hint: `The part is larger than the ${printer.name} build volume (${vec(printer.bed)} mm): make it smaller or split it into parts that are joined after printing.`,
        }),
      );
    }
  }

  for (const d of input.spec.dimensions) out.push(dimensionGate(d, solid ? input.dimensions[d.id] : undefined));

  if (printed && standard) {
    out.push(input.lint ? lintGate(input.lint) : skipped("lint", "Model hygiene", "no model source"));

    if (!solid || !analysis) out.push(skipped("base", "Flat base", "no mesh to analyse"));
    else {
      const need = Math.max(BASE_MIN_MM2, BASE_MIN_FRACTION * analysis.footprintMm2);
      out.push(
        gate("base", "Flat base", analysis.baseAreaMm2 + 1e-9 >= need ? "pass" : "fail", {
          measured: mm2(analysis.baseAreaMm2),
          expected: `≥ ${mm2(need)} (20 mm² and 5 % of the ${mm2(analysis.footprintMm2)} footprint)`,
          hint: "Give the part a flat face at its lowest z: put the largest flat face down (rotate the model), or flatten the bottom.",
        }),
      );
    }

    if (!solid || !analysis) out.push(skipped("overhang", "Overhangs", "no mesh to analyse"));
    else {
      const over = analysis.overhang.areaMm2 > printer.maxOverhangAreaMm2;
      out.push(
        gate("overhang", "Overhangs", over ? "warn" : "pass", {
          measured: `${mm2(analysis.overhang.areaMm2)} steeper than ${fmt(analysis.overhang.angle)}°`,
          expected: `≤ ${mm2(printer.maxOverhangAreaMm2)}`,
          hint: `Reduce the unsupported overhang${analysis.overhang.at ? ` around [${analysis.overhang.at.map((n) => fmt(n)).join(", ")}]` : ""}: chamfer it to ${fmt(printer.maxOverhangDeg)}° or less from vertical, or turn the part so that face points up.`,
          at: analysis.overhang.at,
        }),
      );
    }

    if (!spec.dimensions.some((d) => d.kind === "min_wall")) {
      const need = minWallRequired(printer, input.material);
      if (!solid || !analysis) out.push(skipped("min_wall", "Minimum wall", "no mesh to analyse"));
      else if (analysis.wall === null) out.push(skipped("min_wall", "Minimum wall", "the mesh is not closed, so wall thickness cannot be measured"));
      else {
        const thin = analysis.wall.minMm + 1e-9 < need;
        out.push(
          gate("min_wall", "Minimum wall", thin ? "fail" : "pass", {
            measured: mm(analysis.wall.minMm),
            expected: `≥ ${mm(need)}`,
            hint: `Thicken the wall around [${analysis.wall.at.map((n) => fmt(n)).join(", ")}] from ${mm(analysis.wall.minMm)} to at least ${mm(need)}.`,
            at: analysis.wall.at,
          }),
        );
      }
    }
  }

  return applyPolicy(out, spec);
}

/** `functional` turns warnings into failures; waivers turn a failure or warning into `waived`, except on the unwaivable gates. */
export function applyPolicy(gates: GateResult[], spec: Pick<PartSpec, "strictness" | "waivers">): GateResult[] {
  return gates.map((g) => {
    let status = g.status;
    if (status === "warn" && spec.strictness === "functional") status = "fail";
    const waiver = UNWAIVABLE_GATES.includes(g.id) ? undefined : spec.waivers.find((w) => w.gate === g.id);
    if (waiver && (status === "fail" || status === "warn")) return { ...g, status: "waived", detail: waiver.reason, hint: null };
    return status === g.status ? g : { ...g, status };
  });
}

// ---- roll-ups ------------------------------------------------------------------------------

export function countGates(gates: GateResult[]): { passed: number; total: number; failing: string[] } {
  const counted = gates.filter((g) => g.status !== "skipped");
  return {
    passed: counted.filter((g) => g.status === "pass" || g.status === "warn" || g.status === "waived").length,
    total: counted.length,
    failing: gates.filter((g) => g.status === "fail").map((g) => g.label),
  };
}

export function partStatus(gates: GateResult[], hasModel: boolean): ReportStatus {
  if (!hasModel) return "empty";
  const failed = (id: string): boolean => gates.some((g) => g.id === id && g.status === "fail");
  if (failed("parses") || failed("solid")) return "failed";
  return gates.some((g) => g.status === "fail") ? "draft" : "passed";
}

/** Fix order: the most important first. */
const PRIORITY = ["parses", "solid", "fits_bed", "dim:", "min_wall", "base", "overhang", "lint"];

function priority(id: string): number {
  const i = PRIORITY.findIndex((p) => (p.endsWith(":") ? id.startsWith(p) : id === p));
  return i < 0 ? PRIORITY.length : i;
}

/** What the agent should do next, most important first; empty when nothing fails. */
export function nextSteps(gates: GateResult[], status: ReportStatus, modelPath: string): string[] {
  if (status === "empty") return [`Write the model at ${modelPath}: a first-line // description, Customizer parameters at the top, then the geometry.`];
  return gates
    .filter((g) => g.status === "fail")
    .sort((a, b) => priority(a.id) - priority(b.id))
    .map((g) => `${g.label}: ${g.hint ?? g.detail ?? "fix this gate"}`);
}

/** The worst of several statuses, for project roll-ups. */
export function worst(statuses: ReportStatus[]): ReportStatus {
  if (statuses.length === 0) return "empty";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("draft") || statuses.includes("empty")) return "draft";
  if (statuses.includes("pending")) return "pending";
  return "passed";
}

export { AXIS_INDEX };
