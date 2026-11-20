import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY } from "@/core/theme";
import type { ThemeChoice, ThemeName } from "@/core/theme";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): ThemeName {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : DEFAULT_THEME;
}

export function resolveTheme(choice: ThemeChoice): ThemeName {
  return choice === "system" ? systemTheme() : choice;
}

/** Applies a theme to the document: the `dark` class, `color-scheme` and the browser's theme colour. */
export function applyTheme(name: ThemeName): void {
  const root = document.documentElement;
  root.classList.toggle("dark", name === "dark");
  root.style.colorScheme = THEMES[name].scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEMES[name].C.bg);
}

export function useAppearance() {
  const choice = useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      const mql = window.matchMedia("(prefers-color-scheme: light)");
      mql.addEventListener("change", notify);
      return () => {
        listeners.delete(notify);
        mql.removeEventListener("change", notify);
      };
    },
    stored,
    () => "system" as ThemeChoice,
  );
  const resolved = resolveTheme(choice);
  const setChoice = useCallback((next: ThemeChoice) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be blocked; the choice then lasts until reload.
    }
    applyTheme(resolveTheme(next));
    emit();
  }, []);
  return { choice, resolved, setChoice };
}
