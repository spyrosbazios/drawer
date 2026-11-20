import type { CompareBody, CompareResult, MeasureBody, MeasureResult, ProbeBody, ProbeResult, SectionBody, SectionResult, SliceBody, SliceResult } from "@drawer/shared/api";
import { encodePath } from "@/core/paths";
import { compareSchema, measureSchema, probeSchema, sectionSchema, sliceSchema } from "@/core/schemas";
import { api, read } from "./api";

const at = (slug: string, route: string, path: string) => `/projects/${encodeURIComponent(slug)}/${route}/${encodePath(path)}`;
/** Measuring renders the file first when it has no render yet. */
const SLOW = { timeout: 180_000 };

/** Any `.scad` or mesh file: mesh info, analysis (walls, overhangs, base) and a render. */
export async function measureFile(slug: string, path: string, body: MeasureBody = {}): Promise<MeasureResult> {
  const { data } = await api.post<unknown>(at(slug, "measure", path), body, SLOW);
  return read(measureSchema, data);
}

export async function sliceFile(slug: string, path: string, body: SliceBody): Promise<SliceResult> {
  const { data } = await api.post<unknown>(at(slug, "slice", path), body, SLOW);
  return read(sliceSchema, data);
}

export async function probeFile(slug: string, path: string, body: ProbeBody): Promise<ProbeResult> {
  const { data } = await api.post<unknown>(at(slug, "probe", path), body, SLOW);
  return read(probeSchema, data);
}

export async function sectionFile(slug: string, path: string, body: SectionBody): Promise<SectionResult> {
  const { data } = await api.post<unknown>(at(slug, "section", path), body, SLOW);
  return read(sectionSchema, data);
}

/** How B differs from A: two parts, files or revisions. */
export async function compare(slug: string, body: CompareBody): Promise<CompareResult> {
  const { data } = await api.post<unknown>(`/projects/${encodeURIComponent(slug)}/compare`, body, SLOW);
  return read(compareSchema, data);
}

/**
 * A per-triangle field (`MeshAnalysis.thickness`, `CompareResult.deviation.field`): Float32 little-endian,
 * one value per triangle of the matching mesh.stl, NaN where unknown. The URLs are absolute paths under /api.
 */
export async function fetchField(url: string): Promise<Float32Array> {
  const res = await api.get<ArrayBuffer>(url.replace(/^\/api/, ""), { responseType: "arraybuffer", timeout: 60_000 });
  const buf = res.data;
  if (buf.byteLength % 4 !== 0) throw new Error("A field file must hold whole 32-bit floats");
  const dv = new DataView(buf);
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}
