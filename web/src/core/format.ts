const UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "unknown size";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 hours ago", "yesterday", "just now". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((then - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  for (const [unit, size] of STEPS) {
    if (abs >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(Math.round(seconds / 60), "minute");
}

export function formatSeconds(seconds: number): string {
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

/** A bounding box size: "24.0 x 18.0 x 12.0 mm". */
export function formatMm(size: [number, number, number]): string {
  return size.map((n) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1))).join(" x ") + " mm";
}

/** A length in millimetres: "1.2 mm", "24 mm", "0.05 mm". Precision follows the size. */
export function formatLength(mm: number | null | undefined): string {
  if (mm == null || !Number.isFinite(mm)) return "-";
  return `${formatNumber(mm)} mm`;
}

/** A plain number with sensible digits: 3 significant below 10, 1 decimal below 100, none above. Trailing zeros go. */
export function formatNumber(n: number): string {
  const abs = Math.abs(n);
  const digits = abs === 0 ? 0 : abs < 1 ? 3 : abs < 10 ? 2 : abs < 100 ? 1 : 0;
  return String(Number(n.toFixed(digits)));
}

/** A signed difference: "+0.6 mm", "-1.2 mm", "0 mm". */
export function formatDelta(mm: number, unit = "mm"): string {
  const s = formatNumber(mm);
  return `${mm > 0 ? "+" : ""}${s} ${unit}`;
}

export function formatArea(mm2: number | null | undefined): string {
  return mm2 == null ? "-" : `${formatNumber(mm2)} mm²`;
}

export function formatVolume(cm3: number | null | undefined): string {
  return cm3 == null ? "-" : `${formatNumber(cm3)} cm³`;
}

export function formatMass(g: number | null | undefined): string {
  return g == null ? "-" : `${formatNumber(g)} g`;
}

/** Elapsed time between two instants, short: "45 s", "12 min", "2 h 5 min". */
export function formatElapsed(fromIso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(fromIso);
  if (Number.isNaN(ms)) return "-";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
}

/** "6 of 7 gates pass". */
export function formatGates(passed: number, total: number): string {
  return `${passed} of ${total} ${total === 1 ? "gate passes" : "gates pass"}`;
}

/** A revision id is opaque and long; this is what a person reads. */
export function shortRev(id: string): string {
  return id.slice(0, 7);
}
