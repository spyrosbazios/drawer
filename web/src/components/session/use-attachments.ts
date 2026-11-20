import { useState } from "react";
import { useUploadAttachment } from "@/hooks/sessions";
import { addDraftFiles, removeDraftFile, retryDraftFile, useDraftFiles } from "./composer-drafts";

/** The files of a draft: the list, adding (uploads start at once), removing (aborts), retrying, and the note about what was left out. */
export function useAttachments(slug: string, key: string) {
  const upload = useUploadAttachment(slug);
  const files = useDraftFiles(key);
  const [notice, setNotice] = useState<string | null>(null);
  return {
    files,
    notice,
    add: (list: readonly File[]) => setNotice(addDraftFiles(key, list, (v) => upload.mutateAsync(v))),
    remove: (id: string) => {
      setNotice(null);
      removeDraftFile(key, id);
    },
    retry: retryDraftFile,
  };
}

export type Attachments = ReturnType<typeof useAttachments>;
