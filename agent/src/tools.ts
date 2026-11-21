/**
 * drawer's tools for a modelling agent, independent of any provider. Each one is a thin composition of
 * public API calls through the CLI's `Client`. A tool never throws for an API failure: it returns
 * `ok: false` with the server's message, so the agent can read it and react.
 */
import { ApiFailure, type Client } from "@drawer/cli/client";
import {
  ASSEMBLY_FILE,
  DIMENSION_KINDS,
  LIBRARY_SLUG,
  MATERIALS_FILE,
  PART_DIR,
  PRINTER_FILE,
  type NewSessionItem,
  type PartReport,
  type RenderView,
  type SessionAttachment,
  type Vec3,
} from "@drawer/shared/api";
import { z } from "zod";
import {
  formatAssemblyReport,
  formatAttempts,
  formatCheck,
  formatOverview,
  formatPartReport,
  oneLine,
  summarizeAssemblyReport,
  summarizePartReport,
  truncate,
  vec,
  formatAttachment,
} from "./format.ts";
import { imageMediaType } from "./images.ts";

/** The `Client` methods the tools use; tests supply a fake. */
export type ToolClient = Pick<
  Client,
  | "overview"
  | "tree"
  | "readFile"
  | "writeFile"
  | "edit"
  | "search"
  | "importInto"
  | "putPart"
  | "evaluatePart"
  | "setParams"
  | "render"
  | "measure"
  | "slice"
  | "probe"
  | "section"
  | "compare"
  | "attempts"
  | "restore"
  | "putAssembly"
  | "evaluateAssembly"
  | "waitAnswer"
  | "session"
  | "download"
  | "attachmentBytes"
  | "fileAttachment"
>;

export interface ToolContext {
  client: ToolClient;
  project: string;
  sessionId: string;
  /** Aborted when the turn is stopped. */
  signal: AbortSignal;
  /** Appends an item to the session, in order with the runner's own items. */
  append(item: NewSessionItem): Promise<void>;
  /** Seconds per answer long poll (tests shorten it). */
  answerWait?: number;
}

export interface ToolOutput {
  ok: boolean;
  /** What the agent reads. */
  text: string;
  /** PNG images for the agent to look at. */
  images: Uint8Array[];
  /** Server URL paths of those images, for the session's record. */
  imageUrls: string[];
  /** One line for a person watching the session. */
  summary: string;
}

export interface DrawerTool {
  name: string;
  description: string;
  /** zod v4 raw shape of the input object. */
  input: z.ZodRawShape;
  /** Validates `input` against the shape, then runs. */
  run(ctx: ToolContext, input: unknown): Promise<ToolOutput>;
}

function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  run(ctx: ToolContext, input: z.output<z.ZodObject<S>>): Promise<ToolOutput>;
}): DrawerTool {
  const schema = z.object(def.input);
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    run: (ctx, raw) => def.run(ctx, schema.parse(raw)),
  };
}

const output = (text: string, summary: string, extra: Partial<ToolOutput> = {}): ToolOutput => ({
  ok: true,
  text,
  summary,
  images: [],
  imageUrls: [],
  ...extra,
});

/** A tool failure the agent should read: becomes an `ok: false` result with this message. */
export class ToolError extends Error {
  override name = "ToolError";
}

/** At most this many images go back to the model from one call, none larger than MAX_IMAGE_BYTES. */
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Drops images the model must not get, and says in the text how many were left out. */
function limitImages(out: ToolOutput): ToolOutput {
  const images: Uint8Array[] = [];
  const imageUrls: string[] = [];
  let tooLarge = 0;
  let overCount = 0;
  for (const [i, image] of out.images.entries()) {
    if (image.byteLength > MAX_IMAGE_BYTES) tooLarge++;
    else if (images.length >= MAX_IMAGES) overCount++;
    else {
      images.push(image);
      const url = out.imageUrls[i];
      if (url !== undefined) imageUrls.push(url);
    }
  }
  if (tooLarge === 0 && overCount === 0) return out;
  const notes = [
    ...(tooLarge > 0 ? [`${tooLarge} image(s) over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`] : []),
    ...(overCount > 0 ? [`${overCount} image(s) beyond the first ${MAX_IMAGES}`] : []),
  ];
  return { ...out, images, imageUrls, text: `${out.text}
(left out: ${notes.join(", ")})` };
}

/** Runs a tool; API and validation failures become an `ok: false` result. An abort propagates. */
export async function executeTool(tool: DrawerTool, ctx: ToolContext, input: unknown): Promise<ToolOutput> {
  try {
    return limitImages(await tool.run(ctx, input));
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    let text: string;
    if (err instanceof ApiFailure) text = `${err.code}: ${err.message}`;
    else if (err instanceof z.ZodError) text = `invalid input: ${z.prettifyError(err)}`;
    else text = err instanceof Error ? err.message : String(err);
    return { ok: false, text, summary: oneLine(`${tool.name} failed: ${text}`, 160), images: [], imageUrls: [] };
  }
}

// ---- helpers ------------------------------------------------------------------------------------

const READ_LIMIT = 60_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * Why `path` is not a plain relative path, or null when it is. The agent reaches exactly two roots,
 * its project and `_library/`, so nothing that could climb out of one (or be decoded into something
 * that does) gets through: no `.`/`..`/empty segments, no backslash, no `%`, no leading `/`, no
 * control characters.
 */
export function pathProblem(path: string): string | null {
  if (path === "") return "the path is empty";
  if (path.startsWith("/")) return "the path must be relative (no leading /)";
  if (path.includes("\\")) return "the path must use / only (no backslash)";
  if (path.includes("%")) return "the path must not contain %";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "the path must not contain control characters";
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return "the path must not have empty, . or .. segments";
  return null;
}

/** `_library/x` addresses the library project; everything else is this project. A bad path is a ToolError. */
function locate(ctx: ToolContext, path: string): { slug: string; path: string } {
  const problem = pathProblem(path);
  if (problem !== null) throw new ToolError(`${problem}: ${JSON.stringify(path)}. Paths are project-relative, or _library/<path> for the shared library.`);
  const prefix = `${LIBRARY_SLUG}/`;
  return path.startsWith(prefix) ? { slug: LIBRARY_SLUG, path: path.slice(prefix.length) } : { slug: ctx.project, path };
}

/** A folder prefix for listing: empty (everything), `_library/`, or a path with an optional trailing `/`. */
function locatePrefix(ctx: ToolContext, prefix: string): { slug: string; path: string } {
  if (prefix === "") return { slug: ctx.project, path: "" };
  if (prefix === LIBRARY_SLUG || prefix === `${LIBRARY_SLUG}/`) return { slug: LIBRARY_SLUG, path: "" };
  const trailing = prefix.endsWith("/");
  const where = locate(ctx, trailing ? prefix.slice(0, -1) : prefix);
  return trailing ? { ...where, path: `${where.path}/` } : where;
}

const modelPath = (part: string) => `${PART_DIR}/${part}.scad`;

/** The file's current rev, or null when it does not exist. */
async function currentRev(ctx: ToolContext, slug: string, path: string): Promise<string | null> {
  try {
    return (await ctx.client.readFile(slug, path)).rev;
  } catch (err) {
    if (err instanceof ApiFailure && err.code === "not_found") return null;
    throw err;
  }
}

async function fetchImages(ctx: ToolContext, urls: string[]): Promise<{ images: Uint8Array[]; imageUrls: string[]; failed: string[] }> {
  const images: Uint8Array[] = [];
  const imageUrls: string[] = [];
  const failed: string[] = [];
  for (const url of urls) {
    try {
      images.push(await ctx.client.download(url));
      imageUrls.push(url);
    } catch {
      failed.push(url);
    }
  }
  return { images, imageUrls, failed };
}

/** The part's report as text plus its contact sheet. */
async function reportWithSheet(ctx: ToolContext, report: PartReport, lead: string[] = []): Promise<ToolOutput> {
  const sheet = report.render?.sheet;
  const pictures = await fetchImages(ctx, sheet ? [sheet] : []);
  const text = [...lead, formatPartReport(report)];
  if (sheet && pictures.failed.length > 0) text.push("(the contact sheet could not be downloaded)");
  else if (sheet) text.push("The image is the contact sheet: iso, front, top and side views.");
  return output(text.join("\n"), summarizePartReport(report), { images: pictures.images, imageUrls: pictures.imageUrls });
}

/** After a write that touched a part: check diagnostics, then the evaluated report. */
async function afterModelWrite(ctx: ToolContext, part: string, lead: string[]): Promise<ToolOutput> {
  const report = await ctx.client.evaluatePart(ctx.project, part);
  return reportWithSheet(ctx, report, lead);
}

function conflict(err: unknown, path: string): ToolOutput | null {
  if (!(err instanceof ApiFailure) || err.code !== "conflict") return null;
  const text = `conflict: ${path} changed while you were writing it (current rev ${err.rev ?? "unknown"}). Read it again and redo your change on the current text.`;
  return { ok: false, text, summary: `${path}: write conflict`, images: [], imageUrls: [] };
}

// ---- schemas ------------------------------------------------------------------------------------

/**
 * Fixed-length arrays, not tuples: the Agent SDK sends tool schemas as JSON Schema draft-07, and the
 * API rejects that draft's tuple form (`items` as a list).
 */
const vec3 = z.array(z.number()).length(3).describe("[x, y, z] in mm");
const vec2 = z.array(z.number()).length(2);
const toVec3 = (v: readonly number[]): Vec3 => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
const toVec2 = (v: readonly number[]): [number, number] => [v[0] ?? 0, v[1] ?? 0];
const axis = z.enum(["x", "y", "z"]);
const PART_ID = /^[a-z0-9][a-z0-9-]*$/;
const partId = z.string().regex(PART_ID).describe("Part id: [a-z0-9][a-z0-9-]*");
/** A part of this project, or `_library/<id>` for a library part. */
const partRef = z
  .string()
  .refine((v) => PART_ID.test(v.startsWith(`${LIBRARY_SLUG}/`) ? v.slice(LIBRARY_SLUG.length + 1) : v), "must be a part id or _library/<part id>")
  .describe("Part id, or _library/<id> for a library part");
/** A revision id from attempts or history: a git commit id. */
const revisionId = z.string().regex(/^[0-9a-f]{4,64}$/, "must be a revision id (hex) from attempts").describe("Revision id");
const paramValues = z
  .record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]))
  .describe("Top-level parameter values by name");
const filePath = z.string().min(1).describe("Project-relative path, or _library/<path> for the shared library");
const views = z.array(z.enum(["iso", "front", "top", "side"]));
/**
 * Markdown the agent may write: project notes and memory, the brief, and the library's notes (at the
 * library's root or under its notes/). Checked segment by segment, so no segment can be `.` or `..`.
 */
export function isNotePath(path: string): boolean {
  if (pathProblem(path) !== null) return false;
  const segments = path.split("/");
  if (!segments.every((seg) => /^[\w.-]+$/.test(seg))) return false;
  const name = segments[segments.length - 1] ?? "";
  if (!name.endsWith(".md") || name === ".md") return false;
  const [first, second] = segments;
  if (segments.length === 1) return name === "AGENTS.md" || name === "brief.md";
  if (first === "notes") return true;
  if (first === LIBRARY_SLUG) return segments.length === 2 || (second === "notes" && segments.length > 2);
  return false;
}
const notePath = z
  .string()
  .refine(isNotePath, "must be AGENTS.md, brief.md, notes/<name>.md, _library/<name>.md or _library/notes/<name>.md")
  .describe("AGENTS.md, brief.md, notes/<name>.md, _library/<name>.md or _library/notes/<name>.md");

const dimension = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string(),
  kind: z.enum(DIMENSION_KINDS),
  axis: axis.optional().describe("size, hole, gap, wall"),
  at: z.number().optional().describe("hole, boss: cutting plane position along axis"),
  near: vec2.optional().describe("hole, boss: the other two coordinates (x-y-z order without axis) the centre is nearest to"),
  from: vec3.optional().describe("gap, wall: the point the measuring ray passes through"),
  box: vec3.optional().describe("envelope: the box the bounding box must fit in"),
  nominal: z.number().optional(),
  tol: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const compareSide = z.object({
  part: partRef.optional(),
  path: z
    .string()
    .refine((p) => pathProblem(p) === null, "must be a project-relative path or _library/<path>")
    .optional(),
  at: revisionId.optional(),
});

// ---- tools --------------------------------------------------------------------------------------

const overview = defineTool({
  name: "overview",
  description:
    "Read this first. The project's brief, memory (AGENTS.md), parts with their status and failing gates, assembly status, references, notes, the printer profile, materials, and the library's notes and parts.",
  input: {},
  async run(ctx) {
    const o = await ctx.client.overview(ctx.project);
    return output(formatOverview(o), `overview: ${o.project.status.overall}, ${o.parts.length} part(s)`);
  },
});

const listFiles = defineTool({
  name: "list_files",
  description: "List the files of the project (or of the library with prefix `_library/`), optionally under a folder prefix.",
  input: { prefix: z.string().optional().describe("Folder prefix such as refs/, notes/ or _library/") },
  async run(ctx, { prefix }) {
    const where = locatePrefix(ctx, prefix ?? "");
    const tree = await ctx.client.tree(where.slug);
    const files = tree.entries.filter((e) => e.type === "file" && e.path.startsWith(where.path));
    const lead = where.slug === LIBRARY_SLUG ? `${LIBRARY_SLUG}/` : "";
    const lines = files.map((f) => `${lead}${f.path} (${f.kind ?? "file"}, ${f.size ?? 0} B)`);
    return output(lines.length > 0 ? lines.join("\n") : "No files.", `${files.length} file(s)${prefix ? ` under ${prefix}` : ""}`);
  },
});

const readFile = defineTool({
  name: "read_file",
  description: "Read a text file (markdown, scad, json, notes) from the project or `_library/...`. Binary files are refused; measure meshes instead.",
  input: { path: filePath },
  async run(ctx, { path }) {
    const where = locate(ctx, path);
    const file = await ctx.client.readFile(where.slug, where.path);
    let text: string;
    try {
      text = decoder.decode(file.bytes);
    } catch {
      return { ...output(`${path} is a binary file (${file.bytes.length} bytes). Use measure_file for meshes.`, `${path}: binary`), ok: false };
    }
    return output(`${path} (rev ${file.rev ?? "unknown"})\n${truncate(text, READ_LIMIT)}`, `read ${path}`);
  },
});

const search = defineTool({
  name: "search",
  description: "Full-text search over this project's files, or over the library (`_library/`: shared notes and parts) with library.",
  input: {
    query: z.string().min(1),
    library: z.boolean().optional(),
    kind: z.enum(["markdown", "scad", "mesh", "image", "pdf", "text", "binary"]).optional(),
  },
  async run(ctx, { query, library, kind }) {
    const res = await ctx.client.search(library ? LIBRARY_SLUG : ctx.project, { q: query, kind, limit: 20 });
    const lines = res.hits.map((h) => `- ${library ? `${LIBRARY_SLUG}/` : ""}${h.path} — ${h.title}: ${h.snippet}`);
    return output(lines.length > 0 ? lines.join("\n") : "No matches.", `search "${oneLine(query, 40)}": ${res.hits.length} hit(s)`);
  },
});

/** Creates or replaces a markdown file, reading its rev first. */
async function writeWhole(ctx: ToolContext, path: string, content: string, message: string): Promise<ToolOutput> {
  const where = locate(ctx, path);
  const rev = await currentRev(ctx, where.slug, where.path);
  try {
    const res = await ctx.client.writeFile(where.slug, where.path, encoder.encode(content), { rev: rev ?? undefined, message });
    return output(`${res.created ? "Created" : "Updated"} ${path} (rev ${res.rev}).`, `${res.created ? "created" : "updated"} ${path}`);
  } catch (err) {
    const c = conflict(err, path);
    if (c) return c;
    throw err;
  }
}

const writeNote = defineTool({
  name: "write_note",
  description:
    "Create or replace a whole markdown note: notes/<name>.md, AGENTS.md (the project memory), brief.md, or a library note `_library/<name>.md` (e.g. _library/tolerances.md) for lessons that hold for every project. Read it first when replacing; to add one fact use add_fact.",
  input: {
    path: notePath,
    content: z.string(),
    message: z.string().optional().describe("Why, in a few words"),
  },
  async run(ctx, { path, content, message }) {
    return writeWhole(ctx, path, content, message ?? `note ${path}`);
  },
});

const addFact = defineTool({
  name: "add_fact",
  description:
    "Append one fact line `- [category] text` to the project memory (AGENTS.md by default) or another note. Categories: decision, constraint, learned, fit, todo. Write the decision and its reason.",
  input: {
    category: z.string().regex(/^[a-z][a-z0-9-]*$/),
    text: z.string().min(1),
    path: notePath.optional().describe("Default AGENTS.md (the project memory). A library note is _library/<name>.md, e.g. _library/tolerances.md"),
  },
  async run(ctx, { category, text, path }) {
    const target = path ?? "AGENTS.md";
    const where = locate(ctx, target);
    const line = `- [${category}] ${oneLine(text, 500)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let existing = "";
      let rev: string | undefined;
      try {
        const file = await ctx.client.readFile(where.slug, where.path);
        existing = new TextDecoder().decode(file.bytes);
        rev = file.rev ?? undefined;
      } catch (err) {
        if (!(err instanceof ApiFailure && err.code === "not_found")) throw err;
      }
      const body = existing.length === 0 ? `${line}\n` : `${existing.replace(/\n*$/, "\n")}${line}\n`;
      try {
        await ctx.client.writeFile(where.slug, where.path, encoder.encode(body), { rev, message: `fact: ${oneLine(text, 60)}` });
        return output(`Added to ${target}: ${line}`, `fact in ${target}`);
      } catch (err) {
        if (!(err instanceof ApiFailure && err.code === "conflict")) throw err;
      }
    }
    return { ...output(`conflict: ${target} kept changing; try again.`, `${target}: write conflict`), ok: false };
  },
});

const positive = z.number().positive();
const setLibraryProfile = defineTool({
  name: "set_library_profile",
  description:
    "Write the library's printer profile (_library/printer.json) and/or materials (_library/materials.json), each replaced whole. Only with values the person gave you: when setting up the library, or when they ask for that change. Never to make a gate pass. Every part is measured again against them.",
  input: {
    printer: z
      .object({
        name: z.string().min(1),
        bed: z.array(positive).length(3).describe("Build volume x, y, z in mm"),
        nozzleMm: positive,
        layerMm: positive,
        minWallMm: positive,
        maxOverhangDeg: z.number().min(0).max(90).describe("Steepest printable overhang from vertical"),
        maxOverhangAreaMm2: z.number().min(0).describe("Overhang area tolerated before the gate fails"),
        clearance: z.object({ sliding: z.number().min(0), press: z.number().min(0) }).describe("Gap per side in mm that worked"),
      })
      .optional(),
    materials: z
      .array(z.object({ name: z.string().min(1), densityGCm3: positive, minWallMm: positive.nullable().describe("null: the printer's"), notes: z.string() }))
      .optional()
      .describe("Every material on hand; replaces the list"),
    message: z.string().optional().describe("Why, in a few words"),
  },
  async run(ctx, { printer, materials, message }) {
    if (printer === undefined && materials === undefined) return { ...output("Nothing to write: give printer, materials or both.", "library profile: nothing given"), ok: false };
    const done: ToolOutput[] = [];
    if (printer !== undefined) done.push(await writeWhole(ctx, `${LIBRARY_SLUG}/${PRINTER_FILE}`, `${JSON.stringify(printer, null, 2)}\n`, message ?? "printer profile from the person"));
    if (materials !== undefined) done.push(await writeWhole(ctx, `${LIBRARY_SLUG}/${MATERIALS_FILE}`, `${JSON.stringify({ materials }, null, 2)}\n`, message ?? "materials from the person"));
    return { ...output(done.map((d) => d.text).join("\n"), done.map((d) => d.summary).join("; ")), ok: done.every((d) => d.ok) };
  },
});

const importReference = defineTool({
  name: "import_reference",
  description:
    "Import a model page from Printables, Thingiverse, MakerWorld, Cults3D or MyMiniFactory (https only) into refs/<name>/: its files, images and source.md. Measure the imported mesh afterwards. Other sites: ask the person to add the reference in the web app.",
  input: {
    url: z.string().describe("https URL of a model page on one of the supported sites"),
    name: z
      .string()
      .regex(/^[\w-][\w.-]*$/, "must be one folder name")
      .optional()
      .describe("Folder under refs/"),
  },
  async run(ctx, { url, name }) {
    const problem = importUrlProblem(url);
    if (problem !== null) throw new ToolError(`${problem} Ask the person to add this reference in the web app instead.`);
    const res = await ctx.client.importInto(ctx.project, { url, name });
    const lines = [`Imported into ${res.dir}:`, ...res.written.map((w) => `- ${w}`)];
    if (res.skipped.length > 0) lines.push("Skipped:", ...res.skipped.map((s) => `- ${s.name}: ${s.reason}`));
    return output(lines.join("\n"), `imported ${res.written.length} file(s) into ${res.dir}`);
  },
});

/** The sites drawer has importers for; the server is never asked to fetch anything else. */
const IMPORT_HOSTS = ["printables.com", "thingiverse.com", "makerworld.com", "cults3d.com", "myminifactory.com"];

/** Why the agent may not import `url`, or null when it may. */
export function importUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a URL: ${JSON.stringify(url)}.`;
  }
  if (parsed.protocol !== "https:") return "only https URLs can be imported.";
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return "the URL must not carry credentials or a port.";
  const host = parsed.hostname.toLowerCase();
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (!IMPORT_HOSTS.includes(bare)) return `${host} is not a site drawer imports from (${IMPORT_HOSTS.join(", ")}).`;
  return null;
}

const setPartSpec = defineTool({
  name: "set_part_spec",
  description:
    "Create a part or replace its spec (parts/<id>.part.json): title, class, description, source, material, strictness, and the dimensions that define done. Missing fields take the project defaults. Write the spec before the model. If the part has a model, it is evaluated and the report returned.",
  input: {
    part: partId,
    title: z.string().min(1),
    class: z.string().optional().describe('What kind of part, e.g. "snap-fit clip"'),
    description: z.string().optional(),
    source: z.enum(["printed", "bought"]).optional(),
    material: z.string().optional(),
    strictness: z.enum(["quick", "standard", "functional"]).optional(),
    dimensions: z.array(dimension).optional(),
  },
  async run(ctx, { part, dimensions, ...rest }) {
    const spec = {
      ...rest,
      ...(dimensions === undefined
        ? {}
        : {
            dimensions: dimensions.map(({ near, from, box, ...d }) => ({
              ...d,
              ...(near === undefined ? {} : { near: toVec2(near) }),
              ...(from === undefined ? {} : { from: toVec3(from) }),
              ...(box === undefined ? {} : { box: toVec3(box) }),
            })),
          }),
    };
    const summary = await ctx.client.putPart(ctx.project, part, spec);
    const lead = `Spec of ${part} saved (${spec.dimensions?.length ?? 0} dimension(s)).`;
    if (!summary.model) return output(`${lead} No model yet: write parts/${part}.scad with write_model.`, `spec ${part}`);
    return afterModelWrite(ctx, part, [lead]);
  },
});

const writeModel = defineTool({
  name: "write_model",
  description:
    "Write a part's whole model (parts/<part>.scad). Returns OpenSCAD's check diagnostics, then the evaluated report (gates with measured/expected/hint, next step) and the contact sheet image. Every write is an attempt.",
  input: {
    part: partId,
    content: z.string().min(1).describe("The whole .scad file"),
    message: z.string().optional().describe("What this attempt changes, in a few words"),
  },
  async run(ctx, { part, content, message }) {
    const path = modelPath(part);
    const rev = await currentRev(ctx, ctx.project, path);
    let res;
    try {
      res = await ctx.client.writeFile(ctx.project, path, encoder.encode(content), { rev: rev ?? undefined, message: message ?? `model ${part}` });
    } catch (err) {
      const c = conflict(err, path);
      if (c) return c;
      throw err;
    }
    const check = formatCheck(res.check);
    return afterModelWrite(ctx, res.part ?? part, [`Wrote ${path} (rev ${res.rev}).`, ...(check ? [check] : [])]);
  },
});

const editModel = defineTool({
  name: "edit_model",
  description:
    "Replace an exact string in a part's model (old must occur exactly once unless replace_all). Returns check diagnostics, the evaluated report and the contact sheet, like write_model.",
  input: {
    part: partId,
    old: z.string().min(1),
    new: z.string(),
    replace_all: z.boolean().optional(),
    message: z.string().optional(),
  },
  async run(ctx, { part, old, new: replacement, replace_all, message }) {
    const path = modelPath(part);
    const rev = await currentRev(ctx, ctx.project, path);
    if (rev === null) return { ...output(`${path} does not exist yet; use write_model.`, `${path}: no model`), ok: false };
    let res;
    try {
      res = await ctx.client.edit(ctx.project, path, { rev, old, new: replacement, replaceAll: replace_all, message: message ?? `edit ${part}` });
    } catch (err) {
      const c = conflict(err, path);
      if (c) return c;
      throw err;
    }
    const check = formatCheck(res.check);
    return afterModelWrite(ctx, res.part ?? part, [`Edited ${path} (rev ${res.rev}).`, ...(check ? [check] : [])]);
  },
});

const evaluatePart = defineTool({
  name: "evaluate_part",
  description:
    "The part's current report and contact sheet. With params, a what-if: the report as if those top-level parameters had these values; nothing is written. Use it to tune a value before set_params.",
  input: { part: partId, params: paramValues.optional() },
  async run(ctx, { part, params }) {
    const report = await ctx.client.evaluatePart(ctx.project, part, params ? { params } : {});
    return reportWithSheet(ctx, report);
  },
});

const setParams = defineTool({
  name: "set_params",
  description: "Write new values into the model's top-level parameters (one attempt), then return the evaluated report and contact sheet.",
  input: { part: partId, values: paramValues, message: z.string().optional() },
  async run(ctx, { part, values, message }) {
    const path = modelPath(part);
    const rev = await currentRev(ctx, ctx.project, path);
    if (rev === null) return { ...output(`${path} does not exist yet; use write_model.`, `${path}: no model`), ok: false };
    let res;
    try {
      res = await ctx.client.setParams(ctx.project, part, { rev, values, message });
    } catch (err) {
      const c = conflict(err, path);
      if (c) return c;
      throw err;
    }
    const check = formatCheck(res.check);
    return afterModelWrite(ctx, part, [`Set ${Object.keys(values).join(", ")} (rev ${res.rev}).`, ...(check ? [check] : [])]);
  },
});

const viewPart = defineTool({
  name: "view_part",
  description: "Render a part's model, or any .scad or mesh file, and look at chosen views (iso, front, top, side) as separate images.",
  input: {
    part: partId.optional(),
    path: filePath.optional().describe("Instead of part: any .scad or mesh file"),
    views: views.optional().describe("Default: iso"),
  },
  async run(ctx, { part, path, views: chosen }) {
    const target = path ?? (part ? modelPath(part) : null);
    if (!target) return { ...output("Give part or path.", "view: nothing to view"), ok: false };
    const where = locate(ctx, target);
    const wanted: RenderView[] = chosen && chosen.length > 0 ? chosen : ["iso"];
    const res = await ctx.client.render(where.slug, where.path, { views: wanted });
    const urls = wanted.map((v) => res.views[v]).filter((u): u is string => typeof u === "string");
    const pictures = await fetchImages(ctx, urls);
    const [x, y, z2] = res.info.bbox.size;
    const text = `${target}: views ${wanted.join(", ")} (images in that order). Size ${vec([x, y, z2])} mm.${res.warnings.length > 0 ? `\nWarnings:\n${res.warnings.join("\n")}` : ""}`;
    return output(text, `viewed ${target} (${wanted.join(", ")})`, { images: pictures.images, imageUrls: pictures.imageUrls });
  },
});

const measureFile = defineTool({
  name: "measure_file",
  description: "Measure any .scad or mesh file (a reference, a library part, a model): size, shells, watertightness, base, overhang, and an iso picture. Volume and wall thickness require a closed mesh.",
  input: { path: filePath, params: paramValues.optional() },
  async run(ctx, { path, params }) {
    const where = locate(ctx, path);
    const res = await ctx.client.measure(where.slug, where.path, params ? { params } : {});
    const b = res.mesh.bbox;
    const a = res.analysis;
    const lines = [
      `${path}: ${vec(b.size)} mm, from ${vec(b.min)} to ${vec(b.max)}${res.mesh.volumeCm3 !== null ? `, volume ${res.mesh.volumeCm3.toFixed(2)} cm³` : ""}, ${res.mesh.triangles} triangles`,
      `${a.shells} shell(s), ${a.watertight ? "watertight" : "NOT watertight"}, base ${a.baseAreaMm2.toFixed(1)} mm² of ${a.footprintMm2.toFixed(1)} mm² footprint, overhang ${a.overhang.areaMm2.toFixed(1)} mm²${a.wall ? `, thinnest wall ${a.wall.minMm.toFixed(2)} mm at ${vec(a.wall.at)}` : ""}`,
    ];
    const iso = res.render.views.iso;
    const pictures = await fetchImages(ctx, iso ? [iso] : []);
    return output(lines.join("\n"), `measured ${path}: ${vec(b.size)} mm`, { images: pictures.images, imageUrls: pictures.imageUrls });
  },
});

const slice = defineTool({
  name: "slice",
  description:
    "Cut a .scad or mesh file at axis = at and list the closed outlines: area, bounding box, centre, best-fit circle (diameter, roundness). Use it to find where a hole or slot really is before changing a spec.",
  input: { path: filePath, axis, at: z.number() },
  async run(ctx, { path, axis: ax, at }) {
    const where = locate(ctx, path);
    const res = await ctx.client.slice(where.slug, where.path, { axis: ax, at });
    const lines = res.contours.map(
      (c, i) =>
        `${i + 1}. ${c.hole ? "hole" : "outline"}: area ${c.areaMm2.toFixed(2)} mm², centre ${vec(c.centre)}, box ${vec(c.bbox.min)}–${vec(c.bbox.max)}, circle Ø${c.circle.diameter.toFixed(3)} at ${vec(c.circle.centre)} (${c.circle.round ? "round" : "not round"}, rms ${c.circle.rms.toFixed(3)})`,
    );
    return output(
      [`${path} cut at ${ax} = ${at}: ${res.contours.length} outline(s). Coordinates are the other two axes in x-y-z order.`, ...lines].join("\n"),
      `slice ${path} ${ax}=${at}: ${res.contours.length} outline(s)`,
    );
  },
});

const probe = defineTool({
  name: "probe",
  description: "Whether a point is inside material, and the length of the run of material or air through it along an axis (where it starts and ends).",
  input: { path: filePath, from: vec3, axis },
  async run(ctx, { path, from: point, axis: ax }) {
    const where = locate(ctx, path);
    const from = toVec3(point);
    const res = await ctx.client.probe(where.slug, where.path, { from, axis: ax });
    const what = res.inside ? "material" : "air";
    const run = res.distance === null ? `unbounded ${what}` : `${what} run ${res.distance.toFixed(3)} mm from ${ax} = ${res.low?.toFixed(3)} to ${res.high?.toFixed(3)}`;
    return output(`${vec(from)} in ${path} is inside ${what}; along ${ax}: ${run}.`, `probe ${vec(from)}: ${what}`);
  },
});

const section = defineTool({
  name: "section",
  description: "A picture of a .scad or mesh file cut at axis = at, the lower side kept, looking at the cut face. Use it to see inside a part.",
  input: { path: filePath, axis, at: z.number() },
  async run(ctx, { path, axis: ax, at }) {
    const where = locate(ctx, path);
    const res = await ctx.client.section(where.slug, where.path, { axis: ax, at });
    const pictures = await fetchImages(ctx, [res.image]);
    return output(`Section of ${path} at ${ax} = ${at}.`, `section ${path} ${ax}=${at}`, { images: pictures.images, imageUrls: pictures.imageUrls });
  },
});

const compare = defineTool({
  name: "compare",
  description:
    "How B differs from A: each side is a part, a file, or either at a revision (from attempts). Signed surface distance (positive = B has more material), RMS, 95th percentile, where the largest difference is, volume and size deltas.",
  input: { a: compareSide, b: compareSide },
  async run(ctx, { a, b }) {
    const res = await ctx.client.compare(ctx.project, { a, b });
    const d = res.deviation;
    const text = [
      `Deviation of B from A: min ${d.min.toFixed(3)}, max ${d.max.toFixed(3)}, RMS ${d.rms.toFixed(3)}, p95 ${d.p95.toFixed(3)} mm${d.at ? `, largest at ${vec(d.at)}` : ""}`,
      `Size delta ${vec(res.sizeDelta)} mm${res.volumeDeltaCm3 !== null ? `, volume delta ${res.volumeDeltaCm3.toFixed(3)} cm³` : ""}`,
    ].join("\n");
    return output(text, `compare: p95 ${d.p95.toFixed(2)} mm`);
  },
});

const attempts = defineTool({
  name: "attempts",
  description: "The part's attempts (every model revision), oldest first, with parent, status and message. Restore one to go back to an approach that worked.",
  input: { part: partId },
  async run(ctx, { part }) {
    const res = await ctx.client.attempts(ctx.project, part);
    return output(formatAttempts(res.attempts), `${part}: ${res.attempts.length} attempt(s)`);
  },
});

const restoreAttempt = defineTool({
  name: "restore_attempt",
  description: "Make an earlier attempt's model current again (the next write branches from it). Returns the evaluated report and contact sheet.",
  input: { part: partId, revision_id: revisionId },
  async run(ctx, { part, revision_id }) {
    const res = await ctx.client.restore(ctx.project, part, { revisionId: revision_id });
    return afterModelWrite(ctx, part, [`Restored ${part} to ${revision_id} (rev ${res.rev}).`]);
  },
});

const setAssembly = defineTool({
  name: "set_assembly",
  description:
    "Write assembly.json: instances (part id or _library/<id>, rotate degrees about x then y then z, then translate) and mates (clearance with min/max gap, contact, press). Returns the assembly report and picture.",
  input: {
    title: z.string().min(1),
    instances: z.array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
        part: partRef,
        translate: vec3,
        rotate: vec3,
      }),
    ),
    mates: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string(),
        a: z.string(),
        b: z.string(),
        fit: z.enum(["clearance", "contact", "press"]),
        min: z.number().optional(),
        max: z.number().optional(),
      }),
    ),
  },
  async run(ctx, { instances, ...rest }) {
    const spec = { ...rest, instances: instances.map((i) => ({ ...i, translate: toVec3(i.translate), rotate: toVec3(i.rotate) })) };
    const report = await ctx.client.putAssembly(ctx.project, spec);
    return assemblyOutput(ctx, report, `Wrote ${ASSEMBLY_FILE}.`);
  },
});

async function assemblyOutput(ctx: ToolContext, report: Awaited<ReturnType<ToolClient["evaluateAssembly"]>>, lead?: string): Promise<ToolOutput> {
  const sheet = report.render?.sheet;
  const pictures = await fetchImages(ctx, sheet ? [sheet] : []);
  const text = [...(lead ? [lead] : []), formatAssemblyReport(report)].join("\n");
  return output(text, summarizeAssemblyReport(report), { images: pictures.images, imageUrls: pictures.imageUrls });
}

const evaluateAssembly = defineTool({
  name: "evaluate_assembly",
  description: "The assembly's report (parts, clash, floating, every mate, BOM, gaps and overlaps of every pair) and its picture.",
  input: {},
  async run(ctx) {
    return assemblyOutput(ctx, await ctx.client.evaluateAssembly(ctx.project));
  },
});

const askUser = defineTool({
  name: "ask_user",
  description:
    "Ask the person one question and wait for the answer. Put everything open in one message, with your assumptions; offer short options when the choices are clear. Set multiple when the person may pick several options at once (which features to keep, which edges to round); leave it off when the options exclude each other. The person can always answer in their own words instead of, or with, the options. Use it once before the first model, and later only when blocked.",
  input: {
    question: z.string().min(1).max(20_000),
    options: z.array(z.string().min(1).max(200)).max(12).optional().describe("At most 12 short options"),
    multiple: z.boolean().optional().describe("True: the person may pick several options. Default false: exactly one answer"),
  },
  async run(ctx, { question, options, multiple }) {
    const questionId = crypto.randomUUID();
    await ctx.append({ type: "question", questionId, text: question, options: options ?? [], multiple: multiple ?? false });
    const wait = ctx.answerWait ?? 25;
    for (;;) {
      const answers = await untilAborted(ctx.signal, ctx.client.waitAnswer(ctx.sessionId, questionId, wait));
      if (answers !== null) return output(answerText(answers), `answer: ${oneLine(answers.join("; "), 100)}`);
      // The long poll also ends with null when no answer will ever come: ask the session.
      let status: string;
      try {
        status = (await untilAborted(ctx.signal, ctx.client.session(ctx.sessionId, Number.MAX_SAFE_INTEGER))).session.status;
      } catch (err) {
        if (err instanceof ApiFailure && err.code === "not_found") throw new ToolError("the session was deleted; no answer will come");
        throw err;
      }
      if (status === "stopped" || status === "failed") throw new ToolError(`the session is ${status}; no answer will come`);
    }
  },
});

/** One answer on the line; several as a JSON array (each a picked option or the person's own words), so none can run into another. */
function answerText(answers: string[]): string {
  if (answers.length === 1) return `The person answered: ${answers[0]}`;
  return `The person gave ${answers.length} answers, each a picked option or their own words: ${JSON.stringify(answers)}`;
}

/** `promise`, or a rejection the moment `signal` aborts (the turn was stopped). */
function untilAborted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("the turn was stopped"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("the turn was stopped"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// ---- attachments ------------------------------------------------------------------------------

/** Every file people attached to this session's messages, oldest first. */
async function sessionAttachments(ctx: ToolContext): Promise<SessionAttachment[]> {
  const detail = await ctx.client.session(ctx.sessionId);
  return detail.items.flatMap((item) => (item.type === "user" ? item.attachments : []));
}

/** An attachment of this session; the agent cannot reach another session's. */
async function ownAttachment(ctx: ToolContext, id: string): Promise<SessionAttachment> {
  const found = (await sessionAttachments(ctx)).find((a) => a.id === id);
  if (found === undefined) throw new ToolError(`no attachment ${id} in this session; list_attachments shows them`);
  return found;
}

const attachmentId = z.string().regex(/^[a-f0-9]{16}$/, "must be an attachment id from list_attachments").describe("Attachment id");

const listAttachments = defineTool({
  name: "list_attachments",
  description: "The files the person attached to messages in this session: id, name, kind, type, size, and where each was filed.",
  input: {},
  async run(ctx) {
    const list = await sessionAttachments(ctx);
    const lines = list.map((a) => formatAttachment(a, false));
    return output(lines.length > 0 ? lines.join("\n") : "No attachments in this session.", `${list.length} attachment(s)`);
  },
});

const viewAttachment = defineTool({
  name: "view_attachment",
  description:
    "Look at an attachment: an image (PNG, JPEG, GIF, WebP) comes back as a picture, a text file as its text. Meshes, PDFs and other files: file them first, then measure_file or view_part the filed path.",
  input: { id: attachmentId },
  async run(ctx, { id }) {
    const a = await ownAttachment(ctx, id);
    const { bytes } = await ctx.client.attachmentBytes(id);
    if (imageMediaType(bytes) !== null) {
      return output(`${a.name} (${a.mediaType}). The image follows.`, `viewed ${a.name}`, { images: [bytes], imageUrls: [a.url] });
    }
    if (a.kind === "text" || a.kind === "markdown" || a.kind === "scad") {
      try {
        return output(`${a.name}\n${truncate(decoder.decode(bytes), READ_LIMIT)}`, `read ${a.name}`);
      } catch {
        // not UTF-8 after all: described below
      }
    }
    const next = a.kind === "mesh" ? "File it with file_attachment, then measure_file the filed path." : "This kind cannot be shown; file it if it is worth keeping and say what it is from its name.";
    return { ...output(`${a.name} is a ${a.kind} file (${a.mediaType}, ${bytes.byteLength} bytes). ${next}`, `${a.name}: not viewable`), ok: false };
  },
});

const fileAttachmentTool = defineTool({
  name: "file_attachment",
  description:
    "Copy an attachment into this project at a project-relative path, as one revision: references (photos, meshes, datasheets) under refs/, with a clear lowercase name that says what it is (refs/caliper-jaw-photo.jpg, refs/fan-80mm.stl). Keep the extension. Fails when the path exists unless replace is set.",
  input: {
    id: attachmentId,
    path: z.string().min(1).describe("Project-relative destination, e.g. refs/<name>.<ext>"),
    replace: z.boolean().optional().describe("Replace the file already at path"),
  },
  async run(ctx, { id, path, replace }) {
    const where = locate(ctx, path);
    if (where.slug !== ctx.project) throw new ToolError("attachments are filed into this project, not the library");
    const a = await ownAttachment(ctx, id);
    const rev = replace ? ((await currentRev(ctx, where.slug, where.path)) ?? undefined) : undefined;
    let res;
    try {
      res = await ctx.client.fileAttachment(id, { path: where.path, ...(rev === undefined ? {} : { rev }) });
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "conflict") {
        return { ...output(`${path} already exists. Pick another name, or set replace to replace it.`, `${path}: exists`), ok: false };
      }
      throw err;
    }
    const next = a.kind === "mesh" ? " Measure it with measure_file." : "";
    return output(`Filed "${a.name}" as ${res.write.path} (rev ${res.write.rev}).${next}`, `filed ${a.name} as ${res.write.path}`);
  },
});

/** Every tool, in the order the agent sees them. */
export const drawerTools: readonly DrawerTool[] = [
  overview,
  listFiles,
  readFile,
  search,
  writeNote,
  addFact,
  setLibraryProfile,
  importReference,
  listAttachments,
  viewAttachment,
  fileAttachmentTool,
  setPartSpec,
  writeModel,
  editModel,
  evaluatePart,
  setParams,
  viewPart,
  measureFile,
  slice,
  probe,
  section,
  compare,
  attempts,
  restoreAttempt,
  setAssembly,
  evaluateAssembly,
  askUser,
];

/** The section appended to the guide in the system prompt. */
export function toolsSection(tools: readonly DrawerTool[] = drawerTools): string {
  return [
    "## Your tools",
    "",
    "These are your only tools. Paths are project-relative; `_library/<path>` reaches the shared library.",
    "write_model, edit_model, set_params, restore_attempt and set_part_spec return the evaluated report and the",
    "contact sheet by themselves: read both after every write. Waiving gates and recording prints are the person's;",
    "ask instead. The printer and materials change only to values the person gave you.",
    "",
    ...tools.map((t) => `- \`${t.name}\`: ${t.description}`),
  ].join("\n");
}
