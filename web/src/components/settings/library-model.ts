import type { Material, MaterialsFile, PrinterProfile } from "@drawer/shared/api";
import { z } from "zod";

/**
 * The library's structured files edited as forms. Numbers are kept as typed text; the schemas validate
 * them and the converters write the JSON the server validates again.
 */

export interface PrinterField {
  key: "nozzleMm" | "layerMm" | "minWallMm" | "maxOverhangDeg" | "maxOverhangAreaMm2" | "sliding" | "press";
  label: string;
  unit: string;
}

export const PRINTER_FIELDS: readonly PrinterField[] = [
  { key: "nozzleMm", label: "Nozzle", unit: "mm" },
  { key: "layerMm", label: "Layer height", unit: "mm" },
  { key: "minWallMm", label: "Minimum wall", unit: "mm" },
  { key: "maxOverhangDeg", label: "Max overhang", unit: "°" },
  { key: "maxOverhangAreaMm2", label: "Overhang area allowed", unit: "mm²" },
  { key: "sliding", label: "Sliding clearance", unit: "mm" },
  { key: "press", label: "Press-fit clearance", unit: "mm" },
];

export interface PrinterForm {
  name: string;
  bed: [string, string, string];
  nozzleMm: string;
  layerMm: string;
  minWallMm: string;
  maxOverhangDeg: string;
  maxOverhangAreaMm2: string;
  sliding: string;
  press: string;
}

export interface MaterialForm {
  name: string;
  densityGCm3: string;
  minWallMm: string;
  notes: string;
}

const toNum = (t: string): number => Number(t.trim().replace(",", "."));
const isNum = (t: string) => t.trim() !== "" && Number.isFinite(toNum(t));

const positive = z.string().refine((t) => isNum(t) && toNum(t) > 0, { message: "A number above 0" });
const nonNegative = z.string().refine((t) => isNum(t) && toNum(t) >= 0, { message: "A number, 0 or more" });

export const printerSchema = z.object({
  name: z.string().trim().min(1, "Name the printer"),
  bed: z.tuple([positive, positive, positive]),
  nozzleMm: positive,
  layerMm: positive,
  minWallMm: positive,
  maxOverhangDeg: z.string().refine((t) => isNum(t) && toNum(t) >= 0 && toNum(t) <= 90, { message: "Degrees from 0 to 90" }),
  maxOverhangAreaMm2: nonNegative,
  sliding: nonNegative,
  press: nonNegative,
});

export const materialsSchema = z
  .object({
    materials: z.array(
      z.object({
        name: z.string().trim().min(1, "Name it"),
        densityGCm3: positive,
        minWallMm: z.string().refine((t) => t.trim() === "" || (isNum(t) && toNum(t) > 0), { message: "Empty, or a number above 0" }),
        notes: z.string(),
      }),
    ),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.materials.forEach((m, i) => {
      const key = m.name.trim().toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["materials", i, "name"], message: "Used twice" });
      seen.add(key);
    });
  });

export function printerToForm(p: PrinterProfile): PrinterForm {
  return {
    name: p.name,
    bed: [String(p.bed[0]), String(p.bed[1]), String(p.bed[2])],
    nozzleMm: String(p.nozzleMm),
    layerMm: String(p.layerMm),
    minWallMm: String(p.minWallMm),
    maxOverhangDeg: String(p.maxOverhangDeg),
    maxOverhangAreaMm2: String(p.maxOverhangAreaMm2),
    sliding: String(p.clearance.sliding),
    press: String(p.clearance.press),
  };
}

export function formToPrinter(f: PrinterForm): PrinterProfile {
  return {
    name: f.name.trim(),
    bed: [toNum(f.bed[0]), toNum(f.bed[1]), toNum(f.bed[2])],
    nozzleMm: toNum(f.nozzleMm),
    layerMm: toNum(f.layerMm),
    minWallMm: toNum(f.minWallMm),
    maxOverhangDeg: toNum(f.maxOverhangDeg),
    maxOverhangAreaMm2: toNum(f.maxOverhangAreaMm2),
    clearance: { sliding: toNum(f.sliding), press: toNum(f.press) },
  };
}

export const materialToForm = (m: Material): MaterialForm => ({ name: m.name, densityGCm3: String(m.densityGCm3), minWallMm: m.minWallMm === null ? "" : String(m.minWallMm), notes: m.notes });

export const formToMaterial = (f: MaterialForm): Material => ({
  name: f.name.trim(),
  densityGCm3: toNum(f.densityGCm3),
  minWallMm: f.minWallMm.trim() === "" ? null : toNum(f.minWallMm),
  notes: f.notes.trim(),
});

export const emptyMaterial = (): MaterialForm => ({ name: "", densityGCm3: "1.24", minWallMm: "", notes: "" });

/** The file text as written: two-space JSON with a final newline, like the server's own files. */
export const toFileText = (value: PrinterProfile | MaterialsFile): string => `${JSON.stringify(value, null, 2)}\n`;

/** Reads a library file's text; null when it is not the expected shape (then the form is not offered). */
export function parsePrinter(text: string): PrinterProfile | null {
  try {
    const v: unknown = JSON.parse(text);
    const r = printerShape.safeParse(v);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function parseMaterials(text: string): MaterialsFile | null {
  try {
    const v: unknown = JSON.parse(text);
    const r = materialsShape.safeParse(v);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const printerShape = z.object({
  name: z.string(),
  bed: vec3,
  nozzleMm: z.number(),
  layerMm: z.number(),
  minWallMm: z.number(),
  maxOverhangDeg: z.number(),
  maxOverhangAreaMm2: z.number(),
  clearance: z.object({ sliding: z.number(), press: z.number() }),
}) satisfies z.ZodType<PrinterProfile>;
const materialsShape = z.object({
  materials: z.array(z.object({ name: z.string(), densityGCm3: z.number(), minWallMm: z.number().nullable(), notes: z.string() })),
}) satisfies z.ZodType<MaterialsFile>;
