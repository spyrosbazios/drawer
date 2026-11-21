import { expect, test } from "bun:test";
import { buildBvh } from "../src/bvh";
import { extractFeatures, fitAt } from "../src/features";
import { fitPrimitive, signedResidual } from "../src/fit";
import { shadow, slice } from "../src/measure";
import { buildTopology } from "../src/topology";
import { dot, length, sub } from "../src/vectors";
import type { Vec3 } from "@drawer/shared/api";
import { box } from "./shapes";

const cube = () => box([0, 0, 0], [10, 10, 10]);

function random() {
  let seed = 731;
  const uniform = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const gaussian = () => 0.012 * Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, gaussian };
}

const ORIGIN: Vec3 = [13, -20, 5];
const RADIUS = 8;

for (const kind of ["plane", "cylinder", "sphere"] as const) {
  test(`${kind} fit on a noisy partial surface with 25% outliers`, () => {
    const { uniform, gaussian } = random();
    const points: Vec3[] = [],
      normals: Vec3[] = [];
    for (let i = 0; i < 150; i++) {
      const theta = (uniform() * Math.PI) / 2;
      const latitude = ((uniform() - 0.5) * Math.PI) / 2;
      const n: Vec3 =
        kind === "plane"
          ? [0, 0, 1]
          : kind === "cylinder"
            ? [Math.cos(theta), Math.sin(theta), 0]
            : [Math.cos(theta) * Math.cos(latitude), Math.sin(theta) * Math.cos(latitude), Math.sin(latitude)];
      const z = kind === "sphere" ? RADIUS * n[2] : 15 * (uniform() - 0.5);
      const p: Vec3 = kind === "plane" ? [8 * uniform(), 8 * uniform(), 0] : [RADIUS * n[0], RADIUS * n[1], z];
      points.push([ORIGIN[0] + p[0] + gaussian(), ORIGIN[1] + p[1] + gaussian(), ORIGIN[2] + p[2] + gaussian()]);
      normals.push(n);
    }
    for (let i = 0; i < 50; i++) {
      points.push([ORIGIN[0] + uniform() * 45, ORIGIN[1] + uniform() * 45, ORIGIN[2] + uniform() * 45]);
      normals.push([uniform(), uniform(), uniform()]);
    }
    const fit = fitPrimitive(kind, points, normals, 0.25);
    expect(fit?.kind).toBe(kind);
    if (!fit) throw new Error("expected fit");
    if (fit.kind === "plane") {
      expect(Math.abs(signedResidual(fit, ORIGIN))).toBeLessThan(0.02);
      expect(Math.abs(dot(fit.direction, [0, 0, 1]))).toBeGreaterThan(0.9999);
    } else {
      expect(Math.abs(fit.radius - RADIUS)).toBeLessThan(0.08);
      if (fit.kind === "sphere") expect(length(sub(fit.origin, ORIGIN))).toBeLessThan(0.12);
      else {
        expect(Math.abs(dot(fit.direction, [0, 0, 1]))).toBeGreaterThan(0.9999);
        expect(Math.hypot(fit.origin[0] - ORIGIN[0], fit.origin[1] - ORIGIN[1])).toBeLessThan(0.12);
      }
    }
  });
}

test("the worker's feature algorithm finds the faces of a cube and assigns each triangle a feature", () => {
  const mesh = cube();
  const topology = buildTopology(mesh);
  const result = extractFeatures(mesh, topology, 0);
  expect(result.features.map((f) => [f.kind, f.areaMm2, f.rms])).toEqual(Array.from({ length: 6 }, () => ["plane", 100, 0]));
  expect(new Set(result.values).size).toBe(6);
  const fit = fitAt(mesh, topology, buildBvh(mesh), [3, 4, 10], "plane", 0);
  expect(fit?.direction).toEqual([0, 0, 1]);
});

test("fit reads the diameter and coverage on a quarter-cylinder mesh", () => {
  const pos: number[] = [];
  const p = (t: number, z: number): Vec3 => [RADIUS * Math.cos(t), RADIUS * Math.sin(t), z];
  for (let i = 0; i < 30; i++)
    for (let j = 0; j < 12; j++) {
      const theta = (i * Math.PI) / 60,
        next = ((i + 1) * Math.PI) / 60;
      const a = p(theta, j),
        b = p(next, j),
        c = p(next, j + 1),
        d = p(theta, j + 1);
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  const mesh = Float32Array.from(pos);
  const fit = fitAt(mesh, buildTopology(mesh), buildBvh(mesh), p(0.3, 4), "cylinder", 0.01);
  expect(fit?.kind).toBe("cylinder");
  expect(Math.abs((fit?.diameter ?? 0) - 16)).toBeLessThan(0.01);
  expect(Math.abs((fit?.coverage ?? 0) - 0.25)).toBeLessThan(0.01);
  expect(fit?.side).toBe("boss");
});

test("section returns a full open chain and shadow projects the whole solid", () => {
  const plate = new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10]);
  const cut = slice(plate, "z", 5);
  expect(cut.contours).toEqual([]);
  expect(cut.open).toHaveLength(1);
  expect(cut.open[0]).toHaveLength(3);
  expect(cut.open[0]?.map((p) => p[0]).sort((a, b) => a - b)).toEqual([0, 5, 10]);
  const outlines = shadow(cube(), "z");
  expect(outlines).toHaveLength(1);
  expect(outlines[0]).toMatchObject({ areaMm2: 100, bbox: { min: [0, 0], max: [10, 10] } });
});
