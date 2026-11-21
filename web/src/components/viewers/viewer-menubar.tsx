import { XIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect } from "react";
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

/**
 * The one menubar every centre viewer (part, assembly, mesh file, `.scad` file) wears, so they behave alike:
 * a row of menus on the left, short state text on the right. A viewer describes its menus as data
 * (`MenuSpec`); this file draws them. Continuous controls (sliders, legends) do not belong in a menu: they
 * stay in the canvas, in their mode.
 */

export type MenuEntry =
  | { kind: "item"; label: string; icon?: LucideIcon; shortcut?: string; disabled?: boolean; onSelect?: () => void; /** A download link instead of an action. */ href?: string }
  | { kind: "check"; label: string; checked: boolean; onChange: (checked: boolean) => void; shortcut?: string; disabled?: boolean }
  | { kind: "radio"; value: string; onChange: (value: string) => void; options: { value: string; label: ReactNode; icon?: LucideIcon; shortcut?: string; disabled?: boolean }[] }
  | { kind: "label"; text: string }
  | { kind: "separator" }
  | { kind: "sub"; label: string; icon?: LucideIcon; disabled?: boolean; entries: MenuEntry[] };

export interface MenuSpec {
  id: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  entries: MenuEntry[];
}

interface Props {
  menus: MenuSpec[];
  /** State that must stay visible at a glance: the mode, the attempt shown. Short text, right end of the row. */
  status?: ReactNode;
  label: string;
}

export function ViewerMenubar({ menus, status, label }: Props) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line bg-card px-1.5 py-1">
      <Menubar aria-label={label} className="h-auto min-w-0 gap-0 rounded-none border-0 bg-transparent p-0">
        {menus.map((m) => (
          <MenubarMenu key={m.id} value={m.id}>
            <MenubarTrigger disabled={m.disabled} className="gap-1.5 px-2 py-1 text-[13px] disabled:opacity-50">
              {m.icon && <m.icon className="size-3.5 text-dim" aria-hidden />}
              {m.label}
            </MenubarTrigger>
            <MenubarContent className="max-h-[70vh] min-w-48 overflow-y-auto" sideOffset={4}>
              <Entries entries={m.entries} />
            </MenubarContent>
          </MenubarMenu>
        ))}
      </Menubar>
      {status !== undefined && status !== null && <div className="ml-auto flex min-w-0 shrink items-center gap-2 text-xs text-dim tabular-nums">{status}</div>}
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
