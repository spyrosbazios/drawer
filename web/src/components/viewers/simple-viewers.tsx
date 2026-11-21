import { PencilIcon, EyeIcon } from "lucide-react";
import { Suspense } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useEditableFile } from "@/hooks/use-editable-file";
import { fileUrl } from "@/services/files";
import { ConflictBanner } from "./conflict-banner";
import { SaveButton } from "./save-button";
import { ViewerMenubar, downloadMenu } from "./viewer-menubar";
import { CodeEditor, ViewerSkeleton } from "./viewer-parts";

interface Common {
  slug: string;
  path: string;
  at: string | undefined;
  rev: string | undefined;
}

export function ImageViewer({ slug, path, at, rev }: Common) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerMenubar label="Image viewer" menus={[downloadMenu(fileUrl(slug, path, { at, download: true }))]} />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-card p-3">
        <img src={fileUrl(slug, path, { at, version: rev })} alt={path} className="max-h-full max-w-full object-contain" />
      </div>
    </div>
  );
}

export function PdfViewer({ slug, path, at, rev }: Common) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerMenubar label="PDF viewer" menus={[downloadMenu(fileUrl(slug, path, { at, download: true }))]} />
      <iframe title={path} src={fileUrl(slug, path, { at, version: rev })} className="min-h-0 flex-1 border-0 bg-card" />
    </div>
  );
}

/** A code view: read-only until Edit is toggled on. */
export function TextViewer({ slug, path, at, edit, onEdit }: Common & { edit: boolean; onEdit: (edit: boolean) => void }) {
  const file = useEditableFile(slug, path, at);
  const editing = edit && !file.readOnly;
  const save = () => void file.save();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerMenubar
        label="Text viewer"
        menus={[downloadMenu(fileUrl(slug, path, { at, download: true }))]}
        tools={
          !file.readOnly && (
            <ToggleGroup type="single" size="sm" variant="outline" value={editing ? "edit" : "view"} onValueChange={(v) => v && onEdit(v === "edit")} aria-label="Viewer or editor">
              <ToggleGroupItem value="view" className="gap-1.5 px-2.5">
                <EyeIcon /> View
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
      <div className="min-h-0 flex-1">
        {file.query.isPending ? (
          <ViewerSkeleton />
        ) : file.query.isError && !file.query.data ? (
          <p className="p-4 text-sm text-down">{file.query.error.message}</p>
        ) : (
          <Suspense fallback={<ViewerSkeleton />}>
            <CodeEditor value={file.text} language="text" readOnly={!editing} onChange={file.onChange} onSave={save} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
