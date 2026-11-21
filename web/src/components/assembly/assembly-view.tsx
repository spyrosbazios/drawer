import type { AssemblyReport, Axis } from "@drawer/shared/api";
import { BoxesIcon, CrosshairIcon, ExternalLinkIcon, LoaderCircleIcon, MessageSquarePlusIcon, ScanIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatusChip } from "@/components/status/status-chip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatGates, formatLength } from "@/core/format";
import { useAssembly } from "@/hooks/assembly";
import { useStartAgent } from "@/hooks/start-agent";
import { ASSEMBLY_PROMPT } from "@/components/workspace/kickstart";
import { CutControl } from "@/components/viewers/cut-control";
import { FitButton } from "@/components/viewers/fit-button";
import { PlainViewer, ViewerMenubar, cameraMenu, useShadingEntry, useViewportKeys } from "@/components/viewers/viewer-menubar";
import type { MenuSpec } from "@/components/viewers/viewer-menubar";
import type { ViewControl } from "@/lib/camera-rig";
import { AssemblyScene } from "@/lib/assembly-scene";
import type { AssemblyMode, ScenePick } from "@/lib/assembly-scene";
import { useLocalPref } from "@/lib/local-pref";
import { webglAvailable } from "@/lib/mesh-scene";
import { pointing } from "@/lib/pointing";
import { realisticShading } from "@/lib/shading";
import { cn } from "@/lib/utils";
import { useOpenPart } from "./assembly-actions";
import { clashingPairs, formatOverlap, failingInstances, failingPairs, mateRows, partSlots } from "./assembly-model";
import { assemblySelection, useAssemblySelection } from "./assembly-selection";

/**
 * SLOT (feature: assembly). The workspace centre when the assembly is selected (`?assembly=1`).
 * Reads `useAssembly(slug)` (null = the project has no assembly yet: say so).
 *
 * Renders the placed parts in 3D (`lib/assembly-scene.ts`: each `report.instances[i].mesh` with its row-major
 * matrix, a categorical colour per part) in four local modes (assembled, exploded, clashes, section) chosen in
 * the shared menubar (View, Camera; the view cube sits in the canvas), a status bar, and the mates table. Hover names an instance; a click selects it (shared with the panel
 * through `assembly-selection.ts`) and offers "Open part" and "Point at this in chat" (`pointing.add`).
 */
export interface AssemblyViewProps {
  slug: string;
}

const MODES: { id: AssemblyMode; label: string }[] = [
  { id: "assembled", label: "Assembled" },
  { id: "exploded", label: "Exploded" },
  { id: "clashes", label: "Clashes" },
  { id: "section", label: "Section" },
];
const isMode = (v: string): v is AssemblyMode => MODES.some((m) => m.id === v);

export function AssemblyView({ slug }: AssemblyViewProps) {
  const q = useAssembly(slug);
  if (q.status === "ready" && q.data !== null) return <AssemblyBody slug={slug} report={q.data} refreshing={q.refreshing} />;
  return (
    <PlainViewer label="Assembly viewer">
      {q.status === "pending" ? (
        <Skeleton className="m-4 h-[60%]" aria-label="Loading assembly" />
      ) : q.status === "error" ? (
        <Notice icon={<TriangleAlertIcon />} title="The assembly could not be loaded">{q.error.message}</Notice>
      ) : (
        <NoAssembly slug={slug} />
      )}
    </PlainViewer>
  );
}

function Notice({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="text-faint [&_svg]:size-8">{icon}</span>
      <h2 className="text-base font-medium">{title}</h2>
      <div className="max-w-md text-sm text-dim">{children}</div>
    </div>
  );
}

function NoAssembly({ slug }: { slug: string }) {
  const agent = useStartAgent(slug);
  return (
    <Notice icon={<BoxesIcon />} title="No assembly yet">
      <p>The agent writes it from the parts.</p>
      {!agent.noRunner && (
        <Button className="mt-4" onClick={() => agent.start(ASSEMBLY_PROMPT)} disabled={agent.pending}>
          {agent.pending ? <LoaderCircleIcon className="animate-spin" /> : <MessageSquarePlusIcon />}
          Draft the assembly
        </Button>
      )}
    </Notice>
  );
}

function AssemblyBody({ slug, report, refreshing }: { slug: string; report: AssemblyReport; refreshing: boolean }) {
  const [mode, setMode] = useState<AssemblyMode>("assembled");
  const [explode, setExplode] = useState(0.5);
  const [axis, setAxis] = useState<Axis>("z");
  const [at, setAt] = useState(0.5);
  const [point, setPoint] = useState<ScenePick | null>(null);
  const [scene, setScene] = useState<ViewControl | null>(null);
  const selected = useAssemblySelection(slug);
  const openPart = useOpenPart(slug);
  const instanceById = useMemo(() => new Map(report.instances.map((i) => [i.id, i])), [report]);
  const missing = report.instances.filter((i) => i.mesh === null);
  const clashes = clashingPairs(report);
  const one = selected.length === 1 && selected[0] !== undefined ? instanceById.get(selected[0]) : undefined;
  const evaluating = report.status === "pending";

  const shading = useShadingEntry();
  const menus: MenuSpec[] = [
    {
      id: "view",
      label: "View",
      entries: [
        { kind: "radio", value: mode, onChange: (v) => isMode(v) && setMode(v), options: MODES.map((m) => ({ value: m.id, label: m.id === "clashes" && clashes.length > 0 ? `${m.label} (${clashes.length})` : m.label })) },
        { kind: "separator" },
        shading,
      ],
    },
    cameraMenu(scene),
  ];
  const status = (
    <>
      {(evaluating || refreshing) && (
        <span className="inline-flex items-center gap-1 text-run">
          <LoaderCircleIcon className="size-3 animate-spin" /> {evaluating ? "Evaluating" : "Refreshing"}
        </span>
      )}
      <span className="hidden truncate sm:inline">{MODES.find((m) => m.id === mode)?.label}</span>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto md:overflow-hidden">
      <ViewerMenubar label="Assembly viewer" menus={menus} status={status} />

      <div className="relative h-[55vh] shrink-0 md:h-auto md:min-h-0 md:flex-1">
        {webglAvailable() ? (
          <Viewer slug={slug} report={report} mode={mode} explode={explode} axis={axis} at={at} selected={selected} onPoint={setPoint} view={scene} onScene={setScene} />
        ) : (
          <Fallback report={report} />
        )}
        {mode === "exploded" && <OverlaySlider label="Spread" value={explode} onChange={setExplode} aria="Explode distance" />}
        {mode === "section" && <CutControl axis={axis} onAxis={setAxis} fraction={at} onFraction={setAt} />}
        {mode === "clashes" && clashes.length > 0 && (
          <ul className="absolute top-2 left-2 space-y-1 text-xs">
            {clashes.map((p) => (
              <li key={`${p.a}|${p.b}`} className="rounded-md border border-down/40 bg-card/90 px-2 py-1 text-down">
                {p.a} × {p.b}: {formatOverlap(p.overlapCm3)} overlap
              </li>
            ))}
          </ul>
        )}
        {one && (
          <div className="absolute right-2 bottom-2 left-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-card/95 px-3 py-2 text-sm shadow-sm md:left-auto">
            <span className="font-medium">{one.id}</span>
            <span className="text-dim">{one.part}</span>
            <StatusChip kind="report" status={one.partStatus} />
            <Button size="sm" variant="outline" onClick={() => openPart(one.part)}>
              <ExternalLinkIcon /> Open part
            </Button>
            <Button size="sm" variant="outline" onClick={() => pointing.add(slug, { kind: "part", part: one.part })}>
              <ScanIcon /> Point at this in chat
            </Button>
            {point && point.id === one.id && (
              <Button size="sm" variant="ghost" onClick={() => pointing.add(slug, { kind: "point", part: one.part, position: point.position, normal: point.normal })}>
                <CrosshairIcon /> Point at this spot
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-xs text-dim">
        <StatusChip kind="report" status={report.status} />
        <span>{formatGates(report.passed, report.total)}</span>
        <span>{report.spec.title}</span>
        <span>{report.instances.length} instances</span>
        {failingPairs(report).length > 0 && <span className="text-down">{failingPairs(report).length} failing pairs</span>}
        {missing.length > 0 && (
          <span className="text-warn">
            Not drawn (no model): {missing.map((m) => m.id).join(", ")}
          </span>
        )}
      </div>

      <MatesTable slug={slug} report={report} selected={selected} />
    </div>
  );
}

interface ViewerProps {
  slug: string;
  report: AssemblyReport;
  mode: AssemblyMode;
  explode: number;
  axis: Axis;
  at: number;
  selected: readonly string[];
  /** The clicked spot (null = clicked empty space). */
  onPoint: (pick: ScenePick | null) => void;
  /** The scene the Camera menu and the fit button drive (null until it exists). */
  view: ViewControl | null;
  /** Hands the scene out (null on unmount). */
  onScene: (scene: ViewControl | null) => void;
}

function Viewer({ slug, report, mode, explode, axis, at, selected, onPoint, view, onScene }: ViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<AssemblyScene | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const realistic = useLocalPref(realisticShading);
  const key = report.revisionId + report.evaluatedAt;
  const instanceById = useMemo(() => new Map(report.instances.map((i) => [i.id, i])), [report]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s = new AssemblyScene(el);
    scene.current = s;
    onScene(s);
    return () => {
      onScene(null);
      s.dispose();
      scene.current = null;
    };
  }, [onScene]);

  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    s.onHover = setHover;
    s.onPick = (pick) => {
      assemblySelection.set(slug, pick ? [pick.id] : []);
      onPoint(pick);
    };
  }, [slug, onPoint]);

  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    let current = true;
    const slots = partSlots(report.instances);
    const drawn = report.instances.flatMap((i) => (i.mesh ? [{ id: i.id, mesh: i.mesh, matrix: i.matrix, slot: slots.get(i.part)?.slot ?? 0 }] : []));
    s.setInstances(drawn).then(
      () => current && setLoaded(key),
      (err: unknown) => current && setFailure({ key, message: err instanceof Error ? err.message : "A model could not be read." }),
    );
    return () => {
      current = false;
    };
  }, [report, key]);

  useEffect(() => {
    scene.current?.setClashes(
      failingInstances(report),
      clashingPairs(report).map((p) => [p.a, p.b]),
    );
  }, [report, loaded]);
  useEffect(() => scene.current?.setMode(mode), [mode, loaded]);
  useEffect(() => scene.current?.setExplode(explode), [explode, loaded]);
  useEffect(() => scene.current?.setSection(axis, at), [axis, at, loaded]);
  useEffect(() => scene.current?.setSelected(selected), [selected, loaded]);
  useEffect(() => scene.current?.setRealistic(realistic), [realistic, loaded]);

  const hovered = hover ? instanceById.get(hover) : undefined;
  useViewportKeys(view);
  const state = failure?.key === key ? "error" : loaded === key ? "ready" : "loading";
  useEffect(() => scene.current?.setGizmo(state === "ready"), [state]);

  return (
    <>
      <div ref={host} className="absolute inset-0" />
      {state === "ready" && <FitButton view={view} />}
      {state === "loading" && <Skeleton className="pointer-events-none absolute inset-0 rounded-none" aria-label="Loading models" />}
      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-sm text-down">{failure?.message}</div>
      )}
      {hovered && (
        <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-card/90 px-2 py-0.5 text-xs">
          {hovered.id} <span className="text-dim">({hovered.part})</span>
        </span>
      )}
    </>
  );
}

function Fallback({ report }: { report: AssemblyReport }) {
  const src = report.render?.sheet ?? report.render?.views.iso ?? null;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card p-3">
      <p className="text-xs text-dim">This browser cannot start WebGL: showing the server&apos;s rendered views.</p>
      {src ? <img src={src} alt="Rendered views of the assembly" className="min-h-0 max-w-full flex-1 object-contain" /> : <p className="text-sm text-faint">No rendered views yet.</p>}
    </div>
  );
}

function MatesTable({ slug, report, selected }: { slug: string; report: AssemblyReport; selected: readonly string[] }) {
  const rows = mateRows(report);
  return (
    <section className="shrink-0 border-t border-line md:max-h-[35%] md:overflow-y-auto">
      <h3 className="px-3 pt-2 text-xs font-medium tracking-wide text-faint uppercase">Mates</h3>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-sm text-dim">No mates stated: the assembly says nothing about how its parts meet.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mate</TableHead>
                <TableHead>Between</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead className="text-right">Gap</TableHead>
                <TableHead className="text-right">Overlap</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const on = selected.length === 2 && selected.includes(r.mate.a) && selected.includes(r.mate.b);
                return (
                  <TableRow
                    key={r.mate.id}
                    data-state={on ? "selected" : undefined}
                    className={cn("cursor-pointer", on && "bg-raised")}
                    onClick={() => assemblySelection.set(slug, on ? [] : [r.mate.a, r.mate.b])}
                  >
                    <TableCell className="font-medium">{r.mate.label}</TableCell>
                    <TableCell className="text-dim">
                      {r.mate.a} × {r.mate.b}
                    </TableCell>
                    <TableCell className="text-dim">{r.expected}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.pair ? formatLength(r.pair.gapMm) : "-"}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", r.pair && r.pair.overlapCm3 > 0 && "text-down")}>{r.pair ? formatOverlap(r.pair.overlapCm3) : "-"}</TableCell>
                    <TableCell>{r.gate ? <StatusChip kind="gate" status={r.gate.status} /> : <span className="text-faint">-</span>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

/** A continuous control for one mode (spread, cut position): it stays in the canvas, not in a menu. */
function OverlaySlider({ label, value, onChange, aria }: { label: string; value: number; onChange: (v: number) => void; aria: string }) {
  return (
    <div className="absolute top-2 left-2 flex w-56 max-w-[calc(100%-6rem)] items-center gap-3 rounded-lg border border-line bg-card/95 px-3 py-2 text-xs shadow-sm backdrop-blur-sm">
      <span className="shrink-0 text-dim uppercase">{label}</span>
      <Slider min={0} max={1} step={0.01} value={[value]} onValueChange={(v) => onChange(v[0] ?? 0)} aria-label={aria} />
    </div>
  );
}
