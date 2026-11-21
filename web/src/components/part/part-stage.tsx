import type { PartReport, SessionRef } from "@drawer/shared/api";
import { GitCompareArrowsIcon, TriangleAlertIcon } from "lucide-react";
import { Suspense, useCallback, useMemo, useState } from "react";
import { formatLength } from "@/core/format";
import { useField } from "@/hooks/measure";
import { useAttempts } from "@/hooks/parts";
import type { RenderProgressState } from "@/hooks/render-progress";
import type { ViewControl } from "@/lib/camera-rig";
import { thicknessDomain } from "@/lib/field-colors";
import type { Axis3, FieldPaint, MeshScene, PickHit, SectionCut } from "@/lib/mesh-scene";
import { webglAvailable } from "@/lib/mesh-scene";
import { useProjectNav } from "@/lib/nav";
import { pointing, usePointed } from "@/lib/pointing";
import type { PartMode } from "@/lib/route-search";
import { CutControl } from "@/components/viewers/cut-control";
import { RenderProgressStrip } from "@/components/viewers/render-progress";
import { FieldLegend } from "./field-legend";
import { layoutAttempts } from "./attempt-tree";
import { CanvasFallback, PartCanvas, RenderViews } from "./model-views";
import type { SceneMarker } from "./part-canvas";
import { locatedFailures, requiredMinWall } from "./part-facts";

/** Where the section cuts: across `axis`, at `fraction` of the bounding box along it (so changing the axis keeps a sensible cut). */
export interface SectionState {
  axis: Axis3;
  fraction: number;
}

interface Props {
  slug: string;
  part: string;
  report: PartReport;
  mode: Exclude<PartMode, "code">;
  evaluating: boolean;
  progress: RenderProgressState | undefined;
  /** Draw the failing gates as markers on the model (View menu). */
  showGates: boolean;
  section: SectionState;
  onSection: (section: SectionState) => void;
  /** Hands the scene out (null on unmount): the Camera menu drives it. */
  onScene: (scene: ViewControl | null) => void;
}

const AXIS_INDEX: Record<Axis3, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/** Picks of this part as numbered markers; the number is the pick's place in the next message. */
export function pointMarkers(picks: readonly SessionRef[], part: string): SceneMarker[] {
  return picks.flatMap((r, i) =>
    r.kind === "point" && r.part === part ? [{ key: `p${i}`, position: r.position, text: String(i + 1), title: `Point ${i + 1}, attached to your next message`, tone: "point" as const }] : [],
  );
}

/** The 3D view of the part's current (or `at`) report in one of the 3D modes. */
export function PartStage({ slug, part, report, mode, evaluating, progress, showGates, section: sectionState, onSection, onScene }: Props) {
  const picks = usePointed(slug);
  const thickness = useField(mode === "thickness" ? report.analysis?.thickness : null);
  const [mismatch, setMismatch] = useState<string | null>(null);

  const bbox = report.mesh?.bbox ?? null;
  const { axis, fraction } = sectionState;
  const section: SectionCut | null = useMemo(() => {
    if (mode !== "section" || !bbox) return null;
    const i = AXIS_INDEX[axis];
    // A hair inside the box so the end positions still show a face.
    return { axis, offset: bbox.min[i] + (bbox.max[i] - bbox.min[i]) * Math.min(0.999, Math.max(0.001, fraction)) };
  }, [mode, bbox, axis, fraction]);

  const required = requiredMinWall(report);
  const domain = useMemo(() => (thickness.data ? thicknessDomain(thickness.data, required) : null), [thickness.data, required]);
  const field: FieldPaint | null = useMemo(() => (mode === "thickness" && thickness.data && domain ? { kind: "thickness", values: thickness.data, domain } : null), [mode, thickness.data, domain]);

  const markers = useMemo(() => {
    const out: SceneMarker[] = pointMarkers(picks, part);
    if (showGates) for (const g of locatedFailures(report.gates)) out.push({ key: `g:${g.id}`, position: g.at, text: g.label, title: `${g.label}: ${g.measured ?? g.status}${g.expected ? `, needs ${g.expected}` : ""}`, tone: "gate" });
    const wall = report.analysis?.wall;
    if (mode === "thickness" && wall) out.push({ key: "wall", position: wall.at, text: `thinnest ${formatLength(wall.minMm)}`, title: `Thinnest wall: ${formatLength(wall.minMm)}`, tone: "pin" });
    return out;
  }, [picks, part, showGates, report.gates, report.analysis, mode]);

  const onPick = useCallback((hit: PickHit) => pointing.add(slug, { kind: "point", part, position: hit.position, normal: hit.normal }), [slug, part]);
  const fieldUrl = report.analysis?.thickness ?? "";
  const onFieldMismatch = useCallback(() => setMismatch(fieldUrl), [fieldUrl]);
  const onMeshScene = useCallback((s: MeshScene | null) => onScene(s), [onScene]);
  const render = report.render;
  if (!render) return null;

  return (
    <div className="relative size-full min-h-0">
      {!webglAvailable() ? (
        <RenderViews render={render} note="This browser cannot start WebGL: the rendered views instead." />
      ) : (
        <Suspense fallback={<CanvasFallback />}>
          <PartCanvas url={render.mesh} field={field} section={section} markers={markers} onPick={onPick} onScene={onMeshScene} onFieldMismatch={onFieldMismatch} />
        </Suspense>
      )}
      {mode === "thickness" && <ThicknessNote report={report} pending={thickness.isPending && !!report.analysis?.thickness} error={thickness.isError ? thickness.error.message : mismatch === fieldUrl && fieldUrl ? "The thickness field does not match this mesh." : null} />}
      {mode === "thickness" && domain && (
        <FieldLegend kind="thickness" domain={domain} caption="Wall thickness" mark={required !== null ? { value: required, label: `required ≥ ${formatLength(required)}` } : null} />
      )}
      {mode === "section" && bbox && (
        <CutControl
          axis={axis}
          onAxis={(a) => onSection({ axis: a, fraction })}
          fraction={fraction}
          onFraction={(f) => onSection({ axis, fraction: f })}
          readout={section ? formatLength(section.offset) : undefined}
        />
      )}
      {mode === "deviation" && <ComparePicker slug={slug} part={part} current={report.revisionId} />}
      {evaluating && <RenderProgressStrip progress={progress} />}
    </div>
  );
}

function ThicknessNote({ report, pending, error }: { report: PartReport; pending: boolean; error: string | null }) {
  const text = !report.analysis?.thickness ? "No thickness field: the mesh is not closed." : error ? error : pending ? "Loading the thickness field…" : null;
  if (!text) return null;
  return (
    <p className={`absolute top-2 left-2 flex items-center gap-1.5 rounded border border-line bg-card/90 px-2 py-1 text-xs ${error ? "text-warn" : "text-dim"}`}>
      {error && <TriangleAlertIcon className="size-3.5" />}
      {text}
    </p>
  );
}

/** Deviation needs a second state: offer the attempts to compare with. */
function ComparePicker({ slug, part, current }: { slug: string; part: string; current: string }) {
  const nav = useProjectNav(slug);
  const attempts = useAttempts(slug, part);
  const nodes = useMemo(() => layoutAttempts(attempts.data ?? []).nodes.filter((n) => n.attempt.revisionId !== current).sort((a, b) => b.attempt.date.localeCompare(a.attempt.date)), [attempts.data, current]);
  return (
    <div className="absolute inset-x-3 top-3 right-24 mx-auto max-w-sm rounded-lg border border-line bg-card/95 p-3 text-sm shadow-md backdrop-blur-sm">
      <p className="mb-2 flex items-center gap-2 font-medium">
        <GitCompareArrowsIcon className="size-4 text-dim" /> Compare this with
      </p>
      {nodes.length === 0 ? (
        <p className="text-xs text-faint">No other attempt yet.</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {nodes.map((n) => (
            <li key={n.attempt.revisionId}>
              <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-raised" onClick={() => nav.setCompare(n.attempt.revisionId)}>
                <span className="w-7 font-medium">{n.label}</span>
                <span className="min-w-0 flex-1 truncate">{n.attempt.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
