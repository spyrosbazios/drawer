import { expect, test } from "bun:test";
import { buildBvh, closestPoint, withinRadius } from "../src/bvh";
import { solveCholesky, symmetricEigen3 } from "../src/linalg";
import { buildTopology } from "../src/topology";

test("welding closes a shared edge within tolerance", () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0.001, 1, 0, 0.001, 1, 1, 0]);
  expect(buildTopology(pos).shells).toBe(2);
  const joined = buildTopology(pos, 0.002);
  expect(joined.shells).toBe(1);
  expect(joined.vertexCount).toBe(4);
  expect(joined.neighbours[1]).toBe(1);
  expect(joined.neighbours[3]).toBe(0);
  expect(joined.closed).toBe(false);
  expect(joined.area[0]).toBe(0.5);
  expect(joined.normal.slice(0, 3)).toEqual(new Float64Array([0, 0, 1]));
});

test("BVH returns the closest point with its triangle and filters by surface distance", () => {
  const mesh = buildBvh(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 1, 0, 2, 0, 1, 2]));
  expect(closestPoint(mesh, 0.25, 0.25, 1.75)).toEqual({ triangle: 1, point: [0.25, 0.25, 2], distance2: 0.0625 });
  expect(closestPoint(mesh, 0.25, 0.25, 1.75, 0.01)).toBeNull();
  expect(withinRadius(mesh, 0.25, 0.25, 1.75, 0.25)).toEqual([1]);
  expect(withinRadius(mesh, 0.25, 0.25, 1, 1)).toEqual([0, 1]);
});

test("symmetric eigenpairs reconstruct an off-diagonal matrix", () => {
  const matrix = [4, 1, 2, 1, 3, 0, 2, 0, 2];
  const pairs = symmetricEigen3(matrix);
  expect(pairs[0]!.value).toBeLessThan(pairs[1]!.value);
  expect(pairs[1]!.value).toBeLessThan(pairs[2]!.value);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const value = pairs.reduce((sum, pair) => sum + pair.value * pair.vector[i]! * pair.vector[j]!, 0);
      expect(value).toBeCloseTo(matrix[i * 3 + j]!, 10);
    }
  }
});

test("Cholesky solves a coupled system and rejects a singular system", () => {
  const x = solveCholesky([4, 1, 1, 3], [6, 7]);
  expect(x?.[0]).toBeCloseTo(1, 12);
  expect(x?.[1]).toBeCloseTo(2, 12);
  expect(solveCholesky([1, 1, 1, 1], [1, 1])).toBeNull();
});
