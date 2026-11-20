/** The local render cache: server PNGs downloaded once per content-hash key, shown to the agent as file paths. */
import { rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RenderView } from "@drawer/shared/api";
import type { Client } from "./client.ts";
import { CliError } from "./command.ts";
import { type Env, rendersDir } from "./config.ts";

export const VIEWS: readonly RenderView[] = ["iso", "front", "top", "side"];

/** Server URL paths of a render's PNGs: the shape RenderResult and RenderRef share. */
export interface PictureUrls {
  sheet: string;
  views: Partial<Record<RenderView, string>>;
}

/** Absolute local paths of the same PNGs. */
export interface Pictures {
  sheet: string;
  views: Partial<Record<RenderView, string>>;
}

/** Download /api/renders/<key>/<file> into <cache>/<key>/<file>; a file already there is kept (the key is a content hash). */
async function fetchRender(client: Client, urlPath: string, root: string): Promise<string> {
  const match = /\/renders\/([^/?#]+)\/([^/?#]+)(?:[?#].*)?$/.exec(urlPath);
  const key = match?.[1] ? decodeURIComponent(match[1]) : "";
  const name = match?.[2] ? decodeURIComponent(match[2]) : "";
  if (!key || !name || key === ".." || name === ".." || key.includes("/") || name.includes("/")) {
    throw new CliError(`server returned an unexpected render path: ${urlPath}`);
  }
  const dest = join(root, key, name);
  if (await Bun.file(dest).exists()) return dest;
  const bytes = await client.download(urlPath);
  const tmp = `${dest}.${process.pid}.tmp`;
  await Bun.write(tmp, bytes);
  await rename(tmp, dest);
  return dest;
}

/** One server image (a section, a sheet) into the cache; returns its local path. */
export function fetchPicture(client: Client, env: Env, urlPath: string): Promise<string> {
  return fetchRender(client, urlPath, resolve(rendersDir(env)));
}

/** A render's contact sheet and every view it has. */
export async function fetchPictures(client: Client, env: Env, urls: PictureUrls): Promise<Pictures> {
  const root = resolve(rendersDir(env));
  const sheet = await fetchRender(client, urls.sheet, root);
  const views: Partial<Record<RenderView, string>> = {};
  for (const view of VIEWS) {
    const urlPath = urls.views[view];
    if (urlPath) views[view] = await fetchRender(client, urlPath, root);
  }
  return { sheet, views };
}

/** `sheet  <path>` then one line per view, in the order of VIEWS. */
export function pictureLines(pictures: Pictures): string[] {
  const lines = [`${"sheet".padEnd(5)}  ${pictures.sheet}`];
  for (const view of VIEWS) {
    const path = pictures.views[view];
    if (path) lines.push(`${view.padEnd(5)}  ${path}`);
  }
  return lines;
}
