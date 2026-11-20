/**
 * @drawer/importers: one module per site plus a generic page scraper, behind the `Importers`
 * contract from @drawer/shared. Secrets arrive in `creds` and are only ever sent to their own site.
 */
import type { ImportFile, ImportPreview, ImportSite } from "@drawer/shared/api";
import { ImportError, type ImportCredentials, type Importers } from "@drawer/shared/contracts";
import { detectSite } from "./detect";
import { MAX_IMAGE_BYTES, createHttp, type HttpEnv } from "./http";
import { createCults3d } from "./sites/cults3d";
import { createGeneric } from "./sites/generic";
import { createMakerWorld } from "./sites/makerworld";
import { createMyMiniFactory } from "./sites/myminifactory";
import { createPrintables } from "./sites/printables";
import { createThingiverse } from "./sites/thingiverse";
import type { SiteContext, SiteModule } from "./sites/context";

export { detectSite } from "./detect";
export { htmlToMarkdown } from "./markdown";
export type { HttpEnv } from "./http";

function requireHttpUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ImportError("That is not a valid web address");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ImportError("Only http and https addresses can be imported");
}

/** `env` exists for tests (a stand-in `fetch`, no real waiting between retries); production passes nothing. */
export function createImporters(creds: ImportCredentials, env: HttpEnv = {}): Importers {
  const ctx: SiteContext = { http: createHttp(env), creds };
  const modules: Record<ImportSite, SiteModule> = {
    printables: createPrintables(ctx),
    thingiverse: createThingiverse(ctx),
    makerworld: createMakerWorld(ctx),
    cults3d: createCults3d(ctx),
    myminifactory: createMyMiniFactory(ctx),
    generic: createGeneric(ctx),
  };

  return {
    detect: detectSite,
    async preview(url: string): Promise<ImportPreview> {
      requireHttpUrl(url);
      return modules[detectSite(url)].preview(url.trim());
    },
    async download(url: string, file: ImportFile, destPath: string): Promise<void> {
      requireHttpUrl(url);
      await modules[detectSite(url)].download(url.trim(), file, destPath);
    },
    async downloadImage(imageUrl: string, destPath: string): Promise<void> {
      requireHttpUrl(imageUrl);
      await ctx.http.download(imageUrl.trim(), { label: "Image host", maxBytes: MAX_IMAGE_BYTES, kind: "image" }, destPath);
    },
  };
}
