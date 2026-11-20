/**
 * Project thumbnails: a small PNG of the cover, addressed by a key over what the picture is made of (the
 * file, every file it uses, the renderer's version). The key changes only when the picture can, so the URL
 * is served immutable, and a project change that does not touch the cover keeps it.
 *
 * A thumbnail is rendered once, on its first request, and kept in `cache/thumbnails/` (derived data). A
 * candidate that does not render is remembered as `<key>.fail` and skipped, so the next candidate takes
 * its place and nothing retries OpenSCAD on every page load.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiException, notFound } from "./errors.ts";
import { randomId } from "./util.ts";

const RECIPE = "thumbnail-1";
const KEY_RE = /^[0-9a-f]{32}$/;

export interface ThumbnailDeps {
  dir: string;
  /** What a render of the file is made of (see PartsService.fileInputKey). */
  inputKey(slug: string, path: string): string;
  /** Renders the file and returns the absolute path of its downscaled iso view. Throws `render_failed`. */
  render(slug: string, path: string): Promise<string>;
  /** A candidate turned out not to render: the project's thumbnail moved on to the next one. */
  gaveUp(slug: string): void;
}

export class Thumbnails {
  private readonly running = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly deps: ThumbnailDeps) {}

  private keyOf(slug: string, path: string): string {
    return createHash("sha256").update([RECIPE, slug, path, this.deps.inputKey(slug, path)].join("\0")).digest("hex").slice(0, 32);
  }

  private file(key: string, ext: "png" | "fail"): string {
    return join(this.deps.dir, `${key}.${ext}`);
  }

  /** The first candidate not known to fail, with its key; null when there is none. */
  private pick(slug: string, candidates: string[]): { path: string; key: string } | null {
    for (const path of candidates) {
      const key = this.keyOf(slug, path);
      if (!existsSync(this.file(key, "fail"))) return { path, key };
    }
    return null;
  }

  /** The thumbnail's URL for these cover candidates (best first), or null when nothing can be drawn. */
  url(slug: string, candidates: string[]): string | null {
    const pick = this.pick(slug, candidates);
    return pick && `/api/projects/${encodeURIComponent(slug)}/thumbnail/${pick.key}.png`;
  }

  /** The PNG for `key`: from the cache, or rendered now when it is the project's current thumbnail. */
  async read(slug: string, key: string, candidates: string[]): Promise<Uint8Array> {
    if (!KEY_RE.test(key)) throw notFound("no such thumbnail");
    const cached = await readFile(this.file(key, "png")).catch(() => null);
    if (cached) return new Uint8Array(cached);
    const pick = this.pick(slug, candidates);
    if (pick?.key !== key) throw notFound("this thumbnail is out of date: read the project again for the current one");
    let job = this.running.get(key);
    if (!job) {
      job = this.make(slug, pick.path, key).finally(() => this.running.delete(key));
      this.running.set(key, job);
    }
    return job;
  }

  private async make(slug: string, path: string, key: string): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(await this.deps.render(slug, path)));
    } catch (err) {
      if (!(err instanceof ApiException && err.code === "render_failed")) throw err;
      await this.writeAtomic(this.file(key, "fail"), `${path}\n${err.message}\n`);
      this.deps.gaveUp(slug);
      throw notFound(`${path} does not render, so it has no thumbnail`);
    }
    await this.writeAtomic(this.file(key, "png"), bytes);
    return bytes;
  }

  private async writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
    const tmp = `${path}.${randomId()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  }
}
