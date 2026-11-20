import type { ParamValue, ParamValues, PartReport, ScadParam } from "@drawer/shared/api";
import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { GateList } from "@/components/status/gate-list";
import { StatusChip } from "@/components/status/status-chip";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useFileInfo } from "@/hooks/files";
import { useSetParams, useWhatIf } from "@/hooks/parts";
import { useDebounced } from "@/hooks/use-debounced";
import { cn } from "@/lib/utils";
import { ConflictError } from "@/services/api";
import { changedGates, clampParam, diffParams, formatParamValue, groupParams, parseNumberInput, setVectorComponent } from "./review-model";

const NO_EDITS: ParamValues = {};

/**
 * The state of a person's parameter edits on one report: moving a value runs a what-if (nothing written);
 * `apply` writes the values into the model as one revision, which the server then evaluates for real. The
 * review panel owns it, because its footer holds Apply and Reset.
 */
export function useParamEdits(slug: string, part: string, report: PartReport, model: string) {
  // Edits belong to the revision they were made on: a new revision reads as clean without any reset step.
  const [edits, setEdits] = useState<{ revision: string; values: ParamValues }>({ revision: report.revisionId, values: {} });
  const overrides = edits.revision === report.revisionId ? edits.values : NO_EDITS;
  const setOverrides = (fn: (o: ParamValues) => ParamValues) => setEdits({ revision: report.revisionId, values: fn(overrides) });
  const changed = diffParams(report.params, overrides);
  const debounced = useDebounced(changed, 600);
  const pending = Object.keys(debounced).length > 0;
  const whatIf = useWhatIf(slug, part, pending ? debounced : undefined);
  const info = useFileInfo(slug, model);
  const setParams = useSetParams(slug);
  const count = Object.keys(changed).length;
  const settling = count > 0 && JSON.stringify(changed) !== JSON.stringify(debounced);
  const result = pending && whatIf.data && whatIf.data.whatIf ? whatIf.data : undefined;

  const reset = () => setOverrides(() => ({}));
  const apply = async () => {
    const rev = info.data?.rev;
    if (!rev) {
      toast.error("The model's revision is not loaded yet; try again in a moment.");
      return;
    }
    try {
      await setParams.mutateAsync({ id: part, rev, values: changed, message: `Set ${Object.keys(changed).join(", ")} for ${part}` });
      reset();
    } catch (err) {
      if (err instanceof ConflictError) {
        void info.refetch();
        toast.error("The model changed since it was read (the agent may have written it). Your values are kept: check them and apply again.");
      } else {
        toast.error(err instanceof Error ? err.message : "Could not apply");
      }
    }
  };

  return {
    overrides,
    changed,
    /** How many parameters differ from the model's. */
    count,
    running: settling || (pending && whatIf.isFetching),
    error: whatIf.isError ? whatIf.error.message : undefined,
    result,
    diffs: result ? changedGates(report.gates, result.gates) : [],
    applying: setParams.isPending,
    set: (name: string, v: ParamValue) => setOverrides((o) => ({ ...o, [name]: v })),
    reset,
    apply,
  };
}

export type ParamEdits = ReturnType<typeof useParamEdits>;

/** The model's Customizer parameters as controls, and what the what-if says about the gates. */
export function ParamsSection({ report, edits }: { report: PartReport; edits: ParamEdits }) {
  if (report.params.length === 0) return <p className="px-3 text-sm text-dim">No parameters.</p>;
  const { result, diffs } = edits;
  return (
    <div className="space-y-3">
      {groupParams(report.params).map(({ group, params }) => (
        <div key={group || "_"} className="space-y-3 px-3">
          {group && <h4 className="text-[11px] font-medium tracking-wide text-faint uppercase">{group}</h4>}
          {params.map((p) => (
            <ParamControl key={p.name} param={p} value={edits.overrides[p.name] ?? p.value} changed={p.name in edits.changed} onChange={(v) => edits.set(p.name, v)} />
          ))}
        </div>
      ))}

      {edits.count > 0 && (
        <div className="mx-3 space-y-2 rounded-lg border border-run/40 bg-run/8 p-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">What if</span>
            {edits.running && <LoaderCircleIcon className="size-3.5 animate-spin text-run" aria-label="Evaluating" />}
            {result && <StatusChip kind="report" status={result.status} label={`${result.status} ${result.passed}/${result.total}`} />}
            <span className="ml-auto text-xs text-faint">not written</span>
          </div>
          {edits.error && <p className="text-xs text-down">{edits.error}</p>}
          {result && diffs.length === 0 && <p className="text-xs text-dim">No gate changes.</p>}
          {result && diffs.length > 0 && <GateList className="-mx-3" gates={diffs.map((d) => d.gate)} failingFirst />}
        </div>
      )}
    </div>
  );
}

function ParamControl({ param: p, value, changed, onChange }: { param: ScadParam; value: ParamValue; changed: boolean; onChange: (v: ParamValue) => void }) {
  const id = `param-${p.name}`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <label htmlFor={id} className={changed ? "font-mono text-sm text-run" : "font-mono text-sm"}>
          {p.name}
        </label>
        {changed && <span className="text-[11px] text-faint">was {formatParamValue(p.value)}</span>}
      </div>
      {p.description && <p className="text-xs text-dim">{p.description}</p>}
      <ParamInput id={id} param={p} value={value} onChange={onChange} />
    </div>
  );
}

function ParamInput({ id, param: p, value, onChange }: { id: string; param: ScadParam; value: ParamValue; onChange: (v: ParamValue) => void }) {
  if (p.options) {
    const current = String(value);
    return (
      <Select value={current} onValueChange={(v) => onChange(p.options?.find((o) => String(o.value) === v)?.value ?? v)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {p.options.map((o) => (
            <SelectItem key={String(o.value)} value={String(o.value)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (p.type === "boolean") return <Switch id={id} checked={value === true} onCheckedChange={(c) => onChange(c)} />;
  if (p.type === "string") return <Input id={id} value={typeof value === "string" ? value : String(value)} onChange={(e) => onChange(e.target.value)} />;
  if (p.type === "vector") {
    const vec = Array.isArray(value) ? value : [];
    return (
      <div className="flex gap-2">
        {vec.map((n, i) => (
          <NumberField key={`${i}-${n}`} id={i === 0 ? id : `${id}-${i}`} label={`${p.name}[${i}]`} value={n} onCommit={(x) => onChange(setVectorComponent(value, i, x))} />
        ))}
      </div>
    );
  }
  const n = typeof value === "number" ? value : 0;
  const ranged = p.min !== null && p.max !== null;
  return (
    <div className="flex items-center gap-3">
      {ranged && <Slider aria-label={p.name} className="flex-1" min={p.min ?? 0} max={p.max ?? 100} step={p.step ?? 0.1} value={[n]} onValueChange={(v) => v[0] !== undefined && onChange(clampParam(p, v[0]))} />}
      <NumberField key={String(n)} id={id} label={p.name} value={n} className={ranged ? "w-20" : "w-28"} onCommit={(x) => onChange(clampParam(p, x))} />
    </div>
  );
}

/** Keeps the typed text until Enter or blur, so a half-typed number is never rewritten. Remounted (keyed) when the value changes elsewhere. */
function NumberField({ id, label, value, className, onCommit }: { id: string; label: string; value: number; className?: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = parseNumberInput(text);
    if (n === null) setText(String(value));
    else if (n !== value) onCommit(n);
  };
  return (
    <Input
      id={id}
      aria-label={label}
      inputMode="decimal"
      className={cn("font-mono tabular-nums", className ?? "min-w-0 flex-1")}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
