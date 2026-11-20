import { formatDelta, formatLength } from "@/core/format";
import { scalePosition } from "@/lib/field-colors";

interface Props {
  kind: "thickness" | "deviation";
  domain: readonly [number, number];
  /** A marked value on the scale (the minimum wall a gate requires). */
  mark?: { value: number; label: string } | null;
  caption: string;
}

const GRADIENT = {
  thickness: "linear-gradient(to right, var(--app-scale-lo), var(--app-scale-mid), var(--app-scale-hi))",
  deviation: "linear-gradient(to right, var(--app-dev-neg), var(--app-dev-zero), var(--app-dev-pos))",
} as const;

/** The colour scale a field is painted with: ends, the middle, and an optional mark. */
export function FieldLegend({ kind, domain, mark, caption }: Props) {
  const fmt = kind === "deviation" ? (v: number) => formatDelta(v) : (v: number) => formatLength(v);
  const markAt = mark ? scalePosition(mark.value, domain) : Number.NaN;
  return (
    <figure className="pointer-events-none absolute right-2 bottom-12 w-52 max-w-[60%] rounded-md border border-line bg-card/90 px-2.5 py-2 text-[11px] shadow-sm backdrop-blur-sm">
      <figcaption className="mb-1 text-dim">{caption}</figcaption>
      <div className="relative h-2.5 rounded-sm" style={{ background: GRADIENT[kind] }}>
        {!Number.isNaN(markAt) && <span className="absolute -top-1 -bottom-1 w-0.5 bg-fg" style={{ left: `${markAt * 100}%` }} aria-hidden />}
      </div>
      <div className="mt-1 flex justify-between tabular-nums text-dim">
        <span>{fmt(domain[0])}</span>
        <span>{fmt((domain[0] + domain[1]) / 2)}</span>
        <span>{fmt(domain[1])}</span>
      </div>
      {mark && <p className="mt-0.5 text-fg">{mark.label}</p>}
    </figure>
  );
}
