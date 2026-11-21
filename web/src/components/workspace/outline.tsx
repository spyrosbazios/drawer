import { BRIEF_FILE, LIBRARY_SLUG } from "@drawer/shared/api";
import type { PartSummary, TreeEntry } from "@drawer/shared/api";
import { Link } from "@tanstack/react-router";
import { BoxesIcon, BoxIcon, ScrollTextIcon } from "lucide-react";
import { useMemo } from "react";
import { StatusChip } from "@/components/status/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { boughtParts, sectionOf } from "@/core/parts";
import type { FileSection } from "@/core/parts";
import { useAssembly } from "@/hooks/assembly";
import { useLibraryParts } from "@/hooks/library";
import { useParts } from "@/hooks/parts";
import type { Selection } from "@/lib/route-search";
import { cn } from "@/lib/utils";
import { Fold, Folds, outlineFolds } from "./folds";
import { FileTree } from "./file-tree";
import type { TreeActions } from "./file-tree";

export interface OutlineProps {
  slug: string;
  entries: readonly TreeEntry[] | undefined;
  loading: boolean;
  selection: Selection;
  dirty: ReadonlySet<string>;
  selectedFolder: string;
  onSelectPart: (id: string) => void;
  onSelectAssembly: () => void;
  onSelectFile: (path: string) => void;
  /** File tree actions for references, memory and other files. */
  tree: TreeActions;
}

function Row({ active, onClick, icon: Icon, label, trailing, title }: { active: boolean; onClick: () => void; icon: typeof BoxIcon; label: string; trailing?: React.ReactNode; title?: string }) {
  return (
    <li>
      <button
        type="button"
        title={title}
        aria-current={active ? "true" : undefined}
        onClick={onClick}
        className={cn(
          "flex min-h-9 w-full items-center gap-2 px-3 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-inset md:min-h-8",
          active ? "bg-raised text-fg shadow-[inset_2px_0_0_var(--app-brand)]" : "text-dim hover:bg-raised/60 hover:text-fg",
        )}
      >
        <Icon className="size-4 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing}
      </button>
    </li>
  );
}

function partChip(p: PartSummary) {
  const counted = p.status === "draft" || p.status === "failed";
  return <StatusChip kind="report" status={p.status} busy={p.evaluating} label={counted ? `${p.status} ${p.passed}/${p.total}` : undefined} />;
}

/**
 * The project as a person thinks of it, not as a file tree: brief, assembly, printed parts, bought parts the
 * assembly uses, references, memory, and any other files, each a foldable section (state kept per browser).
 * Each row selects one thing.
 */
export function Outline({ slug, entries, loading, selection, dirty, selectedFolder, onSelectPart, onSelectAssembly, onSelectFile, tree }: OutlineProps) {
  const parts = useParts(slug);
  const assembly = useAssembly(slug);
  const library = useLibraryParts();
  const isLibrary = slug === LIBRARY_SLUG;

  const groups = useMemo(() => {
    const out: Record<FileSection, TreeEntry[]> = { references: [], memory: [], other: [] };
    for (const e of entries ?? []) {
      const s = sectionOf(e.path);
      if (s) out[s].push(e);
    }
    return out;
  }, [entries]);

  const printed = (parts.data ?? []).filter((p) => p.source !== "bought");
  const ownBought = (parts.data ?? []).filter((p) => p.source === "bought");
  const listed = isLibrary ? [...printed, ...ownBought] : printed;
  const assemblyReport = assembly.status === "ready" ? assembly.data : null;
  const placed = boughtParts(assemblyReport?.spec);
  const libTitles = new Map((library.data ?? []).map((p) => [p.id, p]));
  const hasBrief = (entries ?? []).some((e) => e.path === BRIEF_FILE);
  const activeFile = selection.kind === "file" ? selection.path : undefined;
  const fileTree = (list: TreeEntry[], emptyText: string) => (
    <FileTree slug={slug} entries={list} loading={loading} activePath={activeFile} selectedFolder={selectedFolder} dirty={dirty} emptyText={emptyText} {...tree} />
  );

  const count = (n: number) => (n > 0 ? n : undefined);
  const fileCount = (list: TreeEntry[]) => count(list.filter((e) => e.type === "file").length);

  return (
    <nav aria-label="Project outline">
      <Folds prefs={outlineFolds} defaults={{ project: true, parts: true, bought: true, references: true, memory: true, other: false }}>
        <Fold id="project" title="Project">
          <ul>
            <Row
              active={activeFile === BRIEF_FILE}
              onClick={() => onSelectFile(BRIEF_FILE)}
              icon={ScrollTextIcon}
              label="Brief"
              trailing={!hasBrief && !loading ? <span className="text-[11px] text-faint">none</span> : undefined}
            />
            {!isLibrary && (
              <Row
                active={selection.kind === "assembly"}
                onClick={onSelectAssembly}
                icon={BoxesIcon}
                label="Assembly"
                trailing={
                  assembly.status === "pending" ? (
                    <Skeleton className="h-5 w-12 rounded-full" />
                  ) : assemblyReport ? (
                    <StatusChip kind="report" status={assemblyReport.status} label={assemblyReport.status === "passed" ? undefined : `${assemblyReport.status} ${assemblyReport.passed}/${assemblyReport.total}`} />
                  ) : (
                    <span className="text-[11px] text-faint">none</span>
                  )
                }
              />
            )}
          </ul>
        </Fold>

        <Fold id="parts" title="Parts" summary={parts.isPending ? undefined : count(listed.length)}>
          <ul>
            {parts.isPending && (
              <li className="space-y-1.5 px-3 py-1">
                <Skeleton className="h-6" />
                <Skeleton className="h-6" />
              </li>
            )}
            {!parts.isPending && listed.length === 0 && <li className="px-3 py-1.5 text-xs text-faint">None yet.</li>}
            {listed.map((p) => (
              <Row key={p.id} active={selection.kind === "part" && selection.part === p.id} onClick={() => onSelectPart(p.id)} icon={BoxIcon} label={p.title || p.id} title={p.id} trailing={partChip(p)} />
            ))}
          </ul>
        </Fold>

        {!isLibrary && (placed.length > 0 || ownBought.length > 0) && (
          <Fold id="bought" title="Bought" summary={ownBought.length + placed.length}>
            <ul>
              {ownBought.map((p) => (
                <Row key={p.id} active={selection.kind === "part" && selection.part === p.id} onClick={() => onSelectPart(p.id)} icon={BoxIcon} label={p.title || p.id} trailing={<span className="text-[11px] text-faint">bought</span>} />
              ))}
              {placed.map(({ id, count: n }) => (
                <li key={id}>
                  <Link
                    to="/p/$slug"
                    params={{ slug: LIBRARY_SLUG }}
                    search={{ part: id }}
                    className="flex min-h-9 items-center gap-2 px-3 text-sm text-dim hover:bg-raised/60 hover:text-fg md:min-h-8"
                  >
                    <BoxIcon className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate">
                      {libTitles.get(id)?.title ?? id} <span className="text-faint">x{n}</span>
                    </span>
                    <span className="text-[11px] text-faint">library</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Fold>
        )}

        <Fold id="references" title="References" summary={fileCount(groups.references)}>
          {fileTree(groups.references, "None yet.")}
        </Fold>

        <Fold id="memory" title="Memory" summary={fileCount(groups.memory)}>
          {fileTree(groups.memory, "None yet.")}
        </Fold>

        {groups.other.length > 0 && (
          <Fold id="other" title="Other files" summary={fileCount(groups.other)}>
            {fileTree(groups.other, "")}
          </Fold>
        )}
      </Folds>
    </nav>
  );
}
