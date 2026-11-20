import type {
  Attempt,
  EvaluateBody,
  PartReport,
  PartSpecBody,
  PartSummary,
  PrintBody,
  SetParamsBody,
  WaiveBody,
  WriteResult,
} from "@drawer/shared/api";
import { attemptsSchema, partReportSchema, partSummarySchema, partsSchema, revisionIdSchema, writeResultSchema } from "@/core/schemas";
import { api, read } from "./api";

const proj = (slug: string) => `/projects/${encodeURIComponent(slug)}`;
const part = (slug: string, id: string) => `${proj(slug)}/parts/${encodeURIComponent(id)}`;
/** Evaluations queue one part at a time and include a full render: as slow as a render. */
const SLOW = { timeout: 180_000 };

export async function listParts(slug: string): Promise<PartSummary[]> {
  const { data } = await api.get<unknown>(`${proj(slug)}/parts`);
  return read(partsSchema, data).parts;
}

/** Creates the part, or replaces what a client may set in its spec. */
export async function putPart(slug: string, id: string, body: PartSpecBody): Promise<PartSummary> {
  const { data } = await api.put<unknown>(part(slug, id), body);
  return read(partSummarySchema, data);
}

export async function deletePart(slug: string, id: string): Promise<string> {
  const { data } = await api.delete<unknown>(part(slug, id));
  return read(revisionIdSchema, data).revisionId;
}

/** The current report; waits for a running evaluation. */
export async function getReport(slug: string, id: string): Promise<PartReport> {
  const { data } = await api.get<unknown>(`${part(slug, id)}/report`, SLOW);
  return read(partReportSchema, data);
}

/** With `params`: a what-if report (`whatIf: true`), nothing written. With `at`: the part as of a revision. */
export async function evaluatePart(slug: string, id: string, body: EvaluateBody = {}): Promise<PartReport> {
  const { data } = await api.post<unknown>(`${part(slug, id)}/evaluate`, body, SLOW);
  return read(partReportSchema, data);
}

export async function setParams(slug: string, id: string, body: SetParamsBody): Promise<WriteResult> {
  const { data } = await api.post<unknown>(`${part(slug, id)}/params`, body);
  return read(writeResultSchema, data);
}

/** People only: the server answers 403 (`ForbiddenError`) for the author "agent". An empty reason removes the waiver. */
export async function waiveGate(slug: string, id: string, body: WaiveBody): Promise<PartSummary> {
  const { data } = await api.post<unknown>(`${part(slug, id)}/waive`, body);
  return read(partSummarySchema, data);
}

export async function recordPrint(slug: string, id: string, body: PrintBody): Promise<PartSummary> {
  const { data } = await api.post<unknown>(`${part(slug, id)}/prints`, body);
  return read(partSummarySchema, data);
}

/** Oldest first; `parent` makes them a tree. */
export async function getAttempts(slug: string, id: string): Promise<Attempt[]> {
  const { data } = await api.get<unknown>(`${part(slug, id)}/attempts`);
  return read(attemptsSchema, data).attempts;
}

export async function restoreAttempt(slug: string, id: string, revisionId: string): Promise<WriteResult> {
  const { data } = await api.post<unknown>(`${part(slug, id)}/restore`, { revisionId });
  return read(writeResultSchema, data);
}
