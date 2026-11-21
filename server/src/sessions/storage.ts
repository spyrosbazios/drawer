/**
 * Session files: `<id>.json` holds the state, `<id>.jsonl` the items, one JSON object per line.
 *
 * The items file is append-only. An item that changes later (a tool call finishing, a question being
 * answered) is appended again with the same `seq`; the last line for a `seq` wins when it is read.
 *
 * Which runner holds a session is not stored: a restart fails every turn in progress, so no hold
 * outlives the process.
 */
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session, SessionItem } from "@drawer/shared/api";
import { errorMessage, isNodeError, randomId } from "../util.ts";

/** The `<id>.json` file: the public session plus what only the server needs. */
export interface StoredSession {
  session: Session;
  /** The provider's own session handle, handed back with the next turn. */
  resume: string | null;
  /** The newest user item that went out to a turn; later user items are pending. */
  handedSeq: number;
}

export interface LoadedSession extends StoredSession {
  items: SessionItem[];
}

const STATE_FILE = /^([a-z0-9]+)\.json$/;

function isStored(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const s = v.session as Record<string, unknown> | null | undefined;
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.id === "string" &&
    typeof s.project === "string" &&
    typeof s.status === "string" &&
    typeof v.handedSeq === "number" &&
    (v.resume === null || typeof v.resume === "string")
  );
}

function isItem(value: unknown): value is SessionItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.seq === "number" && typeof v.version === "number" && typeof v.type === "string" && typeof v.at === "string";
}

/**
 * Items in an older shape, brought to the current one as they are read: user items written before attachments
 * existed carry none; questions written before multiple answers were single ones with `answer: string | null`.
 */
function current(item: SessionItem): SessionItem {
  if (item.type === "user" && !Array.isArray(item.attachments)) return { ...item, attachments: [] };
  if (item.type === "question") {
    // The file may hold the old shape whatever the type says.
    const { answer, ...rest } = item as typeof item & { answer?: unknown };
    if (typeof rest.multiple === "boolean") return item;
    return { ...rest, multiple: false, answers: typeof answer === "string" ? [answer] : null };
  }
  return item;
}

export class SessionFiles {
  constructor(readonly dir: string) {}

  private state(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private items(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Every readable session; a damaged file is skipped and reported, not fatal. */
  async loadAll(): Promise<LoadedSession[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw err;
    }
    const loaded: LoadedSession[] = [];
    for (const name of names) {
      const match = STATE_FILE.exec(name);
      if (!match) continue;
      const id = match[1] as string;
      try {
        const stored: unknown = JSON.parse(await readFile(this.state(id), "utf8"));
        if (!isStored(stored) || stored.session.id !== id) throw new Error("not a session file");
        loaded.push({ ...stored, items: await this.readItems(id) });
      } catch (err) {
        console.error(`sessions: skipping ${name}: ${errorMessage(err)}`);
      }
    }
    return loaded;
  }

  private async readItems(id: string): Promise<SessionItem[]> {
    let text: string;
    try {
      text = await readFile(this.items(id), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw err;
    }
    // A crash can leave a last line without its newline; end it so the next append starts a new line.
    if (text !== "" && !text.endsWith("\n")) await appendFile(this.items(id), "\n");
    const bySeq = new Map<number, SessionItem>();
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isItem(parsed)) bySeq.set(parsed.seq, current(parsed));
      } catch {
        // a torn line: nothing more to recover from it
      }
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Atomically: a temp file in the same directory, then a rename over the old one. */
  async writeState(id: string, text: string): Promise<void> {
    const tmp = join(this.dir, `.${id}.${randomId().slice(0, 8)}.tmp`);
    await writeFile(tmp, text);
    await rename(tmp, this.state(id));
  }

  async appendItem(id: string, item: SessionItem): Promise<void> {
    await appendFile(this.items(id), `${JSON.stringify(item)}\n`);
  }

  async remove(id: string): Promise<void> {
    await rm(this.state(id), { force: true });
    await rm(this.items(id), { force: true });
  }
}
