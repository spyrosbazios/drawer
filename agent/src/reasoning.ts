/**
 * Records a provider's thinking as `reasoning` session items: the first text opens the item at once (so
 * its place in the conversation is the moment the model began to think), later text replaces it at most
 * once per interval, and `done` closes it. A replace never moves an item, so a throttled update cannot
 * reorder anything, and none of this waits on the turn: every write is a queued append.
 */
import type { NewSessionItem } from "@drawer/shared/api";

/** What one item keeps: the end of a long thought, behind an ellipsis. */
export const REASONING_CHARS = 4000;

interface Thought {
  startedAt: number;
  text: string;
  /** Whether an item exists yet (the first non-empty text creates it). */
  sent: boolean;
  lastSentAt: number;
  /** The text changed since the last write. */
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function clipReasoning(text: string): string {
  const t = text.trim();
  return t.length <= REASONING_CHARS ? t : `…${t.slice(t.length - REASONING_CHARS + 1)}`;
}

export class ReasoningRecorder {
  private readonly thoughts = new Map<string, Thought>();
  private readonly closed = new Set<string>();

  constructor(
    private readonly append: (item: NewSessionItem) => void,
    private readonly intervalMs: number,
    private readonly now: () => number,
  ) {}

  private write(id: string, t: Thought, done: boolean): void {
    if (t.timer !== null) clearTimeout(t.timer);
    t.timer = null;
    t.sent = true;
    t.dirty = false;
    t.lastSentAt = this.now();
    this.append({ type: "reasoning", reasoningId: id, text: clipReasoning(t.text), status: done ? "done" : "running", seconds: Math.max(0, Math.round((t.lastSentAt - t.startedAt) / 1000)) });
  }

  /** A provider event: `text` is everything so far. */
  update(id: string, text: string, done: boolean): void {
    if (this.closed.has(id)) return;
    let t = this.thoughts.get(id);
    if (t === undefined) {
      t = { startedAt: this.now(), text: "", sent: false, lastSentAt: 0, dirty: false, timer: null };
      this.thoughts.set(id, t);
    }
    t.text = text;
    t.dirty = true;
    const hasText = t.text.trim() !== "";
    if (done) {
      this.closed.add(id);
      this.thoughts.delete(id);
      if (t.timer !== null) clearTimeout(t.timer);
      if (hasText || t.sent) this.write(id, t, true);
      return;
    }
    if (!hasText) return;
    if (!t.sent) {
      this.write(id, t, false);
      return;
    }
    if (t.timer !== null) return;
    const wait = Math.max(0, t.lastSentAt + this.intervalMs - this.now());
    const thought = t;
    t.timer = setTimeout(() => {
      thought.timer = null;
      if (thought.dirty && this.thoughts.get(id) === thought) this.write(id, thought, false);
    }, wait);
  }

  /** The turn is over: close every thought still open (one that never had text writes nothing). */
  finish(): void {
    for (const [id, t] of [...this.thoughts]) this.update(id, t.text, true);
  }
}
