import type { SessionRef } from "@drawer/shared/api";
import { ArrowUpIcon, FileIcon, PaperclipIcon, RotateCwIcon, SquareIcon, XIcon } from "lucide-react";
import { useRef } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/core/format";
import { useIsDesktop } from "@/hooks/use-media";
import { pointing, refKey, usePointed } from "@/lib/pointing";
import { clearDraftFiles, pastedName, setComposerDraft, useComposerDraft } from "./composer-drafts";
import type { DraftFile } from "./composer-drafts";
import { RefChip } from "./ref-chip";
import type { Attachments } from "./use-attachments";

interface ComposerProps {
  slug: string;
  draftKey: string;
  placeholder: string;
  attachments: Attachments;
  /** A message is being sent. */
  busy: boolean;
  /** The agent is on a turn: with nothing typed, the send button becomes Stop. */
  stoppable: boolean;
  onStop: () => void;
  /** Sends; resolves true when the server took it (draft, picks and files are then cleared). */
  onSend: (text: string, refs: SessionRef[], attachmentIds: string[]) => Promise<boolean>;
}

function FileChip({ file, onRemove, onRetry }: { file: DraftFile; onRemove: () => void; onRetry: () => void }) {
  const state = file.status === "uploading" ? "uploading" : file.status === "error" ? "error" : "done";
  return (
    <Attachment size="xs" state={state} className="min-w-0 basis-40 flex-1 sm:flex-none">
      <AttachmentMedia variant={file.previewUrl ? "image" : "icon"}>{file.previewUrl ? <img src={file.previewUrl} alt="" /> : <FileIcon />}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
        <AttachmentDescription title={file.error ?? undefined}>
          {file.status === "uploading" ? `${Math.round(file.progress * 100)}%` : file.status === "error" ? (file.error ?? "failed") : formatBytes(file.size)}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        {file.status === "error" && (
          <AttachmentAction aria-label={`Retry ${file.name}`} onClick={onRetry}>
            <RotateCwIcon />
          </AttachmentAction>
        )}
        <AttachmentAction aria-label={`Remove ${file.name}`} onClick={onRemove}>
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
      {file.status === "uploading" && <Progress value={file.progress * 100} className="h-0.5 basis-full" aria-label={`Uploading ${file.name}`} />}
    </Attachment>
  );
}

/**
 * The message box: picks from the viewer and attached files as chips on top, a growing textarea, attach and
 * send. Enter sends on a laptop (Shift+Enter a new line); on the phone Enter is a new line and the button sends.
 */
export function Composer({ slug, draftKey, placeholder, attachments, busy, stoppable, onStop, onSend }: ComposerProps) {
  const desktop = useIsDesktop();
  const text = useComposerDraft(draftKey);
  const picks = usePointed(slug);
  const picker = useRef<HTMLInputElement>(null);
  const { files, notice } = attachments;

  const uploading = files.some((f) => f.status === "uploading");
  const failed = files.some((f) => f.status === "error");
  const ids = files.flatMap((f) => (f.attachment ? [f.attachment.id] : []));
  const empty = text.trim() === "" && files.length === 0;
  const ready = !busy && !uploading && !failed && (text.trim() !== "" || ids.length > 0);

  const send = async () => {
    if (!ready) return;
    if (await onSend(text.trim(), [...picks], ids)) {
      setComposerDraft(draftKey, "");
      pointing.clear(slug);
      clearDraftFiles(draftKey);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (desktop && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length === 0) return;
    e.preventDefault();
    const at = new Date();
    attachments.add(pasted.map((f) => new File([f], pastedName(f, at), { type: f.type })));
  };

  return (
    <div className="space-y-1">
      <input
        ref={picker}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Attach files"
        onChange={(e) => {
          attachments.add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <InputGroup className="bg-card">
        {(picks.length > 0 || files.length > 0) && (
          <InputGroupAddon align="block-start" className="flex-wrap justify-start gap-1.5" aria-label="Attached to the next message">
            {picks.map((r) => (
              <RefChip key={refKey(r)} value={r} onRemove={() => pointing.remove(slug, r)} />
            ))}
            {files.map((f) => (
              <FileChip key={f.id} file={f} onRemove={() => attachments.remove(f.id)} onRetry={() => attachments.retry(f.id)} />
            ))}
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          value={text}
          onChange={(e) => setComposerDraft(draftKey, e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label="Message to the agent"
          rows={1}
          className="max-h-40 min-h-10 px-3 py-2.5 text-base md:text-sm"
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton size="icon-sm" variant="ghost" aria-label="Attach files" title="Attach files" onClick={() => picker.current?.click()}>
            <PaperclipIcon />
          </InputGroupButton>
          {notice && (
            <output className="min-w-0 flex-1 truncate text-xs font-normal text-destructive" title={notice}>
              {notice}
            </output>
          )}
          {stoppable && empty ? (
            <InputGroupButton size="icon-sm" variant="outline" className="ml-auto rounded-full" aria-label="Stop the agent" title="Stop the agent" onClick={onStop}>
              <SquareIcon className="size-3 fill-current" />
            </InputGroupButton>
          ) : (
            <InputGroupButton size="icon-sm" variant="default" className="ml-auto rounded-full" aria-label="Send" title={uploading ? "Waiting for uploads" : "Send"} disabled={!ready} onClick={() => void send()}>
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
