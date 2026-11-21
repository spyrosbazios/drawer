import type { Strictness } from "@drawer/shared/api";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ResponsiveModal } from "@/components/responsive-modal";
import { AgentPicker } from "@/components/session/agent-picker";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { newProjectUploadPath } from "@/core/upload";
import { isValidSlug, slugError, slugify } from "@/core/slug";
import { useUploadFiles } from "@/hooks/files";
import { useLibraryProfile } from "@/hooks/library";
import { useCreateProject } from "@/hooks/projects";
import { usePreviewImport } from "@/hooks/imports";
import { useCreateSession } from "@/hooks/sessions";
import { useAgentOptions } from "@/hooks/agents";
import { ExistsError } from "@/services/api";
import { FileDrop } from "./file-drop";
import { UrlImport } from "./url-import";

const STRICTNESS: { value: Strictness; label: string; hint: string }[] = [
  { value: "quick", label: "Quick", hint: "builds, solid, fits the bed, spec dimensions" },
  { value: "standard", label: "Standard", hint: "adds model hygiene, flat base, overhangs and minimum wall" },
  { value: "functional", label: "Functional fit", hint: "every warning fails" },
];
const isStrictness = (v: string): v is Strictness => STRICTNESS.some((s) => s.value === v);

const schema = z.object({
  brief: z.string().trim().min(1, "Say what you need"),
  name: z.string().trim().min(1, "Give the project a name"),
  slug: z.string().refine(isValidSlug, { message: "Use lower-case letters, digits and dashes" }),
  material: z.string(),
  strictness: z.enum(["quick", "standard", "functional"]),
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A project starts from intent and references, not from an empty file: the brief becomes the first message to the agent. */
export function NewProjectDialog({ open, onOpenChange }: Props) {
  // The form is remounted on each open, so it never shows the previous attempt.
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} title="New project" description="Say what you need. The agent asks once, then models." className="sm:max-w-2xl">
      {open && <NewProjectForm onClose={() => onOpenChange(false)} />}
    </ResponsiveModal>
  );
}

const firstError = (errors: readonly unknown[]): string | undefined =>
  errors.map((x) => (typeof x === "string" ? x : typeof x === "object" && x !== null && "message" in x && typeof x.message === "string" ? x.message : undefined)).find(Boolean);

function NewProjectForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateProject();
  const startSession = useCreateSession();
  const preview = usePreviewImport();
  const profile = useLibraryProfile();
  const agent = useAgentOptions();

  const [slugTouched, setSlugTouched] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [slugTaken, setSlugTaken] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const upload = useUploadFiles();

  const form = useForm({
    defaultValues: { brief: "", name: "", slug: "", material: "", strictness: "standard" as Strictness },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      setSlugTaken(false);
      if (url.trim() !== "" && !preview.data) {
        toast.error("Preview the link first, then choose the files to import.");
        return;
      }
      try {
        setProgress("Creating the project");
        const material = value.material || profile.data?.materials[0]?.name;
        const project = await create.mutateAsync({
          slug: value.slug,
          title: value.name.trim(),
          brief: value.brief.trim(),
          defaults: { strictness: value.strictness, ...(material ? { material } : {}) },
          ...(preview.data ? { fromUrl: url.trim(), fileIds: [...selected] } : {}),
        });
        if (files.length > 0) {
          await upload(
            project.slug,
            files.map((file) => ({ path: newProjectUploadPath(file.name), file })),
            new Set(),
            (done, total) => setProgress(`Uploading ${Math.min(done + 1, total)} of ${total}`),
          );
        }
        setProgress("Starting the session");
        const session = await startSession.mutateAsync({ slug: project.slug, message: value.brief.trim(), ...agent.request });
        agent.pick(null);
        onClose();
        void navigate({ to: "/p/$slug", params: { slug: project.slug }, search: { session: session.id } });
      } catch (err) {
        setProgress(null);
        if (err instanceof ExistsError) setSlugTaken(true);
        else toast.error(err instanceof Error ? err.message : "Could not start the project");
      }
    },
  });

  const runPreview = () => {
    preview.mutate(url.trim(), {
      onSuccess: (p) => {
        setSelected(new Set(p.files.filter((f) => f.downloadable).map((f) => f.id)));
        if (!form.getFieldValue("name")) {
          form.setFieldValue("name", p.source.title);
          if (!slugTouched) form.setFieldValue("slug", slugify(p.source.title));
        }
      },
    });
  };

  const busy = progress !== null;
  const materials = profile.data?.materials ?? [];

  return (
    <form
      className="grid grid-cols-1 gap-6 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="space-y-6">
        <form.Field name="brief">
          {(f) => {
            const invalid = f.state.meta.isTouched && !f.state.meta.isValid;
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor="np-brief">What do you need?</FieldLabel>
                <Textarea
                  id="np-brief"
                  rows={5}
                  placeholder="A desk organiser: tray for pens, a cup, and a clip that holds a 6 mm cable on the tray edge. Fits on the left of my monitor stand."
                  value={f.state.value}
                  aria-invalid={invalid}
                  onBlur={f.handleBlur}
                  onChange={(e) => f.handleChange(e.target.value)}
                />
                {invalid && <FieldError>{firstError(f.state.meta.errors)}</FieldError>}
              </Field>
            );
          }}
        </form.Field>

        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <form.Field name="name">
            {(f) => {
              const invalid = f.state.meta.isTouched && !f.state.meta.isValid;
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="np-name">Name</FieldLabel>
                  <Input
                    id="np-name"
                    autoComplete="off"
                    placeholder="Desk organiser"
                    value={f.state.value}
                    aria-invalid={invalid}
                    onBlur={f.handleBlur}
                    onChange={(e) => {
                      f.handleChange(e.target.value);
                      if (!slugTouched) form.setFieldValue("slug", slugify(e.target.value));
                    }}
                  />
                  {invalid && <FieldError>{firstError(f.state.meta.errors)}</FieldError>}
                </Field>
              );
            }}
          </form.Field>
          <form.Field name="slug" validators={{ onChange: ({ value }) => slugError(value) ?? undefined }}>
            {(f) => {
              const invalid = slugTaken || (f.state.meta.isTouched && !f.state.meta.isValid);
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="np-slug">Address</FieldLabel>
                  <Input
                    id="np-slug"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    className="font-mono"
                    value={f.state.value}
                    aria-invalid={invalid}
                    onBlur={f.handleBlur}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setSlugTaken(false);
                      f.handleChange(e.target.value);
                    }}
                  />
                  {invalid && <FieldError>{slugTaken ? "A project with this address already exists" : firstError(f.state.meta.errors)}</FieldError>}
                </Field>
              );
            }}
          </form.Field>
        </FieldGroup>

        <section className="space-y-3" aria-labelledby="np-refs">
          <h3 id="np-refs" className="text-sm font-medium">
            References <span className="font-normal text-dim">(the agent measures these, it does not guess)</span>
          </h3>
          <UrlImport
            url={url}
            onUrlChange={(v) => {
              setUrl(v);
              preview.reset();
            }}
            onPreview={runPreview}
            pending={preview.isPending}
            error={preview.error?.message ?? null}
            preview={preview.data}
            selected={selected}
            onSelectedChange={setSelected}
          />
          <FileDrop files={files} onFilesChange={setFiles} />
        </section>

        <section className="space-y-3" aria-labelledby="np-constraints">
          <h3 id="np-constraints" className="text-sm font-medium">
            Constraints
          </h3>
          <form.Field name="material">
            {(f) => (
              <Field orientation="horizontal" className="max-sm:flex-col max-sm:items-start">
                <FieldLabel htmlFor="np-material" className="w-24 shrink-0">
                  Material
                </FieldLabel>
                <Select value={f.state.value || materials[0]?.name || ""} onValueChange={f.handleChange} disabled={materials.length === 0}>
                  <SelectTrigger id="np-material" className="w-48">
                    <SelectValue placeholder={profile.isPending ? "Loading" : "No materials in the library"} />
                  </SelectTrigger>
                  <SelectContent>
                    {materials.map((m) => (
                      <SelectItem key={m.name} value={m.name}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {profile.data && <span className="truncate text-xs text-faint">printer: {profile.data.printer.name}</span>}
              </Field>
            )}
          </form.Field>
          <form.Field name="strictness">
            {(f) => (
              <Field orientation="horizontal" className="max-sm:flex-col max-sm:items-start">
                <FieldLabel className="w-24 shrink-0">Strictness</FieldLabel>
                <div className="min-w-0 space-y-1">
                  <ToggleGroup type="single" variant="outline" size="sm" value={f.state.value} onValueChange={(v) => isStrictness(v) && f.handleChange(v)} aria-label="Strictness">
                    {STRICTNESS.map((s) => (
                      <ToggleGroupItem key={s.value} value={s.value} className="px-3">
                        {s.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <p className="text-xs text-faint">{STRICTNESS.find((s) => s.value === f.state.value)?.hint}</p>
                </div>
              </Field>
            )}
          </form.Field>
        </section>

        <section className="space-y-2" aria-labelledby="np-agent">
          <h3 id="np-agent" className="text-sm font-medium">
            Agent
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            <AgentPicker />
            <span className="text-xs text-faint">Runs on the host with your own login; drawer tools only.</span>
          </div>
        </section>
      </div>

      <div className="sticky -bottom-px flex justify-end gap-2 bg-popover pt-2 pb-safe">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {progress ?? "Start session"}
        </Button>
      </div>
    </form>
  );
}
