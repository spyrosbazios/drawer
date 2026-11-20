/**
 * MakerWorld through Bambu Lab's own API (api.bambulab.com), never the website, which sits
 * behind a Cloudflare challenge.
 *  - Metadata: GET /v1/design-service/design/{id}, anonymous (verified live).
 *  - Files: GET /v1/iot-service/api/user/profile/{profileId}?model_id={modelId} with the Bambu
 *    user token as Bearer; the answer carries a short-lived signed `url` for the 3MF.
 *    Documented by github.com/Pr0zak/YASTL pull 51 and github.com/maziggy/bambuddy pull 1099;
 *    not verifiable here without a token.
 */
import type { ImportFile, ImportPreview } from "@drawer/shared/api";
import { ImportError } from "@drawer/shared/contracts";
import { MAX_FILE_BYTES } from "../http";
import { toMarkdown } from "../markdown";
import { parseModelUrl } from "../detect";
import { safeFileName, toNumberOrNull, uniqueStrings, type SiteContext, type SiteModule } from "./context";

const API = "https://api.bambulab.com/v1";
export const MAKERWORLD_BLOCKER = "MakerWorld needs a Bambu account token to download files (MAKERWORLD_TOKEN)";

interface Picture {
  url?: string | null;
}

interface Design {
  id: number;
  title: string;
  slug?: string;
  summary?: string | null;
  coverUrl?: string | null;
  license?: string | null;
  modelId?: string | null;
  designCreator?: { name?: string | null; handle?: string | null } | null;
  designExtension?: { design_pictures?: Picture[] | null; real_pictures?: Picture[] | null } | null;
  instances?: Instance[] | null;
}

interface Instance {
  id: number;
  profileId?: number | null;
  title?: string | null;
  // The API spells it "extention".
  extention?: { modelInfo?: { f3mf?: { size?: number | null } | null } | null } | null;
}

interface ProfileDownload {
  url?: string;
}

/** Hosts a signed download URL may point at: Bambu's own CDN and the S3 buckets behind it. */
function isAllowedDownloadHost(host: string): boolean {
  return ["bblmw.com", "bambulab.com", "amazonaws.com"].some((d) => host === d || host.endsWith(`.${d}`));
}

/** ImportFile ids are "<profileId>:<modelId>"; the download endpoint needs both. */
function fileId(profileId: number, modelId: string): string {
  return `${profileId}:${modelId}`;
}

export function createMakerWorld(ctx: SiteContext): SiteModule {
  const token = ctx.creds.makerworldToken;

  async function design(id: string): Promise<Design> {
    try {
      return await ctx.http.json<Design>(`${API}/design-service/design/${id}`, { label: "MakerWorld" });
    } catch (err) {
      if (err instanceof ImportError && err.message.endsWith("HTTP 404")) throw new ImportError("MakerWorld has no such model");
      throw err;
    }
  }

  function modelId(url: string): string {
    const ref = parseModelUrl(url);
    if (ref?.site !== "makerworld") throw new ImportError("Not a MakerWorld model URL");
    return ref.id;
  }

  async function preview(url: string): Promise<ImportPreview> {
    const d = await design(modelId(url));
    const instances = (d.instances ?? []).filter((i) => typeof i.profileId === "number");
    const names = new Set<string>();
    const files: ImportFile[] = [];
    for (const inst of instances) {
      const profileId = inst.profileId as number;
      let name = safeFileName(inst.title ?? "", `profile-${profileId}`);
      if (names.has(name.toLowerCase())) name = `${name}-${profileId}`;
      names.add(name.toLowerCase());
      files.push({
        id: fileId(profileId, d.modelId ?? ""),
        name: `${name}.3mf`,
        size: toNumberOrNull(inst.extention?.modelInfo?.f3mf?.size),
        downloadable: Boolean(token && d.modelId),
      });
    }
    const pictures = [...(d.designExtension?.design_pictures ?? []), ...(d.designExtension?.real_pictures ?? [])];
    return {
      source: {
        site: "makerworld",
        url,
        title: d.title.trim(),
        author: d.designCreator?.name ?? d.designCreator?.handle ?? null,
        license: d.license ?? null,
        description: toMarkdown(d.summary),
        images: uniqueStrings([d.coverUrl, ...pictures.map((p) => p.url)]),
      },
      files,
      blocker: token ? null : MAKERWORLD_BLOCKER,
    };
  }

  async function download(url: string, file: ImportFile, destPath: string): Promise<void> {
    modelId(url);
    if (!token) throw new ImportError(MAKERWORLD_BLOCKER);
    const [profileId, model] = file.id.split(":");
    if (!profileId || !/^\d+$/.test(profileId) || !model) throw new ImportError("Unknown MakerWorld file id");

    let signed: ProfileDownload;
    try {
      signed = await ctx.http.json<ProfileDownload>(
        `${API}/iot-service/api/user/profile/${profileId}?model_id=${encodeURIComponent(model)}`,
        { label: "MakerWorld", headers: { authorization: `Bearer ${token}` } },
      );
    } catch (err) {
      if (err instanceof ImportError && /HTTP (401|403)$/.test(err.message)) {
        throw new ImportError("MakerWorld refused the token (expired or not allowed to download this model)");
      }
      throw err;
    }
    if (!signed.url) throw new ImportError("MakerWorld did not return a download link");
    let target: URL;
    try {
      target = new URL(signed.url);
    } catch {
      throw new ImportError("MakerWorld returned an invalid download link");
    }
    if (target.protocol !== "https:" || !isAllowedDownloadHost(target.hostname.toLowerCase())) {
      throw new ImportError("MakerWorld returned a download link on an unexpected host");
    }
    // The signed query string is the credential and must reach the CDN byte for byte; no bearer goes along.
    await ctx.http.download(signed.url, { label: "MakerWorld file server", maxBytes: MAX_FILE_BYTES, kind: "file" }, destPath);
  }

  return { preview, download };
}
