import type { SessionRef } from "@drawer/shared/api";
import { BoxIcon, FileTextIcon, MapPinIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const ICON = { part: BoxIcon, point: MapPinIcon, file: FileTextIcon } as const;

/** What a pick says: a part, "point on <part>", or a file path. */
export function refLabel(ref: SessionRef): string {
  switch (ref.kind) {
    case "part":
      return ref.part;
    case "point":
      return `point on ${ref.part}`;
    case "file":
      return ref.path;
  }
}

const base = "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md border border-line bg-raised px-1.5 text-xs text-fg";

/** A pick as a chip: removable in the composer, a button that opens it in a sent message. */
export function RefChip({ value, onRemove, onOpen }: { value: SessionRef; onRemove?: () => void; onOpen?: () => void }) {
  const Icon = ICON[value.kind];
  const label = (
    <>
      <Icon className="size-3 shrink-0 text-run" aria-hidden />
      <span className="truncate">{refLabel(value)}</span>
    </>
  );
  if (onRemove) {
    return (
      <span className={base}>
        {label}
        <button type="button" onClick={onRemove} aria-label={`Remove ${refLabel(value)}`} className="-mr-0.5 rounded p-0.5 text-dim hover:bg-line hover:text-fg">
          <XIcon className="size-3" />
        </button>
      </span>
    );
  }
  return (
    <button type="button" onClick={onOpen} disabled={!onOpen} className={cn(base, onOpen && "cursor-pointer transition-colors hover:border-faint")}>
      {label}
    </button>
  );
}
