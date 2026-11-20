import { useState } from "react";
import { toast } from "sonner";
import { ResponsiveModal } from "@/components/responsive-modal";
import { Button } from "@/components/ui/button";
import { UrlImport } from "@/components/new-project/url-import";
import { useImportInto, usePreviewImport } from "@/hooks/imports";

/** Import a model link into the open project: files land under refs/<name>/. */
export function ImportDialog({ slug, open, onOpenChange, onImported }: { slug: string; open: boolean; onOpenChange: (open: boolean) => void; onImported: (dir: string) => void }) {
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} title="Import from URL" description="Downloads the model files, images and a source.md into refs/." className="sm:max-w-2xl">
      {open && <ImportForm slug={slug} onClose={() => onOpenChange(false)} onImported={onImported} />}
    </ResponsiveModal>
  );
}

function ImportForm({ slug, onClose, onImported }: { slug: string; onClose: () => void; onImported: (dir: string) => void }) {
  const preview = usePreviewImport();
  const run = useImportInto(slug);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const doImport = () =>
    run.mutate(
      { url: url.trim(), fileIds: [...selected] },
      {
        onSuccess: (res) => {
          const skipped = res.skipped.length;
          toast.success(`Imported ${res.written.length} files into ${res.dir}${skipped > 0 ? `, ${skipped} skipped` : ""}`);
          onImported(res.dir);
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );

  return (
    <div className="space-y-4 pb-2">
      <UrlImport
        url={url}
        onUrlChange={(v) => {
          setUrl(v);
          preview.reset();
        }}
        onPreview={() =>
          preview.mutate(url.trim(), {
            onSuccess: (p) => setSelected(new Set(p.files.filter((f) => f.downloadable).map((f) => f.id))),
          })
        }
        pending={preview.isPending}
        error={preview.error?.message ?? null}
        preview={preview.data}
        selected={selected}
        onSelectedChange={setSelected}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={run.isPending}>
          Cancel
        </Button>
        <Button onClick={doImport} disabled={!preview.data || run.isPending}>
          {run.isPending ? "Importing" : "Import"}
        </Button>
      </div>
    </div>
  );
}
