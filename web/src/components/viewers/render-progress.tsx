import { CheckIcon } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import { useEffect, useState } from "react";
import { PHASES, formatElapsed, phaseIndex, progressFraction, stageLabel } from "@/core/render-progress";
import type { RenderProgressState } from "@/hooks/render-progress";
import { cn } from "@/lib/utils";

/** Re-renders a few times a second while mounted, so the bar creeps and the clock counts. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface Live {
  label: string;
  fraction: number;
  phase: number;
  elapsed: string | null;
}

/** `progress` is undefined between sending the request and the server's first report. */
function useLive(progress: RenderProgressState | undefined): Live {
  const now = useNow(250);
  if (!progress) return { label: "Starting the render", fraction: 0, phase: -1, elapsed: null };
  const { stage, step, total, view } = progress;
  return {
    label: stageLabel(stage, step, total, view),
    fraction: progressFraction(stage, step, total, (now - progress.stageAt) / 1000),
    phase: phaseIndex(stage),
    elapsed: formatElapsed((now - progress.startedAt) / 1000),
  };
}

function Bar({ fraction, className }: { fraction: number; className?: string }) {
  return (
    <div className={cn("relative h-1 overflow-hidden rounded-full bg-line", className)}>
      <progress className="sr-only" aria-label="Render progress" max={100} value={Math.round(fraction * 100)} />
      <motion.div className="absolute inset-y-0 left-0 rounded-full bg-brand" initial={false} animate={{ width: `${fraction * 100}%` }} transition={{ duration: 0.4, ease: "easeOut" }} />
      {/* A light sweeping across says "alive" while a long stage reports nothing new. */}
      <motion.div
        className="absolute inset-y-0 w-1/4 bg-linear-to-r from-transparent via-on-brand/40 to-transparent"
        initial={{ left: "-25%" }}
        animate={{ left: "100%" }}
        transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity, repeatDelay: 0.3 }}
      />
    </div>
  );
}

/** Three stacked plates assembling, one after the other: a render in miniature. */
function Mark() {
  return (
    <svg viewBox="0 0 64 64" className="size-16 text-brand" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <motion.path
          key={i}
          d="M32 8 56 20 32 32 8 20Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          style={{ translateY: i * 12 }}
          initial={{ opacity: 0.15, fillOpacity: 0.05 }}
          animate={{ opacity: [0.15, 1, 1, 0.15], fillOpacity: [0.05, 0.35, 0.35, 0.05] }}
          transition={{ duration: 2.4, times: [0, 0.25, 0.7, 1], delay: (2 - i) * 0.3, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </svg>
  );
}

/** Fills the preview while the first render of a file runs. */
export function RenderProgressPanel({ progress }: { progress: RenderProgressState | undefined }) {
  const live = useLive(progress);
  return (
    <MotionConfig reducedMotion="user">
      <div className="flex size-full flex-col items-center justify-center gap-5 bg-card p-6" aria-live="polite">
        <Mark />
        <div className="w-full max-w-xs space-y-3">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <motion.span key={live.label} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="min-w-0 truncate">
              {live.label}
            </motion.span>
            {live.elapsed && <span className="shrink-0 tabular-nums text-xs text-dim">{live.elapsed}</span>}
          </div>
          <Bar fraction={live.fraction} />
          <ol className="grid grid-cols-4 gap-1 text-xs">
            {PHASES.map((p, i) => {
              const done = i < live.phase;
              const active = i === live.phase;
              return (
                <li key={p.id} className={cn("flex items-center justify-center gap-1 transition-colors", active ? "font-medium text-brand" : done ? "text-foreground" : "text-dim")} aria-current={active ? "step" : undefined}>
                  {done && <CheckIcon className="size-3" />}
                  {p.label}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </MotionConfig>
  );
}

/** A thin strip over the previous result while a new render of the same file runs. */
export function RenderProgressStrip({ progress }: { progress: RenderProgressState | undefined }) {
  const live = useLive(progress);
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-3 border-b border-line bg-card/90 px-3 py-1.5 text-xs backdrop-blur-sm"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        aria-live="polite"
      >
        <span className="min-w-0 shrink-0 truncate">{live.label}</span>
        <Bar fraction={live.fraction} className="flex-1" />
        {live.elapsed && <span className="shrink-0 tabular-nums text-dim">{live.elapsed}</span>}
      </motion.div>
    </MotionConfig>
  );
}
