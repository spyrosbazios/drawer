import { createContext, use } from "react";

/** What a thread row needs from the workspace to open things: set once by the thread, read by its rows. */
export interface ThreadActions {
  openPart: (part: string) => void;
  /** A project file: a part's own files open the part, the assembly file the assembly, anything else the file viewer. */
  openPath: (path: string) => void;
}

const none: ThreadActions = { openPart: () => undefined, openPath: () => undefined };

export const ThreadContext = createContext<ThreadActions>(none);
export const useThreadActions = (): ThreadActions => use(ThreadContext);
