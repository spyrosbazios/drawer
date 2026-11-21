import type { DeviationStats, Vec3 } from "@drawer/shared/api";
import type { Bvh } from "./bvh";
import { surfaceDistance } from "./pseudonormal";
import type { Topology } from "./topology";
import { round } from "./measure";
import { add, length, readVec, scale, sub } from "./vectors";

const MAX_SAMPLES = 8_000_000;

export interface DeviationResult extends DeviationStats {
  reverse: DeviationStats;
  at: Vec3 | null;
  field: Float32Array;
}

/** Each triangle is split into n² equal-area cells at a spacing determined by the tolerance. */
function direction(source: Bvh, surface: Topology, target: Bvh, targetSurface: Topology, tol: number, field?: Float32Array) {
  const steps = new Uint32Array(surface.area.length);
  let count = 0;
  for (let t = 0; t < steps.length; t++) {
    if (surface.area[t] === 0) continue;
    const a = readVec(source.pos, t * 9), b = readVec(source.pos, t * 9 + 3), c = readVec(source.pos, t * 9 + 6);
    const samples = Math.max(1, Math.ceil(Math.max(length(sub(a, b)), length(sub(b, c)), length(sub(c, a))) / (tol * 2)));
    count += samples * samples;
    if (count > MAX_SAMPLES) throw new Error("the tolerance needs too many surface samples; use a larger tolerance or retessellate the mesh");
    steps[t] = samples;
  }
  if (!count) throw new Error("deviation needs meshes with nonzero surface area");

  const sampleDistance = surfaceDistance(target, targetSurface);
  const distances = new Float64Array(count);
  const areas = new Float64Array(count);
  let index = 0, total = 0, outOfRange = 0, squares = 0, min = Infinity, max = -Infinity, worst = 0;
  let at: Vec3 | null = null;
  for (let t = 0; t < steps.length; t++) {
    const n = steps[t]!;
    if (!n) continue;
    const a = readVec(source.pos, t * 9), b = readVec(source.pos, t * 9 + 3), c = readVec(source.pos, t * 9 + 6);
    const ab = scale(sub(b, a), 1 / n), ac = scale(sub(c, a), 1 / n);
    const weight = surface.area[t]! / (n * n);
    total += surface.area[t]!;
    let sum = 0;
    function sample(u: number, v: number): void {
      const p = add(a, add(scale(ab, u), scale(ac, v)));
      const raw = sampleDistance(p).distance;
      const d = Math.abs(raw) < 1e-7 ? 0 : raw;
      const abs = Math.abs(d);
      distances[index] = abs;
      areas[index++] = weight;
      sum += d;
      squares += d * d * weight;
      if (abs > tol) outOfRange += weight;
      min = Math.min(min, d);
      max = Math.max(max, d);
      if (abs > worst) {
        worst = abs;
        at = p;
      }
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      sample(i + 1 / 3, j + 1 / 3);
      if (i + j + 1 < n) sample(i + 2 / 3, j + 2 / 3);
    }
    if (field) field[t] = sum / (n * n);
  }
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => distances[a]! - distances[b]!);
  let accumulated = 0, p95 = worst;
  for (const i of order) {
    accumulated += areas[i]!;
    if (accumulated >= total * 0.95) {
      p95 = distances[i]!;
      break;
    }
  }
  const stats = { min: round(min), max: round(max), rms: round(Math.sqrt(squares / total)), p95: round(p95), within: Math.max(0, 1 - outOfRange / total) };
  return { stats, worst, at };
}

export function deviation(a: Bvh, ta: Topology, b: Bvh, tb: Topology, tol: number): DeviationResult {
  if (!(tol > 0 && Number.isFinite(tol))) throw new Error("deviation tolerance must be positive");
  const field = new Float32Array(tb.area.length);
  if (a.pos === b.pos && ta.area.some((area) => area > 0)) {
    const stats = { min: 0, max: 0, rms: 0, p95: 0, within: 1 };
    return { ...stats, field, reverse: stats, at: null };
  }
  const forward = direction(b, tb, a, ta, tol, field);
  const reverse = direction(a, ta, b, tb, tol);
  const at = reverse.worst > forward.worst ? reverse.at : forward.at;
  return { ...forward.stats, reverse: reverse.stats, at, field };
}
