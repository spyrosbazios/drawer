/**
 * A per-browser preference: a small value that belongs to the viewer, not to the project or the address
 * (which sections are folded, how wide the panels are). Kept in `localStorage`, readable as an external
 * store so every component showing it stays in step. Never use it for anything another viewer, the agent
 * or a bookmark must see: that is the URL's or the server's job.
 */
import { useSyncExternalStore } from "react";

export interface LocalPref<T> {
  get: () => T;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function localPref<T>(key: string, fallback: T, parse: (raw: unknown) => T | undefined): LocalPref<T> {
  const listeners = new Set<() => void>();
  let value: T | undefined;

  const load = (): T => {
    try {
      const raw = localStorage.getItem(key);
      return (raw === null ? undefined : parse(JSON.parse(raw))) ?? fallback;
    } catch {
      return fallback;
    }
  };

  return {
    get: () => (value ??= load()),
    set: (next) => {
      value = next;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private mode or blocked storage: the preference lasts for this page only.
      }
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const useLocalPref = <T>(pref: LocalPref<T>): T => useSyncExternalStore(pref.subscribe, pref.get, pref.get);

export const parseBool = (raw: unknown): boolean | undefined => (typeof raw === "boolean" ? raw : undefined);

/** A record of booleans, e.g. which sections are open. Anything else in storage is ignored. */
export function parseFlags(raw: unknown): Record<string, boolean> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "boolean") out[k] = v;
  return out;
}

/** The same storage seen as a `Storage`, for libraries that persist by themselves; never throws. */
export const safeStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // See `localPref`.
    }
  },
};
