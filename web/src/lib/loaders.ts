import type { QueryClient } from "@tanstack/react-query";
import { assemblyQuery, hasAssembly } from "@/hooks/assembly";
import { fileTextQuery, infoQuery, treeQuery } from "@/hooks/files";
import { partReportQuery, partsQuery } from "@/hooks/parts";
import { projectQuery, projectsQuery } from "@/hooks/projects";
import { sessionsQuery } from "@/hooks/sessions";
import { TEXT_EDITABLE } from "@/core/kinds";
import type { ProjectSearch } from "./route-search";

/** Loaders only touch the query cache: the screen reads the same keys, so there is one cache and one freshness rule. */
export function homeLoader(qc: QueryClient): Promise<unknown> {
  void qc.prefetchQuery(sessionsQuery());
  return qc.ensureQueryData(projectsQuery());
}

/** Waits for the project and its tree (the outline's skeleton); everything else streams in. */
export async function projectLoader(qc: QueryClient, slug: string, search: Pick<ProjectSearch, "part" | "file" | "at">): Promise<void> {
  void qc.prefetchQuery(partsQuery(slug));
  void qc.prefetchQuery(sessionsQuery(slug));
  if (search.part) void qc.prefetchQuery(partReportQuery(slug, search.part, search.at));
  const [, tree] = await Promise.all([qc.ensureQueryData(projectQuery(slug)), qc.ensureQueryData(treeQuery(slug))]);
  if (hasAssembly(tree)) void qc.prefetchQuery(assemblyQuery(slug));
  const file = search.file;
  if (!file) return;
  void qc.prefetchQuery(infoQuery(slug, file));
  const entry = tree.find((e) => e.path === file);
  if (entry?.kind && TEXT_EDITABLE.has(entry.kind)) void qc.prefetchQuery(fileTextQuery(slug, file));
}
