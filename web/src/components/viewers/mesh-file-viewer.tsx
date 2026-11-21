import { CrosshairIcon, DownloadIcon, PlayIcon } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useFeatures, useField, useFitFeature } from "@/hooks/measure";
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
  const [showFeatures, setShowFeatures] = useState(false);
  const [picking, setPicking] = useState(false);
  const [fitOpen, setFitOpen] = useState(false);
  const features = useFeatures(slug, path, rev ?? "", at, showFeatures);
  const field = useField(showFeatures ? features.data?.field : undefined);
  const fit = useFitFeature(slug, path, at);
  const scan = /^refs\/[^/]+\/scan\.stl$/.test(path);
  const { query: render } = useRender(slug, path, rev, at, scan);
  // An old revision that was just rendered opens on its sheet; otherwise the model, until the user picks.
  const view: Shown = chosen ?? (at && render.data ? "sheet" : "model");
  const format = formatOf(path);
  const overlayMesh = showFeatures ? features.data?.mesh : undefined;
  const url = overlayMesh ?? render.data?.proxy ?? fileUrl(slug, path, { at, version: rev });
  const download = fileUrl(slug, path, { at, download: true });

  const shading = useShadingEntry(view !== "model");
  const mutateFit = fit.mutate;
  useEffect(() => {
    if (!scene) return;
    scene.setPickHandler(picking && view === "model" ? ({ position }) => {
      setPicking(false);
      setFitOpen(true);
      mutateFit(position);
    } : null);
    return () => scene.setPickHandler(null);
  }, [mutateFit, picking, scene, view]);
  useEffect(() => {
    scene?.setField(showFeatures && field.data ? { kind: "features", values: field.data, domain: [0, 1] } : null);
  }, [field.data, scene, showFeatures]);
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
          { kind: "check", label: "Colour by feature", checked: showFeatures, onChange: setShowFeatures, disabled: view !== "model" },
          shading,
        ],
      },
      cameraMenu(view === "model" ? scene : null),
      {
        id: "point",
        label: "Measure",
        entries: [{ kind: "item", label: picking ? "Stop picking a point" : "Fit at a point", icon: CrosshairIcon, onSelect: () => setPicking(!picking), disabled: !scene || view !== "model" }],
      },
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
    [view, wireframe, grid, shading, scene, at, render, download, showFeatures, picking],
  );

  if (!format) {
    return (
      <PlainViewer label="Mesh viewer">
        <BinaryCard name={path} size={undefined} href={download} />
      </PlainViewer>
    );
  }

  const status = picking ? "Pick a point on the model" : features.isFetching ? "Finding features…" : render.isFetching ? "Rendering…" : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerMenubar label="Mesh viewer" menus={menus} status={status} />
      {showFeatures && (features.error || field.error) && <p role="alert" className="px-2 text-sm text-destructive">{(features.error ?? field.error)?.message}</p>}
      <div className="min-h-0 flex-1">
        {view === "model" ? (
          <Suspense fallback={<Skeleton className="size-full rounded-none" />}>
            {scan && !render.data ? (render.error ? <p role="alert" className="p-4 text-sm text-destructive">{render.error.message}</p> : <Skeleton className="size-full" />) : <MeshViewer url={url} format={overlayMesh || render.data?.proxy ? "stl" : format} wireframe={wireframe} grid={grid} onScene={setScene} />}
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
      <Dialog open={fitOpen} onOpenChange={setFitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Surface fit</DialogTitle>
            <DialogDescription>{fit.data ? fit.data.kind : "Feature at the picked point"}</DialogDescription>
          </DialogHeader>
          {fit.isPending && <p className="text-sm text-dim">Fitting surface…</p>}
          {fit.error && <p role="alert" className="text-sm text-destructive">{fit.error.message}</p>}
          {fit.data && (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt>Origin</dt><dd>{fit.data.origin.map((n) => n.toFixed(2)).join(", ")} mm</dd>
              {fit.data.direction && <><dt>Direction</dt><dd>{fit.data.direction.map((n) => n.toFixed(3)).join(", ")}</dd></>}
              {fit.data.diameter !== null && <><dt>Diameter</dt><dd>{fit.data.diameter.toFixed(2)} mm ({fit.data.side})</dd></>}
              {fit.data.length !== null && <><dt>Length</dt><dd>{fit.data.length.toFixed(2)} mm</dd></>}
              <dt>Coverage</dt><dd>{Math.round(fit.data.coverage * 100)}%</dd>
              <dt>RMS error</dt><dd>{fit.data.rms.toFixed(3)} mm</dd>
              <dt>Largest error</dt><dd>{fit.data.maxError.toFixed(3)} mm</dd>
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
