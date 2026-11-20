import type { RenderRef } from "@drawer/shared/api";
import { Suspense, lazy } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeEditor, ViewerSkeleton } from "@/components/viewers/viewer-parts";
import { useFileText } from "@/hooks/files";

export const PartCanvas = lazy(() => import("./part-canvas"));

export function CanvasFallback() {
  return <Skeleton className="size-full rounded-none" aria-label="Loading the 3D view" />;
}

/** Without WebGL: the four rendered views as pictures. */
export function RenderViews({ render, note }: { render: RenderRef; note: string }) {
  const views = Object.entries(render.views);
  return (
    <div className="flex size-full flex-col gap-2 overflow-auto bg-card p-3">
      <p className="text-xs text-dim">{note}</p>
      <div className="grid grid-cols-2 gap-2">
        {views.map(([view, url]) => (
          <figure key={view} className="overflow-hidden rounded-md border border-line">
            <img src={url} alt={`${view} view`} className="aspect-square w-full object-contain" />
            <figcaption className="border-t border-line px-2 py-1 text-xs text-dim capitalize">{view}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** The model's source at a revision, read-only: the agent writes models, people read them. */
export function ModelCode({ slug, path, at }: { slug: string; path: string; at: string | undefined }) {
  const file = useFileText(slug, path, at);
  if (file.isPending) return <ViewerSkeleton />;
  if (file.isError) return <p className="p-4 text-sm text-down">{file.error.message}</p>;
  return (
    <Suspense fallback={<ViewerSkeleton />}>
      <CodeEditor value={file.data.text} language="scad" readOnly />
    </Suspense>
  );
}
