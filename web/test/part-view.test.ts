import { describe, expect, test } from "bun:test";
import type { Attempt, GateResult, PartReport, ScadParam } from "@drawer/shared/api";
import { layoutAttempts } from "@/components/part/attempt-tree";
import { gateChanges, paramChanges, requiredMinWall } from "@/components/part/part-facts";
import { colorAt, deviationDomain, fieldRange, fieldToVertexColors, hexToRgb, scalePosition, thicknessDomain } from "@/lib/field-colors";
import type { FieldScale } from "@/lib/field-colors";

const scale: FieldScale = { stops: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], domain: [0, 2], unknown: [0.5, 0.5, 0.5] };

describe("field colours", () => {
  test("position clamps and handles unknowns and an empty domain", () => {
    expect(scalePosition(1, [0, 2])).toBe(0.5);
    expect(scalePosition(-5, [0, 2])).toBe(0);
    expect(scalePosition(9, [0, 2])).toBe(1);
    expect(Number.isNaN(scalePosition(Number.NaN, [0, 2]))).toBe(true);
    expect(scalePosition(3, [1, 1])).toBe(0.5);
  });

  test("stops interpolate; NaN draws the unknown colour", () => {
    expect(colorAt(scale, 0)).toEqual([1, 0, 0]);
    expect(colorAt(scale, 1)).toEqual([0, 1, 0]);
    expect(colorAt(scale, 2)).toEqual([0, 0, 1]);
    expect(colorAt(scale, 0.5)).toEqual([0.5, 0.5, 0]);
    expect(colorAt(scale, Number.NaN)).toEqual([0.5, 0.5, 0.5]);
  });

  test("one colour per triangle, repeated on its three vertices", () => {
    const out = fieldToVertexColors(new Float32Array([0, Number.NaN]), scale);
    expect(out.length).toBe(18);
    expect([...out.slice(0, 9)]).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    expect([...out.slice(9, 12)]).toEqual([0.5, 0.5, 0.5]);
  });

  test("ranges skip unknowns; thickness keeps the requirement inside; deviation is symmetric", () => {
    const f = new Float32Array([Number.NaN, 3, 1.5, 8]);
    expect(fieldRange(f)).toEqual([1.5, 8]);
    expect(fieldRange(new Float32Array([Number.NaN]))).toBeNull();
    const d = thicknessDomain(f, 2);
    expect(d?.[0]).toBe(1.5);
    expect(d && d[1] >= 4).toBe(true);
    expect(thicknessDomain(new Float32Array([1]), 3)?.[0]).toBe(1);
    expect(deviationDomain(-0.2, 0.6)).toEqual([-0.6, 0.6]);
    expect(deviationDomain(0, 0)).toEqual([-0.01, 0.01]);
  });

  test("hex parsing", () => {
    expect(hexToRgb("#ff0000")).toEqual([1, 0, 0]);
    expect(hexToRgb(" #0f0 ")).toEqual([0, 1, 0]);
    expect(hexToRgb("nope")).toEqual([0.5, 0.5, 0.5]);
  });
});

const attempt = (revisionId: string, parent: string | null, date: string, current = false): Attempt => ({
  revisionId,
  parent,
  author: "agent",
  message: revisionId,
  date,
  current,
  status: null,
  passed: null,
  total: null,
});

describe("attempt tree layout", () => {
  test("a chain is one lane; a branch opens a new lane; labels follow dates", () => {
    const layout = layoutAttempts([
      attempt("d", "b", "2026-01-04", true),
      attempt("a", null, "2026-01-01"),
      attempt("b", "a", "2026-01-02"),
      attempt("c", "b", "2026-01-03"),
    ]);
    const at = (id: string) => layout.nodes.find((n) => n.attempt.revisionId === id);
    expect(at("a")).toMatchObject({ col: 0, lane: 0, label: "r1" });
    expect(at("b")).toMatchObject({ col: 1, lane: 0, label: "r2" });
    expect(at("c")).toMatchObject({ col: 2, lane: 0, label: "r3" });
    expect(at("d")).toMatchObject({ col: 2, lane: 1, label: "r4" });
    expect(layout.lanes).toBe(2);
    expect(layout.cols).toBe(3);
    expect(layout.edges.map((e) => `${e.from.attempt.revisionId}>${e.to.attempt.revisionId}`).sort()).toEqual(["a>b", "b>c", "b>d"]);
  });

  test("an unknown parent makes a root; empty input is empty", () => {
    const layout = layoutAttempts([attempt("x", "gone", "2026-01-01")]);
    expect(layout.nodes[0]).toMatchObject({ col: 0, lane: 0 });
    expect(layoutAttempts([])).toEqual({ nodes: [], edges: [], cols: 0, lanes: 0 });
  });
});

const gate = (id: string, status: GateResult["status"], expected: string | null = null): GateResult => ({ id, label: id, status, measured: null, expected, detail: null, hint: null, at: null });
const param = (name: string, value: ScadParam["value"]): ScadParam => ({ name, type: "number", value, group: "", description: "", min: null, max: null, step: null, options: null, line: 1 });
const spec = (dimensions: PartReport["spec"]["dimensions"]): PartReport["spec"] => ({ title: "", class: "", description: "", source: "printed", material: "PETG", strictness: "standard", dimensions, waivers: [], prints: [] });

describe("what changed", () => {
  test("parameters that differ, including added and removed", () => {
    const changes = paramChanges({ params: [param("arm_t", 1.2), param("grip", 4), param("old", 1)] }, { params: [param("arm_t", 1.8), param("grip", 4), param("new", [1, 2])] });
    expect(changes).toEqual([
      { name: "arm_t", a: 1.2, b: 1.8 },
      { name: "new", a: undefined, b: [1, 2] },
      { name: "old", a: 1, b: undefined },
    ]);
  });

  test("gate status changes and the unchanged count", () => {
    const r = gateChanges({ gates: [gate("min_wall", "fail"), gate("solid", "pass")] }, { gates: [gate("min_wall", "pass"), gate("solid", "pass"), gate("lint", "warn")] });
    expect(r.changed).toEqual([
      { id: "min_wall", label: "min_wall", a: "fail", b: "pass" },
      { id: "lint", label: "lint", a: null, b: "warn" },
    ]);
    expect(r.unchanged).toBe(1);
  });

  test("required minimum wall: the spec's dimension wins over the gate", () => {
    expect(requiredMinWall({ spec: spec([]), gates: [gate("min_wall", "fail", "≥ 1.6 mm")] })).toBe(1.6);
    expect(requiredMinWall({ spec: spec([{ id: "w", label: "w", kind: "min_wall", min: 2 }]), gates: [gate("min_wall", "fail", "≥ 1.6 mm")] })).toBe(2);
    expect(requiredMinWall({ spec: spec([]), gates: [] })).toBeNull();
  });
});
