/** Mesh maths on generated solids with known answers; no OpenSCAD. */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { buildBvh } from "../src/bvh";
import { createRenderer } from "../src/index";
import { analyse, deviation, gap, probe, slice, transform, volume } from "../src/measure";
import { toBinaryStl } from "../src/mesh";
import { MeasureClient } from "../src/measure-client";
import { box, hollowBox, join, prism, pyramid, torus, washer } from "./shapes";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x: number, y: number, z: number): number[] => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const cube = (): Float32Array => box([0, 0, 0], [10, 10, 10]);

describe("generated solids", () => {
  test("are outward-facing", () => {
    expect(volume(cube())).toBeCloseTo(1000, 6);
    expect(volume(hollowBox())).toBeCloseTo(8000 - 16 ** 3, 3);
    expect(volume(washer())).toBeGreaterThan(0);
    expect(volume(torus(30, 10, 40, 20))).toBeGreaterThan(0);
  });
});

describe("analyse", () => {
  test("10 mm cube", () => {
    const { analysis, thickness } = analyse(cube(), 45);
    expect(analysis.shells).toBe(1);
    expect(analysis.watertight).toBe(true);
    expect(analysis.surfaceAreaMm2).toBeCloseTo(600, 6);
    expect(analysis.baseAreaMm2).toBeCloseTo(100, 6);
    expect(analysis.footprintMm2).toBeCloseTo(100, 6);
    expect(analysis.overhang).toEqual({ angle: 45, areaMm2: 0, at: null });
    expect(analysis.wall?.minMm).toBeCloseTo(10, 4);
    expect(thickness.length).toBe(12);
    for (const t of thickness) expect(t).toBeCloseTo(10, 4);
  });

  test("hollow box: 2 mm walls, two shells", () => {
    const { analysis } = analyse(hollowBox(), 45);
    expect(analysis.shells).toBe(2);
    expect(analysis.watertight).toBe(true);
    expect(analysis.wall?.minMm).toBeCloseTo(2, 4);
    // The cavity's ceiling is an overhang: 16 × 16 at z = 18.
    expect(analysis.overhang.areaMm2).toBeCloseTo(256, 4);
    expect(analysis.overhang.at?.[2]).toBeCloseTo(18, 4);
  });

  test("two separate cubes: two shells; the raised one's underside is an overhang", () => {
    const { analysis } = analyse(join(cube(), box([20, 0, 20], [30, 10, 30])), 45);
    expect(analysis.shells).toBe(2);
    expect(analysis.baseAreaMm2).toBeCloseTo(100, 6);
    expect(analysis.overhang.areaMm2).toBeCloseTo(100, 6);
    expect(analysis.overhang.at).toEqual([25, 5, 20]);
    expect(analysis.footprintMm2).toBeCloseTo(300, 6);
  });

  test("bodies touching at a vertex or along an edge are separate shells", () => {
    expect(analyse(join(cube(), box([10, 10, 10], [20, 20, 20])), 45).analysis.shells).toBe(2);
    expect(analyse(join(cube(), box([10, 10, 0], [20, 20, 10])), 45).analysis.shells).toBe(2);
    expect(analyse(prism(32, 5, 10), 45).analysis.shells).toBe(1);
  });

  test("an open mesh is not watertight and has no wall", () => {
    const open = cube().slice(0, 10 * 9);
    const { analysis, thickness } = analyse(open, 45);
    expect(analysis.watertight).toBe(false);
    expect(analysis.wall).toBeNull();
    expect(Number.isNaN(thickness[0]!)).toBe(true);
  });

  test("a 200 000-triangle torus analyses well inside the budget", () => {
    const mesh = torus(30, 10, 500, 200);
    expect(mesh.length / 9).toBe(200_000);
    const started = performance.now();
    const { analysis } = analyse(mesh, 45);
    const seconds = (performance.now() - started) / 1000;
    expect(analysis.watertight).toBe(true);
    expect(analysis.shells).toBe(1);
    // The tube is 20 mm across; the thinnest straight chord near the inner equator is a bit less.
    expect(analysis.wall?.minMm).toBeGreaterThan(5);
    expect(analysis.wall?.minMm).toBeLessThanOrEqual(20.01);
    expect(seconds).toBeLessThan(20);
  }, 60_000);
});

describe("slice", () => {
  test("plate with a 6 mm through hole: a round hole of diameter 6", () => {
    const contours = slice(washer(20, 3, 4, 64), "z", 2);
    expect(contours.length).toBe(2);
    const hole = contours.find((c) => c.hole);
    const outer = contours.find((c) => !c.hole);
    expect(hole?.circle.round).toBe(true);
    // The fit is to the 64-gon's whole perimeter: within 0.01 of 6.
    expect(Math.abs((hole?.circle.diameter ?? 0) - 6)).toBeLessThan(0.01);
    expect(Math.abs(hole?.circle.centre[0] ?? 1)).toBeLessThan(1e-3);
    expect(Math.abs((outer?.circle.diameter ?? 0) - 40)).toBeLessThan(0.1);
    // The points where the cut crosses each side quad's diagonal lie on the chords: dropped.
    expect(outer?.points.length).toBe(64);
  });

  test("an n-gon prism reports the same diameter at every cut height", () => {
    const heights = [0.5, 2.5, 5, 7.3, 9.9];
    for (const n of [6, 10, 32, 64]) {
      const mesh = prism(n, 5, 10);
      const circles = heights.map((at) => {
        const [c, ...rest] = slice(mesh, "z", at);
        expect(rest).toEqual([]);
        expect(c?.points.length).toBe(n);
        return c!.circle;
      });
      for (const c of circles) {
        expect(c.diameter).toBeCloseTo(circles[0]!.diameter, 3);
        expect(c.rms).toBeCloseTo(circles[0]!.rms, 3);
        // Between the inscribed and the circumscribed circle.
        expect(c.diameter).toBeGreaterThan(10 * Math.cos(Math.PI / n));
        expect(c.diameter).toBeLessThan(10);
      }
      if (n === 6) expect(circles[0]!.round).toBe(false);
      if (n === 10) expect(circles[0]!.rms).toBeGreaterThan(0.01);
      if (n === 64) {
        expect(circles[0]!.round).toBe(true);
        expect(Math.abs(circles[0]!.diameter - 10) / 10).toBeLessThan(0.005);
      }
    }
  });

  test("cube cut along y: one 10 × 10 square in x-z", () => {
    const [c, ...rest] = slice(cube(), "y", 5);
    expect(rest).toEqual([]);
    expect(c?.hole).toBe(false);
    expect(c?.areaMm2).toBeCloseTo(100, 6);
    expect(c?.centre).toEqual([5, 5]);
    expect(c?.bbox).toEqual({ min: [0, 0], max: [10, 10] });
    expect(c?.circle.round).toBe(false);
  });

  test("a cut that misses gives nothing", () => {
    expect(slice(cube(), "x", 20)).toEqual([]);
  });

  test("long outlines are simplified to 200 points", () => {
    const [c] = slice(washer(20, 3, 4, 500), "z", 1).filter((x) => !x.hole);
    expect(c?.points.length).toBe(200);
  });
});

describe("probe", () => {
  const b = buildBvh(hollowBox());
  test("in the wall", () => {
    expect(probe(b, [10, 10, 1], "z")).toEqual({ inside: true, onSurface: false, low: 0, high: 2, distance: 2 });
  });
  test("in the cavity", () => {
    expect(probe(b, [10, 10, 10], "x")).toEqual({ inside: false, onSurface: false, low: 2, high: 18, distance: 16 });
  });
  test("in open air above the part", () => {
    expect(probe(b, [10, 10, 25], "z")).toEqual({ inside: false, onSurface: false, low: 20, high: null, distance: null });
  });
  test("on a face, or within 0.01 mm of it", () => {
    expect(probe(b, [10, 10, 2], "z").onSurface).toBe(true);
    expect(probe(b, [10, 10, 20.005], "z").onSurface).toBe(true);
    expect(probe(b, [10, 10, 20.02], "z").onSurface).toBe(false);
  });
  test("a ray through the edge two triangles share counts once", () => {
    // (5, 5) lies on the diagonal of the cube's top and bottom faces.
    expect(probe(buildBvh(cube()), [5, 5, 5], "z")).toEqual({ inside: true, onSurface: false, low: 0, high: 10, distance: 10 });
    expect(probe(buildBvh(cube()), [5, 5, 15], "z")).toEqual({ inside: false, onSurface: false, low: 10, high: null, distance: null });
  });
  test("a ray that only touches a vertex does not cross the surface", () => {
    // Along x through the pyramid's apex: the four side faces meet there, facing both ways.
    expect(probe(buildBvh(pyramid()), [-5, 0, 10], "x")).toEqual({ inside: false, onSurface: false, low: null, high: null, distance: null });
    expect(probe(buildBvh(pyramid()), [0, 0, 5], "x")).toEqual({ inside: true, onSurface: false, low: -2.5, high: 2.5, distance: 5 });
  });
});

describe("measure client", () => {
  const workerUrl = new URL("./misbehaving-worker.ts", import.meta.url).href;
  test("a worker that dies fails its requests, and the next request gets a fresh one", async () => {
    const client = new MeasureClient({ workerUrl });
    try {
      await expect(client.ask({ op: "probe", mesh: "x", from: [0, 0, 0], axis: "x" })).rejects.toThrow("measuring worker");
      expect(await client.ask({ op: "slice", mesh: "x", axis: "z", at: 0 })).toMatchObject({ ok: true, contours: [] });
    } finally {
      client.terminate();
    }
  });
  test("a request with no answer times out, and the worker is replaced", async () => {
    const client = new MeasureClient({ workerUrl, timeoutMs: 300 });
    try {
      await expect(client.ask({ op: "probe", mesh: "x", from: [0, 0, 0], axis: "y" })).rejects.toThrow("did not answer");
      expect(await client.ask({ op: "slice", mesh: "x", axis: "z", at: 0 })).toMatchObject({ ok: true, contours: [] });
    } finally {
      client.terminate();
    }
  });
});

describe("deviation", () => {
  test("a cube shifted by 1 mm in x", () => {
    const a = buildBvh(cube());
    const shifted = transform(cube(), translate(1, 0, 0));
    const r = deviation(a, shifted);
    expect(r.min).toBeCloseTo(-1, 6);
    expect(r.max).toBeCloseTo(1, 6);
    expect(r.field.length).toBe(12);
    expect(r.p95).toBeCloseTo(1, 6);
    expect(r.at).not.toBeNull();
  });

  test("identical meshes deviate by nothing", () => {
    const r = deviation(buildBvh(cube()), cube());
    expect([r.min, r.max, r.rms, r.p95]).toEqual([0, 0, 0, 0]);
  });
});

describe("gap", () => {
  const place = (m: number[]) => buildBvh(transform(cube(), m));
  test("two cubes 3 mm apart", () => {
    expect(gap(place(IDENTITY), place(translate(13, 0, 0)))).toBeCloseTo(3, 4);
  });
  test("diagonally apart: corner to corner", () => {
    expect(gap(place(IDENTITY), place(translate(13, 14, 0)))).toBeCloseTo(5, 4);
  });
  test("touching and overlapping are 0", () => {
    expect(gap(place(IDENTITY), place(translate(10, 0, 0)))).toBe(0);
    expect(gap(place(IDENTITY), place(translate(5, 5, 5)))).toBe(0);
  });
  test("one inside the other is 0", () => {
    const small = buildBvh(box([4, 4, 4], [6, 6, 6]));
    expect(gap(place(IDENTITY), small)).toBe(0);
  });
  test("two bars crossing without a vertex inside the other are 0", () => {
    const a = buildBvh(box([-20, -1, -1], [20, 1, 1]));
    const b = buildBvh(box([-1, -20, -1], [1, 20, 1]).map((v) => v * 1.0001));
    expect(gap(a, b)).toBe(0);
  });
});

describe("renderer measuring methods (worker, cached files)", () => {
  test("analyse, slice, probe and deviation write their files once", async () => {
    const cacheDir = await mkdtemp(joinPath(tmpdir(), "drawer-measure-"));
    const keyA = "a".repeat(64);
    const keyB = "b".repeat(64);
    await mkdir(joinPath(cacheDir, "meshes", keyA), { recursive: true });
    await mkdir(joinPath(cacheDir, "meshes", keyB));
    await writeFile(joinPath(cacheDir, "meshes", keyA, "mesh.stl"), toBinaryStl(hollowBox()));
    await writeFile(joinPath(cacheDir, "meshes", keyB, "mesh.stl"), toBinaryStl(transform(hollowBox(), translate(0.5, 0, 0))));
    const r = createRenderer({ cacheDir, openscadCmd: "/nonexistent/openscad" });

    const a = await r.analyse({ key: keyA, overhangDeg: 45 });
    expect(a.wall?.minMm).toBeCloseTo(2, 4);
    expect(a.thicknessFile).toBe("thickness.f32");
    const field = new Float32Array((await readFile(joinPath(cacheDir, "meshes", keyA, "thickness.f32"))).buffer.slice(0));
    expect(field.length).toBe(24);
    const written = (await stat(joinPath(cacheDir, "meshes", keyA, "analysis-45.json"))).mtimeMs;
    expect(await r.analyse({ key: keyA, overhangDeg: 45 })).toEqual(a);
    expect((await stat(joinPath(cacheDir, "meshes", keyA, "analysis-45.json"))).mtimeMs).toBe(written);

    const s = await r.slice({ key: keyA, axis: "z", at: 10 });
    expect(s.contours.map((c) => c.hole).sort()).toEqual([false, true]);
    expect(await stat(joinPath(cacheDir, "meshes", keyA, "slice-z-10.json")).then(() => true)).toBe(true);

    expect(await r.probe({ key: keyA, from: [10, 10, -0.5], axis: "z" })).toEqual({ inside: false, onSurface: false, low: null, high: 0, distance: null });
    expect(await stat(joinPath(cacheDir, "meshes", keyA, "probe-z-10_10_-0.5.json")).then(() => true)).toBe(true);

    const d = await r.deviation({ a: keyA, b: keyB });
    expect(d.fieldFile).toBe(`deviation-${keyA}.f32`);
    expect(d.max).toBeCloseTo(0.5, 5);
    expect(d.min).toBeCloseTo(-0.5, 5);

    const i = await r.interference({ a: { key: keyA, matrix: IDENTITY }, b: { key: keyA, matrix: translate(25, 0, 0) } });
    expect(i).toEqual({ gapMm: 5, overlapCm3: 0 });

    await expect(r.analyse({ key: "c".repeat(64), overhangDeg: 45 })).rejects.toThrow("no finished mesh");
    await expect(r.analyse({ key: "../x", overhangDeg: 45 })).rejects.toThrow("not a render key");
  });
});
