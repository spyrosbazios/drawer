import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { formatElapsed, phaseIndex, progressFraction, stageLabel } from "../src/core/render-progress";
import { applyRenderProgress, type RenderProgressState } from "../src/hooks/render-progress";

describe("render progress maths", () => {
  test("queued is zero; a running unit creeps but never completes", () => {
    expect(progressFraction("queued", 0, 7, 30)).toBe(0);
    expect(progressFraction("geometry", 1, 7, 0)).toBeCloseTo(1 / 7, 6);
    const late = progressFraction("geometry", 1, 7, 600);
    expect(late).toBeGreaterThan(1.8 / 7);
    expect(late).toBeLessThan(2 / 7);
    expect(progressFraction("sheet", 6, 7, 600)).toBeLessThan(1);
  });

  test("the bar only moves forward across a normal render", () => {
    const seq: [Parameters<typeof progressFraction>[0], number, number][] = [["analysing", 0, 1], ["geometry", 1, 40], ["views", 2, 2], ["views", 3, 2], ["sheet", 6, 1]];
    const values = seq.flatMap(([stage, step, secs]) => [progressFraction(stage, step, 7, 0), progressFraction(stage, step, 7, secs)]);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  test("labels and phases", () => {
    expect(stageLabel("views", 3, 7, "front")).toBe("Drawing the front view (2 of 4)");
    expect(stageLabel("geometry", 1, 7, null)).toBe("Building geometry");
    expect(phaseIndex("queued")).toBe(-1);
    expect(phaseIndex("views")).toBe(2);
    expect(formatElapsed(4.9)).toBe("4 s");
    expect(formatElapsed(67)).toBe("1:07");
  });
});

describe("applyRenderProgress", () => {
  const base = { type: "render_progress", project: "p", path: "src/a.scad", at: null, total: 7, view: null } as const;
  const key = ["render-progress", "p", "src/a.scad", ""];

  test("tracks a render from queued to done", () => {
    const qc = new QueryClient();
    applyRenderProgress(qc, { ...base, stage: "queued", step: 0 }, 1000);
    applyRenderProgress(qc, { ...base, stage: "geometry", step: 1 }, 3000);
    expect(qc.getQueryData<RenderProgressState>(key)).toEqual({ stage: "geometry", step: 1, total: 7, view: null, startedAt: 1000, stageAt: 3000 });
    applyRenderProgress(qc, { ...base, stage: "views", step: 2, view: "iso" }, 9000);
    applyRenderProgress(qc, { ...base, stage: "views", step: 3, view: "front" }, 9500);
    expect(qc.getQueryData<RenderProgressState>(key)).toMatchObject({ startedAt: 1000, stageAt: 9500, view: "front" });
    applyRenderProgress(qc, { ...base, stage: "done", step: 7 }, 9900);
    expect(qc.getQueryData(key)).toBeUndefined();
  });

  test("a new render restarts the clock; a failure clears; revisions are separate", () => {
    const qc = new QueryClient();
    applyRenderProgress(qc, { ...base, stage: "geometry", step: 1 }, 500);
    applyRenderProgress(qc, { ...base, stage: "queued", step: 0 }, 8000);
    expect(qc.getQueryData<RenderProgressState>(key)?.startedAt).toBe(8000);
    applyRenderProgress(qc, { ...base, at: "abc", stage: "queued", step: 0 }, 8100);
    applyRenderProgress(qc, { ...base, stage: "failed", step: 0 }, 8200);
    expect(qc.getQueryData(key)).toBeUndefined();
    expect(qc.getQueryData(["render-progress", "p", "src/a.scad", "abc"])).toBeDefined();
  });
});
