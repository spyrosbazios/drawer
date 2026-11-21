/** Angle-weighted pseudonormals, Bærentzen and Aanæs (IEEE TVCG 11:3, 2005). */
import type { Vec3 } from "@drawer/shared/api";
import { closestPoint, type Bvh } from "./bvh";
import type { Topology } from "./topology";
import { add, cross, dot, length, readVec, sub, unit } from "./vectors";

export function surfaceDistance(bvh: Bvh, topology: Topology) {
  let normals: Float64Array | undefined;
  function vertexNormals(): Float64Array {
    if (normals) return normals;
    normals = new Float64Array(topology.vertexCount * 3);
    const p = bvh.pos;
    for (let t = 0; t < p.length / 9; t++) {
      const normal = readVec(topology.normal, t * 3);
      for (let i = 0; i < 3; i++) {
        const origin = readVec(p, t * 9 + i * 3);
        const u = sub(readVec(p, t * 9 + ((i + 1) % 3) * 3), origin);
        const v = sub(readVec(p, t * 9 + ((i + 2) % 3) * 3), origin);
        const angle = Math.atan2(length(cross(u, v)), dot(u, v));
        const index = topology.index[t * 3 + i]! * 3;
        for (let j = 0; j < 3; j++) normals[index + j]! += normal[j]! * angle;
      }
    }
    return normals;
  }

  return (p: Vec3): { distance: number; depth: number; tangent2: number } => {
    const nearest = closestPoint(bvh, ...p);
    if (!nearest) return { distance: Infinity, depth: Infinity, tangent2: Infinity };
    const { triangle: t, point: q, distance2 } = nearest;
    if (distance2 === 0) return { distance: 0, depth: 0, tangent2: 0 };
    const a = readVec(bvh.pos, t * 9),
      b = readVec(bvh.pos, t * 9 + 3),
      c = readVec(bvh.pos, t * 9 + 6);
    const face = readVec(topology.normal, t * 3);
    const area2 = 2 * topology.area[t]!;
    const opposite = [dot(cross(sub(b, q), sub(c, q)), face), dot(cross(sub(c, q), sub(a, q)), face), dot(cross(sub(a, q), sub(b, q)), face)];
    const boundary = opposite.map((value) => value <= area2 * 1e-7);
    const count = boundary.filter(Boolean).length;
    let direction = face;
    if (count === 1) {
      const edge = (boundary.indexOf(true) + 1) % 3;
      const neighbour = topology.neighbours[t * 3 + edge]!;
      if (neighbour >= 0) direction = unit(add(face, readVec(topology.normal, neighbour * 3)));
    } else if (count === 2) {
      const corner = topology.index[t * 3 + boundary.indexOf(false)]!;
      direction = unit(readVec(vertexNormals(), corner * 3));
    }
    if (dot(direction, direction) === 0) direction = face;
    const depth = dot(sub(p, q), direction);
    return { distance: (depth < 0 ? -1 : 1) * Math.sqrt(distance2), depth, tangent2: Math.max(0, distance2 - depth * depth) };
  };
}
