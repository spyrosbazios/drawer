import { HEADER_MESSAGE, HEADER_REV } from "@drawer/shared/api";
import type { FileInfo, HistoryResponse, TreeEntry, WriteResult } from "@drawer/shared/api";
import { fileInfoSchema, historySchema, treeSchema, writeResultSchema } from "@/core/schemas";
import { encodePath } from "@/core/paths";
import { api, read } from "./api";

const proj = (slug: string) => `/projects/${encodeURIComponent(slug)}`;

export async function getTree(slug: string): Promise<TreeEntry[]> {
  const { data } = await api.get<unknown>(`${proj(slug)}/tree`);
  return read(treeSchema, data).entries;
}

export interface FileText {
  text: string;
  rev: string;
}

/** Raw bytes of a file, as text. `at` reads a past revision. */
export async function readText(slug: string, path: string, at?: string): Promise<FileText> {
  const res = await api.get<string>(`${proj(slug)}/files/${encodePath(path)}`, {
    params: at ? { at } : undefined,
    responseType: "text",
    transformResponse: (d: string) => d,
  });
  return { text: res.data, rev: String(res.headers[HEADER_REV] ?? "") };
}

/** A URL a browser element (img, iframe, three.js loader, download link) can load directly. */
export function fileUrl(slug: string, path: string, opts: { at?: string; download?: boolean; version?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.at) q.set("at", opts.at);
  if (opts.download) q.set("download", "1");
  if (opts.version && !opts.at) q.set("v", opts.version);
  const s = q.toString();
  return `/api${proj(slug)}/files/${encodePath(path)}${s ? `?${s}` : ""}`;
}

export interface WriteOptions {
  /** The rev the caller read. Omit to create; `*` to overwrite whatever is there. */
  rev?: string;
  message?: string;
}

export async function writeFile(slug: string, path: string, body: string | Blob, opts: WriteOptions = {}): Promise<WriteResult> {
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (opts.rev) headers[HEADER_REV] = opts.rev;
  if (opts.message) headers[HEADER_MESSAGE] = encodeURIComponent(opts.message);
  const { data } = await api.put<unknown>(`${proj(slug)}/files/${encodePath(path)}`, body, { headers, timeout: 0 });
  return read(writeResultSchema, data);
}

export async function deleteFile(slug: string, path: string, rev: string): Promise<void> {
  await api.delete(`${proj(slug)}/files/${encodePath(path)}`, { headers: { [HEADER_REV]: rev } });
}

export async function deleteDir(slug: string, path: string): Promise<void> {
  await api.delete(`${proj(slug)}/files/${encodePath(path)}`, { params: { recursive: 1 } });
}

export async function moveFile(slug: string, from: string, to: string): Promise<void> {
  await api.post(`${proj(slug)}/move`, { from, to });
}

export async function getInfo(slug: string, path: string): Promise<FileInfo> {
  const { data } = await api.get<unknown>(`${proj(slug)}/info/${encodePath(path)}`);
  return read(fileInfoSchema, data);
}

export async function getHistory(slug: string, path?: string, limit = 50): Promise<HistoryResponse["revisions"]> {
  const { data } = await api.get<unknown>(`${proj(slug)}/history`, { params: { path, limit } });
  return read(historySchema, data).revisions;
}
