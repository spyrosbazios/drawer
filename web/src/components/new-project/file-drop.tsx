import { UploadIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/core/format";
import { newProjectUploadPath } from "@/core/upload";
import { cn } from "@/lib/utils";

interface FileDropProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
}

/** A multi-file drop zone for references: models, photos, flatbed scans, datasheets. They land in `refs/`. */
export function FileDrop({ files, onFilesChange }: FileDropProps) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const add = (list: FileList | null) => {
    if (!list) return;
    const known = new Set(files.map((f) => f.name));
    const fresh = [...list].filter((f) => !known.has(f.name));
    if (fresh.length > 0) onFilesChange([...files, ...fresh]);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(e.dataTransfer.files);
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex w-full cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line p-6 text-center text-sm text-dim transition-colors hover:border-faint focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          over && "border-brand bg-brand/5 text-fg",
        )}
      >
        <UploadIcon className="size-5" />
        <span>Drop a model, a photo or a scan, or choose files</span>
        <span className="text-xs text-faint">STL, 3MF, STEP, photos, scans, PDFs</span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
      {files.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{newProjectUploadPath(f.name)}</span>
              <span className="text-xs text-faint">{formatBytes(f.size)}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${f.name}`} onClick={() => onFilesChange(files.filter((x) => x !== f))}>
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
