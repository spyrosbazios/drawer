/**
 * Mesh measurements on a triangle soup (9 floats per triangle): analysis, slices, probes,
 * deviation and the gap between two solids. Pure and synchronous: the renderer runs these in a
 * worker (see measure-worker.ts), tests call them directly.
 */
import type { Axis, MeshAnalysis, ProbeResult, SliceContour, Vec3 } from "@drawer/shared/api";
import { buildTopology, faces, weld, UnionFind, type Faces } from "./topology";
import { type Bvh, buildBvh, isInside, nearestDist2, rayCrossings, rayFirst } from "./bvh";

/** Bed contact: downward faces within this distance of the lowest z. */
const BASE_TOLERANCE = 0.05;
/** A face counts as facing straight down when its normal's z is below this. */
const BASE_NORMAL_Z = -0.99;
/** The thinnest wall must cover at least this area and share of the surface. */
const WALL_MIN_AREA = 1;
const WALL_MIN_SHARE = 0.002;
const MAX_CONTOUR_POINTS = 200;
const ROUND_RMS_SHARE = 0.02;

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

// ---- analyse ----------------------------------------------------------------------------

export type AnalysisResult = Omit<MeshAnalysis, "thickness">;

export function analyse(pos: Float32Array, overhangDeg: number, bvh?: Bvh, f = buildTopology(pos)): { analysis: AnalysisResult; thickness: Float32Array } {
  const n = pos.length / 9;

  let surface = 0;
  let minZ = Infinity;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) {
    const a = i % 3;
    const v = pos[i]!;
    if (v < lo[a]!) lo[a] = v;
    if (v > hi[a]!) hi[a] = v;
  }
  minZ = lo[2]!;
  for (let t = 0; t < n; t++) surface += f.area[t]!;

  const { shells, closed: watertight } = f;

  // Base and overhang.
  const isBase = new Uint8Array(n);
  let baseArea = 0;
  for (let t = 0; t < n; t++) {
    if (f.normal[t * 3 + 2]! >= BASE_NORMAL_Z) continue;
    const b = t * 9;
    if (pos[b + 2]! - minZ <= BASE_TOLERANCE && pos[b + 5]! - minZ <= BASE_TOLERANCE && pos[b + 8]! - minZ <= BASE_TOLERANCE) {
      isBase[t] = 1;
      baseArea += f.area[t]!;
    }
  }
  // A face's angle from vertical is asin(-nz) for a downward normal.
  const limit = Math.sin((Math.min(Math.max(overhangDeg, 0), 90) * Math.PI) / 180);
  const overhangUf = new UnionFind(f.vertexCount);
  const isOverhang = new Uint8Array(n);
  let overhangArea = 0;
  for (let t = 0; t < n; t++) {
    if (isBase[t] || f.area[t] === 0 || -f.normal[t * 3 + 2]! <= limit + 1e-9) continue;
    isOverhang[t] = 1;
    overhangArea += f.area[t]!;
    overhangUf.union(f.index[t * 3]!, f.index[t * 3 + 1]!);
    overhangUf.union(f.index[t * 3]!, f.index[t * 3 + 2]!);
  }
  let overhangAt: Vec3 | null = null;
  if (overhangArea > 0) {
    const regions = new Map<number, { area: number; x: number; y: number; z: number }>();
    for (let t = 0; t < n; t++) {
      if (!isOverhang[t]) continue;
      const root = overhangUf.find(f.index[t * 3]!);
      const a = f.area[t]!;
      const r = regions.get(root) ?? { area: 0, x: 0, y: 0, z: 0 };
      r.area += a;
      r.x += f.centroid[t * 3]! * a;
      r.y += f.centroid[t * 3 + 1]! * a;
      r.z += f.centroid[t * 3 + 2]! * a;
      regions.set(root, r);
    }
    let best: { area: number; x: number; y: number; z: number } | null = null;
    for (const r of regions.values()) if (!best || r.area > best.area) best = r;
    if (best && best.area > 0) overhangAt = [round(best.x / best.area), round(best.y / best.area), round(best.z / best.area)];
  }

  // Wall thickness: a ray from each centroid against its normal, to the first exit.
  const thickness = new Float32Array(n).fill(Number.NaN);
  let wall: MeshAnalysis["wall"] = null;
  if (watertight) {
    const b = bvh ?? buildBvh(pos);
    for (let t = 0; t < n; t++) {
      if (f.area[t] === 0) continue;
      const nx = f.normal[t * 3]!, ny = f.normal[t * 3 + 1]!, nz = f.normal[t * 3 + 2]!;
      const d = rayFirst(b, f.centroid[t * 3]!, f.centroid[t * 3 + 1]!, f.centroid[t * 3 + 2]!, -nx, -ny, -nz, 1e-6, Infinity, t);
      if (d !== Infinity) thickness[t] = d;
    }
    wall = thinnestWall(thickness, f, surface);
  }

  return {
    analysis: {
      shells,
      watertight,
      surfaceAreaMm2: round(surface),
      baseAreaMm2: round(baseArea),
      footprintMm2: n === 0 ? 0 : round((hi[0]! - lo[0]!) * (hi[1]! - lo[1]!)),
      overhang: { angle: overhangDeg, areaMm2: round(overhangArea), at: overhangAt },
      wall,
    },
    thickness,
  };
}

function thinnestWall(thickness: Float32Array, f: Faces, surface: number): MeshAnalysis["wall"] {
  const known: number[] = [];
  for (let t = 0; t < thickness.length; t++) if (!Number.isNaN(thickness[t]!)) known.push(t);
  if (known.length === 0) return null;
  known.sort((a, b) => thickness[a]! - thickness[b]!);
  const need = Math.max(WALL_MIN_AREA, WALL_MIN_SHARE * surface);
  let acc = 0;
  let biggest = known[0]!;
  for (const t of known) {
    acc += f.area[t]!;
    if (f.area[t]! > f.area[biggest]!) biggest = t;
    if (acc >= need) {
      return { minMm: round(thickness[t]!), at: [round(f.centroid[biggest * 3]!), round(f.centroid[biggest * 3 + 1]!), round(f.centroid[biggest * 3 + 2]!)] };
    }
  }
  // The whole surface is smaller than the threshold: the thickest value covers all of it.
  const last = known[known.length - 1]!;
  return { minMm: round(thickness[last]!), at: [round(f.centroid[biggest * 3]!), round(f.centroid[biggest * 3 + 1]!), round(f.centroid[biggest * 3 + 2]!)] };
}

// ---- slice ------------------------------------------------------------------------------

/** The two in-plane axes for a cut along `axis`, in x-y-z order. */
export function planeAxes(axis: Axis): [number, number] {
  return axis === "x" ? [1, 2] : axis === "y" ? [0, 2] : [0, 1];
}

export function slice(pos: Float32Array, axis: Axis, at: number, w = weld(pos)): SliceContour[] {
  const n = pos.length / 9;
  const ai = AXIS_INDEX[axis];
  const [ui, vi] = planeAxes(axis);
  // A crossing edge, keyed by its welded vertices, gets one point; each crossing triangle one segment.
  const pointOf = new Map<number, [number, number]>();
  const segsOf = new Map<number, number[]>();
  const segs: number[] = []; // 2 edge keys per segment
  const V = w.vertexCount;
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const above = [pos[b + ai]! >= at, pos[b + 3 + ai]! >= at, pos[b + 6 + ai]! >= at];
    if (above[0] === above[1] && above[1] === above[2]) continue;
    const ends: number[] = [];
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3;
      if (above[k] === above[k2]) continue;
      const va = w.index[t * 3 + k]!;
      const vb = w.index[t * 3 + k2]!;
      const key = va < vb ? va * V + vb : vb * V + va;
      if (!pointOf.has(key)) {
        // Interpolate from the lower vertex index so both triangles of the edge get the same point.
        const [p, q] = va < vb ? [b + k * 3, b + k2 * 3] : [b + k2 * 3, b + k * 3];
        const dp = pos[p + ai]! - at;
        const dq = pos[q + ai]! - at;
        const s = dp / (dp - dq);
        pointOf.set(key, [pos[p + ui]! + s * (pos[q + ui]! - pos[p + ui]!), pos[p + vi]! + s * (pos[q + vi]! - pos[p + vi]!)]);
      }
      ends.push(key);
    }
    if (ends.length !== 2) continue;
    const id = segs.length / 2;
    segs.push(ends[0]!, ends[1]!);
    for (const e of ends) {
      const list = segsOf.get(e);
      if (list) list.push(id);
      else segsOf.set(e, [id]);
    }
  }

  const loops: [number, number][][] = [];
  const used = new Uint8Array(segs.length / 2);
  for (let s0 = 0; s0 < used.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const start = segs[s0 * 2]!;
    let key = segs[s0 * 2 + 1]!;
    const keys = [start];
    let closed = false;
    for (;;) {
      if (key === start) {
        closed = true;
        break;
      }
      keys.push(key);
      const next = segsOf.get(key)?.find((s) => !used[s]);
      if (next === undefined) break;
      used[next] = 1;
      key = segs[next * 2] === key ? segs[next * 2 + 1]! : segs[next * 2]!;
    }
    if (!closed) continue;
    const pts: [number, number][] = [];
    for (const k of keys) {
      const p = pointOf.get(k)!;
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) pts.push(p);
    }
    const first = pts[0];
    const lastP = pts[pts.length - 1];
    if (pts.length > 1 && first && lastP && Math.abs(first[0] - lastP[0]) <= 1e-9 && Math.abs(first[1] - lastP[1]) <= 1e-9) pts.pop();
    const polygon = dropCollinear(pts);
    if (polygon.length >= 3) loops.push(polygon);
  }

  return loops.map((pts, i) => {
    let depth = 0;
    for (let j = 0; j < loops.length; j++) if (j !== i && pointInPolygon(pts[0]!, loops[j]!)) depth++;
    return contour(pts, depth % 2 === 1);
  });
}

function pointInPolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A point closer than this to the line through its neighbours lies on that line. */
const COLLINEAR_MM = 1e-6;

/**
 * The polygon without points that lie on the segment between their neighbours. A side quad of a
 * prism is two triangles, so the cut also crosses each quad's diagonal: that point lies on the chord
 * between two true vertices and moves along it with the cut height. Dropping it leaves the true
 * polygon, the same at every height.
 */
function dropCollinear(pts: [number, number][]): [number, number][] {
  const onSegment = (a: [number, number], p: [number, number], b: [number, number]): boolean => {
    const ux = b[0] - a[0], uy = b[1] - a[1];
    const len = Math.hypot(ux, uy);
    if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]) <= COLLINEAR_MM;
    if (Math.abs(ux * (p[1] - a[1]) - uy * (p[0] - a[0])) / len > COLLINEAR_MM) return false;
    return (p[0] - a[0]) * ux + (p[1] - a[1]) * uy >= 0 && (p[0] - b[0]) * ux + (p[1] - b[1]) * uy <= 0;
  };
  // One pass against the last kept point, then close the seam where the outline starts.
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const next = pts[(i + 1) % pts.length]!;
    const prev = out[out.length - 1] ?? pts[pts.length - 1]!;
    if (!onSegment(prev, p, next)) out.push(p);
  }
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    if (onSegment(out[out.length - 2]!, out[out.length - 1]!, out[0]!)) {
      out.pop();
      changed = true;
    }
    if (out.length > 3 && onSegment(out[out.length - 1]!, out[0]!, out[1]!)) {
      out.shift();
      changed = true;
    }
  }
  return out;
}

function contour(pts: [number, number][], hole: boolean): SliceContour {
  let a2 = 0, cx = 0, cy = 0;
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    const cross = x0 * y1 - x1 * y0;
    a2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
    if (x0 < minU) minU = x0;
    if (x0 > maxU) maxU = x0;
    if (y0 < minV) minV = y0;
    if (y0 > maxV) maxV = y0;
  }
  let centre: [number, number];
  if (Math.abs(a2) > 1e-12) centre = [cx / (3 * a2), cy / (3 * a2)];
  else centre = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const circle = fitCircle(pts);
  return {
    hole,
    areaMm2: round(Math.abs(a2) / 2),
    centre: [round(centre[0]), round(centre[1])],
    bbox: { min: [round(minU), round(minV)], max: [round(maxU), round(maxV)] },
    circle,
    points: simplify(pts).map(([u, v]) => [round(u), round(v)]),
  };
}

/** Samples per polygon edge for the circle fit. */
const SAMPLES_PER_EDGE = 16;
/** Above this many edges, fewer samples per edge (the outline is then fine already). */
const MAX_SAMPLES = 20_000;

/**
 * Points spread evenly along the closed outline: each edge gets the same number of samples at the
 * midpoints of equal sub-segments, weighted by the sub-segment's length, so the weighted sums are the
 * integrals along the perimeter. Independent of where the outline starts.
 */
function perimeterSamples(pts: [number, number][]): { x: Float64Array; y: Float64Array; w: Float64Array } {
  const n = pts.length;
  const k = Math.max(1, Math.min(SAMPLES_PER_EDGE, Math.floor(MAX_SAMPLES / n)));
  const x = new Float64Array(n * k), y = new Float64Array(n * k), w = new Float64Array(n * k);
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % n]!;
    const step = Math.hypot(x1 - x0, y1 - y0) / k;
    for (let j = 0; j < k; j++) {
      const f = (j + 0.5) / k;
      x[i * k + j] = x0 + f * (x1 - x0);
      y[i * k + j] = y0 + f * (y1 - y0);
      w[i * k + j] = step;
    }
  }
  return { x, y, w };
}

/**
 * Least-squares circle of the whole outline, not just its vertices: an algebraic (Kåsa) fit of points
 * spread evenly along the perimeter, solved around the weighted mean for conditioning; the radius is
 * the mean distance of those points from the centre and `rms` their deviation from it. So a polygon
 * is judged by its edges too: a regular n-gon with circumradius R reports a diameter between its
 * inscribed (2R·cos(π/n)) and circumscribed (2R) circles, about 2R·(1 − π²/(6n²)), and an rms that
 * shrinks with n (a hexagon is not round; a 64-gon is). A prism reports the same at every cut height.
 */
export function fitCircle(pts: [number, number][]): SliceContour["circle"] {
  const { x, y, w } = perimeterSamples(pts);
  let total = 0, mx = 0, my = 0;
  for (let i = 0; i < w.length; i++) {
    total += w[i]!;
    mx += w[i]! * x[i]!;
    my += w[i]! * y[i]!;
  }
  if (total === 0) return { centre: [round(pts[0]?.[0] ?? 0), round(pts[0]?.[1] ?? 0)], diameter: 0, rms: 0, round: false };
  mx /= total;
  my /= total;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    const u = x[i]! - mx, v = y[i]! - my;
    suu += c * u * u;
    suv += c * u * v;
    svv += c * v * v;
    suuu += c * u * u * u;
    svvv += c * v * v * v;
    suvv += c * u * v * v;
    svuu += c * v * u * u;
  }
  const det = suu * svv - suv * suv;
  let uc = 0, vc = 0;
  if (Math.abs(det) > 1e-18) {
    const b1 = (suuu + suvv) / 2;
    const b2 = (svvv + svuu) / 2;
    uc = (b1 * svv - b2 * suv) / det;
    vc = (b2 * suu - b1 * suv) / det;
  }
  const cxp = uc + mx, cyp = vc + my;
  let r = 0;
  for (let i = 0; i < w.length; i++) r += w[i]! * Math.hypot(x[i]! - cxp, y[i]! - cyp);
  r /= total;
  let e = 0;
  for (let i = 0; i < w.length; i++) e += w[i]! * (Math.hypot(x[i]! - cxp, y[i]! - cyp) - r) ** 2;
  const rms = Math.sqrt(e / total);
  const diameter = 2 * r;
  return { centre: [round(cxp), round(cyp)], diameter: round(diameter), rms: round(rms), round: diameter > 0 && rms < ROUND_RMS_SHARE * diameter };
}

function simplify(pts: [number, number][]): [number, number][] {
  if (pts.length <= MAX_CONTOUR_POINTS) return pts;
  const out: [number, number][] = [];
  const step = pts.length / MAX_CONTOUR_POINTS;
  for (let i = 0; i < MAX_CONTOUR_POINTS; i++) out.push(pts[Math.floor(i * step)]!);
  return out;
}

// ---- probe ------------------------------------------------------------------------------

/** A probe point closer than this to the surface lies on it. */
const ON_SURFACE_MM = 0.01;

/**
 * Whether `from` is in material, and the run of material or air through it along `axis`: from the
 * nearest crossing of the surface below to the nearest above. A point on the surface is reported as
 * such; `inside` and the run are then whatever the rays give, not a measurement.
 */
export function probe(b: Bvh, from: Vec3, axis: Axis): ProbeResult {
  const ai = AXIS_INDEX[axis];
  const dir: Vec3 = [0, 0, 0];
  dir[ai] = 1;
  const onSurface = nearestDist2(b, from[0], from[1], from[2], ON_SURFACE_MM * ON_SURFACE_MM * 4) <= ON_SURFACE_MM * ON_SURFACE_MM;
  const up = rayCrossings(b, from[0], from[1], from[2], dir[0], dir[1], dir[2], 0).t;
  const down = rayCrossings(b, from[0], from[1], from[2], -dir[0], -dir[1], -dir[2], 0).t;
  const inside = isInside(b, from[0], from[1], from[2]);
  const c = from[ai]!;
  const high = up.length > 0 ? c + up[0]! : null;
  const low = down.length > 0 ? c - down[0]! : null;
  return {
    inside,
    onSurface,
    low: low === null ? null : round(low),
    high: high === null ? null : round(high),
    distance: low === null || high === null ? null : round(high - low),
  };
}

// ---- deviation --------------------------------------------------------------------------

export interface DeviationResult {
  min: number;
  max: number;
  rms: number;
  p95: number;
  at: Vec3 | null;
  field: Float32Array;
}

/** Per triangle of B, the signed distance from its centroid to A's surface: negative inside A. */
export function deviation(a: Bvh, bPos: Float32Array, f = faces(bPos)): DeviationResult {
  const n = bPos.length / 9;
  const field = new Float32Array(n);
  let min = Infinity, max = -Infinity, sq = 0, total = 0;
  let worst = -1;
  for (let t = 0; t < n; t++) {
    const x = f.centroid[t * 3]!, y = f.centroid[t * 3 + 1]!, z = f.centroid[t * 3 + 2]!;
    let d = Math.sqrt(nearestDist2(a, x, y, z));
    if (d < 1e-6) d = 0;
    else if (isInside(a, x, y, z)) d = -d;
    field[t] = d;
    if (d < min) min = d;
    if (d > max) max = d;
    const area = f.area[t]!;
    sq += d * d * area;
    total += area;
    if (worst < 0 || Math.abs(d) > Math.abs(field[worst]!)) worst = t;
  }
  if (n === 0) return { min: 0, max: 0, rms: 0, p95: 0, at: null, field };
  // Area-weighted 95th percentile of |d|.
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => Math.abs(field[i]!) - Math.abs(field[j]!));
  let acc = 0;
  let p95 = Math.abs(field[idx[idx.length - 1]!]!);
  for (const i of idx) {
    acc += f.area[i]!;
    if (acc >= 0.95 * total) {
      p95 = Math.abs(field[i]!);
      break;
    }
  }
  return {
    min: round(min),
    max: round(max),
    rms: round(total > 0 ? Math.sqrt(sq / total) : 0),
    p95: round(p95),
    at: [round(f.centroid[worst * 3]!), round(f.centroid[worst * 3 + 1]!), round(f.centroid[worst * 3 + 2]!)],
    field,
  };
}

// ---- interference -----------------------------------------------------------------------

/** Applies a 4×4 row-major matrix to every corner. */
export function transform(pos: Float32Array, m: number[]): Float32Array {
  if (m.length !== 16) throw new Error("a placement matrix has 16 numbers");
  const out = new Float32Array(pos.length);
  const g = (i: number): number => m[i]!;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!;
    out[i] = g(0) * x + g(1) * y + g(2) * z + g(3);
    out[i + 1] = g(4) * x + g(5) * y + g(6) * z + g(7);
    out[i + 2] = g(8) * x + g(9) * y + g(10) * z + g(11);
  }
  return out;
}

export function bounds(pos: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) {
    const a = i % 3;
    const v = pos[i]!;
    if (v < min[a]!) min[a] = v;
    if (v > max[a]!) max[a] = v;
  }
  return { min, max };
}

/**
 * Smallest distance between two closed solids, 0 when they touch or overlap: an edge of one
 * crossing the other's surface, or a vertex of one inside the other, is contact. Otherwise the
 * smallest vertex-to-surface distance either way (edge-to-edge closest pairs are not searched).
 */
export function gap(a: Bvh, b: Bvh): number {
  for (const [p, q] of [[a, b], [b, a]] as const) {
    const pos = p.pos;
    for (let i = 0; i < pos.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const o = i + k * 3;
        const e = i + ((k + 1) % 3) * 3;
        const ox = pos[o]!, oy = pos[o + 1]!, oz = pos[o + 2]!;
        if (rayFirst(q, ox, oy, oz, pos[e]! - ox, pos[e + 1]! - oy, pos[e + 2]! - oz, -1e-9, 1 + 1e-9) !== Infinity) return 0;
      }
    }
  }
  let best = Infinity;
  for (const [p, q] of [[a, b], [b, a]] as const) {
    const pos = p.pos;
    // A solid entirely inside the other: one vertex decides it.
    if (pos.length >= 3 && isInside(q, pos[0]!, pos[1]!, pos[2]!)) return 0;
    for (let i = 0; i < pos.length; i += 3) {
      const d2 = nearestDist2(q, pos[i]!, pos[i + 1]!, pos[i + 2]!, best * best);
      if (d2 < best * best) best = Math.sqrt(d2);
    }
  }
  return round(best);
}

/** Signed volume (mm³) of a closed soup. */
export function volume(pos: Float32Array): number {
  let v6 = 0;
  for (let b = 0; b < pos.length; b += 9) {
    const x0 = pos[b]!, y0 = pos[b + 1]!, z0 = pos[b + 2]!;
    const x1 = pos[b + 3]!, y1 = pos[b + 4]!, z1 = pos[b + 5]!;
    const x2 = pos[b + 6]!, y2 = pos[b + 7]!, z2 = pos[b + 8]!;
    v6 += x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2);
  }
  return v6 / 6;
}

export function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
