import type { ImportSource } from "@drawer/shared/api";

/** A file name from a remote site, made safe to place in a folder. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return clean === "" ? "file" : clean;
}

/** `name`, then `name-2.ext`, `name-3.ext`... until unused. Records the choice in `used`. */
export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"]);

export function imageExtension(url: string): string {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const dot = path.lastIndexOf(".");
    const ext = dot < 0 ? "" : path.slice(dot);
    return IMAGE_EXTENSIONS.has(ext) ? ext : ".jpg";
  } catch {
    return ".jpg";
  }
}

export const MAX_IMPORT_IMAGES = 8;

/** `source.md`: title as frontmatter, author/license/URL as fact lines, then the description. */
export function sourceMarkdown(source: ImportSource): string {
  const lines = ["---", `title: ${JSON.stringify(source.title)}`, "---", "", `# ${source.title}`, ""];
  if (source.author) lines.push(`- [author] ${source.author}`);
  if (source.license) lines.push(`- [license] ${source.license}`);
  lines.push(`- [source] ${source.url}`, `- [site] ${source.site}`, "");
  const description = source.description.trim();
  if (description !== "") lines.push("## Description", "", description, "");
  return lines.join("\n");
}
