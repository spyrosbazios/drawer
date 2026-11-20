/** Generated test solids with known answers, as triangle soups (9 floats per triangle). */

type P = [number, number, number];

function soup(tris: [P, P, P][]): Float32Array {
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((p, k) => out.set(p, i * 9 + k * 3)));
  return out;
}

function quad(a: P, b: P, c: P, d: P): [P, P, P][] {
  return [
    [a, b, c],
    [a, c, d],
  ];
}

/** Axis-aligned box from `min` to `max`, faces outward (or inward, for a cavity). */
export function boxTris(min: P, max: P, inward = false): [P, P, P][] {
  const c = (i: number): P => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const quads: [number, number, number, number][] = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const tris: [P, P, P][] = [];
  for (const [a, b, cc, d] of quads) tris.push(...(inward ? quad(c(d), c(cc), c(b), c(a)) : quad(c(a), c(b), c(cc), c(d))));
  return tris;
}

export function box(min: P, max: P): Float32Array {
  return soup(boxTris(min, max));
}

export function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A 20 mm box with a closed 16 mm cavity: walls exactly 2 mm thick. */
export function hollowBox(): Float32Array {
  return soup([...boxTris([0, 0, 0], [20, 20, 20]), ...boxTris([2, 2, 2], [18, 18, 18], true)]);
}

/** A round plate (outer radius `ro`) with a through hole of radius `ri`, from z = 0 to `h`. */
export function washer(ro = 20, ri = 3, h = 4, n = 64): Float32Array {
  const at = (r: number, i: number, z: number): P => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z];
  const tris: [P, P, P][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push(...quad(at(ro, i, h), at(ro, j, h), at(ri, j, h), at(ri, i, h)));
    tris.push(...quad(at(ri, i, 0), at(ri, j, 0), at(ro, j, 0), at(ro, i, 0)));
    tris.push(...quad(at(ro, i, 0), at(ro, j, 0), at(ro, j, h), at(ro, i, h)));
    tris.push(...quad(at(ri, i, 0), at(ri, i, h), at(ri, j, h), at(ri, j, 0)));
  }
  return soup(tris);
}

/** A torus of 2·nu·nv triangles, outward, every vertex computed once (so it welds exactly). */
export function torus(R: number, r: number, nu: number, nv: number): Float32Array {
  const verts = new Float32Array(nu * nv * 3);
  for (let i = 0; i < nu; i++) {
    const u = (2 * Math.PI * i) / nu;
    for (let j = 0; j < nv; j++) {
      const v = (2 * Math.PI * j) / nv;
      const o = (i * nv + j) * 3;
      verts[o] = (R + r * Math.cos(v)) * Math.cos(u);
      verts[o + 1] = (R + r * Math.cos(v)) * Math.sin(u);
      verts[o + 2] = r * Math.sin(v);
    }
  }
  const out = new Float32Array(nu * nv * 2 * 9);
  let w = 0;
  const put = (i: number, j: number): void => {
    const o = (((i + nu) % nu) * nv + ((j + nv) % nv)) * 3;
    out[w++] = verts[o]!;
    out[w++] = verts[o + 1]!;
    out[w++] = verts[o + 2]!;
  };
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      put(i, j);
      put(i + 1, j);
      put(i + 1, j + 1);
      put(i, j);
      put(i + 1, j + 1);
      put(i, j + 1);
    }
  }
  return out;
}

/**
 * A regular n-gon prism (circumradius `r`, centre at the origin) from z = 0 to `h`, the way OpenSCAD
 * meshes a cylinder: each side quad is two triangles split along a diagonal.
 */
export function prism(n: number, r: number, h: number): Float32Array {
  const at = (i: number, z: number): P => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z];
  const tris: [P, P, P][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push(...quad(at(i, 0), at(j, 0), at(j, h), at(i, h)));
    if (i > 0 && i < n - 1) {
      tris.push([at(0, h), at(i, h), at(i + 1, h)]);
      tris.push([at(0, 0), at(i + 1, 0), at(i, 0)]);
    }
  }
  return soup(tris);
}

/** A square pyramid: base [-5, 5]² at z = 0, apex at (0, 0, 10). */
export function pyramid(): Float32Array {
  const apex: P = [0, 0, 10];
  const a: P = [-5, -5, 0], b: P = [5, -5, 0], c: P = [5, 5, 0], d: P = [-5, 5, 0];
  return soup([[a, b, apex], [b, c, apex], [c, d, apex], [d, a, apex], ...quad(a, d, c, b)]);
}
