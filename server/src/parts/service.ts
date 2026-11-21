/**
 * Parts, their evaluation against the spec, attempts, the measuring routes, assemblies and the
 * project roll-up (docs/SPEC.md → Parts and gates, Measuring, Assembly). Evaluation runs one at a
 * time in its own queue and never holds the service lock while OpenSCAD works.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  AssemblyReport,
  AssemblySpec,
  Attempt,
  CompareResult,
  CompareSide,
  Diagnostic,
  EvaluateBody,
  LibraryProfile,
  MeasureResult,
  MeshAnalysis,
  ParamValues,
  PartReport,
  PartSpec,
  PartSummary,
  PrintBody,
  ProbeResult,
  Project,
  ProjectDefaults,
  ProjectOverview,
  ProjectStatus,
  RenderBody,
  RenderRef,
  RenderResult,
  ReportStatus,
  ScadCheck,
  SectionResult,
  SetParamsBody,
  SliceResult,
  Vec3,
  WaiveBody,
  WriteResult,
} from "@drawer/shared/api";
import { ASSEMBLY_FILE, BRIEF_FILE, LIBRARY_SLUG, MATERIALS_FILE, PART_DIR, PART_SPEC_SUFFIX, PRINTER_FILE } from "@drawer/shared/api";
import { RenderError, type MeshAnalysisOutput, type MeshOutput, type Renderer } from "@drawer/shared/contracts";
import { ApiException, conflict, forbidden, invalid, notFound } from "../errors.ts";
import type { EventBus } from "../events.ts";
import type { Index } from "../index/indexer.ts";
import { defaultMaterials, defaultPrinter } from "../store/starter.ts";
import type { ProjectMeta, Store } from "../store/store.ts";
import { errorMessage, isNodeError, isoSeconds, revOfBytes } from "../util.ts";
import { assemblyGates, assemblyNext, assemblyStatus, bom, candidatePairs, placement, transformBox, type Box, type InstancePart, type PairMeasure } from "./assembly-gates.ts";
import { deriveAttempts, type ModelRevision } from "./attempts.ts";
import { countGates, lintSource, nextSteps, partGates, partStatus, worst, type DimMeasurement } from "./gates.ts";
import { measureDimension } from "./measure.ts";
import { JobQueue } from "./queue.ts";
import {
  PART_ID_RE,
  canonical,
  modelPath,
  parseJsonFile,
  partOfPath,
  prettyJson,
  specPath,
  structuredKind,
  validateAssembly,
  validateDefaults,
  validateMaterials,
  validatePartSpec,
  validatePartSpecBody,
  validatePrinter,
  waivableGate,
} from "./validate.ts";

const ALL_VIEWS = ["iso", "front", "top", "side"] as const;
const REPORT_SIZE = 800;
const REPORT_VERSION = "drawer-report-2";
const SCAD_RELATIONS = new Set(["uses", "includes", "imports"]);

/** What the parts module needs from the service: writes go through it so they are validated, committed, indexed and announced. */
export interface Workspace {
  writeFile(slug: string, path: string, bytes: Uint8Array, opts: { rev: string | undefined; author: string; message: string | undefined }): Promise<WriteResult>;
  writeMany(slug: string, writes: { path: string; bytes: Uint8Array }[], removes: string[], author: string, message: string): Promise<{ revisionId: string }>;
  render(slug: string, path: string, body: RenderBody): Promise<RenderResult>;
  mesh(slug: string, path: string, at?: string, params?: ParamValues): Promise<MeshOutput>;
}

export interface PartsDeps {
  store: Store;
  index: Index;
  bus: EventBus;
  renderer: Renderer;
  workspace: Workspace;
}

interface PartRef {
  slug: string;
  id: string;
}

interface KeyedReport {
  report: PartReport;
  key: string;
}

function sha(...parts: string[]): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const p of parts) h.update(`${p.length}:${p}`);
  return h.digest("hex");
}

const paramsKey = (params: ParamValues | undefined): string => (params && Object.keys(params).length > 0 ? canonical(params) : "");

function renderRef(key: string, views: readonly string[]): Omit<RenderRef, "mesh"> {
  const base = `/api/renders/${key}`;
  return { key, views: Object.fromEntries(views.map((v) => [v, `${base}/${v}.png`])), sheet: `${base}/sheet.png` };
}

function meshUrl(key: string): string {
  return `/api/renders/${key}/mesh.stl`;
}

function meshKeyOf(r: RenderRef): string {
  return basename(dirname(r.mesh));
}

function analysisView(key: string, a: MeshAnalysisOutput): MeshAnalysis {
  const { thicknessFile, ...rest } = a;
  return { ...rest, thickness: thicknessFile === null ? null : `/api/renders/${key}/${thicknessFile}` };
}

function fromRenderResult(r: RenderResult): RenderRef {
  return { key: r.key, mesh: r.mesh, views: r.views, sheet: r.sheet };
}

export class PartsService {
  private readonly store: Store;
  private readonly index: Index;
  private readonly bus: EventBus;
  private readonly renderer: Renderer;
  private readonly ws: Workspace;
  private readonly queue = new JobQueue();
  private readonly assemblyQueue = new JobQueue();
  private closed = false;
  /** The renderer's OpenSCAD version, part of every state key: an upgrade re-evaluates everything. Set by start(). */
  private rendererVersion = "unknown";

  constructor(deps: PartsDeps) {
    this.store = deps.store;
    this.index = deps.index;
    this.bus = deps.bus;
    this.renderer = deps.renderer;
    this.ws = deps.workspace;
  }

  /** Learns the renderer's version; call before anything reads a state key. */
  async start(): Promise<void> {
    this.rendererVersion = (await this.renderer.version()) ?? "unavailable";
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.queue.close(), this.assemblyQueue.close()]);
  }

  /** Waits until no evaluation is queued or running (tests). */
  async drained(): Promise<void> {
    for (let i = 0; i < 3; i++) await Promise.all([this.queue.drained(), this.assemblyQueue.drained()]);
  }

  private searchPaths(root: string): string[] {
    const library = this.store.projectDir(LIBRARY_SLUG);
    return root === library ? [root] : [root, library];
  }

  /** OpenSCAD reports absolute paths; clients know project-relative ones. */
  private relativise(text: string, root: string): string {
    return text.replaceAll(`${root}/`, "").replaceAll(`${this.store.projectDir(LIBRARY_SLUG)}/`, `${LIBRARY_SLUG}/`);
  }

  private relativeFile(file: string | null, root: string): string | null {
    if (file === null) return null;
    const library = this.store.projectDir(LIBRARY_SLUG);
    if (root !== library && file.startsWith(`${root}/`)) return file.slice(root.length + 1);
    if (file.startsWith(`${library}/`)) return `${LIBRARY_SLUG}/${file.slice(library.length + 1)}`;
    return file;
  }

  // ---- library profile and defaults ---------------------------------------------------------

  private async readLibraryJson<T>(path: string, validate: (v: unknown) => T, fallback: () => T): Promise<T> {
    try {
      return validate(parseJsonFile(await this.store.readBytes(LIBRARY_SLUG, path), path));
    } catch {
      return fallback();
    }
  }

  async profile(): Promise<LibraryProfile> {
    const [printer, materials] = await Promise.all([
      this.readLibraryJson(PRINTER_FILE, validatePrinter, defaultPrinter),
      this.readLibraryJson(MATERIALS_FILE, validateMaterials, defaultMaterials),
    ]);
    return { printer, materials: materials.materials, printerIsExample: canonical(printer) === canonical(defaultPrinter()) };
  }

  private async materialNames(): Promise<string[]> {
    return (await this.profile()).materials.map((m) => m.name);
  }

  /** Effective defaults: what project.json sets, else the library's first material and `standard`. */
  async defaults(meta: ProjectMeta): Promise<ProjectDefaults> {
    const names = await this.materialNames();
    const material = meta.defaults.material !== undefined && names.includes(meta.defaults.material) ? meta.defaults.material : (names[0] ?? "PLA");
    return { material, strictness: meta.defaults.strictness ?? "standard" };
  }

  async parseDefaults(value: unknown): Promise<Partial<ProjectDefaults>> {
    return validateDefaults(value, await this.materialNames());
  }

  // ---- structured-file validation and write hooks -------------------------------------------

  /** The validator for a write to `path`, or undefined when the file is not structured. Throws for a malformed spec path. */
  validatorFor(slug: string, path: string, author: string): ((bytes: Uint8Array) => Promise<void>) | undefined {
    const kind = structuredKind(slug, path);
    if (!kind) return undefined;
    return async (bytes) => {
      const value = parseJsonFile(bytes, path);
      switch (kind.kind) {
        case "part-spec": {
          const spec = validatePartSpec(value, await this.materialNames());
          if (slug === LIBRARY_SLUG && spec.source !== "bought") throw invalid(`a library part is bought hardware: give ${path} source "bought"; a printed part belongs in its project`);
          if (author === "agent") {
            const stored = await this.readSpec(slug, kind.id).catch(() => null);
            if (canonical(stored?.waivers ?? []) !== canonical(spec.waivers)) throw forbidden("waivers are a person's decision: they change only through POST .../parts/<id>/waive, never by an agent");
          }
          return;
        }
        case "assembly":
          validateAssembly(value);
          return;
        case "printer":
          validatePrinter(value);
          return;
        case "materials":
          validateMaterials(value);
          return;
      }
    };
  }

  /** OpenSCAD's verdict on a .scad file just written, without building geometry. */
  async check(slug: string, path: string): Promise<ScadCheck> {
    const root = this.store.projectDir(slug);
    try {
      const out = await this.renderer.check({ file: this.store.abs(slug, path), searchPaths: this.searchPaths(root) });
      return { ok: out.ok, diagnostics: out.diagnostics.map((d) => ({ ...d, message: this.relativise(d.message, root), file: this.relativeFile(d.file, root) })) };
    } catch (err) {
      return { ok: false, diagnostics: [{ level: "error", message: `OpenSCAD could not be run: ${this.relativise(errorMessage(err), root)}`, file: null, line: null }] };
    }
  }

  /** Called after every committed change: queues evaluations of the parts and assemblies it touches. */
  changed(slug: string, upserts: string[], removes: string[]): void {
    if (this.closed) return;
    const parts = new Map<string, PartRef>();
    const add = (ref: PartRef): void => {
      parts.set(`${ref.slug}/${ref.id}`, ref);
    };
    let everything = false;
    let assembly = false;
    for (const path of [...upserts, ...removes]) {
      const part = partOfPath(path);
      if (part) add({ slug, id: part.id });
      if (path.endsWith(".scad")) for (const ref of this.dependents(slug, path)) add(ref);
      if (slug === LIBRARY_SLUG && (path === PRINTER_FILE || path === MATERIALS_FILE)) everything = true;
      if (path === ASSEMBLY_FILE) assembly = true;
    }
    for (const ref of parts.values()) this.queuePart(ref, true);
    if (assembly) this.queueAssembly(slug, true);
    if (everything) this.queueAll(false).catch((err: unknown) => this.background(err));
  }

  private queuePart(ref: PartRef, high: boolean): void {
    if (!this.index.fileRow(ref.slug, specPath(ref.id))) {
      this.index.removePartStatus(ref.slug, ref.id);
      this.assembliesUsing(ref).catch((err: unknown) => this.background(err));
      return;
    }
    this.evaluateCurrent(ref.slug, ref.id, undefined, high).catch((err: unknown) => this.background(err));
  }

  private background(err: unknown): void {
    if (this.closed || err instanceof ApiException) return;
    console.error("evaluation failed:", err);
  }

  /** Queues every part and assembly whose status is not current (startup, reindex, a new printer profile). */
  async queueAll(onlyStale = true): Promise<void> {
    for (const slug of await this.store.slugs()) {
      if (this.closed) return;
      for (const id of this.partIds(slug)) {
        if (!onlyStale || this.index.partStatus(slug, id)?.state !== this.stateKey(slug, id)) this.queuePart({ slug, id }, false);
      }
      if (this.index.fileRow(slug, ASSEMBLY_FILE) && (!onlyStale || this.index.assemblyStatus(slug)?.state !== (await this.assemblyState(slug)))) this.queueAssembly(slug, false);
    }
  }

  /** Part models that use, include or import `path`, directly or through other files. */
  private dependents(slug: string, path: string): PartRef[] {
    const out: PartRef[] = [];
    const seen = new Set<string>([`${slug}/${path}`]);
    const queue: { project: string; path: string }[] = [{ project: slug, path }];
    while (queue.length > 0) {
      const item = queue.shift() as { project: string; path: string };
      for (const link of this.index.incoming(item.project, item.path)) {
        if (!SCAD_RELATIONS.has(link.relation)) continue;
        const key = `${link.fromProject}/${link.from}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const part = partOfPath(link.from);
        if (part?.file === "model") out.push({ slug: link.fromProject, id: part.id });
        queue.push({ project: link.fromProject, path: link.from });
      }
    }
    return out;
  }

  // ---- state fingerprints -------------------------------------------------------------------

  private partIds(slug: string): string[] {
    return this.index
      .fileRows(slug)
      .map((r) => (r.path.endsWith(PART_SPEC_SUFFIX) ? partOfPath(r.path) : null))
      .filter((p): p is { id: string; file: "spec" } => p?.file === "spec")
      .map((p) => p.id);
  }

  /** Revs of everything a part's report depends on, as far as the index knows: spec, model, the files it uses, printer and materials, and the renderer's version. */
  stateKey(slug: string, id: string): string {
    const rev = (project: string, path: string): string => this.index.fileRow(project, path)?.rev ?? "-";
    const revs = [REPORT_VERSION, this.rendererVersion, rev(slug, specPath(id)), rev(slug, modelPath(id)), rev(LIBRARY_SLUG, PRINTER_FILE), rev(LIBRARY_SLUG, MATERIALS_FILE)];
    return sha(...revs, ...this.usedRevs(slug, modelPath(id)));
  }

  /** What a render of `path` is made of, as far as the index knows: its rev, the revs of the files it uses, and the renderer's version. */
  fileInputKey(slug: string, path: string): string {
    return sha(this.rendererVersion, this.index.fileRow(slug, path)?.rev ?? "-", ...this.usedRevs(slug, path));
  }

  /** `<project>/<path>=<rev>` of every file `path` uses, includes or imports, directly or through other files, sorted. */
  private usedRevs(slug: string, path: string): string[] {
    const seen = new Set<string>();
    const queue = [{ project: slug, path }];
    const deps: string[] = [];
    while (queue.length > 0) {
      const item = queue.shift() as { project: string; path: string };
      for (const link of this.index.outgoing(item.project, item.path)) {
        if (!SCAD_RELATIONS.has(link.relation) || link.to === null || link.toProject === null) continue;
        const key = `${link.toProject}/${link.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deps.push(`${key}=${this.index.fileRow(link.toProject, link.to)?.rev ?? "-"}`);
        queue.push({ project: link.toProject, path: link.to });
      }
    }
    return deps.sort();
  }

  // ---- specs and summaries ------------------------------------------------------------------

  private requireId(id: string): void {
    if (!PART_ID_RE.test(id)) throw invalid("a part id must match [a-z0-9][a-z0-9-]*");
  }

  private async readSpec(slug: string, id: string, root?: string): Promise<PartSpec> {
    let bytes: Uint8Array;
    try {
      bytes = root === undefined ? await this.store.readBytes(slug, specPath(id)) : await Bun.file(join(root, specPath(id))).bytes();
    } catch (err) {
      if (err instanceof ApiException || isNodeError(err, "ENOENT", "ENOTDIR")) throw notFound(`no such part: ${id}`);
      throw err;
    }
    return validatePartSpec(parseJsonFile(bytes, specPath(id)), []);
  }

  private async requirePart(slug: string, id: string): Promise<PartSpec> {
    this.requireId(id);
    await this.store.requireProject(slug);
    return this.readSpec(slug, id);
  }

  private summaryStatus(slug: string, id: string): { status: ReportStatus; passed: number; total: number; failing: string[] } {
    if (!this.index.fileRow(slug, modelPath(id))) return { status: "empty", passed: 0, total: 0, failing: [] };
    const row = this.index.partStatus(slug, id);
    if (row && row.state === this.stateKey(slug, id)) return { status: row.status, passed: row.passed, total: row.total, failing: row.failing };
    return { status: "pending", passed: row?.passed ?? 0, total: row?.total ?? 0, failing: [] };
  }

  private evaluating(slug: string, id: string): boolean {
    return this.queue.busy(`${slug}/${id}@current#`) || this.queue.busy(`${slug}/${id}@state:`);
  }

  async summary(slug: string, id: string): Promise<PartSummary> {
    let spec: PartSpec | null = null;
    try {
      spec = await this.readSpec(slug, id);
    } catch (err) {
      if (!(err instanceof ApiException) || err.code === "not_found") throw err;
    }
    const specRow = this.index.fileRow(slug, specPath(id));
    const modelRow = this.index.fileRow(slug, modelPath(id));
    const newest = [specRow, modelRow].filter((r) => r !== null).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
    const s = this.summaryStatus(slug, id);
    return {
      project: slug,
      id,
      title: spec?.title ?? id,
      class: spec?.class ?? "",
      source: spec?.source ?? "printed",
      material: spec?.material ?? "",
      strictness: spec?.strictness ?? "standard",
      spec: specPath(id),
      model: modelRow ? modelPath(id) : null,
      status: spec === null ? "failed" : s.status,
      passed: s.passed,
      total: s.total,
      failing: spec === null ? ["the spec file is invalid"] : s.failing,
      evaluating: this.evaluating(slug, id),
      printed: spec?.prints.at(-1)?.outcome ?? null,
      updatedAt: newest?.updated_at ?? isoSeconds(),
      updatedBy: newest?.updated_by ?? "system",
    };
  }

  async list(slug: string): Promise<PartSummary[]> {
    await this.store.requireProject(slug);
    return Promise.all(this.partIds(slug).map((id) => this.summary(slug, id)));
  }

  async put(slug: string, id: string, body: unknown, author: string): Promise<PartSummary> {
    this.requireId(id);
    await this.store.requireProject(slug);
    const defaults = await this.defaults(await this.store.readMeta(slug));
    const fields = validatePartSpecBody(body, defaults, await this.materialNames());
    const stored = await this.readSpec(slug, id).catch(() => null);
    const spec: PartSpec = { ...fields, waivers: stored?.waivers ?? [], prints: stored?.prints ?? [] };
    await this.ws.writeFile(slug, specPath(id), prettyJson(spec), { rev: "*", author, message: `${stored ? "update" : "create"} part ${id}` });
    return this.summary(slug, id);
  }

  async remove(slug: string, id: string, author: string): Promise<{ revisionId: string }> {
    await this.requirePart(slug, id);
    return this.ws.writeMany(slug, [], [specPath(id), modelPath(id)], author, `delete part ${id}`);
  }

  async waive(slug: string, id: string, body: WaiveBody, author: string): Promise<PartSummary> {
    if (author === "agent") throw forbidden("waiving a gate is a person's decision; ask them to waive it in the web app");
    waivableGate(body.gate, "gate");
    const spec = await this.requirePart(slug, id);
    const waivers = spec.waivers.filter((w) => w.gate !== body.gate);
    const reason = body.reason.trim();
    if (reason !== "") waivers.push({ gate: body.gate, reason, by: author, at: isoSeconds() });
    await this.ws.writeFile(slug, specPath(id), prettyJson({ ...spec, waivers }), { rev: "*", author, message: reason === "" ? `unwaive ${id} ${body.gate}` : `waive ${id} ${body.gate}` });
    return this.summary(slug, id);
  }

  async print(slug: string, id: string, body: PrintBody, author: string): Promise<PartSummary> {
    const spec = await this.requirePart(slug, id);
    const revisionId = body.revisionId ?? (await this.store.git.head(this.store.projectDir(slug))) ?? "";
    if (body.revisionId !== undefined) this.store.requireRevisionId(body.revisionId);
    const prints = [...spec.prints, { revisionId, at: isoSeconds(), outcome: body.outcome, note: body.note }];
    await this.ws.writeFile(slug, specPath(id), prettyJson({ ...spec, prints }), { rev: "*", author, message: `printed ${id}: ${body.outcome}` });
    return this.summary(slug, id);
  }

  async setParams(slug: string, id: string, body: SetParamsBody, author: string): Promise<WriteResult> {
    await this.requirePart(slug, id);
    const path = modelPath(id);
    const current = await this.store.currentRev(slug, path);
    if (current === null) throw notFound(`part ${id} has no model yet`);
    if (body.rev !== current) throw conflict(`${path} changed: rev is ${current}, not ${body.rev}`, current);
    const source = new TextDecoder().decode(await this.store.readBytes(slug, path));
    let next: string;
    try {
      next = this.renderer.applyParams(source, body.values);
    } catch (err) {
      if (err instanceof RenderError) throw invalid(err.message);
      throw err;
    }
    const names = Object.keys(body.values).join(", ");
    return this.ws.writeFile(slug, path, new TextEncoder().encode(next), { rev: body.rev, author, message: body.message ?? `set ${names}` });
  }

  // ---- evaluation ---------------------------------------------------------------------------

  private reportFile(key: string): string {
    return join(this.store.reportCacheDir, `${key}.json`);
  }

  private async readCached<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.reportFile(key), "utf8")) as T;
    } catch {
      return null;
    }
  }

  private async writeCached(key: string, value: unknown): Promise<void> {
    await mkdir(this.store.reportCacheDir, { recursive: true });
    const tmp = join(this.store.tmpDir, `report-${key}-${crypto.randomUUID()}`);
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, this.reportFile(key)).catch(async (err: unknown) => {
      await rm(tmp, { force: true });
      throw err;
    });
  }

  /** The current report, waiting for an evaluation when the part changed since the last one. */
  async report(slug: string, id: string): Promise<PartReport> {
    await this.requirePart(slug, id);
    return (await this.currentKeyed(slug, id)).report;
  }

  private async currentKeyed(slug: string, id: string): Promise<KeyedReport> {
    const row = this.index.partStatus(slug, id);
    if (row && row.state === this.stateKey(slug, id)) {
      const cached = await this.readCached<PartReport>(row.reportKey);
      if (cached) return { report: cached, key: row.reportKey };
    }
    return this.evaluateCurrent(slug, id, undefined, true);
  }

  async evaluate(slug: string, id: string, body: EvaluateBody): Promise<PartReport> {
    await this.requirePart(slug, id);
    if (body.at !== undefined) {
      this.store.requireRevisionId(body.at);
      const at = body.at;
      const key = `${slug}/${id}@${at}#${paramsKey(body.params)}`;
      return (await this.queue.request(key, true, () => this.run(slug, id, { at, params: body.params, jobKey: key }))).report;
    }
    if (body.params === undefined || paramsKey(body.params) === "") return (await this.currentKeyed(slug, id)).report;
    return (await this.evaluateCurrent(slug, id, body.params, true)).report;
  }

  /** Joins an evaluation of the current state (running or queued), or queues one. */
  private evaluateCurrent(slug: string, id: string, params: ParamValues | undefined, high: boolean): Promise<KeyedReport> {
    const pk = paramsKey(params);
    const running = this.queue.find<KeyedReport>(`${slug}/${id}@state:${this.stateKey(slug, id)}#${pk}`);
    if (running) return running;
    const key = `${slug}/${id}@current#${pk}`;
    return this.queue.request(key, high, () => this.run(slug, id, { at: undefined, params, jobKey: key }));
  }

  private async run(slug: string, id: string, opts: { at: string | undefined; params: ParamValues | undefined; jobKey: string }): Promise<KeyedReport> {
    const started = performance.now();
    const whatIf = paramsKey(opts.params) !== "";
    const current = opts.at === undefined;
    const state = current ? this.stateKey(slug, id) : null;
    if (state !== null) this.queue.rekey(opts.jobKey, `${slug}/${id}@state:${state}#${paramsKey(opts.params)}`);
    const announce = current && !whatIf;
    const before = announce ? this.index.partStatus(slug, id) : null;
    if (announce) this.bus.emit({ type: "part", project: slug, part: id, evaluating: true, status: before?.status ?? null, passed: before?.passed ?? 0, total: before?.total ?? 0 });

    let root = this.store.projectDir(slug);
    let cleanup: (() => Promise<void>) | null = null;
    try {
      if (opts.at !== undefined) {
        const tree = await this.store.materialise(slug, opts.at);
        root = tree.root;
        cleanup = tree.cleanup;
      }
      const revisionId = opts.at ?? (await this.store.git.head(this.store.projectDir(slug))) ?? "";
      const spec = await this.readSpec(slug, id, opts.at === undefined ? undefined : root);
      const keyed = await this.measure(slug, id, spec, root, revisionId, opts.params, started);
      if (!whatIf) {
        const counts = { status: keyed.report.status, passed: keyed.report.passed, total: keyed.report.total };
        // Keyed by the context it was measured in: an attempt shows it only while that is the current one.
        if (keyed.modelRev !== null) this.index.recordPartEval(slug, id, keyed.modelRev, keyed.context, { reportKey: keyed.key, ...counts }, keyed.report.evaluatedAt);
        if (state !== null) {
          this.index.setPartStatus(slug, id, { state, ...counts, failing: countGates(keyed.report.gates).failing, reportKey: keyed.key });
        }
      }
      if (announce) {
        this.bus.emit({ type: "part", project: slug, part: id, evaluating: false, status: keyed.report.status, passed: keyed.report.passed, total: keyed.report.total });
        this.assembliesUsing({ slug, id }).catch((err: unknown) => this.background(err));
      }
      return { report: keyed.report, key: keyed.key };
    } catch (err) {
      if (announce) this.bus.emit({ type: "part", project: slug, part: id, evaluating: false, status: before?.status ?? null, passed: before?.passed ?? 0, total: before?.total ?? 0 });
      throw err;
    } finally {
      await cleanup?.();
    }
  }

  /** Steps of an evaluation: render, analyse, measure, gates. `root` is the project tree to read the model from. */
  private async measure(
    slug: string,
    id: string,
    spec: PartSpec,
    root: string,
    revisionId: string,
    params: ParamValues | undefined,
    started: number,
  ): Promise<KeyedReport & { modelRev: string | null; context: string }> {
    const profile = await this.profile();
    const material = profile.materials.find((m) => m.name === spec.material) ?? null;
    const whatIf = paramsKey(params) !== "";
    const evalContext = this.evalContext(spec, profile);
    const context = [evalContext, paramsKey(params)];
    const base = { project: slug, part: id, revisionId, spec, whatIf };
    const finish = (r: Omit<PartReport, "seconds" | "evaluatedAt" | keyof typeof base>): PartReport => ({ ...base, ...r, seconds: Math.round((performance.now() - started) / 10) / 100, evaluatedAt: isoSeconds() });

    const file = join(root, modelPath(id));
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (err) {
      if (!isNodeError(err, "ENOENT", "ENOTDIR")) throw err;
      const report = finish({ status: "empty", passed: 0, total: 0, gates: [], mesh: null, analysis: null, render: null, params: [], massG: null, next: nextSteps([], "empty", modelPath(id)) });
      const key = sha(REPORT_VERSION, "empty", ...context);
      await this.writeCached(key, report);
      return { report, key, modelRev: null, context: evalContext };
    }
    const modelRev = revOfBytes(new TextEncoder().encode(source));
    const scadParams = this.renderer.params(source);
    const searchPaths = this.searchPaths(root);

    let render;
    try {
      render = await this.renderer.render({ file, searchPaths, views: [...ALL_VIEWS], size: REPORT_SIZE, ...(params ? { params } : {}) });
    } catch (err) {
      if (!(err instanceof RenderError)) throw err;
      const error = await this.buildError(file, searchPaths, params, root, err);
      const gates = partGates({ spec, printer: profile.printer, material, build: { ok: false, error }, mesh: null, analysis: null, dimensions: {}, lint: lintSource(source, scadParams) });
      const counts = countGates(gates);
      const status = partStatus(gates, true);
      const report = finish({ status, passed: counts.passed, total: counts.total, gates, mesh: null, analysis: null, render: null, params: scadParams, massG: null, next: nextSteps(gates, status, modelPath(id)) });
      const key = sha(REPORT_VERSION, "failed", source, error, ...context);
      await this.writeCached(key, report);
      return { report, key, modelRev, context: evalContext };
    }

    const key = sha(REPORT_VERSION, render.key, ...context);
    const cached = await this.readCached<PartReport>(key);
    if (cached) return { report: { ...cached, revisionId, spec, whatIf, seconds: Math.round((performance.now() - started) / 10) / 100 }, key, modelRev, context: evalContext };

    const built = render.info.triangles > 0;
    const analysis = built ? await this.renderer.analyse({ key: render.meshKey, overhangDeg: profile.printer.maxOverhangDeg }) : null;
    const dimensions: Record<string, DimMeasurement> = {};
    if (built) for (const d of spec.dimensions) dimensions[d.id] = await measureDimension(this.renderer, render.meshKey, render.info, analysis, d);
    const gates = partGates({ spec, printer: profile.printer, material, build: { ok: true }, mesh: render.info, analysis, dimensions, lint: lintSource(source, scadParams) });
    const counts = countGates(gates);
    const status = partStatus(gates, true);
    const massG = render.info.volumeCm3 !== null && material ? Math.round(render.info.volumeCm3 * material.densityGCm3 * 100) / 100 : null;
    const report = finish({
      status,
      passed: counts.passed,
      total: counts.total,
      gates,
      mesh: render.info,
      analysis: analysis ? analysisView(render.meshKey, analysis) : null,
      render: { ...renderRef(render.key, render.views), mesh: meshUrl(render.meshKey) },
      params: scadParams,
      massG,
      next: nextSteps(gates, status, modelPath(id)),
    });
    await this.writeCached(key, report);
    return { report, key, modelRev, context: evalContext };
  }

  /** Everything besides the model that decides a part's verdict: spec (without prints), printer, material, renderer. */
  private evalContext(spec: PartSpec, profile: LibraryProfile): string {
    const material = profile.materials.find((m) => m.name === spec.material) ?? null;
    return sha(canonical({ ...spec, prints: [] }), canonical(profile.printer), canonical(material), this.rendererVersion);
  }

  /** The first OpenSCAD error of a model that does not build, as a sentence with project-relative paths. */
  private async buildError(file: string, searchPaths: string[], params: ParamValues | undefined, root: string, err: RenderError): Promise<string> {
    try {
      const check = await this.renderer.check({ file, searchPaths, ...(params ? { params } : {}) });
      const first: Diagnostic | undefined = check.diagnostics.find((d) => d.level === "error");
      if (first) {
        const where = this.relativeFile(first.file, root);
        return `${this.relativise(first.message, root)}${where ? ` (${where}${first.line === null ? "" : `:${first.line}`})` : first.line === null ? "" : ` (line ${first.line})`}`;
      }
    } catch {
      // fall through to the render's own message
    }
    return this.relativise(err.message, root).split("\n").find((l) => l.trim() !== "") ?? "OpenSCAD failed";
  }

  // ---- attempts -----------------------------------------------------------------------------

  /** Each attempt's status is from an evaluation of its model against the current spec, profile and renderer, or null. */
  async attempts(slug: string, id: string): Promise<Attempt[]> {
    const spec = await this.requirePart(slug, id);
    const context = this.evalContext(spec, await this.profile());
    const dir = this.store.projectDir(slug);
    const path = modelPath(id);
    const history = (await this.store.history(slug, path, 1000)).reverse();
    const revisions: ModelRevision[] = [];
    for (const rev of history) {
      const bytes = await this.store.git.show(dir, rev.id, path);
      revisions.push({ id: rev.id, author: rev.author, message: rev.message, date: rev.date, modelRev: bytes === null ? null : revOfBytes(bytes) });
    }
    const exists = this.index.fileRow(slug, path) !== null;
    return deriveAttempts(revisions, (modelRev) => this.index.partEval(slug, id, modelRev, context), exists);
  }

  async restore(slug: string, id: string, revisionId: string, author: string): Promise<WriteResult> {
    await this.requirePart(slug, id);
    const bytes = await this.store.readAt(slug, modelPath(id), revisionId);
    return this.ws.writeFile(slug, modelPath(id), bytes, { rev: "*", author, message: `restore ${revisionId}` });
  }

  // ---- measuring routes ---------------------------------------------------------------------

  private async rendered(slug: string, path: string, at: string | undefined, params?: ParamValues): Promise<RenderResult> {
    return this.ws.render(slug, path, { ...(at === undefined ? {} : { at }), ...(params ? { params } : {}) });
  }

  async measureFile(slug: string, path: string, at: string | undefined, params: ParamValues | undefined): Promise<MeasureResult> {
    const r = await this.rendered(slug, path, at, params);
    const profile = await this.profile();
    const key = meshKeyOf(r);
    const analysis = await this.renderer.analyse({ key, overhangDeg: profile.printer.maxOverhangDeg });
    return { project: slug, path, mesh: r.info, analysis: analysisView(key, analysis), render: fromRenderResult(r) };
  }

  async slice(slug: string, path: string, body: { axis: SliceResult["axis"]; at: number; revision?: string }): Promise<SliceResult> {
    const r = await this.ws.mesh(slug, path, body.revision);
    return this.renderer.slice({ key: r.key, axis: body.axis, at: body.at });
  }

  async probe(slug: string, path: string, body: { from: Vec3; axis: SliceResult["axis"]; revision?: string }): Promise<ProbeResult> {
    const r = await this.ws.mesh(slug, path, body.revision);
    return this.renderer.probe({ key: r.key, from: body.from, axis: body.axis });
  }

  async section(slug: string, path: string, body: { axis: SliceResult["axis"]; at: number; size?: number; revision?: string }): Promise<SectionResult> {
    const r = await this.ws.mesh(slug, path, body.revision);
    try {
      const file = await this.renderer.section({ key: r.key, axis: body.axis, at: body.at, size: body.size ?? REPORT_SIZE });
      return { axis: body.axis, at: body.at, image: `/api/renders/${r.key}/${file}` };
    } catch (err) {
      if (err instanceof RenderError) throw new ApiException("render_failed", err.message);
      throw err;
    }
  }

  private sidePath(side: CompareSide, name: string): string {
    if (side.part !== undefined) {
      if (!PART_ID_RE.test(side.part)) throw invalid(`${name}.part must be a part id`);
      return modelPath(side.part);
    }
    if (side.path !== undefined) return side.path;
    throw invalid(`${name} needs part or path`);
  }

  async compare(slug: string, a: CompareSide, b: CompareSide): Promise<CompareResult> {
    await this.store.requireProject(slug);
    const ra = await this.rendered(slug, this.sidePath(a, "a"), a.at);
    const rb = await this.rendered(slug, this.sidePath(b, "b"), b.at);
    const dev = await this.renderer.deviation({ a: meshKeyOf(ra), b: meshKeyOf(rb) });
    const va = ra.info.volumeCm3;
    const vb = rb.info.volumeCm3;
    const round = (n: number): number => Math.round(n * 1e4) / 1e4;
    return {
      a: { render: fromRenderResult(ra), mesh: ra.info },
      b: { render: fromRenderResult(rb), mesh: rb.info },
      deviation: { min: dev.min, max: dev.max, rms: dev.rms, p95: dev.p95, at: dev.at, field: `/api/renders/${meshKeyOf(rb)}/${dev.fieldFile}` },
      volumeDeltaCm3: va === null || vb === null ? null : round(vb - va),
      sizeDelta: [0, 1, 2].map((i) => round((rb.info.bbox.size[i] ?? 0) - (ra.info.bbox.size[i] ?? 0))) as Vec3,
    };
  }

  // ---- assembly -----------------------------------------------------------------------------

  private async readAssembly(slug: string): Promise<AssemblySpec> {
    let bytes: Uint8Array;
    try {
      bytes = await this.store.readBytes(slug, ASSEMBLY_FILE);
    } catch {
      throw notFound(`${slug} has no ${ASSEMBLY_FILE}`);
    }
    return validateAssembly(parseJsonFile(bytes, ASSEMBLY_FILE));
  }

  private resolvePart(slug: string, part: string): PartRef {
    return part.startsWith(`${LIBRARY_SLUG}/`) ? { slug: LIBRARY_SLUG, id: part.slice(LIBRARY_SLUG.length + 1) } : { slug, id: part };
  }

  private async assemblyState(slug: string): Promise<string> {
    const rev = this.index.fileRow(slug, ASSEMBLY_FILE)?.rev ?? "-";
    let spec: AssemblySpec;
    try {
      spec = await this.readAssembly(slug);
    } catch {
      return sha(REPORT_VERSION, this.rendererVersion, rev);
    }
    const parts = [...new Set(spec.instances.map((i) => i.part))].sort().map((p) => {
      const ref = this.resolvePart(slug, p);
      return `${p}=${this.stateKey(ref.slug, ref.id)}`;
    });
    return sha(REPORT_VERSION, this.rendererVersion, rev, ...parts);
  }

  private queueAssembly(slug: string, high: boolean): void {
    if (!this.index.fileRow(slug, ASSEMBLY_FILE)) {
      this.index.setAssemblyStatus(slug, null);
      return;
    }
    this.evaluateAssemblyCurrent(slug, high).catch((err: unknown) => this.background(err));
  }

  /** Re-evaluates the assemblies that place this part. */
  private async assembliesUsing(ref: PartRef): Promise<void> {
    if (this.closed) return;
    const slugs = ref.slug === LIBRARY_SLUG ? await this.store.slugs() : [ref.slug];
    const name = ref.slug === LIBRARY_SLUG ? `${LIBRARY_SLUG}/${ref.id}` : ref.id;
    for (const slug of slugs) {
      if (!this.index.fileRow(slug, ASSEMBLY_FILE)) continue;
      const spec = await this.readAssembly(slug).catch(() => null);
      if (spec?.instances.some((i) => i.part === name)) this.queueAssembly(slug, true);
    }
  }

  async assemblyReport(slug: string): Promise<AssemblyReport> {
    await this.store.requireProject(slug);
    if (!this.index.fileRow(slug, ASSEMBLY_FILE)) throw notFound(`${slug} has no ${ASSEMBLY_FILE}`);
    const row = this.index.assemblyStatus(slug);
    if (row && row.state === (await this.assemblyState(slug))) {
      const cached = await this.readCached<AssemblyReport>(row.reportKey);
      if (cached) return cached;
    }
    return this.evaluateAssemblyCurrent(slug, true);
  }

  async putAssembly(slug: string, body: unknown, author: string): Promise<AssemblyReport> {
    await this.store.requireProject(slug);
    const spec = validateAssembly(body);
    await this.ws.writeFile(slug, ASSEMBLY_FILE, prettyJson(spec), { rev: "*", author, message: "update assembly" });
    return this.assemblyReport(slug);
  }

  private async evaluateAssemblyCurrent(slug: string, high: boolean): Promise<AssemblyReport> {
    const running = this.assemblyQueue.find<AssemblyReport>(`${slug}@state:${await this.assemblyState(slug)}`);
    if (running) return running;
    const key = `${slug}@current`;
    return this.assemblyQueue.request(key, high, () => this.runAssembly(slug, key));
  }

  private async runAssembly(slug: string, jobKey: string): Promise<AssemblyReport> {
    const started = performance.now();
    const state = await this.assemblyState(slug);
    this.assemblyQueue.rekey(jobKey, `${slug}@state:${state}`);
    const before = this.index.assemblyStatus(slug);
    this.bus.emit({ type: "assembly", project: slug, evaluating: true, status: before?.status ?? null });
    try {
      const report = await this.assemble(slug, state, started);
      this.bus.emit({ type: "assembly", project: slug, evaluating: false, status: report.status });
      return report;
    } catch (err) {
      this.bus.emit({ type: "assembly", project: slug, evaluating: false, status: before?.status ?? null });
      throw err;
    }
  }

  private async assemble(slug: string, state: string, started: number): Promise<AssemblyReport> {
    const spec = await this.readAssembly(slug);
    const revisionId = (await this.store.git.head(this.store.projectDir(slug))) ?? "";
    const parts: InstancePart[] = [];
    const placed: { id: string; part: string; partStatus: ReportStatus; mesh: string | null; matrix: number[]; key: string | null; box: Box | null }[] = [];
    const reportKeys: string[] = [];
    const reports = new Map<string, KeyedReport | null>();
    for (const inst of spec.instances) {
      const ref = this.resolvePart(slug, inst.part);
      let keyed = reports.get(inst.part);
      if (keyed === undefined) {
        keyed = this.index.fileRow(ref.slug, specPath(ref.id)) && PART_ID_RE.test(ref.id) ? await this.currentKeyed(ref.slug, ref.id).catch(() => null) : null;
        reports.set(inst.part, keyed);
      }
      const report = keyed?.report ?? null;
      reportKeys.push(`${inst.id}=${keyed?.key ?? "-"}`);
      const matrix = placement(inst.rotate, inst.translate);
      const usable = report?.render && report.mesh && report.status !== "failed";
      parts.push({ instance: inst, status: report?.status ?? null, title: report?.spec.title ?? inst.part, source: report?.spec.source ?? "printed", material: report?.spec.material ?? null, massG: report?.massG ?? null, meshed: Boolean(usable) });
      placed.push({
        id: inst.id,
        part: inst.part,
        partStatus: report?.status ?? "empty",
        mesh: usable ? (report.render?.mesh ?? null) : null,
        matrix,
        key: usable && report.render ? meshKeyOf(report.render) : null,
        box: usable && report.mesh ? transformBox({ min: report.mesh.bbox.min, max: report.mesh.bbox.max }, matrix) : null,
      });
    }

    const cacheKey = sha(REPORT_VERSION, "assembly", canonical(spec), ...reportKeys);
    const cached = await this.readCached<AssemblyReport>(cacheKey);
    if (cached) {
      this.index.setAssemblyStatus(slug, { state, status: cached.status, reportKey: cacheKey });
      return { ...cached, revisionId };
    }

    const boxes = new Map(placed.filter((p) => p.box !== null).map((p) => [p.id, p.box as Box]));
    const byId = new Map(placed.map((p) => [p.id, p]));
    const pairs: PairMeasure[] = [];
    for (const [a, b] of candidatePairs(spec, boxes)) {
      const pa = byId.get(a);
      const pb = byId.get(b);
      if (!pa?.key || !pb?.key) continue;
      const m = await this.renderer.interference({ a: { key: pa.key, matrix: pa.matrix }, b: { key: pb.key, matrix: pb.matrix } });
      pairs.push({ a, b, gapMm: m.gapMm, overlapCm3: m.overlapCm3 });
    }
    const gates = assemblyGates({ spec, parts, pairs });
    const status = assemblyStatus(gates);
    const counts = countGates(gates);
    const billed = bom(parts);

    const highlight = new Set<string>();
    for (const gate of gates.filter((x) => x.status === "fail")) {
      if (gate.id === "clash") for (const p of pairs.filter((p) => p.overlapCm3 * 1000 > 0.5)) highlight.add(p.a).add(p.b);
      if (gate.id.startsWith("mate:")) {
        const mate = spec.mates.find((m) => `mate:${m.id}` === gate.id);
        if (mate) highlight.add(mate.a).add(mate.b);
      }
    }
    let render: AssemblyReport["render"] = null;
    const drawable = placed.filter((p) => p.key !== null);
    if (drawable.length > 0) {
      try {
        const out = await this.renderer.renderAssembly({ instances: drawable.map((p) => ({ id: p.id, key: p.key as string, matrix: p.matrix })), highlight: [...highlight], views: [...ALL_VIEWS], size: REPORT_SIZE });
        const ref = renderRef(out.key, out.views);
        render = ref;
      } catch (err) {
        if (!(err instanceof RenderError)) throw err;
      }
    }
    const report: AssemblyReport = {
      project: slug,
      revisionId,
      status,
      passed: counts.passed,
      total: counts.total,
      gates,
      spec,
      instances: placed.map((p) => ({ id: p.id, part: p.part, partStatus: p.partStatus, mesh: p.mesh, matrix: p.matrix })),
      pairs: pairs.map((p) => ({ a: p.a, b: p.b, gapMm: p.gapMm, overlapCm3: p.overlapCm3 })),
      bom: billed.lines,
      totalPrintedMassG: billed.totalPrintedMassG,
      render,
      next: assemblyNext(gates),
      seconds: Math.round((performance.now() - started) / 10) / 100,
      evaluatedAt: isoSeconds(),
    };
    await this.writeCached(cacheKey, report);
    this.index.setAssemblyStatus(slug, { state, status, reportKey: cacheKey });
    return report;
  }

  // ---- roll-ups -----------------------------------------------------------------------------

  private async assemblySummary(slug: string): Promise<{ status: ReportStatus; instances: number; failing: string[] } | null> {
    if (!this.index.fileRow(slug, ASSEMBLY_FILE)) return null;
    const spec = await this.readAssembly(slug).catch(() => null);
    const row = this.index.assemblyStatus(slug);
    if (!row || row.state !== (await this.assemblyState(slug))) return { status: "pending", instances: spec?.instances.length ?? 0, failing: [] };
    const report = await this.readCached<AssemblyReport>(row.reportKey);
    return { status: row.status, instances: spec?.instances.length ?? 0, failing: report ? report.gates.filter((g) => g.status === "fail").map((g) => g.label) : [] };
  }

  async projectStatus(slug: string): Promise<ProjectStatus> {
    const statuses = this.partIds(slug).map((id) => this.summaryStatus(slug, id).status);
    const assembly = await this.assemblySummary(slug);
    const count = (s: ReportStatus): number => statuses.filter((x) => x === s).length;
    return {
      parts: statuses.length,
      passed: count("passed"),
      draft: count("draft"),
      failed: count("failed"),
      pending: count("pending"),
      assembly: assembly?.status ?? "none",
      overall: statuses.length === 0 ? "empty" : worst([...statuses, ...(assembly ? [assembly.status] : [])]),
    };
  }

  async overview(project: Project): Promise<ProjectOverview> {
    const slug = project.slug;
    const text = async (s: string, path: string): Promise<string> => {
      try {
        return new TextDecoder().decode(await this.store.readBytes(s, path));
      } catch {
        return "";
      }
    };
    const files = this.index.fileRows(slug).map((r) => r.path);
    const libraryFiles = this.index.fileRows(LIBRARY_SLUG);
    return {
      project,
      brief: await text(slug, BRIEF_FILE),
      memory: await text(slug, "AGENTS.md"),
      parts: await this.list(slug),
      assembly: await this.assemblySummary(slug),
      references: files.filter((p) => p.startsWith("refs/")),
      notes: files.filter((p) => p.startsWith("notes/")),
      library: {
        profile: await this.profile(),
        notes: libraryFiles.filter((r) => r.kind === "markdown" && !r.path.startsWith(`${PART_DIR}/`)).map((r) => r.path),
        parts: slug === LIBRARY_SLUG ? [] : await this.list(LIBRARY_SLUG),
      },
    };
  }
}
