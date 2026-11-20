/**
 * Turns a provider's thinking stream into `reasoning` events. Each thought has a key the provider owns
 * (a block index, an item id) and a prefix picked per turn, so ids never collide with an earlier turn's
 * in the same session (a later append of the same id replaces the item).
 */
import type { ProviderEvent } from "../provider.ts";

export class Thoughts {
  private readonly open = new Map<string, string>();
  private readonly prefix = crypto.randomUUID().slice(0, 8);

  constructor(private readonly emit: (event: ProviderEvent) => void) {}

  private send(key: string, text: string, done: boolean): void {
    this.emit({ type: "reasoning", id: `${this.prefix}-${key}`, text, done });
  }

  /** More text for a thought; the first call opens it. */
  append(key: string, chunk: string): void {
    if (chunk === "") return;
    const text = (this.open.get(key) ?? "") + chunk;
    this.open.set(key, text);
    this.send(key, text, false);
  }

  /** Replaces what a thought says so far (a provider that sends the whole text each time). */
  set(key: string, text: string): void {
    this.open.set(key, text);
    this.send(key, text, false);
  }

  /** Closes a thought. `text` replaces what was streamed when the provider has the authoritative text. */
  end(key: string, text?: string): void {
    const final = text ?? this.open.get(key);
    this.open.delete(key);
    if (final !== undefined) this.send(key, final, true);
  }

  has(key: string): boolean {
    return this.open.has(key);
  }

  /** Closes every thought still open. */
  endAll(): void {
    for (const key of [...this.open.keys()]) this.end(key);
  }
}
