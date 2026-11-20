import type { FileKind, SearchHit } from "@drawer/shared/api";
import { searchSchema } from "@/core/schemas";
import { api, read } from "./api";

export interface SearchParams {
  q: string;
  kind?: FileKind;
  limit?: number;
}

/** Full-text search over one project (or the library); hit paths are project-relative. */
export async function searchProject(slug: string, params: SearchParams): Promise<SearchHit[]> {
  const { data } = await api.get<unknown>(`/projects/${encodeURIComponent(slug)}/search`, { params });
  return read(searchSchema, data).hits;
}
