import { ASSEMBLY_FILE, BRIEF_FILE, LIBRARY_SLUG, PART_DIR, PART_SPEC_SUFFIX } from "@drawer/shared/api";
import type { AssemblySpec } from "@drawer/shared/api";

const PART_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The part a file belongs to (`parts/<id>.scad` or `parts/<id>.part.json`), or null. */
export function partIdOf(path: string): string | null {
  if (!path.startsWith(`${PART_DIR}/`)) return null;
  const name = path.slice(PART_DIR.length + 1);
  const id = name.endsWith(PART_SPEC_SUFFIX) ? name.slice(0, -PART_SPEC_SUFFIX.length) : name.endsWith(".scad") ? name.slice(0, -".scad".length) : null;
  return id !== null && PART_ID.test(id) ? id : null;
}

/** Outline sections of the files that are not parts. Files the outline draws elsewhere return null. */
export type FileSection = "references" | "memory" | "other";

export function sectionOf(path: string): FileSection | null {
  if (path === BRIEF_FILE || path === ASSEMBLY_FILE || partIdOf(path) !== null) return null;
  if (path === "refs" || path.startsWith("refs/")) return "references";
  if (path === "AGENTS.md" || path === "notes" || path.startsWith("notes/")) return "memory";
  if (path === PART_DIR) return null;
  return "other";
}

const LIB_PREFIX = `${LIBRARY_SLUG}/`;

/** Library parts an assembly places, with how many copies: the "Bought" section. */
export function boughtParts(spec: AssemblySpec | undefined): { id: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const inst of spec?.instances ?? []) {
    if (!inst.part.startsWith(LIB_PREFIX)) continue;
    const id = inst.part.slice(LIB_PREFIX.length);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id));
}
