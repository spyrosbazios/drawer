import { useNavigate } from "@tanstack/react-router";
import type { HomeSearch, HomeView, Panel, PartMode, ProjectSearch, Sheet, SortKey } from "./route-search";
import { PROJECT_DEFAULTS, withSelection } from "./route-search";

/** Typed navigation verbs for the home screen. Filters replace history entries; the dialog pushes one so Back closes it. */
export function useHomeNav() {
  const navigate = useNavigate({ from: "/" });
  const patch = (fn: (s: HomeSearch) => HomeSearch, replace = true) => void navigate({ to: ".", search: (s) => fn(s), replace });
  return {
    setView: (view: HomeView) => patch((s) => ({ ...s, view })),
    setSort: (sort: SortKey, dir: "asc" | "desc") => patch((s) => ({ ...s, sort, dir })),
    setQuery: (q: string) => patch((s) => ({ ...s, q: q === "" ? undefined : q })),
    clearFilters: () => patch((s) => ({ ...s, q: undefined })),
    openNew: () => patch((s) => ({ ...s, new: true }), false),
    closeNew: () => patch((s) => ({ ...s, new: undefined })),
  };
}

/**
 * Typed navigation verbs for the project workspace. Everything lives in the address. Selecting something
 * pushes a history entry (Back returns to the previous selection) and closes the phone's sheet; view
 * changes within a selection (mode, panel, edit) replace the entry.
 */
export function useProjectNav(slug: string) {
  const navigate = useNavigate({ from: "/p/$slug" });
  const go = (fn: (s: ProjectSearch) => ProjectSearch, replace = false) => void navigate({ to: ".", search: fn, replace });
  return {
    slug,
    selectPart: (part: string) => go((s) => ({ ...withSelection(s, { kind: "part", part }), sheet: undefined })),
    selectAssembly: () => go((s) => ({ ...withSelection(s, { kind: "assembly" }), sheet: undefined })),
    /** Any file that is not a part: brief.md, AGENTS.md, notes, references. */
    selectFile: (path: string, opts: { edit?: boolean; replace?: boolean } = {}) =>
      go((s) => ({ ...withSelection(s, { kind: "file", path }), edit: opts.edit ? true : undefined, sheet: undefined }), opts.replace),
    clearSelection: () => go((s) => withSelection(s, { kind: "none" })),
    /** Follows a rename or move of the selected file. */
    remapFile: (remap: (path: string) => string) => go((s) => (s.file ? { ...s, file: remap(s.file) } : s), true),
    setMode: (mode: PartMode) => go((s) => ({ ...s, mode: mode === PROJECT_DEFAULTS.mode ? undefined : mode }), true),
    /** A revision of the selected part (an attempt) or file; undefined = back to current. */
    setAt: (at: string | undefined) => go((s) => ({ ...s, at, edit: undefined })),
    /** Opens the compare view against a revision; undefined closes it. */
    setCompare: (compare: string | undefined) => go((s) => ({ ...s, compare })),
    setPanel: (panel: Panel) => go((s) => ({ ...s, panel: panel === PROJECT_DEFAULTS.panel ? undefined : panel }), true),
    /**
     * Shows a session in the right panel (and on the phone, its sheet). undefined = the newest. `reveal` opens the
     * phone's sheet even when none is open: for a person who just started a session from the viewer.
     */
    openSession: (session: string | undefined, opts: { reveal?: boolean } = {}) =>
      go((s) => ({ ...s, session, panel: undefined, sheet: opts.reveal || s.sheet !== undefined ? "session" : undefined })),
    /** Part review in the right panel. */
    openReview: () => go((s) => ({ ...s, panel: "review", sheet: s.sheet === undefined ? undefined : "review" }), true),
    setEdit: (edit: boolean) => go((s) => ({ ...s, edit: edit ? true : undefined }), true),
    setSheet: (sheet: Sheet | undefined) => go((s) => ({ ...s, sheet }), sheet === undefined),
    /** A file of another project (a cross-project link). */
    openElsewhere: (project: string, path: string) => void navigate({ to: "/p/$slug", params: { slug: project }, search: { file: path } }),
  };
}

export type ProjectNav = ReturnType<typeof useProjectNav>;
