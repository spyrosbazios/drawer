import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** The action bar pinned to the bottom of a review panel: the sections scroll above it, it never does. */
export function PanelFooter({ children }: { children: React.ReactNode }) {
  return <div className="pb-safe flex shrink-0 items-center gap-2 border-t border-line bg-card p-2">{children}</div>;
}

export interface MoreItem {
  key: string;
  label: string;
  icon: typeof MoreHorizontalIcon;
  disabled?: boolean;
  /** A link item (a download) instead of a handler. */
  href?: string;
  download?: string;
  onSelect?: () => void;
  separatorBefore?: boolean;
}

/** Everything that does not fit beside the primary action, in one menu. */
export function MoreMenu({ items }: { items: readonly MoreItem[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="ml-auto shrink-0" aria-label="More actions">
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-52">
        {items.map((it) => (
          <div key={it.key}>
            {it.separatorBefore && <DropdownMenuSeparator />}
            {it.href && !it.disabled ? (
              <DropdownMenuItem asChild>
                <a href={it.href} download={it.download}>
                  <it.icon /> {it.label}
                </a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={it.disabled} onSelect={it.onSelect}>
                <it.icon /> {it.label}
              </DropdownMenuItem>
            )}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
