import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** A thumbnail that opens the picture larger in a dialog. */
export function ZoomImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`Enlarge ${alt}`} className={cn("block shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-line bg-raised transition-colors hover:border-faint focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none", className)}>
        <img src={src} alt={alt} loading="lazy" className="size-full object-cover" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(92vw,64rem)]">
          <DialogTitle className="truncate text-sm">{alt}</DialogTitle>
          <DialogDescription className="sr-only">Larger view</DialogDescription>
          <img src={src} alt={alt} className="max-h-[75vh] w-full rounded-md bg-raised object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}
