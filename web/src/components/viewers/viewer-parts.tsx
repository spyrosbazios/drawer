import { DownloadIcon, FileQuestionIcon } from "lucide-react";
import { lazy } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/core/format";

export const CodeEditor = lazy(() => import("@/components/code-editor"));
export const MeshViewer = lazy(() => import("./mesh-viewer"));
export const MarkdownReader = lazy(() => import("./markdown-reader"));

export function ViewerSkeleton() {
  return (
    <div className="space-y-3 p-4" aria-busy="true">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function DownloadButton({ href, size = "sm" }: { href: string; size?: "sm" | "default" }) {
  return (
    <Button asChild variant="outline" size={size}>
      <a href={href} download>
        <DownloadIcon /> Download
      </a>
    </Button>
  );
}

export function FileMissing({ path }: { path: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-dim">
      <FileQuestionIcon className="size-8 text-faint" />
      <p>
        <span className="font-mono text-fg">{path}</span> is not in this project (anymore).
      </p>
    </div>
  );
}

export function BinaryCard({ name, size, href }: { name: string; size: number | undefined; href: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-line bg-card p-6 text-center">
        <FileQuestionIcon className="size-8 text-faint" />
        <div>
          <p className="font-medium break-all">{name}</p>
          <p className="text-sm text-dim">{size === undefined ? "Binary file" : `Binary file, ${formatBytes(size)}`}</p>
        </div>
        <DownloadButton href={href} size="default" />
      </div>
    </div>
  );
}
