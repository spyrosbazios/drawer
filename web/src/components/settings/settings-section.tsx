import type { ReactNode } from "react";

/** One area of the settings page: a titled block with an optional one-line description. */
export function SettingsSection({ id, icon, title, description, aside, children }: { id: string; icon: ReactNode; title: string; description?: ReactNode; aside?: ReactNode; children: ReactNode }) {
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
      <div className="rounded-xl border border-line bg-card p-4">{children}</div>
    </section>
  );
}
