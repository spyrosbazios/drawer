/** Serialises async work: each run starts after the previous one settled. */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** `rev` of a file: first 16 hex chars of the SHA-256 of its bytes. */
export function revOfBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
}

export async function revOfFile(absPath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(absPath).stream()) hasher.update(chunk);
  return hasher.digest("hex").slice(0, 16);
}

/** ISO 8601 in UTC, whole seconds (what git stores), so index and history agree. */
export function isoSeconds(date: Date = new Date()): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
}

export function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isNodeError(err: unknown, ...codes: string[]): boolean {
  return err instanceof Error && "code" in err && codes.includes(String((err as { code: unknown }).code));
}
