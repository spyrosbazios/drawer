import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type {
  ContextNode,
  ContextResponse,
  CreateProjectBody,
  FileInfo,
  FileKind,
  HistoryResponse,
  Health,
  ImportBody,
  ImportPreview,
  ImportResult,
  MeshInfo,
  PatchProjectBody,
  Project,
  ProjectOverview,
  RenderBody,
  RenderResult,
  RenderView,
  SearchHit,
  TreeEntry,
  TreeResponse,
  WriteResult,
} from "@drawer/shared/api";
import { LIBRARY_SLUG } from "@drawer/shared/api";
import { ImportError, RenderError, type Importers, type MeshOutput, type MeshRequest, type Renderer } from "@drawer/shared/contracts";
import { ApiException, exists, invalid, notFound } from "./errors.ts";
import type { EventBus } from "./events.ts";
import { Index, type FileRow, type UpsertSpec } from "./index/indexer.ts";
import { MAX_IMPORT_IMAGES, imageExtension, safeFileName, sourceMarkdown, uniqueName } from "./importing.ts";
import { assertNewSlug, isHiddenName, kindFromExtension, normalizePath, slugify } from "./store/paths.ts";
import { PartsService } from "./parts/service.ts";
import { partOfPath } from "./parts/validate.ts";
import { assertLibraryKeeps, assertLibraryPath } from "./library-layout.ts";
import { Thumbnails } from "./thumbnails.ts";
import { libraryProfileFiles, libraryStarter, projectStarter } from "./store/starter.ts";
import { Store, type Change, type ProjectMeta } from "./store/store.ts";
import { Lock, errorMessage, isoSeconds, randomId, revOfBytes, revOfFile } from "./util.ts";
import { VERSION } from "./version.ts";

export const ALL_VIEWS: RenderView[] = ["iso", "front", "top", "side"];
const DEFAULT_RENDER_SIZE = 800;
/** Longer side of a project thumbnail in pixels: sharp on a 2x screen at the home page's largest tile. */
const THUMBNAIL_SIZE = 480;
const MAX_CONTEXT_NODES = 30;

export interface ServiceDeps {
  store: Store;
  index: Index;
  bus: EventBus;
  renderer: Renderer;
  importers: Importers;
}

export interface ReadResult {
  /** A path on disk (current revision) or the bytes (past revision). */
  source: { type: "file"; abs: string } | { type: "bytes"; bytes: Uint8Array };
  rev: string;
  kind: FileKind | null;
}

async function lstatOrNull(abs: string): Promise<{ type: "file" | "dir" } | null> {
  try {
    const st = await lstat(abs);
    return { type: st.isDirectory() ? "dir" : "file" };
  } catch {
    return null;
  }
}

function importFailed(err: unknown): ApiException {
  return err instanceof ApiException ? err : new ApiException("import_failed", errorMessage(err));
}

export class Service {
  private readonly store: Store;
  private readonly index: Index;
  private readonly bus: EventBus;
  private readonly renderer: Renderer;
  private readonly importers: Importers;
  private readonly lock = new Lock();
  private readonly thumbnails: Thumbnails;
  readonly parts: PartsService;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.index = deps.index;
    this.bus = deps.bus;
    this.renderer = deps.renderer;
    this.importers = deps.importers;
    this.parts = new PartsService({
      store: deps.store,
      index: deps.index,
      bus: deps.bus,
      renderer: deps.renderer,
      workspace: {
        writeFile: (slug, path, bytes, opts) => this.writeFile(slug, path, bytes, opts),
        writeMany: (slug, writes, removes, author, message) => this.writeMany(slug, writes, removes, author, message),
        render: (slug, path, body) => this.render(slug, path, body),
        mesh: (slug, path, at, params) => this.mesh(slug, path, at, params),
      },
    });
    this.thumbnails = new Thumbnails({
      dir: deps.store.thumbnailDir,
      inputKey: (slug, path) => this.parts.fileInputKey(slug, path),
      render: async (slug, path) => {
        const { key } = await this.render(slug, path, { views: ALL_VIEWS, size: DEFAULT_RENDER_SIZE });
        return join(deps.store.renderCacheDir, key, await this.renderer.thumbnail({ key, view: "iso", size: THUMBNAIL_SIZE }));
      },
      gaveUp: (slug) => this.bus.emit({ type: "project", action: "updated", slug }),
    });
  }

  /** Stops evaluations; the running one finishes first. */
  async close(): Promise<void> {
    await this.parts.close();
  }

  // ---- startup ------------------------------------------------------------------------------

  /** Creates the library on first start, then brings the index in line with the files. */
  async start(rebuild: boolean): Promise<void> {
    await this.parts.start();
    await this.store.init();
    await this.lock.run(async () => {
      if (!(await this.store.has(LIBRARY_SLUG))) await this.createProjectLocked(LIBRARY_SLUG, { title: "Library", description: "Notes shared by every project.", cover: null, source: null, createdAt: isoSeconds(), defaults: {} }, libraryStarter(), "system", false);
      else await this.completeLibraryLocked();
      if (rebuild) await this.reindexLocked();
      else await this.reconcileLocked();
    });
    await this.parts.queueAll();
  }

  /** A library from before printer.json and materials.json existed gets them, in one commit. */
  private async completeLibraryLocked(): Promise<void> {
    const missing = [];
    for (const file of libraryProfileFiles()) if ((await this.store.stat(LIBRARY_SLUG, file.path)) === null) missing.push({ path: file.path, bytes: new TextEncoder().encode(file.content) });
    if (missing.length === 0) return;
    const change = await this.store.writeMany(LIBRARY_SLUG, missing, [], { author: "system", message: `add ${missing.map((m) => m.path).join(" and ")}` });
    if (change.commit) await this.indexChange(LIBRARY_SLUG, change, "system");
  }

  private async reconcileLocked(): Promise<void> {
    const slugs = await this.store.slugs();
    for (const gone of this.index.projectSlugs().filter((s) => !slugs.includes(s))) this.index.removeProject(gone);
    for (const slug of slugs) {
      await this.syncProjectLocked(slug);
      if (!this.index.projectStamp(slug)) await this.stampFromGit(slug);
    }
  }

  private async stampFromGit(slug: string): Promise<void> {
    const { last } = await this.store.git.provenance(this.store.projectDir(slug));
    const meta = await this.store.readMeta(slug);
    this.index.touchProject(slug, last?.at ?? meta.createdAt, last?.by ?? "system");
  }

  /** Drops the index and rebuilds it from the files. */
  async reindex(): Promise<{ files: number }> {
    const result = await this.lock.run(() => this.reindexLocked());
    await this.parts.queueAll();
    return result;
  }

  private async reindexLocked(): Promise<{ files: number }> {
    this.index.clear();
    let files = 0;
    for (const slug of await this.store.slugs()) {
      const { last, byPath } = await this.store.git.provenance(this.store.projectDir(slug));
      const meta = await this.store.readMeta(slug);
      const paths = (await this.store.walk(slug)).filter((e) => e.type === "file");
      const specs: UpsertSpec[] = paths.map((e) => {
        const stamp = byPath.get(e.path);
        return { path: e.path, updatedAt: stamp?.at ?? new Date(e.mtimeMs ?? 0).toISOString(), updatedBy: stamp?.by ?? "system" };
      });
      await this.index.apply(slug, specs, []);
      this.index.touchProject(slug, last?.at ?? meta.createdAt, last?.by ?? "system");
      files += specs.length;
    }
    return { files };
  }

  /** Re-indexes files whose size or mtime differ from the index, and forgets files that are gone. */
  private async syncProjectLocked(slug: string): Promise<Map<string, FileRow>> {
    const entries = (await this.store.walk(slug)).filter((e) => e.type === "file");
    const rows = new Map(this.index.fileRows(slug).map((r) => [r.path, r]));
    const stale: UpsertSpec[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.path);
      const row = rows.get(e.path);
      if (!row || row.size !== e.size || row.mtime_ms !== e.mtimeMs) {
        stale.push({ path: e.path, updatedAt: new Date(e.mtimeMs ?? 0).toISOString(), updatedBy: "system" });
      }
    }
    const removed = [...rows.keys()].filter((p) => !seen.has(p));
    if (stale.length === 0 && removed.length === 0) return rows;
    await this.index.apply(slug, stale, removed);
    return new Map(this.index.fileRows(slug).map((r) => [r.path, r]));
  }

  // ---- health -------------------------------------------------------------------------------

  async health(): Promise<Health> {
    let openscad: string | null = null;
    try {
      openscad = await this.renderer.version();
    } catch {
      openscad = null;
    }
    return { ok: true, version: VERSION, openscad };
  }

  // ---- projects -----------------------------------------------------------------------------

  private async projectView(slug: string): Promise<Project> {
    const meta = await this.store.readMeta(slug);
    let stamp = this.index.projectStamp(slug);
    if (!stamp) {
      await this.lock.run(() => this.stampFromGit(slug));
      stamp = this.index.projectStamp(slug);
    }
    const cover = this.effectiveCover(slug, meta);
    return {
      slug,
      title: meta.title,
      description: meta.description,
      createdAt: meta.createdAt,
      updatedAt: stamp?.updatedAt ?? meta.createdAt,
      updatedBy: stamp?.updatedBy ?? "system",
      fileCount: this.index.countFiles(slug),
      cover,
      thumbnail: this.thumbnails.url(slug, this.coverCandidates(slug, cover)),
      source: meta.source,
      defaults: await this.parts.defaults(meta),
      status: await this.parts.projectStatus(slug),
    };
  }

  /** The chosen cover while it is a .scad or mesh file that exists, else the automatic pick. */
  private effectiveCover(slug: string, meta: ProjectMeta): string | null {
    const stored = meta.cover === null ? null : this.index.fileRow(slug, meta.cover);
    return stored && (stored.kind === "scad" || stored.kind === "mesh") ? stored.path : this.index.defaultCover(slug);
  }

  /** What the thumbnail may show, best first: the cover, then the other candidates, so one broken file does not blank the card. */
  private coverCandidates(slug: string, cover: string | null): string[] {
    return [...new Set([...(cover === null ? [] : [cover]), ...this.index.coverCandidates(slug)])];
  }

  /** The PNG bytes of a project thumbnail by its key (see Project.thumbnail); rendered on first request. */
  async thumbnail(slug: string, key: string): Promise<Uint8Array> {
    await this.store.requireProject(slug);
    const cover = this.effectiveCover(slug, await this.store.readMeta(slug));
    return this.thumbnails.read(slug, key, this.coverCandidates(slug, cover));
  }

  async listProjects(): Promise<Project[]> {
    const slugs = (await this.store.slugs()).filter((s) => s !== LIBRARY_SLUG);
    const projects = await Promise.all(slugs.map((s) => this.projectView(s)));
    return projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : 1));
  }

  async getProject(slug: string): Promise<Project> {
    await this.store.requireProject(slug);
    return this.projectView(slug);
  }

  async createProject(body: CreateProjectBody, author: string): Promise<Project> {
    const slug = assertNewSlug(body.slug);
    if (await this.store.has(slug)) throw exists(`project already exists: ${slug}`);
    // Look at the remote first: a bad URL must not leave an empty project behind.
    const preview = body.fromUrl === undefined ? undefined : await this.previewImport(body.fromUrl);
    const meta: ProjectMeta = {
      title: body.title?.trim() || slug,
      description: body.description ?? "",
      cover: null,
      source: null,
      createdAt: isoSeconds(),
      defaults: body.defaults === undefined ? {} : await this.parts.parseDefaults(body.defaults),
    };
    await this.lock.run(() => this.createProjectLocked(slug, meta, projectStarter(meta.title, body.brief), author, true));
    if (body.fromUrl !== undefined && preview) {
      await this.importInto(slug, { url: body.fromUrl, ...(body.fileIds ? { fileIds: body.fileIds } : {}) }, preview);
      await this.lock.run(async () => {
        await this.store.writeMeta(slug, { ...(await this.store.readMeta(slug)), source: { ...preview.source, importedAt: isoSeconds() } });
      });
    }
    return this.projectView(slug);
  }

  private async createProjectLocked(slug: string, meta: ProjectMeta, files: ReturnType<typeof projectStarter>, author: string, announce: boolean): Promise<void> {
    const change = await this.store.createProject(slug, meta, files, author);
    await this.indexChange(slug, change, author);
    if (announce) this.bus.emit({ type: "project", action: "created", slug });
  }

  async patchProject(slug: string, body: PatchProjectBody, author: string): Promise<Project> {
    const defaults = body.defaults === undefined ? undefined : await this.parts.parseDefaults(body.defaults);
    await this.lock.run(async () => {
      await this.store.requireProject(slug);
      const meta = await this.store.readMeta(slug);
      if (defaults !== undefined) meta.defaults = { ...meta.defaults, ...defaults };
      if (body.title !== undefined) meta.title = body.title.trim() || slug;
      if (body.description !== undefined) meta.description = body.description;
      if (body.cover !== undefined) {
        if (body.cover === null) {
          meta.cover = null;
        } else {
          const path = normalizePath(body.cover);
          const row = await this.freshLocked(slug, path);
          if (!row || (row.kind !== "scad" && row.kind !== "mesh")) throw invalid("cover must be an existing .scad or mesh file");
          meta.cover = path;
        }
      }
      await this.store.writeMeta(slug, meta);
      this.index.touchProject(slug, isoSeconds(), author);
      this.bus.emit({ type: "project", action: "updated", slug });
    });
    return this.projectView(slug);
  }

  async deleteProject(slug: string): Promise<void> {
    if (slug === LIBRARY_SLUG) throw invalid("the library cannot be deleted");
    await this.lock.run(async () => {
      await this.store.requireProject(slug);
      await this.store.trash(slug);
      this.index.removeProject(slug);
      this.bus.emit({ type: "project", action: "deleted", slug });
    });
  }

  // ---- index plumbing -----------------------------------------------------------------------

  private async indexChange(slug: string, change: Change, author: string): Promise<void> {
    const at = change.commit?.date ?? isoSeconds();
    await this.index.apply(
      slug,
      change.upserts.map((path) => ({ path, updatedAt: at, updatedBy: author })),
      change.removes,
    );
    this.index.touchProject(slug, at, author);
  }

  /** The index row of a file, re-indexed first when the file changed behind the index's back. */
  private async freshLocked(slug: string, path: string): Promise<FileRow | null> {
    const st = await this.store.stat(slug, path);
    const row = this.index.fileRow(slug, path);
    if (st?.type !== "file" || isHiddenName(posix.basename(path))) {
      if (row) await this.index.apply(slug, [], [path]);
      return null;
    }
    if (row && row.size === st.size && row.mtime_ms === st.mtimeMs) return row;
    await this.index.apply(slug, [{ path, updatedAt: new Date(st.mtimeMs).toISOString(), updatedBy: "system" }], []);
    return this.index.fileRow(slug, path);
  }

  private async fresh(slug: string, path: string): Promise<FileRow | null> {
    await this.store.requireProject(slug);
    const st = await this.store.stat(slug, path);
    const row = this.index.fileRow(slug, path);
    if (st?.type === "file" && row && row.size === st.size && row.mtime_ms === st.mtimeMs) return row;
    return this.lock.run(() => this.freshLocked(slug, path));
  }

  private async requireFile(slug: string, path: string): Promise<FileRow> {
    const row = await this.fresh(slug, path);
    if (!row) throw notFound(`no such file: ${path}`);
    return row;
  }

  // ---- files --------------------------------------------------------------------------------

  async tree(slug: string): Promise<TreeResponse> {
    await this.store.requireProject(slug);
    const rows = await this.lock.run(() => this.syncProjectLocked(slug));
    const entries: TreeEntry[] = (await this.store.walk(slug)).map((e) => {
      if (e.type === "dir") return { path: e.path, type: "dir" };
      const row = rows.get(e.path);
      return {
        path: e.path,
        type: "file",
        ...(row ? { kind: row.kind, rev: row.rev, updatedAt: row.updated_at, updatedBy: row.updated_by } : {}),
        ...(e.size === undefined ? {} : { size: e.size }),
      };
    });
    return { entries };
  }

  async readFile(slug: string, path: string, at: string | undefined): Promise<ReadResult> {
    await this.store.requireProject(slug);
    if (at !== undefined) {
      const bytes = await this.store.readAt(slug, path, at);
      return { source: { type: "bytes", bytes }, rev: revOfBytes(bytes), kind: kindFromExtension(path) };
    }
    const st = await this.store.stat(slug, path);
    if (st?.type !== "file") throw notFound(`no such file: ${path}`);
    const row = isHiddenName(posix.basename(path)) ? null : await this.fresh(slug, path);
    const abs = this.store.abs(slug, path);
    return { source: { type: "file", abs }, rev: row?.rev ?? (await revOfFile(abs)), kind: row?.kind ?? kindFromExtension(path) };
  }

  async writeFile(slug: string, path: string, bytes: Uint8Array, opts: { rev: string | undefined; author: string; message: string | undefined }): Promise<WriteResult> {
    const result = await this.lock.run(async () => {
      await this.store.requireProject(slug);
      this.checkPlace(slug, path);
      const validate = this.parts.validatorFor(slug, path, opts.author);
      const result = await this.store.write(slug, path, bytes, { ...opts, ...(validate ? { validate } : {}) });
      if (result.commit) await this.indexChange(slug, result, opts.author);
      return result;
    });
    return this.afterWrite(slug, path, result, opts.author);
  }

  async editFile(slug: string, path: string, body: { rev: string; old: string; new: string; replaceAll: boolean; message: string | undefined }, author: string): Promise<WriteResult> {
    const result = await this.lock.run(async () => {
      await this.store.requireProject(slug);
      this.checkPlace(slug, path);
      const validate = this.parts.validatorFor(slug, path, author);
      const result = await this.store.edit(slug, path, { ...body, author, ...(validate ? { validate } : {}) });
      if (result.commit) await this.indexChange(slug, result, author);
      return { ...result, created: false };
    });
    return this.afterWrite(slug, path, result, author);
  }

  /** Announces a committed write, queues the evaluations it affects, and checks a .scad file (outside the lock: it runs OpenSCAD). */
  private async afterWrite(slug: string, path: string, result: Change & { rev: string; created: boolean }, author: string): Promise<WriteResult> {
    if (result.commit) {
      this.emitFile("written", slug, path, result.rev, author);
      this.parts.changed(slug, result.upserts, result.removes);
    }
    const check = kindFromExtension(path) === "scad" ? await this.parts.check(slug, path) : null;
    return { project: slug, path, rev: result.rev, created: result.created, revisionId: result.revisionId, check, part: partOfPath(path)?.id ?? null };
  }

  /** Several files written and removed as one revision (parts routes). Structured files are validated first. */
  async writeMany(slug: string, writes: { path: string; bytes: Uint8Array }[], removes: string[], author: string, message: string): Promise<{ revisionId: string }> {
    return this.lock.run(async () => {
      await this.store.requireProject(slug);
      for (const w of writes) this.checkPlace(slug, w.path);
      if (slug === LIBRARY_SLUG) for (const path of removes) assertLibraryKeeps(path);
      for (const w of writes) await this.parts.validatorFor(slug, w.path, author)?.(w.bytes);
      const change = await this.store.writeMany(slug, writes, removes, { author, message });
      if (change.commit) {
        await this.indexChange(slug, change, author);
        for (const w of writes) this.emitFile("written", slug, w.path, this.index.fileRow(slug, w.path)?.rev ?? null, author);
        for (const path of change.removes) this.emitFile("deleted", slug, path, null, author);
        this.parts.changed(slug, change.upserts, change.removes);
      }
      return { revisionId: change.revisionId };
    });
  }

  async deleteFile(slug: string, path: string, opts: { rev: string | undefined; recursive: boolean; message: string | undefined }, author: string): Promise<{ revisionId: string }> {
    return this.lock.run(async () => {
      await this.store.requireProject(slug);
      if (slug === LIBRARY_SLUG) assertLibraryKeeps(path);
      const change = await this.store.remove(slug, path, { ...opts, author });
      if (change.commit) {
        await this.indexChange(slug, change, author);
        this.emitFile("deleted", slug, path, null, author);
        this.parts.changed(slug, change.upserts, change.removes);
      }
      return { revisionId: change.revisionId };
    });
  }

  async moveFile(slug: string, from: string, to: string, message: string | undefined, author: string): Promise<{ revisionId: string }> {
    return this.lock.run(async () => {
      await this.store.requireProject(slug);
      if (slug === LIBRARY_SLUG) {
        assertLibraryKeeps(from);
        const st = await this.store.stat(slug, from);
        const moved = st?.type === "dir" ? (await this.store.walk(slug, from)).filter((e) => e.type === "file").map((e) => `${to}${e.path.slice(from.length)}`) : [to];
        for (const path of moved) assertLibraryPath(path);
      }
      if ((await this.store.stat(slug, from))?.type === "file") {
        const validate = this.parts.validatorFor(slug, to, author);
        if (validate) await validate(await this.store.readBytes(slug, from));
      }
      const change = await this.store.move(slug, from, to, { author, message });
      await this.indexChange(slug, change, author);
      this.parts.changed(slug, change.upserts, change.removes);
      this.emitFile("deleted", slug, from, null, author);
      this.emitFile("moved", slug, to, change.upserts.length === 1 ? (this.index.fileRow(slug, to)?.rev ?? null) : null, author);
      return { revisionId: change.revisionId };
    });
  }

  /** The library takes writes only in its fixed layout; other projects take any path. */
  private checkPlace(slug: string, path: string): void {
    if (slug === LIBRARY_SLUG) assertLibraryPath(path);
  }

  private emitFile(action: "written" | "deleted" | "moved", project: string, path: string, rev: string | null, author: string): void {
    this.bus.emit({ type: "file", action, project, path, rev, author });
  }

  async history(slug: string, path: string, limit: number): Promise<HistoryResponse> {
    await this.store.requireProject(slug);
    return { revisions: await this.store.history(slug, path, limit) };
  }

  // ---- index reads --------------------------------------------------------------------------

  async info(slug: string, path: string): Promise<FileInfo> {
    const row = await this.requireFile(slug, path);
    return {
      project: slug,
      path,
      kind: row.kind,
      size: row.size,
      rev: row.rev,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      mesh: row.mesh ? (JSON.parse(row.mesh) as MeshInfo) : null,
      facts: row.kind === "markdown" ? this.index.facts(slug, path) : [],
      outgoing: this.index.outgoing(slug, path),
      incoming: this.index.incoming(slug, path),
      outline: JSON.parse(row.outline) as string[],
    };
  }

  async context(slug: string, path: string, depth: number, maxBytes: number): Promise<ContextResponse> {
    const root = await this.requireFile(slug, path);
    const nodes: ContextNode[] = [];
    const seen = new Set<string>();
    const key = (project: string, p: string): string => `${project}\u0000${p}`;
    const queue: { row: FileRow; depth: number; via: ContextNode["via"] }[] = [{ row: root, depth: 0, via: null }];
    seen.add(key(slug, path));
    for (let i = 0; i < queue.length && nodes.length < MAX_CONTEXT_NODES; i++) {
      const item = queue[i];
      if (!item) break;
      nodes.push(await this.contextNode(item.row, item.depth, item.via, maxBytes));
      if (item.depth >= depth) continue;
      const links = [
        ...this.index.outgoing(item.row.project, item.row.path).map((link) => ({ link, project: link.toProject, path: link.to })),
        ...this.index.incoming(item.row.project, item.row.path).map((link) => ({ link, project: link.fromProject, path: link.from })),
      ];
      for (const { link, project, path: nextPath } of links) {
        if (project === null || nextPath === null || seen.has(key(project, nextPath))) continue;
        const row = this.index.fileRow(project, nextPath);
        if (!row) continue;
        seen.add(key(project, nextPath));
        queue.push({ row, depth: item.depth + 1, via: link });
      }
    }
    return { root: path, nodes };
  }

  private async contextNode(row: FileRow, depth: number, via: ContextNode["via"], maxBytes: number): Promise<ContextNode> {
    const textual = row.kind === "markdown" || row.kind === "scad" || row.kind === "text";
    let content: string | null = null;
    let truncated = false;
    if (textual) {
      const bytes = await Bun.file(this.store.abs(row.project, row.path)).slice(0, maxBytes + 1).bytes();
      truncated = bytes.length > maxBytes;
      content = new TextDecoder().decode(truncated ? bytes.slice(0, maxBytes) : bytes);
      if (truncated) content = content.replace(/\uFFFD+$/, ""); // a multi-byte character cut in half
    }
    return {
      project: row.project,
      path: row.path,
      kind: row.kind,
      depth,
      via,
      content,
      truncated,
      mesh: row.mesh ? (JSON.parse(row.mesh) as MeshInfo) : null,
    };
  }

  async search(slug: string, opts: { q: string; kind?: FileKind; limit: number }): Promise<SearchHit[]> {
    await this.store.requireProject(slug);
    return this.index.search({ ...opts, project: slug });
  }

  // ---- rendering ----------------------------------------------------------------------------

  private async withRenderFile<T>(slug: string, path: string, at: string | undefined, params: RenderBody["params"], work: (req: MeshRequest) => Promise<T>): Promise<T> {
    await this.store.requireProject(slug);
    const kind = kindFromExtension(path);
    if (kind !== "scad" && kind !== "mesh") throw invalid(`${path} is not a .scad or mesh file`);

    const libraryDir = this.store.projectDir(LIBRARY_SLUG);
    let root = this.store.projectDir(slug);
    let cleanup: (() => Promise<void>) | null = null;
    if (at !== undefined) {
      const tree = await this.store.materialise(slug, at);
      root = tree.root;
      cleanup = tree.cleanup;
    }
    try {
      const st = at === undefined ? await this.store.stat(slug, path) : await lstatOrNull(join(root, path));
      if (st?.type !== "file") throw notFound(`no such file${at ? ` at revision ${at}` : ""}: ${path}`);
      return await work({ file: join(root, path), searchPaths: root === libraryDir ? [root] : [root, libraryDir], ...(params ? { params } : {}) });
    } catch (err) {
      if (err instanceof RenderError) throw new ApiException("render_failed", err.message.replaceAll(`${root}/`, "").replaceAll(`${libraryDir}/`, `${LIBRARY_SLUG}/`));
      throw err;
    } finally {
      await cleanup?.();
    }
  }

  async mesh(slug: string, path: string, at?: string, params?: RenderBody["params"]): Promise<MeshOutput> {
    return this.withRenderFile(slug, path, at, params, (req) => this.renderer.mesh(req));
  }

  async render(slug: string, path: string, body: RenderBody): Promise<RenderResult> {
    const views = body.views && body.views.length > 0 ? [...new Set(body.views)] : ALL_VIEWS;
    const size = body.size ?? DEFAULT_RENDER_SIZE;
    const at = body.at ?? null;
    let total = views.length + 3;
    return this.withRenderFile(slug, path, body.at, body.params, async (req) => {
      try {
        const out = await this.renderer.render({
          ...req,
          views,
          size,
          onProgress: (p) => {
            total = p.total;
            this.bus.emit({ type: "render_progress", project: slug, path, at, ...p });
          },
        });
        const base = `/api/renders/${out.key}`;
        const result: RenderResult = {
          project: slug,
          path,
          key: out.key,
          cached: out.cached,
          seconds: out.seconds,
          mesh: `/api/renders/${out.meshKey}/mesh.stl`,
          views: Object.fromEntries(out.views.map((v) => [v, `${base}/${v}.png`])),
          sheet: `${base}/sheet.png`,
          info: out.info,
          log: out.log,
          warnings: out.warnings,
        };
        this.bus.emit({ type: "render_progress", project: slug, path, at, stage: "done", step: total, total, view: null });
        this.bus.emit({ type: "render", project: slug, path, key: out.key });
        return result;
      } catch (err) {
        this.bus.emit({ type: "render_progress", project: slug, path, at, stage: "failed", step: 0, total, view: null });
        throw err;
      }
    });
  }

  // ---- overview ----------------------------------------------------------------------------

  async overview(slug: string): Promise<ProjectOverview> {
    return this.parts.overview(await this.getProject(slug));
  }

  // ---- importing ----------------------------------------------------------------------------

  async previewImport(url: string): Promise<ImportPreview> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid("url is not a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid("url must be http or https");
    try {
      return await this.importers.preview(url);
    } catch (err) {
      throw err instanceof ImportError ? new ApiException("import_failed", err.message) : importFailed(err);
    }
  }

  async importProject(slug: string, body: ImportBody): Promise<ImportResult> {
    await this.store.requireProject(slug);
    const preview = await this.previewImport(body.url);
    return this.importInto(slug, body, preview);
  }

  private async importInto(slug: string, body: ImportBody, preview: ImportPreview): Promise<ImportResult> {
    const { source } = preview;
    const name = slugify(body.name ?? source.title, "import");
    const dir = `refs/${name}`;
    if ((await this.store.stat(slug, dir)) !== null) throw exists(`${dir} already exists: pick another name`);

    const staging = join(this.store.tmpDir, `import-${randomId()}`);
    const stageDir = join(staging, name);
    const skipped: ImportResult["skipped"] = [];
    const written: string[] = [];
    try {
      await mkdir(stageDir, { recursive: true });
      const used = new Set<string>(["source.md", "images"]);
      const wanted = body.fileIds === undefined ? null : new Set(body.fileIds);
      for (const id of wanted ?? []) {
        if (!preview.files.some((f) => f.id === id)) skipped.push({ name: id, reason: "not offered by the site" });
      }
      for (const file of preview.files) {
        if (wanted !== null && !wanted.has(file.id)) continue;
        if (!file.downloadable) {
          skipped.push({ name: file.name, reason: "the site does not allow downloading this file; upload it by hand" });
          continue;
        }
        const fileName = uniqueName(safeFileName(file.name), used);
        try {
          await this.importers.download(body.url, file, join(stageDir, fileName));
          written.push(`${dir}/${fileName}`);
        } catch (err) {
          skipped.push({ name: file.name, reason: errorMessage(err) });
        }
      }
      const images = source.images.slice(0, MAX_IMPORT_IMAGES);
      for (const [i, imageUrl] of images.entries()) {
        const fileName = `image-${i + 1}${imageExtension(imageUrl)}`;
        try {
          await mkdir(join(stageDir, "images"), { recursive: true });
          await this.importers.downloadImage(imageUrl, join(stageDir, "images", fileName));
          written.push(`${dir}/images/${fileName}`);
        } catch (err) {
          skipped.push({ name: imageUrl, reason: errorMessage(err) });
        }
      }
      await writeFile(join(stageDir, "source.md"), sourceMarkdown(source));
      written.push(`${dir}/source.md`);

      return await this.lock.run(async () => {
        await this.store.requireProject(slug);
        if ((await this.store.stat(slug, dir)) !== null) throw exists(`${dir} already exists: pick another name`);
        await mkdir(join(this.store.projectDir(slug), "refs"), { recursive: true });
        await rename(stageDir, this.store.abs(slug, dir));
        const { commit, revisionId } = await this.store.commitWorkTree(slug, "import", `import ${source.title}`);
        await this.indexChange(slug, { commit, revisionId, upserts: written, removes: [] }, "import");
        this.parts.changed(slug, written, []);
        for (const path of written) this.emitFile("written", slug, path, this.index.fileRow(slug, path)?.rev ?? null, "import");
        return { project: slug, dir, written, skipped, revisionId };
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
