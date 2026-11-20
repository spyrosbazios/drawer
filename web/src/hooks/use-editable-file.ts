import { useState } from "react";
import { toast } from "sonner";
import { DraftStore } from "@/core/drafts";
import { useFileText, useWriteFile } from "@/hooks/files";
import { drafts, useDraft } from "@/lib/drafts";
import { ConflictError } from "@/services/api";

/**
 * Everything an editor of one file needs: the server text, the user's unsaved draft, saving with the
 * rev guard, and the "changed elsewhere" state. Drafts live outside React (core/drafts.ts), so switching
 * selections never loses edits. A clean editor follows the server silently; a dirty one never overwrites the
 * user's text, it raises `changedElsewhere` and lets them choose.
 */
export function useEditableFile(slug: string, path: string, at?: string) {
  const query = useFileText(slug, path, at);
  const draft = useDraft(slug, path);
  const write = useWriteFile(slug);
  const [conflicted, setConflicted] = useState(false);

  const key = DraftStore.key(slug, path);
  const data = query.data;
  const readOnly = at !== undefined;
  const dirty = !readOnly && draft !== undefined;
  const text = dirty ? draft.text : (data?.text ?? "");
  const changedElsewhere = dirty && (conflicted || (data !== undefined && draft.baseRev !== data.rev));

  const onChange = (next: string) => {
    if (data && !readOnly) drafts.edit(key, next, { text: data.text, rev: data.rev });
  };

  const save = async (): Promise<boolean> => {
    if (!draft || readOnly) return false;
    try {
      await write.mutateAsync({ path, body: draft.text, rev: draft.baseRev });
      drafts.clear(key);
      setConflicted(false);
      return true;
    } catch (err) {
      if (err instanceof ConflictError) {
        setConflicted(true);
        void query.refetch();
      } else {
        toast.error(err instanceof Error ? err.message : "Could not save");
      }
      return false;
    }
  };

  /** Discard my edits and show what is on the server. */
  const reload = () => {
    drafts.clear(key);
    setConflicted(false);
    void query.refetch();
  };

  /** Keep my text, based on the newest server version: the next save overwrites it deliberately. */
  const keepMine = async () => {
    const fresh = (await query.refetch()).data;
    if (fresh) drafts.rebase(key, { text: fresh.text, rev: fresh.rev });
    setConflicted(false);
  };

  return {
    query,
    text,
    rev: data?.rev,
    readOnly,
    dirty,
    saving: write.isPending,
    changedElsewhere,
    onChange,
    save,
    reload,
    keepMine,
  };
}

export type EditableFile = ReturnType<typeof useEditableFile>;
