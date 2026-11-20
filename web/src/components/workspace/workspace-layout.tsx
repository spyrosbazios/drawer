import { BotIcon, ClipboardCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { localPref, parseBool, safeStorage } from "@/lib/local-pref";
import { PROJECT_DEFAULTS } from "@/lib/route-search";
import type { Panel } from "@/lib/route-search";
import { ActivityDot } from "./activity";
import type { Activity } from "./activity";

/** Whether the sidebar is hidden: the viewer's own choice, so per browser and not in the address. */
export const outlineHidden = localPref<boolean>("drawer.outline.hidden", false, parseBool);

interface LayoutProps {
  sidebar: React.ReactNode;
  centre: React.ReactNode;
  /** Which right panel the address asks for; `none` = no panel. */
  panel: Panel;
  onPanel: (panel: Panel) => void;
  session: React.ReactNode;
  review: React.ReactNode;
  hideSidebar: boolean;
  activity: Activity | null;
}

/** A layout with a collapsed panel is not remembered: the sizes worth keeping are the open ones. */
const saveOpenLayout =
  (save: (layout: Layout, meta: LayoutChangedMeta) => void) =>
  (layout: Layout, meta: LayoutChangedMeta): void => {
    if (Object.values(layout).every((size) => size > 0)) save(layout, meta);
  };

const OUTLINE_PX = 256;
const SIDE_PX = 384;

/** The layout the group mounts with: the remembered sizes, with a panel the page hides at zero from the start. */
function mountLayout(saved: Layout | undefined, hideSidebar: boolean, panelOpen: boolean): Layout {
  const width = Math.max(window.innerWidth, 1);
  const outline = hideSidebar ? 0 : (saved?.outline ?? (OUTLINE_PX / width) * 100);
  const side = panelOpen ? (saved?.side ?? (SIDE_PX / width) * 100) : 0;
  return { outline, centre: 100 - outline - side, side };
}

const Handle = () => (
  <ResizableHandle className="bg-line transition-colors after:w-2 data-[separator=active]:bg-brand data-[separator=hover]:bg-brand/60 data-[separator=focus]:bg-brand/60" />
);

/**
 * The laptop workspace: sidebar | centre | right panel, each side resizable and collapsible by dragging. A
 * collapsed side stays mounted at zero width (the centre never remounts) and follows its source of truth: the
 * address (`panel`) for the right panel, the per-browser sidebar preference for the left. Dragging one shut
 * or open writes that source back. Sizes are remembered per browser. The right panel's only chrome is the
 * Agent | Review switch; the agent panel draws its own header below it.
 */
export function WorkspaceLayout({ sidebar, centre, panel, onPanel, session, review, hideSidebar, activity }: LayoutProps) {
  const panelOpen = panel !== "none";
  const layout = useDefaultLayout({ id: "drawer.workspace", storage: safeStorage });
  const [initial] = useState(() => mountLayout(layout.defaultLayout, hideSidebar, panelOpen));
  const outlineRef = usePanelRef();
  const sideRef = usePanelRef();

  useEffect(() => {
    const p = outlineRef.current;
    if (!p) return;
    if (hideSidebar && !p.isCollapsed()) p.collapse();
    else if (!hideSidebar && p.isCollapsed()) p.expand();
  }, [hideSidebar, outlineRef]);
  useEffect(() => {
    const p = sideRef.current;
    if (!p) return;
    if (!panelOpen && !p.isCollapsed()) p.collapse();
    else if (panelOpen && p.isCollapsed()) p.expand();
  }, [panelOpen, sideRef]);

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={initial} onLayoutChanged={saveOpenLayout(layout.onLayoutChanged)}>
      <ResizablePanel
        id="outline"
        panelRef={outlineRef}
        defaultSize={`${OUTLINE_PX}px`}
        minSize="200px"
        maxSize="420px"
        collapsible
        onResize={(size, _id, prev) => {
          if (prev && (size.asPercentage === 0) !== hideSidebar) outlineHidden.set(size.asPercentage === 0);
        }}
      >
        {!hideSidebar && (
          <aside aria-label="Project" className="h-full min-h-0 border-r border-line bg-card">
            {sidebar}
          </aside>
        )}
      </ResizablePanel>
      <Handle />
      <ResizablePanel id="centre" minSize="320px">
        <main className="h-full min-h-0 min-w-0 bg-bg">{centre}</main>
      </ResizablePanel>
      <Handle />
      <ResizablePanel
        id="side"
        panelRef={sideRef}
        defaultSize={`${SIDE_PX}px`}
        minSize="300px"
        maxSize="640px"
        collapsible
        onResize={(size, _id, prev) => {
          if (prev && (size.asPercentage === 0) === panelOpen) onPanel(size.asPercentage === 0 ? "none" : PROJECT_DEFAULTS.panel);
        }}
      >
        {panelOpen && (
          <aside aria-label={panel === "session" ? "Agent" : "Review"} className="flex h-full min-h-0 flex-col border-l border-line bg-card">
            <div className="shrink-0 border-b border-line px-2 py-1.5">
              <PanelSwitch panel={panel} onPanel={onPanel} activity={activity} />
            </div>
            <div className="min-h-0 flex-1">{panel === "session" ? session : review}</div>
          </aside>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function PanelSwitch({ panel, onPanel, activity }: { panel: Panel; onPanel: (panel: Panel) => void; activity: Activity | null }) {
  return (
    <ToggleGroup type="single" size="sm" variant="outline" value={panel} onValueChange={(v) => (v === "session" || v === "review") && onPanel(v)} aria-label="Right panel">
      <ToggleGroupItem value="session" className="gap-1.5 px-3">
        <BotIcon /> Agent
        {panel !== "session" && <ActivityDot activity={activity} />}
      </ToggleGroupItem>
      <ToggleGroupItem value="review" className="gap-1.5 px-3">
        <ClipboardCheckIcon /> Review
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
