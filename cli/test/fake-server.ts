/**
 * An in-process stand-in for the drawer server: the routes the CLI calls, stateful, following
 * shared/src/api.ts and docs/SPEC.md. Not a faithful server, just faithful where the CLI looks.
 */
import type {
  ApiError,
  ContextNode,
  ContextResponse,
  EditBody,
  FileInfo,
  FileKind,
  ImportPreview,
  ImportResult,
  MeshInfo,
  Project,
  RenderResult,
  RenderView,
  Revision,
  SearchHit,
  TreeEntry,
} from "@drawer/shared/api";
import { FakeModeling, type StoredFile } from "./fake-parts.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}

const MESH: MeshInfo = {
  format: "stl",
  triangles: 1234,
  bbox: { min: [0, 0, 0], max: [40, 30, 12.5], size: [40, 30, 12.5] },
  volumeCm3: 8.125,
};

const VIEWS: RenderView[] = ["iso", "front", "top", "side"];

export const revOf = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);

const kindOf = (path: string): FileKind => {
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".scad")) return "scad";
  if (/\.(stl|3mf|obj)$/.test(path)) return "mesh";
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(path)) return "image";
  if (path.endsWith(".pdf")) return "pdf";
  if (/\.(txt|json|ya?ml|toml|csv)$/.test(path)) return "text";
  return "binary";
};

const isText = (kind: FileKind) => kind === "markdown" || kind === "scad" || kind === "text";

export class FakeDrawer {
  readonly projects = new Map<string, Project>();
  readonly files = new Map<string, Map<string, StoredFile>>();
  readonly revisions: (Revision & { project: string })[] = [];
  readonly requests: RecordedRequest[] = [];
  readonly downloads: string[] = [];
  /** Parts, reports, measuring, assemblies, sessions. */
  readonly modeling: FakeModeling;
  /** Makes the next request fail with this error: simulates a refusal the real server would give. */
  failNext: { status: number; error: ApiError["error"]; message: string } | null = null;
  /** Runs once just before the next PUT is evaluated: simulates a concurrent writer. */
  beforeNextPut: (() => void) | null = null;
  private readonly server: ReturnType<typeof Bun.serve>;
  private counter = 0;

  constructor() {
    this.modeling = new FakeModeling({
      files: this.files,
      projects: this.projects,
      write: (project, path, text, author, message) => this.store(project, path, new TextEncoder().encode(text), author, message),
      lastRevisionId: () => `r${this.counter}`,
    });
    this.addProject("_library", "Library");
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  addProject(slug: string, title: string): Project {
    const now = new Date().toISOString();
    const project: Project = {
      slug,
      title,
      description: "",
      createdAt: now,
      updatedAt: now,
      updatedBy: "system",
      fileCount: 0,
      cover: null,
      thumbnail: null,
      source: null,
      defaults: { material: "PETG", strictness: "standard" },
      status: { parts: 0, passed: 0, draft: 0, failed: 0, pending: 0, assembly: "none", overall: "empty" },
    };
    this.projects.set(slug, project);
    this.files.set(slug, new Map());
    return project;
  }

  seed(project: string, path: string, content: string | Uint8Array): StoredFile {
    if (!this.projects.has(project)) this.addProject(project, project);
    return this.store(project, path, typeof content === "string" ? new TextEncoder().encode(content) : content, "system", "seed");
  }

  text(project: string, path: string): string | null {
    const file = this.files.get(project)?.get(path);
    return file ? new TextDecoder().decode(file.bytes) : null;
  }

  file(project: string, path: string): StoredFile | undefined {
    return this.files.get(project)?.get(path);
  }

  private store(project: string, path: string, bytes: Uint8Array, author: string, message: string): StoredFile {
    const file: StoredFile = { bytes, rev: revOf(bytes), updatedBy: author };
    this.files.get(project)?.set(path, file);
    this.revisions.unshift({ id: `r${++this.counter}`, author, message, date: new Date().toISOString(), paths: [path], project });
    const p = this.projects.get(project);
    if (p) p.fileCount = this.files.get(project)?.size ?? 0;
    return file;
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private err(status: number, error: ApiError["error"], message: string, rev?: string): Response {
    const body: ApiError = rev === undefined ? { error, message } : { error, message, rev };
    return this.json(body, status);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const query = Object.fromEntries(url.searchParams);
    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    const headers = Object.fromEntries(req.headers);
    this.requests.push({ method: req.method, path: url.pathname, query, headers, body: new TextDecoder().decode(bodyBytes) });
    if (this.failNext) {
      const { status, error, message } = this.failNext;
      this.failNext = null;
      return this.err(status, error, message);
    }
    const author = req.headers.get("x-drawer-author") ?? "agent";
    const rawMessage = req.headers.get("x-drawer-message");
    const message = rawMessage === null ? "" : decodeURIComponent(rawMessage);
    const parts = url.pathname.split("/").map(decodeURIComponent);
    // parts: ["", "api", ...]
    const route = parts.slice(2);
    const method = req.method;

    if (route[0] === "health") return this.json({ ok: true, version: "0.1.0-fake", openscad: "2026.01.01" });
    if (route[0] === "reindex" && method === "POST") return this.json({ files: [...this.files.values()].reduce((n, m) => n + m.size, 0) });

    if (route[0] === "renders") {
      const name = route.slice(1).join("/");
      this.downloads.push(name);
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode(name)]), { headers: { "content-type": "image/png" } });
    }

    if (route[0] === "import" && route[1] === "preview") return this.json(this.preview(JSON.parse(new TextDecoder().decode(bodyBytes)).url));

    const modeled = this.modeling.handle(route, method, query, new TextDecoder().decode(bodyBytes), author);
    if (modeled) return modeled;

    if (route[0] !== "projects") return this.err(404, "not_found", `no route ${url.pathname}`);

    if (route.length === 1) {
      if (method === "GET") return this.json({ projects: [...this.projects.values()].filter((p) => p.slug !== "_library") });
      if (method === "POST") {
        const body = JSON.parse(new TextDecoder().decode(bodyBytes)) as {
          slug: string;
          title?: string;
          description?: string;
          fromUrl?: string;
          brief?: string;
          defaults?: Partial<Project["defaults"]>;
        };
        if (this.projects.has(body.slug)) return this.err(409, "exists", `project ${body.slug} exists`);
        const project = this.addProject(body.slug, body.title ?? body.slug);
        project.description = body.description ?? "";
        project.defaults = { ...project.defaults, ...(body.defaults ?? {}) };
        if (body.brief !== undefined) this.store(body.slug, "brief.md", new TextEncoder().encode(body.brief), author, "brief");
        return this.json(project, 201);
      }
    }

    const slug = route[1] as string;
    const project = this.projects.get(slug);
    if (!project) return this.err(404, "not_found", `no project ${slug}`);
    const files = this.files.get(slug) as Map<string, StoredFile>;
    const sub = route[2];

    if (sub === undefined) {
      if (method === "GET") return this.json(project);
      if (method === "PATCH") {
        Object.assign(project, JSON.parse(new TextDecoder().decode(bodyBytes)));
        return this.json(project);
      }
    }
    if (sub === "tree") return this.json({ entries: this.tree(slug) });
    if (sub === "search") return this.search(slug, query);
    if (sub === "history") {
      const only = query.path;
      const revisions = this.revisions
        .filter((r) => r.project === slug && (!only || r.paths.includes(only)))
        .slice(0, query.limit ? Number(query.limit) : 50)
        .map(({ project: _p, ...rest }) => rest);
      return this.json({ revisions });
    }
    if (sub === "move" && method === "POST") {
      const body = JSON.parse(new TextDecoder().decode(bodyBytes)) as { from: string; to: string; message?: string };
      const file = files.get(body.from);
      if (!file) return this.err(404, "not_found", `no file ${body.from}`);
      files.delete(body.from);
      files.set(body.to, file);
      this.revisions.unshift({ id: `r${++this.counter}`, author, message: body.message ?? "", date: new Date().toISOString(), paths: [body.from, body.to], project: slug });
      return this.json({ revisionId: `r${this.counter}` });
    }
    if (sub === "import" && method === "POST") return this.json(this.importInto(slug, JSON.parse(new TextDecoder().decode(bodyBytes))));

    const path = route.slice(3).join("/");
    if (!path) return this.err(400, "invalid", "missing path");
    if (path.includes("..")) return this.err(400, "invalid", "bad path");

    switch (sub) {
      case "files":
        return this.filesRoute(method, slug, path, files, req, bodyBytes, author, message, query);
      case "edit":
        return this.edit(slug, path, files, JSON.parse(new TextDecoder().decode(bodyBytes)) as EditBody, author, message);
      case "info":
        return this.info(slug, path, files);
      case "context":
        return this.context(slug, path, files);
      case "render":
        return this.render(slug, path, files, bodyBytes);
      default:
        return this.err(404, "not_found", `no route ${url.pathname}`);
    }
  }

  private filesRoute(
    method: string,
    slug: string,
    path: string,
    files: Map<string, StoredFile>,
    req: Request,
    body: Uint8Array,
    author: string,
    message: string,
    query: Record<string, string>,
  ): Response {
    const existing = files.get(path);
    const rev = req.headers.get("x-drawer-rev");
    if (method === "GET") {
      if (!existing) return this.err(404, "not_found", `no file ${slug}/${path}`);
      return new Response(existing.bytes, { headers: { "x-drawer-rev": existing.rev, "content-type": "application/octet-stream" } });
    }
    if (method === "PUT") {
      this.beforeNextPut?.();
      this.beforeNextPut = null;
      const current = files.get(path);
      if (!current) {
        if (rev !== null && rev !== "*") return this.err(404, "not_found", `no file ${path} to overwrite`);
      } else if (rev === null) {
        return this.err(409, "conflict", `${path} exists; send x-drawer-rev`, current.rev);
      } else if (rev !== "*" && rev !== current.rev) {
        return this.err(409, "conflict", `rev ${rev} is not current`, current.rev);
      }
      const saved = this.store(slug, path, body, author, message);
      return this.json(this.modeling.writeResult(slug, path, saved, !current, new TextDecoder().decode(body)), current ? 200 : 201);
    }
    if (method === "DELETE") {
      if (query.recursive === "1") {
        for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
        this.revisions.unshift({ id: `r${++this.counter}`, author, message, date: new Date().toISOString(), paths: [path], project: slug });
        return this.json({ revisionId: `r${this.counter}` });
      }
      if (!existing) return this.err(404, "not_found", `no file ${path}`);
      if (rev === null) return this.err(400, "invalid", "x-drawer-rev required");
      if (rev !== existing.rev) return this.err(409, "conflict", "rev is not current", existing.rev);
      files.delete(path);
      this.revisions.unshift({ id: `r${++this.counter}`, author, message, date: new Date().toISOString(), paths: [path], project: slug });
      return this.json({ revisionId: `r${this.counter}` });
    }
    return this.err(404, "not_found", "no such method");
  }

  private edit(slug: string, path: string, files: Map<string, StoredFile>, body: EditBody, author: string, message: string): Response {
    const existing = files.get(path);
    if (!existing) return this.err(404, "not_found", `no file ${path}`);
    if (body.rev !== existing.rev) return this.err(409, "conflict", "rev is not current", existing.rev);
    const text = new TextDecoder().decode(existing.bytes);
    const count = text.split(body.old).length - 1;
    if (count === 0 || (count > 1 && !body.replaceAll)) {
      return this.err(422, "edit_no_match", count === 0 ? "old string not found" : `old string found ${count} times; pass replaceAll`);
    }
    const next = body.replaceAll ? text.split(body.old).join(body.new) : text.replace(body.old, () => body.new);
    const saved = this.store(slug, path, new TextEncoder().encode(next), author, message);
    return this.json(this.modeling.writeResult(slug, path, saved, false, next));
  }

  private tree(slug: string): TreeEntry[] {
    const files = this.files.get(slug) as Map<string, StoredFile>;
    const entries: TreeEntry[] = [];
    const seen = new Set<string>();
    for (const path of [...files.keys()].sort()) {
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i++) {
        const dir = segments.slice(0, i).join("/");
        if (!seen.has(dir)) {
          seen.add(dir);
          entries.push({ path: dir, type: "dir" });
        }
      }
      const file = files.get(path) as StoredFile;
      entries.push({ path, type: "file", kind: kindOf(path), size: file.bytes.length, rev: file.rev, updatedAt: new Date().toISOString(), updatedBy: file.updatedBy });
    }
    return entries;
  }

  private info(slug: string, path: string, files: Map<string, StoredFile>): Response {
    const file = files.get(path);
    if (!file) return this.err(404, "not_found", `no file ${path}`);
    const kind = kindOf(path);
    const info: FileInfo = {
      project: slug,
      path,
      kind,
      size: file.bytes.length,
      rev: file.rev,
      updatedAt: new Date().toISOString(),
      updatedBy: file.updatedBy,
      mesh: kind === "mesh" ? MESH : null,

      facts: kind === "markdown" ? [{ category: "decision", text: "use M3 screws", path, line: 3 }] : [],
      outgoing: [{ from: path, fromProject: slug, relation: "uses", target: "lib/box.scad", to: null, toProject: null }],
      incoming: [],
      outline: kind === "scad" ? ["module lid", "function wall"] : [],
    };
    return this.json(info);
  }

  private context(slug: string, path: string, files: Map<string, StoredFile>): Response {
    const file = files.get(path);
    if (!file) return this.err(404, "not_found", `no file ${path}`);
    const root: ContextNode = { project: slug, path, kind: kindOf(path), depth: 0, via: null, content: new TextDecoder().decode(file.bytes), truncated: false, mesh: null };
    const linked: ContextNode = {
      project: "_library",
      path: "tolerances.md",
      kind: "markdown",
      depth: 1,
      via: { from: path, fromProject: slug, relation: "uses", target: "Library: tolerances.md", to: "tolerances.md", toProject: "_library" },
      content: "# Tolerances\n- [fit] 0.2 mm clearance",
      truncated: true,
      mesh: null,
    };
    const mesh: ContextNode = { project: slug, path: "refs/part.stl", kind: "mesh", depth: 1, via: null, content: null, truncated: false, mesh: MESH };
    const response: ContextResponse = { root: `${slug}/${path}`, nodes: [root, linked, mesh] };
    return this.json(response);
  }

  private render(slug: string, path: string, files: Map<string, StoredFile>, bodyBytes: Uint8Array): Response {
    const file = files.get(path);
    if (!file) return this.err(404, "not_found", `no file ${path}`);
    const text = new TextDecoder().decode(file.bytes);
    if (text.includes("SYNTAX_ERROR")) return this.err(422, "render_failed", "ERROR: Parser error in file x.scad, line 1: syntax error");
    const body = JSON.parse(new TextDecoder().decode(bodyBytes) || "{}") as { views?: RenderView[] };
    const key = `${file.rev}0000`.slice(0, 24);
    const views: Partial<Record<RenderView, string>> = {};
    for (const view of body.views ?? VIEWS) views[view] = `/api/renders/${key}/${view}.png`;
    const result: RenderResult = {
      project: slug,
      path,
      key,
      cached: false,
      seconds: 1.5,
      mesh: `/api/renders/${key}/mesh.stl`,
      views,
      sheet: `/api/renders/${key}/sheet.png`,
      info: MESH,
      log: ['ECHO: "wall", 2'],
      warnings: ["WARNING: variable x not specified"],
    };
    return this.json(result);
  }

  private search(slug: string, query: Record<string, string>): Response {
    const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/\*$/, ""));
    const hits: SearchHit[] = [];
    for (const [path, file] of this.files.get(slug) ?? []) {
      const kind = kindOf(path);
      if (!isText(kind) || (query.kind && query.kind !== kind)) continue;
      const text = new TextDecoder().decode(file.bytes);
      const lower = text.toLowerCase();
      if (!words.every((w) => lower.includes(w))) continue;
      const at = lower.indexOf(words[0] ?? "");
      const word = text.slice(at, at + (words[0]?.length ?? 0));
      hits.push({ path, kind, title: path, snippet: `${text.slice(Math.max(0, at - 10), at)}«${word}»${text.slice(at + word.length, at + word.length + 20)}`, score: 1 });
    }
    return this.json({ hits: hits.slice(0, query.limit ? Number(query.limit) : 20) });
  }

  private preview(url: string): ImportPreview {
    return {
      source: { site: "printables", url, title: "Earbuds holder", author: "maker", license: "CC-BY-4.0", description: "A holder", images: [] },
      files: [
        { id: "f1", name: "holder.stl", size: 2048, downloadable: true },
        { id: "f2", name: "holder.step", size: null, downloadable: false },
      ],
      blocker: null,
    };
  }

  private importInto(slug: string, body: { url: string; name?: string; fileIds?: string[] }): ImportResult {
    const dir = `refs/${body.name ?? "earbuds-holder"}`;
    this.store(slug, `${dir}/source.md`, new TextEncoder().encode(`# Earbuds holder\n${body.url}\n`), "import", "import");
    return { project: slug, dir, written: [`${dir}/source.md`], skipped: [{ name: "holder.step", reason: "not downloadable" }], revisionId: `r${this.counter}` };
  }
}
