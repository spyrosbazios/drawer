import type { ImportCredentials } from "@drawer/shared/contracts";
import type { ImportFile, ImportPreview, ImportSite } from "@drawer/shared/api";
import type { Http } from "../http";

/** What every site module receives. */
export interface SiteContext {
  http: Http;
  creds: ImportCredentials;
}

/** One module per site. `download` is only called for files this site's `preview` listed as downloadable. */
export interface SiteModule {
  preview(url: string): Promise<ImportPreview>;
  download(url: string, file: ImportFile, destPath: string): Promise<void>;
}

export function emptyPreview(site: ImportSite, url: string, title: string, blocker: string | null): ImportPreview {
  return {
    source: { site, url, title, author: null, license: null, description: "", images: [] },
    files: [],
    blocker,
  };
}

/** Drops duplicates and blanks, keeps order. */
export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    const s = v?.trim();
    if (s) seen.add(s);
  }
  return [...seen];
}

/** A file name that is safe as a single path segment. */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || fallback;
}

export function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
