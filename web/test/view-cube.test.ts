import { describe, expect, test } from "bun:test";
import { VIEW_DIRECTIONS, cornerDirection } from "@/lib/camera-rig";
import { CORNER_SIGNS, CUBE_FACES, cornerLabel, faceBasis, faceTransform } from "@/lib/view-cube-geometry";

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
const cross = (a: readonly number[], b: readonly number[]) => [(a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0), (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0), (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0)];

describe("view cube", () => {
  test("every face's element axes are a proper rotation (no mirrored text)", () => {
    for (const face of CUBE_FACES) {
      const { right, down, normal } = faceBasis(face);
      expect(Math.hypot(...right)).toBeCloseTo(1);
      expect(dot(right, down)).toBeCloseTo(0);
      expect(dot(right, normal)).toBeCloseTo(0);
      expect(cross(right, down).map((v) => v + 0)).toEqual(normal.map((v) => v + 0));
    }
  });

  test("the front face sits on the near side with its text running along +x and down along -z", () => {
    const front = CUBE_FACES.find((f) => f.view === "front");
    expect(front && faceBasis(front)).toEqual({ right: [1, 0, 0], down: [0, 0, -1], normal: [0, 1, 0] });
    expect(front && faceTransform(front, 26)).toBe("matrix3d(1,0,0,0,0,0,-1,0,0,1,0,0,0,26,0,1)");
  });

  test("a face snaps to the direction named by its view; the corners give the iso weights with their signs", () => {
    for (const face of CUBE_FACES) expect(dot(VIEW_DIRECTIONS[face.view], face.normal)).toBeGreaterThan(0.99);
    expect(cornerDirection(1, -1, 1)).toEqual(VIEW_DIRECTIONS.iso);
    expect(cornerDirection(-1, 1, -1)).toEqual([-0.65, 1, -0.8]);
    expect(CORNER_SIGNS).toHaveLength(8);
    expect(cornerLabel([1, -1, 1])).toBe("top front right");
  });
});
