import { LIBRARY_SLUG } from "@drawer/shared/api";
import type { MaterialsFile, PrinterProfile } from "@drawer/shared/api";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useFileText, useWriteFile } from "@/hooks/files";
import { libraryKeys } from "@/hooks/library";
import { ConflictError, InvalidError } from "@/services/api";
import { toFileText } from "./library-model";

/** Shared by the printer and materials sections: a library JSON file read with its rev, saved against it. */

export const firstError = (errors: readonly unknown[]): string | undefined =>
  errors.map((x) => (typeof x === "string" ? x : typeof x === "object" && x !== null && "message" in x && typeof x.message === "string" ? x.message : undefined)).find(Boolean);

/** Reads a library file and saves it with the rev it was read at; `save` returns an error message or null. */
export function useLibraryFile(path: string) {
  const write = useWriteFile(LIBRARY_SLUG);
  const qc = useQueryClient();
  const file = useFileText(LIBRARY_SLUG, path);
  const save = async (value: PrinterProfile | MaterialsFile, message: string): Promise<string | null> => {
    try {
      await write.mutateAsync({ path, body: toFileText(value), rev: file.data?.rev, message });
      void qc.invalidateQueries({ queryKey: libraryKeys.profile() });
      return null;
    } catch (err) {
      if (err instanceof ConflictError) {
        void file.refetch();
        return "Changed elsewhere. Reload and make the change again.";
      }
      if (err instanceof InvalidError) return err.message;
      return err instanceof Error ? err.message : "Could not save";
    }
  };
  return { file, save };
}


/** Loading, a read error, or a file that is not the expected shape (then no form is offered). */
export function FileState({ loading, error, broken, path }: { loading: boolean; error: Error | null; broken: boolean; path: string }) {
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (error) return <p className="text-sm text-down">{error.message}</p>;
  if (broken)
    return (
      <p className="text-sm text-down">
        <Link to="/p/$slug" params={{ slug: LIBRARY_SLUG }} search={{ file: path }} className="underline">
          {path}
        </Link>{" "}
        is not valid.
      </p>
    );
  return null;
}

/** The save button and the server's answer. */
export function SaveRow({ submitting, dirty, error, saved, onDiscard }: { submitting: boolean; dirty: boolean; error: string | null; saved: boolean; onDiscard: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error && (
        <p role="alert" className="mr-auto text-sm text-down">
          {error}
        </p>
      )}
      {!error && saved && !dirty && <p className="mr-auto text-sm text-up">Saved</p>}
      <Button type="button" variant="ghost" disabled={!dirty || submitting} onClick={onDiscard}>
        Discard
      </Button>
      <Button type="submit" disabled={!dirty || submitting}>
        {submitting ? "Saving" : "Save"}
      </Button>
    </div>
  );
}
