import { mkdir, readdir, lstat, rename, rm, rmdir, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { ImportSource, ProjectDefaults, Revision } from "@drawer/shared/api";
import { ApiException, conflict, exists, invalid, notFound } from "../errors.ts";
import { isNodeError, randomId, revOfBytes, revOfFile } from "../util.ts";
import { Git, type CommitInfo } from "./git.ts";
import { isHiddenName, kindFromExtension, isValidSlug } from "./paths.ts";
import type { StarterFile } from "./starter.ts";

export interface ProjectMeta {
  title: string;
  description: string;
  cover: string | null;
  source: ImportSource | null;
  createdAt: string;
  /** What was set; the service fills the rest from the library (a project.json without it reads as {}). */
  defaults: Partial<ProjectDefaults>;
}

export interface WalkEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
  mtimeMs?: number;
}

/** What a mutation did: the commit, and which file paths the index has to revisit. */
export interface Change {
  /** Null when the work tree already matched HEAD (nothing was committed). */
  commit: CommitInfo | null;
  /** Id of the commit that now holds the change (HEAD when nothing was committed). */
  revisionId: string;
  upserts: string[];
  removes: string[];
}

export interface WriteOptions {
  rev: string | undefined;
  author: string;
  message: string | undefined;
  /** Runs after the rev check and before anything is written; throws to refuse the bytes. */
  validate?: (bytes: Uint8Array) => Promise<void>;
}

const MAX_UPLOAD = 200 * 1024 * 1024;

/**
 * Files and revisions of every project under `<dataDir>/projects`. No index knowledge. Callers
 * serialise mutations (the service holds one lock around store + index work).
 */
export class Store {
  readonly projectsDir: string;
  readonly trashDir: string;
  readonly tmpDir: string;
  readonly renderCacheDir: string;
  readonly meshCacheDir: string;
  readonly reportCacheDir: string;
  readonly thumbnailDir: string;
  readonly git: Git;

  constructor(readonly dataDir: string) {
    this.projectsDir = join(dataDir, "projects");
    this.trashDir = join(dataDir, "trash");
    this.tmpDir = join(dataDir, "tmp");
    this.renderCacheDir = join(dataDir, "cache", "renders");
    this.meshCacheDir = join(dataDir, "cache", "meshes");
    this.reportCacheDir = join(dataDir, "cache", "reports");
    this.thumbnailDir = join(dataDir, "cache", "thumbnails");
    this.git = new Git(this.projectsDir);
  }

  async init(): Promise<void> {
    await Promise.all([this.projectsDir, this.trashDir, this.renderCacheDir, this.meshCacheDir, this.reportCacheDir, this.thumbnailDir].map((dir) => mkdir(dir, { recursive: true })));
    // Leftovers of an interrupted write, import or render are garbage by definition.
    await rm(this.tmpDir, { recursive: true, force: true });
    await mkdir(this.tmpDir, { recursive: true });
  }

  projectDir(slug: string): string {
    if (!isValidSlug(slug)) throw notFound(`no such project: ${slug}`);
    return join(this.projectsDir, slug);
  }

  /** Absolute path of a normalised project-relative path. */
  abs(slug: string, path: string): string {
    return join(this.projectDir(slug), path);
  }

  async has(slug: string): Promise<boolean> {
    if (!isValidSlug(slug)) return false;
    try {
      return (await stat(join(this.projectsDir, slug, ".git"))).isDirectory();
    } catch {
      return false;
    }
  }

  async requireProject(slug: string): Promise<void> {
    if (!(await this.has(slug))) throw notFound(`no such project: ${slug}`);
  }

  async slugs(): Promise<string[]> {
    const entries = await readdir(this.projectsDir, { withFileTypes: true });
    const slugs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && isValidSlug(entry.name) && (await this.has(entry.name))) slugs.push(entry.name);
    }
    return slugs.sort();
  }

  async readMeta(slug: string): Promise<ProjectMeta> {
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readFile(join(this.projectDir(slug), "project.json"), "utf8"));
    } catch (err) {
      if (!isNodeError(err, "ENOENT") && !(err instanceof SyntaxError)) throw err;
    }
    const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const str = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
    return {
      title: str(obj.title, slug),
      description: str(obj.description, ""),
      cover: typeof obj.cover === "string" ? obj.cover : null,
      source: typeof obj.source === "object" && obj.source !== null ? (obj.source as ImportSource) : null,
      createdAt: str(obj.createdAt, new Date(0).toISOString()),
      defaults: typeof obj.defaults === "object" && obj.defaults !== null ? (obj.defaults as Partial<ProjectDefaults>) : {},
    };
  }

  async writeMeta(slug: string, meta: ProjectMeta): Promise<void> {
    const target = join(this.projectDir(slug), "project.json");
    const tmp = join(this.tmpDir, `meta-${randomId()}`);
    await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`);
    await rename(tmp, target);
  }

  /** Creates the folder, repo, metadata and starter files in one commit. */
  async createProject(slug: string, meta: ProjectMeta, files: StarterFile[], author: string): Promise<Change> {
    const dir = this.projectDir(slug);
    if (await this.has(slug)) throw exists(`project already exists: ${slug}`);
    try {
      await mkdir(dir);
    } catch (err) {
      if (isNodeError(err, "EEXIST")) throw exists(`project folder already exists: ${slug}`);
      throw err;
    }
    await this.git.init(dir);
    await this.writeMeta(slug, meta);
    for (const file of files) {
      const abs = join(dir, file.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content);
    }
    const commit = await this.git.commitAll(dir, author, "create project");
    const revisionId = commit?.id ?? (await this.git.head(dir)) ?? "";
    const upserts = (await this.walk(slug)).filter((e) => e.type === "file").map((e) => e.path);
    return { commit, revisionId, upserts, removes: [] };
  }

  /** Moves the project folder to `<data>/trash/<slug>-<timestamp>`. */
  async trash(slug: string): Promise<string> {
    await this.requireProject(slug);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const target = join(this.trashDir, `${slug}-${stamp}`);
    await rename(this.projectDir(slug), target);
    return target;
  }

  /** Every non-hidden entry below `sub` (default: the project root), depth-first, directories first. */
  async walk(slug: string, sub = ""): Promise<WalkEntry[]> {
    const root = join(this.projectDir(slug), sub);
    const out: WalkEntry[] = [];
    const visit = async (abs: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch (err) {
        if (isNodeError(err, "ENOENT", "ENOTDIR")) return;
        throw err;
      }
      const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const visible = entries.filter((e) => !isHiddenName(e.name) && !(rel === "" && e.name === "project.json") && !e.isSymbolicLink());
      for (const dir of visible.filter((e) => e.isDirectory()).sort(byName)) {
        const path = rel === "" ? dir.name : `${rel}/${dir.name}`;
        out.push({ path, type: "dir" });
        await visit(join(abs, dir.name), path);
      }
      const files = visible.filter((e) => e.isFile()).sort(byName);
      const stats = await Promise.all(files.map((f) => lstat(join(abs, f.name))));
      files.forEach((file, i) => {
        const st = stats[i];
        if (st) out.push({ path: rel === "" ? file.name : `${rel}/${file.name}`, type: "file", size: st.size, mtimeMs: st.mtimeMs });
      });
    };
    await visit(root, sub);
    return out;
  }

  async stat(slug: string, path: string): Promise<{ type: "file" | "dir"; size: number; mtimeMs: number } | null> {
    try {
      const st = await lstat(this.abs(slug, path));
      if (st.isSymbolicLink()) return null;
      return { type: st.isDirectory() ? "dir" : "file", size: st.size, mtimeMs: st.mtimeMs };
    } catch (err) {
      if (isNodeError(err, "ENOENT", "ENOTDIR")) return null;
      throw err;
    }
  }

  async currentRev(slug: string, path: string): Promise<string | null> {
    const st = await this.stat(slug, path);
    return st?.type === "file" ? revOfFile(this.abs(slug, path)) : null;
  }

  async readBytes(slug: string, path: string): Promise<Uint8Array> {
    const st = await this.stat(slug, path);
    if (st?.type !== "file") throw notFound(`no such file: ${path}`);
    return Bun.file(this.abs(slug, path)).bytes();
  }

  async readAt(slug: string, path: string, revision: string): Promise<Uint8Array> {
    this.requireRevisionId(revision);
    const bytes = await this.git.show(this.projectDir(slug), revision, path);
    if (bytes === null) throw notFound(`no such file at revision ${revision}: ${path}`);
    return bytes;
  }

  requireRevisionId(revision: string): void {
    if (!/^[0-9a-f]{7,40}$/.test(revision)) throw invalid("revision ids are 7 to 40 hex characters");
  }

  async history(slug: string, path: string, limit: number): Promise<Revision[]> {
    return this.git.log(this.projectDir(slug), { path: path === "" ? undefined : path, limit });
  }

  /** Writes the tree of `revision` under a fresh temp dir; the caller removes `root`. */
  async materialise(slug: string, revision: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
    this.requireRevisionId(revision);
    const dir = this.projectDir(slug);
    if (!(await this.git.revisionExists(dir, revision))) throw notFound(`unknown revision: ${revision}`);
    const base = join(this.tmpDir, `rev-${randomId()}`);
    const root = join(base, "tree");
    await mkdir(root, { recursive: true });
    const cleanup = (): Promise<void> => rm(base, { recursive: true, force: true });
    try {
      await this.git.checkoutTree(dir, revision, root, join(base, "index"));
    } catch (err) {
      await cleanup();
      throw err;
    }
    return { root, cleanup };
  }

  private async ensureParents(slug: string, path: string): Promise<void> {
    try {
      await mkdir(dirname(this.abs(slug, path)), { recursive: true });
    } catch (err) {
      if (isNodeError(err, "ENOTDIR", "EEXIST")) throw invalid(`a parent of ${path} is a file`);
      throw err;
    }
  }

  private async commit(slug: string, author: string, message: string): Promise<{ commit: CommitInfo | null; revisionId: string }> {
    const dir = this.projectDir(slug);
    const commit = await this.git.commitAll(dir, author, message);
    return { commit, revisionId: commit?.id ?? (await this.git.head(dir)) ?? "" };
  }

  private async pruneEmptyParents(slug: string, path: string): Promise<void> {
    let dir = posix.dirname(path);
    while (dir !== "." && dir !== "") {
      try {
        await rmdir(this.abs(slug, dir));
      } catch {
        return; // not empty (or gone): stop
      }
      dir = posix.dirname(dir);
    }
  }

  private checkRev(given: string | undefined, current: string, path: string): void {
    if (given === undefined) throw conflict(`${path} exists: send x-drawer-rev with its current rev (${current})`, current);
    if (given !== "*" && given !== current) throw conflict(`${path} changed: rev is ${current}, not ${given}`, current);
  }

  async write(slug: string, path: string, bytes: Uint8Array, opts: WriteOptions): Promise<Change & { created: boolean; rev: string }> {
    if (bytes.length > MAX_UPLOAD) throw invalid("upload exceeds the 200 MB limit");
    const st = await this.stat(slug, path);
    if (st?.type === "dir") throw invalid(`${path} is a directory`);
    if (st) {
      this.checkRev(opts.rev, await revOfFile(this.abs(slug, path)), path);
    } else if (opts.rev !== undefined && opts.rev !== "*") {
      throw notFound(`${path} does not exist, but x-drawer-rev was sent`);
    }
    await opts.validate?.(bytes);
    await this.ensureParents(slug, path);
    const tmp = join(this.tmpDir, `write-${randomId()}`);
    try {
      await Bun.write(tmp, bytes);
      await rename(tmp, this.abs(slug, path));
    } catch (err) {
      await rm(tmp, { force: true });
      if (isNodeError(err, "EISDIR", "ENOTDIR")) throw invalid(`cannot write ${path}`);
      throw err;
    }
    const created = st === null;
    const message = opts.message?.trim() || `${created ? "create" : "update"} ${path}`;
    const { commit, revisionId } = await this.commit(slug, opts.author, message);
    return { commit, revisionId, upserts: [path], removes: [], created, rev: revOfBytes(bytes) };
  }

  /** Replace-in-file with Claude Code Edit semantics. The rev guard comes first. */
  async edit(
    slug: string,
    path: string,
    opts: { rev: string; old: string; new: string; replaceAll: boolean; author: string; message: string | undefined; validate?: (bytes: Uint8Array) => Promise<void> },
  ): Promise<Change & { rev: string }> {
    const st = await this.stat(slug, path);
    if (st === null) throw notFound(`no such file: ${path}`);
    if (st.type === "dir") throw invalid(`${path} is a directory`);
    this.checkRev(opts.rev, await revOfFile(this.abs(slug, path)), path);
    const kind = kindFromExtension(path);
    if (kind === "mesh" || kind === "image" || kind === "pdf") throw invalid(`${path} is not a text file`);
    if (opts.old === "") throw invalid("old must not be empty");
    if (opts.old === opts.new) throw invalid("old and new are identical");
    const bytes = await Bun.file(this.abs(slug, path)).bytes();
    let text: string;
    try {
      if (bytes.includes(0)) throw new Error("NUL byte");
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalid(`${path} is not a text file`);
    }
    const parts = text.split(opts.old);
    const count = parts.length - 1;
    if (count === 0) throw new ApiException("edit_no_match", `old string not found in ${path}`);
    if (count > 1 && !opts.replaceAll) {
      throw new ApiException("edit_no_match", `old string found ${count} times in ${path}; add context to make it unique, or set replaceAll`);
    }
    return this.write(slug, path, new TextEncoder().encode(parts.join(opts.new)), {
      rev: "*",
      author: opts.author,
      message: opts.message ?? `edit ${path}`,
      ...(opts.validate ? { validate: opts.validate } : {}),
    });
  }

  /** Deletes a file (rev required) or a directory (`recursive`, no rev). */
  async remove(
    slug: string,
    path: string,
    opts: { rev: string | undefined; recursive: boolean; author: string; message: string | undefined },
  ): Promise<Change> {
    const st = await this.stat(slug, path);
    if (st === null) throw notFound(`no such file or directory: ${path}`);
    let removes: string[];
    if (st.type === "dir") {
      if (!opts.recursive) throw invalid(`${path} is a directory: pass ?recursive=1 to delete it`);
      removes = (await this.walk(slug, path)).filter((e) => e.type === "file").map((e) => e.path);
      await rm(this.abs(slug, path), { recursive: true, force: true });
    } else {
      this.checkRev(opts.rev, await revOfFile(this.abs(slug, path)), path);
      removes = [path];
      await rm(this.abs(slug, path));
    }
    await this.pruneEmptyParents(slug, path);
    const { commit, revisionId } = await this.commit(slug, opts.author, opts.message?.trim() || `delete ${path}`);
    return { commit, revisionId, upserts: [], removes };
  }

  async move(slug: string, from: string, to: string, opts: { author: string; message: string | undefined }): Promise<Change> {
    const st = await this.stat(slug, from);
    if (st === null) throw notFound(`no such file or directory: ${from}`);
    if (from === to || to.startsWith(`${from}/`)) throw invalid(`cannot move ${from} into itself`);
    if ((await this.stat(slug, to)) !== null) throw exists(`${to} already exists`);
    const oldFiles = st.type === "dir" ? (await this.walk(slug, from)).filter((e) => e.type === "file").map((e) => e.path) : [from];
    await this.ensureParents(slug, to);
    try {
      await rename(this.abs(slug, from), this.abs(slug, to));
    } catch (err) {
      if (isNodeError(err, "ENOTDIR", "EISDIR", "ENOTEMPTY")) throw invalid(`cannot move ${from} to ${to}`);
      throw err;
    }
    await this.pruneEmptyParents(slug, from);
    const { commit, revisionId } = await this.commit(slug, opts.author, opts.message?.trim() || `move ${from} to ${to}`);
    const upserts = oldFiles.map((path) => (path === from ? to : `${to}${path.slice(from.length)}`));
    return { commit, revisionId, upserts, removes: oldFiles };
  }

  /** Writes and removes several files and commits them as one revision. No rev checks: callers own the semantics. */
  async writeMany(slug: string, writes: { path: string; bytes: Uint8Array }[], removes: string[], opts: { author: string; message: string }): Promise<Change> {
    for (const w of writes) {
      await this.ensureParents(slug, w.path);
      const tmp = join(this.tmpDir, `write-${randomId()}`);
      await Bun.write(tmp, w.bytes);
      await rename(tmp, this.abs(slug, w.path));
    }
    const removed: string[] = [];
    for (const path of removes) {
      const st = await this.stat(slug, path);
      if (st?.type !== "file") continue;
      await rm(this.abs(slug, path));
      await this.pruneEmptyParents(slug, path);
      removed.push(path);
    }
    const { commit, revisionId } = await this.commit(slug, opts.author, opts.message);
    return { commit, revisionId, upserts: writes.map((w) => w.path), removes: removed };
  }

  /** Commits whatever is in the work tree (import, bulk writes). */
  async commitWorkTree(slug: string, author: string, message: string): Promise<{ commit: CommitInfo | null; revisionId: string }> {
    return this.commit(slug, author, message);
  }
}
