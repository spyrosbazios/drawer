import { MAX_SCAN_TRIANGLES, type MeshFormat, type ScanUnit } from "@drawer/shared/api";
import { symmetricEigen3 } from "./linalg";
import { computeMeshInfo, parseMesh, toBinaryStl } from "./mesh";
import { buildTopology, faces, weld, type Topology } from "./topology";

const UNIT_MM: Record<ScanUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };
export const PROXY_TRIANGLES = 200_000;

function median(values: Float64Array): number {
  if (values.length === 0) return 0;
  values.sort();
  const mid = values.length >>> 1;
  return values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
}

export function weldTolerance(pos: Float32Array): number {
  const lengths = new Float64Array(pos.length / 3);
  let used = 0;
  for (let t = 0; t < pos.length; t += 9) {
    for (let i = 0; i < 9; i += 3) {
      const a = t + i,
        b = t + ((i + 3) % 9);
      const length = Math.hypot(pos[a]! - pos[b]!, pos[a + 1]! - pos[b + 1]!, pos[a + 2]! - pos[b + 2]!);
      if (length > 0) lengths[used++] = length;
    }
  }
  return median(lengths.subarray(0, used)) * 0.0001;
}

/** Median distance from each vertex to the least-squares plane of its neighbouring vertices. */
export function scanNoise(pos: Float32Array, topology: Topology): number {
  const { index, representatives, neighbours, vertexCount } = topology;
  const stats = new Float64Array(vertexCount * 10);
  const add = (a: number, b: number) => {
    const ai = representatives[a]! * 3,
      bi = representatives[b]! * 3;
    const x = pos[bi]! - pos[ai]!,
      y = pos[bi + 1]! - pos[ai + 1]!,
      z = pos[bi + 2]! - pos[ai + 2]!;
    const o = a * 10;
    stats[o]! += 1;
    stats[o + 1]! += x;
    stats[o + 2]! += y;
    stats[o + 3]! += z;
    stats[o + 4]! += x * x;
    stats[o + 5]! += x * y;
    stats[o + 6]! += x * z;
    stats[o + 7]! += y * y;
    stats[o + 8]! += y * z;
    stats[o + 9]! += z * z;
  };
  for (let t = 0; t < index.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 3 + k;
      if (neighbours[o]! >= 0 && neighbours[o]! < t) continue;
      const a = index[o]!,
        b = index[t * 3 + ((k + 1) % 3)]!;
      if (a !== b) {
        add(a, b);
        add(b, a);
      }
    }
  }
  const distances = new Float64Array(vertexCount);
  const cov = new Float64Array(9);
  let used = 0;
  for (let v = 0; v < vertexCount; v++) {
    const o = v * 10;
    const n = stats[o]!;
    if (n < 3) continue;
    const x = stats[o + 1]! / n,
      y = stats[o + 2]! / n,
      z = stats[o + 3]! / n;
    cov[0] = stats[o + 4]! / n - x * x;
    cov[1] = cov[3] = stats[o + 5]! / n - x * y;
    cov[2] = cov[6] = stats[o + 6]! / n - x * z;
    cov[4] = stats[o + 7]! / n - y * y;
    cov[5] = cov[7] = stats[o + 8]! / n - y * z;
    cov[8] = stats[o + 9]! / n - z * z;
    const eig = symmetricEigen3(cov);
    if (!(eig[1]!.value > eig[2]!.value * 1e-10)) continue;
    const [nx, ny, nz] = eig[0]!.vector;
    distances[used++] = Math.abs(nx * x + ny * y + nz * z);
  }
  return median(distances.subarray(0, used));
}

/** Resolve winding across each manifold edge. Only a closed shell has a determinate outward side. */
function orient(pos: Float32Array, topology: Topology): void {
  const { index, area, neighbours } = topology;
  const n = pos.length / 9;
  const sign = new Int8Array(n);
  const queue = new Uint32Array(n);
  for (let first = 0; first < n; first++) {
    if (sign[first]) continue;
    let end = 1,
      facing = 0,
      volume6 = 0;
    let closed = true;
    queue[0] = first;
    sign[first] = 1;
    for (let i = 0; i < end; i++) {
      const t = queue[i]!;
      facing += area[t]! * sign[t]!;
      const o = t * 9;
      const x = pos[o]!,
        y = pos[o + 1]!,
        z = pos[o + 2]!;
      const u = pos[o + 3]!,
        v = pos[o + 4]!,
        w = pos[o + 5]!;
      const a = pos[o + 6]!,
        b = pos[o + 7]!,
        c = pos[o + 8]!;
      volume6 += sign[t]! * (x * (v * c - w * b) + y * (w * a - u * c) + z * (u * b - v * a));
      for (let k = 0; k < 3; k++) {
        const next = neighbours[t * 3 + k]!;
        if (next < 0) {
          closed = false;
          continue;
        }
        const from = index[t * 3 + k]!,
          to = index[t * 3 + ((k + 1) % 3)]!;
        let expected = sign[t]!;
        for (let j = 0; j < 3; j++) {
          if (index[next * 3 + j] === from && index[next * 3 + ((j + 1) % 3)] === to) expected = -expected;
        }
        if (sign[next] && sign[next] !== expected) throw new Error("scan has contradictory face winding; repair the surface and export it again");
        if (sign[next]) continue;
        sign[next] = expected;
        queue[end++] = next;
      }
    }
    const reverse = (closed ? volume6 : facing) < 0;
    for (const t of queue.subarray(0, end)) {
      if (sign[t]! < 0 === reverse) continue;
      const o = t * 9;
      for (let axis = 0; axis < 3; axis++) {
        const tmp = pos[o + 3 + axis]!;
        pos[o + 3 + axis] = pos[o + 6 + axis]!;
        pos[o + 6 + axis] = tmp;
      }
    }
  }
}

export function normalizeScan(format: MeshFormat, bytes: Uint8Array, units?: ScanUnit) {
  if (format !== "3mf" && !units) throw new Error("Choose the original scan units: mm, cm, m or in");
  const mesh = parseMesh(format, bytes, MAX_SCAN_TRIANGLES);
  const pos = mesh.positions;
  const originalTriangles = pos.length / 9;
  if (originalTriangles === 0) throw new Error("point cloud has no faces; export a triangulated surface");
  const unit = mesh.unit ?? units!;
  const scale = units && format !== "3mf" ? UNIT_MM[units] : 1;
  for (let i = 0; i < pos.length; i++) {
    pos[i]! *= scale;
    if (!Number.isFinite(pos[i])) throw new Error("scan coordinates must be finite in millimetres");
  }

  const joined = weld(pos, weldTolerance(pos));
  for (let c = 0; c < joined.index.length; c++) {
    const r = joined.representatives[joined.index[c]!]! * 3;
    pos.copyWithin(c * 3, r, r + 3);
  }
  const { area } = faces(pos);
  let kept = 0;
  for (let t = 0; t < area.length; t++) {
    if (area[t]! === 0) continue;
    pos.copyWithin(kept++ * 9, t * 9, t * 9 + 9);
  }
  const degenerateTriangles = originalTriangles - kept;
  const cleaned = pos.subarray(0, kept * 9);
  const all = buildTopology(cleaned);
  const componentArea = new Float64Array(kept);
  let totalArea = 0;
  for (let t = 0; t < kept; t++) {
    totalArea += all.area[t]!;
    componentArea[all.component[t]!]! += all.area[t]!;
  }
  let remaining = 0;
  for (let t = 0; t < kept; t++) {
    if (componentArea[all.component[t]!]! < totalArea * 0.01) continue;
    pos.copyWithin(remaining++ * 9, t * 9, t * 9 + 9);
  }
  if (remaining === 0) throw new Error("no surface remains after cleaning; export a triangulated surface with larger connected pieces");
  const surface = pos.subarray(0, remaining * 9);
  const topology = remaining === kept ? all : buildTopology(surface);
  const noiseMm = scanNoise(surface, topology);
  orient(surface, topology);
  const info = computeMeshInfo({ format: "stl", positions: surface }, { ...topology, oriented: topology.closed });
  return { bytes: toBinaryStl(surface), info, originalTriangles, degenerateTriangles, debrisTriangles: kept - remaining, noiseMm, unit };
}

/** Uniform vertex clustering. Recompute the clusters from the original vertices at each cell size. */
export function clusterProxy(pos: Float32Array, limit = PROXY_TRIANGLES): { positions: Float32Array; source: Uint32Array } {
  const welded = weld(pos);
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) {
    const axis = i % 3;
    lo[axis] = Math.min(lo[axis]!, pos[i]!);
    hi[axis] = Math.max(hi[axis]!, pos[i]!);
  }
  const extent = Math.max(...hi.map((v, i) => v - lo[i]!));
  const clusterOf = new Uint32Array(welded.vertexCount);
  const coordinates = new Float64Array(welded.vertexCount * 4);
  const keep = new Uint32Array(limit * 3);
  const source = new Uint32Array(limit);

  let cell = extent / Math.sqrt(limit);
  let smallCell = 0,
    largeCell = Infinity;
  for (let attempt = 0; attempt < 32; attempt++) {
    const cells = new Map<string, number>();
    for (let v = 0; v < welded.vertexCount; v++) {
      const o = welded.representatives[v]! * 3;
      const x = pos[o]!,
        y = pos[o + 1]!,
        z = pos[o + 2]!;
      const key = `${Math.floor((x - lo[0]!) / cell)},${Math.floor((y - lo[1]!) / cell)},${Math.floor((z - lo[2]!) / cell)}`;
      let id = cells.get(key);
      if (id === undefined) {
        id = cells.size;
        cells.set(key, id);
        coordinates.fill(0, id * 4, id * 4 + 4);
      }
      clusterOf[v] = id;
      coordinates[id * 4]! += x;
      coordinates[id * 4 + 1]! += y;
      coordinates[id * 4 + 2]! += z;
      coordinates[id * 4 + 3]! += 1;
    }
    let used = 0;
    for (let i = 0; i < welded.index.length; i += 3) {
      const a = clusterOf[welded.index[i]!]!,
        b = clusterOf[welded.index[i + 1]!]!,
        c = clusterOf[welded.index[i + 2]!]!;
      if (a === b || b === c || c === a) continue;
      if (used === keep.length) {
        used += 3;
        break;
      }
      source[used / 3] = i / 3;
      keep[used++] = a;
      keep[used++] = b;
      keep[used++] = c;
    }
    if (used > 0 && used <= keep.length) {
      const result = new Float32Array(used * 3);
      for (let i = 0; i < used; i++) {
        const o = keep[i]! * 4;
        for (let axis = 0; axis < 3; axis++) result[i * 3 + axis] = coordinates[o + axis]! / coordinates[o + 3]!;
      }
      return { positions: result, source: source.subarray(0, used / 3) };
    }
    if (used === 0) largeCell = cell;
    else smallCell = cell;
    cell = Number.isFinite(largeCell) ? (smallCell + largeCell) / 2 : cell * 1.5;
  }
  throw new Error("could not make a preview mesh; decimate the input mesh before uploading");
}
