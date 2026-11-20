import { MATERIALS_FILE } from "@drawer/shared/api";
import type { MaterialsFile } from "@drawer/shared/api";
import { useForm } from "@tanstack/react-form";
import { FlaskConicalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "./settings-section";
import { FileState, SaveRow, firstError, useLibraryFile } from "./library-form";
import { emptyMaterial, formToMaterial, materialToForm, materialsSchema, parseMaterials } from "./library-model";

/** Settings: the library's materials (`_library/materials.json`): density for mass, an optional minimum wall. */
export function MaterialsSection() {
  const { file } = useLibraryFile(MATERIALS_FILE);
  const materials = file.data ? parseMaterials(file.data.text) : null;
  return (
    <SettingsSection id="materials" icon={<FlaskConicalIcon className="size-4 text-faint" />} title="Materials" aside={MATERIALS_FILE}>
      <FileState loading={file.isPending} error={file.error} broken={file.data !== undefined && materials === null} path={MATERIALS_FILE} />
      {materials && file.data && <MaterialsEditor key={file.data.rev} file={materials} />}
    </SettingsSection>
  );
}

function MaterialsEditor({ file }: { file: MaterialsFile }) {
  const { save } = useLibraryFile(MATERIALS_FILE);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const form = useForm({
    defaultValues: { materials: file.materials.map(materialToForm) },
    validators: { onSubmit: materialsSchema },
    onSubmit: async ({ value }) => {
      setSaved(false);
      const msg = await save({ materials: value.materials.map(formToMaterial) }, "Update materials");
      setError(msg);
      setSaved(msg === null);
    },
  });

  const cell = (name: `materials[${number}].${"name" | "densityGCm3" | "minWallMm" | "notes"}`, label: string, opts: { numeric?: boolean; placeholder?: string } = {}) => (
    <form.Field name={name}>
      {(f) => {
        const invalid = f.state.meta.isTouched && !f.state.meta.isValid;
        return (
          <Field data-invalid={invalid} className="gap-1">
            <FieldLabel htmlFor={`mat-${name}`} className="text-xs md:sr-only">
              {label}
            </FieldLabel>
            <Input id={`mat-${name}`} value={f.state.value} aria-invalid={invalid} placeholder={opts.placeholder} inputMode={opts.numeric ? "decimal" : undefined} autoComplete="off" className={opts.numeric ? "font-mono tabular-nums" : undefined} onBlur={f.handleBlur} onChange={(e) => f.handleChange(e.target.value)} />
            {invalid && <FieldError>{firstError(f.state.meta.errors)}</FieldError>}
          </Field>
        );
      }}
    </form.Field>
  );

  const grid = "grid gap-2 md:grid-cols-[minmax(0,1fr)_7rem_7rem_minmax(0,2fr)_2.25rem]";
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="materials" mode="array">
        {(list) => (
          <div className="space-y-2">
            <div className={`${grid} hidden text-xs text-faint md:grid`}>
              <span>Name</span>
              <span>Density (g/cm³)</span>
              <span>Min wall (mm)</span>
              <span>Notes</span>
              <span />
            </div>
            {list.state.value.map((_m, i) => (
              <div key={i} className={`${grid} items-start rounded-lg border border-line p-2 md:border-0 md:p-0`}>
                {cell(`materials[${i}].name`, "Name")}
                {cell(`materials[${i}].densityGCm3`, "Density (g/cm³)", { numeric: true })}
                {cell(`materials[${i}].minWallMm`, "Min wall (mm)", { numeric: true, placeholder: "printer's" })}
                {cell(`materials[${i}].notes`, "Notes")}
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove material ${i + 1}`} onClick={() => list.removeValue(i)}>
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            {list.state.value.length === 0 && <p className="text-sm text-dim">No materials.</p>}
            <Button type="button" variant="outline" size="sm" onClick={() => list.pushValue(emptyMaterial())}>
              <PlusIcon /> Add material
            </Button>
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(st) => [st.isSubmitting, st.isDirty] as const}>
        {([submitting, dirty]) => <SaveRow submitting={submitting} dirty={dirty} error={error} saved={saved} onDiscard={() => form.reset()} />}
      </form.Subscribe>
    </form>
  );
}
