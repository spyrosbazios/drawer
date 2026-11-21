import { BoxIcon, CodeIcon, SearchXIcon, TriangleAlertIcon, Undo2Icon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAttempts, useParts, usePartReport, usePartSummary, useRestoreAttempt } from "@/hooks/parts";
import { useRenderProgress } from "@/hooks/render-progress";
import type { ViewControl } from "@/lib/camera-rig";
import { useProjectNav } from "@/lib/nav";
import { pointing, usePointed } from "@/lib/pointing";
import { PART_MODES } from "@/lib/route-search";
import type { PartMode } from "@/lib/route-search";
import { RenderProgressPanel } from "@/components/viewers/render-progress";
import { PlainViewer, StatusPill, ViewerMenubar, cameraMenu, useShadingEntry } from "@/components/viewers/viewer-menubar";
import type { MenuEntry, MenuSpec } from "@/components/viewers/viewer-menubar";
import { layoutAttempts } from "./attempt-tree";
import type { TreeNode } from "./attempt-tree";
import { AttemptsStrip } from "./attempts-strip";
import { CompareView } from "./compare-view";
import { GateBar } from "./gate-bar";
import { ModelCode } from "./model-views";
import { isFailing, locatedFailures } from "./part-facts";
import { PartStage } from "./part-stage";
import type { SectionState } from "./part-stage";
import { RestoreDialog } from "./restore-dialog";

/**
 * SLOT (feature: part viewer). The workspace centre when a part is selected (`?part=<id>`).
 *
 * Props come straight from the URL; the component reads everything else from the query cache:
 * `usePartSummary`, `usePartReport(slug, part, at)`, `useAttempts`, `useCompare`, `useField`
 * (thickness / deviation `.f32`).
 *
 * Top to bottom: the menubar (`lib/nav` verbs for `mode`, `at`, `compare`; View, Camera, History, Point; the
 * mode and the attempt on show at its right end), the 3D viewer (the report's `render.mesh`, with the view cube
 * top right; clicking the model adds a `point` SessionRef, Point → whole part adds a `part` one) or the
 * model's code when `mode=code` (read-only), or the compare view when `compare` is set (A = `compare`,
 * B = `at` or current; `mode=deviation` shows B painted with its deviation, any other mode the two side by
 * side), the attempts tree, the gate summary bar and, while the server evaluates, what it is doing.
 *
 * `at`: show the part as of that revision (read-only), named in the menubar with a way back. Works at phone width.
 */
export interface PartViewProps {
  slug: string;
  /** Part id, `[a-z0-9][a-z0-9-]*`. May name a part that does not exist (stale link): say so. */
  part: string;
  mode: PartMode;
  /** A revision id, or undefined for the current model. */
  at: string | undefined;
  /** A revision id to compare against, or undefined. */
  compare: string | undefined;
}

const MODES: { value: PartMode; label: string }[] = [
  { value: "shaded", label: "Shaded" },
  { value: "section", label: "Section" },
  { value: "thickness", label: "Thickness" },
  { value: "deviation", label: "Deviation" },
  { value: "code", label: "Code" },
];
const isMode = (v: string): v is PartMode => (PART_MODES as readonly string[]).includes(v);

export function PartView({ slug, part, mode, at, compare }: PartViewProps) {
  const nav = useProjectNav(slug);
  const parts = useParts(slug);
  const summary = usePartSummary(slug, part);
  const report = usePartReport(slug, part, at);
  const attempts = useAttempts(slug, part);
  const restore = useRestoreAttempt(slug);
  const picks = usePointed(slug);
  const modelPath = summary?.model ?? `parts/${part}.scad`;
  const progress = useRenderProgress(slug, modelPath, at);
  // What the menus drive: the canvas hands its scene out; the view cube drives the same one.
  const [scene, setScene] = useState<ViewControl | null>(null);
  const [showGates, setShowGates] = useState(true);
  const [section, setSection] = useState<SectionState>({ axis: "z", fraction: 0.5 });
  const [restoring, setRestoring] = useState<TreeNode | null>(null);
  const [codeOf, setCodeOf] = useState<"a" | "b" | null>(null);

  const layout = useMemo(() => layoutAttempts(attempts.data ?? []), [attempts.data]);
  const current = layout.nodes.find((n) => n.attempt.current);
  const selected = at ? layout.nodes.find((n) => n.attempt.revisionId === at) : current;
  const labelOf = (id: string) => layout.nodes.find((n) => n.attempt.revisionId === id)?.label ?? id.slice(0, 7);
  const labelA = compare ? labelOf(compare) : "";
  const labelB = at ? labelOf(at) : "current";
  const comparing = compare !== undefined && mode !== "code";
  const gateCount = report.data ? locatedFailures(report.data.gates).length : 0;
  const partPicked = picks.some((r) => r.kind === "part" && r.part === part);
  const others = [...layout.nodes].sort((x, y) => y.attempt.date.localeCompare(x.attempt.date)).filter((n) => n.attempt.revisionId !== (selected?.attempt.revisionId ?? ""));

  const shading = useShadingEntry(comparing ? mode === "deviation" : mode !== "shaded" && mode !== "section");

  if (parts.isSuccess && !summary) {
    return (
      <PlainViewer label="Part viewer">
        <Centered icon={<SearchXIcon className="size-6 text-dim" />} title={`No part “${part}”`}>
          It may have been renamed or deleted. Pick a part from the outline.
        </Centered>
      </PlainViewer>
    );
  }

  const viewEntries: MenuEntry[] = comparing
    ? [
        {
          kind: "radio",
          value: mode === "deviation" ? "deviation" : "side",
          onChange: (v) => nav.setMode(v === "deviation" ? "deviation" : "shaded"),
          options: [
            { value: "side", label: "Side by side" },
            { value: "deviation", label: "Deviation" },
          ],
        },
        { kind: "separator" },
        { kind: "item", label: `Code of A · ${labelA}`, icon: CodeIcon, onSelect: () => setCodeOf("a") },
        { kind: "item", label: `Code of B · ${labelB}`, icon: CodeIcon, onSelect: () => setCodeOf("b") },
        { kind: "separator" },
        shading,
      ]
    : [
        { kind: "radio", value: mode, onChange: (v) => isMode(v) && nav.setMode(v), options: MODES.map((m) => ({ value: m.value, label: m.label })) },
        { kind: "separator" },
        ...(gateCount > 0 ? ([{ kind: "check", label: `Show failing gates (${gateCount})`, checked: showGates, onChange: setShowGates, disabled: mode === "code" }, { kind: "separator" }] satisfies MenuEntry[]) : []),
        shading,
      ];

  const menus: MenuSpec[] = [
    { id: "view", label: "View", entries: viewEntries },
    cameraMenu(mode === "code" && !comparing ? null : scene),
    {
      id: "history",
      label: "History",
      entries: [
        { kind: "item", label: "Back to current", icon: XIcon, disabled: !at, onSelect: () => nav.setAt(undefined) },
        {
          kind: "item",
          label: selected ? `Make ${selected.label} current` : "Make current",
          icon: Undo2Icon,
          disabled: !selected || selected.attempt.current || restore.isPending,
          onSelect: () => selected && setRestoring(selected),
        },
        { kind: "separator" },
        {
          kind: "sub",
          label: "Compare with…",
          disabled: others.length === 0,
          entries: [
            { kind: "label", text: `A = the attempt picked, B = ${at ? labelB : "current"}` },
            ...others.map((n): MenuEntry => ({ kind: "item", label: `${n.label} · ${n.attempt.message}`, onSelect: () => nav.setCompare(n.attempt.revisionId) })),
          ],
        },
        { kind: "item", label: "Close compare", icon: XIcon, disabled: !compare, onSelect: () => nav.setCompare(undefined) },
        { kind: "separator" },
        {
          kind: "radio",
          value: selected?.attempt.revisionId ?? "",
          onChange: (id) => {
            const n = layout.nodes.find((x) => x.attempt.revisionId === id);
            if (n) nav.setAt(n.attempt.current ? undefined : id);
          },
          options: layout.nodes.map((n) => ({ value: n.attempt.revisionId, label: `${n.label} · ${n.attempt.message}`, shortcut: n.attempt.passed !== null ? `${n.attempt.passed}/${n.attempt.total}` : undefined })),
        },
      ],
    },
    {
      id: "point",
      label: "Point",
      entries: [
        { kind: "label", text: "Click the model to point at a place" },
        { kind: "item", label: partPicked ? "Whole part attached" : "Point at the whole part", icon: BoxIcon, disabled: partPicked, onSelect: () => pointing.add(slug, { kind: "part", part }) },
      ],
    },
  ];

  const modeLabel = comparing ? (mode === "deviation" ? "Deviation" : "Side by side") : (MODES.find((m) => m.value === mode)?.label ?? mode);
  const status = (
    <>
      <span className="hidden truncate sm:inline">{modeLabel}</span>
      {comparing ? (
        <StatusPill onClear={() => nav.setCompare(undefined)} clearLabel="Close compare">
          A {labelA} · B {labelB}
        </StatusPill>
      ) : (
        at && (
          <StatusPill onClear={() => nav.setAt(undefined)} clearLabel="Back to current">
            Viewing {labelB}
          </StatusPill>
        )
      )}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerMenubar label="Part viewer" menus={menus} status={status} />

      {comparing && compare ? (
        <CompareView slug={slug} part={part} compare={compare} at={at} deviation={mode === "deviation"} labelA={labelA} labelB={labelB} onScene={setScene} />
      ) : (
        <div className="relative min-h-[16rem] flex-1">
          <Centre
            slug={slug}
            part={part}
            mode={mode}
            at={at}
            modelPath={modelPath}
            evaluating={summary?.evaluating === true && !at}
            progress={progress}
            showGates={showGates}
            section={section}
            onSection={setSection}
            onScene={setScene}
          />
        </div>
      )}

      <AttemptsStrip slug={slug} part={part} layout={layout} selected={selected} compare={compare} restoreError={restore.isError ? restore.error.message : null} />
      <GateBar slug={slug} summary={summary} report={report.data} at={at} progress={progress} />

      <RestoreDialog
        node={restoring}
        onClose={() => setRestoring(null)}
        onConfirm={(node) => {
          restore.mutate({ id: part, revisionId: node.attempt.revisionId }, { onSuccess: () => nav.setAt(undefined) });
          setRestoring(null);
        }}
      />
      <Dialog open={codeOf !== null} onOpenChange={(o) => !o && setCodeOf(null)}>
        <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-2 p-0 sm:max-w-3xl">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle className="text-sm">
              {modelPath} · {codeOf === "a" ? `A · ${labelA}` : `B · ${labelB}`}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 border-t border-line">{codeOf && <ModelCode slug={slug} path={modelPath} at={codeOf === "a" ? compare : at} />}</div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface CentreProps {
  slug: string;
  part: string;
  mode: PartMode;
  at: string | undefined;
  modelPath: string;
  evaluating: boolean;
  progress: ReturnType<typeof useRenderProgress>;
  showGates: boolean;
  section: SectionState;
  onSection: (section: SectionState) => void;
  onScene: (scene: ViewControl | null) => void;
}

function Centre({ slug, part, mode, at, modelPath, evaluating, progress, showGates, section, onSection, onScene }: CentreProps) {
  const summary = usePartSummary(slug, part);
  const report = usePartReport(slug, part, at);

  if (mode === "code") {
    if (!summary?.model && !at) return <Centered title="No model yet">The agent has not written this part&apos;s model.</Centered>;
    return <ModelCode slug={slug} path={modelPath} at={at} />;
  }
  if (report.isPending) return evaluating ? <RenderProgressPanel progress={progress} /> : <Skeleton className="absolute inset-0 rounded-none" aria-label="Loading the part" />;
  if (report.isError) {
    return (
      <Centered icon={<TriangleAlertIcon className="size-6 text-warn" />} title="The report could not be loaded">
        {report.error.message}
      </Centered>
    );
  }
  const r = report.data;
  if (r.status === "empty") {
    return (
      <Centered icon={<BoxIcon className="size-6 text-faint" />} title="No model yet">
        Describe the part to the agent; the model appears here once it writes one.
      </Centered>
    );
  }
  if (!r.render) {
    if (evaluating) return <RenderProgressPanel progress={progress} />;
    const first = r.gates.find(isFailing);
    return (
      <Centered icon={<TriangleAlertIcon className="size-6 text-down" />} title="The model does not build">
        {first ? `${first.label}: ${first.detail ?? first.measured ?? "failed"}` : "No mesh came out of the render."}
      </Centered>
    );
  }
  return <PartStage slug={slug} part={part} report={r} mode={mode} evaluating={evaluating} progress={progress} showGates={showGates} section={section} onSection={onSection} onScene={onScene} />;
}

function Centered({ icon, title, children }: { icon?: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2 p-6 text-center">
      {icon}
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-dim">{children}</p>
    </div>
  );
}
