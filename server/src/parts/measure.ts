/**
 * Measures a spec's dimensions on a rendered mesh (docs/SPEC.md → Dimensions are measured on the
 * mesh). Never reads the model's variables.
 */
import type { Axis, Dimension, MeshInfo, Vec3 } from "@drawer/shared/api";
import type { MeshAnalysisOutput, Renderer } from "@drawer/shared/contracts";
import { errorMessage } from "../util.ts";
import { AXIS_INDEX, fmt, type DimMeasurement } from "./gates.ts";

/** The two axes other than `axis`, in x-y-z order. */
function others(axis: Axis): [number, number] {
  const i = AXIS_INDEX[axis];
  const rest = [0, 1, 2].filter((k) => k !== i);
  return [rest[0] as number, rest[1] as number];
}

/** A point on the cutting plane from its two in-plane coordinates. */
function planePoint(axis: Axis, at: number, uv: [number, number]): Vec3 {
  const p: Vec3 = [0, 0, 0];
  const [u, v] = others(axis);
  p[AXIS_INDEX[axis]] = at;
  p[u] = uv[0];
  p[v] = uv[1];
  return p;
}

const pt = (p: Vec3): string => `[${p.map((n) => fmt(n)).join(", ")}]`;

export async function measureDimension(renderer: Renderer, key: string, mesh: MeshInfo, analysis: MeshAnalysisOutput | null, d: Dimension): Promise<DimMeasurement> {
  try {
    switch (d.kind) {
      case "size":
        return { ok: true, value: mesh.bbox.size[AXIS_INDEX[d.axis ?? "x"]], at: null };
      case "envelope":
        return { ok: true, size: mesh.bbox.size, at: null };
      case "volume":
        return mesh.volumeCm3 === null ? { ok: false, error: "the mesh has no volume (it is not closed)", at: null } : { ok: true, value: mesh.volumeCm3, at: null };
      case "min_wall":
        return analysis?.wall ? { ok: true, value: analysis.wall.minMm, at: analysis.wall.at } : { ok: false, error: "wall thickness cannot be measured: the mesh is not closed", at: null };
      case "hole":
      case "boss": {
        const axis = d.axis ?? "z";
        const at = d.at ?? 0;
        const slice = await renderer.slice({ key, axis, at });
        const [u, v] = others(axis);
        const near: [number, number] = d.near ?? [((mesh.bbox.min[u] ?? 0) + (mesh.bbox.max[u] ?? 0)) / 2, ((mesh.bbox.min[v] ?? 0) + (mesh.bbox.max[v] ?? 0)) / 2];
        // A hole is an opening in the cross-section; a boss is an outline of material.
        const pool = slice.contours.filter((c) => c.hole === (d.kind === "hole"));
        const cut = `${axis} = ${fmt(at)}`;
        if (pool.length === 0) {
          return {
            ok: false,
            error: d.kind === "hole" ? `no opening in the cross-section at ${cut}` : `no outline of material in the cross-section at ${cut}`,
            hint: `Check the cut position: slice the model at ${cut} and see which outlines it crosses; \`at\` must lie within the ${d.kind === "hole" ? "hole" : "boss"}.`,
            at: null,
          };
        }
        const dist = (c: (typeof pool)[number]): number => Math.hypot(c.centre[0] - near[0], c.centre[1] - near[1]);
        const best = pool.reduce((a, b) => (dist(b) < dist(a) ? b : a));
        const where = planePoint(axis, at, best.centre);
        const what = d.kind === "hole" ? "opening" : "outline";
        if (!best.circle.round) {
          const pct = best.circle.diameter > 0 ? (best.circle.rms / best.circle.diameter) * 100 : 100;
          return { ok: false, error: `the ${what} nearest [${near.map((n) => fmt(n)).join(", ")}] at ${cut} is not round (fit error ${fmt(best.circle.rms, 3)} mm, ${fmt(pct, 1)} % of its ${fmt(best.circle.diameter)} mm diameter)`, at: where };
        }
        return { ok: true, value: best.circle.diameter, at: planePoint(axis, at, best.circle.centre) };
      }
      case "gap":
      case "wall": {
        const from = d.from ?? [0, 0, 0];
        const axis = d.axis ?? "x";
        const probe = await renderer.probe({ key, from, axis });
        if (probe.onSurface) return { ok: false, error: `the point ${pt(from)} lies on a face`, hint: `Move the point ${pt(from)} into the ${d.kind === "gap" ? "air of the gap" : "material of the wall"}, away from its faces.`, at: from };
        if (d.kind === "gap" && probe.inside) return { ok: false, error: `the point ${pt(from)} is inside material, not in the gap`, at: from };
        if (d.kind === "wall" && !probe.inside) return { ok: false, error: `the point ${pt(from)} is in air, not inside the wall`, at: from };
        if (probe.distance === null) return { ok: false, error: `the air through ${pt(from)} along ${axis} is open to the outside: there is no gap to measure`, at: from };
        return { ok: true, value: probe.distance, at: from };
      }
    }
  } catch (err) {
    return { ok: false, error: `measuring failed: ${errorMessage(err)}`, at: null };
  }
}
