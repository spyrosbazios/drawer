import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The button that folds a side panel away or brings it back. Each panel holds its own fold button; while it is
 * folded, the way back sits at that end of the centre's menubar.
 */
export function PanelToggle({ label, shortcut, onClick, children }: { label: string; shortcut?: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative shrink-0 text-dim" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-2 text-faint">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
