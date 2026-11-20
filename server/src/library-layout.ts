/**
 * The library's fixed layout (docs/SPEC.md → Store layout). Every write, move, upload and import into
 * `_library` must land in one of these places, whatever the route; anything else is `400 invalid` and the
 * message names the places. printer.json and materials.json cannot be deleted or moved. Files already
 * outside the layout are left alone: they can be read, moved into place or deleted, not written.
 */
import { MATERIALS_FILE, PART_DIR, PRINTER_FILE } from "@drawer/shared/api";
import { invalid } from "./errors.ts";
import { partOfPath } from "./parts/validate.ts";

export const LIBRARY_PLACES =
  "AGENTS.md, printer.json, materials.json, shared notes as <name>.md or notes/<name>.md, bought parts as parts/<id>.part.json and parts/<id>.scad, shared OpenSCAD modules under lib/ (.scad), and references for bought parts under refs/";

const PROTECTED = [PRINTER_FILE, MATERIALS_FILE];
const KEEP = ".gitkeep";

export function libraryPathAllowed(path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  const top = segments[0] ?? "";
  if (segments.length === 1) return PROTECTED.includes(name) || /^[^.].*\.md$/.test(name);
  if (name === KEEP) return [PART_DIR, "notes", "lib", "refs"].includes(top);
  if (top === PART_DIR) return segments.length === 2 && partOfPath(path) !== null;
  if (top === "notes") return /^[^.].*\.md$/.test(name);
  if (top === "lib") return /^[^.].*\.scad$/.test(name);
  return top === "refs";
}

/** Throws `400 invalid` unless `path` has a place in the library. */
export function assertLibraryPath(path: string): void {
  if (!libraryPathAllowed(path)) throw invalid(`${path} has no place in the library. It holds: ${LIBRARY_PLACES}`);
}

/** Throws `400 invalid` when removing or moving `path` (a file or a folder) would take printer.json or materials.json. */
export function assertLibraryKeeps(path: string): void {
  const hit = PROTECTED.find((p) => p === path || path === "" || path === ".");
  if (hit) throw invalid(`${hit} cannot be deleted or moved: change its values instead`);
}
