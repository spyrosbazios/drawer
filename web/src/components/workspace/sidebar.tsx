import type { SearchHit } from "@drawer/shared/api";
import { SearchIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { Ref } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { useProjectSearch } from "@/hooks/search";
import { Outline } from "./outline";
import type { OutlineProps } from "./outline";
import { SearchHits } from "./search-hits";

interface SidebarProps extends OutlineProps {
  /** Opens a hit the way the outline opens things. */
  onOpenHit: (path: string) => void;
  searchRef: Ref<HTMLInputElement>;
}

/**
 * The left column: a search over this project's files on top, and below it the outline. While there is a query
 * the hits replace the outline. The query is a passing filter, so it lives here and not in the address.
 */
export function Sidebar({ onOpenHit, searchRef, ...outline }: SidebarProps) {
  const { slug } = outline;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useProjectSearch(slug, query);
  const searching = query !== "";
  const hits = search.data;

  const change = (q: string) => {
    setQuery(q);
    setActive(0);
  };
  const open = (hit: SearchHit) => onOpenHit(hit.path);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line p-2">
        <InputGroup className="h-9 md:h-8">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (searching) change("");
                else e.currentTarget.blur();
              } else if (e.key === "ArrowDown" && hits?.length) {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, hits.length - 1));
              } else if (e.key === "ArrowUp" && hits?.length) {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && hits?.[active]) {
                e.preventDefault();
                open(hits[active]);
              }
            }}
            placeholder="Search"
            aria-label="Search this project"
            aria-controls="search-hits"
            aria-activedescendant={searching && hits?.[active] ? `hit-${active}` : undefined}
            className="[&::-webkit-search-cancel-button]:hidden"
          />
          <InputGroupAddon align="inline-end">
            {searching ? (
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => change("")}>
                <XIcon />
              </InputGroupButton>
            ) : (
              <Kbd className="hidden md:inline-flex">/</Kbd>
            )}
          </InputGroupAddon>
        </InputGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-contain" data-scroll-restoration-id={`list|${searching ? "search" : "outline"}|${slug}`}>
        {searching ? (
          <SearchHits query={query} hits={hits} loading={search.isFetching} error={search.error?.message} active={active} onActive={setActive} onOpen={open} />
        ) : (
          <div className="pb-6">
            <Outline {...outline} />
          </div>
        )}
      </div>
    </div>
  );
}
