import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// Captured at import time: the browser may fire this before any component has mounted.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

/** `install` is set while the browser offers installation; calling it shows the browser's prompt. */
export function useInstall(): { install: (() => Promise<void>) | null } {
  const event = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => deferred,
    () => null,
  );
  if (!event) return { install: null };
  return {
    install: async () => {
      await event.prompt();
      await event.userChoice;
      deferred = null;
      emit();
    },
  };
}
