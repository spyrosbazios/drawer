import type { Link as FileLink, TreeEntry } from "@drawer/shared/api";
import { fileUrl } from "@/services/files";
import { MarkdownViewer } from "./markdown-viewer";
import { MeshFileViewer } from "./mesh-file-viewer";
import { RevisionBanner } from "./revision-banner";
import { ScadViewer } from "./scad-viewer";
import { ImageViewer, PdfViewer, TextViewer } from "./simple-viewers";
import { BinaryCard, FileMissing } from "./viewer-parts";

interface Props {
  slug: string;
  entry: TreeEntry | undefined;
  path: string;
  at: string | undefined;
  edit: boolean;
  onEdit: (edit: boolean) => void;
  onBackToCurrent: () => void;
  onOpenLink: (link: FileLink) => void;
}

/** Picks the viewer from the file's kind. */
export function FileViewer({ slug, entry, path, at, edit, onEdit, onBackToCurrent, onOpenLink }: Props) {
  // A file at an old revision may no longer exist in the tree; the revision is still readable, so only the head needs the entry.
  if (!entry && !at) return <FileMissing path={path} />;
  const kind = entry?.kind ?? "text";
  const rev = entry?.rev;
  const common = { slug, path, at, rev };

  let body;
  switch (kind) {
    case "markdown":
      body = <MarkdownViewer key={`${path}@${at ?? ""}`} slug={slug} path={path} at={at} edit={edit} onEdit={onEdit} onOpenLink={onOpenLink} />;
      break;
    case "scad":
      body = <ScadViewer key={`${path}@${at ?? ""}`} slug={slug} path={path} at={at} />;
      break;
    case "mesh":
      body = <MeshFileViewer key={`${path}@${at ?? ""}`} slug={slug} path={path} rev={rev} at={at} />;
      break;
    case "image":
      body = <ImageViewer {...common} />;
      break;
    case "pdf":
      body = <PdfViewer {...common} />;
      break;
    case "text":
      body = <TextViewer key={`${path}@${at ?? ""}`} {...common} edit={edit} onEdit={onEdit} />;
      break;
    case "binary":
      body = <BinaryCard name={path} size={entry?.size} href={fileUrl(slug, path, { at, download: true })} />;
      break;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {at && <RevisionBanner slug={slug} path={path} at={at} onBack={onBackToCurrent} />}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}
