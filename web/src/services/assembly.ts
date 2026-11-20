import type { AssemblyReport, AssemblySpec } from "@drawer/shared/api";
import { assemblyReportSchema } from "@/core/schemas";
import { api, read } from "./api";

const proj = (slug: string) => `/projects/${encodeURIComponent(slug)}`;
const SLOW = { timeout: 180_000 };

/** 404 (`NotFoundError`) when the project has no assembly. */
export async function getAssembly(slug: string): Promise<AssemblyReport> {
  const { data } = await api.get<unknown>(`${proj(slug)}/assembly`, SLOW);
  return read(assemblyReportSchema, data);
}

export async function putAssembly(slug: string, spec: AssemblySpec): Promise<AssemblyReport> {
  const { data } = await api.put<unknown>(`${proj(slug)}/assembly`, spec, SLOW);
  return read(assemblyReportSchema, data);
}

export async function evaluateAssembly(slug: string): Promise<AssemblyReport> {
  const { data } = await api.post<unknown>(`${proj(slug)}/assembly/evaluate`, {}, SLOW);
  return read(assemblyReportSchema, data);
}
