/**
 * Worker thread for the mesh maths, so a 200k-triangle analysis never blocks the server's
 * event loop. Keeps the last few meshes and their BVHs: a render's mesh.stl never changes.
 */
import { readFileSync } from "node:fs";
import { type Bvh, buildBvh } from "./bvh";
import { analyse, deviation, gap, probe, slice, transform } from "./measure";
import { parseStl } from "./mesh";
import type { WorkerReply, WorkerRequest } from "./measure-protocol";

const KEEP = 4;
const meshes = new Map<string, { pos: Float32Array; bvh: Bvh | null }>();

function load(path: string): { pos: Float32Array; bvh: Bvh | null } {
  const hit = meshes.get(path);
  if (hit) {
    meshes.delete(path);
    meshes.set(path, hit);
    return hit;
  }
  const entry = { pos: parseStl(new Uint8Array(readFileSync(path))), bvh: null };
  meshes.set(path, entry);
  while (meshes.size > KEEP) {
    const oldest = meshes.keys().next().value;
    if (oldest === undefined) break;
    meshes.delete(oldest);
  }
  return entry;
}

function bvhOf(path: string): Bvh {
  const m = load(path);
  m.bvh ??= buildBvh(m.pos);
  return m.bvh;
}

function handle(req: WorkerRequest): { reply: WorkerReply; transfer: ArrayBuffer[] } {
  switch (req.op) {
    case "analyse": {
      const r = analyse(load(req.mesh).pos, req.overhangDeg, bvhOf(req.mesh));
      return { reply: { id: req.id, ok: true, op: "analyse", analysis: r.analysis, thickness: r.thickness }, transfer: [r.thickness.buffer as ArrayBuffer] };
    }
    case "slice":
      return { reply: { id: req.id, ok: true, op: "slice", contours: slice(load(req.mesh).pos, req.axis, req.at) }, transfer: [] };
    case "probe":
      return { reply: { id: req.id, ok: true, op: "probe", probe: probe(bvhOf(req.mesh), req.from, req.axis) }, transfer: [] };
    case "deviation": {
      const r = deviation(bvhOf(req.a), load(req.b).pos);
      return { reply: { id: req.id, ok: true, op: "deviation", result: r }, transfer: [r.field.buffer as ArrayBuffer] };
    }
    case "gap": {
      const a = buildBvh(transform(load(req.a.mesh).pos, req.a.matrix));
      const b = buildBvh(transform(load(req.b.mesh).pos, req.b.matrix));
      const ab = a.bounds, bb = b.bounds;
      const disjoint = ab[0]! > bb[3]! || bb[0]! > ab[3]! || ab[1]! > bb[4]! || bb[1]! > ab[4]! || ab[2]! > bb[5]! || bb[2]! > ab[5]!;
      return { reply: { id: req.id, ok: true, op: "gap", gapMm: gap(a, b), disjoint }, transfer: [] };
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
