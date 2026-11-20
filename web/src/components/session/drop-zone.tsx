import { UploadIcon } from "lucide-react";
import { useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

/** Wraps the panel: files dropped anywhere on it are attached, with a clear overlay while they hover. */
export function DropZone({ onFiles, className, children }: { onFiles: (files: File[]) => void; className?: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(e) => {
        if (hasFiles(e)) setOver(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      }}
    >
      {children}
      {over && (
        <output className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-run bg-bg/85 text-sm font-medium text-run backdrop-blur-sm">
          <UploadIcon className="size-6" aria-hidden />
          Drop files to attach
        </output>
      )}
    </div>
  );
}
