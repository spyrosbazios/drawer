import { useEffect } from "react";
import { toast } from "sonner";
import { useRegisterSW } from "virtual:pwa-register/react";

const HOUR = 60 * 60 * 1000;

let registration: ServiceWorkerRegistration | undefined;

/** Asks the browser to look for a new build now; resolves when it has looked. */
export async function checkForUpdates(): Promise<void> {
  await registration?.update();
}

/** A new build waits for the user: a persistent toast offers the reload; nothing swaps mid-session. */
export function PwaUpdates() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      registration = reg;
      if (reg) setInterval(() => void reg.update(), HOUR);
    },
  });

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void registration?.update();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    if (!needRefresh) return;
    const id = toast("A new version of drawer is ready", {
      duration: Infinity,
      action: { label: "Reload", onClick: () => void updateServiceWorker(true) },
    });
    return () => void toast.dismiss(id);
  }, [needRefresh, updateServiceWorker]);

  return null;
}
