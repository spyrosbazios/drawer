import type { Project } from "@drawer/shared/api";
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  functionalUpdate,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";
import { HOME_DEFAULTS, SORT_KEYS } from "@/lib/route-search";
import type { HomeSearch, SortDir, SortKey } from "@/lib/route-search";
import { STATUS_RANK } from "./project-status";

// Features and columns are module-level constants: the table's models are rebuilt only when data or state change.
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});

const helper = createColumnHelper<typeof features, Project>();

/** Column ids are the URL's sort keys. */
const columns = helper.columns([
  helper.accessor((p) => p.title, { id: "name", header: "Name", sortFn: "alphanumeric", enableGlobalFilter: false }),
  helper.accessor((p) => STATUS_RANK[p.status.overall] * 1000 + p.status.parts, { id: "status", header: "Status", sortFn: "basic", enableGlobalFilter: false }),
  helper.accessor((p) => p.updatedAt, { id: "updated", header: "Last change", sortFn: "basic", enableGlobalFilter: false }),
  helper.accessor((p) => p.source?.site ?? "", { id: "source", header: "Source", sortFn: "alphanumeric", enableGlobalFilter: false }),
  // Hidden: the one text the filter box searches.
  helper.accessor((p) => `${p.title} ${p.slug} ${p.description}`, { id: "haystack", header: "Search", enableSorting: false, filterFn: "includesString" }),
]);

export function sortingFrom(sort: SortKey | undefined, dir: SortDir | undefined): SortingState {
  return [{ id: sort ?? HOME_DEFAULTS.sort, desc: (dir ?? HOME_DEFAULTS.dir) === "desc" }];
}

/**
 * One pipeline for every view: the grid, the phone list and the table all draw `table.getRowModel()`,
 * so filter and sort mean the same thing everywhere. State lives in the URL; the table only computes.
 */
export function useProjectsModel(
  data: Project[],
  search: HomeSearch,
  onSort: (sort: SortKey, dir: SortDir) => void,
) {
  const sorting = useMemo(() => sortingFrom(search.sort, search.dir), [search.sort, search.dir]);
  const globalFilter = search.q ?? "";

  const table = useTable({
    features,
    columns,
    data,
    state: { sorting, globalFilter },
    onSortingChange: (updater) => {
      const next = functionalUpdate(updater, sorting)[0];
      const key = SORT_KEYS.find((k) => k === next?.id);
      if (next && key) onSort(key, next.desc ? "desc" : "asc");
    },
    // Filters are driven from the URL, never by the table itself.
    onColumnFiltersChange: () => undefined,
    onGlobalFilterChange: () => undefined,
    getColumnCanGlobalFilter: (column) => column.id === "haystack",
    globalFilterFn: "includesString",
    enableSortingRemoval: false,
  });
  return table;
}

export type ProjectsTable = ReturnType<typeof useProjectsModel>;
