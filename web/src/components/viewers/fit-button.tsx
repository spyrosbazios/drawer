import { MaximizeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ViewControl } from "@/lib/camera-rig";
import { GIZMO_INSET_PX, GIZMO_PX } from "@/lib/viewport";

const SIZE_PX = 28;

/**
 * Fits the model to the view: the one button in the canvas, under the view gizmo (the cube in the top right
 * corner that the scene draws itself: click a face, an edge or a corner, or drag it to turn the camera).
 */
export function FitButton({ view }: { view: ViewControl | null }) {
  if (!view) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="absolute z-10 bg-card/90"
      style={{ top: GIZMO_INSET_PX + GIZMO_PX, right: GIZMO_INSET_PX + (GIZMO_PX - SIZE_PX) / 2, width: SIZE_PX, height: SIZE_PX }}
      title="Fit to view"
      aria-label="Fit to view"
      onClick={() => view.fit()}
    >
      <MaximizeIcon />
    </Button>
  );
}
