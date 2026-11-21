import { posix } from "node:path";
import { LIBRARY_SLUG } from "@drawer/shared/api";

/** The set of known files, grouped by project, with lookups by basename and stem. */
export interface FileSet {
  paths: Set<string>;
  byBase: Map<string, string[]>;
  byStem: Map<string, string[]>;
}

export type ResolveContext = Map<string, FileSet>;

export interface Resolved {
  project: string;
  path: string;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildContext(files: Iterable<{ project: string; path: string }>): ResolveContext {
  const ctx: ResolveContext = new Map();
  for (const { project, path } of files) {
    let set = ctx.get(project);
    if (!set) {
      set = { paths: new Set(), byBase: new Map(), byStem: new Map() };
      ctx.set(project, set);
    }
    set.paths.add(path);
    const base = posix.basename(path).toLowerCase();
    push(set.byBase, base, path);
    const dot = base.lastIndexOf(".");
    if (dot > 0) push(set.byStem, base.slice(0, dot), path);
  }
  return ctx;
}

/** An existing file at `path`, also trying `path.md`. */
function exact(ctx: ResolveContext, project: string, path: string, tryMarkdown: boolean): string | null {
  const set = ctx.get(project);
  if (!set || path === "" || path.startsWith("../") || path === "..") return null;
  if (set.paths.has(path)) return path;
  if (tryMarkdown && !path.endsWith(".md") && set.paths.has(`${path}.md`)) return `${path}.md`;
  return null;
}

function uniqueByName(ctx: ResolveContext, project: string, name: string): string | null {
  const set = ctx.get(project);
  if (!set) return null;
  const key = name.toLowerCase();
  const matches = new Set([...(set.byBase.get(key) ?? []), ...(set.byStem.get(key) ?? [])]);
  return matches.size === 1 ? ([...matches][0] ?? null) : null;
}

function inProject(ctx: ResolveContext, project: string, target: string, fromPath: string | null): string | null {
  const direct = exact(ctx, project, target, true);
  if (direct) return direct;
  if (fromPath !== null) {
    const relative = exact(ctx, project, posix.normalize(posix.join(posix.dirname(fromPath), target)), true);
    if (relative) return relative;
  }
  return uniqueByName(ctx, project, target);
}

const LIBRARY_PREFIX_RE = /^library\s*:\s*(.+)$/i;

/** Resolves a `[[target]]` written in a markdown file. See SPEC "Notes grammar". */
export function resolveWikiTarget(ctx: ResolveContext, project: string, fromPath: string, rawTarget: string): Resolved | null {
  let target = rawTarget.trim();
  const hash = target.indexOf("#");
  if (hash > 0) target = target.slice(0, hash).trim();
  target = target.replace(/^\.\//, "");
  if (target === "") return null;

  const library = LIBRARY_PREFIX_RE.exec(target);
  if (library) {
    const path = inProject(ctx, LIBRARY_SLUG, (library[1] ?? "").trim().replace(/^\.\//, ""), null);
    return path ? { project: LIBRARY_SLUG, path } : null;
  }
  if (target.startsWith(`${LIBRARY_SLUG}/`)) {
    const path = inProject(ctx, LIBRARY_SLUG, target.slice(LIBRARY_SLUG.length + 1), null);
    return path ? { project: LIBRARY_SLUG, path } : null;
  }

  const local = inProject(ctx, project, target, fromPath);
  if (local) return { project, path: local };

  const slash = target.indexOf("/");
  if (slash > 0) {
    const otherSlug = target.slice(0, slash);
    if (otherSlug !== project && ctx.has(otherSlug)) {
      const path = exact(ctx, otherSlug, target.slice(slash + 1), true);
      if (path) return { project: otherSlug, path };
    }
  }
  return null;
}

/** Resolves a SCAD `use`/`include`/`import`: relative to the file, then the project root, then the library. */
export function resolveScadTarget(ctx: ResolveContext, project: string, fromPath: string, rawTarget: string): Resolved | null {
  const target = rawTarget.trim();
  if (target === "" || target.startsWith("/")) return null;
  const relative = exact(ctx, project, posix.normalize(posix.join(posix.dirname(fromPath), target)), false);
  if (relative) return { project, path: relative };
  const root = exact(ctx, project, posix.normalize(target), false);
  if (root) return { project, path: root };
  const lib = exact(ctx, LIBRARY_SLUG, posix.normalize(target), false);
  return lib ? { project: LIBRARY_SLUG, path: lib } : null;
}

const SCAD_RELATIONS = new Set(["uses", "includes", "imports"]);

export function resolveLink(ctx: ResolveContext, project: string, fromPath: string, relation: string, target: string): Resolved | null {
  if (relation === "scans" || relation === "matches") {
    const path = exact(ctx, project, target, false);
    return path ? { project, path } : null;
  }
  return fromPath.toLowerCase().endsWith(".scad") && SCAD_RELATIONS.has(relation)
    ? resolveScadTarget(ctx, project, fromPath, target)
    : resolveWikiTarget(ctx, project, fromPath, target);
}
