// The page follows the system theme until the visitor picks one; the pick lives in localStorage and on
// <html data-theme>, which index.html's inline script restores before the first paint.
import { useCallback, useSyncExternalStore } from "react";

export type ThemeName = "light" | "dark";
const KEY = "drawer-site.theme";
const listeners = new Set<() => void>();
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The theme the visitor picked, or null when the page follows the system. */
function picked(): ThemeName | null {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : null;
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  const m = media();
  m.addEventListener("change", notify);
  return () => {
    listeners.delete(notify);
    m.removeEventListener("change", notify);
  };
}

const snapshot = () => picked() ?? "system";

export function useTheme() {
  const choice = useSyncExternalStore(subscribe, snapshot, () => "system" as const);
  const resolved: ThemeName = choice === "system" ? (media().matches ? "dark" : "light") : choice;
  const toggle = useCallback(() => {
    const next: ThemeName = (picked() ?? (media().matches ? "dark" : "light")) === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage can be blocked; the choice then lasts until reload.
    }
    listeners.forEach((l) => l());
  }, []);
  return { choice, resolved, toggle };
}
