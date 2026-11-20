import type { ImportPreview, ImportSite } from "@drawer/shared/api";
import { ImportError } from "@drawer/shared/contracts";
import { toMarkdown } from "../markdown";
import { emptyPreview, uniqueStrings, type SiteContext, type SiteModule } from "./context";

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** The site answered a plain request with a bot challenge or login wall. */
export class BotChallengeError extends ImportError {
  override name = "BotChallengeError";
}

interface PageMeta {
  title: string;
  ogTitle: string;
  description: string;
  images: string[];
  author: string;
  license: string;
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel();
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function extractMeta(html: string, pageUrl: string): Promise<PageMeta> {
  const meta: PageMeta = { title: "", ogTitle: "", description: "", images: [], author: "", license: "" };
  const named = new Map<string, string>();
  const images: string[] = [];
  let title = "";

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        title += chunk.text;
      },
    })
    .on("meta", {
      element(el) {
        const content = el.getAttribute("content");
        const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? el.getAttribute("itemprop"))?.toLowerCase();
        if (!key || !content) return;
        if (key === "og:image" || key === "og:image:url" || key === "og:image:secure_url" || key === "twitter:image") images.push(content);
        else if (!named.has(key)) named.set(key, content);
      },
    })
    .on("link[rel~=license]", {
      element(el) {
        const href = el.getAttribute("href");
        if (href && !named.has("link:license")) named.set("link:license", href);
      },
    });
  await rewriter.transform(new Response(html)).text();

  meta.title = decodeEntities(title).replace(/\s+/g, " ").trim();
  meta.ogTitle = (named.get("og:title") ?? named.get("twitter:title") ?? "").trim();
  meta.description = (named.get("og:description") ?? named.get("description") ?? named.get("twitter:description") ?? "").trim();
  meta.author = (named.get("author") ?? named.get("article:author") ?? named.get("dc.creator") ?? "").trim();
  meta.license = (named.get("license") ?? named.get("dc.rights") ?? named.get("link:license") ?? "").trim();
  meta.images = uniqueStrings(images.map((src) => resolveUrl(src, pageUrl)));
  return meta;
}

function resolveUrl(src: string, base: string): string | null {
  try {
    const u = new URL(src, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A readable title from the URL alone, for when nothing else is known. */
export function titleFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const slug = decodeURIComponent(last).replace(/^3d-print-/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    return slug || u.hostname;
  } catch {
    return raw;
  }
}

/**
 * Fetch a page and read its metadata. `site` labels the result. Never throws for a normal HTML
 * page; a bot challenge, a missing page or an unreachable host throws ImportError.
 */
export async function scrapePage(ctx: SiteContext, url: string, site: ImportSite = "generic"): Promise<ImportPreview> {
  const host = new URL(url).hostname;
  const res = await ctx.http.request(url, {
    label: host,
    headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
  });
  if (res.status === 403 || res.status === 503 || res.status === 401) {
    await res.body?.cancel();
    throw new BotChallengeError(`${host} answered with a bot challenge or login wall (HTTP ${res.status}); the page cannot be read automatically`);
  }
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel();
    throw new ImportError(`${host} has no such page (HTTP ${res.status})`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ImportError(`${host} answered HTTP ${res.status}`);
  }
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type && !type.includes("html") && !type.includes("xml") && !type.startsWith("text/")) {
    await res.body?.cancel();
    return emptyPreview(site, url, titleFromUrl(url), null);
  }
  const html = await readLimited(res, MAX_PAGE_BYTES);
  const meta = await extractMeta(html, res.url || url);
  const title = decodeEntities(meta.ogTitle) || meta.title || titleFromUrl(url);
  return {
    source: {
      site,
      url,
      title,
      author: meta.author ? decodeEntities(meta.author) : null,
      license: meta.license ? decodeEntities(meta.license) : null,
      description: toMarkdown(decodeEntities(meta.description)),
      images: meta.images,
    },
    files: [],
    blocker: null,
  };
}

/**
 * Metadata for a known site whose credential is missing: the page scraper's answer, labelled
 * with the real site and carrying the blocker. When the page is itself unreadable (bot
 * challenge), the preview is a bare title from the URL, because a missing credential never throws. Other failures
 * (no such page, host unreachable) still throw.
 */
export async function fallbackPreview(ctx: SiteContext, url: string, site: ImportSite, blocker: string): Promise<ImportPreview> {
  try {
    const page = await scrapePage(ctx, url, site);
    return { ...page, blocker };
  } catch (err) {
    if (!(err instanceof BotChallengeError)) throw err;
    return emptyPreview(site, url, titleFromUrl(url), blocker);
  }
}

export function createGeneric(ctx: SiteContext): SiteModule {
  return {
    preview: (url) => scrapePage(ctx, url),
    download: async () => {
      throw new ImportError("This site has no files to download; only the page details can be imported");
    },
  };
}
