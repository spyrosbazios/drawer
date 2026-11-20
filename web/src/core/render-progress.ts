import type { RenderStage, RenderView } from "@drawer/shared/api";

type RunningStage = Exclude<RenderStage, "done" | "failed">;

/** The four things a render does, in order, as the progress display names them. */
export const PHASES = [
  { id: "analysing", label: "Read" },
  { id: "geometry", label: "Geometry" },
  { id: "views", label: "Views" },
  { id: "sheet", label: "Sheet" },
] as const satisfies readonly { id: RunningStage; label: string }[];

/** Index into PHASES of the running phase; -1 while queued. */
export function phaseIndex(stage: RunningStage): number {
  return PHASES.findIndex((p) => p.id === stage);
}

/** One line saying what the renderer is doing now. `views` is how many views the render draws. */
export function stageLabel(stage: RunningStage, step: number, total: number, view: RenderView | null): string {
  switch (stage) {
    case "queued":
      return "Waiting for the renderer";
    case "analysing":
      return "Reading the file";
    case "geometry":
      return "Building geometry";
    case "views": {
      const views = total - 3;
      const n = step - 1;
      return view ? `Drawing the ${view} view (${n} of ${views})` : "Drawing views";
    }
    case "sheet":
      return "Composing the contact sheet";
  }
}

/** Seconds a stage usually needs before the next report; the bar creeps across its share in that time. */
const TYPICAL_SECONDS: Record<RunningStage, number> = { queued: 0, analysing: 2, geometry: 45, views: 3, sheet: 1 };

/**
 * Where the bar should be: the finished share, plus a creep into the running unit that slows down and
 * never completes it (the server only reports stage changes, and geometry can take a minute).
 */
export function progressFraction(stage: RunningStage, step: number, total: number, secondsInStage: number): number {
  if (stage === "queued" || total <= 0) return 0;
  const typical = TYPICAL_SECONDS[stage];
  const creep = 0.9 * (1 - Math.exp(-Math.max(0, secondsInStage) / typical));
  return Math.min(0.99, (step + creep) / total);
}

/** Elapsed time as the display shows it: `4 s`, `1:07`. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
