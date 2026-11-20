import type { ImportPreview } from "@drawer/shared/api";
import { LinkIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/core/format";
import { cn } from "@/lib/utils";

interface UrlImportProps {
  url: string;
  onUrlChange: (url: string) => void;
  onPreview: () => void;
  pending: boolean;
  error: string | null;
  preview: ImportPreview | undefined;
  selected: ReadonlySet<string>;
  onSelectedChange: (ids: Set<string>) => void;
}

/** Paste a model link, see what the site offers, tick the files to download. */
export function UrlImport({ url, onUrlChange, onPreview, pending, error, preview, selected, onSelectedChange }: UrlImportProps) {
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelectedChange(next);
  };
  const cover = preview?.source.images[0];
  return (
    <div className="space-y-3">
      {/* Not a <form>: this panel lives inside the new-project form, and forms cannot nest. */}
      <div className="flex gap-2">
        <Input
          aria-label="Model link"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          enterKeyHint="go"
          placeholder="https://www.printables.com/model/..."
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (url.trim() !== "" && !pending) onPreview();
            }
          }}
        />
        <Button type="button" variant="secondary" disabled={pending || url.trim() === ""} onClick={onPreview}>
          <LinkIcon /> Preview
        </Button>
      </div>

      {pending && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-24" />
          <Skeleton className="h-9" />
        </div>
      )}
      {error && !pending && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-down/40 bg-down/10 p-3 text-sm text-down">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" /> {error}
        </p>
      )}

      {preview && !pending && (
        <div className="space-y-3 rounded-xl border border-line p-3">
          <div className="flex gap-3">
            {cover ? <img src={cover} alt="" referrerPolicy="no-referrer" className="size-20 shrink-0 rounded-lg bg-raised object-cover" /> : <div className="size-20 shrink-0 rounded-lg bg-raised" />}
            <div className="min-w-0 space-y-1">
              <Badge variant="outline" className="capitalize">
                {preview.source.site}
              </Badge>
              <h3 className="font-medium">{preview.source.title}</h3>
              <p className="text-xs text-dim">
                {preview.source.author ? `by ${preview.source.author}` : "Unknown author"}
                {preview.source.license ? ` · ${preview.source.license}` : " · no licence listed"}
              </p>
            </div>
          </div>

          {preview.blocker && (
            <output className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warn" /> {preview.blocker}
            </output>
          )}

          {preview.files.length === 0 ? (
            <p className="text-sm text-dim">The site offers no files. The title, images and description are still imported.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {preview.files.map((f) => {
                const id = `import-file-${f.id}`;
                return (
                  <li key={f.id} className={cn("flex items-center gap-3 px-3 py-2", !f.downloadable && "opacity-60")}>
                    <Checkbox id={id} checked={f.downloadable && selected.has(f.id)} disabled={!f.downloadable} onCheckedChange={(v) => toggle(f.id, v === true)} />
                    <label htmlFor={id} className="min-w-0 flex-1 text-sm">
                      <span className="block truncate">{f.name}</span>
                      <span className="block text-xs text-dim">
                        {f.downloadable ? formatBytes(f.size) : `Not downloadable: ${preview.source.site} does not hand out this file, upload it by hand.`}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
