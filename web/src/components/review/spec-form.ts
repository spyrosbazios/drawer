import { DIMENSION_KINDS, PART_SOURCES, isMeshFormat } from "@drawer/shared/api";
import type { Axis, Dimension, DimensionKind, PartSource, PartSpec, PartSpecBody, Strictness } from "@drawer/shared/api";
import { z } from "zod";

/**
 * The edit-spec form keeps every number as the text the person typed, so a half-typed value is never
 * rewritten under them; `specFormSchema` validates it and `formToBody` turns it into the request body.
 */
export const AXES = ["x", "y", "z"] as const satisfies readonly Axis[];
export const STRICTNESS = ["quick", "standard", "functional"] as const satisfies readonly Strictness[];

export const KIND_HELP: Record<DimensionKind, string> = {
  size: "Extent of the bounding box along an axis",
  envelope: "The bounding box must fit inside a box",
  hole: "Diameter of a round opening in a cut",
  boss: "Diameter of a round pin or body in a cut",
  gap: "Free distance through a point in air",
  wall: "Material thickness through a point in material",
  min_wall: "Thinnest wall anywhere in the part",
  volume: "Solid volume, cm³",
};

export type RangeMode = "tol" | "limits";

export interface DimensionForm {
  id: string;
  label: string;
  kind: DimensionKind;
  axis: Axis;
  at: string;
  near: [string, string];
  from: [string, string, string];
  box: [string, string, string];
  range: RangeMode;
  nominal: string;
  tol: string;
  min: string;
  max: string;
}

export interface SpecForm {
  title: string;
  class: string;
  description: string;
  source: PartSource;
  scanFile: string;
  scanRotate: string;
  scanTranslate: string;
  material: string;
  strictness: Strictness;
  dimensions: DimensionForm[];
}

const usesAxis = (k: DimensionKind) => k === "size" || k === "hole" || k === "boss" || k === "gap" || k === "wall";
const usesCut = (k: DimensionKind) => k === "hole" || k === "boss";
const usesPoint = (k: DimensionKind) => k === "gap" || k === "wall";
/** Kinds whose range is nominal ± tol or min/max (envelope has a box, min_wall only a minimum). */
const usesRange = (k: DimensionKind) => k !== "envelope" && k !== "min_wall";

export const dimensionFields = (k: DimensionKind) => ({ axis: usesAxis(k), cut: usesCut(k), point: usesPoint(k), box: k === "envelope", range: usesRange(k), minOnly: k === "min_wall" });

const s = (n: number | undefined): string => (n === undefined ? "" : String(n));

export function newDimension(existing: readonly DimensionForm[]): DimensionForm {
  let i = existing.length + 1;
  while (existing.some((d) => d.id === `dim${i}`)) i++;
  return { id: `dim${i}`, label: "", kind: "size", axis: "z", at: "", near: ["0", "0"], from: ["0", "0", "0"], box: ["", "", ""], range: "tol", nominal: "", tol: "0.1", min: "", max: "" };
}

export function dimensionToForm(d: Dimension): DimensionForm {
  return {
    id: d.id,
    label: d.label,
    kind: d.kind,
    axis: d.axis ?? "z",
    at: s(d.at),
    near: [s(d.near?.[0] ?? 0), s(d.near?.[1] ?? 0)],
    from: [s(d.from?.[0] ?? 0), s(d.from?.[1] ?? 0), s(d.from?.[2] ?? 0)],
    box: [s(d.box?.[0]), s(d.box?.[1]), s(d.box?.[2])],
    range: d.nominal !== undefined ? "tol" : d.min !== undefined || d.max !== undefined ? "limits" : "tol",
    nominal: s(d.nominal),
    tol: s(d.tol),
    min: s(d.min),
    max: s(d.max),
  };
}

export function specToForm(spec: PartSpec): SpecForm {
  return {
    title: spec.title,
    class: spec.class,
    description: spec.description,
    source: spec.source,
    scanFile: spec.scan?.file ?? "",
    scanRotate: spec.scan?.rotate.join(", ") ?? "0, 0, 0",
    scanTranslate: spec.scan?.translate.join(", ") ?? "0, 0, 0",
    material: spec.material,
    strictness: spec.strictness,
    dimensions: spec.dimensions.map(dimensionToForm),
  };
}

/** "" → undefined, otherwise the number (comma accepted as decimal point); NaN when not a number. */
function num(text: string): number | undefined {
  const t = text.trim().replace(",", ".");
  return t === "" ? undefined : Number(t);
}

const ID = /^[a-z0-9][a-z0-9_-]*$/;

const dimensionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(DIMENSION_KINDS),
    axis: z.enum(AXES),
    at: z.string(),
    near: z.tuple([z.string(), z.string()]),
    from: z.tuple([z.string(), z.string(), z.string()]),
    box: z.tuple([z.string(), z.string(), z.string()]),
    range: z.enum(["tol", "limits"]),
    nominal: z.string(),
    tol: z.string(),
    min: z.string(),
    max: z.string(),
  })
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const need = (path: (string | number)[], text: string, opts: { positive?: boolean; nonNegative?: boolean } = {}) => {
      const n = num(text);
      if (n === undefined) issue(path, "Required");
      else if (!Number.isFinite(n)) issue(path, "Not a number");
      else if (opts.positive && n <= 0) issue(path, "Must be above 0");
      else if (opts.nonNegative && n < 0) issue(path, "Must not be negative");
    };
    const optional = (path: (string | number)[], text: string) => {
      const n = num(text);
      if (n !== undefined && !Number.isFinite(n)) issue(path, "Not a number");
    };
    if (!ID.test(d.id)) issue(["id"], "Lower-case letters, digits, - and _");
    if (d.label.trim() === "") issue(["label"], "Say what it is");
    const f = dimensionFields(d.kind);
    if (f.cut) {
      need(["at"], d.at);
      need(["near", 0], d.near[0]);
      need(["near", 1], d.near[1]);
    }
    if (f.point) d.from.forEach((t, i) => need(["from", i], t));
    if (f.box) d.box.forEach((t, i) => need(["box", i], t, { positive: true }));
    if (f.minOnly) need(["min"], d.min, { positive: true });
    if (f.range && d.range === "tol") {
      need(["nominal"], d.nominal);
      optional(["tol"], d.tol);
      const tol = num(d.tol);
      if (tol !== undefined && tol < 0) issue(["tol"], "Must not be negative");
    }
    if (f.range && d.range === "limits") {
      optional(["min"], d.min);
      optional(["max"], d.max);
      const min = num(d.min);
      const max = num(d.max);
      if (min === undefined && max === undefined) issue(["min"], "Give a minimum, a maximum or both");
      if (min !== undefined && max !== undefined && min > max) issue(["max"], "Below the minimum");
    }
  });

export const specFormSchema = z
  .object({
    title: z.string().trim().min(1, "Give the part a title"),
    class: z.string(),
    description: z.string(),
    source: z.enum(PART_SOURCES),
    scanFile: z.string(),
    scanRotate: z.string(),
    scanTranslate: z.string(),
    material: z.string(),
    strictness: z.enum(STRICTNESS),
    dimensions: z.array(dimensionSchema),
  })
  .superRefine((v, ctx) => {
    if (v.source === "scanned") {
      const file = v.scanFile.trim();
      if (!isMeshFormat(file.slice(file.lastIndexOf(".") + 1).toLowerCase())) ctx.addIssue({ code: "custom", path: ["scanFile"], message: "Enter a project mesh path" });
      for (const key of ["scanRotate", "scanTranslate"] as const) {
        const values = v[key].split(",");
        if (values.length !== 3 || values.some((value) => finite(value) === undefined)) ctx.addIssue({ code: "custom", path: [key], message: "Enter three comma-separated numbers" });
      }
    }
    const seen = new Set<string>();
    v.dimensions.forEach((d, i) => {
      if (seen.has(d.id)) ctx.addIssue({ code: "custom", path: ["dimensions", i, "id"], message: "Used twice" });
      seen.add(d.id);
    });
  });

const finite = (text: string): number | undefined => {
  const n = num(text);
  return n !== undefined && Number.isFinite(n) ? n : undefined;
};
const vec3 = (t: [string, string, string]): [number, number, number] => [finite(t[0]) ?? 0, finite(t[1]) ?? 0, finite(t[2]) ?? 0];

/** One dimension as the server takes it: only the fields its kind uses. Assumes the form validated. */
export function formToDimension(d: DimensionForm): Dimension {
  const f = dimensionFields(d.kind);
  const out: Dimension = { id: d.id.trim(), label: d.label.trim(), kind: d.kind };
  if (f.axis) out.axis = d.axis;
  if (f.cut) {
    out.at = finite(d.at) ?? 0;
    out.near = [finite(d.near[0]) ?? 0, finite(d.near[1]) ?? 0];
  }
  if (f.point) out.from = vec3(d.from);
  if (f.box) out.box = vec3(d.box);
  if (f.minOnly) {
    const min = finite(d.min);
    if (min !== undefined) out.min = min;
  }
  if (f.range && d.range === "tol") {
    const nominal = finite(d.nominal);
    const tol = finite(d.tol);
    if (nominal !== undefined) out.nominal = nominal;
    if (tol !== undefined) out.tol = tol;
  }
  if (f.range && d.range === "limits") {
    const min = finite(d.min);
    const max = finite(d.max);
    if (min !== undefined) out.min = min;
    if (max !== undefined) out.max = max;
  }
  return out;
}

export function formToBody(v: SpecForm): PartSpecBody {
  return {
    title: v.title.trim(),
    class: v.class.trim(),
    description: v.description.trim(),
    source: v.source,
    ...(v.source === "scanned" ? { scan: { file: v.scanFile.trim(), rotate: v.scanRotate.split(",").map(Number) as [number, number, number], translate: v.scanTranslate.split(",").map(Number) as [number, number, number] } } : {}),
    material: v.material,
    strictness: v.strictness,
    dimensions: v.dimensions.map(formToDimension),
  };
}
