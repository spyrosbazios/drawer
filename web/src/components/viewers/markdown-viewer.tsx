import { PencilIcon, BookOpenIcon } from "lucide-react";
import { Suspense } from "react";
import type { Link as FileLink } from "@drawer/shared/api";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useFileInfo } from "@/hooks/files";
import { useEditableFile } from "@/hooks/use-editable-file";
import { fileUrl } from "@/services/files";
import { detailScroll } from "@/lib/scroll";
import { ConflictBanner } from "./conflict-banner";
import { SaveButton } from "./save-button";
import { ViewerMenubar, downloadMenu } from "./viewer-menubar";
import { CodeEditor, MarkdownReader, ViewerSkeleton } from "./viewer-parts";

interface Props {
  slug: string;
  path: string;
  at: string | undefined;
  edit: boolean;
  onEdit: (edit: boolean) => void;
  onOpenLink: (link: FileLink) => void;
}

/** A rendered reader with an Edit toggle. Facts become coloured chips, `[[links]]` clickable chips. */
export function MarkdownViewer({ slug, path, at, edit, onEdit, onOpenLink }: Props) {
  const file = useEditableFile(slug, path, at);
  const info = useFileInfo(slug, at ? undefined : path);
  const save = () => void file.save();
  const editing = edit && !file.readOnly;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerMenubar
        label="Note"
        menus={[downloadMenu(fileUrl(slug, path, { at, download: true }))]}
        tools={
          !file.readOnly && (
            <ToggleGroup type="single" size="sm" variant="outline" value={editing ? "edit" : "read"} onValueChange={(v) => v && onEdit(v === "edit")} aria-label="Reader or editor">
              <ToggleGroupItem value="read" className="gap-1.5 px-2.5">
                <BookOpenIcon /> Read
              </ToggleGroupItem>
              <ToggleGroupItem value="edit" className="gap-1.5 px-2.5">
                <PencilIcon /> Edit
              </ToggleGroupItem>
            </ToggleGroup>
          )
        }
        status={file.readOnly ? null : <SaveButton dirty={file.dirty} saving={file.saving} onSave={save} />}
      />
      {file.changedElsewhere && <ConflictBanner onReload={file.reload} onKeepMine={() => void file.keepMine()} />}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-contain" data-scroll-restoration-id={detailScroll(`${slug}/${path}/${editing ? "e" : "r"}`)}>
        {file.query.isPending ? (
          <ViewerSkeleton />
        ) : file.query.isError && !file.query.data ? (
          <p className="p-4 text-sm text-down">{file.query.error.message}</p>
        ) : (
          <Suspense fallback={<ViewerSkeleton />}>
            {editing ? (
              <CodeEditor value={file.text} language="markdown" wrap onChange={file.onChange} onSave={save} />
            ) : (
              <MarkdownReader text={file.text} outgoing={info.data?.outgoing ?? []} onOpenLink={onOpenLink} />
            )}
          </Suspense>
        )}
      </div>
    </div>
  );
}
