/**
 * The URL is the state. Search params are plain strings so addresses stay readable,
 * and each route's validator keeps what it understands and drops the rest: a stale or hand-typed
 * address opens the screen instead of an error page.
 */

type Raw = Record<string, unknown>;

export function parseSearch(searchStr: string): Record<string, string> {
  const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v === undefined || v === null || v === false || v === "") continue;
    if (v === true) {
      params.set(k, "1");
    } else {
      params.set(k, String(v));
    }
  }
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

const str = (v: unknown): string | undefined => {
  const s = typeof v === "number" ? String(v) : v;
  return typeof s === "string" && s !== "" ? s : undefined;
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => allowed.find((a) => a === v);

const flag = (v: unknown): true | undefined => (v === true || v === "1" || v === "true" ? true : undefined);

// ---- home -------------------------------------------------------------------------------

export const HOME_VIEWS = ["grid", "table"] as const;
export const SORT_KEYS = ["updated", "name", "status", "source"] as const;
export type HomeView = (typeof HOME_VIEWS)[number];
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export interface HomeSearch {
  view?: HomeView;
  sort?: SortKey;
  dir?: SortDir;
  q?: string;
  /** The New project dialog is open. */
  new?: true;
}

export const HOME_DEFAULTS = { view: "grid", sort: "updated", dir: "desc" } as const satisfies {
  view: HomeView;
  sort: SortKey;
  dir: SortDir;
};

export function validateHomeSearch(raw: Raw): HomeSearch {
  const out: HomeSearch = {};
  const view = oneOf(raw.view, HOME_VIEWS);
  if (view && view !== HOME_DEFAULTS.view) out.view = view;
  const sort = oneOf(raw.sort, SORT_KEYS);
  if (sort && sort !== HOME_DEFAULTS.sort) out.sort = sort;
  const dir = oneOf(raw.dir, ["asc", "desc"] as const);
  if (dir && dir !== HOME_DEFAULTS.dir) out.dir = dir;
  const q = str(raw.q);
  if (q) out.q = q;
  if (flag(raw.new)) out.new = true;
  return out;
}

// ---- project workspace -----------------------------------------------------------------

/**
 * The workspace shows ONE selection at a time: a part, the assembly, or a file (brief.md, AGENTS.md, a note,
 * a reference, any other file). When an address carries more than one, the first of part, assembly, file wins.
 */
export const PART_MODES = ["shaded", "section", "thickness", "deviation", "code"] as const;
export const PANELS = ["session", "review", "none"] as const;
/** Phone only: the bottom navigation's sheets. No sheet = the viewer. */
export const SHEETS = ["outline", "session", "review"] as const;
export type PartMode = (typeof PART_MODES)[number];
export type Panel = (typeof PANELS)[number];
export type Sheet = (typeof SHEETS)[number];

export const PROJECT_DEFAULTS = { mode: "shaded", panel: "session" } as const satisfies { mode: PartMode; panel: Panel };

export interface ProjectSearch {
  /** A part id: the centre shows the part viewer. */
  part?: string;
  /** The assembly is selected. */
  assembly?: true;
  /** A project-relative path that is not a part: shown in the file viewers. */
  file?: string;
  /** Part viewer mode; absent = shaded. Part only. */
  mode?: PartMode;
  /** A revision id: the part (an attempt) or file as of then, read-only. */
  at?: string;
  /** Part only: a revision to compare against (the attempts/compare view). */
  compare?: string;
  /** Right panel on laptop; absent = session. */
  panel?: Panel;
  /** A session id; absent = the project's newest. */
  session?: string;
  /** Markdown/text edit mode. File only. */
  edit?: true;
  /** Phone: the open sheet; absent = the viewer. */
  sheet?: Sheet;
}

export type Selection = { kind: "part"; part: string } | { kind: "assembly" } | { kind: "file"; path: string } | { kind: "none" };

export function validateProjectSearch(raw: Raw): ProjectSearch {
  const out: ProjectSearch = {};
  const part = str(raw.part);
  const assembly = flag(raw.assembly);
  const file = str(raw.file);
  if (part) out.part = part;
  else if (assembly) out.assembly = true;
  else if (file) out.file = file;

  const mode = oneOf(raw.mode, PART_MODES);
  if (out.part && mode && mode !== PROJECT_DEFAULTS.mode) out.mode = mode;
  const at = str(raw.at);
  if (at && (out.part || out.file)) out.at = at;
  const compare = str(raw.compare);
  if (compare && out.part) out.compare = compare;
  if (flag(raw.edit) && out.file && !out.at) out.edit = true;

  const panel = oneOf(raw.panel, PANELS);
  if (panel && panel !== PROJECT_DEFAULTS.panel) out.panel = panel;
  const session = str(raw.session);
  if (session) out.session = session;
  const sheet = oneOf(raw.sheet, SHEETS);
  if (sheet) out.sheet = sheet;
  return out;
}

export function selectionOf(search: ProjectSearch): Selection {
  if (search.part) return { kind: "part", part: search.part };
  if (search.assembly) return { kind: "assembly" };
  if (search.file) return { kind: "file", path: search.file };
  return { kind: "none" };
}

/** Clears everything that belongs to the previous selection; panel, session and sheet stay. */
export function withSelection(search: ProjectSearch, selection: Selection): ProjectSearch {
  const { panel, session, sheet } = search;
  const base: ProjectSearch = { panel, session, sheet };
  switch (selection.kind) {
    case "part":
      return { ...base, part: selection.part };
    case "assembly":
      return { ...base, assembly: true };
    case "file":
      return { ...base, file: selection.path };
    case "none":
      return base;
  }
}
