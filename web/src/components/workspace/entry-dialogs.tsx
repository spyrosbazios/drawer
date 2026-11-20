import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { ResponsiveModal } from "@/components/responsive-modal";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { extOf, isValidRelPath, joinPath } from "@/core/paths";
import type { TreeNode } from "@/core/tree";
import { useDeleteEntry, useMoveEntry, useWriteFile } from "@/hooks/files";
import { drafts } from "@/lib/drafts";

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/** One text field and Save/Cancel: the shape every small file dialog shares. */
function PathForm({
  label,
  hint,
  initial,
  submitLabel,
  existing,
  onSubmit,
  onCancel,
  pending,
  selectName,
}: {
  label: string;
  hint: string;
  initial: string;
  submitLabel: string;
  existing: ReadonlySet<string>;
  onSubmit: (path: string) => void;
  onCancel: () => void;
  pending: boolean;
  /** Select only the file name part on focus, so typing replaces the name and keeps the folder. */
  selectName?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  const error = path === "" ? null : !isValidRelPath(path) ? "That is not a valid path (no empty, . or .. parts)" : path !== initial && existing.has(path) ? "Something already exists at this path" : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (path !== "" && !error) onSubmit(path);
  };
  return (
    <form onSubmit={submit} className="space-y-4 pb-2">
      <Field data-invalid={error !== null}>
        <FieldLabel htmlFor="entry-path">{label}</FieldLabel>
        <Input
          id="entry-path"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono"
          value={value}
          aria-invalid={error !== null}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => {
            if (!selectName) return;
            const slash = e.target.value.lastIndexOf("/") + 1;
            const dot = e.target.value.lastIndexOf(".");
            e.target.setSelectionRange(slash, dot > slash ? dot : e.target.value.length);
          }}
        />
        <FieldDescription>{hint}</FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || path === "" || error !== null || path === initial}>
          {pending ? "Working" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

interface Common {
  slug: string;
  existing: ReadonlySet<string>;
}

export function NewFileDialog({ slug, existing, folder, open, onOpenChange, onCreated }: Common & { folder: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (path: string) => void }) {
  const write = useWriteFile(slug);
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} title="New file" description="Created empty, then opened for editing." className="sm:max-w-md">
      {open && (
        <PathForm
          label="Path"
          hint={folder === "" ? "Relative to the project root, e.g. notes/ideas.md" : `In ${folder}/`}
          initial={folder === "" ? "" : `${folder}/`}
          submitLabel="Create file"
          existing={existing}
          pending={write.isPending}
          onCancel={() => onOpenChange(false)}
          onSubmit={(path) => {
            const body = extOf(path) === ".md" ? `# ${path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")}\n` : "";
            write.mutate(
              { path, body, message: `Create ${path}` },
              {
                onSuccess: () => {
                  onOpenChange(false);
                  onCreated(path);
                },
                onError: (err) => toast.error(message(err, "Could not create the file")),
              },
            );
          }}
        />
      )}
    </ResponsiveModal>
  );
}

export function NewFolderDialog({ slug, existing, folder, open, onOpenChange }: Common & { folder: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const write = useWriteFile(slug);
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} title="New folder" description="A folder exists while it holds a file, so an empty .gitkeep is added." className="sm:max-w-md">
      {open && (
        <PathForm
          label="Folder path"
          hint="Relative to the project root, e.g. refs/datasheets"
          initial={folder === "" ? "" : `${folder}/`}
          submitLabel="Create folder"
          existing={existing}
          pending={write.isPending}
          onCancel={() => onOpenChange(false)}
          onSubmit={(path) =>
            write.mutate(
              { path: joinPath(path, ".gitkeep"), body: "", message: `Create folder ${path}` },
              { onSuccess: () => onOpenChange(false), onError: (err) => toast.error(message(err, "Could not create the folder")) },
            )
          }
        />
      )}
    </ResponsiveModal>
  );
}

export function RenameDialog({
  slug,
  existing,
  node,
  onClose,
  onMoved,
}: Common & { node: TreeNode | null; onClose: () => void; onMoved: (from: string, to: string) => void }) {
  const move = useMoveEntry(slug);
  return (
    <ResponsiveModal open={node !== null} onOpenChange={(o) => !o && onClose()} title={node?.type === "dir" ? "Rename or move folder" : "Rename or move file"} description="Change the name, or the folder part of the path to move it." className="sm:max-w-md">
      {node && (
        <PathForm
          label="New path"
          hint="Parent folders are created as needed."
          initial={node.path}
          submitLabel="Move"
          existing={existing}
          pending={move.isPending}
          selectName
          onCancel={onClose}
          onSubmit={(to) =>
            move.mutate(
              { from: node.path, to },
              {
                onSuccess: () => {
                  onMoved(node.path, to);
                  onClose();
                },
                onError: (err) => toast.error(message(err, "Could not move")),
              },
            )
          }
        />
      )}
    </ResponsiveModal>
  );
}

export function DeleteEntryDialog({ slug, node, onClose, onDeleted }: { slug: string; node: TreeNode | null; onClose: () => void; onDeleted: (path: string, type: "file" | "dir") => void }) {
  const del = useDeleteEntry(slug);
  return (
    <AlertDialog open={node !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {node?.type === "dir" ? "folder" : "file"}?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono break-all">{node?.path}</span>
            {node?.type === "dir" ? " and everything inside it will be removed." : " will be removed."} The server keeps the history, but this cannot be undone from here.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={del.isPending}
            onClick={(e) => {
              e.preventDefault();
              if (!node) return;
              del.mutate(
                { path: node.path, type: node.type, rev: node.entry?.rev },
                {
                  onSuccess: () => {
                    drafts.clearUnder(slug, node.path);
                    onDeleted(node.path, node.type);
                    onClose();
                  },
                  onError: (err) => toast.error(message(err, "Could not delete")),
                },
              );
            }}
          >
            {del.isPending ? "Deleting" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
