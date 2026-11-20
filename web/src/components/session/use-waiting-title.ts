import { useEffect } from "react";

/**
 * While `waiting` is set and the tab is in the background, the document title says the agent waits for
 * the person; it is put back when the tab is focused again or the session stops waiting.
 */
export function useWaitingTitle(waiting: string | undefined): void {
  useEffect(() => {
    if (!waiting) return;
    let saved: string | null = null;
    const sync = () => {
      if (document.hidden && saved === null) {
        saved = document.title;
        document.title = `Waiting for you: ${waiting}`;
      } else if (!document.hidden && saved !== null) {
        document.title = saved;
        saved = null;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      if (saved !== null) document.title = saved;
    };
  }, [waiting]);
}
