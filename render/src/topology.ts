/** Welded mesh connectivity and per-triangle surface geometry. */
// ---- welding ----------------------------------------------------------------------------

export interface Welded {
  /** Vertex index per corner, 3 per triangle. */
  index: Uint32Array;
  vertexCount: number;
  /** Corner containing each welded vertex’s representative coordinates. */
  representatives: Uint32Array;
}

/** Join corners within a Euclidean tolerance, or exactly when the tolerance is zero. */
export function weld(pos: Float32Array, tolerance = 0): Welded {
  const exact = weldExact(pos);
  if (tolerance === 0) return exact;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("weld tolerance must be finite and non-negative");
  const cells = new Map<string, number[]>();
  const remap = new Uint32Array(exact.vertexCount);
  const representatives = new Uint32Array(exact.vertexCount);
  const tol2 = tolerance * tolerance;
  let vertexCount = 0;
  for (let v = 0; v < exact.vertexCount; v++) {
    const corner = exact.representatives[v]!;
    const offset = corner * 3;
    const x = pos[offset]!,
      y = pos[offset + 1]!,
      z = pos[offset + 2]!;
    const ix = Math.floor(x / tolerance),
      iy = Math.floor(y / tolerance),
      iz = Math.floor(z / tolerance);
    let best = tol2;
    let nearest = -1;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          const others = cells.get(`${ix + i},${iy + j},${iz + k}`);
          if (!others) continue;
          for (const other of others) {
            const o = representatives[other]! * 3;
            const d = (pos[o]! - x) ** 2 + (pos[o + 1]! - y) ** 2 + (pos[o + 2]! - z) ** 2;
            if (d <= best) {
              best = d;
              nearest = other;
            }
          }
        }
      }
    }
    if (nearest < 0) {
      nearest = vertexCount++;
      representatives[nearest] = corner;
      const key = `${ix},${iy},${iz}`;
      const cell = cells.get(key);
      if (cell) cell.push(nearest);
      else cells.set(key, [nearest]);
    }
    remap[v] = nearest;
  }
  return { index: exact.index.map((v) => remap[v]!), vertexCount, representatives: representatives.subarray(0, vertexCount) };
}

function weldExact(pos: Float32Array): Welded {
  const corners = pos.length / 3;
  const norm = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i++) norm[i] = pos[i]! + 0; // -0 → 0
  const bits = new Uint32Array(norm.buffer);
  let size = 1;
  while (size < corners * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1); // corner index of the first occurrence
  const vertexOf = new Uint32Array(corners);
  const index = new Uint32Array(corners);
  const representatives = new Uint32Array(corners);
  let vertexCount = 0;
  for (let c = 0; c < corners; c++) {
    const a = bits[c * 3]!,
      b = bits[c * 3 + 1]!,
      d = bits[c * 3 + 2]!;
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(d, 83492791)) & mask;
    for (;;) {
      const slot = table[h]!;
      if (slot < 0) {
        table[h] = c;
        vertexOf[c] = vertexCount;
        representatives[vertexCount] = c;
        index[c] = vertexCount++;
        break;
      }
      if (bits[slot * 3] === a && bits[slot * 3 + 1] === b && bits[slot * 3 + 2] === d) {
        index[c] = vertexOf[slot]!;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return { index, vertexCount, representatives: representatives.subarray(0, vertexCount) };
}

export class UnionFind {
  readonly parent: Uint32Array;
  constructor(n: number) {
    this.parent = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r]!;
    while (this.parent[i] !== r) {
      const next = this.parent[i]!;
      this.parent[i] = r;
      i = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

// ---- per-triangle basics ----------------------------------------------------------------

export interface Faces {
  /** Unit normal, 3 per triangle (0 for a degenerate triangle). */
  normal: Float64Array;
  area: Float64Array;
  /** 3 per triangle. */
  centroid: Float64Array;
}

export function faces(pos: Float32Array): Faces {
  const n = pos.length / 9;
  const normal = new Float64Array(n * 3);
  const area = new Float64Array(n);
  const centroid = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const ax = pos[b]!,
      ay = pos[b + 1]!,
      az = pos[b + 2]!;
    const ux = pos[b + 3]! - ax,
      uy = pos[b + 4]! - ay,
      uz = pos[b + 5]! - az;
    const vx = pos[b + 6]! - ax,
      vy = pos[b + 7]! - ay,
      vz = pos[b + 8]! - az;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    area[t] = len / 2;
    if (len > 0) {
      normal[t * 3] = nx / len;
      normal[t * 3 + 1] = ny / len;
      normal[t * 3 + 2] = nz / len;
    }
    centroid[t * 3] = (ax + pos[b + 3]! + pos[b + 6]!) / 3;
    centroid[t * 3 + 1] = (ay + pos[b + 4]! + pos[b + 7]!) / 3;
    centroid[t * 3 + 2] = (az + pos[b + 5]! + pos[b + 8]!) / 3;
  }
  return { normal, area, centroid };
}

/** Each corner's undirected edge (corner k to corner k+1 of its triangle), as a numeric key. */
function edgeKeys(w: Welded): Float64Array {
  const n = w.index.length;
  const keys = new Float64Array(n);
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = w.index[t + k]!;
      const b = w.index[t + ((k + 1) % 3)]!;
      keys[t + k] = a < b ? a * w.vertexCount + b : b * w.vertexCount + a;
    }
  }
  return keys;
}

/** Corner indices sorted by edge key, so the corners of one edge are adjacent. */
function cornersByEdge(keys: Float64Array): Uint32Array {
  const order = new Uint32Array(keys.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => keys[a]! - keys[b]!);
  return order;
}

export interface Connectivity {
  /** Neighbour triangle across each corner's outgoing edge. -1 for boundary and non-manifold edges. */
  neighbours: Int32Array;
  /** Component representative per triangle. */
  component: Uint32Array;
  shells: number;
  closed: boolean;
  /** Every closed edge also has opposite winding. */
  oriented: boolean;
}

export function connectivity(welded: Welded): Connectivity {
  const n = welded.index.length / 3;
  const neighbours = new Int32Array(welded.index.length).fill(-1);
  const keys = edgeKeys(welded);
  const order = cornersByEdge(keys);
  const uf = new UnionFind(n);
  let closed = n > 0;
  let oriented = true;
  let start = 0;
  for (let i = 1; i <= order.length; i++) {
    if (i < order.length && keys[order[i]!] === keys[order[start]!]) continue;
    if (i - start === 2) {
      const a = order[start]!,
        b = order[start + 1]!;
      const ta = Math.floor(a / 3),
        tb = Math.floor(b / 3);
      if (welded.index[a] === welded.index[b]) oriented = false;
      neighbours[a] = tb;
      neighbours[b] = ta;
      uf.union(ta, tb);
    } else {
      closed = false;
    }
    start = i;
  }
  let shells = 0;
  const component = new Uint32Array(n);
  for (let t = 0; t < n; t++) {
    component[t] = uf.find(t);
    if (component[t] === t) shells++;
  }
  return { neighbours, component, shells, closed, oriented: closed && oriented };
}

export interface Topology extends Welded, Faces, Connectivity {}

export function buildTopology(pos: Float32Array, tolerance = 0): Topology {
  const welded = weld(pos, tolerance);
  return { ...welded, ...connectivity(welded), ...faces(pos) };
}
