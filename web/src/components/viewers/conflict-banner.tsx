import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shown when the file changed on the server while the user has unsaved edits. */
export function ConflictBanner({ onReload, onKeepMine }: { onReload: () => void; onKeepMine: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-2 text-sm">
      <TriangleAlertIcon className="size-4 shrink-0 text-warn" />
      <span className="mr-auto">This file changed elsewhere. Your unsaved edits are still here.</span>
      <Button size="sm" variant="outline" onClick={onReload}>
        Reload from server
      </Button>
      <Button size="sm" variant="ghost" onClick={onKeepMine}>
        Keep mine
      </Button>
    </div>
  );
}
