/**
 * Per-triangle fields (wall thickness, deviation) to colours. Pure: no DOM, no three.js. Colours are
 * linear RGB triples in 0..1, read from theme tokens by the caller.
 */

export type Rgb = readonly [number, number, number];

/** A colour scale: evenly spaced stops over `domain`; values outside are clamped, NaN draws `unknown`. */
export interface FieldScale {
  stops: readonly Rgb[];
  domain: readonly [number, number];
  unknown: Rgb;
  categorical?: boolean;
}

/** Where a value falls on the scale, 0..1 (NaN for an unknown value). */
export function scalePosition(value: number, domain: readonly [number, number]): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const [lo, hi] = domain;
  if (hi <= lo) return 0.5;
  return Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
}

export function colorAt(scale: FieldScale, value: number): Rgb {
  if (scale.categorical) return Number.isInteger(value) && value >= 0 ? scale.stops[value % scale.stops.length] ?? scale.unknown : scale.unknown;
  const t = scalePosition(value, scale.domain);
  if (Number.isNaN(t)) return scale.unknown;
  const n = scale.stops.length;
  const x = t * (n - 1);
  const i = Math.max(0, Math.min(n - 2, Math.floor(x)));
  const f = x - i;
  const a = scale.stops[i] ?? scale.unknown;
  const b = scale.stops[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Vertex colours for a non-indexed triangle mesh: three equal vertices per triangle, 9 floats each. */
export function fieldToVertexColors(field: Float32Array, scale: FieldScale): Float32Array {
  const out = new Float32Array(field.length * 9);
  for (let t = 0; t < field.length; t++) {
    const c = colorAt(scale, field[t] ?? Number.NaN);
    for (let v = 0; v < 3; v++) out.set(c, t * 9 + v * 3);
  }
  return out;
}

/** Smallest and largest finite values; null when there are none. */
export function fieldRange(field: Float32Array): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of field) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? null : [lo, hi];
}

/** The value below which `q` (0..1) of the finite values lie. */
export function fieldQuantile(field: Float32Array, q: number): number | null {
  const finite = field.filter((v) => Number.isFinite(v)).sort();
  if (finite.length === 0) return null;
  return finite[Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))))] ?? null;
}

/**
 * The thickness scale's domain: from the thinnest wall to the 95th percentile, so one deep pocket does
 * not wash out the walls that matter. `required` (the minimum wall a gate asks for) is kept inside it.
 */
export function thicknessDomain(field: Float32Array, required: number | null): [number, number] | null {
  const range = fieldRange(field);
  if (!range) return null;
  const top = fieldQuantile(field, 0.95) ?? range[1];
  const lo = Math.min(range[0], required ?? range[0]);
  const hi = Math.max(top, required === null ? top : required * 2, lo + 0.1);
  return [lo, hi];
}

/** A diverging domain symmetric around 0, wide enough for the larger side. */
export function deviationDomain(min: number, max: number): [number, number] {
  const m = Math.max(Math.abs(min), Math.abs(max), 0.01);
  return [-m, m];
}

/** "#rrggbb" to 0..1 sRGB. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const n = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return [0.5, 0.5, 0.5];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
