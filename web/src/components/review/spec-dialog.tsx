import type { DimensionKind, PartSpec } from "@drawer/shared/api";
import { useForm } from "@tanstack/react-form";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { ResponsiveModal } from "@/components/responsive-modal";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useLibraryProfile } from "@/hooks/library";
import { usePutPart } from "@/hooks/parts";
import { InvalidError } from "@/services/api";
import { AXES, DIMENSION_KINDS, KIND_HELP, STRICTNESS, dimensionFields, formToBody, newDimension, specFormSchema, specToForm } from "./spec-form";

interface Props {
  slug: string;
  part: string;
  spec: PartSpec;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A person edits what "done" means: the spec. The agent then models against it. */
export function SpecDialog({ slug, part, spec, open, onOpenChange }: Props) {
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} title="Edit spec" description={`parts/${part}.part.json: the gates measure the model against this.`} className="sm:max-w-2xl">
      {open && <SpecEditor slug={slug} part={part} spec={spec} onClose={() => onOpenChange(false)} />}
    </ResponsiveModal>
  );
}

const firstError = (errors: readonly unknown[]): string | undefined =>
  errors.map((x) => (typeof x === "string" ? x : typeof x === "object" && x !== null && "message" in x && typeof x.message === "string" ? x.message : undefined)).find(Boolean);

type DimText = "id" | "label" | "at" | "nominal" | "tol" | "min" | "max";
type TextPath = "title" | "class" | "description" | `dimensions[${number}].${DimText}` | `dimensions[${number}].near[${0 | 1}]` | `dimensions[${number}].${"from" | "box"}[${0 | 1 | 2}]`;

const STRICT_HELP: Record<(typeof STRICTNESS)[number], string> = {
  quick: "builds, one body, fits the bed, spec dimensions",
  standard: "adds lint, flat base, overhangs, minimum wall",
  functional: "every warning fails",
};

function SpecEditor({ slug, part, spec, onClose }: { slug: string; part: string; spec: PartSpec; onClose: () => void }) {
  const put = usePutPart(slug);
  const profile = useLibraryProfile();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: specToForm(spec),
    validators: { onSubmit: specFormSchema },
    onSubmit: async ({ value }) => {
      setServerError(null);
      try {
        await put.mutateAsync({ id: part, body: formToBody(value) });
        onClose();
      } catch (err) {
        setServerError(err instanceof InvalidError ? `The server refused the spec: ${err.message}` : err instanceof Error ? err.message : "Could not save");
      }
    },
  });

  const materials = profile.data?.materials ?? [];

  const text = (name: TextPath, label: string, opts: { mono?: boolean; numeric?: boolean; className?: string; hideLabel?: boolean } = {}) => (
    <form.Field name={name}>
      {(f) => {
        const invalid = f.state.meta.isTouched && !f.state.meta.isValid;
        const id = `spec-${name}`;
        return (
          <Field data-invalid={invalid} className={opts.className}>
            <FieldLabel htmlFor={id} className={opts.hideLabel ? "sr-only" : "text-xs"}>
              {label}
            </FieldLabel>
            <Input
              id={id}
              value={String(f.state.value)}
              aria-invalid={invalid}
              inputMode={opts.numeric ? "decimal" : undefined}
              autoComplete="off"
              spellCheck={false}
              className={opts.mono || opts.numeric ? "font-mono tabular-nums" : undefined}
              onBlur={f.handleBlur}
              onChange={(e) => f.handleChange(e.target.value)}
            />
            {invalid && <FieldError>{firstError(f.state.meta.errors)}</FieldError>}
          </Field>
        );
      }}
    </form.Field>
  );

  const vector = (base: `dimensions[${number}]`, key: "from" | "box", label: string) => (
    <div className="space-y-1">
      <p className="text-xs font-medium">{label}</p>
      <div className="grid grid-cols-3 gap-2">
        {([0, 1, 2] as const).map((i) => (
          <div key={i}>{text(`${base}.${key}[${i}]`, `${label} ${AXES[i]}`, { numeric: true })}</div>
        ))}
      </div>
    </div>
  );

  return (
    <form
      className="space-y-5 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      {text("title", "Title")}
      <div className="grid gap-4 sm:grid-cols-2">
        {text("class", "Class (snap-fit clip, enclosure lid)")}
        <form.Field name="source">
          {(f) => (
            <Field>
              <FieldLabel htmlFor="spec-source" className="text-xs">
                Source
              </FieldLabel>
              <Select value={f.state.value} onValueChange={(v) => f.handleChange(v === "bought" ? "bought" : "printed")}>
                <SelectTrigger id="spec-source" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="printed">Printed</SelectItem>
                  <SelectItem value="bought">Bought (no printability gates)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
        <form.Field name="material">
          {(f) => (
            <Field>
              <FieldLabel htmlFor="spec-material" className="text-xs">
                Material
              </FieldLabel>
              <Select value={f.state.value} onValueChange={(v) => f.handleChange(v)}>
                <SelectTrigger id="spec-material" className="w-full">
                  <SelectValue placeholder="From the library" />
                </SelectTrigger>
                <SelectContent>
                  {materials.map((m) => (
                    <SelectItem key={m.name} value={m.name}>
                      {m.name}
                    </SelectItem>
                  ))}
                  {f.state.value !== "" && !materials.some((m) => m.name === f.state.value) && <SelectItem value={f.state.value}>{f.state.value} (not in the library)</SelectItem>}
                </SelectContent>
              </Select>
              <FieldDescription>Materials come from the library.</FieldDescription>
            </Field>
          )}
        </form.Field>
        <form.Field name="strictness">
          {(f) => (
            <Field>
              <FieldLabel htmlFor="spec-strictness" className="text-xs">
                Strictness
              </FieldLabel>
              <Select value={f.state.value} onValueChange={(v) => f.handleChange(STRICTNESS.find((x) => x === v) ?? "standard")}>
                <SelectTrigger id="spec-strictness" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STRICTNESS.map((x) => (
                    <SelectItem key={x} value={x}>
                      {x}: {STRICT_HELP[x]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
      </div>
      <form.Field name="description">
        {(f) => (
          <Field>
            <FieldLabel htmlFor="spec-description" className="text-xs">
              Description
            </FieldLabel>
            <Textarea id="spec-description" rows={2} value={f.state.value} onBlur={f.handleBlur} onChange={(e) => f.handleChange(e.target.value)} />
          </Field>
        )}
      </form.Field>

      <form.Field name="dimensions" mode="array">
        {(list) => (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">Dimensions</h3>
              <span className="text-xs text-faint">measured on the mesh, in mm</span>
              <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => list.pushValue(newDimension(list.state.value))}>
                <PlusIcon /> Add
              </Button>
            </div>
            {list.state.value.length === 0 && <p className="text-sm text-dim">No dimensions: only the general gates apply.</p>}
            {list.state.value.map((d, i) => {
              const base = `dimensions[${i}]` as const;
              const f = dimensionFields(d.kind);
              return (
                <fieldset key={i} className="space-y-3 rounded-lg border border-line p-3">
                  <legend className="sr-only">Dimension {i + 1}</legend>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                    {text(`${base}.label`, "Label", { className: "col-span-2 sm:col-span-1" })}
                    {text(`${base}.id`, "Id (gate dim:id)", { mono: true })}
                    <form.Field name={`${base}.kind`}>
                      {(k) => (
                        <Field>
                          <FieldLabel htmlFor={`spec-${base}-kind`} className="text-xs">
                            Kind
                          </FieldLabel>
                          <Select value={k.state.value} onValueChange={(v) => k.handleChange(DIMENSION_KINDS.find((x) => x === v) ?? "size")}>
                            <SelectTrigger id={`spec-${base}-kind`} className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {DIMENSION_KINDS.map((x: DimensionKind) => (
                                <SelectItem key={x} value={x}>
                                  {x}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      )}
                    </form.Field>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${d.label || d.id}`} onClick={() => list.removeValue(i)}>
                      <Trash2Icon />
                    </Button>
                  </div>
                  <p className="text-xs text-faint">{KIND_HELP[d.kind]}</p>
                  {(f.axis || f.cut) && (
                    <div className="grid grid-cols-3 gap-2">
                      {f.axis && (
                        <form.Field name={`${base}.axis`}>
                          {(a) => (
                            <Field>
                              <FieldLabel htmlFor={`spec-${base}-axis`} className="text-xs">
                                Axis
                              </FieldLabel>
                              <Select value={a.state.value} onValueChange={(v) => a.handleChange(AXES.find((x) => x === v) ?? "z")}>
                                <SelectTrigger id={`spec-${base}-axis`} className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {AXES.map((x) => (
                                    <SelectItem key={x} value={x}>
                                      {x}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </Field>
                          )}
                        </form.Field>
                      )}
                      {f.cut && text(`${base}.at`, "Cut at", { numeric: true })}
                    </div>
                  )}
                  {f.cut && (
                    <div className="space-y-1">
                      <p className="text-xs text-dim">Nearest to (the two other coordinates, x-y-z order)</p>
                      <div className="grid grid-cols-2 gap-2">
                        {text(`${base}.near[0]`, "Near, first", { numeric: true })}
                        {text(`${base}.near[1]`, "Near, second", { numeric: true })}
                      </div>
                    </div>
                  )}
                  {f.point && vector(base, "from", "Through point")}
                  {f.box && vector(base, "box", "Box")}
                  {f.minOnly && <div className="grid grid-cols-3 gap-2">{text(`${base}.min`, "At least", { numeric: true })}</div>}
                  {f.range && (
                    <div className="grid grid-cols-3 items-end gap-2">
                      <form.Field name={`${base}.range`}>
                        {(r) => (
                          <Field>
                            <FieldLabel htmlFor={`spec-${base}-range`} className="text-xs">
                              Range
                            </FieldLabel>
                            <Select value={r.state.value} onValueChange={(v) => r.handleChange(v === "limits" ? "limits" : "tol")}>
                              <SelectTrigger id={`spec-${base}-range`} className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="tol">nominal ± tol</SelectItem>
                                <SelectItem value="limits">min / max</SelectItem>
                              </SelectContent>
                            </Select>
                          </Field>
                        )}
                      </form.Field>
                      {d.range === "tol" ? (
                        <>
                          {text(`${base}.nominal`, "Nominal", { numeric: true })}
                          {text(`${base}.tol`, "± tol", { numeric: true })}
                        </>
                      ) : (
                        <>
                          {text(`${base}.min`, "Min", { numeric: true })}
                          {text(`${base}.max`, "Max", { numeric: true })}
                        </>
                      )}
                    </div>
                  )}
                </fieldset>
              );
            })}
          </section>
        )}
      </form.Field>

      {serverError && (
        <p role="alert" className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          {serverError}
        </p>
      )}
      <form.Subscribe selector={(s) => [s.isSubmitting, s.submissionAttempts > 0 && !s.isValid] as const}>
        {([submitting, invalid]) => (
          <div className="flex items-center justify-end gap-2">
            {invalid && <span className="mr-auto text-xs text-down">Fix the marked fields.</span>}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving" : "Save spec"}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
