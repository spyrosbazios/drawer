import type { ImportBody, ImportPreview, ImportResult } from "@drawer/shared/api";
import { importPreviewSchema, importResultSchema } from "@/core/schemas";
import { api, read } from "./api";

export async function previewImport(url: string): Promise<ImportPreview> {
  const { data } = await api.post<unknown>("/import/preview", { url }, { timeout: 90_000 });
  return read(importPreviewSchema, data);
}

export async function importInto(slug: string, body: ImportBody): Promise<ImportResult> {
  const { data } = await api.post<unknown>(`/projects/${encodeURIComponent(slug)}/import`, body, { timeout: 0 });
  return read(importResultSchema, data);
}
