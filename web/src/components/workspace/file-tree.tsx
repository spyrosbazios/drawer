import type { TreeEntry } from "@drawer/shared/api";
import { ChevronRightIcon, DownloadIcon, FilePlusIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import { KindBadge } from "@/components/kind-badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ancestorsOf } from "@/core/paths";
import { allDirs, buildTree, visibleRows } from "@/core/tree";
import type { TreeNode } from "@/core/tree";
import { cn } from "@/lib/utils";
import { fileUrl } from "@/services/files";

export interface TreeActions {
  onOpen: (path: string) => void;
  /** Pointer or focus arrives on a file: warm its data. */
  onIntent: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onRename: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
  onNewFile: (folder: string) => void;
  onNewFolder: (folder: string) => void;
  onUpload: (folder: string) => void;
  /** Files dropped on a folder (or on the empty area, with folder ""). */
  onDropFiles: (folder: string, files: File[]) => void;
}

interface FileTreeProps extends TreeActions {
  slug: string;
  entries: readonly TreeEntry[] | undefined;
  loading: boolean;
  activePath: string | undefined;
  selectedFolder: string;
  dirty: ReadonlySet<string>;
  /** Shown when there is nothing to list. */
  emptyText?: string;
}

interface MenuItem {
  key: string;
  label: string;
  icon: typeof PencilIcon;
  danger?: boolean;
  separatorBefore?: boolean;
  run: () => void;
  href?: string;
}

function menuFor(node: TreeNode, slug: string, a: TreeActions): MenuItem[] {
  if (node.type === "dir") {
    return [
      { key: "new-file", label: "New file here", icon: FilePlusIcon, run: () => a.onNewFile(node.path) },
      { key: "new-folder", label: "New folder here", icon: FolderPlusIcon, run: () => a.onNewFolder(node.path) },
      { key: "upload", label: "Upload files here", icon: UploadIcon, run: () => a.onUpload(node.path) },
      { key: "rename", label: "Rename or move", icon: PencilIcon, separatorBefore: true, run: () => a.onRename(node) },
      { key: "delete", label: "Delete folder", icon: Trash2Icon, danger: true, run: () => a.onDelete(node) },
    ];
  }
  return [
    { key: "download", label: "Download", icon: DownloadIcon, run: () => window.open(fileUrl(slug, node.path, { download: true }), "_self") },
    { key: "rename", label: "Rename or move", icon: PencilIcon, run: () => a.onRename(node) },
    { key: "delete", label: "Delete", icon: Trash2Icon, danger: true, separatorBefore: true, run: () => a.onDelete(node) },
  ];
}

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export function FileTree({ slug, entries, loading, activePath, selectedFolder, dirty, emptyText = "Nothing here yet.", ...actions }: FileTreeProps) {
  const tree = useMemo(() => buildTree(entries ?? []), [entries]);
  // A folder is open when the user opened it, or by default when it is top-level or holds the open file.
  // `closed` wins over the defaults, so a folder the user collapsed stays collapsed.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Opening a file (from a link, a tab or the URL) reveals it: its folders are no longer "closed".
  const [seenActive, setSeenActive] = useState(activePath);
  if (seenActive !== activePath) {
    setSeenActive(activePath);
    if (activePath) {
      const parents = ancestorsOf(activePath);
      if (parents.some((p) => closed.has(p))) setClosed(new Set([...closed].filter((p) => !parents.includes(p))));
    }
  }

  const expanded = useMemo(() => {
    const parents = new Set(activePath ? ancestorsOf(activePath) : []);
    const open = new Set<string>();
    for (const dir of allDirs(tree)) {
      const byDefault = !dir.path.includes("/") || parents.has(dir.path);
      if (!closed.has(dir.path) && (opened.has(dir.path) || byDefault)) open.add(dir.path);
    }
    return open;
  }, [tree, opened, closed, activePath]);

  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  const toggle = (path: string) => {
    const isOpen = expanded.has(path);
    setOpened((prev) => (isOpen ? new Set([...prev].filter((p) => p !== path)) : new Set(prev).add(path)));
    setClosed((prev) => (isOpen ? new Set(prev).add(path) : new Set([...prev].filter((p) => p !== path))));
  };

  if (loading) {
    return (
      <div className="space-y-1.5 p-3" aria-busy="true">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-7" style={{ marginLeft: `${(i % 3) * 12}px` }} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn("min-h-full", dropTarget === "" && "bg-brand/5")}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropTarget("");
      }}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropTarget(null);
        actions.onDropFiles("", [...e.dataTransfer.files]);
      }}
    >
      {rows.length === 0 && <p className="px-3 py-1.5 text-xs text-faint">{emptyText}</p>}
      <ul aria-label="Files">
        {rows.map(({ node, depth }) => {
          const isDir = node.type === "dir";
          const open = expanded.has(node.path);
          const active = !isDir && node.path === activePath;
          const items = menuFor(node, slug, actions);
          return (
            <li key={node.path}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    className={cn(
                      "group flex items-center gap-1 pr-1 text-sm",
                      active ? "bg-raised text-fg" : "text-dim hover:bg-raised/60 hover:text-fg",
                      isDir && dropTarget === node.path && "bg-brand/10 ring-1 ring-brand ring-inset",
                      isDir && selectedFolder === node.path && "text-fg",
                    )}
                    onDragOver={
                      isDir
                        ? (e) => {
                            if (!hasFiles(e)) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setDropTarget(node.path);
                          }
                        : undefined
                    }
                    onDrop={
                      isDir
                        ? (e) => {
                            if (!hasFiles(e)) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setDropTarget(null);
                            actions.onDropFiles(node.path, [...e.dataTransfer.files]);
                          }
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      aria-expanded={isDir ? open : undefined}
                      aria-current={active ? "true" : undefined}
                      className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 py-1 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-inset md:min-h-7"
                      style={{ paddingLeft: `${8 + depth * 14}px` }}
                      onPointerEnter={isDir ? undefined : () => actions.onIntent(node.path)}
                      onFocus={isDir ? undefined : () => actions.onIntent(node.path)}
                      onClick={() => {
                        if (isDir) {
                          toggle(node.path);
                          actions.onSelectFolder(node.path);
                        } else actions.onOpen(node.path);
                      }}
                    >
                      {isDir ? (
                        <>
                          <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
                          {open ? <FolderOpenIcon className="size-4 shrink-0 text-faint" /> : <FolderIcon className="size-4 shrink-0 text-faint" />}
                        </>
                      ) : (
                        <>
                          <span className="size-3.5 shrink-0" />
                          {node.entry?.kind ? <KindBadge kind={node.entry.kind} /> : <span className="w-7" />}
                        </>
                      )}
                      <span className="truncate">{node.name}</span>
                      {dirty.has(node.path) && <span aria-label="Unsaved changes" className="ml-auto size-1.5 shrink-0 rounded-full bg-warn" />}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${node.name}`} className="size-8 shrink-0 opacity-100 md:size-6 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {items.map((it) => (
                          <div key={it.key}>
                            {it.separatorBefore && <DropdownMenuSeparator />}
                            <DropdownMenuItem variant={it.danger ? "destructive" : "default"} onSelect={it.run}>
                              <it.icon /> {it.label}
                            </DropdownMenuItem>
                          </div>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  {items.map((it) => (
                    <div key={it.key}>
                      {it.separatorBefore && <ContextMenuSeparator />}
                      <ContextMenuItem variant={it.danger ? "destructive" : "default"} onSelect={it.run}>
                        <it.icon /> {it.label}
                      </ContextMenuItem>
                    </div>
                  ))}
                </ContextMenuContent>
              </ContextMenu>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
