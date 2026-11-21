import { BotIcon, ClipboardCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { localPref, parseBool } from "@/lib/local-pref";
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

const OUTLINE_PX = 256;
const SIDE_PX = 384;

interface OpenSizes {
  outline: number;
  side: number;
}

const parseSizes = (raw: unknown): OpenSizes | undefined => {
  if (typeof raw !== "object" || raw === null || !("outline" in raw) || !("side" in raw)) return undefined;
  const { outline, side } = raw;
  return typeof outline === "number" && typeof side === "number" && outline > 0 && side > 0 ? { outline, side } : undefined;
};

/**
 * How wide each side panel is when it is open (px), the viewer's own choice. Remembered per panel and only
 * from a drag: a collapsed panel keeps its size, so it comes back as wide as it was (also after a reload),
 * and a window too narrow to fit the panels never rewrites it.
 */
const openSizes = localPref<OpenSizes>("drawer.workspace.sizes", { outline: OUTLINE_PX, side: SIDE_PX }, parseSizes);

/** The layout the group mounts with: the remembered sizes, a panel the page hides at zero from the start. */
function mountLayout(hideSidebar: boolean, panelOpen: boolean): Layout {
  const width = Math.max(window.innerWidth, 1);
  const sizes = openSizes.get();
  const outline = hideSidebar ? 0 : (sizes.outline / width) * 100;
  const side = panelOpen ? (sizes.side / width) * 100 : 0;
  return { outline, centre: 100 - outline - side, side };
}

const Handle = () => (
  <ResizableHandle className="bg-line transition-colors after:w-2 data-[separator=active]:bg-brand data-[separator=hover]:bg-brand/60 data-[separator=focus]:bg-brand/60" />
);

/**
 * The laptop workspace: sidebar | centre | right panel, each side resizable and collapsible by dragging. A
 * collapsed side stays mounted at zero width (the centre never remounts) and follows its source of truth: the
 * address (`panel`) for the right panel, the per-browser sidebar preference for the left. Only a drag (or a
 * key on a separator) writes that source back and remembers a size: every other layout change (a window too
 * narrow for the panels, the toggles) is the layout following the sources, never the viewer's choice. The
 * right panel's only chrome is the Agent | Review switch; the agent panel draws its own header below it.
 */
export function WorkspaceLayout({ sidebar, centre, panel, onPanel, session, review, hideSidebar, activity }: LayoutProps) {
  const panelOpen = panel !== "none";
  const [initial] = useState(() => mountLayout(hideSidebar, panelOpen));
  const outlineRef = usePanelRef();
  const centreRef = usePanelRef();
  const sideRef = usePanelRef();

  useEffect(() => {
    const p = outlineRef.current;
    if (!p) return;
    if (hideSidebar && !p.isCollapsed()) p.collapse();
    else if (!hideSidebar && p.isCollapsed()) p.resize(`${openSizes.get().outline}px`);
  }, [hideSidebar, outlineRef]);
  useEffect(() => {
    const p = sideRef.current;
    if (!p) return;
    if (!panelOpen && !p.isCollapsed()) p.collapse();
    else if (panelOpen && p.isCollapsed()) p.resize(`${openSizes.get().side}px`);
  }, [panelOpen, sideRef]);

  const onUserLayout = (layout: Layout, meta: LayoutChangedMeta): void => {
    const c = centreRef.current?.getSize();
    if (!meta.isUserInteraction || !c || c.asPercentage <= 0) return;
    const groupPx = c.inPixels / (c.asPercentage / 100);
    const px = (id: "outline" | "side", fallback: number) => ((layout[id] ?? 0) > 0 ? Math.round((groupPx * (layout[id] ?? 0)) / 100) : fallback);
    const before = openSizes.get();
    openSizes.set({ outline: px("outline", before.outline), side: px("side", before.side) });
    const outlineShut = (layout.outline ?? 0) === 0;
    if (outlineShut !== hideSidebar) outlineHidden.set(outlineShut);
    const sideShut = (layout.side ?? 0) === 0;
    if (sideShut === panelOpen) onPanel(sideShut ? "none" : PROJECT_DEFAULTS.panel);
  };

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={initial} onLayoutChanged={onUserLayout}>
      <ResizablePanel id="outline" panelRef={outlineRef} defaultSize={`${OUTLINE_PX}px`} minSize="200px" maxSize="420px" collapsible>
        {!hideSidebar && (
          <aside aria-label="Project" className="h-full min-h-0 border-r border-line bg-card">
            {sidebar}
          </aside>
        )}
      </ResizablePanel>
      <Handle />
      <ResizablePanel id="centre" panelRef={centreRef} minSize="320px">
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
