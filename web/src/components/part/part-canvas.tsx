import { TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { MeshScene } from "@/lib/mesh-scene";
import type { FieldPaint, PickHit, Point3, SectionCut } from "@/lib/mesh-scene";
import { cn } from "@/lib/utils";
import { ViewCube } from "@/components/viewers/view-cube";
import { useViewportKeys } from "@/components/viewers/viewer-menubar";

/** A labelled place drawn over the model; it follows the camera. */
export interface SceneMarker {
  key: string;
  position: Point3;
  /** Short text inside the marker: a number, a value. */
  text: string;
  /** Longer text on hover and for screen readers. */
  title: string;
  tone: "point" | "gate" | "pin";
}

const TONE: Record<SceneMarker["tone"], string> = {
  point: "bg-brand text-on-brand",
  gate: "bg-down text-bg",
  pin: "bg-fg text-bg",
};

export interface PartCanvasProps {
  /** A binary STL. */
  url: string;
  field?: FieldPaint | null;
  section?: SectionCut | null;
  markers?: readonly SceneMarker[];
  onPick?: (hit: PickHit) => void;
  /** Hands the scene out once created (null on unmount): camera sync between two canvases. */
  onScene?: (scene: MeshScene | null) => void;
  /** Called when the field does not match the mesh's triangles (and is not drawn). */
  onFieldMismatch?: () => void;
  /** Small caption in the top-left corner ("A · r3"). */
  caption?: string;
  /** Draw the view cube (compare panes share one camera, so only one of them shows it). */
  cube?: boolean;
  className?: string;
}

/** The part's 3D view: a MeshScene with fields, a section cut, click-to-point and HTML markers. */
export default function PartCanvas({ url, field = null, section = null, markers = [], onPick, onScene, onFieldMismatch, caption, cube = true, className }: PartCanvasProps) {
  const overlay = useRef<HTMLDivElement>(null);
  const onSceneRef = useRef(onScene);
  const [scene, setScene] = useState<MeshScene | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  const state = failure?.url === url ? "error" : loadedUrl === url ? "ready" : "loading";
  const viewportKeys = useViewportKeys(scene);

  useEffect(() => {
    onSceneRef.current = onScene;
  }, [onScene]);

  // The scene lives exactly as long as its host element (a React 19 ref callback with cleanup).
  const host = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const s = new MeshScene(el);
    setScene(s);
    onSceneRef.current?.(s);
    return () => {
      onSceneRef.current?.(null);
      setScene(null);
      s.dispose();
    };
  }, []);

  useEffect(() => {
    if (!scene) return;
    let current = true;
    scene.load(url, "stl").then(
      () => {
        if (!current) return;
        setLoadedUrl(url);
      },
      (err: unknown) => {
        if (current) setFailure({ url, message: err instanceof Error ? err.message : "The model could not be read." });
      },
    );
    return () => {
      current = false;
    };
  }, [scene, url]);

  useEffect(() => {
    if (!scene || state !== "ready") return;
    if (!scene.setField(field)) onFieldMismatch?.();
  }, [scene, state, field, onFieldMismatch]);

  useEffect(() => {
    scene?.setSection(section);
  }, [scene, section]);

  useEffect(() => {
    if (!scene) return;
    scene.setPickHandler(onPick ?? null);
  }, [scene, onPick]);

  // Markers are HTML over the canvas, moved after every frame without a React render.
  useEffect(() => {
    const el = overlay.current;
    if (!scene || !el) return;
    const place = () => {
      for (const m of markers) {
        const node = el.querySelector<HTMLElement>(`[data-marker="${CSS.escape(m.key)}"]`);
        if (!node) continue;
        const p = scene.toScreen(m.position);
        node.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
        node.style.visibility = p.behind ? "hidden" : "visible";
      }
    };
    place();
    return scene.addRenderListener(place);
  }, [scene, markers, state]);

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col", className)}>
      <div className="relative min-h-0 flex-1 overflow-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset" {...viewportKeys}>
        <div ref={host} className={cn("absolute inset-0", onPick && "cursor-crosshair")} />
        <div ref={overlay} className="pointer-events-none absolute inset-0">
          {state === "ready" &&
            markers.map((m) => (
              <span
                key={m.key}
                data-marker={m.key}
                title={m.title}
                aria-label={m.title}
                className={cn("pointer-events-auto absolute top-0 left-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap shadow-sm tabular-nums", TONE[m.tone])}
                style={{ visibility: "hidden" }}
              >
                {m.text}
              </span>
            ))}
        </div>
        {caption && <span className="pointer-events-none absolute top-2 left-2 rounded border border-line bg-card/90 px-2 py-0.5 text-xs">{caption}</span>}
        {cube && state === "ready" && <ViewCube view={scene} />}
        {state === "loading" && <Skeleton className="absolute inset-0 rounded-none" aria-label="Loading model" />}
        {state === "error" && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card p-6 text-center text-sm text-dim">
            <TriangleAlertIcon className="size-6 text-warn" />
            <p>{failure?.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}
