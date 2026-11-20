import { posix } from "node:path";
import type { FileKind } from "@drawer/shared/api";
import { LIBRARY_SLUG } from "@drawer/shared/api";
import { invalid } from "../errors.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidSlug(slug: string): boolean {
  return slug === LIBRARY_SLUG || SLUG_RE.test(slug);
}

/** For slugs a client may choose: the library is reserved. */
export function assertNewSlug(slug: unknown): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw invalid("slug must match [a-z0-9][a-z0-9-]* (max 63 characters)");
  }
  return slug;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Normalises a client-supplied project-relative path. Rejects anything that could leave the
 * project folder or touch server-owned files (`..`, absolute paths, `.git`, `project.json`).
 */
export function normalizePath(input: string, opts: { allowEmpty?: boolean } = {}): string {
  if (CONTROL_RE.test(input)) throw invalid("path contains control characters");
  if (input.includes("\\")) throw invalid("path must use forward slashes");
  if (input.startsWith("/")) throw invalid("path must be relative");
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw invalid("path must not contain '..'");
    if (segment.toLowerCase() === ".git") throw invalid("path must not contain '.git'");
    if (Buffer.byteLength(segment) > 255) throw invalid("path segment too long");
    segments.push(segment);
  }
  const path = segments.join("/");
  if (path === "") {
    if (opts.allowEmpty) return "";
    throw invalid("path is empty");
  }
  if (path === "project.json") throw invalid("project.json is managed by the server");
  return path;
}

/** Entries the store never lists or indexes. `.git` and root `project.json` cannot be addressed at all. */
export function isHiddenName(name: string): boolean {
  return name === ".git" || name === ".gitkeep";
}

export function extOf(path: string): string {
  const base = posix.basename(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

const KIND_BY_EXT: Record<string, FileKind> = {
  md: "markdown",
  scad: "scad",
  stl: "mesh",
  "3mf": "mesh",
  obj: "mesh",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  pdf: "pdf",
  txt: "text",
  json: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  csv: "text",
  gcode: "text",
  py: "text",
  js: "text",
  ts: "text",
  sh: "text",
  dxf: "text",
};

/** Kind from the extension alone; null when the content has to be sniffed. */
export function kindFromExtension(path: string): FileKind | null {
  return KIND_BY_EXT[extOf(path)] ?? null;
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/plain; charset=utf-8",
  scad: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  toml: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gcode: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8",
  js: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  sh: "text/plain; charset=utf-8",
  dxf: "text/plain; charset=utf-8",
  stl: "model/stl",
  "3mf": "model/3mf",
  obj: "model/obj",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/plain; charset=utf-8",
};

export function mimeFor(path: string, kind: FileKind | null): string {
  const byExt = MIME_BY_EXT[extOf(path)];
  if (byExt) return byExt;
  return kind === "text" || kind === "markdown" || kind === "scad" ? "text/plain; charset=utf-8" : "application/octet-stream";
}

/** Sniffs unknown extensions: UTF-8 under 1 MB without NUL bytes is text. */
export const TEXT_SNIFF_LIMIT = 1024 * 1024;

export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length > TEXT_SNIFF_LIMIT || bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function slugify(text: string, fallback: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? fallback : slug;
}
