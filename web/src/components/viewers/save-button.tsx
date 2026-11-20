import { SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SaveButton({ dirty, saving, disabled, onSave, className }: { dirty: boolean; saving: boolean; disabled?: boolean; onSave: () => void; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {dirty && <span className="text-xs text-warn">Unsaved changes</span>}
      <Button size="sm" onClick={onSave} disabled={!dirty || saving || disabled}>
        <SaveIcon /> {saving ? "Saving" : "Save"}
      </Button>
    </div>
  );
}
