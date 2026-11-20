import { getRouteApi } from "@tanstack/react-router";
import { LayoutGridIcon, PlusIcon, SearchXIcon, TableIcon } from "lucide-react";
import { useMemo } from "react";
import { AppLogo } from "@/components/app-logo";
import { AppMenu } from "@/components/app-menu";
import { NewProjectDialog } from "@/components/new-project/new-project-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useProjects } from "@/hooks/projects";
import { useIsDesktop } from "@/hooks/use-media";
import { useHomeNav } from "@/lib/nav";
import { HOME_DEFAULTS, HOME_VIEWS, SORT_KEYS } from "@/lib/route-search";
import type { SortDir, SortKey } from "@/lib/route-search";
import { listScroll } from "@/lib/scroll";
import { SessionsStrip } from "@/components/session/sessions-strip";
import { ProjectCard, ProjectRow, ProjectSkeletons, isSortKey } from "./project-views";
import { ProjectsTable } from "./projects-table";
import { useProjectsModel } from "./projects-model";

const route = getRouteApi("/");

const SORT_LABEL: Record<SortKey, string> = { updated: "Last change", name: "Name", status: "Status", source: "Source site" };

export function HomePage() {
  const search = route.useSearch();
  const nav = useHomeNav();
  const desktop = useIsDesktop();
  const projects = useProjects();
  const data = useMemo(() => projects.data ?? [], [projects.data]);
  const table = useProjectsModel(data, search, nav.setSort);
  const rows = table.getRowModel().rows;

  const view = desktop ? (search.view ?? HOME_DEFAULTS.view) : "list";
  const sort = search.sort ?? HOME_DEFAULTS.sort;
  const dir = search.dir ?? HOME_DEFAULTS.dir;

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="pt-safe flex shrink-0 items-center gap-3 border-b border-line bg-card px-4">
        <div className="flex h-14 w-full items-center gap-3">
          <AppLogo />
          <div className="ml-auto flex items-center gap-1">
            <Button onClick={nav.openNew} className="hidden md:inline-flex">
              <PlusIcon /> New project
            </Button>
            <AppMenu />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto scroll-contain" data-scroll-restoration-id={listScroll("home", `${view}|${search.q ?? ""}`)}>
        <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 pb-24 md:p-6">
          <SessionsStrip />

          <section aria-labelledby="projects-heading" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="projects-heading" className="mr-auto text-sm font-medium">
                Projects
              </h2>
              <Input
                aria-label="Filter projects"
                placeholder="Filter by name or text"
                value={search.q ?? ""}
                onChange={(e) => nav.setQuery(e.target.value)}
                className="order-last w-full md:order-none md:w-64"
                type="search"
                enterKeyHint="search"
              />
              {desktop && (
                <>
                  {view === "grid" && (
                    <Select
                      value={sort}
                      onValueChange={(v) => {
                        if (isSortKey(v)) nav.setSort(v, v === "name" || v === "source" ? "asc" : "desc");
                      }}
                    >
                      <SelectTrigger aria-label="Sort by" className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SORT_KEYS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {SORT_LABEL[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {view === "grid" && (
                    <Button variant="outline" size="sm" onClick={() => nav.setSort(sort, (dir satisfies SortDir) === "asc" ? "desc" : "asc")}>
                      {dir === "asc" ? "Ascending" : "Descending"}
                    </Button>
                  )}
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={view}
                    onValueChange={(v) => {
                      const next = HOME_VIEWS.find((x) => x === v);
                      if (next) nav.setView(next);
                    }}
                    aria-label="View mode"
                  >
                    <ToggleGroupItem value="grid" aria-label="Grid view">
                      <LayoutGridIcon />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="table" aria-label="Table view">
                      <TableIcon />
                    </ToggleGroupItem>
                  </ToggleGroup>
                </>
              )}
            </div>

            {projects.isPending && <ProjectSkeletons view={view} />}
            {projects.isError && !projects.data && (
              <div className="rounded-xl border border-line p-6 text-center text-sm text-dim">
                {projects.error.message}{" "}
                <Button variant="link" onClick={() => void projects.refetch()}>
                  Try again
                </Button>
              </div>
            )}
            {!projects.isPending && data.length === 0 && !projects.isError && (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line p-10 text-center">
                <p className="text-sm text-dim">No projects yet.</p>
                <Button onClick={nav.openNew}>
                  <PlusIcon /> New project
                </Button>
              </div>
            )}
            {!projects.isPending && data.length > 0 && rows.length === 0 && (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line p-10 text-center">
                <SearchXIcon className="size-6 text-faint" />
                <p className="text-sm text-dim">No project matches these filters.</p>
                <Button variant="outline" onClick={nav.clearFilters}>
                  Clear filters
                </Button>
              </div>
            )}

            {rows.length > 0 && view === "grid" && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
                {rows.map((r) => (
                  <ProjectCard key={r.original.slug} project={r.original} />
                ))}
              </div>
            )}
            {rows.length > 0 && view === "list" && (
              <div className="flex flex-col gap-2">
                {rows.map((r) => (
                  <ProjectRow key={r.original.slug} project={r.original} />
                ))}
              </div>
            )}
            {rows.length > 0 && view === "table" && <ProjectsTable table={table} />}
          </section>
        </div>
      </main>

      {!desktop && (
        <Button
          size="lg"
          onClick={nav.openNew}
          className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] h-12 gap-2 rounded-full px-5 shadow-lg"
        >
          <PlusIcon /> New
        </Button>
      )}

      <NewProjectDialog open={search.new === true} onOpenChange={(open) => (open ? nav.openNew() : nav.closeNew())} />
    </div>
  );
}
