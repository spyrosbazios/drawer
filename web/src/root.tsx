import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import { PwaUpdates } from "@/components/pwa-updates";
import "@/lib/install";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRealtimeSync } from "@/hooks/realtime";
import { applyTheme, useAppearance } from "@/hooks/use-appearance";
import { queryClient, router } from "./router";

/** Things that run once for the whole app and render nothing of their own. */
function AppEffects() {
  const { resolved } = useAppearance();
  useRealtimeSync();
  useEffect(() => applyTheme(resolved), [resolved]);
  return null;
}

export function Root() {
  const { resolved } = useAppearance();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <AppEffects />
        <RouterProvider router={router} />
        <Toaster theme={resolved} position="bottom-right" />
        <PwaUpdates />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
