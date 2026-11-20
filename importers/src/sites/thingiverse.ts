/**
 * Thingiverse: the official REST API, Bearer token. Shapes follow the public API docs
 * (www.thingiverse.com/developers/rest-api-reference) and open-source clients; not
 * verifiable live without a token, and the website is behind Cloudflare.
 */
import type { ImportFile, ImportPreview } from "@drawer/shared/api";
import { ImportError } from "@drawer/shared/contracts";
import { MAX_FILE_BYTES } from "../http";
import { toMarkdown } from "../markdown";
import { parseModelUrl } from "../detect";
import { safeFileName, toNumberOrNull, uniqueStrings, type SiteContext, type SiteModule } from "./context";
import { fallbackPreview } from "./generic";

const API = "https://api.thingiverse.com";
export const THINGIVERSE_BLOCKER = "Thingiverse needs an API token (THINGIVERSE_TOKEN)";

interface ThingImage {
  url?: string | null;
  sizes?: Array<{ type?: string; size?: string; url?: string }> | null;
}

interface Thing {
  id: number;
  name: string;
  description?: string | null;
  description_html?: string | null;
  details?: string | null;
  instructions?: string | null;
  instructions_html?: string | null;
  license?: string | null;
  creator?: { name?: string | null; first_name?: string | null } | null;
  default_image?: ThingImage | null;
}

interface ThingFile {
  id: number;
  name: string;
  size?: number | null;
}

/** The biggest still-image URL Thingiverse offers for one image. */
function imageUrl(img: ThingImage): string | null {
  const sizes = img.sizes ?? [];
  const pick =
    sizes.find((s) => s.type === "display" && s.size === "large") ??
    sizes.find((s) => s.type === "display") ??
    sizes.find((s) => s.type === "preview" && s.size === "large") ??
    sizes.find((s) => s.type === "preview");
  return pick?.url ?? img.url ?? null;
}

export function createThingiverse(ctx: SiteContext): SiteModule {
  const token = ctx.creds.thingiverseToken;

  function thingId(url: string): string {
    const ref = parseModelUrl(url);
    if (ref?.site !== "thingiverse") throw new ImportError("Not a Thingiverse thing URL");
    return ref.id;
  }

  async function api<T>(path: string): Promise<T> {
    try {
      return await ctx.http.json<T>(`${API}${path}`, { label: "Thingiverse", headers: { authorization: `Bearer ${token}` } });
    } catch (err) {
      if (err instanceof ImportError) {
        if (err.message.endsWith("HTTP 404")) throw new ImportError("Thingiverse has no such thing");
        if (/HTTP (401|403)$/.test(err.message)) throw new ImportError("Thingiverse rejected the API token");
      }
      throw err;
    }
  }

  async function preview(url: string): Promise<ImportPreview> {
    const id = thingId(url);
    if (!token) return fallbackPreview(ctx, url, "thingiverse", THINGIVERSE_BLOCKER);

    const [thing, files, images] = await Promise.all([
      api<Thing>(`/things/${id}`),
      api<ThingFile[]>(`/things/${id}/files`),
      api<ThingImage[]>(`/things/${id}/images`),
    ]);

    const summary = toMarkdown(thing.description_html ?? thing.description);
    const details = toMarkdown(thing.details);
    const instructions = toMarkdown(thing.instructions_html ?? thing.instructions);
    const description = [
      summary,
      details && details !== summary ? details : "",
      instructions ? `## Print settings\n\n${instructions}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const importFiles: ImportFile[] = (Array.isArray(files) ? files : []).map((f) => ({
      id: String(f.id),
      name: safeFileName(f.name, `file-${f.id}`),
      size: toNumberOrNull(f.size),
      downloadable: true,
    }));

    return {
      source: {
        site: "thingiverse",
        url,
        title: thing.name.trim(),
        author: thing.creator?.name ?? null,
        license: thing.license ?? null,
        description,
        images: uniqueStrings([
          ...(Array.isArray(images) ? images : []).map(imageUrl),
          thing.default_image ? imageUrl(thing.default_image) : null,
        ]),
      },
      files: importFiles,
      blocker: null,
    };
  }

  async function download(url: string, file: ImportFile, destPath: string): Promise<void> {
    thingId(url);
    if (!token) throw new ImportError(THINGIVERSE_BLOCKER);
    if (!/^\d+$/.test(file.id)) throw new ImportError("Unknown Thingiverse file id");
    // The API answers with a redirect to the CDN; the http layer drops the bearer on that hop.
    await ctx.http.download(
      `${API}/files/${file.id}/download`,
      { label: "Thingiverse", headers: { authorization: `Bearer ${token}` }, maxBytes: MAX_FILE_BYTES, kind: "file" },
      destPath,
    );
  }

  return { preview, download };
}
