/**
 * A bounding volume hierarchy over the triangles of a soup, with the queries the mesh maths
 * needs: first hit along a ray, every hit along a ray, and the nearest surface point.
 * Flat typed arrays, no allocation per query.
 */

const LEAF_SIZE = 4;
const STACK_SIZE = 4096;
/** Barycentric slack: a ray through a shared edge must hit at least one of its triangles. */
const BARY_EPS = 1e-9;

export interface Bvh {
  /** 9 floats per triangle. */
  pos: Float32Array;
  /** Triangle indices, reordered so every leaf covers a contiguous run. */
  order: Uint32Array;
  /** 6 per node: min x y z, max x y z. */
  bounds: Float64Array;
  /** Inner node: index of the first child (the second is +1; never 0). Leaf: start in `order`. */
  first: Uint32Array;
  /** 0 for an inner node, else the number of triangles in the leaf. */
  count: Uint32Array;
}

export function buildBvh(pos: Float32Array): Bvh {
  const n = pos.length / 9;
  const order = new Uint32Array(n);
  const cx = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    order[t] = t;
    const b = t * 9;
    for (let a = 0; a < 3; a++) cx[t * 3 + a] = (pos[b + a]! + pos[b + 3 + a]! + pos[b + 6 + a]!) / 3;
  }
  let bounds = new Float64Array(Math.min(Math.max(1, 2 * n), 1024) * 6);
  let first = new Uint32Array(bounds.length / 6);
  let count = new Uint32Array(bounds.length / 6);
  let nodes = 1;
  const grow = (): void => {
    const cap = (bounds.length / 6) * 2;
    const nb = new Float64Array(cap * 6);
    nb.set(bounds);
    bounds = nb;
    const nf = new Uint32Array(cap);
    nf.set(first);
    first = nf;
    const nc = new Uint32Array(cap);
    nc.set(count);
    count = nc;
  };

  const stack: [number, number, number][] = [[0, 0, n]];
  while (stack.length > 0) {
    const [node, start, end] = stack.pop()!;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    let cmnx = Infinity, cmny = Infinity, cmnz = Infinity, cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;
    for (let i = start; i < end; i++) {
      const t = order[i]!;
      const b = t * 9;
      for (let k = 0; k < 9; k += 3) {
        const x = pos[b + k]!, y = pos[b + k + 1]!, z = pos[b + k + 2]!;
        if (x < mnx) mnx = x;
        if (x > mxx) mxx = x;
        if (y < mny) mny = y;
        if (y > mxy) mxy = y;
        if (z < mnz) mnz = z;
        if (z > mxz) mxz = z;
      }
      const x = cx[t * 3]!, y = cx[t * 3 + 1]!, z = cx[t * 3 + 2]!;
      if (x < cmnx) cmnx = x;
      if (x > cmxx) cmxx = x;
      if (y < cmny) cmny = y;
      if (y > cmxy) cmxy = y;
      if (z < cmnz) cmnz = z;
      if (z > cmxz) cmxz = z;
    }
    const o = node * 6;
    bounds[o] = mnx;
    bounds[o + 1] = mny;
    bounds[o + 2] = mnz;
    bounds[o + 3] = mxx;
    bounds[o + 4] = mxy;
    bounds[o + 5] = mxz;
    const size = end - start;
    if (size <= LEAF_SIZE) {
      first[node] = start;
      count[node] = size;
      if (size === 0) {
        // An empty mesh: a leaf with no triangles and an inverted box that no query enters.
        count[node] = 0;
        first[node] = 0;
        bounds.fill(Infinity, o, o + 3);
        bounds.fill(-Infinity, o + 3, o + 6);
      }
      continue;
    }
    const ex = cmxx - cmnx, ey = cmxy - cmny, ez = cmxz - cmnz;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const split = axis === 0 ? (cmnx + cmxx) / 2 : axis === 1 ? (cmny + cmxy) / 2 : (cmnz + cmxz) / 2;
    let i = start;
    let j = end - 1;
    while (i <= j) {
      if (cx[order[i]! * 3 + axis]! < split) i++;
      else {
        const tmp = order[i]!;
        order[i] = order[j]!;
        order[j] = tmp;
        j--;
      }
    }
    let mid = i;
    if (mid === start || mid === end) mid = start + (size >> 1);
    while (nodes + 2 > bounds.length / 6) grow();
    const left = nodes;
    nodes += 2;
    first[node] = left;
    count[node] = 0;
    stack.push([left, start, mid], [left + 1, mid, end]);
  }
  return { pos, order, bounds: bounds.slice(0, nodes * 6), first: first.slice(0, nodes), count: count.slice(0, nodes) };
}

const stack = new Uint32Array(STACK_SIZE);

/** Entry distance of a ray into a node's box, or Infinity when it misses within [tmin, tmax]. */
function rayBox(b: Bvh, node: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, tmin: number, tmax: number): number {
  const o = node * 6;
  let lo = tmin;
  let hi = tmax;
  // Per axis: a zero direction component gives infinite inverse; then the origin must lie in the slab.
  let t1 = (b.bounds[o]! - ox) * ix, t2 = (b.bounds[o + 3]! - ox) * ix;
  if (Number.isNaN(t1) || Number.isNaN(t2)) {
    if (ox < b.bounds[o]! || ox > b.bounds[o + 3]!) return Infinity;
  } else {
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > lo) lo = t1;
    if (t2 < hi) hi = t2;
  }
  t1 = (b.bounds[o + 1]! - oy) * iy;
  t2 = (b.bounds[o + 4]! - oy) * iy;
  if (Number.isNaN(t1) || Number.isNaN(t2)) {
    if (oy < b.bounds[o + 1]! || oy > b.bounds[o + 4]!) return Infinity;
  } else {
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > lo) lo = t1;
    if (t2 < hi) hi = t2;
  }
  t1 = (b.bounds[o + 2]! - oz) * iz;
  t2 = (b.bounds[o + 5]! - oz) * iz;
  if (Number.isNaN(t1) || Number.isNaN(t2)) {
    if (oz < b.bounds[o + 2]! || oz > b.bounds[o + 5]!) return Infinity;
  } else {
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > lo) lo = t1;
    if (t2 < hi) hi = t2;
  }
  return lo <= hi * (1 + 1e-12) + 1e-12 ? lo : Infinity;
}

/** Möller–Trumbore. Returns t (in units of the direction's length) or Infinity. */
function rayTriangle(pos: Float32Array, t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const b = t * 9;
  const ax = pos[b]!, ay = pos[b + 1]!, az = pos[b + 2]!;
  const e1x = pos[b + 3]! - ax, e1y = pos[b + 4]! - ay, e1z = pos[b + 5]! - az;
  const e2x = pos[b + 6]! - ax, e2y = pos[b + 7]! - ay, e2z = pos[b + 8]! - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det === 0) return Infinity;
  const inv = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < -BARY_EPS || u > 1 + BARY_EPS) return Infinity;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -BARY_EPS || u + v > 1 + BARY_EPS) return Infinity;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** Nearest hit with t in (tmin, tmax), ignoring triangle `skip`. Infinity when none. */
export function rayFirst(b: Bvh, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmin: number, tmax: number, skip = -1): number {
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let best = tmax;
  let hit = -1;
  let sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp]!;
    if (rayBox(b, node, ox, oy, oz, ix, iy, iz, tmin, best) === Infinity) continue;
    const c = b.count[node]!;
    if (c > 0) {
      const s = b.first[node]!;
      for (let i = s; i < s + c; i++) {
        const t = b.order[i]!;
        if (t === skip) continue;
        const d = rayTriangle(b.pos, t, ox, oy, oz, dx, dy, dz);
        if (d > tmin && d < best) {
          best = d;
          hit = t;
        }
      }
    } else if (b.first[node]! > 0) {
      const l = b.first[node]!;
      const dl = rayBox(b, l, ox, oy, oz, ix, iy, iz, tmin, best);
      const dr = rayBox(b, l + 1, ox, oy, oz, ix, iy, iz, tmin, best);
      // Push the farther child first so the nearer one is visited first.
      if (dl <= dr) {
        if (dr !== Infinity) stack[sp++] = l + 1;
        if (dl !== Infinity) stack[sp++] = l;
      } else {
        if (dl !== Infinity) stack[sp++] = l;
        if (dr !== Infinity) stack[sp++] = l + 1;
      }
    }
  }
  return hit < 0 ? Infinity : best;
}

/** Where a ray crosses the surface, and whether any hit was a graze that does not cross it. */
export interface Crossings {
  /** Distances along the ray, sorted: each is one passage into or out of the solid. */
  t: number[];
  /** Some hits touched the surface without crossing it (an edge or vertex on the silhouette). */
  grazed: boolean;
}

/**
 * Every passage of the ray through the surface with t > tmin. Hits closer than `merge` are one point
 * of the surface (a ray through a shared edge or vertex hits each triangle there): it counts once when
 * all those triangles face the same way along the ray (the ray passes through), and not at all when
 * they face both ways (it only touches the surface there).
 */
export function rayCrossings(b: Bvh, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmin: number, merge = 1e-7): Crossings {
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  const hits: { t: number; facing: number }[] = [];
  let sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp]!;
    if (rayBox(b, node, ox, oy, oz, ix, iy, iz, tmin, Infinity) === Infinity) continue;
    const c = b.count[node]!;
    if (c > 0) {
      const s = b.first[node]!;
      for (let i = s; i < s + c; i++) {
        const tri = b.order[i]!;
        const d = rayTriangle(b.pos, tri, ox, oy, oz, dx, dy, dz);
        if (d > tmin && d !== Infinity) hits.push({ t: d, facing: facing(b.pos, tri, dx, dy, dz) });
      }
    } else if (b.first[node]! > 0) {
      stack[sp++] = b.first[node]!;
      stack[sp++] = b.first[node]! + 1;
    }
  }
  hits.sort((p, q) => p.t - q.t);
  const t: number[] = [];
  let grazed = false;
  for (let i = 0; i < hits.length; ) {
    let j = i + 1;
    let pos = hits[i]!.facing > 0, neg = hits[i]!.facing < 0;
    while (j < hits.length && hits[j]!.t - hits[j - 1]!.t <= merge) {
      if (hits[j]!.facing > 0) pos = true;
      if (hits[j]!.facing < 0) neg = true;
      j++;
    }
    if (pos !== neg) t.push(hits[i]!.t);
    else grazed = true;
    i = j;
  }
  return { t, grazed };
}

/** Sign of the triangle's normal along the direction: 1 leaving the solid, -1 entering, 0 edge-on. */
function facing(pos: Float32Array, t: number, dx: number, dy: number, dz: number): number {
  const b = t * 9;
  const ax = pos[b]!, ay = pos[b + 1]!, az = pos[b + 2]!;
  const ux = pos[b + 3]! - ax, uy = pos[b + 4]! - ay, uz = pos[b + 5]! - az;
  const vx = pos[b + 6]! - ax, vy = pos[b + 7]! - ay, vz = pos[b + 8]! - az;
  return Math.sign((uy * vz - uz * vy) * dx + (uz * vx - ux * vz) * dy + (ux * vy - uy * vx) * dz);
}

/** Directions no axis-aligned edge or face lies along; the first whose ray only crosses cleanly decides. */
const INSIDE_DIRECTIONS: [number, number, number][] = [
  [0.5773, 0.5774, 0.5775],
  [-0.6123, 0.4472, 0.6521],
  [0.3162, -0.7071, 0.6325],
  [-0.4364, -0.5455, -0.7155],
];

/**
 * Whether a point is inside the closed surface: parity of the crossings along a ray. A ray that grazes
 * the surface somewhere is retried along another direction; if every one grazes, the majority decides.
 */
export function isInside(b: Bvh, x: number, y: number, z: number): boolean {
  let votes = 0;
  for (const [dx, dy, dz] of INSIDE_DIRECTIONS) {
    const c = rayCrossings(b, x, y, z, dx, dy, dz, 0);
    const inside = c.t.length % 2 === 1;
    if (!c.grazed) return inside;
    votes += inside ? 1 : -1;
  }
  return votes > 0;
}

function boxDist2(b: Bvh, node: number, x: number, y: number, z: number): number {
  const o = node * 6;
  const dx = Math.max(b.bounds[o]! - x, 0, x - b.bounds[o + 3]!);
  const dy = Math.max(b.bounds[o + 1]! - y, 0, y - b.bounds[o + 4]!);
  const dz = Math.max(b.bounds[o + 2]! - z, 0, z - b.bounds[o + 5]!);
  return dx * dx + dy * dy + dz * dz;
}

/** Squared distance from a point to a triangle (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangleDist2(pos: Float32Array, t: number, px: number, py: number, pz: number): number {
  const b = t * 9;
  const ax = pos[b]!, ay = pos[b + 1]!, az = pos[b + 2]!;
  const bx = pos[b + 3]!, by = pos[b + 4]!, bz = pos[b + 5]!;
  const cx = pos[b + 6]!, cy = pos[b + 7]!, cz = pos[b + 8]!;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az;
  } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const vc = d1 * d4 - d3 * d2;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx; qy = by; qz = bz;
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
    } else {
      const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
      const d5 = abx * cpx + aby * cpy + abz * cpz;
      const d6 = acx * cpx + acy * cpy + acz * cpz;
      const vb = d5 * d2 - d1 * d6;
      if (d6 >= 0 && d5 <= d6) {
        qx = cx; qy = cy; qz = cz;
      } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
      } else {
        const va = d3 * d6 - d5 * d4;
        if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
          const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
          qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
        } else {
          const denom = 1 / (va + vb + vc);
          const v = vb * denom;
          const w = vc * denom;
          qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
        }
      }
    }
  }
  const ex = px - qx, ey = py - qy, ez = pz - qz;
  return ex * ex + ey * ey + ez * ez;
}

/** Squared distance from a point to the nearest triangle, searching no farther than sqrt(max2). */
export function nearestDist2(b: Bvh, x: number, y: number, z: number, max2 = Infinity): number {
  let best = max2;
  let sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp]!;
    if (boxDist2(b, node, x, y, z) >= best) continue;
    const c = b.count[node]!;
    if (c > 0) {
      const s = b.first[node]!;
      for (let i = s; i < s + c; i++) {
        const d = pointTriangleDist2(b.pos, b.order[i]!, x, y, z);
        if (d < best) best = d;
      }
    } else if (b.first[node]! > 0) {
      const l = b.first[node]!;
      const dl = boxDist2(b, l, x, y, z);
      const dr = boxDist2(b, l + 1, x, y, z);
      if (dl <= dr) {
        if (dr < best) stack[sp++] = l + 1;
        if (dl < best) stack[sp++] = l;
      } else {
        if (dl < best) stack[sp++] = l;
        if (dr < best) stack[sp++] = l + 1;
      }
    }
  }
  return best;
}
