import type { AssemblySpec, DrawerEvent } from "@drawer/shared/api";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { NotFoundError } from "@/services/api";
import { evaluateAssembly, getAssembly, putAssembly } from "@/services/assembly";
import { projectKeys } from "./projects";

export const assemblyKeys = {
  report: (slug: string) => ["assembly", slug] as const,
};

/** A project without an assembly answers 404: `data` is then null, not an error. */
export const assemblyQuery = (slug: string) =>
  queryOptions({
    queryKey: assemblyKeys.report(slug),
    queryFn: async () => {
      try {
        return await getAssembly(slug);
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
  });

export const useAssembly = (slug: string) => useQuery(assemblyQuery(slug));

export function usePutAssembly(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: AssemblySpec) => putAssembly(slug, spec),
    onSuccess: (report) => {
      qc.setQueryData(assemblyKeys.report(slug), report);
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.overview(slug) });
    },
  });
}

export function useEvaluateAssembly(slug: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => evaluateAssembly(slug), onSuccess: (report) => qc.setQueryData(assemblyKeys.report(slug), report) });
}

type AssemblyEvent = Extract<DrawerEvent, { type: "assembly" }>;

export function applyAssemblyEvent(qc: QueryClient, e: AssemblyEvent): void {
  if (e.evaluating) return;
  void qc.invalidateQueries({ queryKey: assemblyKeys.report(e.project) });
  void qc.invalidateQueries({ queryKey: projectKeys.detail(e.project) });
  void qc.invalidateQueries({ queryKey: projectKeys.list() });
  void qc.invalidateQueries({ queryKey: projectKeys.overview(e.project) });
}
