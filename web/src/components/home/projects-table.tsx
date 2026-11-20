import { Link } from "@tanstack/react-router";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProjectCover } from "@/components/project-cover";
import { formatRelative } from "@/core/format";
import type { ProjectsTable as Model } from "./projects-model";
import { SortIcon, SourceBadge, StatusRow } from "./project-views";

export function ProjectsTable({ table }: { table: Model }) {
  const rows = table.getRowModel().rows;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-card" data-scroll-restoration-id="list|home-table">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers
                .filter((h) => h.column.id !== "haystack")
                .map((header) => {
                  const sorted = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();
                  return (
                    <TableHead key={header.id} aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}>
                      {canSort ? (
                        <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-fg" onClick={() => header.column.toggleSorting(sorted === "asc")}>
                          <table.FlexRender header={header} />
                          <SortIcon active={sorted !== false} dir={sorted === "asc" ? "asc" : "desc"} />
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  );
                })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const p = row.original;
            return (
              <TableRow key={row.id} className="cursor-pointer">
                <TableCell className="min-w-56">
                  <Link to="/p/$slug" params={{ slug: p.slug }} search={{}} className="flex items-center gap-3">
                    <ProjectCover thumbnail={p.thumbnail} className="size-9 shrink-0 rounded-md" />
                    <span className="font-medium">{p.title}</span>
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="whitespace-nowrap">
                    <StatusRow project={p} />
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums text-dim">{formatRelative(p.updatedAt)}</TableCell>
                <TableCell>
                  <SourceBadge project={p} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
