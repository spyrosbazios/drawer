import type { DrawerEvent } from "@drawer/shared/api";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

type ProgressEvent = Extract<DrawerEvent, { type: "render_progress" }>;

/** A running render as the server last reported it. `startedAt` and `stageAt` are local clock times (ms). */
export interface RenderProgressState {
  stage: Exclude<ProgressEvent["stage"], "done" | "failed">;
  step: number;
  total: number;
  view: ProgressEvent["view"];
  startedAt: number;
  stageAt: number;
}

const key = (slug: string, path: string, at: string | null | undefined) => ["render-progress", slug, path, at ?? ""] as const;

/** Keeps the progress of each running render in the query cache; the end of a render clears it. */
export function applyRenderProgress(qc: QueryClient, e: ProgressEvent, now: number): void {
  const queryKey = key(e.project, e.path, e.at);
  if (e.stage === "done" || e.stage === "failed") {
    qc.removeQueries({ queryKey });
    return;
  }
  const { stage, step, total, view } = e;
  qc.setQueryData<RenderProgressState>(queryKey, (prev) => ({
    stage,
    step,
    total,
    view,
    // `queued` opens a render; anything else without a predecessor means we connected mid-render.
    startedAt: prev && stage !== "queued" ? prev.startedAt : now,
    stageAt: prev && prev.stage === stage && prev.step === step ? prev.stageAt : now,
  }));
}

/** The live progress of the render of this file (and revision), or undefined when none is running. */
export function useRenderProgress(slug: string, path: string, at: string | undefined): RenderProgressState | undefined {
  return useQuery<RenderProgressState>({ queryKey: key(slug, path, at), queryFn: skipToken, staleTime: Infinity, gcTime: 5 * 60_000 }).data;
}
