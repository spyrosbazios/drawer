import { PRINTER_FILE } from "@drawer/shared/api";
import type { PrinterProfile } from "@drawer/shared/api";
import { useForm } from "@tanstack/react-form";
import { PrinterIcon } from "lucide-react";
import { useState } from "react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "./settings-section";
import { FileState, SaveRow, firstError, useLibraryFile } from "./library-form";
import { PRINTER_FIELDS, formToPrinter, parsePrinter, printerSchema, printerToForm } from "./library-model";

/** Settings: the library's printer profile (`_library/printer.json`), which every gate reads. */
export function PrinterSection() {
  const { file } = useLibraryFile(PRINTER_FILE);
  const printer = file.data ? parsePrinter(file.data.text) : null;
  return (
    <SettingsSection id="printer" icon={<PrinterIcon className="size-4 text-faint" />} title="Printer" aside={PRINTER_FILE}>
      <FileState loading={file.isPending} error={file.error} broken={file.data !== undefined && printer === null} path={PRINTER_FILE} />
      {printer && file.data && <PrinterEditor key={file.data.rev} printer={printer} />}
    </SettingsSection>
  );
}

type FieldName = "name" | "nozzleMm" | "layerMm" | "minWallMm" | "maxOverhangDeg" | "maxOverhangAreaMm2" | "sliding" | "press" | `bed[${0 | 1 | 2}]`;

function PrinterEditor({ printer }: { printer: PrinterProfile }) {
  const { save } = useLibraryFile(PRINTER_FILE);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const form = useForm({
    defaultValues: printerToForm(printer),
    validators: { onSubmit: printerSchema },
    onSubmit: async ({ value }) => {
      setSaved(false);
      const msg = await save(formToPrinter(value), "Update printer profile");
      setError(msg);
      setSaved(msg === null);
    },
  });

  const text = (name: FieldName, label: string, opts: { unit?: string; numeric?: boolean; srLabel?: boolean } = {}) => (
    <form.Field name={name}>
      {(f) => {
        const invalid = f.state.meta.isTouched && !f.state.meta.isValid;
        const id = `printer-${name}`;
        return (
          <Field data-invalid={invalid} className="gap-1.5">
            <FieldLabel htmlFor={id} className={opts.srLabel ? "sr-only" : "text-xs"}>
              {label}
              {opts.unit && <span className="font-normal text-faint"> ({opts.unit})</span>}
            </FieldLabel>
            <Input id={id} value={f.state.value} aria-invalid={invalid} inputMode={opts.numeric ? "decimal" : undefined} autoComplete="off" className={opts.numeric ? "font-mono tabular-nums" : undefined} onBlur={f.handleBlur} onChange={(e) => f.handleChange(e.target.value)} />
            {invalid && <FieldError>{firstError(f.state.meta.errors)}</FieldError>}
          </Field>
        );
      }}
    </form.Field>
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {text("name", "Name")}
        <div className="space-y-1.5">
          <p className="text-xs font-medium">
            Build volume <span className="font-normal text-faint">(mm, x × y × z)</span>
          </p>
          <div className="grid grid-cols-3 gap-2">
            {text("bed[0]", "Build volume x", { numeric: true, srLabel: true })}
            {text("bed[1]", "Build volume y", { numeric: true, srLabel: true })}
            {text("bed[2]", "Build volume z", { numeric: true, srLabel: true })}
          </div>
        </div>
        {PRINTER_FIELDS.map((p) => (
          <div key={p.key}>{text(p.key, p.label, { unit: p.unit, numeric: true })}</div>
        ))}
      </div>
      <form.Subscribe selector={(st) => [st.isSubmitting, st.isDirty] as const}>
        {([submitting, dirty]) => <SaveRow submitting={submitting} dirty={dirty} error={error} saved={saved} onDiscard={() => form.reset()} />}
      </form.Subscribe>
    </form>
  );
}
