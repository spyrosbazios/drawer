import type { RenderBody, RenderResult } from "@drawer/shared/api";
import { encodePath } from "@/core/paths";
import { renderResultSchema } from "@/core/schemas";
import { api, read } from "./api";

/** Renders can queue behind other renders and run up to the server's 120 s limit. */
export async function renderFile(slug: string, path: string, body: RenderBody = {}): Promise<RenderResult> {
  const { data } = await api.post<unknown>(`/projects/${encodeURIComponent(slug)}/render/${encodePath(path)}`, body, { timeout: 180_000 });
  return read(renderResultSchema, data);
}
