/**
 * Orthogonal distance fits following Forbes DITC 140/89 and Shakarji, J. Res. NIST 103 (1998).
 * Plane from covariance. Radial shapes use an algebraic start and damped Gauss–Newton
 * on distances to the surface, with cylinder updates in the tangent space of its unit axis.
 */
import type { FeatureKind, Vec3 } from "@drawer/shared/api";
import { solveCholesky, symmetricEigen3 } from "./linalg";
import { add, dot, length, planeBasis, reject, scale, sub, unit } from "./vectors";

export type Primitive =
  { kind: "plane"; origin: Vec3; direction: Vec3 } | { kind: "sphere"; origin: Vec3; radius: number } | { kind: "cylinder"; origin: Vec3; direction: Vec3; radius: number };

export function centroid(points: readonly Vec3[]): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  for (const p of points) {
    sum[0] += p[0];
    sum[1] += p[1];
    sum[2] += p[2];
  }
  return scale(sum, 1 / points.length);
}

export function principal(points: readonly Vec3[], origin: Vec3) {
  const matrix = new Float64Array(9);
  for (const p of points) {
    const [x, y, z] = sub(p, origin);
    matrix[0]! += x * x;
    matrix[1]! += x * y;
    matrix[2]! += x * z;
    matrix[4]! += y * y;
    matrix[5]! += y * z;
    matrix[8]! += z * z;
  }
  matrix[3] = matrix[1]!;
  matrix[6] = matrix[2]!;
  matrix[7] = matrix[5]!;
  return symmetricEigen3(matrix);
}

class LeastSquares {
  readonly matrix: Float64Array;
  readonly rhs: Float64Array;
  constructor(readonly size: number) {
    this.matrix = new Float64Array(size * size);
    this.rhs = new Float64Array(size);
  }

  add(row: readonly number[], value: number): void {
    for (let i = 0; i < this.size; i++) {
      this.rhs[i]! += row[i]! * value;
      for (let j = 0; j <= i; j++) this.matrix[i * this.size + j]! += row[i]! * row[j]!;
    }
  }

  solve(damping = 0): Float64Array | null {
    for (let i = 0; i < this.size; i++) {
      const d = i * this.size + i;
      this.matrix[d]! += damping * Math.max(this.matrix[d]!, 1);
    }
    return solveCholesky(this.matrix, this.rhs);
  }
}

export function signedResidual(shape: Primitive, point: Vec3): number {
  const rel = sub(point, shape.origin);
  if (shape.kind === "plane") return dot(rel, shape.direction);
  return length(shape.kind === "cylinder" ? reject(rel, shape.direction) : rel) - shape.radius;
}

export function primitiveNormal(shape: Primitive, point: Vec3): Vec3 {
  if (shape.kind === "plane") return shape.direction;
  const rel = sub(point, shape.origin);
  return unit(shape.kind === "cylinder" ? reject(rel, shape.direction) : rel);
}

function squaredError(shape: Primitive, points: readonly Vec3[]): number {
  let error = 0;
  for (const p of points) error += signedResidual(shape, p) ** 2;
  return error;
}

function refine(initial: Exclude<Primitive, { kind: "plane" }>, points: readonly Vec3[], gauge: Vec3): typeof initial {
  let shape = initial;
  let error = squaredError(shape, points);
  let damping = 1e-6;
  for (let i = 0; i < 40; i++) {
    const current = shape;
    const cylinder = current.kind === "cylinder";
    const [u, v] = cylinder
      ? planeBasis(current.direction)
      : ([
          [1, 0, 0],
          [0, 1, 0],
        ] as [Vec3, Vec3]);
    const fit = new LeastSquares(cylinder ? 5 : 4);
    for (const point of points) {
      const rel = sub(point, current.origin);
      const along = cylinder ? dot(rel, current.direction) : 0;
      const radial = cylinder ? sub(rel, scale(current.direction, along)) : rel;
      const distance = length(radial);
      if (distance <= 1e-15) continue;
      const normal = scale(radial, 1 / distance);
      const jx = -dot(normal, u),
        jy = -dot(normal, v);
      const row = cylinder ? [jx, jy, jx * along, jy * along, -1] : [jx, jy, -normal[2], -1];
      fit.add(row, current.radius - distance);
    }
    const step = fit.solve(damping);
    if (!step) break;
    const delta = add(scale(u, step[0]!), scale(v, step[1]!));
    let next: typeof initial;
    if (cylinder) {
      const direction = unit(add(current.direction, add(scale(u, step[2]!), scale(v, step[3]!))));
      const moved = add(current.origin, delta);
      const origin = add(moved, scale(direction, dot(sub(gauge, moved), direction)));
      next = { kind: "cylinder", origin, direction, radius: current.radius + step[4]! };
    } else {
      next = { kind: "sphere", origin: add(add(current.origin, delta), [0, 0, step[2]!]), radius: current.radius + step[3]! };
    }
    const nextError = next.radius > 0 ? squaredError(next, points) : Infinity;
    if (nextError < error) {
      shape = next;
      if (error - nextError <= 1e-13 * Math.max(1, error)) break;
      error = nextError;
      damping = Math.max(1e-12, damping * 0.2);
    } else {
      damping *= 10;
      if (damping > 1e8) break;
    }
  }
  return shape;
}

function algebraic(points: readonly Vec3[], centre: Vec3, axis?: Vec3): Exclude<Primitive, { kind: "plane" }> | null {
  const fit = new LeastSquares(axis ? 3 : 4);
  const [u, v] = axis
    ? planeBasis(axis)
    : ([
        [1, 0, 0],
        [0, 1, 0],
      ] as [Vec3, Vec3]);
  for (const p of points) {
    const rel = sub(p, centre);
    const x = dot(u, rel),
      y = dot(v, rel);
    if (axis) fit.add([2 * x, 2 * y, 1], x * x + y * y);
    else fit.add([2 * x, 2 * y, 2 * rel[2], 1], dot(rel, rel));
  }
  const answer = fit.solve();
  if (!answer) return null;
  let delta = add(scale(u, answer[0]!), scale(v, answer[1]!));
  if (!axis) delta = add(delta, [0, 0, answer[2]!]);
  const radius = Math.sqrt(answer[fit.size - 1]! + dot(delta, delta));
  if (!(radius > 0 && Number.isFinite(radius))) return null;
  const origin = add(centre, delta);
  return axis ? { kind: "cylinder", origin, direction: axis, radius } : { kind: "sphere", origin, radius };
}

function leastSquaresFit(kind: FeatureKind, points: readonly Vec3[], normals?: readonly Vec3[]): Primitive | null {
  if (points.length < (kind === "plane" ? 3 : kind === "sphere" ? 4 : 6)) return null;
  const origin = centroid(points);
  if (kind === "sphere") {
    const initial = algebraic(points, origin);
    return initial && refine(initial, points, origin);
  }
  const axes = principal(points, origin);
  if (kind === "plane") return axes[1]!.value > axes[2]!.value * 1e-12 ? { kind, origin, direction: axes[0]!.vector } : null;

  const options = axes.map((axis) => axis.vector);
  if (normals && normals.length >= 3) options.unshift(principal(normals, [0, 0, 0])[0]!.vector);
  const diameter = 2 * Math.sqrt(axes[2]!.value / points.length);
  let best: Primitive | null = null;
  let error = Infinity;
  for (const axis of options) {
    const initial = algebraic(points, origin, axis);
    if (!initial || initial.radius > diameter * 100) continue;
    const trial = refine(initial, points, origin);
    const next = squaredError(trial, points);
    if (trial.radius <= diameter * 100 && next < error) {
      best = trial;
      error = next;
    }
  }
  return best;
}

/**
 * Least squares on a smooth region, optionally rejecting an outlier fraction before the final fit.
 * Deterministic sample starts are scored by their trimmed squared residuals over the whole region.
 */
export function fitPrimitive(kind: FeatureKind, points: readonly Vec3[], normals?: readonly Vec3[], outlierShare = 0): Primitive | null {
  const initial = leastSquaresFit(kind, points, normals);
  if (!outlierShare || points.length < 20) return initial;
  const n = Math.ceil(points.length * (1 - outlierShare));
  const ranked = (shape: Primitive) =>
    points
      .map((p, i) => ({ i, error: signedResidual(shape, p) ** 2 }))
      .sort((a, b) => a.error - b.error)
      .slice(0, n);
  let best = initial ? ranked(initial) : null;
  let loss = best?.reduce((sum, x) => sum + x.error, 0) ?? Infinity;
  const sampleSize = kind === "plane" ? 3 : kind === "sphere" ? 4 : 8;
  let seed = 123456;
  for (let attempt = 0; attempt < 42; attempt++) {
    const indices = new Set<number>();
    while (indices.size < sampleSize) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      indices.add(Math.floor((seed / 2 ** 32) * points.length));
    }
    const ids = [...indices];
    const trial = leastSquaresFit(
      kind,
      ids.map((i) => points[i]!),
      normals ? ids.map((i) => normals[i]!) : undefined,
    );
    if (!trial) continue;
    const inliers = ranked(trial);
    const candidate = inliers.reduce((sum, x) => sum + x.error, 0);
    if (candidate < loss) {
      loss = candidate;
      best = inliers;
    }
  }
  return best
    ? leastSquaresFit(
        kind,
        best.map(({ i }) => points[i]!),
        normals ? best.map(({ i }) => normals[i]!) : undefined,
      )
    : initial;
}
