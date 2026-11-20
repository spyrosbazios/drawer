import type { SearchHit } from "@drawer/shared/api";
import { KindBadge } from "@/components/kind-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** A snippet's match is wrapped in « »; draws it marked. */
export function Snippet({ text }: { text: string }) {
  const pieces = text.split(/«|»/);
  return (
    <>
      {pieces.map((p, i) =>
        // Odd pieces sit between « and ».
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-brand/20 px-px text-fg">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

interface HitsProps {
  query: string;
  hits: readonly SearchHit[] | undefined;
  loading: boolean;
  error: string | undefined;
  active: number;
  onActive: (index: number) => void;
  onOpen: (hit: SearchHit) => void;
}

/** The sidebar while a search is typed: what matched, best first. Replaces the outline. */
export function SearchHits({ query, hits, loading, error, active, onActive, onOpen }: HitsProps) {
  if (query.trim().length < 2) return <p className="px-3 py-3 text-xs text-faint">Type two characters or more.</p>;
  if (error) return <p className="px-3 py-3 text-xs text-down">{error}</p>;
  if (!hits) {
    return (
      <div className="space-y-2 p-3" aria-busy="true">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    );
  }
  if (hits.length === 0) return <p className="px-3 py-3 text-xs text-faint">{loading ? "Searching" : "No matches."}</p>;
  return (
    <ul id="search-hits" aria-label="Search results" className={cn(loading && "opacity-60 transition-opacity")}>
      {hits.map((h, i) => (
        <li key={h.path}>
          <button
            type="button"
            id={`hit-${i}`}
            aria-current={i === active ? "true" : undefined}
            onPointerEnter={() => onActive(i)}
            onClick={() => onOpen(h)}
            className={cn("flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-inset", i === active ? "bg-raised" : "hover:bg-raised/60")}
          >
            <span className="flex min-w-0 items-center gap-2">
              <KindBadge kind={h.kind} />
              <span className="min-w-0 flex-1 truncate font-medium">{h.title || h.path}</span>
            </span>
            {h.title && h.title !== h.path && <span className="truncate font-mono text-[11px] text-faint">{h.path}</span>}
            {h.snippet && (
              <span className="line-clamp-2 text-xs text-dim">
                <Snippet text={h.snippet} />
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
