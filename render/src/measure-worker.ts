/**
 * Worker thread for the mesh maths, so a 200k-triangle analysis never blocks the server's
 * event loop. Keeps the last few meshes and their BVHs: a render's mesh.stl never changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { type Bvh, buildBvh } from "./bvh";
import { datum, register, surfaceSamples } from "./align";
import { surfaceDistance } from "./pseudonormal";
import { readVec } from "./vectors";
import { extractFeatures, fitAt } from "./features";
import { analyse, deviation, gap, probe, shadow, slice, transform, volume } from "./measure";
import { computeMeshInfo, isBinaryStl, meshFormatOf, parseMesh, parseStl, toBinaryStl } from "./mesh";
import { clusterProxy, normalizeScan, scanNoise, weldTolerance } from "./scan";
import { buildTopology, type Topology } from "./topology";
import type { WorkerReply, WorkerRequest } from "./measure-protocol";

const KEEP = 4;
interface CachedMesh {
  pos: Float32Array;
  bvh?: Bvh;
  topology?: Topology;
  noiseMm?: number;
}
const meshes = new Map<string, CachedMesh>();

function load(path: string): CachedMesh {
  const hit = meshes.get(path);
  if (hit) {
    meshes.delete(path);
    meshes.set(path, hit);
    return hit;
  }
  const entry = { pos: parseStl(new Uint8Array(readFileSync(path))) };
  meshes.set(path, entry);
  while (meshes.size > KEEP) {
    const oldest = meshes.keys().next().value;
    if (oldest === undefined) break;
    meshes.delete(oldest);
  }
  return entry;
}

function topologyOf(mesh: CachedMesh): Topology {
  return (mesh.topology ??= buildTopology(mesh.pos));
}

function bvhOf(path: string): Bvh {
  const m = load(path);
  m.bvh ??= buildBvh(m.pos);
  return m.bvh;
}

function handle(req: WorkerRequest): { reply: WorkerReply; transfer: ArrayBuffer[] } {
  switch (req.op) {
    case "normalize": {
      const scan = normalizeScan(req.format, req.bytes, req.units);
      return { reply: { id: req.id, ok: true, op: "normalize", scan }, transfer: [scan.bytes.buffer as ArrayBuffer] };
    }
    case "proxy": {
      const proxy = clusterProxy(load(req.mesh).pos);
      writeFileSync(req.dest, toBinaryStl(proxy.positions));
      writeFileSync(req.mapping, proxy.source);
      return { reply: { id: req.id, ok: true, op: "proxy" }, transfer: [] };
    }
    case "info": {
      const format = meshFormatOf(req.file);
      if (!format) throw new Error(`not a mesh file: ${req.file}`);
      const info = computeMeshInfo(parseMesh(format, readFileSync(req.file)));
      return { reply: { id: req.id, ok: true, op: "info", info }, transfer: [] };
    }
    case "convert": {
      const mesh = parseMesh(req.format, req.source);
      if (req.matrix) mesh.positions = transform(mesh.positions, req.matrix);
      const info = computeMeshInfo(mesh);
      if (info.triangles > 0) writeFileSync(req.dest, !req.matrix && req.format === "stl" && isBinaryStl(req.source) ? req.source : toBinaryStl(mesh.positions));
      return { reply: { id: req.id, ok: true, op: "convert", info }, transfer: [] };
    }
    case "volume":
      return { reply: { id: req.id, ok: true, op: "volume", mm3: volume(parseStl(readFileSync(req.mesh))) }, transfer: [] };
    case "analyse": {
      const mesh = load(req.mesh);
      const topology = topologyOf(mesh);
      const r = analyse(mesh.pos, req.overhangDeg, topology.closed ? bvhOf(req.mesh) : undefined, topology);
      return { reply: { id: req.id, ok: true, op: "analyse", analysis: r.analysis, thickness: r.thickness }, transfer: [r.thickness.buffer as ArrayBuffer] };
    }
    case "slice": {
      const mesh = load(req.mesh);
      const surface = topologyOf(mesh);
      const section = req.at === null ? { contours: shadow(mesh.pos, req.axis), open: [] } : slice(mesh.pos, req.axis, req.at, surface, surface.closed ? 0 : weldTolerance(mesh.pos));
      return { reply: { id: req.id, ok: true, op: "slice", result: { ...section, axis: req.axis, at: req.at } }, transfer: [] };
    }
    case "align": {
      const source = load(req.mesh);
      const topology = topologyOf(source);
      const result = req.to
        ? register(source.pos, topology, bvhOf(req.to), topologyOf(load(req.to)))
        : datum(source.pos, topology, source.noiseMm ??= scanNoise(source.pos, topology));
      return { reply: { id: req.id, ok: true, op: "align", result }, transfer: [] };
    }
    case "features":
    case "fit": {
      const mesh = load(req.mesh);
      const topology = topologyOf(mesh);
      const noise = (mesh.noiseMm ??= scanNoise(mesh.pos, topology));
      if (req.op === "fit") {
        const feature = fitAt(mesh.pos, topology, bvhOf(req.mesh), req.at, req.kind, noise);
        return { reply: { id: req.id, ok: true, op: "fit", feature }, transfer: [] };
      }
      const result = extractFeatures(mesh.pos, topology, noise);
      return { reply: { id: req.id, ok: true, op: "features", ...result }, transfer: [result.values.buffer as ArrayBuffer] };
    }
    case "probe": {
      if (!topologyOf(load(req.mesh)).closed) throw new Error("an open mesh has no inside; probe requires a closed mesh");
      return { reply: { id: req.id, ok: true, op: "probe", probe: probe(bvhOf(req.mesh), req.from, req.axis) }, transfer: [] };
    }
    case "deviation": {
      const b = load(req.b);
      const r = deviation(bvhOf(req.a), b.pos, topologyOf(b));
      return { reply: { id: req.id, ok: true, op: "deviation", result: r }, transfer: [r.field.buffer as ArrayBuffer] };
    }
    case "gap": {
      const meshA = load(req.a.mesh), meshB = load(req.b.mesh);
      const topA = topologyOf(meshA), topB = topologyOf(meshB);
      const a = buildBvh(transform(meshA.pos, req.a.matrix));
      const b = buildBvh(transform(meshB.pos, req.b.matrix));
      const ab = a.bounds, bb = b.bounds;
      const disjoint = ab[0]! > bb[3]! || bb[0]! > ab[3]! || ab[1]! > bb[4]! || bb[1]! > ab[4]! || ab[2]! > bb[5]! || bb[2]! > ab[5]!;
      const gapMm = gap(a, b, topA.closed, topB.closed);
      const open = !topA.closed || !topB.closed;
      let penetration;
      if (open) {
        let depthMm = 0, limitMm = req.clearanceMm, excess = -Infinity;
        for (const [reference, referenceMesh, topology, other, otherTopology] of [[a, meshA, topA, b, topB], [b, meshB, topB, a, topA]] as const) {
          if (topology.closed) continue;
          const noise = (referenceMesh.noiseMm ??= scanNoise(referenceMesh.pos, topology));
          const limit = Math.max(req.clearanceMm, 2 * noise);
          const distance = surfaceDistance(reference, buildTopology(reference.pos));
          const consider = (p: Parameters<typeof distance>[0]) => {
            const hit = distance(p);
            if (hit.tangent2 <= limit ** 2 && Math.max(0, -hit.depth) - limit > excess) {
              depthMm = Math.max(0, -hit.depth);
              limitMm = limit;
              excess = depthMm - limitMm;
            }
          };
          for (let i = 0; i < other.pos.length; i += 3) consider(readVec(other.pos, i));
          for (const { p } of surfaceSamples(other.pos, otherTopology, 1024)) consider(p);
          if (excess === -Infinity) limitMm = limit;
        }
        penetration = { depthMm: Math.max(0, depthMm), limitMm };
      }
      return { reply: { id: req.id, ok: true, op: "gap", gapMm, disjoint, ...(penetration ? { penetration } : {}) }, transfer: [] };
    }
  }
}

addEventListener("message", (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    const { reply, transfer } = handle(req);
    postMessage(reply, transfer);
  } catch (e) {
    const reply: WorkerReply = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    postMessage(reply);
  }
});
