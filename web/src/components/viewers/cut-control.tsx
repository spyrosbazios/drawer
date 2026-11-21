import type { Axis } from "@drawer/shared/api";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const AXES: Axis[] = ["x", "y", "z"];
const isAxis = (v: string): v is Axis => v === "x" || v === "y" || v === "z";

interface Props {
  axis: Axis;
  onAxis: (axis: Axis) => void;
  /** Where the plane sits along the axis, 0 to 1 of the model's extent. */
  fraction: number;
  onFraction: (fraction: number) => void;
  /** The cut's position in model units, when the viewer knows it ("z = 6.0 mm"). */
  readout?: string;
}

/**
 * The section cut's controls, floating over the canvas while a viewer shows a section: which axis the plane
 * cuts across, and where along it. Everything about the cut is here, in the canvas, next to what it changes.
 */
export function CutControl({ axis, onAxis, fraction, onFraction, readout }: Props) {
  return (
    <div className="absolute inset-x-3 bottom-3 mx-auto flex max-w-sm items-center gap-3 rounded-lg border border-line bg-card/95 px-2 py-1.5 text-xs shadow-sm backdrop-blur-sm">
      <ToggleGroup type="single" size="sm" variant="outline" value={axis} onValueChange={(v) => isAxis(v) && onAxis(v)} aria-label="Cut across">
        {AXES.map((a) => (
          <ToggleGroupItem key={a} value={a} className="w-7 px-0 uppercase" aria-label={`Cut across ${a.toUpperCase()}`}>
            {a}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Slider min={0} max={1000} value={[Math.round(fraction * 1000)]} onValueChange={(v) => onFraction((v[0] ?? 0) / 1000)} aria-label={`Cut position along ${axis.toUpperCase()}`} />
      {readout !== undefined && <span className="w-16 shrink-0 text-right tabular-nums">{readout}</span>}
    </div>
  );
}
