import { Database } from "bun:sqlite";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { Fact, FileKind, Link, MeshInfo, PartSpec, ReportStatus, SearchHit } from "@drawer/shared/api";
import type { Renderer } from "@drawer/shared/contracts";
import { errorMessage, isNodeError, revOfFile } from "../util.ts";
import { PART_DIR, PART_SPEC_SUFFIX } from "@drawer/shared/api";
import { TEXT_SNIFF_LIMIT, kindFromExtension, looksLikeText, normalizePath } from "../store/paths.ts";
import { parseMarkdown } from "./markdown.ts";
import { parseScad } from "./scad.ts";
import { buildContext, resolveLink, type ResolveContext } from "./resolve.ts";
import { SCHEMA, SCHEMA_VERSION } from "./schema.ts";

/** Largest markdown/scad/text file whose content is parsed and full-text indexed. */
const MAX_INDEXED_TEXT = 2 * 1024 * 1024;

function specLinks(text: string): { relation: string; target: string }[] {
  try {
    const spec = JSON.parse(text) as Partial<PartSpec>;
    const links: { relation: string; target: string }[] = [];
    if (spec.source === "scanned" && typeof spec.scan?.file === "string") {
      const target = normalizePath(spec.scan.file);
      if (kindFromExtension(target) === "mesh") links.push({ relation: "scans", target });
    }
    if (Array.isArray(spec.matches)) {
      for (const match of spec.matches) {
        if (typeof match?.to === "string" && /^[a-z0-9][a-z0-9-]*$/.test(match.to)) {
          links.push({ relation: "matches", target: `${PART_DIR}/${match.to}${PART_SPEC_SUFFIX}` });
        }
      }
    }
    return links;
  } catch {
    return [];
  }
}

export interface FileRow {
  id: number;
  project: string;
  path: string;
  kind: FileKind;
  size: number;
  mtime_ms: number;
  rev: string;
  updated_at: string;
  updated_by: string;
  title: string;
  mesh: string | null;
  outline: string;
}

export interface UpsertSpec {
  path: string;
  updatedAt: string;
  updatedBy: string;
}

interface RawLink {
  relation: string;
  target: string;
}

interface Prepared {
  spec: UpsertSpec;
  kind: FileKind;
  size: number;
  mtimeMs: number;
  rev: string;
  title: string;
  mesh: MeshInfo | null;
  outline: string[];
  body: string;
  facts: { category: string; text: string; line: number }[];
  links: RawLink[];
}

interface LinkRow {
  id: number;
  project: string;
  from_path: string;
  relation: string;
  target: string;
  to_project: string | null;
  to_path: string | null;
}

/** The latest evaluation of a part's current state. `state` fingerprints the files it was made from. */
export interface PartStatusRow {
  state: string;
  status: ReportStatus;
  passed: number;
  total: number;
  failing: string[];
  reportKey: string;
}

/** An evaluation of one model content (by rev), for the attempt tree. */
export interface PartEvalRow {
  reportKey: string;
  status: ReportStatus;
  passed: number;
  total: number;
}

export interface AssemblyStatusRow {
  state: string;
  status: ReportStatus;
  reportKey: string;
}

export interface SearchOptions {
  q: string;
  project: string;
  kind?: FileKind;
  limit: number;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function meshText(name: string, mesh: MeshInfo | null): string {
  if (!mesh) return name;
  const [x, y, z] = mesh.bbox.size;
  const volume = mesh.volumeCm3 === null ? "" : ` volume ${mesh.volumeCm3} cm3`;
  return `${name} ${mesh.format} mesh ${mesh.triangles} triangles size ${x} x ${y} x ${z} mm${volume}`;
}

/** Plain words to an FTS5 query: every word quoted, the last one a prefix. */
export function ftsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}]+/gu);
  if (!words || words.length === 0) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

export class Index {
  private readonly db: Database;
  /** True when the database was empty or from another schema version: the caller must reindex. */
  readonly needsRebuild: boolean;

  constructor(
    dbPath: string,
    private readonly projectsDir: string,
    private readonly renderer: Pick<Renderer, "meshInfo">,
  ) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    this.needsRebuild = version !== SCHEMA_VERSION;
    if (this.needsRebuild) {
      this.db.transaction(() => {
        for (const table of ["fts", "tags", "project_tags", "facts", "links", "files", "projects", "part_status", "part_evals", "assembly_status"]) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- writing ------------------------------------------------------------------------------

  async apply(project: string, upserts: UpsertSpec[], removes: string[]): Promise<void> {
    const prepared: Prepared[] = [];
    const vanished: string[] = [];
    for (const spec of upserts) {
      const p = await this.prepare(project, spec);
      if (p) prepared.push(p);
      else vanished.push(spec.path);
    }
    this.db.transaction(() => {
      let setChanged = false;
      for (const path of [...removes, ...vanished]) if (this.deleteFile(project, path)) setChanged = true;
      for (const p of prepared) {
        if (!this.deleteFile(project, p.spec.path)) setChanged = true;
        this.insertFile(project, p);
      }
      if (setChanged) this.resolveAll();
      else this.resolveFiles(project, prepared.map((p) => p.spec.path));
    })();
  }

  removeProject(project: string): void {
    this.db.transaction(() => {
      const ids = this.db.query<{ id: number }, [string]>("SELECT id FROM files WHERE project = ?").all(project);
      const del = this.db.query<unknown, [number]>("DELETE FROM fts WHERE rowid = ?");
      for (const { id } of ids) del.run(id);
      for (const table of ["files", "facts", "links", "part_status", "part_evals", "assembly_status"]) this.db.query<unknown, [string]>(`DELETE FROM ${table} WHERE project = ?`).run(project);
      this.db.query<unknown, [string]>("DELETE FROM projects WHERE slug = ?").run(project);
      this.resolveAll();
    })();
  }

  clear(): void {
    this.db.transaction(() => {
      for (const table of ["fts", "facts", "links", "files", "projects"]) this.db.exec(`DELETE FROM ${table}`);
    })();
  }

  touchProject(project: string, at: string, by: string): void {
    this.db
      .query<unknown, [string, string, string]>("INSERT INTO projects (slug, updated_at, updated_by) VALUES (?1, ?2, ?3) ON CONFLICT(slug) DO UPDATE SET updated_at = ?2, updated_by = ?3")
      .run(project, at, by);
  }

  private async prepare(project: string, spec: UpsertSpec): Promise<Prepared | null> {
    const abs = join(this.projectsDir, project, spec.path);
    let st;
    try {
      st = await stat(abs);
    } catch (err) {
      if (isNodeError(err, "ENOENT", "ENOTDIR")) return null;
      throw err;
    }
    if (!st.isFile()) return null;
    const name = basename(spec.path);
    let kind = kindFromExtension(spec.path);
    if (kind === null) {
      kind = st.size <= TEXT_SNIFF_LIMIT && looksLikeText(await Bun.file(abs).bytes()) ? "text" : "binary";
    }
    const out: Prepared = {
      spec,
      kind,
      size: st.size,
      mtimeMs: st.mtimeMs,
      rev: await revOfFile(abs),
      title: name,
      mesh: null,
      outline: [],
      body: "",
      facts: [],
      links: [],
    };
    const limit = kind === "text" ? TEXT_SNIFF_LIMIT : MAX_INDEXED_TEXT;
    if ((kind === "markdown" || kind === "scad" || kind === "text") && st.size <= limit) {
      const text = await Bun.file(abs).text();
      if (kind === "markdown") {
        const md = parseMarkdown(text);
        out.title = md.title ?? name;
        out.body = md.body;
        out.facts = md.facts;
        out.links = md.links.map((l) => ({ relation: l.relation, target: l.target }));
      } else if (kind === "scad") {
        const scad = parseScad(text);
        out.body = text;
        out.outline = scad.outline;
        out.links = scad.links;
      } else {
        out.body = text;
        if (spec.path.endsWith(PART_SPEC_SUFFIX)) out.links = specLinks(text);
      }
    } else if (kind === "mesh") {
      try {
        out.mesh = await this.renderer.meshInfo(abs);
      } catch (err) {
        console.warn(`mesh info failed for ${project}/${spec.path}: ${errorMessage(err)}`);
      }
      out.body = meshText(name, out.mesh);
    }
    return out;
  }

  /** Removes every row of one file; false when it was not indexed. */
  private deleteFile(project: string, path: string): boolean {
    const row = this.db.query<{ id: number }, [string, string]>("SELECT id FROM files WHERE project = ? AND path = ?").get(project, path);
    if (!row) return false;
    this.db.query<unknown, [number]>("DELETE FROM fts WHERE rowid = ?").run(row.id);
    this.db.query<unknown, [number]>("DELETE FROM files WHERE id = ?").run(row.id);
    this.db.query<unknown, [string, string]>("DELETE FROM facts WHERE project = ? AND path = ?").run(project, path);
    this.db.query<unknown, [string, string]>("DELETE FROM links WHERE project = ? AND from_path = ?").run(project, path);
    return true;
  }

  private insertFile(project: string, p: Prepared): void {
    const { lastInsertRowid } = this.db
      .query<unknown, [string, string, string, number, number, string, string, string, string, string | null, string]>(
        "INSERT INTO files (project, path, kind, size, mtime_ms, rev, updated_at, updated_by, title, mesh, outline) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(project, p.spec.path, p.kind, p.size, p.mtimeMs, p.rev, p.spec.updatedAt, p.spec.updatedBy, p.title, p.mesh ? JSON.stringify(p.mesh) : null, JSON.stringify(p.outline));
    this.db.query<unknown, [number | bigint, string, string, string]>("INSERT INTO fts (rowid, path, title, body) VALUES (?, ?, ?, ?)").run(lastInsertRowid, p.spec.path, p.title, p.body);
    const fact = this.db.query<unknown, [string, string, number, string, string]>("INSERT INTO facts (project, path, line, category, text) VALUES (?,?,?,?,?)");
    for (const f of p.facts) fact.run(project, p.spec.path, f.line, f.category, f.text);
    const link = this.db.query<unknown, [string, string, string, string]>("INSERT INTO links (project, from_path, relation, target) VALUES (?,?,?,?)");
    for (const l of p.links) link.run(project, p.spec.path, l.relation, l.target);
  }

  // ---- link resolution ----------------------------------------------------------------------

  private context(): ResolveContext {
    return buildContext(this.db.query<{ project: string; path: string }, []>("SELECT project, path FROM files").all());
  }

  private resolveRows(rows: LinkRow[], ctx: ResolveContext): void {
    const update = this.db.query<unknown, [string | null, string | null, number]>("UPDATE links SET to_project = ?, to_path = ? WHERE id = ?");
    for (const row of rows) {
      const to = resolveLink(ctx, row.project, row.from_path, row.relation, row.target);
      const toProject = to?.project ?? null;
      const toPath = to?.path ?? null;
      if (toProject !== row.to_project || toPath !== row.to_path) update.run(toProject, toPath, row.id);
    }
  }

  /** The set of files changed: any link in any project may now resolve differently. */
  private resolveAll(): void {
    this.resolveRows(this.db.query<LinkRow, []>("SELECT * FROM links").all(), this.context());
  }

  /** Only the files' own links changed (same file set). */
  private resolveFiles(project: string, paths: string[]): void {
    const rows: LinkRow[] = [];
    const sel = this.db.query<LinkRow, [string, string]>("SELECT * FROM links WHERE project = ? AND from_path = ?");
    for (const path of paths) rows.push(...sel.all(project, path));
    if (rows.length > 0) this.resolveRows(rows, this.context());
  }

  // ---- part and assembly status --------------------------------------------------------------
  // Derived like the rest: the reports they point at live in the report cache, and a lost row only
  // means the part is evaluated again (a cache hit when nothing changed).

  setPartStatus(project: string, part: string, row: PartStatusRow): void {
    this.db
      .query<unknown, [string, string, string, string, number, number, string, string]>(
        "INSERT OR REPLACE INTO part_status (project, part, state, status, passed, total, failing, report_key) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(project, part, row.state, row.status, row.passed, row.total, JSON.stringify(row.failing), row.reportKey);
  }

  partStatus(project: string, part: string): PartStatusRow | null {
    const row = this.db
      .query<{ state: string; status: ReportStatus; passed: number; total: number; failing: string; report_key: string }, [string, string]>("SELECT * FROM part_status WHERE project = ? AND part = ?")
      .get(project, part);
    return row ? { state: row.state, status: row.status, passed: row.passed, total: row.total, failing: JSON.parse(row.failing) as string[], reportKey: row.report_key } : null;
  }

  removePartStatus(project: string, part: string): void {
    this.db.query<unknown, [string, string]>("DELETE FROM part_status WHERE project = ? AND part = ?").run(project, part);
  }

  /** An evaluation of one model content in one context (spec, profile, material, renderer): see PartsService.evalContext. */
  recordPartEval(project: string, part: string, modelRev: string, context: string, row: PartEvalRow, at: string): void {
    this.db
      .query<unknown, [string, string, string, string, string, string, number, number, string]>(
        "INSERT OR REPLACE INTO part_evals (project, part, model_rev, context, report_key, status, passed, total, evaluated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(project, part, modelRev, context, row.reportKey, row.status, row.passed, row.total, at);
  }

  partEval(project: string, part: string, modelRev: string, context: string): PartEvalRow | null {
    const row = this.db
      .query<{ report_key: string; status: ReportStatus; passed: number; total: number }, [string, string, string, string]>("SELECT * FROM part_evals WHERE project = ? AND part = ? AND model_rev = ? AND context = ?")
      .get(project, part, modelRev, context);
    return row ? { reportKey: row.report_key, status: row.status, passed: row.passed, total: row.total } : null;
  }

  setAssemblyStatus(project: string, row: AssemblyStatusRow | null): void {
    if (row === null) this.db.query<unknown, [string]>("DELETE FROM assembly_status WHERE project = ?").run(project);
    else this.db.query<unknown, [string, string, string, string]>("INSERT OR REPLACE INTO assembly_status (project, state, status, report_key) VALUES (?,?,?,?)").run(project, row.state, row.status, row.reportKey);
  }

  assemblyStatus(project: string): AssemblyStatusRow | null {
    const row = this.db.query<{ state: string; status: ReportStatus; report_key: string }, [string]>("SELECT * FROM assembly_status WHERE project = ?").get(project);
    return row ? { state: row.state, status: row.status, reportKey: row.report_key } : null;
  }

  // ---- reading ------------------------------------------------------------------------------

  fileRow(project: string, path: string): FileRow | null {
    return this.db.query<FileRow, [string, string]>("SELECT * FROM files WHERE project = ? AND path = ?").get(project, path);
  }

  fileRows(project: string): FileRow[] {
    return this.db.query<FileRow, [string]>("SELECT * FROM files WHERE project = ? ORDER BY path").all(project);
  }

  countFiles(project: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM files WHERE project = ?").get(project)?.n ?? 0;
  }

  /** The default cover: the first cover candidate. */
  defaultCover(project: string): string | null {
    return this.coverCandidates(project)[0] ?? null;
  }

  /** Files worth trying as a cover, best first: part models (parts/*.scad), then other .scad files (shallowest first, so helpers in subfolders come last), then meshes. */
  coverCandidates(project: string): string[] {
    const depth = "(length(path) - length(replace(path, '/', '')))";
    const isPart = "(substr(path, 1, 6) = 'parts/' AND " + depth + " = 1)";
    const scad = this.db
      .query<{ path: string }, [string]>(`SELECT path FROM files WHERE project = ? AND kind = 'scad' ORDER BY ${isPart} DESC, ${depth}, path LIMIT 4`)
      .all(project);
    const mesh = this.db.query<{ path: string }, [string]>(`SELECT path FROM files WHERE project = ? AND kind = 'mesh' ORDER BY ${depth}, path LIMIT 2`).all(project);
    return [...scad, ...mesh].map((r) => r.path);
  }

  /** Every project the index holds rows for. */
  projectSlugs(): string[] {
    return this.db
      .query<{ slug: string }, []>("SELECT project AS slug FROM files UNION SELECT slug FROM projects")
      .all()
      .map((r) => r.slug);
  }

  projectStamp(project: string): { updatedAt: string; updatedBy: string } | null {
    const row = this.db.query<{ updated_at: string; updated_by: string }, [string]>("SELECT updated_at, updated_by FROM projects WHERE slug = ?").get(project);
    return row ? { updatedAt: row.updated_at, updatedBy: row.updated_by } : null;
  }

  private toLink(row: LinkRow): Link {
    return { from: row.from_path, fromProject: row.project, relation: row.relation, target: row.target, to: row.to_path, toProject: row.to_project };
  }

  outgoing(project: string, path: string): Link[] {
    return this.db.query<LinkRow, [string, string]>("SELECT * FROM links WHERE project = ? AND from_path = ? ORDER BY id").all(project, path).map((r) => this.toLink(r));
  }

  incoming(project: string, path: string): Link[] {
    return this.db.query<LinkRow, [string, string]>("SELECT * FROM links WHERE to_project = ? AND to_path = ? ORDER BY project, from_path, id").all(project, path).map((r) => this.toLink(r));
  }

  /** Spec links name exact project paths. Keep the dependency when the target is temporarily absent. */
  specDependents(project: string, path: string): Link[] {
    return this.db.query<LinkRow, [string, string]>(
      "SELECT * FROM links WHERE project = ? AND target = ? AND relation IN ('scans', 'matches') ORDER BY from_path, id",
    ).all(project, path).map((row) => this.toLink(row));
  }

  facts(project: string, path: string): Fact[] {
    return this.db
      .query<{ category: string; text: string; line: number }, [string, string]>("SELECT category, text, line FROM facts WHERE project = ? AND path = ? ORDER BY line, rowid")
      .all(project, path)
      .map((r) => ({ category: r.category, text: r.text, path, line: r.line }));
  }

  search(opts: SearchOptions): SearchHit[] {
    const match = ftsQuery(opts.q);
    if (match === null) return [];
    const where = ["fts MATCH ?", "f.project = ?"];
    const params: (string | number)[] = [match, opts.project];
    if (opts.kind) {
      where.push("f.kind = ?");
      params.push(opts.kind);
    }
    params.push(opts.limit);
    const rows = this.db
      .query<{ path: string; kind: FileKind; title: string; snippet: string; score: number }, (string | number)[]>(
        `SELECT f.path AS path, f.kind AS kind, f.title AS title,
                snippet(fts, -1, '«', '»', '…', 14) AS snippet, -bm25(fts, 4.0, 6.0, 1.0) AS score
         FROM fts JOIN files f ON f.id = fts.rowid
         WHERE ${where.join(" AND ")}
         ORDER BY bm25(fts, 4.0, 6.0, 1.0), f.path
         LIMIT ?`,
      )
      .all(...params);
    return rows.map((r) => ({ ...r, snippet: r.snippet.replace(/\s+/g, " ").trim() }));
  }

}
