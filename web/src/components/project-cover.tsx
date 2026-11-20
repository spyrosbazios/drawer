import { BoxIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A project's thumbnail (`Project.thumbnail`). Its URL is keyed by the picture's content and served immutable,
 * so it is fetched once and then painted from the cache. Without one, or when it fails to load, the tile shows
 * the no-thumbnail placeholder; while it loads, a pulse in the same box, so nothing shifts.
 */
export function ProjectCover({ thumbnail, className }: { thumbnail: string | null; className?: string }) {
  return (
    <div className={cn("@container relative overflow-hidden bg-raised", className)}>
      {thumbnail === null ? <NoThumbnail /> : <Thumbnail key={thumbnail} src={thumbnail} />}
    </div>
  );
}

function Thumbnail({ src }: { src: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  if (state === "failed") return <NoThumbnail />;
  return (
    <>
      {state === "loading" && <div className="absolute inset-0 animate-pulse bg-line/40" aria-hidden />}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className={cn("absolute inset-0 size-full object-contain transition-opacity duration-200", state === "ready" ? "opacity-100" : "opacity-0")}
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
      />
    </>
  );
}

/** Nothing renders yet: a box on a dot grid, drawn in tokens; a small tile gets the box alone. */
function NoThumbnail() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-size-[10px_10px] @min-[5rem]:bg-[radial-gradient(var(--color-line)_1px,transparent_1px)]" aria-hidden>
      <div className="flex size-3/5 max-h-14 max-w-14 items-center justify-center rounded-[25%] @min-[5rem]:size-2/5 @min-[5rem]:border @min-[5rem]:border-line @min-[5rem]:bg-raised">
        <BoxIcon className="size-3/5 text-faint @min-[5rem]:size-1/2" strokeWidth={1.5} />
      </div>
    </div>
  );
}
