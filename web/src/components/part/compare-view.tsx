import type { CompareResult, PartReport } from "@drawer/shared/api";
import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { StatusChip } from "@/components/status/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDelta, formatLength, formatMass, formatNumber, formatVolume } from "@/core/format";
import { useField } from "@/hooks/measure";
import { useCompare, usePartReport } from "@/hooks/parts";
import type { ViewControl } from "@/lib/camera-rig";
import { deviationDomain } from "@/lib/field-colors";
import type { FieldPaint, MeshScene } from "@/lib/mesh-scene";
import { webglAvailable } from "@/lib/mesh-scene";
import { pointing, usePointed } from "@/lib/pointing";
import { FieldLegend } from "./field-legend";
import { CanvasFallback, PartCanvas, RenderViews } from "./model-views";
import { formatParam, gateChanges, paramChanges } from "./part-facts";
import { pointMarkers } from "./part-stage";

interface Props {
  slug: string;
  part: string;
  /** A: the revision compared against. */
  compare: string;
  /** B: a revision, or undefined for the current model. */
  at: string | undefined;
  /** "Deviation" shows B painted with its deviation from A; any other mode puts the two side by side. */
  deviation: boolean;
  /** What a person reads for A and B ("r2", "current"). */
  labelA: string;
  labelB: string;
  /** Hands out the scene the Camera menu drives (null on unmount). */
  onScene: (scene: ViewControl | null) => void;
}

/** Keeps two scenes' cameras together: moving either moves the other. */
function useLinkedCameras(a: MeshScene | null, b: MeshScene | null): void {
  useEffect(() => {
    if (!a || !b) return;
    const offA = a.addViewListener((pose) => b.setView(pose));
    const offB = b.addViewListener((pose) => a.setView(pose));
    return () => {
      offA();
      offB();
    };
  }, [a, b]);
}

/** A against B: side by side with linked cameras, or B painted with its deviation from A; what changed beside it. The menubar above holds the controls. */
export function CompareView({ slug, part, compare, at, deviation, labelA, labelB, onScene }: Props) {
  const sideA = useMemo(() => ({ part, at: compare }), [part, compare]);
  const sideB = useMemo(() => ({ part, at }), [part, at]);
  const result = useCompare(slug, sideA, sideB);
  const reportA = usePartReport(slug, part, compare);
  const reportB = usePartReport(slug, part, at);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_18rem] lg:overflow-hidden">
      <section aria-label="Compare" className="relative flex min-h-[22rem] flex-col lg:min-h-0">
        <div className="relative min-h-0 flex-1">
          {result.isPending ? (
            <Skeleton className="size-full rounded-none" aria-label="Comparing" />
          ) : result.isError ? (
            <p role="alert" className="flex h-full items-center justify-center gap-2 p-6 text-sm text-down">
              <TriangleAlertIcon className="size-4" /> {result.error.message}
            </p>
          ) : deviation ? (
            <DeviationPane slug={slug} part={part} result={result.data} labelA={labelA} labelB={labelB} onScene={onScene} />
          ) : (
            <SideBySide result={result.data} labelA={labelA} labelB={labelB} onScene={onScene} />
          )}
        </div>
      </section>
      <WhatChanged a={reportA.data} b={reportB.data} result={result.data} labelA={labelA} labelB={labelB} />
    </div>
  );
}

function SideBySide({ result, labelA, labelB, onScene }: { result: CompareResult; labelA: string; labelB: string; onScene: (scene: ViewControl | null) => void }) {
  const [a, setA] = useState<MeshScene | null>(null);
  const [b, setB] = useState<MeshScene | null>(null);
  useLinkedCameras(a, b);
  // Both panes share one camera, so the cube and the Camera menu drive B's: A follows it.
  const sceneB = useCallback(
    (s: MeshScene | null) => {
      setB(s);
      onScene(s);
    },
    [onScene],
  );
  if (!webglAvailable()) return <RenderViews render={result.b.render} note="This browser cannot start WebGL: B's rendered views instead." />;
  return (
    <div className="grid size-full grid-rows-2 divide-y divide-line sm:grid-cols-2 sm:grid-rows-1 sm:divide-x sm:divide-y-0">
      <Suspense fallback={<CanvasFallback />}>
        <PartCanvas url={result.a.render.mesh} caption={`A · ${labelA}`} onScene={setA} cube={false} />
      </Suspense>
      <Suspense fallback={<CanvasFallback />}>
        <PartCanvas url={result.b.render.mesh} caption={`B · ${labelB}`} onScene={sceneB} />
      </Suspense>
    </div>
  );
}

function DeviationPane({ slug, part, result, labelA, labelB, onScene }: { slug: string; part: string; result: CompareResult; labelA: string; labelB: string; onScene: (scene: ViewControl | null) => void }) {
  const values = useField(result.deviation.field);
  const picks = usePointed(slug);
  const domain = useMemo(() => deviationDomain(result.deviation.min, result.deviation.max), [result.deviation.min, result.deviation.max]);
  const field: FieldPaint | null = useMemo(() => (values.data ? { kind: "deviation", values: values.data, domain } : null), [values.data, domain]);
  const markers = useMemo(() => {
    const out = pointMarkers(picks, part);
    const d = result.deviation;
    if (d.at) out.push({ key: "dev", position: d.at, text: `${formatDelta(Math.abs(d.max) >= Math.abs(d.min) ? d.max : d.min)}`, title: "Largest difference", tone: "pin" });
    return out;
  }, [picks, part, result.deviation]);
  if (!webglAvailable()) return <RenderViews render={result.b.render} note="This browser cannot start WebGL: B's rendered views instead." />;
  return (
    <>
      <Suspense fallback={<CanvasFallback />}>
        <PartCanvas
          url={result.b.render.mesh}
          field={field}
          markers={markers}
          onScene={onScene}
          caption={`B − A · ${labelB} against ${labelA}`}
          onPick={(hit) => pointing.add(slug, { kind: "point", part, position: hit.position, normal: hit.normal })}
        />
      </Suspense>
      {values.isError && <p className="absolute top-10 left-2 rounded border border-line bg-card/90 px-2 py-1 text-xs text-warn">{values.error.message}</p>}
      <FieldLegend kind="deviation" domain={domain} caption={`Deviation B − A · rms ${formatLength(result.deviation.rms)} · p95 ${formatLength(result.deviation.p95)}`} />
    </>
  );
}

interface WhatChangedProps {
  a: PartReport | undefined;
  b: PartReport | undefined;
  result: CompareResult | undefined;
  labelA: string;
  labelB: string;
}

function WhatChanged({ a, b, result, labelA, labelB }: WhatChangedProps) {
  const params = a && b ? paramChanges(a, b) : [];
  const gates = a && b ? gateChanges(a, b) : null;
  const size = result?.sizeDelta;
  const massDelta = a?.massG != null && b?.massG != null ? b.massG - a.massG : null;

  return (
    <aside aria-label="What changed" className="space-y-4 border-t border-line bg-card p-3 text-sm lg:overflow-y-auto lg:border-t-0 lg:border-l">
      <h2 className="text-xs font-medium tracking-wide text-dim uppercase">
        What changed · {labelA} → {labelB}
      </h2>

      <Group title="Parameters">
        {!a || !b ? (
          <Skeleton className="h-6 w-full" />
        ) : params.length === 0 ? (
          <p className="text-xs text-dim">No parameter changed.</p>
        ) : (
          params.map((p) => (
            <Row key={p.name}>
              <span className="font-mono text-xs">{p.name}</span>
              <span className="ml-auto flex items-center gap-1 text-xs tabular-nums">
                {formatParam(p.a)} <ArrowRightIcon className="size-3 text-dim" /> {formatParam(p.b)}
              </span>
            </Row>
          ))
        )}
      </Group>

      <Group title="Gates">
        {!gates ? (
          <Skeleton className="h-6 w-full" />
        ) : (
          <>
            {gates.changed.map((g) => (
              <Row key={g.id}>
                <span className="min-w-0 flex-1 truncate text-xs">{g.label}</span>
                {g.a ? <StatusChip kind="gate" status={g.a} /> : <span className="text-xs text-faint">none</span>}
                <ArrowRightIcon className="size-3 shrink-0 text-dim" />
                {g.b ? <StatusChip kind="gate" status={g.b} /> : <span className="text-xs text-faint">none</span>}
              </Row>
            ))}
            <p className="text-xs text-dim">{gates.changed.length === 0 ? "No gate changed." : `${gates.unchanged} others unchanged.`}</p>
          </>
        )}
      </Group>

      <Group title="Measured">
        {!result ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
            <dt className="text-dim">volume</dt>
            <dd>
              {formatVolume(result.a.mesh.volumeCm3)} → {formatVolume(result.b.mesh.volumeCm3)}
              {result.volumeDeltaCm3 !== null && <span className="text-dim"> ({formatDelta(result.volumeDeltaCm3, "cm³")})</span>}
            </dd>
            <dt className="text-dim">mass</dt>
            <dd>
              {formatMass(a?.massG)} → {formatMass(b?.massG)}
              {massDelta !== null && <span className="text-dim"> ({formatDelta(massDelta, "g")})</span>}
            </dd>
            <dt className="text-dim">size</dt>
            <dd>{size && size.every((d) => Math.abs(d) < 0.005) ? "unchanged" : size?.map((d, i) => `${"xyz"[i]} ${formatDelta(d)}`).join(", ")}</dd>
            <dt className="text-dim">deviation</dt>
            <dd>
              {formatNumber(result.deviation.min)} … {formatNumber(result.deviation.max)} mm
            </dd>
          </dl>
        )}
      </Group>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 rounded-md border border-line px-2 py-1">{children}</div>;
}
