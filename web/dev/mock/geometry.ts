/** Generated binaries for the mock: boxy binary STLs, per-triangle Float32 fields, small PNGs. */
import { deflateSync } from "node:zlib";
import type { MeshInfo, Vec3 } from "../../../shared/src/api";

/** An axis-aligned box; a mock part is a few of them. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

export const TRIS_PER_BOX = 12;

const box = (min: Vec3, max: Vec3): Box => ({ min, max });
export { box };

/** Thinnest extent of a box: what a wall-thickness ray through it would find. */
export const thicknessOf = (b: Box): number => Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);

function boxTriangles(b: Box): Vec3[][] {
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  const v = (x: number, y: number, z: number): Vec3 => [x ? x1 : x0, y ? y1 : y0, z ? z1 : z0];
  const quads: Vec3[][] = [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
    [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
    [v(1, 1, 0), v(0, 1, 0), v(0, 1, 1), v(1, 1, 1)],
    [v(0, 1, 0), v(0, 0, 0), v(0, 0, 1), v(0, 1, 1)],
  ];
  return quads.flatMap((q) => [
    [q[0] as Vec3, q[1] as Vec3, q[2] as Vec3],
    [q[0] as Vec3, q[2] as Vec3, q[3] as Vec3],
  ]);
}

/** Binary STL of the boxes, TRIS_PER_BOX triangles each, in order. Normals are zero: viewers compute their own. */
export function boxesStl(boxes: readonly Box[]): Uint8Array {
  const tris = boxes.flatMap(boxTriangles);
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    t.forEach((p, j) => p.forEach((c, k) => dv.setFloat32(o + 12 + j * 12 + k * 4, c, true)));
  });
  return new Uint8Array(buf);
}

export const cubeStl = (size: number): Uint8Array => boxesStl([box([0, 0, 0], [size, size, size])]);

/** One Float32 (little-endian) per triangle: the value of the box the triangle belongs to. */
export function perTriangleField(values: readonly number[]): Uint8Array {
  const out = new Float32Array(values.length * TRIS_PER_BOX);
  values.forEach((v, i) => out.fill(v, i * TRIS_PER_BOX, (i + 1) * TRIS_PER_BOX));
  const bytes = new Uint8Array(out.buffer);
  // Float32Array is platform-endian; every machine this runs on is little-endian, as the format wants.
  return bytes;
}

export function bboxOf(boxes: readonly Box[]): { min: Vec3; max: Vec3; size: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? 0, b.min[k] ?? 0);
      max[k] = Math.max(max[k] ?? 0, b.max[k] ?? 0);
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Boxes may touch but are treated as disjoint: the volume is their sum. */
export const volumeCm3 = (boxes: readonly Box[]): number => boxes.reduce((n, b) => n + (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]), 0) / 1000;

export function meshInfoOfBoxes(boxes: readonly Box[]): MeshInfo {
  return { format: "stl", closed: true, triangles: boxes.length * TRIS_PER_BOX, bbox: bboxOf(boxes), volumeCm3: round(volumeCm3(boxes), 4) };
}

/** Reads any binary STL back (used for uploaded meshes). */
export function meshInfoOfStl(bytes: Uint8Array): MeshInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n && 84 + i * 50 + 50 <= bytes.byteLength; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        const c = dv.getFloat32(84 + i * 50 + 12 + j * 12 + k * 4, true);
        min[k] = Math.min(min[k] ?? 0, c);
        max[k] = Math.max(max[k] ?? 0, c);
      }
    }
  }
  if (n === 0) return { format: "stl", closed: false, triangles: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] }, volumeCm3: null };
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { format: "stl", closed: true, triangles: n, bbox: { min, max, size }, volumeCm3: round((size[0] * size[1] * size[2]) / 1000, 4) };
}

export const round = (n: number, digits = 2): number => Number(n.toFixed(digits));

/** Volume two box sets share, cm³: the clash measure. */
export function overlapCm3(a: readonly Box[], b: readonly Box[]): number {
  let mm3 = 0;
  for (const p of a) {
    for (const q of b) {
      const d = [0, 1, 2].map((k) => Math.max(0, Math.min(p.max[k] ?? 0, q.max[k] ?? 0) - Math.max(p.min[k] ?? 0, q.min[k] ?? 0)));
      mm3 += (d[0] ?? 0) * (d[1] ?? 0) * (d[2] ?? 0);
    }
  }
  return mm3 / 1000;
}

/** Smallest distance between two bounding boxes (0 when they touch or overlap). */
export function gapMm(a: readonly Box[], b: readonly Box[]): number {
  const A = bboxOf(a);
  const B = bboxOf(b);
  const d = [0, 1, 2].map((k) => Math.max(0, (B.min[k] ?? 0) - (A.max[k] ?? 0), (A.min[k] ?? 0) - (B.max[k] ?? 0)));
  return Math.hypot(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0);
}

export const moveBoxes = (boxes: readonly Box[], t: Vec3): Box[] =>
  boxes.map((b) => ({ min: [b.min[0] + t[0], b.min[1] + t[1], b.min[2] + t[2]], max: [b.max[0] + t[0], b.max[1] + t[1], b.max[2] + t[2]] }));

// ---- PNG ---------------------------------------------------------------------------------

const encoder = new TextEncoder();

/** A small RGB PNG: a gradient with a lighter square (tinted by `hue`), so a rendered view is recognisable. */
export function png(w: number, h: number, hue = 0): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const inside = x > w * 0.28 && x < w * 0.72 && y > h * 0.28 && y < h * 0.72;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = inside ? 180 + (hue % 60) : 60 + (x * 80) / w;
      raw[o + 1] = inside ? 205 : 70 + (y * 80) / h;
      raw[o + 2] = inside ? 215 - (hue % 80) : 100;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(encoder.encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
