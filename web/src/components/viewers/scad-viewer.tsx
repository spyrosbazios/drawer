import { DownloadIcon, PlayIcon, TriangleAlertIcon } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useFileText } from "@/hooks/files";
import { useRender } from "@/hooks/render";
import { useRenderProgress } from "@/hooks/render-progress";
import { useIsDesktop } from "@/hooks/use-media";
import type { MeshScene } from "@/lib/mesh-scene";
import { cn } from "@/lib/utils";
import { fileUrl } from "@/services/files";
import { RenderProgressPanel, RenderProgressStrip } from "./render-progress";
import { ViewerMenubar, cameraMenu } from "./viewer-menubar";
import type { MenuSpec } from "./viewer-menubar";
import { CodeEditor, MeshViewer, ViewerSkeleton } from "./viewer-parts";

interface Props {
  slug: string;
  path: string;
  at: string | undefined;
}

type Preview = "model" | "sheet";
type Pane = "code" | "preview";

/**
 * A `.scad` file that is not a part's model (a part's model opens in the part view): code on the left, the
 * rendered model on the right, a console underneath. Nobody edits models by hand; the agent does.
 */
export function ScadViewer({ slug, path, at }: Props) {
  const file = useFileText(slug, path, at);
  const { query: render, result } = useRender(slug, path, file.data?.rev, at);
  const desktop = useIsDesktop();
  const [preview, setPreview] = useState<Preview>("model");
  const [pane, setPane] = useState<Pane>("code");
  const [scene, setScene] = useState<MeshScene | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [grid, setGrid] = useState(true);
  // null: follow the render (a failure opens the console on its own); true/false: the user decided.
  const [consoleChoice, setConsoleChoice] = useState<boolean | null>(null);

  const failure = render.error?.message ?? null;
  const warnings = result?.warnings.length ?? 0;
  const rendering = render.isFetching;
  const progress = useRenderProgress(slug, path, at);

  const consoleOpen = consoleChoice ?? failure !== null;
  const showCode = desktop || pane === "code";
  const showPreview = desktop || pane === "preview";
  const modelShown = showPreview && preview === "model" && result !== undefined;
  const download = fileUrl(slug, path, { at, download: true });

  const menus = useMemo<MenuSpec[]>(
    () => [
      {
        id: "view",
        label: "View",
        entries: [
          ...(desktop
            ? []
            : ([
                { kind: "radio", value: pane, onChange: (v: string) => (v === "code" || v === "preview") && setPane(v), options: [{ value: "code", label: "Code" }, { value: "preview", label: "Preview" }] },
                { kind: "separator" },
              ] satisfies MenuSpec["entries"])),
          { kind: "radio", value: preview, onChange: (v) => (v === "model" || v === "sheet") && setPreview(v), options: [{ value: "model", label: "3D model" }, { value: "sheet", label: "Contact sheet" }] },
          { kind: "separator" },
          { kind: "check", label: "Wireframe", checked: wireframe, onChange: setWireframe, disabled: !modelShown },
          { kind: "check", label: "Grid", checked: grid, onChange: setGrid, disabled: !modelShown },
          { kind: "separator" },
          { kind: "check", label: warnings > 0 ? `Console (${warnings} ${warnings === 1 ? "warning" : "warnings"})` : "Console", checked: consoleOpen, onChange: setConsoleChoice },
        ],
      },
      cameraMenu(modelShown ? scene : null),
      {
        id: "file",
        label: "File",
        entries: [
          { kind: "item", label: "Render", icon: PlayIcon, disabled: rendering || file.isPending, onSelect: () => void render.refetch() },
          { kind: "item", label: "Download", icon: DownloadIcon, href: download },
        ],
      },
    ],
    [desktop, pane, preview, wireframe, grid, modelShown, scene, warnings, consoleOpen, rendering, file.isPending, render, download],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerMenubar label="Script viewer" menus={menus} status={rendering ? "Rendering…" : failure ? <span className="text-down">Render failed</span> : null} />

      <div className={cn("grid min-h-0 flex-1", desktop ? "grid-cols-2 divide-x divide-line" : "grid-cols-1")}>
        {showCode && (
          <section aria-label="Code" className="min-h-0 min-w-0">
            {file.isPending ? (
              <ViewerSkeleton />
            ) : file.isError ? (
              <p className="p-4 text-sm text-down">{file.error.message}</p>
            ) : (
              <Suspense fallback={<ViewerSkeleton />}>
                <CodeEditor value={file.data.text} language="scad" readOnly />
              </Suspense>
            )}
          </section>
        )}
        {showPreview && (
          <section aria-label="Preview" className="relative min-h-0 min-w-0">
            {result === undefined ? (
              rendering ? (
                <RenderProgressPanel progress={progress} />
              ) : failure ? (
                <p className="flex h-full items-center justify-center gap-2 p-6 text-sm text-down">
                  <TriangleAlertIcon className="size-4" /> Render failed. See the console.
                </p>
              ) : (
                <Skeleton className="size-full rounded-none" aria-label="Rendering" />
              )
            ) : preview === "model" ? (
              <Suspense fallback={<Skeleton className="size-full rounded-none" />}>
                <MeshViewer url={result.mesh} format="stl" wireframe={wireframe} grid={grid} onScene={setScene} />
              </Suspense>
            ) : (
              <div className="flex size-full items-center justify-center overflow-auto bg-card p-2">
                <img src={result.sheet} alt="Contact sheet of the rendered views" className="max-h-full max-w-full object-contain" />
              </div>
            )}
            {rendering && result !== undefined && <RenderProgressStrip progress={progress} />}
          </section>
        )}
      </div>

      {consoleOpen && (
        <section aria-label="Console" className="max-h-48 shrink-0 overflow-y-auto border-t border-line bg-card p-3 font-mono text-xs scroll-contain">
          {failure && <pre className="mb-2 whitespace-pre-wrap text-down">{failure}</pre>}
          {result === undefined && !failure && <p className="text-dim">Nothing rendered yet.</p>}
          {result?.warnings.map((w, i) => (
            <pre key={`w${i}`} className="whitespace-pre-wrap text-warn">
              {w}
            </pre>
          ))}
          {result?.log.map((l, i) => (
            <pre key={`l${i}`} className="whitespace-pre-wrap text-dim">
              {l}
            </pre>
          ))}
          {result && result.log.length === 0 && result.warnings.length === 0 && !failure && <p className="text-dim">No output.</p>}
        </section>
      )}
    </div>
  );
}
