/** Project-relative path helpers. Paths use forward slashes and never start with one. */

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Lower-case extension including the dot, or "" when there is none. */
export function extOf(path: string): string {
  const name = baseName(path);
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i).toLowerCase();
}

/** Joins parts with single slashes, ignoring empty parts. */
export function joinPath(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split("/"))
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
}

/** A path the server will accept: no empty, `.` or `..` segments, not absolute, not inside `.git`. */
export function isValidRelPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  const segs = path.split("/");
  return segs.every((s) => s !== "" && s !== "." && s !== ".." && s !== ".git") && path !== "project.json";
}

/** `a/b/c.md` -> `a/b/c.md` with each segment URI-encoded, for use in a URL path. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** `a/b/c.md` -> [`a`, `a/b`]. */
export function ancestorsOf(path: string): string[] {
  const segs = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

/** True when `path` is `root` itself or lies inside the folder `root`. */
export function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Repoints `path` when `from` was moved to `to`; returns it unchanged when it is unaffected. */
export function remapMoved(path: string, from: string, to: string): string {
  return isAtOrUnder(path, from) ? `${to}${path.slice(from.length)}` : path;
}
