import type { FileKind } from "@drawer/shared/api";
import { KIND_LABEL, KIND_TONE } from "@/core/kinds";
import { cn } from "@/lib/utils";

export function KindBadge({ kind, className }: { kind: FileKind; className?: string }) {
  return (
    <span className={cn("inline-flex h-4 min-w-7 shrink-0 items-center justify-center rounded px-1 font-mono text-[10px] leading-none font-medium uppercase", KIND_TONE[kind], className)}>
      {KIND_LABEL[kind]}
    </span>
  );
}
