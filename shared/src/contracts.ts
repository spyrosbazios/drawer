/**
 * Contracts between the server and its two helper packages. The server depends on these
 * interfaces only; @drawer/render and @drawer/importers implement them.
 */
import type { Axis, Diagnostic, ImportFile, ImportPreview, ImportSite, MeshAnalysis, MeshInfo, ParamValues, ProbeResult, RenderStage, RenderView, ScadParam, SliceResult, Vec3, ScanUnit, MeshFormat } from "./api";

// ---- @drawer/render ---------------------------------------------------------------------

export interface RendererOptions {
  /** Cache root. Meshes and previews have separate directories and keys. */
  cacheDir: string;
  /** Command line prefix for OpenSCAD, split on spaces. Default "openscad". */
  openscadCmd?: string;
  /** Seconds before a render is killed. Default 120. */
  timeoutSeconds?: number;
}

export interface MeshRequest {
  /** Absolute path of the .scad or mesh file to render. */
  file: string;
  /** Directories for OPENSCADPATH, in order (project root, library root). */
  searchPaths: string[];
  /** SCAD only: top-level overrides passed as `-D name=value`. Part of the cache key. */
  params?: ParamValues;
}

export interface RenderRequest extends MeshRequest {
  views: RenderView[];
  size: number;
  /** Called on every stage change, `queued` first. A cache hit stops after `analysing`. Must not throw. */
  onProgress?: (p: RenderProgress) => void;
}

/** `step` work units are finished out of `total`; the stage named is the one now running. */
export interface RenderProgress {
  stage: Exclude<RenderStage, "done" | "failed">;
  step: number;
  total: number;
  view: RenderView | null;
}

export interface MeshOutput {
  key: string;
  cached: boolean;
  seconds: number;
  /** Absolute directory holding the outputs. */
  dir: string;
  info: MeshInfo;
  log: string[];
  warnings: string[];
}

export interface RenderOutput extends MeshOutput {
  meshKey: string;
  proxy: boolean;
  views: RenderView[];
}

/** Thrown by render() when OpenSCAD fails or times out; message carries its stderr. */
export class RenderError extends Error {
  override name = "RenderError";
}

/** The key of a finished mesh in `<cacheDir>/meshes/`. */
export type MeshKey = string;

/** MeshAnalysis with the thickness field as a file name inside the render's cache directory (the server turns it into a URL). */
export type MeshAnalysisOutput = Omit<MeshAnalysis, "thickness"> & { thicknessFile: string | null };

export interface CheckOutput {
  ok: boolean;
  /** `file` is absolute, as OpenSCAD reports it; the server makes it project-relative. */
  diagnostics: Diagnostic[];
  log: string[];
}

/** A solid placed in space: 4×4 row-major matrix applied to the render's mesh. */
export interface PlacedMesh {
  key: MeshKey;
  matrix: number[];
}

export interface DeviationOutput {
  min: number;
  max: number;
  rms: number;
  p95: number;
  at: Vec3 | null;
  /** File name inside B's cache directory: Float32 LE per triangle of B's mesh.stl. */
  fieldFile: string;
}

export interface AssemblyRenderOutput {
  key: string;
  cached: boolean;
  dir: string;
  views: RenderView[];
}

export interface ScanNormalization {
  bytes: Uint8Array;
  info: MeshInfo;
  originalTriangles: number;
  degenerateTriangles: number;
  debrisTriangles: number;
  noiseMm: number;
  unit: string;
}

export interface Renderer {
  /** OpenSCAD's version string, or null when it cannot be run. Cached after the first call. */
  version(): Promise<string | null>;
  /** Renders one at a time (internal queue). Throws RenderError. */
  render(req: RenderRequest): Promise<RenderOutput>;
  /** Produce just the mesh and its metadata, without any PNG previews. */
  mesh(req: MeshRequest): Promise<MeshOutput>;
  /** Pure parse of a mesh file on disk; no OpenSCAD. Throws on an unreadable file. */
  meshInfo(file: string): Promise<MeshInfo>;
  /** Normalize uploaded scan bytes before any project files are written. */
  normalizeScan(req: { format: MeshFormat; bytes: Uint8Array; units?: ScanUnit }): Promise<ScanNormalization>;

  /** Parses and evaluates a .scad file without building geometry (seconds, not minutes). Never throws for a broken file: that is `ok: false`. Throws RenderError only when OpenSCAD cannot be run. */
  check(req: { file: string; searchPaths: string[]; params?: ParamValues }): Promise<CheckOutput>;
  /** Customizer parameters of SCAD source text. Pure. */
  params(source: string): ScadParam[];
  /** The source with the values of the named top-level parameters replaced; everything else byte-for-byte unchanged. Throws RenderError for a name that is not a parameter or a value of the wrong type. Pure. */
  applyParams(source: string, values: ParamValues): string;

  // Everything below works on a finished mesh and is cached beside it (`<cacheDir>/meshes/<key>/`).
  // None of it may block the event loop for long: mesh maths runs in a worker.
  /** Shells, base, overhangs, wall thickness. `overhangDeg` is the steepest printable angle from vertical. */
  analyse(req: { key: MeshKey; overhangDeg: number }): Promise<MeshAnalysisOutput>;
  /** Cross-section outlines at `axis` = `at`. */
  slice(req: { key: MeshKey; axis: Axis; at: number }): Promise<SliceResult>;
  /** The run of material or air through a point along an axis. */
  probe(req: { key: MeshKey; from: Vec3; axis: Axis }): Promise<ProbeResult>;
  /** PNG of the solid cut at `axis` = `at` (the lower side kept), looking at the cut. Returns the file name inside the cache directory. Throws RenderError. */
  section(req: { key: MeshKey; axis: Axis; at: number; size: number }): Promise<string>;
  /** A view of a finished render scaled down to at most `size` pixels on its longer side. Returns the file name inside the cache directory. Throws RenderError. */
  thumbnail(req: { key: string; view: RenderView; size: number }): Promise<string>;
  /** Signed distance from B's surface to A's. */
  deviation(req: { a: MeshKey; b: MeshKey }): Promise<DeviationOutput>;
  /** Smallest distance between two placed solids (0 when they touch or overlap) and the volume they share. */
  interference(req: { a: PlacedMesh; b: PlacedMesh }): Promise<{ gapMm: number; overlapCm3: number }>;
  /** Views and a contact sheet of several placed solids together, each in its own colour; `highlight` pairs are drawn in the warning colour. Cached under its own key. Throws RenderError. */
  renderAssembly(req: { instances: (PlacedMesh & { id: string })[]; highlight: string[]; views: RenderView[]; size: number }): Promise<AssemblyRenderOutput>;
}

/** @drawer/render default export shape: `export function createRenderer(opts: RendererOptions): Renderer` */
export type CreateRenderer = (opts: RendererOptions) => Renderer;

// ---- @drawer/importers ------------------------------------------------------------------

/** Credentials, read from the environment by the server and passed in. All optional. */
export interface ImportCredentials {
  thingiverseToken?: string;
  makerworldToken?: string;
  cults3dUser?: string;
  cults3dKey?: string;
  myminifactoryKey?: string;
}

export interface Importers {
  /** Which site a URL belongs to ("generic" for anything unknown). Pure. */
  detect(url: string): ImportSite;
  /** Metadata and file list. Never throws for a missing credential (sets `blocker`); throws ImportError when the site cannot be reached or the model does not exist. */
  preview(url: string): Promise<ImportPreview>;
  /** Streams one file from a preview to `destPath` (absolute). Throws ImportError. */
  download(url: string, file: ImportFile, destPath: string): Promise<void>;
  /** Downloads a remote image (from ImportSource.images) to `destPath`. */
  downloadImage(imageUrl: string, destPath: string): Promise<void>;
}

export class ImportError extends Error {
  override name = "ImportError";
}

/** @drawer/importers export shape: `export function createImporters(creds: ImportCredentials): Importers` */
export type CreateImporters = (creds: ImportCredentials) => Importers;
