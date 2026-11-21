/**
 * Defensive readers for the server's responses. Each schema is checked against the contract type in
 * `shared/src/api.ts` with `satisfies`, so a change there is a compile error here.
 */
import type {
  AlignResult,
  AssemblyReport,
  AttemptsResponse,
  CompareResult,
  FileAttachmentResult,
  FileInfo,
  Feature,
  FeaturesResult,
  HistoryResponse,
  ImportPreview,
  ImportResult,
  LibraryProfile,
  MeasureResult,
  PartReport,
  PartSummary,
  PartsResponse,
  ProbeResult,
  Project,
  ProjectOverview,
  RenderResult,
  ProviderSettings,
  ProviderStatus,
  RunnersResponse,
  SearchResponse,
  SectionResult,
  ScanResult,
  Session,
  SessionAttachment,
  SessionDetail,
  SessionItem,
  SessionsResponse,
  SliceResult,
  TreeResponse,
  WriteResult,
  Settings,
} from "@drawer/shared/api";
import { DIMENSION_KINDS, FEATURE_KINDS, MESH_FORMATS, PART_SOURCES, PROVIDER_KINDS } from "@drawer/shared/api";
import { z } from "zod";

const kind = z.enum(["markdown", "scad", "mesh", "image", "pdf", "text", "binary"]);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const vec2 = z.tuple([z.number(), z.number()]);
const providerKind = z.enum(PROVIDER_KINDS);
const importSite = z.enum(["printables", "thingiverse", "makerworld", "cults3d", "myminifactory", "generic"]);
const reportStatus = z.enum(["passed", "draft", "failed", "empty", "pending"]);
const strictness = z.enum(["quick", "standard", "functional"]);
const axis = z.enum(["x", "y", "z"]);
const partSource = z.enum(PART_SOURCES);

const importSource = z.object({
  site: importSite,
  url: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  license: z.string().nullable(),
  description: z.string(),
  images: z.array(z.string()),
  importedAt: z.string().optional(),
});

export const projectSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  fileCount: z.number(),
  cover: z.string().nullable(),
  thumbnail: z.string().nullable(),
  source: importSource.nullable(),
  defaults: z.object({ material: z.string(), strictness }),
  status: z.object({
    parts: z.number(),
    passed: z.number(),
    draft: z.number(),
    failed: z.number(),
    pending: z.number(),
    assembly: z.union([reportStatus, z.literal("none")]),
    overall: reportStatus,
  }),
}) satisfies z.ZodType<Project>;

export const treeSchema = z.object({
  entries: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["file", "dir"]),
      kind: kind.optional(),
      size: z.number().optional(),
      rev: z.string().optional(),
      updatedAt: z.string().optional(),
      updatedBy: z.string().optional(),
    }),
  ),
}) satisfies z.ZodType<TreeResponse>;

const meshInfo = z.object({
  format: z.enum(MESH_FORMATS),
  triangles: z.number(),
  closed: z.boolean(),
  bbox: z.object({ min: vec3, max: vec3, size: vec3 }),
  volumeCm3: z.number().nullable(),
});

export const scanResultSchema = z.object({
  project: z.string(),
  path: z.string(),
  source: z.string(),
  revisionId: z.string(),
  mesh: meshInfo,
  noiseMm: z.number(),
}) satisfies z.ZodType<ScanResult>;

const link = z.object({
  from: z.string(),
  fromProject: z.string(),
  relation: z.string(),
  target: z.string(),
  to: z.string().nullable(),
  toProject: z.string().nullable(),
});

export const fileInfoSchema = z.object({
  project: z.string(),
  path: z.string(),
  kind,
  size: z.number(),
  rev: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  mesh: meshInfo.nullable(),
  facts: z.array(z.object({ category: z.string(), text: z.string(), path: z.string(), line: z.number() })),
  outgoing: z.array(link),
  incoming: z.array(link),
  outline: z.array(z.string()),
}) satisfies z.ZodType<FileInfo>;

const scadCheck = z.object({
  ok: z.boolean(),
  diagnostics: z.array(z.object({ level: z.enum(["error", "warning"]), message: z.string(), file: z.string().nullable(), line: z.number().nullable() })),
});

export const writeResultSchema = z.object({
  project: z.string(),
  path: z.string(),
  rev: z.string(),
  created: z.boolean(),
  revisionId: z.string(),
  check: scadCheck.nullable(),
  part: z.string().nullable(),
}) satisfies z.ZodType<WriteResult>;

export const revisionIdSchema = z.object({ revisionId: z.string() });

export const historySchema = z.object({
  revisions: z.array(z.object({ id: z.string(), author: z.string(), message: z.string(), date: z.string(), paths: z.array(z.string()) })),
}) satisfies z.ZodType<HistoryResponse>;

const renderView = z.enum(["iso", "front", "top", "side"]);
const views = z.partialRecord(renderView, z.string());

export const renderResultSchema = z.object({
  project: z.string(),
  path: z.string(),
  key: z.string(),
  cached: z.boolean(),
  seconds: z.number(),
  mesh: z.string(),
  proxy: z.string().optional(),
  views,
  sheet: z.string(),
  info: meshInfo,
  log: z.array(z.string()),
  warnings: z.array(z.string()),
}) satisfies z.ZodType<RenderResult>;

export const searchSchema = z.object({
  hits: z.array(z.object({ path: z.string(), kind, title: z.string(), snippet: z.string(), score: z.number() })),
}) satisfies z.ZodType<SearchResponse>;

export const importPreviewSchema = z.object({
  source: importSource,
  files: z.array(z.object({ id: z.string(), name: z.string(), size: z.number().nullable(), downloadable: z.boolean() })),
  blocker: z.string().nullable(),
}) satisfies z.ZodType<ImportPreview>;

export const importResultSchema = z.object({
  project: z.string(),
  dir: z.string(),
  written: z.array(z.string()),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  revisionId: z.string(),
}) satisfies z.ZodType<ImportResult>;

// ---- parts -----------------------------------------------------------------------------

const dimension = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(DIMENSION_KINDS),
  axis: axis.optional(),
  at: z.number().optional(),
  near: vec2.optional(),
  from: vec3.optional(),
  box: vec3.optional(),
  nominal: z.number().optional(),
  tol: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const match = z.object({ id: z.string(), label: z.string(), to: z.string(), tol: z.number(), share: z.number().optional() });

const partSpec = z.object({
  title: z.string(),
  class: z.string(),
  description: z.string(),
  source: partSource,
  scan: z.object({ file: z.string(), rotate: vec3, translate: vec3 }).optional(),
  material: z.string(),
  strictness,
  dimensions: z.array(dimension),
  matches: z.array(match),
  waivers: z.array(z.object({ gate: z.string(), reason: z.string(), by: z.string(), at: z.string() })),
  prints: z.array(z.object({ revisionId: z.string(), at: z.string(), outcome: z.enum(["ok", "issue"]), note: z.string() })),
});

const gateResult = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["pass", "fail", "warn", "skipped", "waived"]),
  measured: z.string().nullable(),
  expected: z.string().nullable(),
  detail: z.string().nullable(),
  hint: z.string().nullable(),
  at: vec3.nullable(),
});

const paramValue = z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]);

const scadParam = z.object({
  name: z.string(),
  type: z.enum(["number", "string", "boolean", "vector"]),
  value: paramValue,
  group: z.string(),
  description: z.string(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  step: z.number().nullable(),
  options: z.array(z.object({ value: z.union([z.number(), z.string()]), label: z.string() })).nullable(),
  line: z.number(),
});

const meshAnalysis = z.object({
  shells: z.number(),
  watertight: z.boolean(),
  surfaceAreaMm2: z.number(),
  baseAreaMm2: z.number(),
  footprintMm2: z.number(),
  overhang: z.object({ angle: z.number(), areaMm2: z.number(), at: vec3.nullable() }),
  wall: z.object({ minMm: z.number(), at: vec3 }).nullable(),
  thickness: z.string().nullable(),
});

const renderRef = z.object({ key: z.string(), mesh: z.string(), proxy: z.string().optional(), views, sheet: z.string() });

export const partSummarySchema = z.object({
  project: z.string(),
  id: z.string(),
  title: z.string(),
  class: z.string(),
  source: partSource,
  material: z.string(),
  strictness,
  spec: z.string(),
  model: z.string().nullable(),
  status: reportStatus,
  passed: z.number(),
  total: z.number(),
  failing: z.array(z.string()),
  evaluating: z.boolean(),
  printed: z.enum(["ok", "issue"]).nullable(),
  updatedAt: z.string(),
  updatedBy: z.string(),
}) satisfies z.ZodType<PartSummary>;

export const partsSchema = z.object({ parts: z.array(partSummarySchema) }) satisfies z.ZodType<PartsResponse>;

export const partReportSchema = z.object({
  project: z.string(),
  part: z.string(),
  revisionId: z.string(),
  status: reportStatus,
  passed: z.number(),
  total: z.number(),
  gates: z.array(gateResult),
  spec: partSpec,
  mesh: meshInfo.nullable(),
  analysis: meshAnalysis.nullable(),
  render: renderRef.nullable(),
  params: z.array(scadParam),
  massG: z.number().nullable(),
  next: z.array(z.string()),
  whatIf: z.boolean(),
  seconds: z.number(),
  evaluatedAt: z.string(),
}) satisfies z.ZodType<PartReport>;

export const attemptsSchema = z.object({
  attempts: z.array(
    z.object({
      revisionId: z.string(),
      parent: z.string().nullable(),
      author: z.string(),
      message: z.string(),
      date: z.string(),
      current: z.boolean(),
      status: reportStatus.nullable(),
      passed: z.number().nullable(),
      total: z.number().nullable(),
    }),
  ),
}) satisfies z.ZodType<AttemptsResponse>;

const deviationStats = z.object({ min: z.number(), max: z.number(), rms: z.number(), p95: z.number(), within: z.number() });

export const compareSchema = z.object({
  a: z.object({ render: renderRef, mesh: meshInfo }),
  b: z.object({ render: renderRef, mesh: meshInfo }),
  deviation: deviationStats.extend({ reverse: deviationStats, tol: z.number(), at: vec3.nullable(), field: z.string(), mesh: z.string() }),
  volumeDeltaCm3: z.number().nullable(),
  sizeDelta: vec3,
}) satisfies z.ZodType<CompareResult>;

// ---- measuring -------------------------------------------------------------------------

export const measureSchema = z.object({
  project: z.string(),
  path: z.string(),
  mesh: meshInfo,
  analysis: meshAnalysis,
  render: renderRef,
}) satisfies z.ZodType<MeasureResult>;

const pose = { rotate: vec3, translate: vec3 };
export const alignSchema = z.object({
  ...pose,
  rms: z.number().nullable(),
  ambiguous: z.array(z.object({ ...pose, rms: z.number() })),
}) satisfies z.ZodType<AlignResult>;

export const featureSchema = z.object({
  kind: z.enum(FEATURE_KINDS),
  origin: vec3,
  direction: vec3.nullable(),
  diameter: z.number().nullable(),
  length: z.number().nullable(),
  side: z.enum(["hole", "boss"]).nullable(),
  areaMm2: z.number(),
  rms: z.number(),
  maxError: z.number(),
  coverage: z.number(),
}) satisfies z.ZodType<Feature>;

export const featuresSchema = z.object({
  features: z.array(featureSchema),
  field: z.string(),
  mesh: z.string(),
}) satisfies z.ZodType<FeaturesResult>;

export const sliceSchema = z.object({
  axis,
  at: z.number().nullable(),
  open: z.array(z.array(vec2)),
  contours: z.array(
    z.object({
      hole: z.boolean(),
      areaMm2: z.number(),
      centre: vec2,
      bbox: z.object({ min: vec2, max: vec2 }),
      circle: z.object({ centre: vec2, diameter: z.number(), rms: z.number(), round: z.boolean() }),
      points: z.array(vec2),
    }),
  ),
}) satisfies z.ZodType<SliceResult>;

export const probeSchema = z.object({
  inside: z.boolean(),
  onSurface: z.boolean(),
  distance: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
}) satisfies z.ZodType<ProbeResult>;

export const sectionSchema = z.object({ axis, at: z.number(), image: z.string() }) satisfies z.ZodType<SectionResult>;

// ---- library ---------------------------------------------------------------------------

const material = z.object({ name: z.string(), densityGCm3: z.number(), minWallMm: z.number().nullable(), notes: z.string() });

export const libraryProfileSchema = z.object({
  printer: z.object({
    name: z.string(),
    bed: vec3,
    nozzleMm: z.number(),
    layerMm: z.number(),
    minWallMm: z.number(),
    maxOverhangDeg: z.number(),
    maxOverhangAreaMm2: z.number(),
    clearance: z.object({ sliding: z.number(), press: z.number() }),
  }),
  materials: z.array(material),
  printerIsExample: z.boolean(),
}) satisfies z.ZodType<LibraryProfile>;

export const overviewSchema = z.object({
  project: projectSchema,
  brief: z.string(),
  memory: z.string(),
  parts: z.array(partSummarySchema),
  assembly: z.object({ status: reportStatus, instances: z.number(), failing: z.array(z.string()) }).nullable(),
  references: z.array(z.string()),
  notes: z.array(z.string()),
  library: z.object({ profile: libraryProfileSchema, notes: z.array(z.string()), parts: z.array(partSummarySchema) }),
}) satisfies z.ZodType<ProjectOverview>;

// ---- assembly --------------------------------------------------------------------------

export const assemblyReportSchema = z.object({
  project: z.string(),
  revisionId: z.string(),
  status: reportStatus,
  passed: z.number(),
  total: z.number(),
  gates: z.array(gateResult),
  spec: z.object({
    title: z.string(),
    instances: z.array(z.object({ id: z.string(), part: z.string(), translate: vec3, rotate: vec3 })),
    mates: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        a: z.string(),
        b: z.string(),
        fit: z.enum(["clearance", "contact", "press"]),
        min: z.number().optional(),
        max: z.number().optional(),
      }),
    ),
  }),
  instances: z.array(z.object({ id: z.string(), part: z.string(), partStatus: reportStatus, mesh: z.string().nullable(), matrix: z.array(z.number()) })),
  pairs: z.array(z.object({ a: z.string(), b: z.string(), gapMm: z.number(), overlapCm3: z.number().nullable(), penetration: z.object({ depthMm: z.number(), limitMm: z.number() }).optional() })),
  bom: z.array(
    z.object({
      part: z.string(),
      title: z.string(),
      count: z.number(),
      source: partSource,
      material: z.string().nullable(),
      massG: z.number().nullable(),
    }),
  ),
  totalPrintedMassG: z.number().nullable(),
  render: z.object({ key: z.string(), views, sheet: z.string() }).nullable(),
  next: z.array(z.string()),
  seconds: z.number(),
  evaluatedAt: z.string(),
}) satisfies z.ZodType<AssemblyReport>;

// ---- sessions --------------------------------------------------------------------------

const sessionStatus = z.enum(["queued", "working", "waiting", "idle", "stopped", "failed"]);

export const sessionSchema = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  provider: providerKind,
  model: z.string().nullable(),
  status: sessionStatus,
  activity: z.string().nullable(),
  pending: z.number(),
  toolCalls: z.number(),
  seq: z.number(),
  version: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Session>;

const sessionRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("part"), part: z.string() }),
  z.object({ kind: z.literal("point"), part: z.string(), position: vec3, normal: vec3.nullable() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
]);

export const sessionAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  kind,
  url: z.string(),
  filedAs: z.string().nullable(),
}) satisfies z.ZodType<SessionAttachment>;

export const fileAttachmentResultSchema = z.object({ attachment: sessionAttachmentSchema, write: writeResultSchema }) satisfies z.ZodType<FileAttachmentResult>;

const itemBase = { seq: z.number(), version: z.number(), at: z.string() };

export const sessionItemSchema = z.discriminatedUnion("type", [
  z.object({ ...itemBase, type: z.literal("user"), text: z.string(), refs: z.array(sessionRef), attachments: z.array(sessionAttachmentSchema), author: z.string() }),
  z.object({ ...itemBase, type: z.literal("assistant"), text: z.string() }),
  z.object({
    ...itemBase,
    type: z.literal("tool"),
    callId: z.string(),
    name: z.string(),
    summary: z.string(),
    status: z.enum(["running", "ok", "error"]),
    result: z.string().nullable(),
    images: z.array(z.string()),
  }),
  z.object({ ...itemBase, type: z.literal("question"), questionId: z.string(), text: z.string(), options: z.array(z.string()), multiple: z.boolean(), answers: z.array(z.string()).nullable() }),
  z.object({ ...itemBase, type: z.literal("reasoning"), reasoningId: z.string(), text: z.string(), status: z.enum(["running", "done"]), seconds: z.number() }),
  z.object({ ...itemBase, type: z.literal("notice"), level: z.enum(["info", "error"]), text: z.string() }),
]) satisfies z.ZodType<SessionItem>;

export const sessionDetailSchema = z.object({ session: sessionSchema, items: z.array(sessionItemSchema) }) satisfies z.ZodType<SessionDetail>;
export const sessionsSchema = z.object({ sessions: z.array(sessionSchema) }) satisfies z.ZodType<SessionsResponse>;

export const providerStatusSchema = z.object({
  kind: providerKind,
  state: z.enum(["ready", "disabled", "not_installed", "signed_out", "unavailable"]),
  version: z.string().nullable(),
  models: z.array(z.string()),
  message: z.string().nullable(),
  binary: z.string().nullable(),
}) satisfies z.ZodType<ProviderStatus>;

export const runnersSchema = z.object({
  runners: z.array(z.object({ id: z.string(), providers: z.array(providerStatusSchema), accepting: z.boolean(), lastSeen: z.string() })),
}) satisfies z.ZodType<RunnersResponse>;

const providerSettingsSchema = z.object({
  enabled: z.boolean(),
  defaultModel: z.string().nullable(),
  customModels: z.array(z.string()),
}) satisfies z.ZodType<ProviderSettings>;

export const settingsSchema = z.object({
  defaultProvider: providerKind,
  providers: z.object({ claude: providerSettingsSchema, codex: providerSettingsSchema, pi: providerSettingsSchema, gemini: providerSettingsSchema }),
}) satisfies z.ZodType<Settings>;
