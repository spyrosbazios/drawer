/**
 * The mock's parts, gates, attempts, assembly and measuring. Geometry is a few boxes per part, derived
 * from the model's parameters, so changing a number (a what-if, set params, the fake agent) changes the
 * measurements and the gates the way the real server would.
 */
import { ASSEMBLY_FILE, LIBRARY_SLUG, PART_DIR, PART_SPEC_SUFFIX, UNWAIVABLE_GATES } from "../../../shared/src/api";
import type {
  AssemblyReport,
  AssemblySpec,
  Attempt,
  CompareResult,
  CompareSide,
  Dimension,
  Feature,
  FeaturesResult,
  GateResult,
  MeasureResult,
  MeshAnalysis,
  ParamValues,
  PartReport,
  PartSpec,
  PartSpecBody,
  PartSummary,
  PrinterProfile,
  ProbeResult,
  Project,
  ProjectStatus,
  RenderRef,
  ReportStatus,
  ScadParam,
  SliceResult,
  Vec3,
  WriteResult,
} from "../../../shared/src/api";
import { bboxOf, box, boxesStl, gapMm, meshInfoOfBoxes, moveBoxes, overlapCm3, perTriangleField, png, round, thicknessOf, volumeCm3 } from "./geometry";
import type { Box } from "./geometry";
import { HttpError, broadcast } from "./http";
import { decoder, encoder, getProject, head, kindOf, now, projects, put, sha, textOf } from "./store";
import type { StoredProject } from "./store";

const isModelPath = (path: string): boolean => {
  const kind = kindOf(path.toLowerCase());
  return kind === "scad" || kind === "mesh";
};

export const PRINTER: PrinterProfile = {
  name: "Prusa MK4 (mock)",
  bed: [250, 210, 220],
  nozzleMm: 0.4,
  layerMm: 0.2,
  minWallMm: 1.2,
  maxOverhangDeg: 45,
  maxOverhangAreaMm2: 100,
  clearance: { sliding: 0.2, press: 0.05 },
};

export const MATERIALS = [
  { name: "PLA", densityGCm3: 1.24, minWallMm: null, notes: "Stiff and easy; creeps above 50 C." },
  { name: "PETG", densityGCm3: 1.27, minWallMm: null, notes: "Tougher than PLA; strings, dry it first." },
  { name: "TPU", densityGCm3: 1.21, minWallMm: 1.6, notes: "Flexible; thicker walls." },
];

const EVAL_MS = Number(process.env.MOCK_EVAL_MS ?? 700);

// ---- model text and parameters ------------------------------------------------------------

/** Top-level `name = number; // [min:step:max]` lines before the first module. */
export function paramsOf(text: string): ScadParam[] {
  const out: ScadParam[] = [];
  let group = "";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(module|function)\b/.test(line)) break;
    const g = /^\s*\/\*\s*\[(.+)\]\s*\*\/\s*$/.exec(line);
    if (g?.[1]) {
      group = g[1];
      continue;
    }
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*(?:\/\/\s*\[([\d.:\s-]+)\])?/.exec(line);
    if (!m?.[1] || m[2] === undefined) continue;
    const range = (m[3] ?? "").split(":").map(Number);
    const above = /^\s*\/\/\s*(.+)$/.exec(lines[i - 1] ?? "")?.[1] ?? "";
    out.push({
      name: m[1],
      type: "number",
      value: Number(m[2]),
      group,
      description: i > 0 && !/^\s*\/\*/.test(lines[i - 1] ?? "") ? above : "",
      min: range.length >= 2 ? (range[0] ?? null) : null,
      max: range.length >= 2 ? (range[range.length - 1] ?? null) : null,
      step: range.length === 3 ? (range[1] ?? null) : null,
      options: null,
      line: i + 1,
    });
  }
  return out;
}

function valuesOf(params: readonly ScadParam[], overrides: ParamValues = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of params) out[p.name] = typeof p.value === "number" ? p.value : 0;
  for (const [k, v] of Object.entries(overrides)) if (typeof v === "number") out[k] = v;
  return out;
}

/** Rewrites parameter values in place; unknown names are an error, like the server. */
export function rewriteParams(text: string, values: ParamValues): string {
  const known = new Set(paramsOf(text).map((p) => p.name));
  for (const name of Object.keys(values)) if (!known.has(name)) throw new HttpError("invalid", `No parameter ${name} in the model`);
  return text
    .split("\n")
    .map((line) => {
      const m = /^(\s*)([A-Za-z_]\w*)(\s*=\s*)(-?\d+(?:\.\d+)?)(\s*;.*)$/.exec(line);
      const v = m?.[2] ? values[m[2]] : undefined;
      return m && typeof v === "number" ? `${m[1]}${m[2]}${m[3]}${v}${m[5]}` : line;
    })
    .join("\n");
}

/** A believable OpenSCAD model with a Customizer block. */
export function modelSource(title: string, params: { name: string; value: number; range: string; note: string }[], body: string): string {
  const block = params.map((p) => `// ${p.note}\n${p.name} = ${p.value}; // [${p.range}]`).join("\n");
  return `// ${title}\n$fn = 64;\n\n/* [Dimensions] */\n${block}\n\nmodule body() {\n${body}\n}\n\nbody();\n`;
}

// ---- shapes ---------------------------------------------------------------------------------

type Shape = (v: Record<string, number>) => Box[];

const n = (v: Record<string, number>, k: string, d: number) => v[k] ?? d;

const SHAPES: Record<string, Shape> = {
  tray: (v) => {
    const w = n(v, "width", 120), d = n(v, "depth", 80), h = n(v, "height", 25), t = n(v, "wall", 2), f = n(v, "floor", 2);
    return [box([0, 0, 0], [w, d, f]), box([0, 0, f], [w, t, h]), box([0, d - t, f], [w, d, h]), box([0, t, f], [t, d - t, h]), box([w - t, t, f], [w, d - t, h])];
  },
  "cable-clip": (v) => {
    const a = n(v, "arm_t", 1.2), s = n(v, "slot", 4.2), h = n(v, "height", 12), back = 4;
    return [box([0, 0, 0], [24, a, h]), box([0, a + s, 0], [24, a + s + back, h]), box([0, 0, h - 3], [24, a + s + back, h])];
  },
  "spool-arm": (v) => [box([0, 0, 0], [n(v, "length", 90), n(v, "width", 12), n(v, "thick", 4)]), box([0, 0, 4], [12, 12, 30])],
  "spool-base": (v) => [box([0, 0, 0], [n(v, "width", 60), n(v, "depth", 60), n(v, "thick", 5)])],
  "spool-axle": (v) => [box([0, 0, 0], [n(v, "diameter", 30), n(v, "diameter", 30), n(v, "length", 70)])],
  "m3x8-screw": () => [box([0, 0, 0], [3, 3, 8]), box([-1.25, -1.25, 8], [4.25, 4.25, 11])],
  "magnet-6x2": () => [box([0, 0, 0], [6, 6, 2])],
};

const shapeOf = (id: string): Shape => SHAPES[id] ?? ((v) => [box([0, 0, 0], [n(v, "width", 20), n(v, "depth", 20), n(v, "height", 20)])]);

// ---- renders ---------------------------------------------------------------------------------

export const meshes = new Map<string, { stl: Uint8Array; fields: Map<string, Uint8Array> }>();
export const previews = new Map<string, Uint8Array>();

/** The same geometry serves measurements and every set of preview views. */
export function renderBoxes(boxes: readonly Box[]): { ref: RenderRef; meshKey: string; thickness: string } {
  const meshKey = sha(encoder.encode(JSON.stringify(boxes))).slice(0, 32);
  const key = sha(encoder.encode(`preview:${meshKey}`)).slice(0, 32);
  if (!meshes.has(meshKey)) {
    const fields = new Map<string, Uint8Array>([["thickness.f32", perTriangleField(boxes.map(thicknessOf))]]);
    meshes.set(meshKey, { stl: boxesStl(boxes), fields });
  }
  if (!previews.has(key)) previews.set(key, png(256, 256, Number.parseInt(key.slice(0, 2), 16)));
  const base = `/api/renders/${key}`;
  const meshBase = `/api/renders/${meshKey}`;
  return {
    ref: { key, mesh: `${meshBase}/mesh.stl`, views: { iso: `${base}/iso.png`, front: `${base}/front.png`, top: `${base}/top.png`, side: `${base}/side.png` }, sheet: `${base}/sheet.png` },
    meshKey,
    thickness: `${meshBase}/thickness.f32`,
  };
}

function analysisOf(boxes: readonly Box[]): MeshAnalysis {
  const bb = bboxOf(boxes);
  const thinnest = boxes.reduce<Box | null>((best, b) => (best === null || thicknessOf(b) < thicknessOf(best) ? b : best), null);
  const area = boxes.reduce((s, b) => {
    const [x, y, z] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    return s + 2 * (x * y + y * z + x * z);
  }, 0);
  const base = boxes.filter((b) => b.min[2] === bb.min[2]).reduce((s, b) => s + (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]), 0);
  return {
    shells: 1,
    watertight: true,
    surfaceAreaMm2: round(area, 1),
    baseAreaMm2: round(base, 1),
    footprintMm2: round(bb.size[0] * bb.size[1], 1),
    overhang: { angle: PRINTER.maxOverhangDeg, areaMm2: 0, at: null },
    wall: thinnest ? { minMm: round(thicknessOf(thinnest)), at: centre(thinnest) } : null,
    thickness: renderBoxes(boxes).thickness,
  };
}

const centre = (b: Box): Vec3 => [round((b.min[0] + b.max[0]) / 2), round((b.min[1] + b.max[1]) / 2), round((b.min[2] + b.max[2]) / 2)];

// ---- specs -----------------------------------------------------------------------------------

const specPath = (id: string) => `${PART_DIR}/${id}${PART_SPEC_SUFFIX}`;
const modelPath = (id: string) => `${PART_DIR}/${id}.scad`;

export function partIds(p: StoredProject): string[] {
  return [...p.files.keys()]
    .filter((k) => k.startsWith(`${PART_DIR}/`) && k.endsWith(PART_SPEC_SUFFIX) && head(p, k))
    .map((k) => k.slice(PART_DIR.length + 1, -PART_SPEC_SUFFIX.length))
    .sort();
}

export function specOf(p: StoredProject, id: string, at?: string): PartSpec {
  const raw = textOf(p, specPath(id), at) ?? textOf(p, specPath(id));
  if (raw === null) throw new HttpError("not_found", `No part ${id}`);
  const s = JSON.parse(raw) as Partial<PartSpec>;
  return {
    title: s.title ?? id,
    class: s.class ?? "",
    description: s.description ?? "",
    source: s.source ?? "printed",
    ...(s.scan ? { scan: s.scan } : {}),
    material: s.material ?? p.meta.defaults.material,
    strictness: s.strictness ?? p.meta.defaults.strictness,
    dimensions: s.dimensions ?? [],
    waivers: s.waivers ?? [],
    prints: s.prints ?? [],
  };
}

function writeSpec(p: StoredProject, id: string, spec: PartSpec, author: string, message: string): void {
  const bytes = encoder.encode(`${JSON.stringify(spec, null, 2)}\n`);
  const res = put(p, specPath(id), bytes, author, message);
  broadcast({ type: "file", action: "written", project: p.meta.slug, path: specPath(id), rev: res.rev, author });
}

// ---- part state: attempts, cached reports, evaluation ------------------------------------------

interface PartState {
  attempts: Attempt[];
  /** The attempt the model currently is (after a restore, an old one). */
  current: string | null;
  report: PartReport | null;
  evaluating: boolean;
}

const states = new Map<string, PartState>();
const stateOf = (slug: string, id: string): PartState => {
  const k = `${slug}/${id}`;
  let s = states.get(k);
  if (!s) {
    s = { attempts: [], current: null, report: null, evaluating: false };
    states.set(k, s);
  }
  return s;
};

const fmt = (x: number) => String(round(x, 2));

function expectedOf(d: Dimension): string {
  if (d.kind === "envelope" && d.box) return `≤ ${d.box.map(fmt).join(" × ")} mm`;
  const unit = d.kind === "volume" ? "cm³" : "mm";
  if (d.nominal !== undefined) return `${fmt(d.nominal)} ± ${fmt(d.tol ?? 0)} ${unit}`;
  if (d.min !== undefined && d.max !== undefined) return `${fmt(d.min)}..${fmt(d.max)} ${unit}`;
  if (d.min !== undefined) return `≥ ${fmt(d.min)} ${unit}`;
  if (d.max !== undefined) return `≤ ${fmt(d.max)} ${unit}`;
  return "-";
}

function inRange(v: number, d: Dimension): boolean {
  if (d.nominal !== undefined) return Math.abs(v - d.nominal) <= (d.tol ?? 0) + 1e-9;
  return (d.min === undefined || v >= d.min - 1e-9) && (d.max === undefined || v <= d.max + 1e-9);
}

const AXES = { x: 0, y: 1, z: 2 } as const;

function dimensionGate(d: Dimension, boxes: readonly Box[], values: Record<string, number>): GateResult {
  const bb = bboxOf(boxes);
  const thinnest = Math.min(...boxes.map(thicknessOf));
  const thinBox = boxes.find((b) => thicknessOf(b) === thinnest) ?? null;
  const base = { id: `dim:${d.id}`, label: d.label, expected: expectedOf(d), detail: null, at: null as Vec3 | null };
  if (d.kind === "envelope") {
    const ok = !d.box || bb.size.every((s, k) => s <= (d.box?.[k] ?? Infinity) + 1e-9);
    return { ...base, status: ok ? "pass" : "fail", measured: `${bb.size.map(fmt).join(" × ")} mm`, hint: ok ? null : "Make the part smaller or relax the envelope.", at: null };
  }
  let v: number;
  let at: Vec3 | null = null;
  switch (d.kind) {
    case "size":
      v = bb.size[AXES[d.axis ?? "z"]];
      break;
    case "hole":
    case "boss":
      v = values[d.id] ?? values.bore ?? d.nominal ?? 0;
      at = d.near && d.axis ? ([d.near[0], d.near[1], d.at ?? 0] as Vec3) : null;
      break;
    case "gap":
      v = values[d.id] ?? values.slot ?? d.nominal ?? 0;
      at = d.from ?? null;
      break;
    case "wall":
      v = values[d.id] ?? thinnest;
      at = d.from ?? null;
      break;
    case "min_wall":
      v = thinnest;
      at = thinBox ? centre(thinBox) : null;
      break;
    case "volume":
      v = volumeCm3(boxes);
      break;
  }
  const ok = inRange(v, d);
  const unit = d.kind === "volume" ? "cm³" : "mm";
  const param = Object.entries(values).find(([, x]) => Math.abs(x - v) < 1e-6)?.[0];
  const target = d.nominal ?? d.min ?? d.max ?? v;
  return {
    ...base,
    status: ok ? "pass" : "fail",
    measured: `${fmt(v)} ${unit}`,
    hint: ok ? null : `${v < target ? "Raise" : "Lower"} ${param ? `\`${param}\`` : "it"} to ${fmt(target)} ${unit}.`,
    at,
  };
}

function gatesOf(spec: PartSpec, text: string, boxes: readonly Box[] | null, values: Record<string, number>): GateResult[] {
  const g = (id: string, label: string, status: GateResult["status"], measured: string | null, expected: string | null, hint: string | null = null, at: Vec3 | null = null, detail: string | null = null): GateResult => ({
    id,
    label,
    status,
    measured,
    expected,
    detail,
    hint,
    at,
  });
  const printed = spec.source === "printed";
  const standard = printed && spec.strictness !== "quick";
  if (!boxes) {
    const out = [g("parses", "Builds", "fail", null, null, "Fix the syntax error the check reports.", null, "Parser error: syntax error in line 1")];
    for (const id of ["solid", "fits_bed", ...spec.dimensions.map((d) => `dim:${d.id}`)]) out.push(g(id, id, "skipped", null, null, null, null, "No mesh: the model does not build."));
    return out;
  }
  const bb = bboxOf(boxes);
  const fits = bb.size[0] <= PRINTER.bed[0] && bb.size[1] <= PRINTER.bed[1] && bb.size[2] <= PRINTER.bed[2];
  const out: GateResult[] = [g("parses", "Builds", "pass", `${boxes.length * 12} triangles`, null), g("solid", "One closed body", "pass", "1 body, watertight", "1 body, watertight")];
  if (printed) out.push(g("fits_bed", "Fits the bed", fits ? "pass" : "fail", `${bb.size.map(fmt).join(" × ")} mm`, `≤ ${PRINTER.bed.join(" × ")} mm`, fits ? null : "Split the part or turn it."));
  out.push(...spec.dimensions.map((d) => dimensionGate(d, boxes, values)));
  if (standard) {
    const linted = text.startsWith("//");
    out.push(g("lint", "Model hygiene", linted ? "pass" : "fail", linted ? "clean" : "no description", null, linted ? null : "Start the file with a // line that says what it is."));
    out.push(g("base", "Flat base", "pass", `${fmt(analysisOf(boxes).baseAreaMm2)} mm²`, "≥ 20 mm²"));
    out.push(g("overhang", "Overhangs", "pass", `0 mm² steeper than ${PRINTER.maxOverhangDeg}°`, `≤ ${PRINTER.maxOverhangAreaMm2} mm²`));
    if (!spec.dimensions.some((d) => d.kind === "min_wall")) {
      const min = MATERIALS.find((m) => m.name === spec.material)?.minWallMm ?? PRINTER.minWallMm;
      const thin = boxes.reduce((a, b) => (thicknessOf(b) < thicknessOf(a) ? b : a));
      const ok = thicknessOf(thin) >= min - 1e-9;
      out.push(g("min_wall", "Minimum wall", ok ? "pass" : "fail", `${fmt(thicknessOf(thin))} mm`, `≥ ${fmt(min)} mm`, ok ? null : `Thicken the wall at ${centre(thin).join(", ")} to ${fmt(min)} mm.`, centre(thin)));
    }
  }
  if (spec.strictness === "functional") for (const x of out) if (x.status === "warn") x.status = "fail";
  for (const x of out) {
    const w = spec.waivers.find((w) => w.gate === x.id);
    if (w && (x.status === "fail" || x.status === "warn")) {
      x.status = "waived";
      x.detail = w.reason;
    }
  }
  return out;
}

function statusOf(gates: readonly GateResult[]): ReportStatus {
  if (gates.some((x) => UNWAIVABLE_GATES.includes(x.id) && x.status === "fail")) return "failed";
  return gates.some((x) => x.status === "fail") ? "draft" : "passed";
}

export function boxesOfPart(slug: string, id: string, at?: string, overrides: ParamValues = {}): Box[] | null {
  const p = getProject(slug);
  const scan = head(p, specPath(id)) ? specOf(p, id, at).scan : undefined;
  if (scan) return head(p, scan.file) ? moveBoxes(boxesOfFile(slug, scan.file, at), scan.translate) : null;
  const text = textOf(p, modelPath(id), at);
  if (text === null || text.includes("FAIL")) return null;
  return shapeOf(id)(valuesOf(paramsOf(text), overrides));
}

/** Measures the part: with `at` as of a revision, with `params` a what-if. Pure: nothing is stored. */
export function computeReport(slug: string, id: string, opts: { at?: string; params?: ParamValues } = {}): PartReport {
  const started = performance.now();
  const p = getProject(slug);
  const spec = specOf(p, id, opts.at);
  const text = spec.scan ? (head(p, spec.scan.file) ? "" : "FAIL") : textOf(p, modelPath(id), opts.at);
  const revisionId = opts.at ?? p.revisions[0]?.id ?? "r0";
  const material = MATERIALS.find((m) => m.name === spec.material);
  const whatIf = opts.params !== undefined && Object.keys(opts.params).length > 0;
  const common = { project: slug, part: id, revisionId, spec, whatIf, evaluatedAt: now() };
  if (text === null) {
    return { ...common, status: "empty", passed: 0, total: 0, gates: [], mesh: null, analysis: null, render: null, params: [], massG: null, next: ["Write the model: parts/" + id + ".scad."], seconds: 0 };
  }
  const params = paramsOf(text);
  const values = valuesOf(params, opts.params);
  const boxes = spec.scan ? boxesOfPart(slug, id, opts.at) : text.includes("FAIL") ? null : shapeOf(id)(values);
  const gates = gatesOf(spec, text, boxes, values).filter((gate) => !spec.scan || gate.id === "parses" || gate.id.startsWith("dim:"));
  const counted = gates.filter((x) => x.status !== "skipped");
  const passed = counted.filter((x) => x.status !== "fail").length;
  return {
    ...common,
    status: statusOf(gates),
    passed,
    total: counted.length,
    gates,
    mesh: boxes ? meshInfoOfBoxes(boxes) : null,
    analysis: boxes ? analysisOf(boxes) : null,
    render: boxes ? renderBoxes(boxes).ref : null,
    params: params.map((x) => (opts.params && typeof opts.params[x.name] === "number" ? { ...x, value: opts.params[x.name] ?? x.value } : x)),
    massG: boxes && material ? round(volumeCm3(boxes) * material.densityGCm3, 1) : null,
    next: gates.filter((x) => x.status === "fail" && x.hint).map((x) => x.hint ?? ""),
    seconds: round((performance.now() - started) / 1000 + 1.2, 2),
  };
}

export function currentReport(slug: string, id: string): PartReport {
  const s = stateOf(slug, id);
  if (!s.report) s.report = computeReport(slug, id);
  return s.report;
}

export function summaryOf(slug: string, id: string): PartSummary {
  const p = getProject(slug);
  const spec = specOf(p, id);
  const s = stateOf(slug, id);
  const r = s.evaluating && !s.report ? null : currentReport(slug, id);
  const modelFile = spec.scan?.file ?? modelPath(id);
  const model = head(p, modelFile) ? modelFile : null;
  const f = p.files.get(model ?? specPath(id));
  return {
    project: slug,
    id,
    title: spec.title,
    class: spec.class,
    source: spec.source,
    material: spec.material,
    strictness: spec.strictness,
    spec: specPath(id),
    model,
    status: r?.status ?? "pending",
    passed: r?.passed ?? 0,
    total: r?.total ?? 0,
    failing: r?.gates.filter((x) => x.status === "fail").map((x) => x.label) ?? [],
    evaluating: s.evaluating,
    printed: spec.prints.at(-1)?.outcome ?? null,
    updatedAt: f?.updatedAt ?? now(),
    updatedBy: f?.updatedBy ?? "system",
  };
}

export const listParts = (slug: string): PartSummary[] => partIds(getProject(slug)).map((id) => summaryOf(slug, id));

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Like the server: `evaluating: true` now, the new report after a while, then the assembly that uses the part. */
export function scheduleEvaluation(slug: string, id: string): void {
  const s = stateOf(slug, id);
  const k = `${slug}/${id}`;
  s.evaluating = true;
  broadcast({ type: "part", project: slug, part: id, evaluating: true, status: s.report?.status ?? null, passed: s.report?.passed ?? 0, total: s.report?.total ?? 0 });
  clearTimeout(pending.get(k));
  pending.set(
    k,
    setTimeout(() => {
      pending.delete(k);
      s.report = computeReport(slug, id);
      s.evaluating = false;
      const attempt = s.attempts.find((a) => a.revisionId === s.current);
      if (attempt) Object.assign(attempt, { status: s.report.status, passed: s.report.passed, total: s.report.total });
      broadcast({ type: "part", project: slug, part: id, evaluating: false, status: s.report.status, passed: s.report.passed, total: s.report.total });
      scheduleAssembly(slug);
    }, EVAL_MS),
  );
}

/** After any write under parts/: a model write is a new attempt, a child of the current one. */
export function onPartFileWritten(slug: string, path: string, revisionId: string, author: string, message: string): string | null {
  if (!path.startsWith(`${PART_DIR}/`)) return null;
  const name = path.slice(PART_DIR.length + 1);
  const id = name.endsWith(".scad") ? name.slice(0, -5) : name.endsWith(PART_SPEC_SUFFIX) ? name.slice(0, -PART_SPEC_SUFFIX.length) : null;
  if (!id || !head(getProject(slug), specPath(id))) return null;
  if (name.endsWith(".scad")) {
    const s = stateOf(slug, id);
    for (const a of s.attempts) a.current = false;
    s.attempts.push({ revisionId, parent: s.current, author, message, date: now(), current: true, status: null, passed: null, total: null });
    s.current = revisionId;
  }
  scheduleEvaluation(slug, id);
  return id;
}

function writeModel(slug: string, id: string, text: string, author: string, message: string): WriteResult {
  const p = getProject(slug);
  const res = put(p, modelPath(id), encoder.encode(text), author, message);
  broadcast({ type: "file", action: res.created ? "written" : "written", project: slug, path: modelPath(id), rev: res.rev, author });
  onPartFileWritten(slug, modelPath(id), res.revisionId, author, message);
  return { project: slug, path: modelPath(id), rev: res.rev, created: res.created, revisionId: res.revisionId, check: { ok: !text.includes("FAIL"), diagnostics: [] }, part: id };
}

/** Seeds a part with a history of model versions: each is an attempt; `parentIndex` makes a branch. */
export function seedPart(slug: string, id: string, spec: Partial<PartSpec> & { title: string }, versions: { text: string; message: string; parentIndex?: number }[], currentIndex?: number): void {
  const p = getProject(slug);
  writeSpec(p, id, { ...specOf_defaults(p, spec) }, "agent", `spec ${id}`);
  const s = stateOf(slug, id);
  versions.forEach((v, i) => {
    const res = put(p, modelPath(id), encoder.encode(v.text), "agent", v.message);
    const parent = v.parentIndex === undefined ? (s.attempts[i - 1]?.revisionId ?? null) : (s.attempts[v.parentIndex]?.revisionId ?? null);
    s.attempts.push({ revisionId: res.revisionId, parent, author: "agent", message: v.message, date: now(), current: false, status: null, passed: null, total: null });
  });
  for (const a of s.attempts) {
    const r = computeReport(slug, id, { at: a.revisionId });
    Object.assign(a, { status: r.status, passed: r.passed, total: r.total });
  }
  const cur = s.attempts[currentIndex ?? s.attempts.length - 1];
  if (cur) {
    // The head file must hold the current attempt's text.
    const text = textOf(p, modelPath(id), cur.revisionId);
    if (text !== null && text !== textOf(p, modelPath(id))) put(p, modelPath(id), encoder.encode(text), "web", `restore ${cur.revisionId}`);
    cur.current = true;
    s.current = cur.revisionId;
  }
  s.report = computeReport(slug, id);
}

function specOf_defaults(p: StoredProject, spec: Partial<PartSpec> & { title: string }): PartSpec {
  return {
    class: "",
    description: "",
    source: "printed",
    material: p.meta.defaults.material,
    strictness: p.meta.defaults.strictness,
    dimensions: [],
    waivers: [],
    prints: [],
    ...spec,
  };
}

export function putPart(slug: string, id: string, body: PartSpecBody, author: string): PartSummary {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new HttpError("invalid", "Invalid part id");
  if (typeof body.title !== "string") throw new HttpError("invalid", "title is required");
  const p = getProject(slug);
  const old = head(p, specPath(id)) ? specOf(p, id) : null;
  writeSpec(p, id, { ...specOf_defaults(p, body), waivers: old?.waivers ?? [], prints: old?.prints ?? [] }, author, `spec ${id}`);
  scheduleEvaluation(slug, id);
  return summaryOf(slug, id);
}

export function deletePart(slug: string, id: string, author: string): string {
  const p = getProject(slug);
  specOf(p, id);
  for (const path of [specPath(id), modelPath(id)]) {
    const f = p.files.get(path);
    if (f && !f.deleted) {
      f.deleted = true;
      broadcast({ type: "file", action: "deleted", project: slug, path, rev: null, author });
    }
  }
  states.delete(`${slug}/${id}`);
  return p.revisions[0]?.id ?? "r0";
}

export function setParams(slug: string, id: string, body: { rev?: string; values?: ParamValues; message?: string }, author: string): WriteResult {
  const p = getProject(slug);
  const current = head(p, modelPath(id));
  if (!current) throw new HttpError("not_found", `Part ${id} has no model`);
  if (body.rev !== current.rev) throw new HttpError("conflict", "The model changed since you read it", current.rev);
  const text = rewriteParams(decoder.decode(current.bytes), body.values ?? {});
  const msg = body.message ?? `set ${Object.entries(body.values ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`;
  return writeModel(slug, id, text, author, msg);
}

/** The fake agent's edit: same as set params, without the rev guard. */
export function agentSetParams(slug: string, id: string, values: ParamValues, message: string): WriteResult {
  const current = textOf(getProject(slug), modelPath(id));
  if (current === null) throw new HttpError("not_found", `Part ${id} has no model`);
  return writeModel(slug, id, rewriteParams(current, values), "agent", message);
}

export function waive(slug: string, id: string, body: { gate?: string; reason?: string }, author: string): PartSummary {
  if (author === "agent") throw new HttpError("forbidden", "Only a person can waive a gate");
  if (!body.gate) throw new HttpError("invalid", "gate is required");
  const p = getProject(slug);
  const spec = specOf(p, id);
  const waivers = spec.waivers.filter((w) => w.gate !== body.gate);
  if (body.reason) waivers.push({ gate: body.gate, reason: body.reason, by: author, at: now() });
  writeSpec(p, id, { ...spec, waivers }, author, body.reason ? `waive ${body.gate}` : `unwaive ${body.gate}`);
  scheduleEvaluation(slug, id);
  return summaryOf(slug, id);
}

export function recordPrint(slug: string, id: string, body: { outcome?: "ok" | "issue"; note?: string; revisionId?: string }, author: string): PartSummary {
  if (body.outcome !== "ok" && body.outcome !== "issue") throw new HttpError("invalid", "outcome must be ok or issue");
  const p = getProject(slug);
  const spec = specOf(p, id);
  const revisionId = body.revisionId ?? stateOf(slug, id).current ?? p.revisions[0]?.id ?? "r0";
  writeSpec(p, id, { ...spec, prints: [...spec.prints, { revisionId, at: now(), outcome: body.outcome, note: body.note ?? "" }] }, author, `printed ${body.outcome}`);
  return summaryOf(slug, id);
}

export function attemptsOf(slug: string, id: string): Attempt[] {
  specOf(getProject(slug), id);
  if (specOf(getProject(slug), id).scan) return [];
  return stateOf(slug, id).attempts.map((a) => ({ ...a }));
}

export function restore(slug: string, id: string, revisionId: string, author: string): WriteResult {
  const p = getProject(slug);
  const s = stateOf(slug, id);
  if (!s.attempts.some((a) => a.revisionId === revisionId)) throw new HttpError("not_found", `No attempt ${revisionId}`);
  const text = textOf(p, modelPath(id), revisionId);
  if (text === null) throw new HttpError("not_found", `No attempt ${revisionId}`);
  const res = put(p, modelPath(id), encoder.encode(text), author, `restore ${revisionId}`);
  broadcast({ type: "file", action: "written", project: slug, path: modelPath(id), rev: res.rev, author });
  for (const a of s.attempts) a.current = a.revisionId === revisionId;
  s.current = revisionId;
  scheduleEvaluation(slug, id);
  return { project: slug, path: modelPath(id), rev: res.rev, created: false, revisionId: res.revisionId, check: { ok: true, diagnostics: [] }, part: id };
}

// ---- comparing and measuring files ----------------------------------------------------------------

/** The boxes of a part (at a revision) or of a file in the project. */
function boxesOfSide(slug: string, side: CompareSide): Box[] {
  const id = side.part ?? (side.path ? /^parts\/([a-z0-9][a-z0-9-]*)\.scad$/.exec(side.path)?.[1] : undefined);
  if (id) {
    const b = boxesOfPart(slug, id, side.at);
    if (!b) throw new HttpError("render_failed", `${id} does not build at ${side.at ?? "the current revision"}`);
    return b;
  }
  if (side.path) return boxesOfFile(slug, side.path, side.at);
  throw new HttpError("invalid", "A side needs a part or a path");
}

export function compare(slug: string, a: CompareSide, b: CompareSide): CompareResult {
  const A = boxesOfSide(slug, a);
  const B = boxesOfSide(slug, b);
  // Per box of B: how much thicker it is than A's box at the same index. Plausible, signed, per triangle.
  const deltas = B.map((bb, i) => {
    const ab = A[i];
    return ab ? round(thicknessOf(bb) - thicknessOf(ab), 3) : round(thicknessOf(bb), 3);
  });
  const ra = renderBoxes(A);
  const rb = renderBoxes(B);
  const name = `deviation-${ra.meshKey}.f32`;
  meshes.get(rb.meshKey)?.fields.set(name, perTriangleField(deltas));
  const abs = deltas.map(Math.abs).sort((x, y) => x - y);
  const worst = deltas.reduce((best, d, i) => (Math.abs(d) > Math.abs(deltas[best] ?? 0) ? i : best), 0);
  const wb = B[worst];
  const ma = meshInfoOfBoxes(A);
  const mb = meshInfoOfBoxes(B);
  return {
    a: { render: ra.ref, mesh: ma },
    b: { render: rb.ref, mesh: mb },
    deviation: {
      min: Math.min(...deltas),
      max: Math.max(...deltas),
      rms: round(Math.sqrt(deltas.reduce((s, d) => s + d * d, 0) / Math.max(1, deltas.length)), 3),
      p95: abs[Math.floor(abs.length * 0.95)] ?? 0,
      at: wb && deltas[worst] !== 0 ? centre(wb) : null,
      field: `/api/renders/${rb.meshKey}/${name}`,
    },
    volumeDeltaCm3: round((mb.volumeCm3 ?? 0) - (ma.volumeCm3 ?? 0), 4),
    sizeDelta: [round(mb.bbox.size[0] - ma.bbox.size[0]), round(mb.bbox.size[1] - ma.bbox.size[1]), round(mb.bbox.size[2] - ma.bbox.size[2])],
  };
}

/** Any .scad or mesh file: a part's model uses its shape, anything else a cube sized from the file. */
export function boxesOfFile(slug: string, path: string, revision?: string): Box[] {
  const p = getProject(slug);
  const id = /^parts\/([a-z0-9][a-z0-9-]*)\.(?:scad|part\.json)$/.exec(path)?.[1];
  if (id) {
    const b = boxesOfPart(slug, id, revision);
    if (!b) throw new HttpError("render_failed", `ERROR: Parser error in file "${path}"`);
    return b;
  }
  const f = p.files.get(path);
  const v = revision ? f?.versions.find((x) => x.revisionId === revision) : head(p, path);
  if (!v) throw new HttpError("not_found", `No file ${path}`);
  if (!isModelPath(path)) throw new HttpError("invalid", "Only .scad and mesh files can be measured");
  const size = Number(/cube\(\s*(?:\[\s*)?(\d+(?:\.\d+)?)/.exec(decoder.decode(v.bytes.subarray(0, 4000)))?.[1] ?? 20);
  return [box([0, 0, 0], [size, size, size])];
}

export function measure(slug: string, path: string, revision?: string): MeasureResult {
  const boxes = boxesOfFile(slug, path, revision);
  return { project: slug, path, mesh: meshInfoOfBoxes(boxes), analysis: analysisOf(boxes), render: renderBoxes(boxes).ref };
}

export function featuresOfFile(slug: string, path: string, revision?: string): FeaturesResult {
  const boxes = boxesOfFile(slug, path, revision);
  const { ref, meshKey } = renderBoxes(boxes);
  const features = boxes.map((b): Feature => ({
    kind: "plane",
    origin: [b.min[0], b.min[1], b.max[2]],
    direction: [0, 0, 1],
    diameter: null, length: null, side: null,
    areaMm2: (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]),
    rms: 0, maxError: 0, coverage: 1,
  })).sort((a, b) => b.areaMm2 - a.areaMm2);
  meshes.get(meshKey)?.fields.set("features.f32", perTriangleField(boxes.map((_, i) => i)));
  return { features, field: `/api/renders/${meshKey}/features.f32`, mesh: ref.mesh };
}

export function slice(slug: string, path: string, axis: "x" | "y" | "z", at: number | null, revision?: string): SliceResult {
  const boxes = boxesOfFile(slug, path, revision);
  const k = AXES[axis];
  const [u, v] = [0, 1, 2].filter((i) => i !== k) as [number, number];
  const contours = boxes
    .filter((b) => at === null || ((b.min[k] ?? 0) <= at && at <= (b.max[k] ?? 0)))
    .map((b) => {
      const min: [number, number] = [b.min[u] ?? 0, b.min[v] ?? 0];
      const max: [number, number] = [b.max[u] ?? 0, b.max[v] ?? 0];
      const c: [number, number] = [round((min[0] + max[0]) / 2), round((min[1] + max[1]) / 2)];
      const w = max[0] - min[0];
      const h = max[1] - min[1];
      return {
        hole: false,
        areaMm2: round(w * h, 2),
        centre: c,
        bbox: { min, max },
        circle: { centre: c, diameter: round(Math.max(w, h)), rms: round(Math.abs(w - h) / 2, 3), round: Math.abs(w - h) < 0.02 * Math.max(w, h) },
        points: [min, [max[0], min[1]], max, [min[0], max[1]]] as [number, number][],
      };
    });
  return { axis, at, contours, open: [] };
}

export function probe(slug: string, path: string, from: Vec3, axis: "x" | "y" | "z", revision?: string): ProbeResult {
  const boxes = boxesOfFile(slug, path, revision);
  const k = AXES[axis];
  const inside = boxes.find((b) => [0, 1, 2].every((i) => (b.min[i] ?? 0) <= (from[i] ?? 0) && (from[i] ?? 0) <= (b.max[i] ?? 0)));
  if (inside) return { inside: true, onSurface: false, distance: round((inside.max[k] ?? 0) - (inside.min[k] ?? 0)), low: inside.min[k] ?? 0, high: inside.max[k] ?? 0 };
  return { inside: false, onSurface: false, distance: null, low: null, high: null };
}

export function section(slug: string, path: string, axis: "x" | "y" | "z", at: number, revision?: string): { axis: "x" | "y" | "z"; at: number; image: string } {
  const { meshKey } = renderBoxes(boxesOfFile(slug, path, revision));
  return { axis, at, image: `/api/renders/${meshKey}/section-${axis}-${at}.png` };
}

// ---- assembly ----------------------------------------------------------------------------------

function assemblySpec(p: StoredProject): AssemblySpec | null {
  const raw = textOf(p, ASSEMBLY_FILE);
  return raw === null ? null : (JSON.parse(raw) as AssemblySpec);
}

const LIB = `${LIBRARY_SLUG}/`;
const resolvePart = (slug: string, ref: string): [string, string] => (ref.startsWith(LIB) ? [LIBRARY_SLUG, ref.slice(LIB.length)] : [slug, ref]);

function rotationMatrix(r: Vec3): number[] {
  const [ax, ay, az] = r.map((d) => (d * Math.PI) / 180) as Vec3;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  // Rz * Ry * Rx, like OpenSCAD's rotate([x, y, z]).
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}

const asmState = new Map<string, { report: AssemblyReport | null; evaluating: boolean }>();

export function computeAssembly(slug: string): AssemblyReport {
  const started = performance.now();
  const p = getProject(slug);
  const spec = assemblySpec(p);
  if (!spec) throw new HttpError("not_found", `${slug} has no assembly`);
  const placed = spec.instances.map((inst) => {
    const [proj, id] = resolvePart(slug, inst.part);
    let summary: PartSummary | null = null;
    try {
      summary = summaryOf(proj, id);
    } catch {
      summary = null;
    }
    const boxes = summary ? boxesOfPart(proj, id) : null;
    return { inst, summary, boxes: boxes ? moveBoxes(boxes, inst.translate) : null, mesh: boxes ? renderBoxes(boxes).ref.mesh : null };
  });
  const pairs: AssemblyReport["pairs"] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (!a?.boxes || !b?.boxes) continue;
      const gap = gapMm(a.boxes, b.boxes);
      const mated = spec.mates.some((m) => (m.a === a.inst.id && m.b === b.inst.id) || (m.a === b.inst.id && m.b === a.inst.id));
      if (gap <= 1 || mated) pairs.push({ a: a.inst.id, b: b.inst.id, gapMm: round(gap, 3), overlapCm3: round(overlapCm3(a.boxes, b.boxes), 4) });
    }
  }
  const gates: GateResult[] = [];
  const g = (id: string, label: string, status: GateResult["status"], measured: string | null, expected: string | null, hint: string | null = null, at: Vec3 | null = null): GateResult => ({ id, label, status, measured, expected, detail: null, hint, at });
  const missing = placed.filter((x) => !x.summary || x.summary.status === "empty" || x.summary.status === "failed");
  const drafts = placed.filter((x) => x.summary?.status === "draft");
  gates.push(
    g(
      "parts",
      "Every part exists and builds",
      missing.length ? "fail" : drafts.length ? "warn" : "pass",
      missing.length ? `${missing.length} missing or failing` : drafts.length ? `${drafts.length} draft` : `${placed.length} placed`,
      "all passed",
      missing.length ? `Model ${missing.map((x) => x.inst.part).join(", ")}.` : drafts.length ? `Finish ${[...new Set(drafts.map((x) => x.inst.part))].join(", ")}.` : null,
    ),
  );
  const press = (a: string, b: string) => spec.mates.some((m) => m.fit === "press" && ((m.a === a && m.b === b) || (m.a === b && m.b === a)));
  const clashes = pairs.filter((x) => (x.overlapCm3 ?? 0) > 0.0005 && !press(x.a, x.b));
  const first = clashes[0];
  const firstBoxes = first ? placed.find((x) => x.inst.id === first.a)?.boxes : undefined;
  gates.push(
    g(
      "clash",
      "No parts overlap",
      clashes.length ? "fail" : "pass",
      clashes.length ? clashes.map((c) => `${c.a} × ${c.b}: ${round((c.overlapCm3 ?? 0) * 1000, 1)} mm³`).join("; ") : "no overlap",
      "≤ 0.5 mm³",
      first ? `Move ${first.b} away from ${first.a}, or mate them as a press fit.` : null,
      firstBoxes ? bboxOf(firstBoxes).max : null,
    ),
  );
  for (const m of spec.mates) {
    const pair = pairs.find((x) => (x.a === m.a && x.b === m.b) || (x.a === m.b && x.b === m.a));
    const gap = pair?.gapMm ?? Infinity;
    const overlap = (pair?.overlapCm3 ?? 0) > 0.0005;
    const ok = m.fit === "press" ? overlap || gap <= 0.05 : m.fit === "contact" ? !overlap && gap <= 0.05 : !overlap && gap >= (m.min ?? 0) && gap <= (m.max ?? Infinity);
    gates.push(g(`mate:${m.id}`, m.label, ok ? "pass" : "fail", overlap ? "overlapping" : `${fmt(gap)} mm`, m.fit === "clearance" ? `${fmt(m.min ?? 0)}..${fmt(m.max ?? 0)} mm` : m.fit, ok ? null : `Adjust ${m.a} or ${m.b} so they ${m.fit === "contact" ? "touch" : "meet the clearance"}.`));
  }
  const floating = placed.length > 1 && placed.filter((x) => x.boxes).some((x) => !pairs.some((pp) => (pp.a === x.inst.id || pp.b === x.inst.id) && pp.gapMm <= 0.5));
  gates.push(g("floating", "Nothing floats", placed.length <= 1 ? "skipped" : floating ? "fail" : "pass", null, "within 0.5 mm of another part"));
  gates.push(g("bom", "Bought parts come from the library", "pass", null, null));
  const counted = gates.filter((x) => x.status !== "skipped");
  const passedN = counted.filter((x) => x.status !== "fail").length;
  const status: ReportStatus = gates.some((x) => x.status === "fail") ? "draft" : "passed";
  const bom = new Map<string, AssemblyReport["bom"][number]>();
  for (const x of placed) {
    const line = bom.get(x.inst.part);
    if (line) line.count++;
    else {
      const density = MATERIALS.find((m) => m.name === x.summary?.material)?.densityGCm3;
      const [proj, id] = resolvePart(slug, x.inst.part);
      const raw = x.summary ? boxesOfPart(proj, id) : null;
      bom.set(x.inst.part, {
        part: x.inst.part,
        title: x.summary?.title ?? x.inst.part,
        count: 1,
        source: x.summary?.source ?? "printed",
        material: x.summary?.source === "printed" ? (x.summary.material ?? null) : null,
        massG: raw && density && x.summary?.source === "printed" ? round(volumeCm3(raw) * density, 1) : null,
      });
    }
  }
  const lines = [...bom.values()];
  const allBoxes = placed.flatMap((x) => x.boxes ?? []);
  return {
    project: slug,
    revisionId: p.revisions[0]?.id ?? "r0",
    status,
    passed: passedN,
    total: counted.length,
    gates,
    spec,
    instances: placed.map((x) => {
      const r = rotationMatrix(x.inst.rotate);
      const t = x.inst.translate;
      return {
        id: x.inst.id,
        part: x.inst.part,
        partStatus: x.summary?.status ?? "empty",
        mesh: x.mesh,
        // Translation is already in the boxes of the clash maths; the viewer gets it in the matrix instead.
        matrix: [r[0] ?? 1, r[1] ?? 0, r[2] ?? 0, t[0], r[3] ?? 0, r[4] ?? 1, r[5] ?? 0, t[1], r[6] ?? 0, r[7] ?? 0, r[8] ?? 1, t[2], 0, 0, 0, 1],
      };
    }),
    pairs,
    bom: lines,
    totalPrintedMassG: lines.some((l) => l.massG !== null) ? round(lines.reduce((s, l) => s + (l.massG ?? 0) * l.count, 0), 1) : null,
    render: allBoxes.length ? (({ key, views, sheet }) => ({ key, views, sheet }))(renderBoxes(allBoxes).ref) : null,
    next: gates.filter((x) => x.status === "fail" && x.hint).map((x) => x.hint ?? ""),
    seconds: round((performance.now() - started) / 1000 + 0.8, 2),
    evaluatedAt: now(),
  };
}

export function currentAssembly(slug: string): AssemblyReport {
  const s = asmState.get(slug) ?? { report: null, evaluating: false };
  asmState.set(slug, s);
  if (!s.report) s.report = computeAssembly(slug);
  return s.report;
}

export function scheduleAssembly(slug: string): void {
  // A library part changing re-evaluates every assembly; others only their own project's.
  const targets = slug === LIBRARY_SLUG ? [...projects.keys()] : [slug];
  for (const t of targets) {
    const p = projects.get(t);
    if (!p || !assemblySpec(p)) continue;
    const s = asmState.get(t) ?? { report: null, evaluating: false };
    asmState.set(t, s);
    s.evaluating = true;
    broadcast({ type: "assembly", project: t, evaluating: true, status: s.report?.status ?? null });
    setTimeout(() => {
      s.report = computeAssembly(t);
      s.evaluating = false;
      broadcast({ type: "assembly", project: t, evaluating: false, status: s.report.status });
    }, EVAL_MS / 2);
  }
}

export function putAssembly(slug: string, spec: AssemblySpec, author: string): AssemblyReport {
  if (typeof spec.title !== "string" || !Array.isArray(spec.instances) || !Array.isArray(spec.mates)) throw new HttpError("invalid", "An assembly needs title, instances and mates");
  const p = getProject(slug);
  const res = put(p, ASSEMBLY_FILE, encoder.encode(`${JSON.stringify(spec, null, 2)}\n`), author, "assembly");
  broadcast({ type: "file", action: "written", project: slug, path: ASSEMBLY_FILE, rev: res.rev, author });
  const s = { report: computeAssembly(slug), evaluating: false };
  asmState.set(slug, s);
  broadcast({ type: "assembly", project: slug, evaluating: false, status: s.report.status });
  return s.report;
}

// ---- project roll-up ------------------------------------------------------------------------------

const WORST: ReportStatus[] = ["failed", "draft", "pending", "passed"];

export function projectStatus(slug: string): ProjectStatus {
  const parts = listParts(slug);
  const p = getProject(slug);
  const asm = assemblySpec(p) ? currentAssembly(slug).status : "none";
  const all: ReportStatus[] = [...parts.map((x) => (x.evaluating ? "pending" : x.status === "empty" ? "draft" : x.status)), ...(asm === "none" ? [] : [asm])];
  const overall: ReportStatus = parts.length === 0 ? "empty" : (WORST.find((w) => all.includes(w)) ?? "passed");
  return {
    parts: parts.length,
    passed: parts.filter((x) => x.status === "passed").length,
    draft: parts.filter((x) => x.status === "draft" || x.status === "empty").length,
    failed: parts.filter((x) => x.status === "failed").length,
    pending: parts.filter((x) => x.evaluating || x.status === "pending").length,
    assembly: asm,
    overall,
  };
}

/** Like the server: `cover` is the effective cover, the chosen file or else a part's model, then any .scad or mesh. */
export function projectOut(p: StoredProject): Project {
  const live = [...p.files.entries()].filter(([, f]) => !f.deleted).map(([path]) => path).sort();
  const auto = live.find((f) => f.startsWith(`${PART_DIR}/`) && f.endsWith(".scad")) ?? live.find((f) => isModelPath(f)) ?? null;
  const cover = p.meta.cover ?? auto;
  return { ...p.meta, cover, thumbnail: cover === null ? null : `/api/projects/${p.meta.slug}/thumbnail/${thumbnailKey(p, cover)}.png`, status: projectStatus(p.meta.slug) };
}

/** Like the server: keyed by what the picture is made of, here the cover's path and rev. */
export const thumbnailKey = (p: StoredProject, cover: string): string => sha(encoder.encode(`${p.meta.slug}\0${cover}\0${head(p, cover)?.rev ?? "-"}`)).slice(0, 32);
