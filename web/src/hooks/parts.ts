import type { CompareSide, DrawerEvent, ParamValues, PartSpecBody, PartSummary, PrintBody, SetParamsBody, WaiveBody } from "@drawer/shared/api";
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { deletePart, evaluatePart, getAttempts, getReport, listParts, putPart, recordPrint, restoreAttempt, setParams, waiveGate } from "@/services/parts";
import { compare } from "@/services/measure";
import { projectKeys } from "./projects";

/** Parameter values as a stable key: the same values in any order are one cache entry. */
export function paramsKey(params: ParamValues): string {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
}

const sideKey = (s: CompareSide) => `${s.part ?? ""}|${s.path ?? ""}|${s.at ?? ""}`;

export const partKeys = {
  list: (slug: string) => ["parts", slug] as const,
  /** Everything about one part: invalidating this prefix refreshes its reports and attempts. */
  part: (slug: string, id: string) => ["part", slug, id] as const,
  /** `at` undefined = the current report. */
  report: (slug: string, id: string, at?: string) => ["part", slug, id, "report", at ?? "head"] as const,
  whatIf: (slug: string, id: string, params: ParamValues) => ["part", slug, id, "what-if", paramsKey(params)] as const,
  attempts: (slug: string, id: string) => ["part", slug, id, "attempts"] as const,
  compare: (slug: string, a: CompareSide, b: CompareSide) => ["compare", slug, sideKey(a), sideKey(b)] as const,
};

export const partsQuery = (slug: string) => queryOptions({ queryKey: partKeys.list(slug), queryFn: () => listParts(slug) });

/** A report at an old revision never changes; the current one is refreshed by realtime `part` events. */
export const partReportQuery = (slug: string, id: string, at?: string) =>
  queryOptions({
    queryKey: partKeys.report(slug, id, at),
    queryFn: () => (at ? evaluatePart(slug, id, { at }) : getReport(slug, id)),
    staleTime: at ? Infinity : 30_000,
  });

export const attemptsQuery = (slug: string, id: string) => queryOptions({ queryKey: partKeys.attempts(slug, id), queryFn: () => getAttempts(slug, id) });

export const useParts = (slug: string) => useQuery(partsQuery(slug));

/** One part's summary, read from the list (no request of its own). */
export function usePartSummary(slug: string, id: string | undefined): PartSummary | undefined {
  const parts = useParts(slug);
  return id === undefined ? undefined : parts.data?.find((p) => p.id === id);
}

export const usePartReport = (slug: string, id: string | undefined, at?: string) => useQuery({ ...partReportQuery(slug, id ?? "", at), enabled: id !== undefined });

/**
 * A what-if report for parameter overrides (sliders). Nothing is written and the part's status does not
 * change. `params` undefined = no what-if; the previous result stays on screen while the next one runs.
 */
export const useWhatIf = (slug: string, id: string, params: ParamValues | undefined) =>
  useQuery({
    queryKey: partKeys.whatIf(slug, id, params ?? {}),
    queryFn: () => evaluatePart(slug, id, { params }),
    enabled: params !== undefined && Object.keys(params).length > 0,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

export const useAttempts = (slug: string, id: string | undefined) => useQuery({ ...attemptsQuery(slug, id ?? ""), enabled: id !== undefined });

/** How B differs from A. Both sides are fixed revisions or files, so a result never goes stale. */
export const useCompare = (slug: string, a: CompareSide | undefined, b: CompareSide | undefined) =>
  useQuery({
    queryKey: partKeys.compare(slug, a ?? {}, b ?? {}),
    queryFn: () => compare(slug, { a: a ?? {}, b: b ?? {} }),
    enabled: a !== undefined && b !== undefined,
    staleTime: Infinity,
    retry: false,
  });

function useInvalidatePart(slug: string) {
  const qc = useQueryClient();
  return (id: string) => invalidatePart(qc, slug, id);
}

function invalidatePart(qc: QueryClient, slug: string, id: string): void {
  void qc.invalidateQueries({ queryKey: partKeys.list(slug) });
  // What-ifs and old revisions do not depend on the current files' state, except through the spec.
  void qc.invalidateQueries({ queryKey: partKeys.part(slug, id) });
  void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
  void qc.invalidateQueries({ queryKey: projectKeys.list() });
  void qc.invalidateQueries({ queryKey: projectKeys.overview(slug) });
}

export function usePutPart(slug: string) {
  const invalidate = useInvalidatePart(slug);
  return useMutation({ mutationFn: (v: { id: string; body: PartSpecBody }) => putPart(slug, v.id, v.body), onSuccess: (_s, v) => invalidate(v.id) });
}

export function useDeletePart(slug: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidatePart(slug);
  return useMutation({
    mutationFn: (id: string) => deletePart(slug, id),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: partKeys.part(slug, id) });
      invalidate(id);
    },
  });
}

/** Re-evaluates now (the server joins a running evaluation) and stores the result as the current report. */
export function useEvaluatePart(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => evaluatePart(slug, id),
    onSuccess: (report, id) => qc.setQueryData(partKeys.report(slug, id), report),
  });
}

/** Writes parameter values into the model: one revision, then a new evaluation (arrives as a `part` event). */
export function useSetParams(slug: string) {
  const invalidate = useInvalidatePart(slug);
  return useMutation({ mutationFn: (v: { id: string } & SetParamsBody) => setParams(slug, v.id, { rev: v.rev, values: v.values, message: v.message }), onSuccess: (_r, v) => invalidate(v.id) });
}

/** A `ForbiddenError` means the server refused this author; the web app always sends "web". */
export function useWaiveGate(slug: string) {
  const invalidate = useInvalidatePart(slug);
  return useMutation({ mutationFn: (v: { id: string } & WaiveBody) => waiveGate(slug, v.id, { gate: v.gate, reason: v.reason }), onSuccess: (_r, v) => invalidate(v.id) });
}

export function useRecordPrint(slug: string) {
  const invalidate = useInvalidatePart(slug);
  return useMutation({ mutationFn: (v: { id: string } & PrintBody) => recordPrint(slug, v.id, { outcome: v.outcome, note: v.note, revisionId: v.revisionId }), onSuccess: (_r, v) => invalidate(v.id) });
}

export function useRestoreAttempt(slug: string) {
  const invalidate = useInvalidatePart(slug);
  return useMutation({ mutationFn: (v: { id: string; revisionId: string }) => restoreAttempt(slug, v.id, v.revisionId), onSuccess: (_r, v) => invalidate(v.id) });
}

// ---- realtime ------------------------------------------------------------------------------

type PartEvent = Extract<DrawerEvent, { type: "part" }>;

/** Patches the part's row at once (the "evaluating" spinner), and refreshes reports when an evaluation ends. */
export function applyPartEvent(qc: QueryClient, e: PartEvent): void {
  let known = false;
  qc.setQueryData<PartSummary[]>(partKeys.list(e.project), (old) =>
    old?.map((p) => {
      if (p.id !== e.part) return p;
      known = true;
      return { ...p, evaluating: e.evaluating, status: e.status ?? p.status, passed: e.passed, total: e.total };
    }),
  );
  if (e.evaluating) {
    if (!known) void qc.invalidateQueries({ queryKey: partKeys.list(e.project) });
    return;
  }
  invalidatePart(qc, e.project, e.part);
}
