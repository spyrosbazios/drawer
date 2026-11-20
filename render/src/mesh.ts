/**
 * Pure mesh maths: STL (binary + ASCII), 3MF and OBJ parsers, MeshInfo, binary STL writer.
 * No OpenSCAD involved. Every parser yields a flat triangle soup in millimetres.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Unzip, UnzipInflate, strFromU8 } from "fflate";
import type { MeshInfo } from "@drawer/shared/api";

export type MeshFormat = MeshInfo["format"];

export interface Mesh {
  format: MeshFormat;
  /** 9 floats per triangle: x0 y0 z0 x1 y1 z1 x2 y2 z2, millimetres. */
  positions: Float32Array;
}

export function meshFormatOf(file: string): MeshFormat | null {
  const ext = extname(file).toLowerCase();
  if (ext === ".stl") return "stl";
  if (ext === ".3mf") return "3mf";
  if (ext === ".obj") return "obj";
  return null;
}

export async function readMesh(file: string): Promise<Mesh> {
  const format = meshFormatOf(file);
  if (!format) throw new Error(`not a mesh file: ${file}`);
  return parseMesh(format, new Uint8Array(await readFile(file)));
}

export function parseMesh(format: MeshFormat, bytes: Uint8Array): Mesh {
  switch (format) {
    case "stl":
      return { format, positions: parseStl(bytes) };
    case "3mf":
      return { format, positions: parse3mf(bytes) };
    case "obj":
      return { format, positions: parseObj(new TextDecoder().decode(bytes)) };
  }
}

// ---- STL --------------------------------------------------------------------------------

export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return bytes.byteLength === 84 + count * 50;
}

export function parseStl(bytes: Uint8Array): Float32Array {
  if (isBinaryStl(bytes)) return parseBinaryStl(bytes);
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 512))).trimStart();
  if (!head.toLowerCase().startsWith("solid")) throw new Error("not an STL file (neither binary nor ASCII)");
  return parseAsciiStl(new TextDecoder().decode(bytes));
}

function parseBinaryStl(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12; // skip the normal
    for (let k = 0; k < 9; k++) out[t * 9 + k] = view.getFloat32(base + k * 4, true);
  }
  return out;
}

function parseAsciiStl(text: string): Float32Array {
  const values: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    values.push(num(m[1]), num(m[2]), num(m[3]));
  }
  if (values.length % 9 !== 0) throw new Error("ASCII STL: vertex count is not a multiple of 3");
  return Float32Array.from(values);
}

/** Binary STL bytes for a triangle soup, with computed facet normals. */
export function toBinaryStl(positions: Float32Array): Uint8Array {
  const count = positions.length / 9;
  const out = new Uint8Array(84 + count * 50);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("binary STL written by drawer"));
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const p = t * 9;
    const ax = at(positions, p + 3) - at(positions, p);
    const ay = at(positions, p + 4) - at(positions, p + 1);
    const az = at(positions, p + 5) - at(positions, p + 2);
    const bx = at(positions, p + 6) - at(positions, p);
    const by = at(positions, p + 7) - at(positions, p + 1);
    const bz = at(positions, p + 8) - at(positions, p + 2);
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    const base = 84 + t * 50;
    view.setFloat32(base, nx, true);
    view.setFloat32(base + 4, ny, true);
    view.setFloat32(base + 8, nz, true);
    for (let k = 0; k < 9; k++) view.setFloat32(base + 12 + k * 4, at(positions, p + k), true);
  }
  return out;
}

// ---- OBJ --------------------------------------------------------------------------------

export function parseObj(text: string): Float32Array {
  const verts: number[] = [];
  const out: number[] = [];
  const vertex = (token: string): number => {
    const raw = Number.parseInt(token.split("/")[0] ?? "", 10);
    const count = verts.length / 3;
    const index = raw < 0 ? count + raw : raw - 1;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`OBJ: bad vertex reference "${token}"`);
    return index;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^v\s/.test(line)) {
      const [, x, y, z] = line.split(/\s+/);
      verts.push(num(x), num(y), num(z));
    } else if (/^f\s/.test(line)) {
      const idx = line.split(/\s+/).slice(1).map(vertex);
      for (let i = 1; i + 1 < idx.length; i++) {
        for (const v of [idx[0], idx[i], idx[i + 1]]) {
          const b = (v ?? 0) * 3;
          out.push(at(verts, b), at(verts, b + 1), at(verts, b + 2));
        }
      }
    }
  }
  return Float32Array.from(out);
}

// ---- 3MF --------------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number, number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface ModelObject {
  vertices: number[];
  triangles: number[];
  components: { objectId: string; path: string | null; transform: Matrix }[];
}

interface ModelFile {
  unitScale: number;
  objects: Map<string, ModelObject>;
  build: { objectId: string; path: string | null; transform: Matrix }[];
}

const UNIT_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** The most one model or relationships part of a 3MF may inflate to. Large multi-part prints stay well under. */
export const MAX_3MF_ENTRY_BYTES = 256 * 1024 * 1024;
/** The most all model and relationships parts of one 3MF may inflate to together. */
export const MAX_3MF_TOTAL_BYTES = 512 * 1024 * 1024;
/** The most model and relationships parts one 3MF may hold. */
export const MAX_3MF_ENTRIES = 1000;
/** Input fed to the inflater at a time: one push can inflate to at most ~1032 times this. */
const UNZIP_CHUNK_BYTES = 16 * 1024;

/**
 * The `.model` and `.rels` parts of a 3MF, inflated with the caps above. Sizes are counted as the bytes
 * come out of the inflater, never taken from the archive's headers, which can lie: a small file that
 * claims a small size can still inflate to gigabytes. Streaming lets the count stop the work early too.
 */
function unzip3mf(bytes: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  let count = 0;
  const unzip = new Unzip((file) => {
    if (!file.name.endsWith(".model") && !file.name.endsWith(".rels")) return;
    if (++count > MAX_3MF_ENTRIES) throw new Error(`3MF: more than ${MAX_3MF_ENTRIES} model parts`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, data, final) => {
      if (err) throw err;
      size += data.length;
      total += data.length;
      if (size > MAX_3MF_ENTRY_BYTES) throw new Error(`3MF: ${file.name} inflates to more than ${MAX_3MF_ENTRY_BYTES / (1024 * 1024)} MB`);
      if (total > MAX_3MF_TOTAL_BYTES) throw new Error(`3MF: the model parts inflate to more than ${MAX_3MF_TOTAL_BYTES / (1024 * 1024)} MB`);
      chunks.push(data);
      if (final) out[file.name] = concat(chunks, size);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  if (bytes.length === 0) throw new Error("3MF: empty file");
  for (let i = 0; i < bytes.length; i += UNZIP_CHUNK_BYTES) {
    unzip.push(bytes.subarray(i, i + UNZIP_CHUNK_BYTES), i + UNZIP_CHUNK_BYTES >= bytes.length);
  }
  return out;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0];
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return all;
}

export function parse3mf(bytes: Uint8Array): Float32Array {
  const entries = unzip3mf(bytes);
  const text = (name: string): string | null => {
    const entry = entries[name.replace(/^\//, "")];
    return entry ? strFromU8(entry) : null;
  };
  const rels = text("_rels/.rels");
  if (!rels) throw new Error("3MF: missing _rels/.rels");
  const rootPath = [...rels.matchAll(/<\w*:?Relationship\b([^>]*)>/g)]
    .map((m) => attrs(m[1] ?? ""))
    .find((a) => (a.Type ?? "").endsWith("/3dmodel"))?.Target;
  if (!rootPath) throw new Error("3MF: no 3D model relationship");

  const models = new Map<string, ModelFile>();
  const model = (path: string): ModelFile => {
    const key = path.replace(/^\//, "");
    let parsed = models.get(key);
    if (!parsed) {
      const xml = text(key);
      if (xml === null) throw new Error(`3MF: missing model part ${path}`);
      parsed = parseModelXml(xml);
      models.set(key, parsed);
    }
    return parsed;
  };

  const root = model(rootPath);
  const out: number[] = [];
  const emit = (path: string, objectId: string, transform: Matrix, depth: number): void => {
    if (depth > 32) throw new Error("3MF: component nesting too deep");
    const file = model(path);
    const obj = file.objects.get(objectId);
    if (!obj) throw new Error(`3MF: object ${objectId} not found in ${path}`);
    const s = file.unitScale;
    for (let t = 0; t < obj.triangles.length; t++) {
      const b = at(obj.triangles, t) * 3;
      const [x, y, z] = apply(transform, at(obj.vertices, b) * s, at(obj.vertices, b + 1) * s, at(obj.vertices, b + 2) * s);
      out.push(x, y, z);
    }
    for (const c of obj.components) {
      emit(c.path ?? path, c.objectId, compose(scaleTranslation(c.transform, s), transform), depth + 1);
    }
  };
  for (const item of root.build) {
    emit(item.path ?? rootPath, item.objectId, scaleTranslation(item.transform, root.unitScale), 0);
  }
  return Float32Array.from(out);
}

function parseModelXml(xml: string): ModelFile {
  const modelAttrs = attrs(/<(?:\w+:)?model\b([^>]*)>/.exec(xml)?.[1] ?? "");
  const unitScale = UNIT_MM[modelAttrs.unit ?? "millimeter"];
  if (unitScale === undefined) throw new Error(`3MF: unknown unit "${modelAttrs.unit}"`);
  const objects = new Map<string, ModelObject>();
  const build: ModelFile["build"] = [];
  let current: ModelObject | null = null;
  let inBuild = false;
  const tagRe = /<(\/?)(?:[\w.-]+:)?([\w.-]+)\b([^>]*?)\/?>/g;
  for (let m = tagRe.exec(xml); m; m = tagRe.exec(xml)) {
    const closing = m[1] === "/";
    const name = m[2];
    const raw = m[3] ?? "";
    if (name === "object") {
      if (closing) {
        current = null;
      } else {
        const id = attrs(raw).id;
        if (id === undefined) throw new Error("3MF: object without id");
        current = { vertices: [], triangles: [], components: [] };
        objects.set(id, current);
        if (m[0].endsWith("/>")) current = null;
      }
    } else if (name === "build") {
      inBuild = !closing && !m[0].endsWith("/>");
    } else if (closing) {
      continue;
    } else if (name === "vertex" && current) {
      const a = attrs(raw);
      current.vertices.push(num(a.x), num(a.y), num(a.z));
    } else if (name === "triangle" && current) {
      const a = attrs(raw);
      current.triangles.push(int(a.v1), int(a.v2), int(a.v3));
    } else if (name === "component" && current) {
      const a = attrs(raw);
      current.components.push({ objectId: req(a.objectid, "component objectid"), path: a.path ?? null, transform: matrix(a.transform) });
    } else if (name === "item" && inBuild) {
      const a = attrs(raw);
      build.push({ objectId: req(a.objectid, "item objectid"), path: a.path ?? null, transform: matrix(a.transform) });
    }
  }
  return { unitScale, objects, build };
}

/** Attributes by local name (namespace prefixes dropped, so `p:path` → `path`). */
function attrs(raw: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const m of raw.matchAll(/(?:[\w.-]+:)?([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = m[1];
    if (key) out[key] = m[2] ?? m[3] ?? "";
  }
  return out;
}

function matrix(raw: string | undefined): Matrix {
  if (!raw) return IDENTITY;
  const v = raw.trim().split(/\s+/).map(num);
  if (v.length !== 12) throw new Error(`3MF: bad transform "${raw}"`);
  return v as Matrix;
}

/** 3MF row-vector convention: p' = [x y z 1] · M. */
function apply(m: Matrix, x: number, y: number, z: number): [number, number, number] {
  return [
    x * m[0] + y * m[3] + z * m[6] + m[9],
    x * m[1] + y * m[4] + z * m[7] + m[10],
    x * m[2] + y * m[5] + z * m[8] + m[11],
  ];
}

/** a then b. */
function compose(a: Matrix, b: Matrix): Matrix {
  const r = (i: number, j: number): number => at(a, i * 3) * at(b, j) + at(a, i * 3 + 1) * at(b, 3 + j) + at(a, i * 3 + 2) * at(b, 6 + j);
  const [tx, ty, tz] = apply(b, a[9], a[10], a[11]);
  return [r(0, 0), r(0, 1), r(0, 2), r(1, 0), r(1, 1), r(1, 2), r(2, 0), r(2, 1), r(2, 2), tx, ty, tz];
}

/** Transforms are written in the model's unit; vertices are already scaled to mm. */
function scaleTranslation(m: Matrix, s: number): Matrix {
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9] * s, m[10] * s, m[11] * s];
}

// ---- MeshInfo ---------------------------------------------------------------------------

/** Share of directed edges without a reverse partner above which a mesh counts as open. */
const OPEN_EDGE_TOLERANCE = 0.005;

export function computeMeshInfo(mesh: Mesh): MeshInfo {
  const p = mesh.positions;
  const triangles = p.length / 9;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let volume6 = 0;
  for (let t = 0; t < triangles; t++) {
    const b = t * 9;
    for (let k = 0; k < 3; k++) {
      for (let axis = 0; axis < 3; axis++) {
        const v = at(p, b + k * 3 + axis);
        if (v < min[axis]!) min[axis] = v;
        if (v > max[axis]!) max[axis] = v;
      }
    }
    const x0 = at(p, b), y0 = at(p, b + 1), z0 = at(p, b + 2);
    const x1 = at(p, b + 3), y1 = at(p, b + 4), z1 = at(p, b + 5);
    const x2 = at(p, b + 6), y2 = at(p, b + 7), z2 = at(p, b + 8);
    volume6 += x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2);
  }
  if (triangles === 0) {
    const zero: [number, number, number] = [0, 0, 0];
    return { format: mesh.format, triangles, bbox: { min: zero, max: [0, 0, 0], size: [0, 0, 0] }, volumeCm3: null };
  }
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const volumeMm3 = Math.abs(volume6 / 6);
  const boxVolume = size[0] * size[1] * size[2];
  const closed = boxVolume > 0 && volumeMm3 > boxVolume * 1e-9 && openEdgeShare(p) <= OPEN_EDGE_TOLERANCE;
  return {
    format: mesh.format,
    triangles,
    bbox: { min: min.map(round) as [number, number, number], max: max.map(round) as [number, number, number], size: size.map(round) as [number, number, number] },
    volumeCm3: closed ? round(volumeMm3 / 1000) : null,
  };
}

/** Fraction of directed edges (welded on exact coordinates) that have no opposite twin. */
function openEdgeShare(p: Float32Array): number {
  const ids = new Map<string, number>();
  const id = (o: number): number => {
    const key = `${p[o]},${p[o + 1]},${p[o + 2]}`;
    let v = ids.get(key);
    if (v === undefined) {
      v = ids.size;
      ids.set(key, v);
    }
    return v;
  };
  const tri = new Uint32Array(p.length / 3);
  for (let i = 0; i < tri.length; i++) tri[i] = id(i * 3);
  const n = ids.size;
  const edges = new Map<number, number>();
  for (let t = 0; t < tri.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = at(tri, t + k);
      const b = at(tri, t + ((k + 1) % 3));
      const reverse = b * n + a;
      const pending = edges.get(reverse);
      if (pending) {
        if (pending === 1) edges.delete(reverse);
        else edges.set(reverse, pending - 1);
      } else {
        const key = a * n + b;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
  }
  let unmatched = 0;
  for (const c of edges.values()) unmatched += c;
  return tri.length === 0 ? 1 : unmatched / tri.length;
}

export async function meshInfoOf(file: string): Promise<MeshInfo> {
  return computeMeshInfo(await readMesh(file));
}

// ---- helpers ----------------------------------------------------------------------------

function num(s: string | undefined): number {
  const v = Number(s);
  if (s === undefined || s === "" || !Number.isFinite(v)) throw new Error(`bad number "${s}"`);
  return v;
}

function int(s: string | undefined): number {
  const v = num(s);
  if (!Number.isInteger(v) || v < 0) throw new Error(`bad index "${s}"`);
  return v;
}

function req(s: string | undefined, what: string): string {
  if (s === undefined) throw new Error(`3MF: missing ${what}`);
  return s;
}

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new Error(`index ${i} out of range`);
  return v;
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
