import type { SessionAttachment, SessionItem } from "@drawer/shared/api";
import { ClockIcon, CornerDownRightIcon, FileIcon, FileTextIcon, ImageIcon, ShapesIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { formatBytes } from "@/core/format";
import { attachmentUrl } from "@/services/sessions";
import { ZoomImage } from "./image-zoom";
import { RefChip } from "./ref-chip";
import { useThreadActions } from "./thread-context";

type UserItem = Extract<SessionItem, { type: "user" }>;

const KIND_ICON: Record<SessionAttachment["kind"], ReactNode> = {
  mesh: <ShapesIcon />,
  image: <ImageIcon />,
  markdown: <FileTextIcon />,
  text: <FileTextIcon />,
  scad: <FileTextIcon />,
  pdf: <FileIcon />,
  binary: <FileIcon />,
};

/** A non-image attachment: name, type and size, a download link. */
function FileChip({ attachment }: { attachment: SessionAttachment }) {
  const ext = attachment.name.includes(".") ? attachment.name.slice(attachment.name.lastIndexOf(".") + 1).toUpperCase() : attachment.kind;
  return (
    <Attachment size="sm">
      <AttachmentMedia>{KIND_ICON[attachment.kind]}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.name}</AttachmentTitle>
        <AttachmentDescription>
          {ext} · {formatBytes(attachment.size)}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentTrigger asChild>
        <a href={attachmentUrl(attachment, { download: true })} download={attachment.name} aria-label={`Download ${attachment.name}`} />
      </AttachmentTrigger>
    </Attachment>
  );
}

/** One of the person's messages: attachments, the text, the picks, and "queued" while the agent has not read it. */
export function UserMessage({ item, queued }: { item: UserItem; queued: boolean }) {
  const { openPart, openPath } = useThreadActions();
  const images = item.attachments.filter((a) => a.kind === "image");
  const others = item.attachments.filter((a) => a.kind !== "image");
  const filed = item.attachments.filter((a) => a.filedAs !== null);
  return (
    <Message align="end">
      <MessageContent>
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((a) => (
              <ZoomImage key={a.id} src={attachmentUrl(a)} alt={a.name} className="size-24" />
            ))}
          </div>
        )}
        {others.length > 0 && (
          <div className="flex max-w-full flex-col items-end gap-1.5">
            {others.map((a) => (
              <FileChip key={a.id} attachment={a} />
            ))}
          </div>
        )}
        {item.text.trim() !== "" && (
          <Bubble align="end" variant="muted">
            <BubbleContent className="whitespace-pre-wrap">{item.text}</BubbleContent>
          </Bubble>
        )}
        {item.refs.length > 0 && (
          <div className="flex max-w-full flex-wrap justify-end gap-1">
            {item.refs.map((r, i) => (
              <RefChip key={i} value={r} onOpen={() => (r.kind === "file" ? openPath(r.path) : openPart(r.part))} />
            ))}
          </div>
        )}
        {filed.length > 0 && (
          <div className="flex max-w-full flex-col items-end gap-0.5 text-xs text-dim">
            {filed.map((a) => (
              <button key={a.id} type="button" onClick={() => a.filedAs && openPath(a.filedAs)} title={`Open ${a.filedAs}`} className="flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
                <CornerDownRightIcon className="size-3 shrink-0" aria-hidden />
                <span className="shrink-0">filed as</span>
                <span className="truncate font-mono text-run">{a.filedAs}</span>
              </button>
            ))}
          </div>
        )}
        {queued && (
          <MessageFooter>
            <ClockIcon className="mr-1 size-3" aria-hidden /> queued
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}
