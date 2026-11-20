import { useNavigate } from "@tanstack/react-router";
import type { PatchProjectBody, Project, TreeEntry } from "@drawer/shared/api";
import { useState } from "react";
import { toast } from "sonner";
import { ResponsiveModal } from "@/components/responsive-modal";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useDeleteProject, usePatchProject } from "@/hooks/projects";

const NO_COVER = "__none__";

interface Props {
  project: Project;
  entries: readonly TreeEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The library cannot be deleted. */
  isLibrary: boolean;
}

export function ProjectSettingsDialog({ project, entries, open, onOpenChange, isLibrary }: Props) {
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange} title="Project settings" description={project.slug} className="sm:max-w-lg">
      {open && <SettingsForm project={project} entries={entries} isLibrary={isLibrary} onClose={() => onOpenChange(false)} />}
    </ResponsiveModal>
  );
}

function SettingsForm({ project, entries, isLibrary, onClose }: { project: Project; entries: readonly TreeEntry[]; isLibrary: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const patch = usePatchProject(project.slug);
  const del = useDeleteProject();
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description);
  const [cover, setCover] = useState(project.cover ?? NO_COVER);
  const [confirm, setConfirm] = useState("");

  const coverable = entries.filter((e) => e.type === "file" && (e.kind === "scad" || e.kind === "mesh"));
  // The server reports the effective cover (its automatic pick when none was chosen), so the body carries
  // only what the user changed: echoing `cover` back would pin the automatic pick as an explicit choice.
  const body: PatchProjectBody = {};
  if (title.trim() !== "" && title.trim() !== project.title) body.title = title.trim();
  if (description !== project.description) body.description = description;
  if (cover !== (project.cover ?? NO_COVER)) body.cover = cover === NO_COVER ? null : cover;
  const changed = Object.keys(body).length > 0;

  const save = () => patch.mutate(body, { onSuccess: onClose, onError: (err) => toast.error(err.message) });

  return (
    <div className="space-y-5 pb-2">
      <Field>
        <FieldLabel htmlFor="ps-title">Title</FieldLabel>
        <Input id="ps-title" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor="ps-desc">Description</FieldLabel>
        <Textarea id="ps-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </Field>
      <Field>
        <FieldLabel htmlFor="ps-cover">Cover file</FieldLabel>
        <Select value={cover} onValueChange={setCover}>
          <SelectTrigger id="ps-cover" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_COVER}>Automatic (first .scad in src/, else first mesh)</SelectItem>
            {coverable.map((e) => (
              <SelectItem key={e.path} value={e.path}>
                {e.path}
              </SelectItem>
            ))}
            {project.cover && !coverable.some((e) => e.path === project.cover) && <SelectItem value={project.cover}>{project.cover}</SelectItem>}
          </SelectContent>
        </Select>
        <FieldDescription>The cover is the render of this file.</FieldDescription>
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={!changed || patch.isPending}>
          {patch.isPending ? "Saving" : "Save"}
        </Button>
      </div>

      {!isLibrary && (
        <section className="space-y-3 rounded-xl border border-down/40 p-4">
          <h3 className="text-sm font-medium text-down">Delete this project</h3>
          <p className="text-sm text-dim">
            Moves the folder to the server's trash. Type <span className="font-mono text-fg">{project.slug}</span> to confirm.
          </p>
          <Input aria-label="Type the project slug to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} className="font-mono" />
          <Button
            variant="destructive"
            disabled={confirm !== project.slug || del.isPending}
            onClick={() =>
              del.mutate(project.slug, {
                onSuccess: () => {
                  onClose();
                  toast.success(`Deleted ${project.title}`);
                  void navigate({ to: "/", search: {} });
                },
                onError: (err) => toast.error(err.message),
              })
            }
          >
            {del.isPending ? "Deleting" : "Delete project"}
          </Button>
        </section>
      )}
    </div>
  );
}
