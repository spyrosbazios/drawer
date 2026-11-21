import { CameraIcon, DownloadIcon, EyeIcon, FileIcon, FolderCogIcon, HistoryIcon, MousePointerClickIcon, XIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createContext, use, useEffect } from "react";
import type { ReactNode } from "react";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { CAMERA_VIEWS, cameraCommand } from "@/lib/camera-keys";
import { VIEW_DIRECTIONS } from "@/lib/camera-rig";
import type { ViewControl } from "@/lib/camera-rig";
import { useLocalPref } from "@/lib/local-pref";
import { realisticShading } from "@/lib/shading";
import { cn } from "@/lib/utils";

/**
 * The one menubar every centre view wears, so they behave alike: a row of menus on the left, short state text
 * on the right. A viewer describes its menus as data (`MenuSpec`); this file draws them. The workspace adds its
 * own through `ShellBarContext` (the Project menu, a button for each side panel that is folded away), which is
 * why a view with no menus of its own still wears the bar (`PlainViewer`). Continuous controls (sliders,
 * legends) do not belong in a menu: they stay in the canvas, in their mode.
 */

export type MenuEntry =
  | { kind: "item"; label: string; icon?: LucideIcon; shortcut?: string; disabled?: boolean; onSelect?: () => void; /** A download link instead of an action. */ href?: string }
  | { kind: "check"; label: string; checked: boolean; onChange: (checked: boolean) => void; shortcut?: string; disabled?: boolean }
  | { kind: "radio"; value: string; onChange: (value: string) => void; options: { value: string; label: ReactNode; icon?: LucideIcon; shortcut?: string; disabled?: boolean }[] }
  | { kind: "label"; text: string }
  | { kind: "separator" }
  | { kind: "sub"; label: string; icon?: LucideIcon; disabled?: boolean; entries: MenuEntry[] };

/** Every menu the bar can hold, with its icon: a menu is one of these, so the same menu looks the same in every viewer. */
const MENU_ICONS = {
  project: FolderCogIcon,
  view: EyeIcon,
  camera: CameraIcon,
  history: HistoryIcon,
  point: MousePointerClickIcon,
  file: FileIcon,
} satisfies Record<string, LucideIcon>;

export interface MenuSpec {
  id: keyof typeof MENU_ICONS;
  label: string;
  disabled?: boolean;
  entries: MenuEntry[];
}

/** What the workspace puts in the bar of whichever view is in the centre. */
export interface ShellBar {
  /** Menus ahead of the viewer's own. */
  menus: MenuSpec[];
  /** At the bar's left and right ends: the way back to a side panel that is folded away. */
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const ShellBarContext = createContext<ShellBar>({ menus: [] });

interface Props {
  menus: MenuSpec[];
  /** Controls that are not a menu and must stay one click away (a Read | Edit switch), right after the menus. */
  tools?: ReactNode;
  /** State that must stay visible at a glance: the mode, the attempt shown. Short text, right end of the row. */
  status?: ReactNode;
  label: string;
}

export function ViewerMenubar({ menus, tools, status, label }: Props) {
  const shell = use(ShellBarContext);
  const all = [...shell.menus, ...menus];
  const hasStatus = status !== undefined && status !== null;
  const hasTrailing = shell.trailing !== undefined && shell.trailing !== null;
  return (
    <div className="@container/bar flex shrink-0 items-center gap-2 border-b border-line bg-card px-1.5 py-1">
      {shell.leading}
      <Menubar aria-label={label} className="h-auto min-w-0 gap-0 rounded-none border-0 bg-transparent p-0">
        {all.map((m) => {
          const Icon = MENU_ICONS[m.id];
          return (
            <MenubarMenu key={m.id} value={m.id}>
              {/* A narrow bar (the phone, a squeezed centre) keeps the icons and drops the words. */}
              <MenubarTrigger disabled={m.disabled} title={m.label} className="gap-1.5 px-2 py-1 text-[13px] disabled:opacity-50">
                <Icon className="size-3.5 text-dim" aria-hidden />
                <span className="sr-only @lg/bar:not-sr-only">{m.label}</span>
              </MenubarTrigger>
              <MenubarContent className="max-h-[70vh] min-w-48 overflow-y-auto" sideOffset={4}>
                <Entries entries={m.entries} />
              </MenubarContent>
            </MenubarMenu>
          );
        })}
      </Menubar>
      {tools}
      {hasStatus && <div className="ml-auto flex min-w-0 shrink items-center gap-2 text-xs text-dim tabular-nums">{status}</div>}
      {hasTrailing && <div className={cn("flex shrink-0 items-center", !hasStatus && "ml-auto")}>{shell.trailing}</div>}
    </div>
  );
}

/** A centre view with no menus of its own (a notice, an empty project, a file with nothing to offer): the bar, then the view. */
export function PlainViewer({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerMenubar label={label} menus={[]} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function Entries({ entries }: { entries: MenuEntry[] }) {
  return entries.map((e, i) => {
    switch (e.kind) {
      case "separator":
        return <MenubarSeparator key={i} />;
      case "label":
        return (
          <MenubarLabel key={i} className="text-xs font-normal text-dim">
            {e.text}
          </MenubarLabel>
        );
      case "item": {
        const body = (
          <>
            {e.icon && <e.icon />}
            {e.label}
            {e.shortcut && <MenubarShortcut>{e.shortcut}</MenubarShortcut>}
          </>
        );
        return e.href ? (
          <MenubarItem key={i} asChild disabled={e.disabled}>
            <a href={e.href} download>
              {body}
            </a>
          </MenubarItem>
        ) : (
          <MenubarItem key={i} disabled={e.disabled} onSelect={e.onSelect}>
            {body}
          </MenubarItem>
        );
      }
      case "check":
        return (
          <MenubarCheckboxItem key={i} checked={e.checked} disabled={e.disabled} onCheckedChange={(v) => e.onChange(v === true)}>
            {e.label}
            {e.shortcut && <MenubarShortcut>{e.shortcut}</MenubarShortcut>}
          </MenubarCheckboxItem>
        );
      case "radio":
        return (
          <MenubarRadioGroup key={i} value={e.value} onValueChange={e.onChange}>
            {e.options.map((o) => (
              <MenubarRadioItem key={o.value} value={o.value} disabled={o.disabled}>
                {o.icon && <o.icon />}
                {o.label}
                {o.shortcut && <MenubarShortcut>{o.shortcut}</MenubarShortcut>}
              </MenubarRadioItem>
            ))}
          </MenubarRadioGroup>
        );
      case "sub":
        return (
          <MenubarSub key={i}>
            <MenubarSubTrigger disabled={e.disabled}>
              {e.icon && <e.icon />}
              {e.label}
            </MenubarSubTrigger>
            <MenubarSubContent className="max-h-72 overflow-y-auto">
              <Entries entries={e.entries} />
            </MenubarSubContent>
          </MenubarSub>
        );
    }
  });
}

// ---- camera: the one list of standard views, shared by the Camera menu, the shortcuts and the cube ----------------------

/** The Camera menu, the same in every 3D viewer: it drives the scene that the view cube drives. */
export function cameraMenu(view: ViewControl | null): MenuSpec {
  return {
    id: "camera",
    label: "Camera",
    disabled: view === null,
    entries: [
      ...CAMERA_VIEWS.map((v): MenuEntry => ({ kind: "item", label: v.label, shortcut: v.key, onSelect: () => view?.goTo(VIEW_DIRECTIONS[v.view]) })),
      { kind: "separator" },
      { kind: "item", label: "Fit to view", shortcut: "F", onSelect: () => view?.fit() },
    ],
  };
}

/**
 * Answers the camera shortcuts the Camera menu lists, anywhere in the workspace while a 3D viewer is
 * mounted: a view needs no focus. Typing in a field, a menu or a dialog never moves the camera (`cameraCommand`).
 */
export function useViewportKeys(view: ViewControl | null): void {
  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      const command = cameraCommand(e);
      if (!command) return;
      e.preventDefault();
      if (command.kind === "fit") view.fit();
      else view.goTo(VIEW_DIRECTIONS[command.view]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);
}

/** The View menu's switch between the flat look and the realistic one: one preference, the same in every 3D viewer. */
export function useShadingEntry(disabled = false): MenuEntry {
  const on = useLocalPref(realisticShading);
  return { kind: "check", label: "Realistic shading", checked: on, onChange: realisticShading.set, disabled };
}

/** The File menu of a viewer whose file can only be taken away as it is. */
export const downloadMenu = (href: string): MenuSpec => ({ id: "file", label: "File", entries: [{ kind: "item", label: "Download", icon: DownloadIcon, href }] });

/** State text in the menubar's right end that can be dismissed: "Viewing A2" with a way back. */
export function StatusPill({ children, onClear, clearLabel }: { children: ReactNode; onClear: () => void; clearLabel: string }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title={clearLabel}
      aria-label={clearLabel}
      className="flex min-w-0 items-center gap-1 rounded-md bg-raised px-2 py-0.5 text-xs text-fg hover:bg-line focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="truncate">{children}</span>
      <XIcon className="size-3 shrink-0 text-dim" aria-hidden />
    </button>
  );
}
