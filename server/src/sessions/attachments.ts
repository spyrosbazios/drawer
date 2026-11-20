/**
 * Attachments: files a person uploads to send with a session message. Each is two files in
 * `DRAWER_DATA/sessions/attachments/`: `<id>.json` (who it belongs to and its descriptor) and `<id>.bin`
 * (the bytes, never changed). An upload belongs to a project until a message names it; from then on
 * to that session and message. Unsent uploads expire; a session's attachments go with the session.
 */
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { posix } from "node:path";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type SessionAttachment } from "@drawer/shared/api";
import { invalid, notFound } from "../errors.ts";
import { kindFromExtension, looksLikeText, mimeFor, TEXT_SNIFF_LIMIT } from "../store/paths.ts";
import { errorMessage, randomId } from "../util.ts";

/** How long an upload that no message named is kept. */
export const UNSENT_TTL_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[a-f0-9]{16}$/;
const META_RE = /^([a-f0-9]{16})\.json$/;
const NAME_MAX_BYTES = 200;

export interface StoredAttachment {
  attachment: SessionAttachment;
  project: string;
  /** The session and the user item that carry it; null while unsent. */
  session: string | null;
  seq: number | null;
  uploadedAt: string;
}

function isStored(value: unknown): value is StoredAttachment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const a = v.attachment as Record<string, unknown> | null | undefined;
  return typeof a === "object" && a !== null && typeof a.id === "string" && typeof v.project === "string" && typeof v.uploadedAt === "string";
}

/** The last path segment of what a client called the file, without control characters, capped. */
export function attachmentName(raw: string): string {
  const base = posix.basename(raw.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  let name = base === "" || base === "." || base === ".." ? "attachment" : base;
  while (Buffer.byteLength(name) > NAME_MAX_BYTES) name = name.slice(0, -1);
  return name;
}

export class Attachments {
  private readonly byId = new Map<string, StoredAttachment>();

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) {
      const match = META_RE.exec(name);
      if (!match) continue;
      try {
        const stored: unknown = JSON.parse(await readFile(this.meta(match[1] as string), "utf8"));
        if (!isStored(stored) || stored.attachment.id !== match[1]) throw new Error("not an attachment file");
        this.byId.set(stored.attachment.id, stored);
      } catch (err) {
        console.error(`attachments: skipping ${name}: ${errorMessage(err)}`);
      }
    }
  }

  private meta(id: string): string {
    return `${this.dir}/${id}.json`;
  }

  /** Where the bytes are. */
  data(id: string): string {
    return `${this.dir}/${id}.bin`;
  }

  get(id: string): StoredAttachment {
    const stored = ID_RE.test(id) ? this.byId.get(id) : undefined;
    if (stored === undefined) throw notFound(`no such attachment: ${id}`);
    return stored;
  }

  all(): StoredAttachment[] {
    return [...this.byId.values()];
  }

  async upload(project: string, rawName: string, bytes: Uint8Array): Promise<SessionAttachment> {
    if (bytes.length === 0) throw invalid("the attachment is empty");
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw invalid(`an attachment may be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
    const name = attachmentName(rawName);
    let id = randomId().slice(0, 16);
    while (this.byId.has(id)) id = randomId().slice(0, 16);
    const kind = kindFromExtension(name) ?? (bytes.length <= TEXT_SNIFF_LIMIT && looksLikeText(bytes) ? "text" : "binary");
    const attachment: SessionAttachment = {
      id,
      name,
      mediaType: mimeFor(name, kind),
      size: bytes.length,
      kind,
      url: `/api/attachments/${id}`,
      filedAs: null,
    };
    const stored: StoredAttachment = { attachment, project, session: null, seq: null, uploadedAt: new Date().toISOString() };
    this.byId.set(id, stored);
    try {
      await Bun.write(this.data(id), bytes);
      await this.write(stored);
    } catch (err) {
      await this.removeWhere((s) => s === stored);
      throw err;
    }
    return { ...attachment };
  }

  /**
   * Checks that every id is an unsent upload of `project` and marks them taken by `session`, all at
   * once and synchronously, so two messages cannot both take one upload. `bind` records the item.
   */
  take(ids: string[], project: string, session: string): StoredAttachment[] {
    if (ids.length > MAX_ATTACHMENTS) throw invalid(`a message may carry at most ${MAX_ATTACHMENTS} attachments`);
    if (new Set(ids).size !== ids.length) throw invalid("attachments lists an id twice");
    const taken = ids.map((id) => {
      const stored = ID_RE.test(id) ? this.byId.get(id) : undefined;
      if (stored === undefined) throw invalid(`no such attachment: ${id}`);
      if (stored.project !== project) throw invalid(`attachment ${id} was uploaded to another project`);
      if (stored.session !== null) throw invalid(`attachment ${id} was already sent`);
      return stored;
    });
    for (const stored of taken) stored.session = session;
    return taken;
  }

  /** Records the item that carries taken attachments; `persist` writes that down. */
  bind(taken: StoredAttachment[], seq: number): void {
    for (const stored of taken) stored.seq = seq;
  }

  async persist(taken: StoredAttachment[]): Promise<void> {
    for (const stored of taken) await this.write(stored);
  }

  async markFiled(stored: StoredAttachment, path: string): Promise<SessionAttachment> {
    stored.attachment = { ...stored.attachment, filedAs: path };
    await this.write(stored);
    return { ...stored.attachment };
  }

  async removeWhere(match: (s: StoredAttachment) => boolean): Promise<void> {
    for (const stored of [...this.byId.values()]) {
      if (!match(stored)) continue;
      const id = stored.attachment.id;
      this.byId.delete(id);
      await rm(this.meta(id), { force: true });
      await rm(this.data(id), { force: true });
    }
  }

  /** Unsent uploads older than the TTL, and anything whose session is gone. */
  sweep(sessionExists: (id: string) => boolean, now = Date.now()): Promise<void> {
    return this.removeWhere((s) => (s.session === null ? now - Date.parse(s.uploadedAt) > UNSENT_TTL_MS : !sessionExists(s.session)));
  }

  /** Writes the meta file, unless the attachment was removed meanwhile (Bun.write would bring it back). */
  private async write(stored: StoredAttachment): Promise<void> {
    if (this.byId.get(stored.attachment.id) !== stored) return;
    await Bun.write(this.meta(stored.attachment.id), `${JSON.stringify(stored, null, 2)}\n`);
  }
}
