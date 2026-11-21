import type { ScanQuery } from "@drawer/shared/api";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Query } from "@tanstack/react-query";
import { isAtOrUnder } from "@/core/paths";
import { addScan, deleteDir, deleteFile, getHistory, getInfo, getTree, moveFile, readText, writeFile } from "@/services/files";
import type { WriteOptions } from "@/services/files";
import { projectKeys } from "./projects";

export const fileKeys = {
  tree: (slug: string) => ["tree", slug] as const,
  text: (slug: string, path: string, at?: string) => ["file", slug, path, at ?? ""] as const,
  info: (slug: string, path: string) => ["info", slug, path] as const,
  history: (slug: string, path?: string) => ["history", slug, path ?? ""] as const,
};

export const treeQuery = (slug: string) => queryOptions({ queryKey: fileKeys.tree(slug), queryFn: () => getTree(slug) });

/** File text is owned by the editor's draft logic, so it never refetches by itself; realtime invalidates it. */
export const fileTextQuery = (slug: string, path: string, at?: string) =>
  queryOptions({
    queryKey: fileKeys.text(slug, path, at),
    queryFn: () => readText(slug, path, at),
    staleTime: at ? Infinity : 30_000,
    refetchOnWindowFocus: false,
  });

export const infoQuery = (slug: string, path: string) => queryOptions({ queryKey: fileKeys.info(slug, path), queryFn: () => getInfo(slug, path) });
export const historyQuery = (slug: string, path?: string) =>
  queryOptions({ queryKey: fileKeys.history(slug, path), queryFn: () => getHistory(slug, path) });

export const useTree = (slug: string) => useQuery(treeQuery(slug));
export const useFileText = (slug: string, path: string, at?: string) => useQuery(fileTextQuery(slug, path, at));
export const useFileInfo = (slug: string, path: string | undefined) =>
  useQuery({ ...infoQuery(slug, path ?? ""), enabled: path !== undefined });
export const useHistory = (slug: string, path?: string) => useQuery(historyQuery(slug, path));

/** Matches queries keyed `[kind, slug, path]` whose path is not `gone` and does not lie inside it. */
export const notAtOrUnder = (gone: string) => (q: Query) => !(typeof q.queryKey[2] === "string" && isAtOrUnder(q.queryKey[2], gone));

/**
 * After any write the tree, infos and history of the project are stale; so is the project's file count.
 * `gone` is a path that no longer exists (a deleted or moved file or folder): its text and info are left
 * alone, because the viewer still showing it until the address changes would refetch them into 404s.
 */
function useInvalidateProject(slug: string) {
  const qc = useQueryClient();
  return (gone?: string) => {
    const keep = gone === undefined ? undefined : notAtOrUnder(gone);
    void qc.invalidateQueries({ queryKey: fileKeys.tree(slug) });
    void qc.invalidateQueries({ queryKey: ["info", slug], predicate: keep });
    void qc.invalidateQueries({ queryKey: ["history", slug] });
    void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    void qc.invalidateQueries({ queryKey: projectKeys.list() });
    void qc.invalidateQueries({ queryKey: projectKeys.overview(slug) });
  };
}

export function useWriteFile(slug: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateProject(slug);
  return useMutation({
    mutationFn: (v: { path: string; body: string | Blob } & WriteOptions) => writeFile(slug, v.path, v.body, { rev: v.rev, message: v.message }),
    onSuccess: (res, v) => {
      if (typeof v.body === "string") qc.setQueryData(fileKeys.text(slug, v.path), { text: v.body, rev: res.rev });
      else void qc.invalidateQueries({ queryKey: ["file", slug, v.path] });
      invalidate();
    },
  });
}

export function useDeleteEntry(slug: string) {
  const invalidate = useInvalidateProject(slug);
  return useMutation({
    mutationFn: (v: { path: string; type: "file" | "dir"; rev?: string }) =>
      v.type === "dir" ? deleteDir(slug, v.path) : deleteFile(slug, v.path, v.rev ?? ""),
    onSuccess: (_void, v) => invalidate(v.path),
  });
}

export function useMoveEntry(slug: string) {
  const invalidate = useInvalidateProject(slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { from: string; to: string }) => moveFile(slug, v.from, v.to),
    onSuccess: (_void, v) => {
      void qc.invalidateQueries({ queryKey: ["file", slug], predicate: notAtOrUnder(v.from) });
      invalidate(v.from);
    },
  });
}

export interface UploadItem {
  path: string;
  file: File;
}

/** Uploads files one after another; existing paths are overwritten (`x-drawer-rev: *`), new ones created. */
export function useUploadFiles() {
  const qc = useQueryClient();
  return async (slug: string, items: UploadItem[], existing: ReadonlySet<string>, onProgress: (done: number, total: number) => void): Promise<void> => {
    let done = 0;
    onProgress(0, items.length);
    try {
      for (const item of items) {
        await writeFile(slug, item.path, item.file, { rev: existing.has(item.path) ? "*" : undefined, message: `Upload ${item.file.name}` });
        void qc.invalidateQueries({ queryKey: ["file", slug, item.path] });
        done++;
        onProgress(done, items.length);
      }
    } finally {
      for (const key of [fileKeys.tree(slug), ["info", slug], ["history", slug], projectKeys.detail(slug), projectKeys.list(), projectKeys.overview(slug)]) void qc.invalidateQueries({ queryKey: key });
    }
  };
}


export function useAddScan(slug: string) {
  const qc = useQueryClient();
  return async (query: ScanQuery, file: File) => {
    const scan = await addScan(slug, query, file);
    for (const key of [fileKeys.tree(slug), ["info", slug], ["history", slug], projectKeys.detail(slug), projectKeys.list(), projectKeys.overview(slug)]) {
      void qc.invalidateQueries({ queryKey: key });
    }
    return scan;
  };
}
