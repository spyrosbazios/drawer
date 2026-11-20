import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { useIsDesktop } from "@/hooks/use-media";
import { cn } from "@/lib/utils";

interface ResponsiveModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** A dialog from `md` up, a bottom drawer below it (forms live in drawers on the phone). */
export function ResponsiveModal({ open, onOpenChange, title, description, children, footer, className }: ResponsiveModalProps) {
  const desktop = useIsDesktop();
  if (desktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn("max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl", className)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-0.5 scroll-contain">{children}</div>
          {footer && <DialogFooter>{footer}</DialogFooter>}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[92dvh]">
        <DrawerHeader className="text-left">
          <DrawerTitle>{title}</DrawerTitle>
          {description ? <DrawerDescription>{description}</DrawerDescription> : <DrawerDescription className="sr-only">{title}</DrawerDescription>}
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 scroll-contain">{children}</div>
        {footer && <DrawerFooter className="pb-safe">{footer}</DrawerFooter>}
      </DrawerContent>
    </Drawer>
  );
}
