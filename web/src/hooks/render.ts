import type { RenderBody, RenderResult } from "@drawer/shared/api";
import { keepPreviousData, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { renderFile } from "@/services/render";

export const renderKeys = {
  /** The most recent successful render of a file: what stays on screen while the next one runs or fails. */
  last: (slug: string, path: string, at: string | undefined) => ["render-last", slug, path, at ?? "head"] as const,
  of: (slug: string, path: string, at: string | undefined, rev: string) => ["render", slug, path, at ?? "head", rev] as const,
};

/**
 * Renders on demand, and (with `auto`) automatically once per saved revision. The result lives in the query cache,
 * so switching selections keeps it; `refetch` (the Render button) renders again. The server caches by content,
 * so asking twice for the same thing is cheap.
 */
export function useRender(slug: string, path: string, rev: string | undefined, at?: string, auto = true) {
  const qc = useQueryClient();
  const body: RenderBody = at ? { at } : {};
  const query = useQuery({
    queryKey: renderKeys.of(slug, path, at, rev ?? ""),
    queryFn: async () => {
      const result = await renderFile(slug, path, body);
      qc.setQueryData(renderKeys.last(slug, path, at), result);
      return result;
    },
    enabled: false,
    retry: false,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    placeholderData: keepPreviousData,
  });
  const { data, error, isFetching, isPlaceholderData, refetch } = query;
  const needed = auto && rev !== undefined && (data === undefined || isPlaceholderData) && error === null && !isFetching;
  useEffect(() => {
    if (needed) void refetch();
  }, [needed, refetch]);
  // skipToken: read the cache only, never fetch.
  const last = useQuery<RenderResult>({ queryKey: renderKeys.last(slug, path, at), queryFn: skipToken, gcTime: 30 * 60_000 });
  return { query, result: data ?? last.data };
}
