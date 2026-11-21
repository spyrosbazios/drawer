import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  id: string;
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  /** The content lays itself out to the card's edge (a list beside a detail pane), so the card adds no padding. */
  flush?: boolean;
  children: ReactNode;
}

/** One area of the settings page: a titled block with an optional one-line description. */
export function SettingsSection({ id, icon, title, description, aside, flush = false, children }: Props) {
  return (
    <section aria-labelledby={`settings-${id}`} className="space-y-3">
      <div className="space-y-0.5">
        <h2 id={`settings-${id}`} className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
          {aside && <span className="ml-auto text-xs font-normal text-faint">{aside}</span>}
        </h2>
        {description && <p className="text-xs text-dim">{description}</p>}
      </div>
      <div className={cn("rounded-xl border border-line bg-card", flush ? "overflow-hidden" : "p-4")}>{children}</div>
    </section>
  );
}
