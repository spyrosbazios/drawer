/** The mock's file store: projects as folders of versioned files, with revisions, links and facts. */
import { isMeshFormat, LIBRARY_SLUG } from "../../../shared/src/api";
import type { Fact, FileInfo, FileKind, ImportPreview, ImportResult, Link, Project, Revision, TreeEntry } from "../../../shared/src/api";
import { cubeStl, meshInfoOfStl } from "./geometry";
import { HttpError } from "./http";

export interface Version {
  revisionId: string;
  bytes: Uint8Array;
  rev: string;
}
export interface StoredFile {
  versions: Version[];
  updatedAt: string;
  updatedBy: string;
  deleted: boolean;
}
/** What project.json holds; `status` is computed from the parts when the project is read. */
export type ProjectMeta = Omit<Project, "status" | "thumbnail">;

export interface StoredProject {
  meta: ProjectMeta;
  files: Map<string, StoredFile>;
  revisions: Revision[];
}

export const projects = new Map<string, StoredProject>();
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
let counter = 0;

export const now = () => new Date().toISOString();
export const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export const revOf = (bytes: Uint8Array) => sha(bytes).slice(0, 16);
export const nextId = () => `r${(++counter).toString(36).padStart(4, "0")}`;

export function kindOf(path: string): FileKind {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (ext === ".md") return "markdown";
  if (ext === ".scad") return "scad";
  if (isMeshFormat(ext.slice(1))) return "mesh";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".txt", ".json", ".yaml", ".yml", ".toml", ".csv", ".gcode", ".py", ".js", ".ts", ".sh", ".dxf", ".gitkeep", ""].includes(ext)) return "text";
  return "binary";
}

export function record(p: StoredProject, author: string, message: string, paths: string[]): Revision {
  const rev: Revision = { id: nextId(), author, message, date: now(), paths };
  p.revisions.unshift(rev);
  p.meta.updatedAt = rev.date;
  p.meta.updatedBy = author;
  p.meta.fileCount = [...p.files.values()].filter((f) => !f.deleted).length;
  return rev;
}

export function put(p: StoredProject, path: string, bytes: Uint8Array, author: string, message: string, revision = record(p, author, message, [path])): { created: boolean; rev: string; revisionId: string } {
  const existing = p.files.get(path);
  const created = !existing || existing.deleted;
  const version: Version = { revisionId: revision.id, bytes, rev: revOf(bytes) };
  if (existing && !existing.deleted) existing.versions.unshift(version);
  else p.files.set(path, { versions: [version, ...(existing?.versions ?? [])], updatedAt: revision.date, updatedBy: author, deleted: false });
  const f = p.files.get(path);
  if (f) {
    f.updatedAt = revision.date;
    f.updatedBy = author;
  }
  p.meta.fileCount = [...p.files.values()].filter((x) => !x.deleted).length;
  return { created, rev: version.rev, revisionId: revision.id };
}

export function head(p: StoredProject, path: string): Version | null {
  const f = p.files.get(path);
  return f && !f.deleted ? (f.versions[0] ?? null) : null;
}

export function createProject(slug: string, title: string, source: Project["source"] = null): StoredProject {
  const meta: ProjectMeta = { slug, title, description: "", createdAt: now(), updatedAt: now(), updatedBy: "system", fileCount: 0, cover: null, source, defaults: { material: "PETG", strictness: "standard" } };
  const p: StoredProject = { meta, files: new Map(), revisions: [] };
  projects.set(slug, p);
  return p;
}

// ---- notes grammar -----------------------------------------------------------------------------

function resolve(slug: string, from: string, target: string): { to: string | null; toProject: string | null } {
  const lib = /^(?:Library:\s*|_library\/)(.+)$/.exec(target);
  const [project, wanted] = lib ? [LIBRARY_SLUG, lib[1] ?? ""] : [slug, target];
  const p = projects.get(project);
  if (!p) return { to: null, toProject: null };
  const paths = [...p.files.entries()].filter(([, f]) => !f.deleted).map(([path]) => path);
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const candidates = [wanted, dir ? `${dir}/${wanted}` : wanted];
  for (const c of candidates) if (paths.includes(c)) return { to: c, toProject: project };
  const base = (x: string) => x.slice(x.lastIndexOf("/") + 1);
  const stem = (x: string) => base(x).replace(/\.[^.]+$/, "");
  const matches = paths.filter((x) => base(x) === wanted || stem(x) === wanted || x === `${wanted}.md`);
  return matches.length === 1 && matches[0] ? { to: matches[0], toProject: project } : { to: null, toProject: null };
}

function linksOf(slug: string, path: string, text: string): Link[] {
  const out: Link[] = [];
  for (const line of text.split("\n")) {
    const rel = /^\s*[-*+]\s+([A-Za-z_ ]+?)\s*\[\[([^\]]+)\]\]/.exec(line);
    const bare = /^\s*[-*+]\s+\[\[([^\]]+)\]\]/.exec(line);
    const seen = new Set<string>();
    if (rel?.[1] && rel[2]) {
      seen.add(rel[2]);
      out.push({ from: path, fromProject: slug, relation: rel[1].trim().replace(/\s+/g, "_"), target: rel[2], ...resolve(slug, path, rel[2]) });
    } else if (bare?.[1]) {
      seen.add(bare[1]);
      out.push({ from: path, fromProject: slug, relation: "relates_to", target: bare[1], ...resolve(slug, path, bare[1]) });
    }
    for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const t = m[1] ?? "";
      if (!seen.has(t)) out.push({ from: path, fromProject: slug, relation: "links_to", target: t, ...resolve(slug, path, t) });
    }
  }
  if (kindOf(path) === "scad") {
    for (const m of text.matchAll(/\b(use|include)\s*<([^>]+)>/g)) {
      const t = m[2] ?? "";
      out.push({ from: path, fromProject: slug, relation: m[1] === "use" ? "uses" : "includes", target: t, ...resolve(slug, path, t) });
    }
  }
  return out;
}

function factsOf(path: string, text: string): Fact[] {
  return text.split("\n").flatMap((line, i): Fact[] => {
    const m = /^\s*[-*+]\s+\[([^\]\n]+)\]\s+(.*)$/.exec(line);
    if (!m || /^[ xX]$/.test(m[1] ?? "")) return [];
    return [{ category: (m[1] ?? "").trim(), text: m[2] ?? "", path, line: i + 1 }];
  });
}

export function infoOf(slug: string, p: StoredProject, path: string): FileInfo | null {
  const v = head(p, path);
  const f = p.files.get(path);
  if (!v || !f) return null;
  const kind = kindOf(path);
  const text = ["markdown", "scad", "text"].includes(kind) ? decoder.decode(v.bytes) : "";
  const outgoing = text ? linksOf(slug, path, text) : [];
  const incoming: Link[] = [];
  for (const [s, other] of projects) {
    for (const [op, of] of other.files) {
      const ov = of.deleted ? null : of.versions[0];
      if (!ov || !["markdown", "scad"].includes(kindOf(op))) continue;
      for (const l of linksOf(s, op, decoder.decode(ov.bytes))) if (l.to === path && l.toProject === slug && !(s === slug && op === path)) incoming.push(l);
    }
  }
  return {
    project: slug,
    path,
    kind,
    size: v.bytes.byteLength,
    rev: v.rev,
    updatedAt: f.updatedAt,
    updatedBy: f.updatedBy,
    mesh: kind === "mesh" && path.toLowerCase().endsWith(".stl") ? meshInfoOfStl(v.bytes) : null,
    facts: kind === "markdown" ? factsOf(path, text) : [],
    outgoing,
    incoming,
    outline: kind === "scad" ? [...text.matchAll(/\b(?:module|function)\s+([A-Za-z_]\w*)/g)].map((m) => m[1] ?? "") : [],
  };
}

export function treeOf(p: StoredProject): TreeEntry[] {
  const files = [...p.files.entries()].filter(([, f]) => !f.deleted).sort(([a], [b]) => a.localeCompare(b));
  const dirs = new Set<string>();
  for (const [path] of files) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const entries: TreeEntry[] = [];
  const walk = (prefix: string) => {
    const children = new Set<string>();
    for (const d of dirs) if (d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) children.add(d);
    for (const d of [...children].sort()) {
      entries.push({ path: d, type: "dir" });
      walk(`${d}/`);
    }
    for (const [path, f] of files) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) continue;
      const v = f.versions[0];
      if (v) entries.push({ path, type: "file", kind: kindOf(path), size: v.bytes.byteLength, rev: v.rev, updatedAt: f.updatedAt, updatedBy: f.updatedBy });
    }
  };
  walk("");
  return entries;
}

export function validPath(path: string): string {
  if (path === "" || path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "." || s === "" || s === ".git") || path === "project.json") throw new HttpError("invalid", `Invalid path: ${path}`);
  return path;
}


export function getProject(slug: string): StoredProject {
  const p = projects.get(slug);
  if (!p) throw new HttpError("not_found", `No project ${slug}`);
  return p;
}

export function textOf(p: StoredProject, path: string, revisionId?: string): string | null {
  const f = p.files.get(path);
  const v = revisionId ? f?.versions.find((x) => x.revisionId === revisionId) : head(p, path);
  return v ? decoder.decode(v.bytes) : null;
}

export function importFixture(url: string): ImportPreview {
  const host = new URL(url).hostname;
  const base = { url, title: "Phone stand", author: "maker", license: "CC-BY 4.0", description: "A sturdy stand.", images: [] as string[] };
  if (host.includes("printables")) {
    return {
      source: { ...base, site: "printables" },
      files: [
        { id: "f1", name: "stand.stl", size: 482_000, downloadable: true },
        { id: "f2", name: "stand-v2.3mf", size: 1_220_000, downloadable: true },
        { id: "f3", name: "assembly.step", size: null, downloadable: false },
      ],
      blocker: null,
    };
  }
  if (host.includes("thingiverse")) {
    return {
      source: { ...base, site: "thingiverse" },
      files: [{ id: "t1", name: "stand.stl", size: 300_000, downloadable: false }],
      blocker: "Thingiverse needs an API token (THINGIVERSE_TOKEN)",
    };
  }
  if (host === "broken.example") throw new HttpError("import_failed", "Could not reach broken.example");
  return { source: { ...base, site: "generic", title: "Some page", author: null, license: null }, files: [], blocker: null };
}

export function importInto(p: StoredProject, url: string, fileIds: string[] | undefined, name: string | undefined): ImportResult {
  const preview = importFixture(url);
  const dir = `refs/${name ?? preview.source.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const written: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const chosen = preview.files.filter((f) => fileIds === undefined || fileIds.includes(f.id));
  for (const f of chosen) {
    if (!f.downloadable) skipped.push({ name: f.name, reason: "The site does not hand out this file" });
    else {
      put(p, `${dir}/${f.name}`, cubeStl(30), "import", `Import ${f.name}`);
      written.push(`${dir}/${f.name}`);
    }
  }
  put(p, `${dir}/source.md`, encoder.encode(`# ${preview.source.title}\n\n- [source] ${url}\n`), "import", "Import source");
  written.push(`${dir}/source.md`);
  const rev = record(p, "import", `Import ${preview.source.title}`, written);
  return { project: p.meta.slug, dir, written, skipped, revisionId: rev.id };
}

