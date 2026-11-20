import { posix } from "node:path";

/** `Content-Disposition` for downloading a file under its own name. */
export function attachmentHeader(path: string): string {
  const name = posix.basename(path);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Types a browser would execute or script when served from this origin. */
export function isActiveContent(path: string): boolean {
  return /\.(svg|html?|xml)$/i.test(path);
}
