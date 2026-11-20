import { useSyncExternalStore } from "react";

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", notify);
      return () => mql.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The laptop shell from the `md` breakpoint (768 px) up; the phone shell below it. */
export const useIsDesktop = () => useMedia("(min-width: 768px)");
