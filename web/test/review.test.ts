import { describe, expect, test } from "bun:test";
import type { Dimension, GateResult, ScadParam } from "@drawer/shared/api";
import { formToMaterial, formToPrinter, materialsSchema, parseMaterials, parsePrinter, printerSchema, printerToForm } from "@/components/settings/library-model";
import { changedGates, clampParam, diffParams, formatExpectation, groupParams, isWaivable, parseNumberInput, sendBackMessage, setVectorComponent } from "@/components/review/review-model";
import { formToBody, newDimension, specFormSchema, specToForm } from "@/components/review/spec-form";

const dim = (d: Partial<Dimension>): Dimension => ({ id: "d", label: "D", kind: "size", ...d });
const gate = (id: string, status: GateResult["status"], measured: string | null = null): GateResult => ({ id, label: id, status, measured, expected: null, detail: null, hint: null, at: null });
const param = (p: Partial<ScadParam>): ScadParam => ({ name: "x", type: "number", value: 1, group: "", description: "", min: null, max: null, step: null, options: null, line: 1, ...p });

describe("dimension expectations", () => {
  test("each range form", () => {
    expect(formatExpectation(dim({ nominal: 6.4, tol: 0.1 }))).toBe("6.4 ± 0.1");
    expect(formatExpectation(dim({ nominal: 12 }))).toBe("12");
    expect(formatExpectation(dim({ kind: "min_wall", min: 1.6 }))).toBe("≥ 1.6");
    expect(formatExpectation(dim({ max: 3 }))).toBe("≤ 3");
    expect(formatExpectation(dim({ min: 2, max: 3 }))).toBe("2 – 3");
    expect(formatExpectation(dim({ kind: "envelope", box: [30, 20, 15] }))).toBe("≤ 30 × 20 × 15");
  });
});

describe("gates", () => {
  test("parses and solid cannot be waived", () => {
    expect(isWaivable(gate("parses", "fail"))).toBe(false);
    expect(isWaivable(gate("solid", "fail"))).toBe(false);
    expect(isWaivable(gate("overhang", "warn"))).toBe(true);
    expect(isWaivable(gate("lint", "pass"))).toBe(false);
  });
  test("changed gates keep only differences", () => {
    const cur = [gate("a", "pass", "1"), gate("b", "fail", "2"), gate("c", "pass", "3")];
    const next = [gate("a", "pass", "1"), gate("b", "pass", "2.5"), gate("c", "pass", "3.1")];
    expect(changedGates(cur, next).map((c) => c.gate.id)).toEqual(["b", "c"]);
  });
  test("send-back message names failing gates", () => {
    const msg = sendBackMessage("clip", { status: "draft", passed: 6, total: 7, gates: [gate("a", "pass"), { ...gate("min_wall", "fail", "1.2 mm"), expected: "≥ 1.6 mm" }] });
    expect(msg).toContain("draft (6/7)");
    expect(msg).toContain("- min_wall (1.2 mm, needs ≥ 1.6 mm)");
  });
});

describe("parameters", () => {
  test("diff keeps only changed values of known params", () => {
    const params = [param({ name: "a", value: 1 }), param({ name: "v", type: "vector", value: [1, 2] })];
    expect(diffParams(params, { a: 1, v: [1, 2], gone: 3 })).toEqual({});
    expect(diffParams(params, { a: 2, v: [1, 3] })).toEqual({ a: 2, v: [1, 3] });
  });
  test("clamp and round to step", () => {
    const p = { min: 0.8, max: 4, step: 0.2 };
    expect(clampParam(p, 5)).toBe(4);
    expect(clampParam(p, 0.1)).toBe(0.8);
    expect(clampParam(p, 1.2300001)).toBe(1.2);
  });
  test("typed numbers", () => {
    expect(parseNumberInput("1,5")).toBe(1.5);
    expect(parseNumberInput("")).toBeNull();
    expect(parseNumberInput("abc")).toBeNull();
    expect(setVectorComponent([1, 2, 3], 1, 9)).toEqual([1, 9, 3]);
  });
  test("groups keep file order, ungrouped first", () => {
    const g = groupParams([param({ name: "a", group: "Size" }), param({ name: "b", group: "" }), param({ name: "c", group: "Size" })]);
    expect(g.map((x) => [x.group, x.params.map((p) => p.name)])).toEqual([
      ["", ["b"]],
      ["Size", ["a", "c"]],
    ]);
  });
});

describe("spec form", () => {
  const spec = {
    title: "Clip",
    class: "clip",
    description: "",
    source: "printed" as const,
    material: "PETG",
    strictness: "standard" as const,
    dimensions: [
      dim({ id: "bore", kind: "hole", axis: "z", at: 6, near: [0, 0], nominal: 6.4, tol: 0.15 }),
      dim({ id: "env", kind: "envelope", box: [40, 20, 15] }),
      dim({ id: "w", kind: "wall", axis: "x", from: [1, 2, 3], min: 1.5 }),
    ],
    waivers: [],
    prints: [],
  };

  test("round-trips to the same body", () => {
    const form = specToForm(spec);
    expect(specFormSchema.safeParse(form).success).toBe(true);
    const body = formToBody(form);
    expect(body.dimensions).toEqual(spec.dimensions);
    expect(body.title).toBe("Clip");
  });

  test("only the fields a kind uses are sent", () => {
    const form = specToForm(spec);
    const first = form.dimensions[0];
    if (!first) throw new Error("no dimension");
    form.dimensions[0] = { ...first, kind: "size" };
    expect(formToBody(form).dimensions?.[0]).toEqual({ id: "bore", label: "D", kind: "size", axis: "z", nominal: 6.4, tol: 0.15 });
  });

  test("rejects bad input with field paths", () => {
    const form = specToForm(spec);
    form.dimensions.push({ ...newDimension(form.dimensions), id: "bore", label: "" });
    const r = specFormSchema.safeParse(form);
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path.join(".")) ?? [];
    expect(paths).toContain("dimensions.3.label");
    expect(paths).toContain("dimensions.3.nominal");
    expect(paths).toContain("dimensions.3.id");
  });
});

describe("library files", () => {
  const printer = { name: "MK4", bed: [250, 210, 220] as [number, number, number], nozzleMm: 0.4, layerMm: 0.2, minWallMm: 1.2, maxOverhangDeg: 45, maxOverhangAreaMm2: 100, clearance: { sliding: 0.2, press: 0.05 } };
  test("printer round-trips and validates", () => {
    const f = printerToForm(printer);
    expect(printerSchema.safeParse(f).success).toBe(true);
    expect(formToPrinter(f)).toEqual(printer);
    expect(printerSchema.safeParse({ ...f, maxOverhangDeg: "120" }).success).toBe(false);
    expect(parsePrinter(JSON.stringify(printer))).toEqual(printer);
    expect(parsePrinter("{")).toBeNull();
  });
  test("materials: empty min wall is null, duplicates rejected", () => {
    expect(formToMaterial({ name: " PLA ", densityGCm3: "1.24", minWallMm: "", notes: "" })).toEqual({ name: "PLA", densityGCm3: 1.24, minWallMm: null, notes: "" });
    const m = { name: "PLA", densityGCm3: "1.24", minWallMm: "", notes: "" };
    expect(materialsSchema.safeParse({ materials: [m, { ...m, name: "pla" }] }).success).toBe(false);
    expect(parseMaterials(JSON.stringify({ materials: [{ name: "PLA", densityGCm3: 1.24, minWallMm: null, notes: "" }] }))?.materials).toHaveLength(1);
  });
});
