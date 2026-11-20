/**
 * The instances selected in the assembly (one clicked instance, or the two of a mate row), shared by the
 * centre view and the right panel. Kept outside React, per project, like `lib/pointing.ts`.
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;
const EMPTY: readonly string[] = [];

class AssemblySelection {
  private sel = new Map<string, readonly string[]>();
  private listeners = new Set<Listener>();

  get = (slug: string): readonly string[] => this.sel.get(slug) ?? EMPTY;

  set(slug: string, ids: readonly string[]): void {
    this.sel.set(slug, ids.length === 0 ? EMPTY : [...ids]);
    for (const l of this.listeners) l();
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

export const assemblySelection = new AssemblySelection();

export function useAssemblySelection(slug: string): readonly string[] {
  return useSyncExternalStore(assemblySelection.subscribe, () => assemblySelection.get(slug));
}
