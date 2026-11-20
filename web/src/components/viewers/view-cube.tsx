import { MaximizeIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { VIEW_DIRECTIONS, cornerDirection } from "@/lib/camera-rig";
import type { ViewControl } from "@/lib/camera-rig";
import { CORNER_SIGNS, CUBE_FACES, cornerLabel, faceTransform, toLocal } from "@/lib/view-cube-geometry";

/**
 * The in-canvas view control, top right of every 3D canvas: a cube that turns with the camera. A face snaps the
 * camera to that standard view, a corner dot to the iso view from that corner, the button underneath fits the model.
 * CSS 3D synced to the camera on every frame the scene draws: no second WebGL context, no React renders while orbiting.
 * Colours are the theme's tokens, so light and dark need nothing here.
 */

const HALF = 26; // px: the cube is 52 px wide
const CORNER_REACH = HALF + 2;

const FACE_TRANSFORMS = CUBE_FACES.map((f) => faceTransform(f, HALF));

export function ViewCube({ view }: { view: ViewControl | null }) {
  const cube = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = cube.current;
    if (!view || !el) return;
    const sync = () => {
      const { rotation, inverse } = view.cubeTransforms();
      el.style.transform = rotation;
      el.style.setProperty("--cube-inverse", inverse);
    };
    sync();
    return view.addRenderListener(sync);
  }, [view]);

  if (!view) return null;

  return (
    <div role="toolbar" aria-label="View" className="pointer-events-auto absolute top-2 right-2 z-10 flex flex-col items-center gap-1.5">
      <div className="relative size-[100px]" style={{ perspective: 300 }}>
        <div ref={cube} className="absolute top-1/2 left-1/2 size-0" style={{ transformStyle: "preserve-3d" }}>
          {CUBE_FACES.map((f, i) => (
            <button
              key={f.view}
              type="button"
              title={`${f.label} view`}
              aria-label={`${f.label} view`}
              onClick={() => view.goTo(VIEW_DIRECTIONS[f.view])}
              className="absolute flex items-center justify-center border border-line bg-raised text-[10px] font-medium tracking-wide text-fg uppercase select-none hover:bg-brand hover:text-on-brand focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              style={{ width: HALF * 2, height: HALF * 2, top: -HALF, left: -HALF, transform: FACE_TRANSFORMS[i], backfaceVisibility: "hidden" }}
            >
              {f.label}
            </button>
          ))}
          {CORNER_SIGNS.map((s) => {
            const [x, y, z] = toLocal(s);
            return (
              <button
                key={s.join()}
                type="button"
                tabIndex={-1}
                title={`Isometric, ${cornerLabel(s)}`}
                aria-label={`Isometric view, ${cornerLabel(s)}`}
                onClick={() => view.goTo(cornerDirection(...s))}
                className="absolute size-3 rounded-full border border-line bg-card hover:scale-125 hover:border-brand hover:bg-brand"
                style={{ top: -6, left: -6, transform: `translate3d(${x * CORNER_REACH}px,${y * CORNER_REACH}px,${z * CORNER_REACH}px) var(--cube-inverse)` }}
              />
            );
          })}
        </div>
      </div>
      <Button type="button" variant="outline" size="icon" className="size-7 bg-card/90" title="Fit to view" aria-label="Fit to view" onClick={() => view.fit()}>
        <MaximizeIcon />
      </Button>
    </div>
  );
}
