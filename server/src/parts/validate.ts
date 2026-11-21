/**
 * Validators for the structured files (docs/SPEC.md → Files, revs and writes): part specs,
 * assembly.json and the library's printer.json and materials.json. Each returns the typed value or
 * throws `400 invalid` naming the field.
 */
import type {
  AssemblyInstance,
  AssemblySpec,
  Axis,
  Dimension,
  Mate,
  Material,
  MaterialsFile,
  PartSpec,
  PartSpecBody,
  PrinterProfile,
  PrintResult,
  ProjectDefaults,
  Strictness,
  Vec3,
  Waiver,
} from "@drawer/shared/api";
import { ASSEMBLY_FILE, DIMENSION_KINDS, LIBRARY_SLUG, MATERIALS_FILE, PART_DIR, PART_SPEC_SUFFIX, PRINTER_FILE, UNWAIVABLE_GATES } from "@drawer/shared/api";
import { invalid } from "../errors.ts";

type Obj = Record<string, unknown>;

export const PART_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const STRICTNESS: Strictness[] = ["quick", "standard", "functional"];
const AXES: Axis[] = ["x", "y", "z"];

/** What a project-relative path is, when it is a structured file. */
export type Structured = { kind: "part-spec"; id: string } | { kind: "assembly" } | { kind: "printer" } | { kind: "materials" };

/** Which part a path belongs to: `parts/<id>.scad` or `parts/<id>.part.json`. */
export function partOfPath(path: string): { id: string; file: "model" | "spec" } | null {
  const m = new RegExp(`^${PART_DIR}/([^/]+?)(\\.scad|${PART_SPEC_SUFFIX.replace(".", "\\.")})$`).exec(path);
  if (!m?.[1] || !PART_ID_RE.test(m[1])) return null;
  return { id: m[1], file: m[2] === ".scad" ? "model" : "spec" };
}

export const specPath = (id: string): string => `${PART_DIR}/${id}${PART_SPEC_SUFFIX}`;
export const modelPath = (id: string): string => `${PART_DIR}/${id}.scad`;

export function structuredKind(slug: string, path: string): Structured | null {
  if (path.endsWith(PART_SPEC_SUFFIX)) {
    const part = partOfPath(path);
    if (!part) throw invalid(`a part spec lives at ${PART_DIR}/<id>${PART_SPEC_SUFFIX} with an id matching [a-z0-9][a-z0-9-]*`);
    return { kind: "part-spec", id: part.id };
  }
  if (path === ASSEMBLY_FILE) return { kind: "assembly" };
  if (slug === LIBRARY_SLUG && path === PRINTER_FILE) return { kind: "printer" };
  if (slug === LIBRARY_SLUG && path === MATERIALS_FILE) return { kind: "materials" };
  return null;
}

export function parseJsonFile(bytes: Uint8Array, name: string): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid(`${name} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid(`${name} must be a JSON object`);
  return parsed as Obj;
}

// ---- primitives -----------------------------------------------------------------------------

function obj(value: unknown, field: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${field} must be an object`);
  return value as Obj;
}

function onlyKeys(o: Obj, allowed: readonly string[], field: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw invalid(`${field ? `${field}: ` : ""}unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")}`);
}

function str(o: Obj, key: string, field: string, fallback?: string): string {
  const v = o[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string") throw invalid(`${field}${key} must be a string`);
  return v;
}

function num(o: Obj, key: string, field: string, opts: { min?: number; positive?: boolean } = {}): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(`${field}${key} must be a number`);
  if (opts.positive && v <= 0) throw invalid(`${field}${key} must be greater than 0`);
  if (opts.min !== undefined && v < opts.min) throw invalid(`${field}${key} must be at least ${opts.min}`);
  return v;
}

function optNum(o: Obj, key: string, field: string): number | undefined {
  return o[key] === undefined ? undefined : num(o, key, field);
}

function oneOf<T extends string>(o: Obj, key: string, field: string, values: readonly T[], fallback?: T): T {
  const v = o[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw invalid(`${field}${key} must be one of ${values.join(", ")}`);
  return v as T;
}

function vec3(v: unknown, field: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) throw invalid(`${field} must be [x, y, z] numbers`);
  return [v[0] as number, v[1] as number, v[2] as number];
}

function arr(o: Obj, key: string, field: string): unknown[] {
  const v = o[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw invalid(`${field}${key} must be an array`);
  return v;
}

// ---- part specs ----------------------------------------------------------------------------

function dimension(value: unknown, field: string): Dimension {
  const o = obj(value, field);
  const f = `${field}.`;
  onlyKeys(o, ["id", "label", "kind", "axis", "at", "near", "from", "box", "nominal", "tol", "min", "max"], field);
  const id = str(o, "id", f);
  if (!LOCAL_ID_RE.test(id)) throw invalid(`${f}id must match [a-z0-9][a-z0-9_-]*`);
  const kind = oneOf(o, "kind", f, DIMENSION_KINDS);
  const d: Dimension = { id, label: str(o, "label", f, id), kind };
  const needs = (key: string): void => {
    if (o[key] === undefined) throw invalid(`${f}${key} is required for a ${kind} dimension`);
  };
  if (kind === "size" || kind === "hole" || kind === "boss" || kind === "gap" || kind === "wall") {
    needs("axis");
    d.axis = oneOf(o, "axis", f, AXES);
  } else if (o.axis !== undefined) d.axis = oneOf(o, "axis", f, AXES);
  if (kind === "hole" || kind === "boss") {
    needs("at");
    d.at = num(o, "at", f);
    if (o.near !== undefined) {
      const near = o.near;
      if (!Array.isArray(near) || near.length !== 2 || !near.every((n) => typeof n === "number" && Number.isFinite(n))) throw invalid(`${f}near must be two numbers`);
      d.near = [near[0] as number, near[1] as number];
    }
  }
  if (kind === "gap" || kind === "wall") {
    needs("from");
    d.from = vec3(o.from, `${f}from`);
  }
  if (kind === "envelope") {
    needs("box");
    d.box = vec3(o.box, `${f}box`);
  }
  const nominal = optNum(o, "nominal", f);
  const tol = optNum(o, "tol", f);
  const min = optNum(o, "min", f);
  const max = optNum(o, "max", f);
  if (tol !== undefined && tol < 0) throw invalid(`${f}tol must not be negative`);
  if (tol !== undefined && nominal === undefined) throw invalid(`${f}tol needs nominal`);
  if (nominal !== undefined && (min !== undefined || max !== undefined)) throw invalid(`${f}: give nominal ± tol, or min and/or max, not both`);
  if (min !== undefined && max !== undefined && min > max) throw invalid(`${f}min must not exceed max`);
  if (kind === "min_wall" && min === undefined) throw invalid(`${f}min is required for a min_wall dimension`);
  if (kind !== "envelope" && nominal === undefined && min === undefined && max === undefined) throw invalid(`${f}: a ${kind} dimension needs nominal, min or max`);
  if (nominal !== undefined) d.nominal = nominal;
  if (tol !== undefined) d.tol = tol;
  if (min !== undefined) d.min = min;
  if (max !== undefined) d.max = max;
  return d;
}

function dimensions(o: Obj, field: string): Dimension[] {
  const dims = arr(o, "dimensions", field).map((d, i) => dimension(d, `${field}dimensions[${i}]`));
  const seen = new Set<string>();
  for (const d of dims) {
    if (seen.has(d.id)) throw invalid(`${field}dimensions: duplicate id ${d.id}`);
    seen.add(d.id);
  }
  return dims;
}

function material(o: Obj, field: string, materials: readonly string[], fallback: string, printed = true): string {
  const m = str(o, "material", field, fallback);
  if (printed && materials.length > 0 && !materials.includes(m)) throw invalid(`${field}material must be one of the library's materials: ${materials.join(", ")}`);
  return m;
}

/** The gate a waiver names; `parses` and `solid` cannot be waived. */
export function waivableGate(gate: string, field: string): string {
  if (gate.trim() === "") throw invalid(`${field} must not be empty`);
  if (UNWAIVABLE_GATES.includes(gate)) throw invalid(`${field}: ${gate} cannot be waived: a part that does not build, or is not one closed body, is never acceptable`);
  return gate;
}

function waiver(value: unknown, field: string): Waiver {
  const o = obj(value, field);
  onlyKeys(o, ["gate", "reason", "by", "at"], field);
  const f = `${field}.`;
  const gate = waivableGate(str(o, "gate", f), `${f}gate`);
  return { gate, reason: str(o, "reason", f), by: str(o, "by", f), at: str(o, "at", f) };
}

function printResult(value: unknown, field: string): PrintResult {
  const o = obj(value, field);
  onlyKeys(o, ["revisionId", "at", "outcome", "note"], field);
  const f = `${field}.`;
  return { revisionId: str(o, "revisionId", f), at: str(o, "at", f), outcome: oneOf(o, "outcome", f, ["ok", "issue"] as const), note: str(o, "note", f, "") };
}

/** A whole `parts/<id>.part.json`. */
export function validatePartSpec(value: unknown, materials: readonly string[]): PartSpec {
  const o = obj(value, "spec");
  onlyKeys(o, ["title", "class", "description", "source", "material", "strictness", "dimensions", "waivers", "prints"], "");
  const source = oneOf(o, "source", "", ["printed", "bought"] as const, "printed");
  return {
    title: str(o, "title", ""),
    class: str(o, "class", "", ""),
    description: str(o, "description", "", ""),
    source,
    material: material(o, "", materials, "", source === "printed"),
    strictness: oneOf(o, "strictness", "", STRICTNESS),
    dimensions: dimensions(o, ""),
    waivers: arr(o, "waivers", "").map((w, i) => waiver(w, `waivers[${i}]`)),
    prints: arr(o, "prints", "").map((p, i) => printResult(p, `prints[${i}]`)),
  };
}

/** The body of PUT .../parts/<id>: what a client may set; missing fields take the defaults. */
export function validatePartSpecBody(value: unknown, defaults: ProjectDefaults, materials: readonly string[]): Omit<PartSpec, "waivers" | "prints"> {
  const o = obj(value, "body");
  onlyKeys(o, ["title", "class", "description", "source", "material", "strictness", "dimensions"], "");
  const body: PartSpecBody = { title: str(o, "title", "") };
  if (body.title.trim() === "") throw invalid("title must not be empty");
  const source = oneOf(o, "source", "", ["printed", "bought"] as const, "printed");
  return {
    title: body.title.trim(),
    class: str(o, "class", "", ""),
    description: str(o, "description", "", ""),
    source,
    material: material(o, "", materials, defaults.material, source === "printed"),
    strictness: oneOf(o, "strictness", "", STRICTNESS, defaults.strictness),
    dimensions: dimensions(o, ""),
  };
}

// ---- assembly ------------------------------------------------------------------------------

const ASSEMBLY_PART_RE = /^(_library\/)?[a-z0-9][a-z0-9-]*$/;

export function validateAssembly(value: unknown): AssemblySpec {
  const o = obj(value, "assembly");
  onlyKeys(o, ["title", "instances", "mates"], "");
  const ids = new Set<string>();
  const rawInstances = arr(o, "instances", "");
  if (rawInstances.length === 0) throw invalid("instances must place at least one part");
  const instances = rawInstances.map((v, i): AssemblyInstance => {
    const field = `instances[${i}]`;
    const io = obj(v, field);
    onlyKeys(io, ["id", "part", "translate", "rotate"], field);
    const id = str(io, "id", `${field}.`);
    if (!LOCAL_ID_RE.test(id)) throw invalid(`${field}.id must match [a-z0-9][a-z0-9_-]*`);
    if (ids.has(id)) throw invalid(`${field}.id: duplicate instance id ${id}`);
    ids.add(id);
    const part = str(io, "part", `${field}.`);
    if (!ASSEMBLY_PART_RE.test(part)) throw invalid(`${field}.part must be a part id or _library/<id>`);
    return {
      id,
      part,
      translate: io.translate === undefined ? [0, 0, 0] : vec3(io.translate, `${field}.translate`),
      rotate: io.rotate === undefined ? [0, 0, 0] : vec3(io.rotate, `${field}.rotate`),
    };
  });
  const mateIds = new Set<string>();
  const mates = arr(o, "mates", "").map((v, i): Mate => {
    const field = `mates[${i}]`;
    const f = `${field}.`;
    const mo = obj(v, field);
    onlyKeys(mo, ["id", "label", "a", "b", "fit", "min", "max"], field);
    const id = str(mo, "id", f);
    if (!LOCAL_ID_RE.test(id)) throw invalid(`${f}id must match [a-z0-9][a-z0-9_-]*`);
    if (mateIds.has(id)) throw invalid(`${f}id: duplicate mate id ${id}`);
    mateIds.add(id);
    const a = str(mo, "a", f);
    const b = str(mo, "b", f);
    for (const [k, inst] of [["a", a], ["b", b]] as const) if (!ids.has(inst)) throw invalid(`${f}${k}: no instance ${inst}`);
    if (a === b) throw invalid(`${f}b must differ from a`);
    const fit = oneOf(mo, "fit", f, ["clearance", "contact", "press"] as const);
    const mate: Mate = { id, label: str(mo, "label", f, id), a, b, fit };
    const min = optNum(mo, "min", f);
    const max = optNum(mo, "max", f);
    if (fit === "clearance" && min === undefined && max === undefined) throw invalid(`${f}: a clearance mate needs min and/or max`);
    if (min !== undefined && max !== undefined && min > max) throw invalid(`${f}min must not exceed max`);
    if (min !== undefined) mate.min = min;
    if (max !== undefined) mate.max = max;
    return mate;
  });
  return { title: str(o, "title", "", ""), instances, mates };
}

// ---- library profile -----------------------------------------------------------------------

export function validatePrinter(value: unknown): PrinterProfile {
  const o = obj(value, "printer");
  onlyKeys(o, ["name", "bed", "nozzleMm", "layerMm", "minWallMm", "maxOverhangDeg", "maxOverhangAreaMm2", "clearance"], "");
  const bed = vec3(o.bed, "bed");
  if (bed.some((n) => n <= 0)) throw invalid("bed sizes must be greater than 0");
  const maxOverhangDeg = num(o, "maxOverhangDeg", "", { min: 0 });
  if (maxOverhangDeg > 90) throw invalid("maxOverhangDeg must be at most 90");
  const c = obj(o.clearance, "clearance");
  onlyKeys(c, ["sliding", "press"], "clearance");
  return {
    name: str(o, "name", ""),
    bed,
    nozzleMm: num(o, "nozzleMm", "", { positive: true }),
    layerMm: num(o, "layerMm", "", { positive: true }),
    minWallMm: num(o, "minWallMm", "", { positive: true }),
    maxOverhangDeg,
    maxOverhangAreaMm2: num(o, "maxOverhangAreaMm2", "", { min: 0 }),
    clearance: { sliding: num(c, "sliding", "clearance.", { min: 0 }), press: num(c, "press", "clearance.") },
  };
}

export function validateMaterials(value: unknown): MaterialsFile {
  const o = obj(value, "materials file");
  onlyKeys(o, ["materials"], "");
  const raw = o.materials;
  if (!Array.isArray(raw) || raw.length === 0) throw invalid("materials must be a non-empty array");
  const names = new Set<string>();
  const materials = raw.map((v, i): Material => {
    const field = `materials[${i}]`;
    const f = `${field}.`;
    const mo = obj(v, field);
    onlyKeys(mo, ["name", "densityGCm3", "minWallMm", "notes"], field);
    const name = str(mo, "name", f);
    if (name.trim() === "") throw invalid(`${f}name must not be empty`);
    if (names.has(name)) throw invalid(`${f}name: duplicate material ${name}`);
    names.add(name);
    const minWall = mo.minWallMm;
    if (minWall !== null && minWall !== undefined && (typeof minWall !== "number" || !(minWall > 0))) throw invalid(`${f}minWallMm must be a positive number or null`);
    return { name, densityGCm3: num(mo, "densityGCm3", f, { positive: true }), minWallMm: typeof minWall === "number" ? minWall : null, notes: str(mo, "notes", f, "") };
  });
  return { materials };
}

/** A `defaults` object from a request body. */
export function validateDefaults(value: unknown, materials: readonly string[]): Partial<ProjectDefaults> {
  const o = obj(value, "defaults");
  onlyKeys(o, ["material", "strictness"], "defaults");
  const out: Partial<ProjectDefaults> = {};
  if (o.material !== undefined) out.material = material(o, "defaults.", materials, "");
  if (o.strictness !== undefined) out.strictness = oneOf(o, "strictness", "defaults.", STRICTNESS);
  return out;
}

/** Canonical JSON for comparing and hashing: keys sorted. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

export function prettyJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}
