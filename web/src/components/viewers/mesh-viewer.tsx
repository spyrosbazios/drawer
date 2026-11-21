import { TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { MeshScene, webglAvailable } from "@/lib/mesh-scene";
import type { MeshFormat } from "@/lib/mesh-scene";
import { useLocalPref } from "@/lib/local-pref";
import { realisticShading } from "@/lib/shading";
import { FitButton } from "./fit-button";
import { useViewportKeys } from "./viewer-menubar";

interface MeshViewerProps {
  /** Where the model's bytes come from. */
  url: string;
  format: MeshFormat;
  wireframe: boolean;
  grid: boolean;
  /** Hands the scene out once created (null on unmount): the viewer's Camera menu drives it. */
  onScene: (scene: MeshScene | null) => void;
}

/** The 3D canvas of a mesh: orbit controls, the view gizmo, wireframe, grid and the two looks. Its menus live in the viewer that renders it. */
export default function MeshViewer({ url, format, wireframe, grid, onScene }: MeshViewerProps) {
  const realistic = useLocalPref(realisticShading);
  const [scene, setScene] = useState<MeshScene | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useViewportKeys(scene);

  // What is being shown, as one key: the state below is derived from it, never set from an effect body.
  const key = `${format}:${url}`;
  const unsupported = !webglAvailable();
  const state: "loading" | "ready" | "error" = unsupported || failure?.key === key ? "error" : loadedKey === key ? "ready" : "loading";
  const error = unsupported ? "This browser cannot start WebGL." : (failure?.message ?? "");

  // The scene lives exactly as long as its host element (a React 19 ref callback with cleanup).
  const host = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !webglAvailable()) return;
      const s = new MeshScene(el);
      setScene(s);
      onScene(s);
      return () => {
        onScene(null);
        setScene(null);
        s.dispose();
      };
    },
    [onScene],
  );

  useEffect(() => {
    if (!scene) return;
    let current = true;
    scene.load(url, format).then(
      () => {
        if (current) setLoadedKey(key);
      },
      (err: unknown) => {
        if (current) setFailure({ key, message: err instanceof Error ? err.message : "The model could not be read." });
      },
    );
    return () => {
      current = false;
    };
  }, [scene, url, format, key]);

  useEffect(() => scene?.setWireframe(wireframe), [scene, wireframe]);
  useEffect(() => scene?.setGrid(grid), [scene, grid]);
  useEffect(() => scene?.setRealistic(realistic), [scene, realistic]);
  useEffect(() => scene?.setGizmo(state === "ready"), [scene, state]);

  return (
    <div className="relative size-full overflow-hidden">
      <div ref={host} className="absolute inset-0" />
      {state === "ready" && <FitButton view={scene} />}
      {state === "loading" && <Skeleton className="pointer-events-none absolute inset-0 rounded-none" aria-label="Loading model" />}
      {state === "error" && (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card p-6 text-center text-sm text-dim">
          <TriangleAlertIcon className="size-6 text-warn" />
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
