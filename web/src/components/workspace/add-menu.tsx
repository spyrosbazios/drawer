import { LinkIcon, NotebookPenIcon, PlusIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

interface Props {
  onUploadReference: () => void;
  onImport: () => void;
  onNewNote: () => void;
  iconOnly?: boolean;
}

/** What a person may add to a project: references and notes. Parts, specs and models are the agent's. */
export function AddMenu({ onUploadReference, onImport, onNewNote, iconOnly = false }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {iconOnly ? (
          <Button variant="ghost" size="icon" aria-label="Add" className="size-10">
            <PlusIcon />
          </Button>
        ) : (
          <Button variant="outline" size="icon" className="size-8" aria-label="Add">
            <PlusIcon />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal text-faint">Add to the project</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onUploadReference}>
          <UploadIcon /> Upload a reference
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onImport}>
          <LinkIcon /> Import from a URL
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewNote}>
          <NotebookPenIcon /> New note
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
