import { useSyncExternalStore } from "react";
import { DraftStore } from "@/core/drafts";
import type { Draft } from "@/core/drafts";

export const drafts = new DraftStore();

/** The draft for one file; re-renders when it changes. */
export function useDraft(project: string, path: string): Draft | undefined {
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  return drafts.get(DraftStore.key(project, path));
}

/** The set of paths with unsaved edits in a project. */
export function useDirtyPaths(project: string): string[] {
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  return drafts.dirtyPaths(project);
}
