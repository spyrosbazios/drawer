import { ASSEMBLY_FILE, LIBRARY_SLUG } from "@drawer/shared/api";
import type { TreeEntry } from "@drawer/shared/api";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, getRouteApi } from "@tanstack/react-router";
import { BotIcon, ClipboardCheckIcon, EyeIcon, ListTreeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssemblyPanel } from "@/components/assembly/assembly-panel";
import { AssemblyView } from "@/components/assembly/assembly-view";
import { PartView } from "@/components/part/part-view";
import { ReviewPanel } from "@/components/review/review-panel";
import { SessionPanel } from "@/components/session/session-panel";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { FileViewer } from "@/components/viewers/file-viewer";
import { TEXT_EDITABLE } from "@/core/kinds";
import { dirName, joinPath, remapMoved } from "@/core/paths";
import { partIdOf } from "@/core/parts";
import { newestSession } from "@/core/sessions";
import type { TreeNode } from "@/core/tree";
import { useAssembly } from "@/hooks/assembly";
import { fileTextQuery, infoQuery, useTree, useUploadFiles } from "@/hooks/files";
import { useParts } from "@/hooks/parts";
import { useProject } from "@/hooks/projects";
import { useSessions } from "@/hooks/sessions";
import { useIsDesktop } from "@/hooks/use-media";
import { drafts, useDirtyPaths } from "@/lib/drafts";
import { useProjectNav } from "@/lib/nav";
import { useLocalPref } from "@/lib/local-pref";
import { PROJECT_DEFAULTS, selectionOf, withSelection } from "@/lib/route-search";
import type { Panel, Selection, Sheet } from "@/lib/route-search";
import { cn } from "@/lib/utils";
import { ActivityDot, projectActivity } from "./activity";
import { defaultSelection } from "./default-selection";
import { DeleteEntryDialog, NewFileDialog, NewFolderDialog, RenameDialog } from "./entry-dialogs";
import { ImportDialog } from "./import-dialog";
import { Kickstart } from "./kickstart-view";
import { ProjectSettingsDialog } from "./project-settings";
import { Sidebar } from "./sidebar";
import { WorkspaceHeader } from "./workspace-header";
import { WorkspaceLayout, outlineHidden } from "./workspace-layout";

const route = getRouteApi("/p/$slug");

const REFS = "refs";
const NOTES = "notes";

/** The phone's bottom navigation: the viewer is the screen itself, the rest are sheets over it. */
const PHONE_NAV: { sheet: Sheet | undefined; label: string; icon: typeof EyeIcon }[] = [
  { sheet: "outline", label: "Outline", icon: ListTreeIcon },
  { sheet: undefined, label: "Viewer", icon: EyeIcon },
  { sheet: "session", label: "Session", icon: BotIcon },
  { sheet: "review", label: "Review", icon: ClipboardCheckIcon },
];

/**
 * Nothing in the address. A project with something to look at opens on it (a replace, so Back skips this
 * step); an empty one offers to get the agent going.
 */
function NoSelection({ slug, entries, onImport }: { slug: string; entries: readonly TreeEntry[] | undefined; onImport: () => void }) {
  const parts = useParts(slug);
  const assembly = useAssembly(slug);
  if (parts.isPending || assembly.isPending) return <Skeleton className="m-6 h-24" aria-label="Loading" />;
  const target = defaultSelection(parts.data ?? [], assembly.data, slug === LIBRARY_SLUG);
  if (!target) return <Kickstart slug={slug} entries={entries} onImport={onImport} />;
  return <Navigate from="/p/$slug" to="." search={(s) => withSelection(s, target)} replace />;
}

function ReviewHint({ selection }: { selection: Selection }) {
  return <p className="p-4 text-sm text-dim">{selection.kind === "file" ? "Review is for parts and the assembly." : "Nothing to review yet."}</p>;
}

export function WorkspacePage() {
  const { slug } = route.useParams();
  const search = route.useSearch();
  const nav = useProjectNav(slug);
  const desktop = useIsDesktop();
  const qc = useQueryClient();
  const project = useProject(slug);
  const tree = useTree(slug);
  const sessions = useSessions(slug);
  const upload = useUploadFiles();
  const dirtyPaths = useDirtyPaths(slug);

  const entries = tree.data;
  const entryMap = useMemo(() => new Map((entries ?? []).map((e) => [e.path, e])), [entries]);
  const files = useMemo(() => new Set((entries ?? []).filter((e) => e.type === "file").map((e) => e.path)), [entries]);
  const dirty = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const selection = selectionOf(search);
  const activeFile = selection.kind === "file" ? selection.path : undefined;
  const sessionId = search.session ?? newestSession(sessions.data, slug)?.id;
  const activity = projectActivity(sessions.data, slug);
  const hideSidebar = useLocalPref(outlineHidden);
  const searchField = useRef<HTMLInputElement>(null);

  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const folder = selectedFolder ?? (activeFile ? dirName(activeFile) : REFS);
  const [settings, setSettings] = useState(false);
  const [importing, setImporting] = useState(false);
  const [newFile, setNewFile] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<TreeNode | null>(null);
  const [deleting, setDeleting] = useState<TreeNode | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pickerFolder = useRef(REFS);

  // Unsaved note edits survive switching selections; leaving the page would lose them, so the browser asks first.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (drafts.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // Ctrl/Cmd B folds the sidebar; "/" jumps to its search (laptop shell only).
  useEffect(() => {
    if (!desktop) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const typing = t !== null && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        outlineHidden.set(!outlineHidden.get());
      } else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        outlineHidden.set(false);
        requestAnimationFrame(() => searchField.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop]);

  /** A part's own files open as the part; the assembly's file opens the assembly. */
  const openFile = (path: string) => {
    setSelectedFolder(null);
    const part = partIdOf(path);
    if (part) nav.selectPart(part);
    else if (path === ASSEMBLY_FILE) nav.selectAssembly();
    else nav.selectFile(path);
  };
  const openLinked = (project: string, path: string) => (project === slug ? openFile(path) : nav.openElsewhere(project, path));

  const onIntent = (path: string) => {
    void qc.prefetchQuery(infoQuery(slug, path));
    const kind = entryMap.get(path)?.kind;
    if (kind && TEXT_EDITABLE.has(kind)) void qc.prefetchQuery(fileTextQuery(slug, path));
  };

  const handleFiles = async (target: string, picked: File[]) => {
    if (picked.length === 0) return;
    const items = picked.map((file) => ({ path: joinPath(target, file.name), file }));
    const replaced = items.filter((i) => files.has(i.path)).length;
    const id = toast.loading(`Uploading 0 of ${items.length}`);
    try {
      await upload(slug, items, files, (done, total) => toast.loading(`Uploading ${done} of ${total}`, { id }));
      toast.success(`Uploaded ${items.length} ${items.length === 1 ? "file" : "files"}${replaced > 0 ? `, ${replaced} replaced` : ""}`, { id });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed", { id });
    }
  };

  const startUpload = (target: string) => {
    pickerFolder.current = target;
    picker.current?.click();
  };

  const treeActions = {
    onOpen: openFile,
    onIntent,
    onSelectFolder: setSelectedFolder,
    onRename: setRenaming,
    onDelete: setDeleting,
    onNewFile: setNewFile,
    onNewFolder: setNewFolder,
    onUpload: startUpload,
    onDropFiles: (target: string, dropped: File[]) => void handleFiles(target === "" ? REFS : target, dropped),
  };

  const sidebar = (
    <Sidebar
      searchRef={searchField}
      onOpenHit={openFile}
      slug={slug}
      entries={entries}
      loading={tree.isPending}
      selection={selection}
      dirty={dirty}
      selectedFolder={folder}
      onSelectPart={nav.selectPart}
      onSelectAssembly={nav.selectAssembly}
      onSelectFile={openFile}
      tree={treeActions}
    />
  );

  let centre: React.ReactNode;
  switch (selection.kind) {
    case "part":
      centre = <PartView key={selection.part} slug={slug} part={selection.part} mode={search.mode ?? PROJECT_DEFAULTS.mode} at={search.at} compare={search.compare} />;
      break;
    case "assembly":
      centre = <AssemblyView slug={slug} />;
      break;
    case "file":
      centre = (
        <FileViewer
          slug={slug}
          entry={entryMap.get(selection.path)}
          path={selection.path}
          at={search.at}
          edit={search.edit === true}
          onEdit={nav.setEdit}
          onBackToCurrent={() => nav.setAt(undefined)}
          onOpenLink={(l) => l.to && openLinked(l.toProject ?? slug, l.to)}
        />
      );
      break;
    case "none":
      centre = <NoSelection slug={slug} entries={entries} onImport={() => setImporting(true)} />;
      break;
  }

  const sessionPanel = <SessionPanel key={sessionId ?? "none"} slug={slug} sessionId={sessionId} />;
  const reviewPanel =
    selection.kind === "part" ? <ReviewPanel key={selection.part} slug={slug} part={selection.part} /> : selection.kind === "assembly" ? <AssemblyPanel slug={slug} /> : <ReviewHint selection={selection} />;

  const addMenu = {
    onUploadReference: () => startUpload(REFS),
    onImport: () => setImporting(true),
    onNewNote: () => setNewFile(NOTES),
  };

  const projectData = project.data;
  const dialogs = (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void handleFiles(pickerFolder.current, [...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {projectData && <ProjectSettingsDialog project={projectData} entries={entries ?? []} open={settings} onOpenChange={setSettings} isLibrary={slug === LIBRARY_SLUG} />}
      <ImportDialog slug={slug} open={importing} onOpenChange={setImporting} onImported={(dir) => setSelectedFolder(dir)} />
      <NewFileDialog
        slug={slug}
        existing={files}
        folder={newFile ?? ""}
        open={newFile !== null}
        onOpenChange={(o) => !o && setNewFile(null)}
        onCreated={(path) => nav.selectFile(path, { edit: path.toLowerCase().endsWith(".md") })}
      />
      <NewFolderDialog slug={slug} existing={files} folder={newFolder ?? ""} open={newFolder !== null} onOpenChange={(o) => !o && setNewFolder(null)} />
      <RenameDialog
        slug={slug}
        existing={files}
        node={renaming}
        onClose={() => setRenaming(null)}
        onMoved={(from, to) => {
          const remap = (p: string) => remapMoved(p, from, to);
          drafts.rename(slug, remap);
          nav.remapFile(remap);
        }}
      />
      <DeleteEntryDialog
        slug={slug}
        node={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(path) => {
          if (activeFile && (activeFile === path || activeFile.startsWith(`${path}/`))) nav.clearSelection();
        }}
      />
    </>
  );

  const panel: Panel = search.panel ?? PROJECT_DEFAULTS.panel;
  const header = (
    <WorkspaceHeader
      slug={slug}
      project={projectData}
      desktop={desktop}
      addMenu={addMenu}
      onSettings={() => setSettings(true)}
      outlineOpen={!hideSidebar}
      onToggleOutline={() => outlineHidden.set(!hideSidebar)}
      panelOpen={panel !== "none"}
      onTogglePanel={() => nav.setPanel(panel === "none" ? PROJECT_DEFAULTS.panel : "none")}
      activity={activity}
    />
  );

  if (desktop) {
    return (
      <div className="flex h-full flex-col bg-bg">
        {header}
        <WorkspaceLayout sidebar={sidebar} centre={centre} panel={panel} onPanel={nav.setPanel} session={sessionPanel} review={reviewPanel} hideSidebar={hideSidebar} activity={activity} />
        {dialogs}
      </div>
    );
  }

  const sheet = search.sheet;
  const bottomNav = (
    <nav aria-label="Workspace" className="pb-safe grid shrink-0 grid-cols-4 border-t border-line bg-card">
      {PHONE_NAV.map(({ sheet: target, label, icon: Icon }) => {
        const on = sheet === target;
        return (
          <button
            key={label}
            type="button"
            aria-pressed={on}
            onClick={() => nav.setSheet(target)}
            className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs", on ? "text-brand" : "text-dim")}
          >
            <span className="relative">
              <Icon className="size-5" />
              {target === "session" && sheet !== "session" && <ActivityDot activity={activity} className="absolute -top-0.5 -right-1 ring-2 ring-card" />}
            </span>
            {label}
          </button>
        );
      })}
    </nav>
  );

  return (
    <div className="flex h-full flex-col bg-bg">
      {header}
      <main className="min-h-0 flex-1">{centre}</main>
      {bottomNav}
      <Drawer open={sheet !== undefined} onOpenChange={(o) => !o && nav.setSheet(undefined)}>
        <DrawerContent className="h-[85dvh] max-h-[85dvh]">
          <DrawerTitle className="sr-only">{PHONE_NAV.find((n) => n.sheet === sheet)?.label ?? "Details"}</DrawerTitle>
          <DrawerDescription className="sr-only">Project {slug}</DrawerDescription>
          <div className={cn("min-h-0 flex-1", sheet === "session" && "overflow-y-auto scroll-contain")} {...(sheet === "session" ? { "data-scroll-restoration-id": `detail|sheet|${slug}|session` } : {})}>
            {sheet === "outline" && sidebar}
            {sheet === "session" && sessionPanel}
            {sheet === "review" && reviewPanel}
          </div>
          {bottomNav}
        </DrawerContent>
      </Drawer>
      {dialogs}
    </div>
  );
}
