import { DownloadIcon, PlayIcon } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useRender } from "@/hooks/render";
import { formatOf } from "@/lib/mesh-scene";
import type { MeshScene } from "@/lib/mesh-scene";
import { fileUrl } from "@/services/files";
import { PlainViewer, ViewerMenubar, cameraMenu, useShadingEntry } from "./viewer-menubar";
import type { MenuSpec } from "./viewer-menubar";
import { BinaryCard, MeshViewer } from "./viewer-parts";

interface Props {
  slug: string;
  path: string;
  rev: string | undefined;
  at: string | undefined;
}

type Shown = "model" | "sheet";

/** A mesh file: the 3D viewer on its bytes, plus an on-demand render for the contact sheet (also for an old revision). */
export function MeshFileViewer({ slug, path, rev, at }: Props) {
  const [chosen, setChosen] = useState<Shown | null>(null);
  const [scene, setScene] = useState<MeshScene | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [grid, setGrid] = useState(true);
  // Never renders by itself: Render in the File menu, or "Render this revision" in the revisions panel, fills the cache.
  const { query: render } = useRender(slug, path, rev ?? "", at, false);
  // An old revision that was just rendered opens on its sheet; otherwise the model, until the user picks.
  const view: Shown = chosen ?? (at && render.data ? "sheet" : "model");
  const format = formatOf(path);
  const url = fileUrl(slug, path, { at, version: rev });
  const download = fileUrl(slug, path, { at, download: true });

  const shading = useShadingEntry(view !== "model");
  const menus = useMemo<MenuSpec[]>(
    () => [
      {
        id: "view",
        label: "View",
        entries: [
          { kind: "radio", value: view, onChange: (v) => (v === "model" || v === "sheet") && setChosen(v), options: [{ value: "model", label: "3D model" }, { value: "sheet", label: "Contact sheet" }] },
          { kind: "separator" },
          { kind: "check", label: "Wireframe", checked: wireframe, onChange: setWireframe, disabled: view !== "model" },
          { kind: "check", label: "Grid", checked: grid, onChange: setGrid, disabled: view !== "model" },
          shading,
        ],
      },
      cameraMenu(view === "model" ? scene : null),
      {
        id: "file",
        label: "File",
        entries: [
          {
            kind: "item",
            label: at ? "Render this revision" : "Render",
            icon: PlayIcon,
            disabled: render.isFetching,
            onSelect: () => {
              setChosen("sheet");
              void render.refetch();
            },
          },
          { kind: "item", label: "Download", icon: DownloadIcon, href: download },
        ],
      },
    ],
    [view, wireframe, grid, shading, scene, at, render, download],
  );

  if (!format) {
    return (
      <PlainViewer label="Mesh viewer">
        <BinaryCard name={path} size={undefined} href={download} />
      </PlainViewer>
    );
  }

  const status = render.isFetching ? "Rendering…" : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerMenubar label="Mesh viewer" menus={menus} status={status} />
      <div className="min-h-0 flex-1">
        {view === "model" ? (
          <Suspense fallback={<Skeleton className="size-full rounded-none" />}>
            <MeshViewer url={url} format={format} wireframe={wireframe} grid={grid} onScene={setScene} />
          </Suspense>
        ) : render.data ? (
          <div className="flex size-full items-center justify-center overflow-auto bg-card p-2">
            <img src={render.data.sheet} alt="Contact sheet of the rendered views" className="max-h-full max-w-full object-contain" />
          </div>
        ) : render.isFetching ? (
          <Skeleton className="size-full rounded-none" aria-label="Rendering" />
        ) : (
          <p className="flex h-full items-center justify-center p-6 text-center text-sm text-dim">
            {render.error ? render.error.message : "Choose File → Render to make a contact sheet."}
          </p>
        )}
      </div>
    </div>
  );
}
