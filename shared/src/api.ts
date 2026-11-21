/**
 * The HTTP contract between the drawer server, the CLI and the web app.
 * docs/SPEC.md explains behaviour; this file is the authority on shapes.
 * All routes are under /api. JSON unless stated. Errors: { error: ErrorCode, message: string }.
 */

export const LIBRARY_SLUG = "_library";
export const DEFAULT_PORT = 3050;

/** Who made a change. Sent as the X-Drawer-Author header on every write; defaults to "agent" in the CLI, "web" in the web app. */
export type Author = "agent" | "web" | "import" | "system" | (string & {});

export type ErrorCode =
  | "not_found" // 404
  | "conflict" // 409: rev mismatch; body carries the current rev
  | "exists" // 409: creating something that exists
  | "invalid" // 400
  | "edit_no_match" // 422: `old` not found, or found more than once without replaceAll
  | "render_failed" // 422
  | "import_failed" // 502
  | "forbidden" // 403: an agent tried something only a person may do (waive a gate)
  | "internal"; // 500

export interface ApiError {
  error: ErrorCode;
  message: string;
  /** Present on `conflict`: the file's current rev. */
  rev?: string;
}

/** How the web app and CLI treat a file. Derived from the extension by the server. */
export type FileKind = "markdown" | "scad" | "mesh" | "image" | "pdf" | "text" | "binary";

export interface Project {
  slug: string; // [a-z0-9][a-z0-9-]*, or "_library"
  title: string;
  description: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
  updatedBy: Author;
  fileCount: number;
  /** Path of the file whose render is the cover, or null: the chosen one, else the server's automatic pick. Never echo it back in a PATCH. */
  cover: string | null;
  /**
   * URL of the cover's thumbnail, a small PNG. It is addressed by what the picture is made of (the file and every
   * file it uses), so it changes only when the picture does and is served immutable. Null when nothing can be drawn.
   */
  thumbnail: string | null;
  /** Set when the project was created from an import. */
  source: ImportSource | null;
  /** What new parts start from. */
  defaults: ProjectDefaults;
  /** Gate results rolled up over the parts and the assembly. */
  status: ProjectStatus;
}

export interface ProjectDefaults {
  /** A material name from the library's materials.json. */
  material: string;
  strictness: Strictness;
}

/** `pending` = written but not evaluated yet. `overall` is the worst of the parts and the assembly; `empty` when there are no parts. */
export interface ProjectStatus {
  parts: number;
  passed: number;
  draft: number;
  failed: number;
  pending: number;
  assembly: ReportStatus | "none";
  overall: ReportStatus;
}

export interface CreateProjectBody {
  slug: string;
  title?: string;
  description?: string;
  /** Import this URL into refs/<name>/ right after creation. */
  fromUrl?: string;
  /** With fromUrl: which remote files to download (by ImportFile.id). Omitted = all. */
  fileIds?: string[];
  /** What is needed, in the person's words. Written to brief.md. */
  brief?: string;
  defaults?: Partial<ProjectDefaults>;
}

export interface PatchProjectBody {
  title?: string;
  description?: string;
  cover?: string | null;
  defaults?: Partial<ProjectDefaults>;
}

export interface TreeEntry {
  path: string; // project-relative, forward slashes, no leading slash
  type: "file" | "dir";
  kind?: FileKind; // files only
  size?: number; // files only, bytes
  rev?: string; // files only
  updatedAt?: string; // files only
  updatedBy?: Author; // files only
}

/** GET /projects/:slug/tree → every entry, depth-first, dirs before their children. */
export interface TreeResponse {
  entries: TreeEntry[];
}

export const MESH_FORMATS = ["stl", "3mf", "obj", "ply"] as const;
export type MeshFormat = (typeof MESH_FORMATS)[number];

export function isMeshFormat(value: string): value is MeshFormat {
  return MESH_FORMATS.some((format) => format === value);
}

export interface MeshInfo {
  format: MeshFormat;
  triangles: number;
  closed: boolean;
  /** Millimetres. */
  bbox: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  volumeCm3: number | null;
}

export const SCAN_UNITS = ["mm", "cm", "m", "in"] as const;
export type ScanUnit = (typeof SCAN_UNITS)[number];
export const MAX_SCAN_TRIANGLES = 2_000_000;

/** POST /projects/:slug/scans, with raw bytes in the body. */
export interface ScanQuery {
  name: string;
  filename: string;
  units?: ScanUnit;
}

export interface ScanResult {
  project: string;
  path: string;
  source: string;
  revisionId: string;
  mesh: MeshInfo;
  noiseMm: number;
}

export interface Link {
  /** Project-relative path of the file holding the link. */
  from: string;
  fromProject: string;
  /** Relation name: the word(s) before [[target]], or "links_to" for a link in prose, "uses"/"includes"/"imports" for SCAD statements. */
  relation: string;
  /** Raw target text as written. */
  target: string;
  /** Resolved file, or null while the target does not exist. */
  to: string | null;
  toProject: string | null;
}

export interface Fact {
  category: string;
  text: string;
  path: string;
  line: number;
}

export interface FileInfo {
  project: string;
  path: string;
  kind: FileKind;
  size: number;
  rev: string;
  updatedAt: string;
  updatedBy: Author;
  mesh: MeshInfo | null; // kind "mesh" only
  facts: Fact[]; // markdown only
  outgoing: Link[];
  incoming: Link[];
  /** SCAD only: module and function names defined in the file. */
  outline: string[];
}

export interface WriteResult {
  project: string;
  path: string;
  rev: string;
  created: boolean;
  revisionId: string;
  /** `.scad` writes and edits only: a parse and evaluation pass over the new text, without building geometry. Null for other files. */
  check: ScadCheck | null;
  /** Id of the part this file belongs to (its model or its spec), or null. The server has queued an evaluation; `POST .../parts/<id>/evaluate` waits for it. */
  part: string | null;
}

/** POST /projects/:slug/edit/<path> */
export interface EditBody {
  rev: string;
  old: string;
  new: string;
  replaceAll?: boolean;
  message?: string;
}

/** POST /projects/:slug/move */
export interface MoveBody {
  from: string;
  to: string;
  message?: string;
}

export interface Revision {
  id: string; // opaque; pass as ?at=<id> to read a file at that revision
  author: Author;
  message: string;
  date: string;
  paths: string[];
}

export interface HistoryResponse {
  revisions: Revision[];
}

export type RenderView = "iso" | "front" | "top" | "side";

/** POST /projects/:slug/render/<path>  (SCAD or mesh) */
export interface RenderBody {
  views?: RenderView[]; // default: all four
  size?: number; // px per view, square; default 800
  /** Render the file as of this revision instead of the current one. */
  at?: string;
  /** SCAD only: top-level parameter overrides for this render (`-D name=value`); the file is not changed. */
  params?: ParamValues;
}

export interface RenderResult {
  project: string;
  path: string;
  /** Hash of everything that affects the output; the cache key. */
  key: string;
  cached: boolean;
  seconds: number;
  /** URL paths (start with /api/renders/). */
  mesh: string; // full binary STL
  /** Lightweight STL for drawing a large mesh. Measurements always use the full mesh. */
  proxy?: string;
  views: Partial<Record<RenderView, string>>;
  /** One PNG with all requested views in a grid. */
  sheet: string;
  info: MeshInfo;
  /** OpenSCAD's ECHO lines and warnings. */
  log: string[];
  warnings: string[];
}

/** GET /projects/:slug/search?q=&kind=&limit= hits one project (or the library); paths are project-relative. */
export interface SearchHit {
  path: string;
  kind: FileKind;
  title: string;
  snippet: string; // plain text, match wrapped in « »
  score: number;
}

export interface SearchResponse {
  hits: SearchHit[];
}

export interface ContextNode {
  project: string;
  path: string;
  kind: FileKind;
  depth: number;
  /** How this node was reached; null for the root. */
  via: Link | null;
  /** File text for markdown/scad/text (truncated to maxBytes per node); null for others. */
  content: string | null;
  truncated: boolean;
  mesh: MeshInfo | null;
}

export interface ContextResponse {
  root: string;
  nodes: ContextNode[];
}

export type ImportSite = "printables" | "thingiverse" | "makerworld" | "cults3d" | "myminifactory" | "generic";

export interface ImportFile {
  id: string;
  name: string;
  size: number | null;
  /** False when the site does not hand out the file (Cults3D, MyMiniFactory): the user uploads it by hand. */
  downloadable: boolean;
}

export interface ImportSource {
  site: ImportSite;
  url: string;
  title: string;
  author: string | null;
  license: string | null;
  description: string; // markdown
  images: string[]; // remote URLs
  importedAt?: string;
}

/** POST /import/preview { url } */
export interface ImportPreview {
  source: ImportSource;
  files: ImportFile[];
  /** What is missing to fetch files, in plain words; null when nothing is. e.g. "Thingiverse needs an API token (THINGIVERSE_TOKEN)". */
  blocker: string | null;
}

/** POST /projects/:slug/import */
export interface ImportBody {
  url: string;
  fileIds?: string[]; // omitted = all downloadable
  /** Folder under refs/. Default: slug of the source title. */
  name?: string;
}

export interface ImportResult {
  project: string;
  dir: string; // e.g. "refs/earbuds-holder"
  written: string[]; // project-relative paths, includes source.md and images
  skipped: { name: string; reason: string }[];
  revisionId: string;
}

/**
 * Where a render is. `queued` waits for the single render slot; `analysing` reads the file and its
 * dependencies; `geometry` builds the mesh (the long one for SCAD); `views` draws one PNG per view;
 * `sheet` composes the contact sheet. `done` and `failed` end it.
 */
export type RenderStage = "queued" | "analysing" | "geometry" | "views" | "sheet" | "done" | "failed";

/** Server-sent events on GET /events. `data` is JSON of this shape. */
export type DrawerEvent =
  | { type: "project"; action: "created" | "updated" | "deleted"; slug: string }
  | { type: "file"; action: "written" | "deleted" | "moved"; project: string; path: string; rev: string | null; author: Author }
  | { type: "render"; project: string; path: string; key: string }
  /**
   * One per stage change of a running render. `step` of `total` counts the work units done so far
   * (0 while queued; `total` on done). `view` is set during `views`. `at` is the revision being
   * rendered, or null for the current file. A cache hit goes from `analysing` straight to `done`.
   */
  | { type: "render_progress"; project: string; path: string; at: string | null; stage: RenderStage; step: number; total: number; view: RenderView | null }
  /** A part's evaluation started (`evaluating: true`) or its report changed. `status` is null while the first evaluation runs. */
  | { type: "part"; project: string; part: string; evaluating: boolean; status: ReportStatus | null; passed: number; total: number }
  | { type: "assembly"; project: string; evaluating: boolean; status: ReportStatus | null }
  /** A session's state or items changed; `version` is the session's newest. `deleted` when the session is gone. */
  | { type: "session"; id: string; project: string; status: SessionStatus; activity: string | null; version: number; deleted: boolean }
  /** The settings changed: GET /settings again. */
  | { type: "settings" };

export interface Health {
  ok: true;
  version: string;
  openscad: string | null; // version string, null when the renderer is unavailable
}


// ============================================================================================
// Parts, specs and gates
// ============================================================================================
//
// A part is a spec plus a model, both files in the project (docs/SPEC.md → Parts):
//   parts/<id>.part.json   the PartSpec: what must be true
//   parts/<id>.scad        the model (absent until the first attempt)
// The library holds shared parts the same way (bought hardware: screws, magnets, bearings);
// an assembly refers to them as "_library/<id>".
// The server measures the model against the spec and decides the status. No client sets it.

export const PART_DIR = "parts";
export const PART_SPEC_SUFFIX = ".part.json";
export const ASSEMBLY_FILE = "assembly.json";
export const BRIEF_FILE = "brief.md";
export const PRINTER_FILE = "printer.json"; // in the library
export const MATERIALS_FILE = "materials.json"; // in the library

/** How many gates apply by default. `quick`: parses, solid, fits the bed, spec dimensions. `standard` adds lint, flat base, overhangs, minimum wall. `functional` also turns warnings into failures. */
export type Strictness = "quick" | "standard" | "functional";
export type Axis = "x" | "y" | "z";
export type Vec3 = [number, number, number];

/** `passed`: every gate passes, is waived or only warns. `draft`: the model builds but a gate fails. `failed`: the model does not parse or produces no solid. `empty`: no model yet. `pending`: not evaluated yet. */
export type ReportStatus = "passed" | "draft" | "failed" | "empty" | "pending";

/**
 * What to measure, and the range it must fall in: `nominal` ± `tol`, or `min` and/or `max`.
 * All lengths in millimetres, in the model's own coordinates (as modelled, the print orientation).
 *
 * - size:     extent of the bounding box along `axis`.
 * - envelope: the bounding box must fit inside `box` (x, y, z).
 * - hole:     diameter of the round opening in the cross-section at `axis` = `at`, the one whose centre
 *             is nearest to `near` (the two other coordinates, in x-y-z order without `axis`).
 * - boss:     the same for a round outline of material: a pin, a peg, a round body.
 * - gap:      free distance through the point `from` along `axis` (the point must be in air: a slot, a bore).
 * - wall:     material thickness through the point `from` along `axis` (the point must be inside material).
 * - min_wall: the thinnest wall anywhere in the part must be at least `min`.
 * - volume:   solid volume in cm³.
 */
export const DIMENSION_KINDS = ["size", "envelope", "hole", "boss", "gap", "wall", "min_wall", "volume"] as const;
export type DimensionKind = (typeof DIMENSION_KINDS)[number];

/** A model that fails to build or has no single closed body cannot be waived. */
export const UNWAIVABLE_GATES: readonly string[] = ["parses", "solid"] as const;

export interface Dimension {
  /** Unique in the spec: [a-z0-9][a-z0-9_-]*. */
  id: string;
  label: string;
  kind: DimensionKind;
  axis?: Axis; // size, hole, boss, gap, wall
  at?: number; // hole, boss: position of the cutting plane along `axis`
  near?: [number, number]; // hole, boss
  from?: Vec3; // gap, wall
  box?: Vec3; // envelope
  nominal?: number;
  tol?: number;
  min?: number;
  max?: number;
}

/** A person's decision that a failing gate is acceptable for this part. Agents cannot add one. */
export interface Waiver {
  gate: string;
  reason: string;
  by: Author;
  at: string;
}

export interface PrintResult {
  /** The revision that was printed. */
  revisionId: string;
  at: string;
  outcome: "ok" | "issue";
  note: string;
}

/** parts/<id>.part.json. Written through PUT .../parts/<id>; the server validates it. */
export const PART_SOURCES = ["printed", "bought", "scanned"] as const;
export type PartSource = (typeof PART_SOURCES)[number];

export interface Pose {
  /** Euler rotations about x, then y, then z, in degrees. */
  rotate: Vec3;
  translate: Vec3;
}

export interface ScanPlacement extends Pose {
  file: string;
}

export interface Match {
  id: string;
  label: string;
  /** Part id in the project. */
  to: string;
  tol: number;
  /** Required area share in both directions. Defaults to 0.95. */
  share?: number;
}

export interface PartSpec {
  title: string;
  /** What kind of part it is, in a few words ("snap-fit clip", "enclosure lid"). Guides the modeller; no gate reads it. */
  class: string;
  description: string;
  /** `bought`: hardware that is not printed; only its model and size matter (no printability gates). */
  source: PartSource;
  scan?: ScanPlacement;
  material: string;
  strictness: Strictness;
  dimensions: Dimension[];
  matches: Match[];
  waivers: Waiver[];
  prints: PrintResult[];
}

/** Body of PUT .../parts/<id>: everything a client may set. `waivers` and `prints` have their own routes. */
export type PartSpecBody = Partial<Omit<PartSpec, "waivers" | "prints">> & { title: string };

export type GateStatus = "pass" | "fail" | "warn" | "skipped" | "waived";

export interface GateResult {
  /** "parses" | "lint" | "solid" | "fits_bed" | "base" | "overhang" | "min_wall" | "dim:<dimension id>"; assemblies: "parts" | "clash" | "floating" | "mate:<mate id>" | "bom". */
  id: string;
  label: string;
  status: GateStatus;
  /** What was found and what was required, ready to show ("1.2 mm", "≥ 1.6 mm"). */
  measured: string | null;
  expected: string | null;
  /** Why it failed or was skipped, or the waiver's reason. */
  detail: string | null;
  /** What to change to make it pass; null when it passes. */
  hint: string | null;
  /** Where the problem is, when the measurement has a place. */
  at: Vec3 | null;
}

export interface Diagnostic {
  level: "error" | "warning";
  message: string;
  /** Project-relative ("_library/..." for library files); null when OpenSCAD names none. */
  file: string | null;
  line: number | null;
}

export interface ScadCheck {
  ok: boolean; // no errors
  diagnostics: Diagnostic[];
}

export type ParamValue = number | string | boolean | number[];
export type ParamValues = Record<string, ParamValue>;

/** A top-level assignment before the first module or function: what OpenSCAD's Customizer and `-D` can change. */
export interface ScadParam {
  name: string;
  type: "number" | "string" | "boolean" | "vector";
  value: ParamValue;
  /** From the `[Group]` block comment above it; "" when ungrouped. Parameters under [Hidden] are left out. */
  group: string;
  /** The comment on the line above, or "". */
  description: string;
  /** From `// [min:max]` or `// [min:step:max]`. */
  min: number | null;
  max: number | null;
  step: number | null;
  /** From `// [a, b, c]` or `// [a:Label, b:Label]`. */
  options: { value: number | string; label: string }[] | null;
  line: number;
}

/** Measurements of a solid that need no spec. Areas in mm². */
export interface MeshAnalysis {
  /** Disconnected bodies. */
  shells: number;
  /** Every edge is shared by exactly two triangles. */
  watertight: boolean;
  surfaceAreaMm2: number;
  /** Downward faces at the lowest z: what touches the bed. */
  baseAreaMm2: number;
  /** Bounding box x × y. */
  footprintMm2: number;
  /** Faces steeper than `angle` degrees from vertical that are not on the bed. `at` is in the largest such region. */
  overhang: { angle: number; areaMm2: number; at: Vec3 | null };
  /** Thinnest wall that covers a meaningful area (not a single sliver triangle); null when the mesh is not closed. */
  wall: { minMm: number; at: Vec3 } | null;
  /** URL of the wall thickness per triangle of the render's mesh.stl, in its order: Float32 little-endian, mm, NaN where unknown. */
  thickness: string | null;
}

export const FEATURE_KINDS = ["plane", "cylinder", "sphere"] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

export interface Feature {
  kind: FeatureKind;
  /** A point on the plane or axis, or the sphere centre. */
  origin: Vec3;
  /** Plane normal or cylinder axis. */
  direction: Vec3 | null;
  diameter: number | null;
  length: number | null;
  side: "hole" | "boss" | null;
  areaMm2: number;
  rms: number;
  maxError: number;
  coverage: number;
}

export interface AlignBody extends FeaturesBody {
  to?: CompareSide;
}

export interface AlignResult extends Pose {
  rms: number | null;
  ambiguous: (Pose & { rms: number })[];
}

export interface FeaturesBody { revision?: string }

export interface FeaturesResult {
  features: Feature[];
  field: string;
  /** Mesh that the feature values index, one value per displayed triangle. */
  mesh: string;
}

export interface FitBody extends FeaturesBody {
  at: Vec3;
  kind?: FeatureKind;
}

/** One closed section outline, in the two remaining axes in x-y-z order. */
export interface SliceContour {
  /** True when material is outside the outline (a hole in the section). */
  hole: boolean;
  areaMm2: number;
  centre: [number, number];
  bbox: { min: [number, number]; max: [number, number] };
  /** Best-fit circle; `rms` is the fit error in mm. `round` when rms is under 2 % of the diameter. */
  circle: { centre: [number, number]; diameter: number; rms: number; round: boolean };
  /** The outline, simplified to at most 200 points. */
  points: [number, number][];
}

export interface SliceResult {
  axis: Axis;
  at: number | null;
  open: [number, number][][];
  contours: SliceContour[];
}

export interface ProbeResult {
  /** Whether `from` is inside material. */
  inside: boolean;
  /** The point lies on the surface (within 0.01 mm), so `inside` and the run are not meaningful: move the point. */
  onSurface: boolean;
  /** Length of the run of material (inside) or air (outside) through `from` along `axis`; null when it is unbounded (air that reaches outside the part). */
  distance: number | null;
  /** Coordinates along `axis` where that run ends on each side; null when unbounded. */
  low: number | null;
  high: number | null;
}

export interface RenderRef {
  key: string;
  mesh: string;
  /** Lightweight STL for drawing a large mesh. Measurements always use the full mesh. */
  proxy?: string;
  views: Partial<Record<RenderView, string>>;
  sheet: string;
}

export interface PartSummary {
  project: string;
  /** [a-z0-9][a-z0-9-]*: the file name without suffix. */
  id: string;
  title: string;
  class: string;
  source: PartSource;
  material: string;
  strictness: Strictness;
  /** Project-relative paths. `model` is null until the part has one. */
  spec: string;
  model: string | null;
  status: ReportStatus;
  passed: number;
  total: number;
  /** Labels of the failing gates. */
  failing: string[];
  evaluating: boolean;
  /** Outcome of the newest recorded print, or null. */
  printed: "ok" | "issue" | null;
  updatedAt: string;
  updatedBy: Author;
}

/** The server's verdict on one part at one state of its files. */
export interface PartReport {
  project: string;
  part: string;
  /** Revision of the project the model was read from. */
  revisionId: string;
  status: ReportStatus;
  passed: number;
  total: number;
  gates: GateResult[];
  spec: PartSpec;
  /** Null when there is no model or it does not build. */
  mesh: MeshInfo | null;
  analysis: MeshAnalysis | null;
  render: RenderRef | null;
  params: ScadParam[];
  /** Mass in grams from the volume and the material's density; null without a mesh. */
  massG: number | null;
  /** What to do next, most important first; empty when passed. Written for the agent. */
  next: string[];
  /** True when the report used `params` overrides: a what-if, not the part's status. */
  whatIf: boolean;
  seconds: number;
  evaluatedAt: string;
}

/** POST .../parts/<id>/evaluate */
export interface EvaluateBody {
  /** Evaluate the part as of this revision. */
  at?: string;
  /** Parameter overrides: what would the report be with these values? Nothing is written. */
  params?: ParamValues;
}

/** POST .../parts/<id>/params: rewrites the values of top-level parameters in the model. One revision. */
export interface SetParamsBody {
  rev: string; // rev of the model file
  values: ParamValues;
  message?: string;
}

/** POST /projects/:slug/measure/<path> (a .scad or mesh file: a part's model, a reference, anything) */
export interface MeasureBody {
  /** Measure the file as of this revision; default current. */
  revision?: string;
  params?: ParamValues;
}

export interface MeasureResult {
  project: string;
  path: string;
  mesh: MeshInfo;
  analysis: MeshAnalysis;
  render: RenderRef;
}

/** POST /projects/:slug/slice/<path>, /probe/<path>, /section/<path>: the same files as measure. */
export interface SliceBody {
  axis: Axis;
  at?: number;
  shadow?: boolean;
  /** The file as of this revision; default current. */
  revision?: string;
}

export interface ProbeBody {
  from: Vec3;
  axis: Axis;
  revision?: string;
}

export interface SectionBody {
  axis: Axis;
  at: number;
  revision?: string;
  size?: number; // px, default 800
}

/** The part cut at `axis` = `at`, the side below the plane kept, drawn looking at the cut face. */
export interface SectionResult {
  axis: Axis;
  at: number;
  image: string; // URL path of a PNG
}

/** POST .../parts/<id>/waive (people only: `forbidden` for the author "agent") */
export interface WaiveBody {
  gate: string;
  /** Empty string removes the waiver. */
  reason: string;
}

/** POST .../parts/<id>/prints */
export interface PrintBody {
  outcome: "ok" | "issue";
  note: string;
  /** Default: the current revision. */
  revisionId?: string;
}

/**
 * One state of a part's model in the project's history. Attempts form a tree: `parent` is the attempt
 * this one was made from. Restoring an old attempt makes it current again without a new attempt; the
 * next write then becomes its child, so a different approach is a branch.
 */
export interface Attempt {
  revisionId: string;
  parent: string | null;
  author: Author;
  message: string;
  date: string;
  current: boolean;
  /** From the report cache; null when this attempt was never evaluated. */
  status: ReportStatus | null;
  passed: number | null;
  total: number | null;
}

/** POST .../parts/<id>/restore */
export interface RestoreBody {
  revisionId: string;
}

/** One side of a comparison: a part or a mesh/SCAD file, optionally at a revision. */
export interface CompareSide {
  part?: string;
  path?: string;
  at?: string;
}

export const DEFAULT_COMPARE_TOL = 0.2;

export interface DeviationStats {
  min: number;
  max: number;
  rms: number;
  p95: number;
  /** Area share within the tolerance. */
  within: number;
}

/** POST /projects/:slug/compare: how B differs from A. */
export interface CompareResult {
  a: { render: RenderRef; mesh: MeshInfo };
  b: { render: RenderRef; mesh: MeshInfo };
  /** B to A. Positive lies on the normal side of A. Reverse is A to B. */
  deviation: DeviationStats & {
    tol: number;
    reverse: DeviationStats;
    at: Vec3 | null;
    field: string;
    /** The mesh indexed by the field painted on B. */
    mesh: string;
  };
  volumeDeltaCm3: number | null;
  sizeDelta: Vec3;
}

// ============================================================================================
// Printer and materials (structured library data the gates read)
// ============================================================================================

/** _library/printer.json */
export interface PrinterProfile {
  name: string;
  /** Build volume in mm. */
  bed: Vec3;
  nozzleMm: number;
  layerMm: number;
  /** Thinnest wall that prints reliably. */
  minWallMm: number;
  /** Steepest overhang from vertical that prints without support, degrees. */
  maxOverhangDeg: number;
  /** Overhang area tolerated before the gate fails, mm². */
  maxOverhangAreaMm2: number;
  /** Clearances per side that worked on this machine, mm. */
  clearance: { sliding: number; press: number };
}

export interface Material {
  name: string;
  densityGCm3: number;
  /** Overrides the printer's minimum wall for this material, or null. */
  minWallMm: number | null;
  notes: string;
}

/** _library/materials.json */
export interface MaterialsFile {
  materials: Material[];
}

/** GET /library/profile */
export interface LibraryProfile {
  printer: PrinterProfile;
  materials: Material[];
  /** True while printer.json still holds the starter's example printer: the library has not been set up. */
  printerIsExample: boolean;
}

// ============================================================================================
// Assembly
// ============================================================================================

/** One placed copy of a part. The part's model is rotated (degrees about x, then y, then z, like OpenSCAD's rotate()) and then moved. */
export interface AssemblyInstance {
  /** Unique in the assembly: [a-z0-9][a-z0-9_-]*. */
  id: string;
  /** A part of this project ("tray") or of the library ("_library/m3x8-screw"). */
  part: string;
  translate: Vec3;
  rotate: Vec3;
}

/**
 * How two instances must meet. Gap = smallest distance between their surfaces, mm.
 * - clearance: they do not overlap and the gap is within `min`..`max`.
 * - contact:   they do not overlap and the gap is at most 0.05 mm.
 * - press:     they may overlap (interference fit); exempt from the clash gate.
 */
export interface Mate {
  id: string;
  label: string;
  a: string; // instance id
  b: string;
  fit: "clearance" | "contact" | "press";
  min?: number;
  max?: number;
}

/** assembly.json. Written through PUT /projects/:slug/assembly. */
export interface AssemblySpec {
  title: string;
  instances: AssemblyInstance[];
  mates: Mate[];
}

export interface BomLine {
  part: string;
  title: string;
  count: number;
  source: PartSource;
  material: string | null;
  massG: number | null; // per piece
}

export interface OpenClash {
  depthMm: number;
  limitMm: number;
}

export interface AssemblyReport {
  project: string;
  revisionId: string;
  status: ReportStatus;
  passed: number;
  total: number;
  gates: GateResult[];
  spec: AssemblySpec;
  /** Each instance with the mesh to draw and its 4×4 placement, row-major. */
  instances: { id: string; part: string; partStatus: ReportStatus; mesh: string | null; matrix: number[] }[];
  /** Every pair that is mated or whose bounding boxes come within 1 mm. */
  pairs: { a: string; b: string; gapMm: number; overlapCm3: number | null; penetration?: OpenClash }[];
  bom: BomLine[];
  totalPrintedMassG: number | null;
  render: Omit<RenderRef, "mesh"> | null;
  next: string[];
  seconds: number;
  evaluatedAt: string;
}

// ============================================================================================
// Agent sessions
// ============================================================================================
//
// A session is one conversation between a person and a modelling agent about one project. It lives
// on the server (DRAWER_DATA/sessions) so any device can attach. An agent runner (a separate process
// with a provider login) claims the work through the /runner routes and drives the provider's agent,
// which reaches drawer only through this HTTP API.

/** The coding agents a runner can drive. Each has an adapter in `agent/src/providers/`. */
export const PROVIDER_KINDS = ["claude", "codex", "pi", "gemini"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** `queued`: waiting for a runner. `working`: the agent is on a turn. `waiting`: the agent asked a question. `idle`: the turn ended. `stopped`: a person stopped it. `failed`: the provider or runner failed. */
export type SessionStatus = "queued" | "working" | "waiting" | "idle" | "stopped" | "failed";

export interface Session {
  id: string;
  project: string;
  title: string;
  provider: ProviderKind;
  model: string | null;
  status: SessionStatus;
  /** What the agent is doing right now, in a few words; null when not working. */
  activity: string | null;
  /** Messages a person sent that no turn has picked up yet. */
  pending: number;
  toolCalls: number;
  /** Sequence number of the newest item. */
  seq: number;
  /** Goes up by one each time an item is appended or changed (a tool call finishing, a question answered). */
  version: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Something a message points at, picked in the viewer. */
export type SessionRef =
  | { kind: "part"; part: string }
  | { kind: "point"; part: string; position: Vec3; normal: Vec3 | null }
  | { kind: "file"; path: string };

/**
 * A file a person attached to a message: a photo, a reference mesh, a datasheet. Uploaded first
 * (POST /projects/:slug/attachments), then named by id in the message. It lives with the session state
 * (DRAWER_DATA/sessions/attachments), not in the project, until the agent files it into the project
 * (POST /attachments/:id/file). Unsent uploads are dropped after a day; a session's go with it.
 */
export interface SessionAttachment {
  id: string;
  /** The uploaded file name, one path segment. */
  name: string;
  /** From the extension; `application/octet-stream` when unknown. */
  mediaType: string;
  size: number;
  /** The same kind a project file with this name and content would get. */
  kind: FileKind;
  /** URL path of the bytes: `/api/attachments/<id>` (`?download=1` for a download). */
  url: string;
  /** Project-relative path it was last filed to, or null. */
  filedAs: string | null;
}

/** At most this many attachments per message, each at most MAX_ATTACHMENT_BYTES. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** POST /attachments/:id/file: copy the attachment into its project as one revision. */
export interface FileAttachmentBody {
  /** Project-relative destination, e.g. "refs/caliper-photo.jpg". */
  path: string;
  /** Omitted: the path must not exist yet. The current rev (or "*") replaces the file there. */
  rev?: string;
  message?: string;
}

export interface FileAttachmentResult {
  attachment: SessionAttachment;
  write: WriteResult;
}

/** `seq` is the item's place in the conversation and never changes; `version` is the session version of its last change. */
export type SessionItem = { seq: number; version: number; at: string } & (
  /** `text` may be empty when the message only carries attachments. Filing an attachment changes the item (`filedAs`). */
  | { type: "user"; text: string; refs: SessionRef[]; attachments: SessionAttachment[]; author: Author }
  | { type: "assistant"; text: string }
  | { type: "tool"; callId: string; name: string; summary: string; status: "running" | "ok" | "error"; result: string | null; images: string[] }
  /**
   * `multiple`: the person may pick several options. `answers` is null until answered, then each entry is one
   * picked option verbatim or the person's own words: exactly one for a single question, one or more for a multiple one.
   */
  | { type: "question"; questionId: string; text: string; options: string[]; multiple: boolean; answers: string[] | null }
  /** What the model reported thinking, display only: never sent back to a model, never searched. `seconds` is how long the thought has run. */
  | { type: "reasoning"; reasoningId: string; text: string; status: "running" | "done"; seconds: number }
  | { type: "notice"; level: "info" | "error"; text: string }
);

/** POST /projects/:slug/sessions */
export interface CreateSessionBody {
  /** May be empty when `attachments` is not. */
  message: string;
  refs?: SessionRef[];
  /** Ids of uploads of this project not yet sent with a message. */
  attachments?: string[];
  /** Must be enabled in settings; default: the settings' `defaultProvider`. */
  provider?: ProviderKind;
  /** Default: that provider's `defaultModel` in settings. */
  model?: string;
}

/** POST /sessions/:id/messages */
export interface SessionMessageBody {
  /** May be empty when `attachments` is not. */
  text: string;
  refs?: SessionRef[];
  /** Ids of uploads of the session's project not yet sent with a message. */
  attachments?: string[];
}

/** GET /sessions/:id?since=<version>: the session and the items appended or changed after that version (all of them without `since`). */
export interface SessionDetail {
  session: Session;
  items: SessionItem[];
}

/** POST /sessions/:id/answer: exactly one answer for a single question, one or more distinct ones for a multiple one. */
export interface AnswerBody {
  questionId: string;
  answers: string[];
}

/**
 * What a runner found for one provider. `ready`: it takes turns. `disabled`: off in settings.
 * `not_installed`: the CLI is not on the runner's host. `signed_out`: installed, no login.
 * `unavailable`: installed, but it cannot run safely or failed its check (`message` says why).
 */
export type ProviderState = "ready" | "disabled" | "not_installed" | "signed_out" | "unavailable";

export interface ProviderStatus {
  kind: ProviderKind;
  state: ProviderState;
  /** The CLI's version, when it could be read. */
  version: string | null;
  /** The provider's own models plus the custom ones from settings. */
  models: string[];
  /** Why it is not ready, or how to sign in; null when there is nothing to say. */
  message: string | null;
  /** The CLI the runner runs for it, as the runner's host resolved it; null when none was found. */
  binary: string | null;
}

export interface RunnerInfo {
  id: string;
  /** Every provider the runner knows, in whatever state. Only `ready` ones get turns. */
  providers: ProviderStatus[];
  /** False while every turn slot is taken. */
  accepting: boolean;
  lastSeen: string;
}

/** GET /runners: which agent runners polled in the last minute. Empty means sessions will stay queued. */
export interface RunnersResponse {
  runners: RunnerInfo[];
}

/**
 * POST /runner/work: long poll by a runner, with what it offers; → `RunnerWork`, null when nothing turned
 * up within `wait` seconds. `boot` is a random string the runner process picks at start: a new one tells
 * the server the old process is gone, and the sessions it held fail. The server hands out a turn only for
 * a provider that is `ready` here and enabled in settings, and only while `accepting`.
 */
export interface RunnerPoll {
  runner: string;
  boot: string;
  providers: ProviderStatus[];
  accepting: boolean;
  /** Seconds, at most 30. */
  wait: number;
}

/**
 * `turn`: run the agent for this session until it ends its turn. `messages` are the user items not yet
 * seen by the agent; `resume` is what the provider gave for this session before (PATCH below).
 * `stop`: interrupt the session this runner is working on.
 */
export type RunnerWork =
  | { kind: "turn"; session: Session; messages: SessionItem[]; resume: string | null; guide: string }
  | { kind: "stop"; sessionId: string }
  | null;

/**
 * The items a runner appends (POST /sessions/:id/items?runner=&boot=); the server assigns seq and at. A `tool`
 * item with a known callId replaces the earlier one, and so does a `reasoning` item with a known reasoningId
 * (a thought streams as a few coarse updates, then closes as `done`). Only the runner that holds the session may append or
 * patch: anyone else gets `409 conflict`.
 */
export type NewSessionItem =
  | { type: "assistant"; text: string }
  | { type: "tool"; callId: string; name: string; summary: string; status: "running" | "ok" | "error"; result: string | null; images: string[] }
  | { type: "question"; questionId: string; text: string; options: string[]; multiple: boolean }
  | { type: "reasoning"; reasoningId: string; text: string; status: "running" | "done"; seconds: number }
  | { type: "notice"; level: "info" | "error"; text: string };

/** PATCH /sessions/:id?runner=&boot= by the runner that holds the session. */
export interface RunnerSessionPatch {
  status?: SessionStatus;
  activity?: string | null;
  error?: string | null;
  /** The provider's own session handle, kept for the next turn. */
  resume?: string | null;
}

// ---- settings ----

/** How one provider is used. Logins stay with each CLI on the runner's host: no keys here. */
export interface ProviderSettings {
  /** Off: no runner offers it and no session can start with it. */
  enabled: boolean;
  /** The model a new session gets when it names none; null = the provider's own default. */
  defaultModel: string | null;
  /** Model ids offered besides the ones the provider lists. */
  customModels: string[];
}

/**
 * A model id as the providers spell them (`sonnet`, `gpt-5.1-codex`, `anthropic/claude-sonnet-4-5`). It
 * reaches a provider CLI's arguments, so the server refuses any other value in settings and session
 * requests, and the runner refuses it again before a turn.
 */
export const isModelId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(value) && !value.includes("..") && !value.includes("//");

/** A provider's own session handle (`RunnerSessionPatch.resume`), held to the same kind of rule. */
export const isResumeHandle = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);

/** GET /settings. Kept in DRAWER_DATA/settings.json; every provider in PROVIDER_KINDS has an entry. */
export interface Settings {
  /** The provider a new session gets when it names none. Always an enabled one. */
  defaultProvider: ProviderKind;
  providers: Record<ProviderKind, ProviderSettings>;
}

/** PATCH /settings (people only: `forbidden` for the author "agent"). Only the fields sent change. */
export interface PatchSettingsBody {
  defaultProvider?: ProviderKind;
  providers?: Partial<Record<ProviderKind, Partial<ProviderSettings>>>;
}

/** GET /sessions?project=<slug> */
export interface SessionsResponse {
  sessions: Session[];
}

/** GET /projects/:slug/parts */
export interface PartsResponse {
  parts: PartSummary[];
}

/** GET .../parts/<id>/attempts, oldest first. */
export interface AttemptsResponse {
  attempts: Attempt[];
}

/** POST /projects/:slug/compare */
export interface CompareBody {
  a: CompareSide;
  b: CompareSide;
  tol?: number;
}

/** GET /projects/:slug/overview: what an agent reads first. */
export interface ProjectOverview {
  project: Project;
  brief: string;
  /** AGENTS.md of the project. */
  memory: string;
  parts: PartSummary[];
  assembly: { status: ReportStatus; instances: number; failing: string[] } | null;
  /** refs/ and notes/ files, project-relative. */
  references: string[];
  notes: string[];
  library: { profile: LibraryProfile; notes: string[]; parts: PartSummary[] };
}

export const HEADER_REV = "x-drawer-rev";
export const HEADER_AUTHOR = "x-drawer-author";
export const HEADER_MESSAGE = "x-drawer-message"; // URI-encoded
