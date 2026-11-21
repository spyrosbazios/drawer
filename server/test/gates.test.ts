import { describe, expect, test } from "bun:test";
import type { AssemblySpec, Dimension, GateResult, MeshInfo, PartSpec, ScadParam } from "@drawer/shared/api";
import { assemblyGates, assemblyStatus, apply, bom, boxDistance, candidatePairs, placement, transformBox, type InstancePart } from "../src/parts/assembly-gates.ts";
import { deriveAttempts } from "../src/parts/attempts.ts";
import { applyPolicy, countGates, dimensionGate, lintSource, nextSteps, partGates, partStatus, worst, type GateAnalysis, type PartGateInput } from "../src/parts/gates.ts";
import { validateAssembly, validateMaterials, validatePartSpec, validatePartSpecBody, validatePrinter } from "../src/parts/validate.ts";
import { defaultMaterials, defaultPrinter } from "../src/store/starter.ts";

const printer = defaultPrinter();
const PLA = defaultMaterials().materials[0] ?? null;
const mesh: MeshInfo = { format: "stl", closed: true, triangles: 100, bbox: { min: [0, 0, 0], max: [40, 30, 10], size: [40, 30, 10] }, volumeCm3: 5 };
const analysis: GateAnalysis = { shells: 1, watertight: true, surfaceAreaMm2: 500, baseAreaMm2: 1200, footprintMm2: 1200, overhang: { angle: 45, areaMm2: 0, at: null }, wall: { minMm: 2, at: [1, 2, 3] } };
const PARAM: ScadParam = { name: "w", type: "number", value: 10, group: "", description: "", min: null, max: null, step: null, options: null, line: 2 };
const CLEAN = "// a clip\nw = 10;\nmodule clip() { cube([w, 2, 3]); }\nclip();\n";

function spec(over: Partial<PartSpec> = {}): PartSpec {
  return { title: "Clip", class: "", description: "", source: "printed", material: "PLA", strictness: "standard", dimensions: [], waivers: [], prints: [], ...over };
}

function input(over: Partial<PartGateInput> = {}): PartGateInput {
  return { spec: spec(), printer, material: PLA, build: { ok: true }, mesh, analysis, dimensions: {}, lint: lintSource(CLEAN, [PARAM]), ...over };
}

const byId = (gates: GateResult[], id: string): GateResult | undefined => gates.find((g) => g.id === id);

describe("part gates", () => {
  test("a clean standard part passes every gate", () => {
    const gates = partGates(input());
    expect(gates.map((g) => g.id)).toEqual(["parses", "solid", "fits_bed", "lint", "base", "overhang", "min_wall"]);
    expect(gates.every((g) => g.status === "pass")).toBe(true);
    expect(partStatus(gates, true)).toBe("passed");
    expect(countGates(gates)).toEqual({ passed: 7, total: 7, failing: [] });
    expect(nextSteps(gates, "passed", "parts/clip.scad")).toEqual([]);
  });

  test("quick drops the printability gates; bought drops everything printed", () => {
    expect(partGates(input({ spec: spec({ strictness: "quick" }) })).map((g) => g.id)).toEqual(["parses", "solid", "fits_bed"]);
    expect(partGates(input({ spec: spec({ source: "bought" }) })).map((g) => g.id)).toEqual(["parses", "solid"]);
  });

  test("a build error fails parses, skips what needs a mesh, and is the first next step", () => {
    const gates = partGates(input({ build: { ok: false, error: "Parser error (line 3)" }, mesh: null, analysis: null, spec: spec({ dimensions: [{ id: "w", label: "Width", kind: "size", axis: "x", nominal: 10 }] }) }));
    expect(byId(gates, "parses")).toMatchObject({ status: "fail", detail: "Parser error (line 3)" });
    for (const id of ["solid", "fits_bed", "dim:w", "base", "overhang", "min_wall"]) expect(byId(gates, id)?.status).toBe("skipped");
    expect(byId(gates, "lint")?.status).toBe("pass");
    const status = partStatus(gates, true);
    expect(status).toBe("failed");
    expect(countGates(gates).total).toBe(2);
    expect(nextSteps(gates, status, "parts/clip.scad")[0]).toContain("Parser error");
  });

  test("an empty solid fails parses", () => {
    expect(byId(partGates(input({ mesh: { ...mesh, triangles: 0 } })), "parses")?.status).toBe("fail");
  });

  test("solid fails for several shells or open edges", () => {
    const shells = partGates(input({ analysis: { ...analysis, shells: 3 } }));
    expect(byId(shells, "solid")).toMatchObject({ status: "fail", measured: "3 separate bodies" });
    expect(partStatus(shells, true)).toBe("failed");
    const leaky = partGates(input({ analysis: { ...analysis, watertight: false, wall: null } }));
    expect(byId(leaky, "solid")?.status).toBe("fail");
    expect(byId(leaky, "min_wall")?.status).toBe("skipped");
  });

  test("fits_bed allows x and y to swap but not z", () => {
    const big = (size: [number, number, number]): GateResult | undefined => byId(partGates(input({ printer: { ...printer, bed: [300, 100, 50] }, mesh: { ...mesh, bbox: { ...mesh.bbox, size } } })), "fits_bed");
    expect(big([90, 250, 40])?.status).toBe("pass");
    expect(big([90, 250, 60])?.status).toBe("fail");
    expect(big([310, 50, 10])?.status).toBe("fail");
  });

  test("base needs 20 mm² and 5 % of the footprint", () => {
    expect(byId(partGates(input({ analysis: { ...analysis, baseAreaMm2: 19 } })), "base")?.status).toBe("fail");
    expect(byId(partGates(input({ analysis: { ...analysis, baseAreaMm2: 59, footprintMm2: 1200 } })), "base")?.status).toBe("fail");
    expect(byId(partGates(input({ analysis: { ...analysis, baseAreaMm2: 60, footprintMm2: 1200 } })), "base")?.status).toBe("pass");
  });

  test("overhang over the limit warns under standard and fails under functional", () => {
    const over = { ...analysis, overhang: { angle: 45, areaMm2: 500, at: [5, 5, 5] as [number, number, number] } };
    const standard = partGates(input({ analysis: over }));
    expect(byId(standard, "overhang")).toMatchObject({ status: "warn", at: [5, 5, 5] });
    expect(partStatus(standard, true)).toBe("passed");
    expect(countGates(standard).passed).toBe(7);
    const functional = partGates(input({ analysis: over, spec: spec({ strictness: "functional" }) }));
    expect(byId(functional, "overhang")?.status).toBe("fail");
    expect(partStatus(functional, true)).toBe("draft");
  });

  test("min_wall uses the material's minimum over the printer's, and gives way to a min_wall dimension", () => {
    const thin = { ...analysis, wall: { minMm: 1.4, at: [1, 1, 1] as [number, number, number] } };
    expect(byId(partGates(input({ analysis: thin })), "min_wall")?.status).toBe("pass");
    const tpu = defaultMaterials().materials.find((m) => m.name === "TPU") ?? null;
    expect(byId(partGates(input({ analysis: thin, material: tpu })), "min_wall")).toMatchObject({ status: "fail", at: [1, 1, 1], expected: "≥ 1.6 mm" });
    const withDim = partGates(input({ analysis: thin, spec: spec({ dimensions: [{ id: "mw", label: "Wall", kind: "min_wall", min: 1 }] }), dimensions: { mw: { ok: true, value: 1.4, at: [1, 1, 1] } } }));
    expect(byId(withDim, "min_wall")).toBeUndefined();
    expect(byId(withDim, "dim:mw")?.status).toBe("pass");
  });

  test("waivers turn a failure into waived and count as passed", () => {
    const gates = partGates(input({ analysis: { ...analysis, baseAreaMm2: 5 }, spec: spec({ waivers: [{ gate: "base", reason: "printed on a raft", by: "web", at: "2026-01-01T00:00:00.000Z" }] }) }));
    expect(byId(gates, "base")).toMatchObject({ status: "waived", detail: "printed on a raft", hint: null });
    expect(partStatus(gates, true)).toBe("passed");
    expect(countGates(gates).passed).toBe(7);
  });

  test("a waiver on parses or solid does not apply: a broken part is never passed", () => {
    const waivers = ["parses", "solid"].map((gate) => ({ gate, reason: "ship it", by: "web", at: "" }));
    const gates = partGates(input({ analysis: { ...analysis, shells: 2 }, spec: spec({ waivers }) }));
    expect(byId(gates, "solid")?.status).toBe("fail");
    expect(partStatus(gates, true)).toBe("failed");
  });

  test("applyPolicy leaves passes alone", () => {
    const g: GateResult = { id: "x", label: "X", status: "pass", measured: null, expected: null, detail: null, hint: null, at: null };
    expect(applyPolicy([g], { strictness: "functional", waivers: [{ gate: "x", reason: "r", by: "web", at: "" }] })).toEqual([g]);
  });

  test("next steps are ordered by importance and empty status asks for a model", () => {
    const gates = partGates(input({ analysis: { ...analysis, baseAreaMm2: 1, shells: 2 }, lint: lintSource("cube(1);", []) }));
    const next = nextSteps(gates, partStatus(gates, true), "parts/clip.scad");
    expect(next[0]).toStartWith("One closed body");
    expect(next.at(-1)).toStartWith("Model hygiene");
    expect(nextSteps([], "empty", "parts/clip.scad")[0]).toContain("parts/clip.scad");
  });
});

describe("dimension gates", () => {
  const dim = (d: Partial<Dimension>): Dimension => ({ id: "d", label: "D", kind: "size", axis: "x", ...d });
  test("nominal ± tol, min and max", () => {
    expect(dimensionGate(dim({ nominal: 10, tol: 0.2 }), { ok: true, value: 10.1, at: null }).status).toBe("pass");
    const wide = dimensionGate(dim({ nominal: 10, tol: 0.2 }), { ok: true, value: 10.5, at: null });
    expect(wide).toMatchObject({ status: "fail", measured: "10.5 mm", expected: "10 ± 0.2 mm" });
    expect(wide.hint).toContain("Reduce the extent along x by 0.5 mm");
    expect(dimensionGate(dim({ kind: "hole", at: 2, min: 5 }), { ok: true, value: 4, at: [1, 1, 2] })).toMatchObject({ status: "fail", at: [1, 1, 2] });
    expect(dimensionGate(dim({ kind: "hole", at: 2, min: 5 }), { ok: true, value: 4, at: null }).hint).toStartWith("Widen");
    expect(dimensionGate(dim({ kind: "volume", max: 3 }), { ok: true, value: 3, at: null })).toMatchObject({ status: "pass", measured: "3 cm³" });
  });

  test("envelope compares per axis", () => {
    const d = dim({ kind: "envelope", box: [50, 50, 20] });
    expect(dimensionGate(d, { ok: true, size: [40, 30, 10], at: null }).status).toBe("pass");
    const over = dimensionGate(d, { ok: true, size: [60, 30, 10], at: null });
    expect(over.status).toBe("fail");
    expect(over.hint).toContain("10 mm along x");
  });

  test("a measurement error fails with that detail", () => {
    expect(dimensionGate(dim({ kind: "hole", at: 1, nominal: 3 }), { ok: false, error: "not round", at: [0, 0, 1] })).toMatchObject({ status: "fail", detail: "not round", at: [0, 0, 1] });
  });
});

describe("lint", () => {
  test("needs a description, a parameter and a sane $fn", () => {
    expect(lintSource(CLEAN, [PARAM]).problems).toEqual([]);
    const bad = lintSource("$fn = 256;\nmodule a() { cube(1); }\n", []);
    expect(bad.problems).toHaveLength(3);
    expect(bad.problems.join(" ")).toContain("$fn = 256");
    expect(lintSource("// x\n$fn = 64;\nw = 1;\n", [PARAM]).problems).toEqual([]);
  });

  test("more than six unexplained numbers inside modules warn; commented lines and obvious numbers do not count", () => {
    const many = `// x\nw = 1;\nmodule a() {\n  translate([3, 4, 5]) cube([6, 7, 8]);\n  sphere(9);\n}\n`;
    expect(lintSource(many, [PARAM]).unexplained).toBe(7);
    const gates = partGates(input({ lint: lintSource(many, [PARAM]) }));
    expect(byId(gates, "lint")?.status).toBe("warn");
    const explained = `// x\nw = 1;\nmodule a() {\n  translate([3, 4, 5]) cube([6, 7, 8]); // pocket\n  sphere(9);\n  rotate([0, 90, 0]) cube(1);\n}\n/* 11 12 13 */\n`;
    expect(lintSource(explained, [PARAM]).unexplained).toBe(1);
  });
});

describe("roll-up", () => {
  test("worst status", () => {
    expect(worst([])).toBe("empty");
    expect(worst(["passed", "failed", "draft"])).toBe("failed");
    expect(worst(["passed", "draft", "pending"])).toBe("draft");
    expect(worst(["passed", "empty"])).toBe("draft");
    expect(worst(["passed", "pending"])).toBe("pending");
    expect(worst(["passed", "passed"])).toBe("passed");
  });
});

describe("assembly maths and gates", () => {
  test("placement rotates x, then y, then z, then translates", () => {
    const m = placement([0, 0, 90], [10, 0, 0]);
    expect(apply(m, [1, 0, 0]).map((n) => Math.round(n * 1e9) / 1e9)).toEqual([10, 1, 0]);
    const xy = placement([90, 0, 90], [0, 0, 0]);
    // x first: (0,1,0) -> (0,0,1); then z leaves it.
    expect(apply(xy, [0, 1, 0]).map((n) => Math.round(n * 1e9) / 1e9)).toEqual([0, 0, 1]);
    expect(m).toHaveLength(16);
    expect(transformBox({ min: [0, 0, 0], max: [2, 1, 1] }, m)).toEqual({ min: [9, 0, 0], max: [10, 2, 1] });
    expect(boxDistance({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [1.5, 0, 0], max: [2, 1, 1] })).toBe(0.5);
  });

  const asm: AssemblySpec = {
    title: "Box",
    instances: [
      { id: "base", part: "base", translate: [0, 0, 0], rotate: [0, 0, 0] },
      { id: "lid", part: "lid", translate: [0, 0, 10], rotate: [0, 0, 0] },
      { id: "screw", part: "_library/m3", translate: [100, 0, 0], rotate: [0, 0, 0] },
    ],
    mates: [{ id: "lid-fit", label: "Lid fit", a: "base", b: "lid", fit: "clearance", min: 0.1, max: 0.3 }],
  };

  test("candidate pairs are mates plus boxes within 1 mm", () => {
    const boxes = new Map([
      ["base", { min: [0, 0, 0], max: [10, 10, 10] }],
      ["lid", { min: [0, 0, 10.2], max: [10, 10, 12] }],
      ["screw", { min: [10.5, 0, 0], max: [12, 2, 2] }],
    ] as [string, { min: [number, number, number]; max: [number, number, number] }][]);
    expect(candidatePairs(asm, boxes).map((p) => p.join("-")).sort()).toEqual(["base-lid", "base-screw"]);
  });

  const part = (id: string, part: string, over: Partial<InstancePart> = {}): InstancePart => ({
    instance: asm.instances.find((i) => i.id === id) ?? { id, part, translate: [0, 0, 0], rotate: [0, 0, 0] },
    status: "passed",
    title: part,
    source: "printed",
    material: "PLA",
    massG: 2,
    meshed: true,
    ...over,
  });

  test("gates: parts, clash, mates, floating, bom", () => {
    const parts = [part("base", "base"), part("lid", "lid"), part("screw", "_library/m3", { source: "bought", massG: null })];
    const ok = assemblyGates({ spec: asm, parts, pairs: [{ a: "base", b: "lid", gapMm: 0.2, overlapCm3: 0 }, { a: "base", b: "screw", gapMm: 0, overlapCm3: 0 }] });
    expect(ok.map((g) => `${g.id}:${g.status}`)).toEqual(["parts:pass", "clash:pass", "mate:lid-fit:pass", "floating:pass", "bom:pass"]);
    expect(assemblyStatus(ok)).toBe("passed");

    const bad = assemblyGates({ spec: asm, parts: [part("base", "base", { status: "draft" }), part("lid", "lid"), part("screw", "_library/m3", { source: "bought" })], pairs: [{ a: "base", b: "lid", gapMm: 0, overlapCm3: 0.002 }] });
    expect(bad.map((g) => `${g.id}:${g.status}`)).toEqual(["parts:warn", "clash:fail", "mate:lid-fit:fail", "floating:fail", "bom:pass"]);
    expect(assemblyStatus(bad)).toBe("draft");

    const pressed = assemblyGates({ spec: { ...asm, mates: [{ id: "p", label: "Press", a: "base", b: "lid", fit: "press" }] }, parts, pairs: [{ a: "base", b: "lid", gapMm: 0, overlapCm3: 0.01 }] });
    expect(pressed.find((g) => g.id === "clash")?.status).toBe("pass");
    expect(pressed.find((g) => g.id === "mate:p")?.status).toBe("pass");

    const missing = assemblyGates({ spec: asm, parts: [part("base", "base", { status: null }), part("lid", "lid"), { ...part("screw", "screw", { source: "bought" }), instance: { id: "screw", part: "screw", translate: [0, 0, 0], rotate: [0, 0, 0] } }], pairs: [] });
    expect(missing.find((g) => g.id === "parts")?.status).toBe("fail");
    expect(missing.find((g) => g.id === "bom")?.status).toBe("fail");
    expect(assemblyStatus(missing)).toBe("failed");
  });

  test("floating ignores instances without a mesh: the parts gate reports them", () => {
    const parts = [part("base", "base"), part("lid", "lid", { status: "failed", meshed: false }), part("screw", "_library/m3", { source: "bought", massG: null })];
    const gates = assemblyGates({ spec: asm, parts, pairs: [{ a: "base", b: "screw", gapMm: 0, overlapCm3: 0 }] });
    expect(gates.find((g) => g.id === "floating")?.status).toBe("pass");
    expect(gates.find((g) => g.id === "parts")?.status).toBe("fail");
    const alone = assemblyGates({ spec: asm, parts: [part("base", "base"), part("lid", "lid", { status: null, meshed: false }), part("screw", "_library/m3", { status: "empty", meshed: false })], pairs: [] });
    expect(alone.find((g) => g.id === "floating")).toMatchObject({ status: "skipped", detail: "fewer than two instances have a mesh" });
  });

  test("contact mates and a single instance", () => {
    const one: AssemblySpec = { title: "", instances: [asm.instances[0] as AssemblySpec["instances"][number]], mates: [] };
    expect(assemblyGates({ spec: one, parts: [part("base", "base")], pairs: [] }).find((g) => g.id === "floating")?.status).toBe("skipped");
    const contact = { ...asm, mates: [{ id: "c", label: "C", a: "base", b: "lid", fit: "contact" as const }] };
    expect(assemblyGates({ spec: contact, parts: [], pairs: [{ a: "lid", b: "base", gapMm: 0.04, overlapCm3: 0 }] }).find((g) => g.id === "mate:c")?.status).toBe("pass");
    expect(assemblyGates({ spec: contact, parts: [], pairs: [{ a: "lid", b: "base", gapMm: 0.1, overlapCm3: 0 }] }).find((g) => g.id === "mate:c")?.status).toBe("fail");
  });

  test("bill of materials counts instances and sums printed mass", () => {
    const extra = { ...part("lid", "lid"), instance: { id: "lid2", part: "lid", translate: [0, 0, 0] as [number, number, number], rotate: [0, 0, 0] as [number, number, number] } };
    const out = bom([part("base", "base", { massG: 3 }), part("lid", "lid"), extra, part("screw", "_library/m3", { source: "bought", massG: null })]);
    expect(out.lines).toEqual([
      { part: "base", title: "base", count: 1, source: "printed", material: "PLA", massG: 3 },
      { part: "lid", title: "lid", count: 2, source: "printed", material: "PLA", massG: 2 },
      { part: "_library/m3", title: "_library/m3", count: 1, source: "bought", material: null, massG: null },
    ]);
    expect(out.totalPrintedMassG).toBe(7);
  });
});

describe("attempt tree", () => {
  test("restores branch the tree and removals end the line", () => {
    const rev = (id: string, message: string, modelRev: string | null = id) => ({ id, author: "agent", message, date: "", modelRev });
    const attempts = deriveAttempts(
      [rev("aaaaaaa1", "first"), rev("bbbbbbb2", "second"), rev("ccccccc3", "restore aaaaaaa1"), rev("ddddddd4", "third")],
      (m) => (m === "aaaaaaa1" ? { status: "draft", passed: 3, total: 5 } : null),
      true,
    );
    expect(attempts.map((a) => [a.revisionId, a.parent, a.current])).toEqual([
      ["aaaaaaa1", null, false],
      ["bbbbbbb2", "aaaaaaa1", false],
      ["ddddddd4", "aaaaaaa1", true],
    ]);
    expect(attempts[0]).toMatchObject({ status: "draft", passed: 3, total: 5 });
    expect(attempts[1]?.status).toBeNull();
    const removed = deriveAttempts([rev("a1", "first"), rev("b2", "delete", null), rev("c3", "again")], () => null, true);
    expect(removed.map((a) => [a.revisionId, a.parent])).toEqual([
      ["a1", null],
      ["c3", null],
    ]);
  });
});

describe("structured-file validation", () => {
  test("part specs", () => {
    const ok = validatePartSpec({ title: "T", source: "printed", material: "PLA", strictness: "quick", dimensions: [{ id: "w", label: "W", kind: "size", axis: "x", nominal: 10, tol: 0.1 }] }, ["PLA"]);
    expect(ok).toMatchObject({ class: "", description: "", waivers: [], prints: [] });
    const bad: [unknown, string][] = [
      [{ title: "T", source: "printed", material: "PLA", strictness: "loose" }, "strictness"],
      [{ title: "T", source: "printed", material: "Wood", strictness: "quick" }, "material"],
      [{ title: "T", source: "printed", material: "PLA", strictness: "quick", colour: "red" }, "colour"],
      [{ title: "T", source: "printed", material: "PLA", strictness: "quick", dimensions: [{ id: "w", label: "W", kind: "size", nominal: 1 }] }, "dimensions[0].axis"],
      [{ title: "T", source: "printed", material: "PLA", strictness: "quick", dimensions: [{ id: "w", label: "W", kind: "hole", axis: "z", nominal: 1 }] }, "dimensions[0].at"],
      [{ title: "T", source: "printed", material: "PLA", strictness: "quick", dimensions: [{ id: "w", label: "W", kind: "size", axis: "x" }] }, "nominal, min or max"],
      [{ title: "T", source: "printed", material: "PLA", strictness: "quick", dimensions: [{ id: "w", kind: "min_wall", max: 1 }] }, "min is required"],
      [{ source: "printed", material: "PLA", strictness: "quick" }, "title"],
      [{ title: "T", source: "printed", material: "PLA", strictness: "quick", dimensions: [{ id: "w", label: "W", kind: "boss", axis: "z", nominal: 1 }] }, "dimensions[0].at"],
      [{ title: "T", source: "printed", material: "PLA", strictness: "quick", waivers: [{ gate: "parses", reason: "r", by: "web", at: "" }] }, "cannot be waived"],
      [{ title: "T", source: "printed", material: "PLA", strictness: "quick", waivers: [{ gate: "solid", reason: "r", by: "web", at: "" }] }, "cannot be waived"],
    ];
    expect(validatePartSpec({ title: "T", source: "printed", material: "PLA", strictness: "quick", dimensions: [{ id: "p", label: "P", kind: "boss", axis: "z", at: 2, near: [1, 1], nominal: 4 }] }, ["PLA"]).dimensions[0]).toEqual({ id: "p", label: "P", kind: "boss", axis: "z", at: 2, near: [1, 1], nominal: 4 });
    for (const [value, field] of bad) expect(() => validatePartSpec(value, ["PLA"])).toThrow(field);
    expect(validatePartSpec({ title: "Screw", source: "bought", material: "steel", strictness: "quick" }, ["PLA"]).material).toBe("steel");
  });

  test("a part spec body takes the defaults and rejects waivers", () => {
    expect(validatePartSpecBody({ title: "T" }, { material: "PETG", strictness: "functional" }, ["PLA", "PETG"])).toEqual({ title: "T", class: "", description: "", source: "printed", material: "PETG", strictness: "functional", dimensions: [] });
    expect(() => validatePartSpecBody({ title: "T", waivers: [] }, { material: "PLA", strictness: "quick" }, ["PLA"])).toThrow("waivers");
  });

  test("assembly, printer and materials", () => {
    expect(validateAssembly({ title: "A", instances: [{ id: "a", part: "x" }], mates: [] }).instances[0]).toEqual({ id: "a", part: "x", translate: [0, 0, 0], rotate: [0, 0, 0] });
    expect(() => validateAssembly({ instances: [{ id: "a", part: "x" }], mates: [{ id: "m", label: "M", a: "a", b: "zz", fit: "contact" }] })).toThrow("mates[0].b");
    expect(() => validateAssembly({ instances: [{ id: "a", part: "x" }, { id: "a", part: "y" }] })).toThrow("duplicate");
    expect(() => validateAssembly({ instances: [{ id: "a", part: "../x" }] })).toThrow("instances[0].part");
    expect(() => validateAssembly({ title: "A", instances: [], mates: [] })).toThrow("at least one");
    expect(() => validateAssembly({ title: "A" })).toThrow("at least one");
    expect(validatePrinter(printer)).toEqual(printer);
    expect(() => validatePrinter({ ...printer, bed: [1, 2] })).toThrow("bed");
    expect(() => validatePrinter({ ...printer, clearance: { sliding: 0.2 } })).toThrow("clearance.press");
    expect(validateMaterials(defaultMaterials())).toEqual(defaultMaterials());
    expect(() => validateMaterials({ materials: [{ name: "PLA", densityGCm3: 0 }] })).toThrow("densityGCm3");
    expect(() => validateMaterials({ materials: [] })).toThrow("materials");
  });
});
