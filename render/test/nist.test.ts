/**
 * The fits against NIST's reference results: the practice data sets of the Algorithm Testing System
 * (https://www.nist.gov/pml/sensor-science/dimensional-metrology/algorithm-testing), a work of the US
 * government and so in the public domain. `nist-fits.json` holds every plane, sphere and cylinder case
 * of at most 200 points, 23 of the 30 per shape, with NIST's own least-squares answer beside it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Vec3 } from "@drawer/shared/api";
import { fitPrimitive, signedResidual, type Primitive } from "../src/fit";
import { dot, length, reject, sub } from "../src/vectors";

interface Case {
  name: string;
  /** x y z per point. */
  points: number[];
  /** Plane: point, normal. Sphere: centre, diameter. Cylinder: point on the axis, axis, diameter. */
  fit: number[];
}

const KINDS = ["plane", "sphere", "cylinder"] as const;
const cases = JSON.parse(readFileSync(join(import.meta.dir, "nist-fits.json"), "utf8")) as Record<(typeof KINDS)[number], Case[]>;

/** The fit's residual may differ from the reference's by this much, in the data's own length unit. */
const RMS_TOLERANCE = 1e-9;
/** Sizes and positions agree to this share of the shape's size; directions to this much of 1 - |cos|. */
const PARAMETER_TOLERANCE = 1e-6;

const vec = (values: number[], at: number): Vec3 => [values[at]!, values[at + 1]!, values[at + 2]!];

function reference(kind: (typeof KINDS)[number], fit: number[]): Primitive {
  const origin = vec(fit, 0);
  if (kind === "sphere") return { kind, origin, radius: fit[3]! / 2 };
  const axis = vec(fit, 3);
  const size = length(axis);
  const direction: Vec3 = [axis[0] / size, axis[1] / size, axis[2] / size];
  return kind === "plane" ? { kind, origin, direction } : { kind, origin, direction, radius: fit[6]! / 2 };
}

function rms(shape: Primitive, points: readonly Vec3[]): number {
  return Math.sqrt(points.reduce((sum, point) => sum + signedResidual(shape, point) ** 2, 0) / points.length);
}

for (const kind of KINDS) {
  test(`${kind} fits reproduce NIST's reference results`, () => {
    expect(cases[kind]).toHaveLength(23);
    for (const { name, points: flat, fit } of cases[kind]) {
      const points = Array.from({ length: flat.length / 3 }, (_, i) => vec(flat, i * 3));
      const expected = reference(kind, fit);
      const found = fitPrimitive(kind, points);
      if (found === null || found.kind !== expected.kind) throw new Error(`${name}: no ${kind} was fitted`);
      expect(Math.abs(rms(found, points) - rms(expected, points)), `${name}: residual`).toBeLessThan(RMS_TOLERANCE);

      const offset = sub(expected.origin, found.origin);
      if (found.kind === "sphere" && expected.kind === "sphere") {
        expect(Math.abs(found.radius - expected.radius) / expected.radius, `${name}: radius`).toBeLessThan(PARAMETER_TOLERANCE);
        expect(length(offset) / expected.radius, `${name}: centre`).toBeLessThan(PARAMETER_TOLERANCE);
        continue;
      }
      if (found.kind === "sphere" || expected.kind === "sphere") continue;
      expect(1 - Math.abs(dot(found.direction, expected.direction)), `${name}: direction`).toBeLessThan(PARAMETER_TOLERANCE);
      if (found.kind === "cylinder" && expected.kind === "cylinder") {
        expect(Math.abs(found.radius - expected.radius) / expected.radius, `${name}: radius`).toBeLessThan(PARAMETER_TOLERANCE);
        // The reference names a point on its axis: it must lie on the fitted axis too.
        expect(length(reject(offset, found.direction)) / expected.radius, `${name}: axis position`).toBeLessThan(PARAMETER_TOLERANCE);
      } else {
        // The reference names a point on its plane: it must lie on the fitted plane too.
        const extent = Math.max(...points.map((point) => length(sub(point, expected.origin))));
        expect(Math.abs(dot(offset, found.direction)) / extent, `${name}: plane position`).toBeLessThan(PARAMETER_TOLERANCE);
      }
    }
  });
}
