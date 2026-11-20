import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { statusText } from "@/components/status/status-chip";
import type { AnyStatus } from "@/components/status/status-chip";
import { localPref, parseFlags, useLocalPref } from "@/lib/local-pref";
import type { LocalPref } from "@/lib/local-pref";
import { cn } from "@/lib/utils";

/**
 * Foldable sections, the same everywhere: the sidebar's outline, the part review and the assembly review.
 * Which sections the viewer opened or closed is remembered per browser; a section the viewer never touched
 * follows its default, which the caller computes from the data (a failing gate opens its section).
 */
export const outlineFolds = localPref<Record<string, boolean>>("drawer.folds.outline", {}, parseFlags);
export const reviewFolds = localPref<Record<string, boolean>>("drawer.folds.review", {}, parseFlags);
export const assemblyFolds = localPref<Record<string, boolean>>("drawer.folds.assembly", {}, parseFlags);

/** `defaults` lists every section the group renders, with whether it starts open. */
export function Folds({ prefs, defaults, className, children }: { prefs: LocalPref<Record<string, boolean>>; defaults: Record<string, boolean>; className?: string; children: React.ReactNode }) {
  const saved = useLocalPref(prefs);
  const ids = Object.keys(defaults);
  const isOpen = (id: string) => saved[id] ?? defaults[id] ?? false;
  const onValueChange = (next: string[]) => {
    const changed: Record<string, boolean> = {};
    for (const id of ids) if (next.includes(id) !== isOpen(id)) changed[id] = !isOpen(id);
    if (Object.keys(changed).length > 0) prefs.set({ ...prefs.get(), ...changed });
  };
  return (
    <Accordion type="multiple" value={ids.filter(isOpen)} onValueChange={onValueChange} className={className}>
      {children}
    </Accordion>
  );
}

interface FoldProps {
  id: string;
  title: string;
  /** What the closed section says about itself: a count, "2 failing". Right-aligned beside the chevron. */
  summary?: React.ReactNode;
  /** Colours the summary like that status does. */
  status?: AnyStatus;
  children: React.ReactNode;
}

export function Fold({ id, title, summary, status, children }: FoldProps) {
  return (
    <AccordionItem value={id} className="border-line">
      <AccordionTrigger className="items-center rounded-none px-3 py-1.5 text-[11px] font-medium tracking-wide text-dim uppercase hover:bg-raised/60 hover:no-underline">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0">{title}</span>
          {summary !== undefined && <span className={cn("ml-auto truncate font-normal tracking-normal normal-case", status ? statusText(status) : "text-faint")}>{summary}</span>}
        </span>
      </AccordionTrigger>
      <AccordionContent className="pb-2">{children}</AccordionContent>
    </AccordionItem>
  );
}
