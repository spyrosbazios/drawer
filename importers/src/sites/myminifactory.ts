/**
 * MyMiniFactory: API v2 with the `key` query parameter (OpenAPI description:
 * github.com/MyMiniFactory/api-documentation). A key reads metadata, images and file names;
 * file downloads need an OAuth user, so every file is listed as not downloadable. The key
 * travels in the URL, so no message built here ever includes a URL.
 */
import type { ImportFile, ImportPreview } from "@drawer/shared/api";
import { ImportError } from "@drawer/shared/contracts";
import { toMarkdown } from "../markdown";
import { parseModelUrl } from "../detect";
import { safeFileName, toNumberOrNull, uniqueStrings, type SiteContext, type SiteModule } from "./context";
import { fallbackPreview } from "./generic";

const API = "https://www.myminifactory.com/api/v2";
export const MMF_BLOCKER_NO_KEY = "MyMiniFactory needs an API key (MYMINIFACTORY_KEY)";
export const MMF_BLOCKER_NO_FILES = "MyMiniFactory only hands out files to logged-in users; download them from the site by hand and upload them here";

interface Img {
  original?: { url?: string | null } | null;
  large?: { url?: string | null } | null;
  standard?: { url?: string | null } | null;
  is_primary?: boolean;
}

interface MmfFile {
  id: number;
  filename: string;
  size?: string | number | null;
}

interface MmfObject {
  id: number;
  name: string;
  description?: string | null;
  description_html?: string | null;
  printing_details_html?: string | null;
  designer?: { username?: string | null; name?: string | null } | null;
  images?: Img[] | null;
  files?: { items?: MmfFile[] | null } | MmfFile[] | null;
  license?: string | null;
}

interface FileList {
  items?: MmfFile[] | null;
}

function imgUrl(i: Img): string | null {
  return i.original?.url ?? i.large?.url ?? i.standard?.url ?? null;
}

export function createMyMiniFactory(ctx: SiteContext): SiteModule {
  const key = ctx.creds.myminifactoryKey;

  async function api<T>(path: string): Promise<T> {
    try {
      return await ctx.http.json<T>(`${API}${path}?key=${encodeURIComponent(key ?? "")}`, { label: "MyMiniFactory", sameOrigin: true });
    } catch (err) {
      if (err instanceof ImportError) {
        if (err.message.endsWith("HTTP 404")) throw new ImportError("MyMiniFactory has no such object");
        if (/HTTP (401|403)$/.test(err.message)) throw new ImportError("MyMiniFactory rejected the API key");
      }
      throw err;
    }
  }

  async function preview(url: string): Promise<ImportPreview> {
    const ref = parseModelUrl(url);
    if (ref?.site !== "myminifactory") throw new ImportError("Not a MyMiniFactory object URL");
    if (!key) return fallbackPreview(ctx, url, "myminifactory", MMF_BLOCKER_NO_KEY);

    const obj = await api<MmfObject>(`/objects/${ref.id}`);
    let rawFiles: MmfFile[] | undefined;
    if (Array.isArray(obj.files)) rawFiles = obj.files;
    else if (obj.files?.items) rawFiles = obj.files.items;
    if (!rawFiles) rawFiles = (await api<FileList>(`/objects/${ref.id}/files`)).items ?? [];

    const files: ImportFile[] = rawFiles.map((f) => ({
      id: String(f.id),
      name: safeFileName(f.filename, `file-${f.id}`),
      size: toNumberOrNull(f.size),
      downloadable: false,
    }));
    const images = [...(obj.images ?? [])].sort((a, b) => Number(b.is_primary ?? false) - Number(a.is_primary ?? false));
    const description = [toMarkdown(obj.description_html ?? obj.description), toMarkdown(obj.printing_details_html) && `## Printing details\n\n${toMarkdown(obj.printing_details_html)}`]
      .filter(Boolean)
      .join("\n\n");
    return {
      source: {
        site: "myminifactory",
        url,
        title: obj.name.trim(),
        author: obj.designer?.name ?? obj.designer?.username ?? null,
        license: obj.license ?? null,
        description,
        images: uniqueStrings(images.map(imgUrl)),
      },
      files,
      blocker: MMF_BLOCKER_NO_FILES,
    };
  }

  return {
    preview,
    download: async () => {
      throw new ImportError(MMF_BLOCKER_NO_FILES);
    },
  };
}
