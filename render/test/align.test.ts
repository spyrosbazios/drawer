import { expect, test } from "bun:test";
import type { Pose, Vec3 } from "@drawer/shared/api";
import { datum, register } from "../src/align";
import { buildBvh } from "../src/bvh";
import { transform } from "../src/measure";
import { buildTopology } from "../src/topology";
import { box, join } from "./shapes";

function matrix({ rotate, translate }: Pose): number[] {
  const [x, y, z] = rotate.map((d) => (d * Math.PI) / 180) as Vec3;
  const [cx, cy, cz] = [Math.cos(x), Math.cos(y), Math.cos(z)];
  const [sx, sy, sz] = [Math.sin(x), Math.sin(y), Math.sin(z)];
  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    translate[0],
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    translate[1],
    -sy,
    cy * sx,
    cy * cx,
    translate[2],
    0,
    0,
    0,
    1,
  ];
}

test("ICP recovers the physical placement of an asymmetric surface at a seeded random pose", () => {
  let seed = 283719;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const next = (span: number): Vec3 => [span * (random() - 0.5), span * (random() - 0.5), span * (random() - 0.5)];
  const target = join(box([0, 0, 0], [25, 15, 4]), box([3, 5, 5], [7, 10, 11]), box([12, 1, 4], [22, 5, 7]));
  const moved = transform(target, matrix({ rotate: next(240), translate: next(120) }));
  const fit = register(moved, buildTopology(moved), buildBvh(target), buildTopology(target));
  expect(fit.rms).toBeLessThan(0.005);
  expect(fit.ambiguous).toHaveLength(0);
  const back = transform(moved, matrix(fit));
  const maximum = back.reduce((max, x, i) => Math.max(max, Math.abs(x - target[i]!)), 0);
  expect(maximum).toBeLessThan(0.02);
});

test("a symmetric cube exposes distinct alternative fits", () => {
  const solid = box([0, 0, 0], [10, 10, 10]);
  const moved = transform(solid, matrix({ rotate: [14, 55, 31], translate: [8, -10, 34] }));
  const fit = register(moved, buildTopology(moved), buildBvh(solid), buildTopology(solid));
  expect(fit.rms).toBeLessThan(0.005);
  expect(fit.ambiguous.length).toBeGreaterThan(0);
  expect(fit.ambiguous.every((p) => p.rms < 0.01)).toBe(true);
});

test("a datum puts the largest plane at Z=0", () => {
  const original = new Float32Array([0, 0, 3, 20, 0, 3, 20, 10, 3, 0, 0, 3, 20, 10, 3, 0, 10, 3]);
  const moved = transform(original, matrix({ rotate: [14, 55, 31], translate: [8, -10, 34] }));
  const fit = datum(moved, buildTopology(moved), 0);
  expect(fit.rms).toBeNull();
  const framed = transform(moved, matrix(fit));
  expect(Math.max(...framed.filter((_, i) => i % 3 === 2).map(Math.abs))).toBeLessThan(0.001);
});

test("interference against an open scan measures depth and uses the printer clearance", async () => {
  const { createRenderer } = await import("../src/index");
  const { toBinaryStl } = await import("../src/mesh");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = await mkdtemp("/tmp/drawer-open-clash-");
  try {
    const surface = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0]);
    const aFile = join(root, "open.stl"),
      bFile = join(root, "part.stl");
    await Bun.write(aFile, toBinaryStl(surface));
    await Bun.write(bFile, toBinaryStl(box([3, 3, 0], [6, 6, 4])));
    const renderer = createRenderer({ cacheDir: join(root, "cache"), openscadCmd: "/unavailable" });
    const a = await renderer.mesh({ file: aFile, searchPaths: [] });
    const b = await renderer.mesh({ file: bFile, searchPaths: [] });
    const m = (z: number) => matrix({ rotate: [0, 0, 0], translate: [0, 0, z] });
    const near = await renderer.interference({ a: { key: a.key, matrix: m(0) }, b: { key: b.key, matrix: m(-0.1) }, clearanceMm: 0.2 });
    const deep = await renderer.interference({ a: { key: a.key, matrix: m(0) }, b: { key: b.key, matrix: m(-0.5) }, clearanceMm: 0.2 });
    expect(near.overlapCm3).toBeNull();
    expect(near.penetration?.depthMm).toBeCloseTo(0.1, 5);
    expect(near.penetration?.limitMm).toBe(0.2);
    expect(deep.penetration).toEqual({ depthMm: 0.5, limitMm: 0.2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
