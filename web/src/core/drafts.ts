/**
 * Unsaved editor text, kept outside React so closing a tab or navigating between files never loses it.
 * A draft remembers the text and rev it was started from: that is how "changed elsewhere" is detected.
 */
export interface Draft {
  text: string;
  baseText: string;
  baseRev: string;
}

type Listener = () => void;

export class DraftStore {
  private drafts = new Map<string, Draft>();
  private listeners = new Set<Listener>();
  /** Bumped on every change so a React snapshot can be a plain number. */
  private version = 0;

  static key(project: string, path: string): string {
    return `${project}\u0000${path}`;
  }

  get = (key: string): Draft | undefined => this.drafts.get(key);

  /** Records an edit. Typing the text back to the base removes the draft. */
  edit(key: string, text: string, base: { text: string; rev: string }): void {
    const prev = this.drafts.get(key);
    const baseText = prev?.baseText ?? base.text;
    const baseRev = prev?.baseRev ?? base.rev;
    if (text === baseText) this.drafts.delete(key);
    else this.drafts.set(key, { text, baseText, baseRev });
    this.emit();
  }

  /** Re-bases a draft on newer content, keeping the user's text ("keep mine" after a remote change). */
  rebase(key: string, base: { text: string; rev: string }): void {
    const prev = this.drafts.get(key);
    if (!prev) return;
    if (prev.text === base.text) this.drafts.delete(key);
    else this.drafts.set(key, { text: prev.text, baseText: base.text, baseRev: base.rev });
    this.emit();
  }

  clear(key: string): void {
    if (this.drafts.delete(key)) this.emit();
  }

  /** Drops the drafts of a deleted file, or of every file under a deleted folder. */
  clearUnder(project: string, path: string): void {
    let changed = false;
    for (const k of [...this.drafts.keys()]) {
      const [p, file = ""] = k.split("\u0000");
      if (p === project && (file === path || file.startsWith(`${path}/`))) {
        this.drafts.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Repoints drafts when a file or folder moves. */
  rename(project: string, remap: (path: string) => string): void {
    const next = new Map<string, Draft>();
    for (const [k, d] of this.drafts) {
      const [p, path = ""] = k.split("\u0000");
      next.set(p === project ? DraftStore.key(project, remap(path)) : k, d);
    }
    this.drafts = next;
    this.emit();
  }

  isDirty = (key: string): boolean => this.drafts.has(key);

  dirtyPaths(project: string): string[] {
    const prefix = `${project}\u0000`;
    return [...this.drafts.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  get size(): number {
    return this.drafts.size;
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  snapshot = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}
