import type { FileKind } from "@drawer/shared/api";

export const KIND_LABEL: Record<FileKind, string> = {
  markdown: "md",
  scad: "scad",
  mesh: "3D",
  image: "img",
  pdf: "pdf",
  text: "txt",
  binary: "bin",
};

/** Full class strings so Tailwind can see them; all colours are theme tokens. */
export const KIND_TONE: Record<FileKind, string> = {
  markdown: "bg-cat1/15 text-cat1",
  scad: "bg-cat4/15 text-cat4",
  mesh: "bg-cat3/15 text-cat3",
  image: "bg-cat5/15 text-cat5",
  pdf: "bg-cat2/15 text-cat2",
  text: "bg-raised text-dim",
  binary: "bg-raised text-faint",
};

const CATEGORY_TONES = [
  "bg-cat1/15 text-cat1",
  "bg-cat2/15 text-cat2",
  "bg-cat3/15 text-cat3",
  "bg-cat4/15 text-cat4",
  "bg-cat5/15 text-cat5",
  "bg-cat6/15 text-cat6",
] as const;

/** A stable colour for a fact category: the same word always gets the same chip. */
export function categoryTone(category: string): string {
  let h = 0;
  for (const ch of category.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CATEGORY_TONES[h % CATEGORY_TONES.length] ?? CATEGORY_TONES[0];
}

export const TEXT_EDITABLE: ReadonlySet<FileKind> = new Set<FileKind>(["markdown", "scad", "text"]);
