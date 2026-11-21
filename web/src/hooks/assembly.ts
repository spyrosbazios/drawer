import { ASSEMBLY_FILE } from "@drawer/shared/api";
import type { AssemblyReport, AssemblySpec, DrawerEvent, TreeEntry } from "@drawer/shared/api";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { NotFoundError } from "@/services/api";
import { evaluateAssembly, getAssembly, putAssembly } from "@/services/assembly";
import { useTree } from "./files";
import { projectKeys } from "./projects";

export const assemblyKeys = {
  report: (slug: string) => ["assembly", slug] as const,
};

/** Whether the project's tree lists an assembly file: what decides if the report is worth asking for. */
export const hasAssembly = (entries: readonly TreeEntry[]): boolean => entries.some((e) => e.type === "file" && e.path === ASSEMBLY_FILE);

/** The report of an assembly the tree says exists; the file deleted in the meantime answers 404, which reads as none. */
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

/** `ready` with `data: null` = the project has no assembly (known from its tree, so nothing is requested). */
export type AssemblyState = { status: "pending" } | { status: "error"; error: Error } | { status: "ready"; data: AssemblyReport | null; refreshing: boolean };

/**
 * The project's assembly report. The tree (already loaded for the outline) says whether `assembly.json`
 * exists; the report is requested only then, and as soon as the file appears (its `file` event refreshes the
 * tree) so a project without an assembly never makes a request that can only fail.
 */
export function useAssembly(slug: string): AssemblyState {
  const tree = useTree(slug);
  const present = tree.data === undefined ? undefined : hasAssembly(tree.data);
  const q = useQuery({ ...assemblyQuery(slug), enabled: present === true });
  if (tree.isError) return { status: "error", error: tree.error };
  if (present === undefined) return { status: "pending" };
  if (!present) return { status: "ready", data: null, refreshing: false };
  if (q.isError) return { status: "error", error: q.error };
  if (q.isPending) return { status: "pending" };
  return { status: "ready", data: q.data, refreshing: q.isFetching };
}

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
