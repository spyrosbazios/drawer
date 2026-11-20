import type { CreateProjectBody, PatchProjectBody, Project, ProjectOverview } from "@drawer/shared/api";
import { overviewSchema, projectSchema } from "@/core/schemas";
import { api, read } from "./api";

export async function listProjects(): Promise<Project[]> {
  const { data } = await api.get<{ projects?: unknown[] }>("/projects");
  // One malformed record is dropped; it must not blank the whole list.
  return (data.projects ?? []).flatMap((raw) => {
    const parsed = projectSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function getProject(slug: string): Promise<Project> {
  const { data } = await api.get<unknown>(`/projects/${encodeURIComponent(slug)}`);
  return read(projectSchema, data);
}

/** With `fromUrl` the server downloads the model before answering, which can take as long as an import. */
export async function createProject(body: CreateProjectBody): Promise<Project> {
  const { data } = await api.post<unknown>("/projects", body, body.fromUrl ? { timeout: 0 } : undefined);
  return read(projectSchema, data);
}

export async function patchProject(slug: string, body: PatchProjectBody): Promise<Project> {
  const { data } = await api.patch<unknown>(`/projects/${encodeURIComponent(slug)}`, body);
  return read(projectSchema, data);
}

export async function deleteProject(slug: string): Promise<void> {
  await api.delete(`/projects/${encodeURIComponent(slug)}`);
}

/** Brief, memory, parts, assembly, references, notes and the library in one read: what the outline draws. */
export async function getOverview(slug: string): Promise<ProjectOverview> {
  const { data } = await api.get<unknown>(`/projects/${encodeURIComponent(slug)}/overview`);
  return read(overviewSchema, data);
}
