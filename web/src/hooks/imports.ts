import type { ImportBody } from "@drawer/shared/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { importInto, previewImport } from "@/services/imports";
import { fileKeys } from "./files";
import { projectKeys } from "./projects";

export const usePreviewImport = () => useMutation({ mutationFn: (url: string) => previewImport(url) });

export function useImportInto(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportBody) => importInto(slug, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: fileKeys.tree(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}
