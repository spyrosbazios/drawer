import type { PartReport } from "@drawer/shared/api";
import { useForm } from "@tanstack/react-form";
import { useSearch } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ResponsiveModal } from "@/components/responsive-modal";
import { StatusChip } from "@/components/status/status-chip";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatRelative, shortRev } from "@/core/format";
import { useRecordPrint, useWaiveGate } from "@/hooks/parts";
import { useCreateSession, useSendMessage, useSessions } from "@/hooks/sessions";
import { useProjectNav } from "@/lib/nav";
import { ForbiddenError } from "@/services/api";
import { isWaivable, sendBackMessage } from "./review-model";

const firstError = (errors: readonly unknown[]): string | undefined =>
  errors.map((x) => (typeof x === "string" ? x : typeof x === "object" && x !== null && "message" in x && typeof x.message === "string" ? x.message : undefined)).find(Boolean);

interface DialogProps {
  slug: string;
  part: string;
  report: PartReport;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---- waive -----------------------------------------------------------------------------------

const waiveSchema = z.object({ gate: z.string().min(1, "Pick a gate"), reason: z.string().trim().min(3, "Say why this is acceptable") });

export function WaiveDialog(props: DialogProps) {
  return (
    <ResponsiveModal open={props.open} onOpenChange={props.onOpenChange} title="Waive a gate" description="Your decision that a failing gate is acceptable for this part. Agents cannot waive.">
      {props.open && <WaiveForm {...props} />}
    </ResponsiveModal>
  );
}

function WaiveForm({ slug, part, report, onOpenChange }: DialogProps) {
  const waive = useWaiveGate(slug);
  const [error, setError] = useState<string | null>(null);
  const waivable = report.gates.filter(isWaivable);
  const labelOf = (id: string) => report.gates.find((g) => g.id === id)?.label ?? id;
  const form = useForm({
    defaultValues: { gate: waivable[0]?.id ?? "", reason: "" },
    validators: { onSubmit: waiveSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await waive.mutateAsync({ id: part, gate: value.gate, reason: value.reason.trim() });
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof ForbiddenError ? `The server refused: ${err.message}` : err instanceof Error ? err.message : "Could not waive");
      }
    },
  });
  const remove = (gate: string) =>
    waive.mutate({ id: part, gate, reason: "" }, { onError: (err) => setError(err instanceof Error ? err.message : "Could not remove the waiver") });

  return (
    <div className="space-y-5 pb-2">
      {report.spec.waivers.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Waived</h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {report.spec.waivers.map((w) => (
              <li key={w.gate} className="flex items-start gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p>{labelOf(w.gate)}</p>
                  <p className="text-xs text-dim">
                    {w.reason} <span className="text-faint">· {w.by}, {formatRelative(w.at)}</span>
                  </p>
                </div>
                <Button variant="ghost" size="sm" disabled={waive.isPending} onClick={() => remove(w.gate)}>
                  <XIcon /> Remove
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {waivable.length === 0 ? (
        <p className="text-sm text-dim">No gate can be waived now: none fails, or only Builds and One closed body fail, which cannot be waived.</p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="gate">
            {(f) => (
              <Field>
                <FieldLabel htmlFor="waive-gate">Gate</FieldLabel>
                <Select value={f.state.value} onValueChange={(v) => f.handleChange(v)}>
                  <SelectTrigger id="waive-gate" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {waivable.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.label}
                        {g.measured ? ` (${g.measured})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Builds and One closed body cannot be waived.</FieldDescription>
              </Field>
            )}
          </form.Field>
          <form.Field name="reason">
            {(f) => {
              const invalid = f.state.meta.isTouched && !f.state.meta.isValid;
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="waive-reason">Reason</FieldLabel>
                  <Textarea id="waive-reason" rows={3} value={f.state.value} aria-invalid={invalid} placeholder="The overhang is a chamfer that prints fine on this machine." onBlur={f.handleBlur} onChange={(e) => f.handleChange(e.target.value)} />
                  {invalid && <FieldError>{firstError(f.state.meta.errors)}</FieldError>}
                </Field>
              );
            }}
          </form.Field>
          {error && (
            <p role="alert" className="text-sm text-down">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={waive.isPending}>
              {waive.isPending ? "Waiving" : "Waive gate"}
            </Button>
          </div>
        </form>
      )}
      {waivable.length === 0 && error && (
        <p role="alert" className="text-sm text-down">
          {error}
        </p>
      )}
    </div>
  );
}

// ---- print result ------------------------------------------------------------------------------

const printSchema = z.object({ outcome: z.enum(["ok", "issue"]), note: z.string().trim().min(1, "Say how it went: fit, warping, what to change") });

export function PrintDialog(props: DialogProps) {
  return (
    <ResponsiveModal open={props.open} onOpenChange={props.onOpenChange} title="Record print result" description="A print result becomes a fact the agent reads, and can adjust tolerances.">
      {props.open && <PrintForm {...props} />}
    </ResponsiveModal>
  );
}

function PrintForm({ slug, part, report, onOpenChange }: DialogProps) {
  const record = useRecordPrint(slug);
  const form = useForm({
    defaultValues: { outcome: "ok" as "ok" | "issue", note: "" },
    validators: { onSubmit: printSchema },
    onSubmit: async ({ value }) => {
      try {
        await record.mutateAsync({ id: part, outcome: value.outcome, note: value.note.trim(), revisionId: report.revisionId });
        onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not record the print");
      }
    },
  });
  const prints = [...report.spec.prints].reverse();
  return (
    <div className="space-y-5 pb-2">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <p className="text-xs text-dim">For revision {shortRev(report.revisionId)}, the one this report measured.</p>
        <form.Field name="outcome">
          {(f) => (
            <Field>
              <FieldLabel>Outcome</FieldLabel>
              <ToggleGroup type="single" variant="outline" value={f.state.value} onValueChange={(v) => (v === "ok" || v === "issue") && f.handleChange(v)} className="justify-start">
                <ToggleGroupItem value="ok" className="px-4">
                  Printed fine
                </ToggleGroupItem>
                <ToggleGroupItem value="issue" className="px-4">
                  Had an issue
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          )}
        </form.Field>
        <form.Field name="note">
          {(f) => {
            const invalid = f.state.meta.isTouched && !f.state.meta.isValid;
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor="print-note">Note</FieldLabel>
                <Textarea id="print-note" rows={3} value={f.state.value} aria-invalid={invalid} placeholder="Cable bore a bit tight; slot fits the tray edge." onBlur={f.handleBlur} onChange={(e) => f.handleChange(e.target.value)} />
                {invalid && <FieldError>{firstError(f.state.meta.errors)}</FieldError>}
              </Field>
            );
          }}
        </form.Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={record.isPending}>
            {record.isPending ? "Saving" : "Record"}
          </Button>
        </div>
      </form>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Earlier prints</h3>
        {prints.length === 0 ? (
          <p className="text-sm text-dim">None recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {prints.map((p) => (
              <li key={`${p.at}-${p.revisionId}`} className="space-y-0.5 px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <StatusChip kind="gate" status={p.outcome === "ok" ? "pass" : "fail"} label={p.outcome === "ok" ? "ok" : "issue"} />
                  <span className="text-xs text-faint">
                    {formatRelative(p.at)} · rev {shortRev(p.revisionId)}
                  </span>
                </div>
                <p className="text-dim">{p.note}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---- send back to agent --------------------------------------------------------------------------

const sendSchema = z.object({ text: z.string().trim().min(1, "Say what the agent should do") });

export function SendBackDialog(props: DialogProps) {
  return (
    <ResponsiveModal open={props.open} onOpenChange={props.onOpenChange} title="Send back to agent" description="A message to the project's session, with this part attached.">
      {props.open && <SendBackForm {...props} />}
    </ResponsiveModal>
  );
}

function SendBackForm({ slug, part, report, onOpenChange }: DialogProps) {
  const search = useSearch({ strict: false });
  const sessions = useSessions(slug);
  const nav = useProjectNav(slug);
  const newest = [...(sessions.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const target = typeof search.session === "string" ? search.session : newest?.id;
  const send = useSendMessage(target ?? "");
  const create = useCreateSession();
  const form = useForm({
    defaultValues: { text: sendBackMessage(part, report) },
    validators: { onSubmit: sendSchema },
    onSubmit: async ({ value }) => {
      const refs = [{ kind: "part" as const, part }];
      try {
        if (target) {
          await send.mutateAsync({ text: value.text.trim(), refs });
          nav.openSession(target);
        } else {
          const s = await create.mutateAsync({ slug, message: value.text.trim(), refs });
          nav.openSession(s.id);
        }
        onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not send");
      }
    },
  });
  return (
    <form
      className="space-y-4 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="text">
        {(f) => {
          const invalid = f.state.meta.isTouched && !f.state.meta.isValid;
          return (
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="send-text">Message</FieldLabel>
              <Textarea id="send-text" rows={7} className="font-mono text-xs" value={f.state.value} aria-invalid={invalid} onBlur={f.handleBlur} onChange={(e) => f.handleChange(e.target.value)} />
              <FieldDescription>{target ? "Goes to the current session; it queues if the agent is working." : "This project has no session yet: sending starts one."}</FieldDescription>
              {invalid && <FieldError>{firstError(f.state.meta.errors)}</FieldError>}
            </Field>
          );
        }}
      </form.Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={send.isPending || create.isPending}>
          {target ? "Send" : "Start session"}
        </Button>
      </div>
    </form>
  );
}
