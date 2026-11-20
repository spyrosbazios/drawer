import type { FileKind } from "@drawer/shared/api";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { searchProject } from "@/services/search";

export const searchKeys = {
  project: (slug: string) => ["search", slug] as const,
  query: (slug: string, q: string, kind?: FileKind) => ["search", slug, q, kind ?? null] as const,
};

export const projectSearchQuery = (slug: string, q: string, kind?: FileKind) =>
  queryOptions({ queryKey: searchKeys.query(slug, q, kind), queryFn: () => searchProject(slug, { q, kind, limit: 20 }), staleTime: 15_000 });

/** Searches one project once the query has two characters; keeps the last hits while the next ones load. */
export const useProjectSearch = (slug: string, q: string, kind?: FileKind) =>
  useQuery({ ...projectSearchQuery(slug, q.trim(), kind), enabled: q.trim().length >= 2, placeholderData: keepPreviousData });
