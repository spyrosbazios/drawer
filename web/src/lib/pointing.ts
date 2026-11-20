/**
 * What a person has picked in a viewer (a part, a point on a face, a file) to attach to their next message
 * to the agent. Kept outside React, per project, so switching parts or panels keeps the picks; the session
 * composer reads them and clears them once the message is sent.
 */
import type { SessionRef } from "@drawer/shared/api";
import { useSyncExternalStore } from "react";

type Listener = () => void;

/** Two refs are the same pick when they point at the same thing. */
export function refKey(ref: SessionRef): string {
  switch (ref.kind) {
    case "part":
      return `part:${ref.part}`;
    case "point":
      return `point:${ref.part}:${ref.position.map((n) => n.toFixed(2)).join(",")}`;
    case "file":
      return `file:${ref.path}`;
  }
}

const EMPTY: readonly SessionRef[] = [];

class PointingStore {
  private picks = new Map<string, readonly SessionRef[]>();
  private listeners = new Set<Listener>();

  get = (slug: string): readonly SessionRef[] => this.picks.get(slug) ?? EMPTY;

  /** Adds a pick; the same pick twice is kept once. */
  add(slug: string, ref: SessionRef): void {
    const have = this.get(slug);
    if (have.some((r) => refKey(r) === refKey(ref))) return;
    this.set(slug, [...have, ref]);
  }

  remove(slug: string, ref: SessionRef): void {
    const key = refKey(ref);
    this.set(slug, this.get(slug).filter((r) => refKey(r) !== key));
  }

  clear(slug: string): void {
    if (this.get(slug).length > 0) this.set(slug, EMPTY);
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(slug: string, refs: readonly SessionRef[]): void {
    // A new array per change: useSyncExternalStore compares snapshots by identity.
    this.picks.set(slug, refs);
    for (const l of this.listeners) l();
  }
}

export const pointing = new PointingStore();

/** The picks for one project; re-renders when they change. */
export function usePointed(slug: string): readonly SessionRef[] {
  return useSyncExternalStore(pointing.subscribe, () => pointing.get(slug));
}
