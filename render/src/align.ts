/** Principal-axis starts refined by Chen–Medioni point-to-plane ICP. */
import type { AlignResult, Feature, Pose, Vec3 } from "@drawer/shared/api";
import { closestPoint, type Bvh } from "./bvh";
import { centroid, principal } from "./fit";
import { solveCholesky } from "./linalg";
import type { Topology } from "./topology";
import { add, cross, dot, length, planeBasis, readVec, reject, scale, sub, unit } from "./vectors";
import { extractFeatures } from "./features";

type Rotation = [Vec3, Vec3, Vec3];
interface Located {
  axes: Rotation;
  centre: Vec3;
  samples: { p: Vec3; normal: Vec3 }[];
}
interface Candidate {
  rotation: Rotation;
  offset: Vec3;
  rms: number;
}

const rotate = ([x, y, z]: Rotation, p: Vec3): Vec3 => [dot(x, p), dot(y, p), dot(z, p)];
const transpose = ([a, b, c]: Rotation): Rotation => [
  [a[0], b[0], c[0]],
  [a[1], b[1], c[1]],
  [a[2], b[2], c[2]],
];
const multiply = (a: Rotation, b: Rotation): Rotation => {
  const columns = transpose(b);
  return a.map((row) => rotate(columns, row)) as Rotation;
};

function euler(rotation: Rotation): Vec3 {
  const [a, b, c] = rotation;
  const cy = Math.hypot(a[0], b[0]);
  const y = Math.atan2(-c[0], cy);
  const [x, z] = cy > 1e-10 ? [Math.atan2(c[1], c[2]), Math.atan2(b[0], a[0])] : [Math.atan2(-b[2], b[1]), 0];
  return [x, y, z].map((r) => (r * 180) / Math.PI) as Vec3;
}

function exponential(rotation: Vec3): Rotation {
  const angle = length(rotation);
  if (angle < 1e-14)
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  const [x, y, z] = scale(rotation, 1 / angle);
  const c = Math.cos(angle),
    s = Math.sin(angle),
    t = 1 - c;
  return [
    [c + x * x * t, x * y * t - z * s, x * z * t + y * s],
    [y * x * t + z * s, c + y * y * t, y * z * t - x * s],
    [z * x * t - y * s, z * y * t + x * s, c + z * z * t],
  ];
}

function radical(index: number, base: number): number {
  let n = index,
    fraction = 1 / base,
    value = 0;
  while (n > 0) {
    value += (n % base) * fraction;
    n = Math.floor(n / base);
    fraction /= base;
  }
  return value;
}

/** Deterministic stratification by surface area and low-discrepancy points within triangles. */
export function surfaceSamples(pos: Float32Array, topology: Topology, count: number): Located["samples"] {
  const area = topology.area.reduce((total, a) => total + a, 0);
  if (!(area > 0)) return [];
  const result: Located["samples"] = [];
  let t = 0,
    areaAt = topology.area[0]!;
  for (let i = 0; i < count; i++) {
    const wanted = (area * (i + 0.5)) / count;
    while (areaAt < wanted && t + 1 < topology.area.length) areaAt += topology.area[++t]!;
    const a = readVec(pos, t * 9),
      b = readVec(pos, t * 9 + 3),
      c = readVec(pos, t * 9 + 6);
    const s = Math.sqrt(radical(i + 1, 2)),
      u = radical(i + 1, 3);
    result.push({ p: add(scale(a, 1 - s), add(scale(b, s * (1 - u)), scale(c, s * u))), normal: readVec(topology.normal, t * 3) });
  }
  return result;
}

function locate(pos: Float32Array, topology: Topology): Located {
  const samples = surfaceSamples(pos, topology, 2048);
  if (!samples.length) throw new Error("alignment needs a non-empty surface");
  const points = samples.map(({ p }) => p);
  const centre = centroid(points);
  const [, middle, largest] = principal(points, centre);
  const x = largest!.vector,
    y = middle!.vector;
  return { axes: [x, y, cross(x, y)], centre, samples };
}

function poseOf(c: Candidate, centre: Vec3): Pose & { rms: number } {
  return { rotate: euler(c.rotation), translate: sub(c.offset, rotate(c.rotation, centre)), rms: c.rms };
}

function score(pose: Candidate, points: Located["samples"], centre: Vec3, target: Bvh): number {
  let sq = 0;
  for (const { p } of points) {
    const moved = add(rotate(pose.rotation, sub(p, centre)), pose.offset);
    sq += closestPoint(target, ...moved)?.distance2 ?? Infinity;
  }
  return Math.sqrt(sq / points.length);
}

/** Reject long pairs and opposed normals, even when a partial fit could improve its apparent score. */
function icp(initial: Candidate, source: Located, points: Located["samples"], target: Bvh, surface: Topology, iterations: number): Candidate {
  let pose = initial;
  let best = { ...pose, rms: score(pose, points, source.centre, target) };
  for (let iteration = 0; iteration < iterations; iteration++) {
    const pairs = points.flatMap(({ p, normal }) => {
      const rel = rotate(pose.rotation, sub(p, source.centre));
      const moved = add(rel, pose.offset);
      const closest = closestPoint(target, ...moved);
      if (!closest) return [];
      const n = readVec(surface.normal, closest.triangle * 3);
      return [{ rel, delta: sub(closest.point, moved), d2: closest.distance2, n, facing: dot(rotate(pose.rotation, normal), n) > 0 }];
    });
    const distances = Float64Array.from(pairs, (p) => p.d2).sort();
    const bound2 = Math.max(1e-12, 9 * distances[distances.length >>> 1]!);
    const normal = new Float64Array(36),
      rhs = new Float64Array(6);
    let used = 0;
    for (const p of pairs) {
      if (!p.facing || p.d2 > bound2) continue;
      const row = [...cross(p.rel, p.n), ...p.n];
      const value = dot(p.delta, p.n);
      for (let i = 0; i < 6; i++) {
        rhs[i]! += row[i]! * value;
        for (let j = 0; j <= i; j++) normal[i * 6 + j]! += row[i]! * row[j]!;
      }
      used++;
    }
    if (used < 6) break;
    for (let i = 0; i < 6; i++) normal[i * 7]! += 1e-8 * Math.max(1, normal[i * 7]!);
    const update = solveCholesky(normal, rhs);
    if (!update) break;
    const spin = readVec(update, 0),
      move = readVec(update, 3);
    pose = { rotation: multiply(exponential(spin), pose.rotation), offset: add(pose.offset, move), rms: 0 };
    pose.rms = score(pose, points, source.centre, target);
    if (pose.rms < best.rms) best = pose;
    if (length(spin) < 1e-8 && length(move) < 1e-7) break;
  }
  return best;
}

function samePose(a: Candidate, b: Candidate, linear: number): boolean {
  return length(sub(a.offset, b.offset)) <= linear && a.rotation.every((axis, i) => dot(axis, b.rotation[i]!) > 0.99985);
}

export function register(sourcePos: Float32Array, sourceTopology: Topology, target: Bvh, targetTopology: Topology): AlignResult {
  const source = locate(sourcePos, sourceTopology);
  const destination = locate(target.pos, targetTopology);
  const coarse = source.samples.filter((_, i) => i % 4 === 0);
  const candidates: Candidate[] = [];
  for (const [x, y] of [
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 2],
    [2, 0],
    [2, 1],
  ] as const) {
    for (const signX of [-1, 1])
      for (const signY of [-1, 1]) {
        const u = scale(destination.axes[x], signX),
          v = scale(destination.axes[y], signY);
        const rotation = multiply(transpose([u, v, cross(u, v)]), source.axes);
        candidates.push(icp({ rotation, offset: destination.centre, rms: 0 }, source, coarse, target, targetTopology, 8));
      }
  }
  candidates.sort((a, b) => a.rms - b.rms);
  for (const c of candidates) c.rms = score(c, source.samples, source.centre, target);
  candidates.sort((a, b) => a.rms - b.rms);
  const span = Math.hypot(target.bounds[3]! - target.bounds[0]!, target.bounds[4]! - target.bounds[1]!, target.bounds[5]! - target.bounds[2]!);
  const linear = Math.max(1e-6, span * 0.0005);
  const refined = candidates
    .slice(0, 8)
    .map((c) => icp(c, source, source.samples, target, targetTopology, 35))
    .sort((a, b) => a.rms - b.rms);
  const best = refined[0]!;
  const alternatives = [best];
  for (const c of [...refined.slice(1), ...candidates.slice(8)]) {
    if (c.rms <= best.rms * 1.05 + linear && !alternatives.some((a) => samePose(a, c, linear))) alternatives.push(c);
  }
  alternatives.sort((a, b) => a.rms - b.rms);
  return { ...poseOf(best, source.centre), ambiguous: alternatives.filter((c) => c !== best).map((c) => poseOf(c, source.centre)) };
}

/** A plane at least this share of the largest plane's area is an equally good base: the other way up is offered too. */
const RIVAL_BASE = 0.9;

function datumPose(pos: Float32Array, source: Located, plane: Feature | undefined, cylinder: Feature | undefined): Pose {
  const z = plane?.direction ? scale(plane.direction, -1) : (cylinder?.direction ?? source.axes[2]);
  const flat = source.samples.map(({ p }) => reject(sub(p, source.centre), z));
  const x = unit(reject(principal(flat, [0, 0, 0])[2]!.vector, z));
  const right = length(x) > 0 ? x : planeBasis(z)[0];
  const frame: Rotation = [right, cross(z, right), z];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    const q = rotate(frame, readVec(pos, i));
    for (let d = 0; d < 3; d++) min[d] = Math.min(min[d]!, q[d]!);
  }
  if (plane) min[2] = dot(z, plane.origin);
  if (cylinder?.direction && Math.abs(dot(cylinder.direction, z)) > 0.95) {
    min[0] = dot(frame[0], cylinder.origin);
    min[1] = dot(frame[1], cylinder.origin);
  }
  return { rotate: euler(frame), translate: scale(min, -1) };
}

export function datum(pos: Float32Array, topology: Topology, noiseMm: number): AlignResult {
  const source = locate(pos, topology);
  const { features } = extractFeatures(pos, topology, noiseMm);
  const planes = features.filter((f) => f.kind === "plane").sort((a, b) => b.areaMm2 - a.areaMm2);
  const cylinder = features.find((f) => f.kind === "cylinder");
  const [base, ...others] = planes;
  const rivals = base ? others.filter((p) => p.areaMm2 >= base.areaMm2 * RIVAL_BASE) : [];
  return { ...datumPose(pos, source, base, cylinder), rms: null, ambiguous: rivals.map((p) => ({ ...datumPose(pos, source, p, cylinder), rms: null })) };
}
