import { FEATURE_KINDS, type Feature, type FeatureKind, type Vec3 } from "@drawer/shared/api";
import { closestPoint, type Bvh } from "./bvh";
import { fitPrimitive, primitiveNormal, signedResidual, type Primitive } from "./fit";
import { scanNoise, weldTolerance } from "./scan";
import type { Topology } from "./topology";
import { dot, readVec, scale, sub } from "./vectors";

const MAX_FEATURES = 40;
const MAX_SAMPLES = 3000;
const STEP_DOT = Math.cos((50 * Math.PI) / 180);
const FIT_DOT = Math.cos((40 * Math.PI) / 180);

function normalDot(normals: Float64Array, a: number, b: number): number {
  const i = a * 3,
    j = b * 3;
  return normals[i]! * normals[j]! + normals[i + 1]! * normals[j + 1]! + normals[i + 2]! * normals[j + 2]!;
}

/** A stable, connected neighbourhood starts each fit. Dihedral breaks keep sharp features apart. */
function patch(topology: Topology, seed: number, available: Uint8Array, seen: Uint32Array, visit: number, queue: Uint32Array): Uint32Array {
  let end = 1;
  queue[0] = seed;
  seen[seed] = visit;
  for (let i = 0; i < end; i++) {
    const t = queue[i]!;
    for (let k = 0; k < 3; k++) {
      const next = topology.neighbours[t * 3 + k]!;
      if (next < 0 || !available[next] || seen[next] === visit || topology.area[next] === 0) continue;
      if (normalDot(topology.normal, t, next) < STEP_DOT) continue;
      seen[next] = visit;
      queue[end++] = next;
    }
  }
  return queue.subarray(0, end);
}

function sample(pos: Float32Array, topology: Topology, region: Uint32Array): { points: Vec3[]; normals: Vec3[] } {
  const points: Vec3[] = [],
    normals: Vec3[] = [];
  const seen = new Set<number>();
  const stride = Math.max(1, Math.ceil((region.length * 3) / MAX_SAMPLES));
  for (let i = 0; i < region.length; i += stride) {
    const t = region[i]!;
    for (let k = 0; k < 3; k++) {
      const vert = topology.index[t * 3 + k]!;
      if (seen.has(vert)) continue;
      seen.add(vert);
      points.push(readVec(pos, topology.representatives[vert]! * 3));
      normals.push(readVec(topology.normal, t * 3));
    }
  }
  return { points, normals };
}

function choose(pos: Float32Array, topology: Topology, region: Uint32Array, tolerance: number, kind?: FeatureKind, outlierShare = 0): Primitive | null {
  const { points, normals } = sample(pos, topology, region);
  let best: Primitive | null = null;
  let bestError = Infinity;
  for (const type of kind ? [kind] : FEATURE_KINDS) {
    const shape = fitPrimitive(type, points, normals, outlierShare);
    if (!shape) continue;
    let sum = 0;
    for (const p of points) sum += signedResidual(shape, p) ** 2;
    const error = Math.sqrt(sum / points.length);
    if (error <= tolerance) return shape;
    if (error < bestError) {
      bestError = error;
      best = shape;
    }
  }
  return best;
}

/** Repeatedly keep the connected triangles that agree in normal and distance with the fitted shape. */
function coherent(
  pos: Float32Array,
  topology: Topology,
  shape: Primitive,
  candidates: Uint32Array,
  tolerance: number,
  seed: number,
  allowed: Uint8Array,
  visited: Uint32Array,
  visit: number,
  queue: Uint32Array,
): Uint32Array {
  for (const t of candidates) {
    const centroid = readVec(topology.centroid, t * 3);
    const normal = readVec(topology.normal, t * 3);
    const facing = Math.abs(dot(normal, primitiveNormal(shape, centroid))) >= FIT_DOT;
    // Use vertices: a coarse triangle's centre can lie inside the fitted curved surface.
    let maxDistance = 0;
    for (let k = 0; k < 3; k++) {
      maxDistance = Math.max(maxDistance, Math.abs(signedResidual(shape, readVec(pos, t * 9 + k * 3))));
    }
    allowed[t] = facing && maxDistance <= tolerance ? 1 : 0;
  }
  const region = allowed[seed] ? patch(topology, seed, allowed, visited, visit, queue) : queue.subarray(0, 0);
  for (const t of candidates) allowed[t] = 0;
  return region;
}

function metrics(pos: Float32Array, topology: Topology, shape: Primitive, region: Uint32Array): Feature {
  const points = new Set<number>();
  let areaMm2 = 0,
    alignment = 0,
    squared = 0,
    maxError = 0,
    lo = Infinity,
    hi = -Infinity;
  for (const t of region) {
    const centre = readVec(topology.centroid, t * 3);
    const area = topology.area[t]!;
    areaMm2 += area;
    alignment += area * dot(readVec(topology.normal, t * 3), primitiveNormal(shape, centre));
    for (let k = 0; k < 3; k++) {
      const id = topology.index[t * 3 + k]!;
      if (points.has(id)) continue;
      points.add(id);
      const p = readVec(pos, topology.representatives[id]! * 3);
      const err = Math.abs(signedResidual(shape, p));
      squared += err * err;
      maxError = Math.max(maxError, err);
      if (shape.kind === "cylinder") {
        const along = dot(sub(p, shape.origin), shape.direction);
        lo = Math.min(lo, along);
        hi = Math.max(hi, along);
      }
    }
  }
  const length = shape.kind === "cylinder" ? hi - lo : null;
  const total = shape.kind === "plane" ? areaMm2 : shape.kind === "sphere" ? 4 * Math.PI * shape.radius ** 2 : 2 * Math.PI * shape.radius * (length ?? 0);
  return {
    kind: shape.kind,
    origin: shape.origin,
    direction: shape.kind === "sphere" ? null : shape.kind === "plane" && alignment < 0 ? scale(shape.direction, -1) : shape.direction,
    diameter: shape.kind === "plane" ? null : 2 * shape.radius,
    length,
    side: shape.kind === "plane" ? null : alignment < 0 ? "hole" : "boss",
    areaMm2,
    rms: Math.sqrt(squared / points.size),
    maxError,
    coverage: total > 0 ? Math.min(1, areaMm2 / total) : 0,
  };
}

function grower(pos: Float32Array, topology: Topology, noise: number) {
  const n = topology.area.length;
  const available = new Uint8Array(n).fill(1);
  const candidates = new Uint32Array(n);
  const queue = new Uint32Array(n);
  const visited = new Uint32Array(n);
  const allowed = new Uint8Array(n);
  const edgeLength = weldTolerance(pos) / 0.0001;
  const tolerance = Math.max(1e-7, edgeLength * 0.005, Math.min(edgeLength * 0.15, noise * 4));
  let visit = 0;
  return {
    available,
    grow(seed: number, kind?: FeatureKind): { feature: Feature | null; region: Uint32Array } {
      const initial = patch(topology, seed, available, visited, ++visit, candidates);
      let shape = choose(pos, topology, initial, tolerance, kind);
      if (!shape) return { feature: null, region: initial };
      let region = initial;
      for (let i = 0; i < 5; i++) {
        let next = coherent(pos, topology, shape, initial, tolerance, seed, allowed, visited, ++visit, queue);
        if (next.length === 0 && i === 0) {
          const local = initial.subarray(0, 64);
          const retry = choose(pos, topology, local, tolerance, kind, 0.25);
          if (retry) {
            shape = retry;
            next = coherent(pos, topology, shape, initial, tolerance, seed, allowed, visited, ++visit, queue);
          }
          if (next.length === 0) return { feature: null, region: local };
        }
        if (next.length === 0) return { feature: null, region };
        if (next.length === region.length) break;
        region = next;
        const refined = choose(pos, topology, region, tolerance, kind ?? shape.kind);
        if (!refined) return { feature: null, region: initial };
        shape = refined;
      }
      const feature = metrics(pos, topology, shape, region);
      return { feature: feature.coverage > 0 && feature.rms <= tolerance ? feature : null, region };
    },
  };
}

export function fitAt(pos: Float32Array, topology: Topology, bvh: Bvh, at: Vec3, kind?: FeatureKind, noise = scanNoise(pos, topology)): Feature | null {
  const closest = closestPoint(bvh, ...at);
  return closest ? grower(pos, topology, noise).grow(closest.triangle, kind).feature : null;
}

export function extractFeatures(pos: Float32Array, topology: Topology, noise = scanNoise(pos, topology)): { features: Feature[]; values: Float32Array } {
  const n = topology.area.length;
  const score = new Float32Array(n);
  const order = new Uint32Array(n);
  for (let t = 0; t < n; t++) {
    order[t] = t;
    for (let k = 0; k < 3; k++) {
      const next = topology.neighbours[t * 3 + k]!;
      if (next >= 0) score[t] = Math.max(score[t]!, 1 - normalDot(topology.normal, t, next));
    }
  }
  order.sort((a, b) => score[a]! - score[b]! || topology.area[b]! - topology.area[a]!);
  const growerInstance = grower(pos, topology, noise);
  const found: { feature: Feature; index: number }[] = [];
  const values = new Float32Array(n).fill(-1);
  for (const t of order) {
    if (growerInstance.available[t] === 0) continue;
    const { feature, region } = growerInstance.grow(t);
    if (feature) found.push({ feature, index: found.length });
    for (const f of region) {
      growerInstance.available[f] = 0;
      if (feature) values[f] = found.length - 1;
    }
  }
  found.sort((a, b) => b.feature.areaMm2 - a.feature.areaMm2);
  const remap = new Int32Array(found.length).fill(-1);
  const best = found.slice(0, MAX_FEATURES);
  for (const [i, item] of best.entries()) remap[item.index] = i;
  for (let i = 0; i < n; i++) if (values[i]! >= 0) values[i] = remap[values[i]!]!;
  return { features: best.map(({ feature }) => feature), values };
}
