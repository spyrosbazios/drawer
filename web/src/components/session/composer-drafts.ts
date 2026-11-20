/**
 * Unsent composer state, kept outside React per session (or per project before a session exists), so
 * switching the right panel to Review, switching sessions or closing the phone sheet never loses it:
 * the text, and the files being attached. Uploads start at once and run on in here, so one that
 * finishes while the panel is away is waiting when the person comes back.
 */
import type { SessionAttachment } from "@drawer/shared/api";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@drawer/shared/api";
import { useSyncExternalStore } from "react";
import { formatBytes } from "@/core/format";

/** The draft key: a session id, or `new:<slug>` for the message that starts one. */
export const draftKey = (slug: string, sessionId: string | undefined): string => sessionId ?? `new:${slug}`;

export interface DraftFile {
  id: string;
  name: string;
  size: number;
  /** A local preview for images (an object URL), revoked when the file leaves the draft. */
  previewUrl: string | null;
  status: "uploading" | "done" | "error";
  /** 0..1 while uploading. */
  progress: number;
  /** Set once the upload is done. */
  attachment: SessionAttachment | null;
  error: string | null;
}

/** Uploads one file; `useUploadAttachment(slug).mutateAsync` fits. */
export type Uploader = (v: { file: File; name: string; onProgress: (fraction: number) => void; signal: AbortSignal }) => Promise<SessionAttachment>;

interface Job {
  file: File;
  key: string;
  upload: Uploader;
  controller: AbortController;
}

const texts = new Map<string, string>();
const files = new Map<string, readonly DraftFile[]>();
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
const NONE: readonly DraftFile[] = [];
let nextId = 0;

const emit = () => {
  for (const l of listeners) l();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function setComposerDraft(key: string, text: string): void {
  if (text === "") texts.delete(key);
  else texts.set(key, text);
  emit();
}

export const useComposerDraft = (key: string): string => useSyncExternalStore(subscribe, () => texts.get(key) ?? "");
export const draftFiles = (key: string): readonly DraftFile[] => files.get(key) ?? NONE;
export const useDraftFiles = (key: string): readonly DraftFile[] => useSyncExternalStore(subscribe, () => draftFiles(key));

/** Which of `incoming` fit under the limits (in order), and one short sentence for what did not. */
export function planFiles(have: number, incoming: readonly { name: string; size: number }[]): { accepted: number[]; notice: string | null } {
  const accepted: number[] = [];
  const tooBig: string[] = [];
  let over = 0;
  for (const [i, f] of incoming.entries()) {
    if (f.size > MAX_ATTACHMENT_BYTES) tooBig.push(f.name);
    else if (have + accepted.length >= MAX_ATTACHMENTS) over++;
    else accepted.push(i);
  }
  const notes: string[] = [];
  if (tooBig.length > 0) notes.push(`${tooBig.length === 1 ? tooBig[0] : `${tooBig.length} files`} over ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
  if (over > 0) notes.push(`at most ${MAX_ATTACHMENTS} files per message`);
  return { accepted, notice: notes.length > 0 ? `Not attached: ${notes.join("; ")}.` : null };
}

/** A name for a clipboard image, which browsers all call `image.png`. */
export function pastedName(file: Pick<File, "name" | "type">, at: Date): string {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = file.type.split("/")[1]?.replace(/\+.*/, "") || "png";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `pasted-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.${ext}`;
}

function update(key: string, id: string, patch: Partial<DraftFile>): void {
  const have = files.get(key);
  if (!have?.some((f) => f.id === id)) return;
  files.set(key, have.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  emit();
}

function run(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.controller = new AbortController();
  const { controller, key, file } = job;
  update(key, id, { status: "uploading", progress: 0, error: null });
  job
    .upload({ file, name: file.name, onProgress: (progress) => update(key, id, { progress }), signal: controller.signal })
    .then((attachment) => update(key, id, { status: "done", progress: 1, attachment }))
    .catch((err: unknown) => {
      if (controller.signal.aborted) return;
      update(key, id, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
    });
}

function preview(file: File): string | null {
  return file.type.startsWith("image/") && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
}

/** Adds files to a draft and starts uploading them; returns a short note when some were left out. */
export function addDraftFiles(key: string, incoming: readonly File[], upload: Uploader): string | null {
  const have = draftFiles(key);
  const plan = planFiles(have.length, incoming);
  const added: DraftFile[] = [];
  for (const i of plan.accepted) {
    const file = incoming[i];
    if (!file) continue;
    const id = `f${++nextId}`;
    jobs.set(id, { file, key, upload, controller: new AbortController() });
    added.push({ id, name: file.name, size: file.size, previewUrl: preview(file), status: "uploading", progress: 0, attachment: null, error: null });
  }
  if (added.length > 0) {
    files.set(key, [...have, ...added]);
    emit();
    for (const f of added) run(f.id);
  }
  return plan.notice;
}

function drop(key: string, id: string): void {
  const f = files.get(key)?.find((x) => x.id === id);
  if (f?.previewUrl) URL.revokeObjectURL(f.previewUrl);
  jobs.delete(id);
}

/** Removes a file from the draft; one still uploading is aborted. */
export function removeDraftFile(key: string, id: string): void {
  jobs.get(id)?.controller.abort();
  drop(key, id);
  const rest = (files.get(key) ?? NONE).filter((f) => f.id !== id);
  if (rest.length === 0) files.delete(key);
  else files.set(key, rest);
  emit();
}

export function retryDraftFile(id: string): void {
  run(id);
}

/** After a send: the files left with the message. */
export function clearDraftFiles(key: string): void {
  for (const f of files.get(key) ?? NONE) drop(key, f.id);
  files.delete(key);
  emit();
}
