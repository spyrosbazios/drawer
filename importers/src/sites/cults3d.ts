/**
 * Cults3D: the official GraphQL API (https://cults3d.com/graphql), HTTP Basic with the account
 * nickname and an API key. Query fields follow Cults' published example queries
 * (gist.github.com/sunny/07db54478ac030bd277c19cfe734648b). Files are never offered: the site
 * hands them out only to buyers through the browser. Not verifiable live without credentials.
 */
import type { ImportPreview } from "@drawer/shared/api";
import { ImportError } from "@drawer/shared/contracts";
import { toMarkdown } from "../markdown";
import { parseModelUrl } from "../detect";
import { uniqueStrings, type SiteContext, type SiteModule } from "./context";
import { fallbackPreview } from "./generic";

const GRAPHQL_URL = "https://cults3d.com/graphql";
export const CULTS3D_BLOCKER_NO_CREDS = "Cults3D needs API credentials (CULTS3D_USER, CULTS3D_KEY)";
export const CULTS3D_BLOCKER_NO_FILES = "Cults3D does not hand out files; download them from the site by hand and upload them here";

const CREATION_QUERY = `
query DrawerCreation($slug: String!) {
  creation(slug: $slug) {
    name(locale: EN)
    description(locale: EN)
    shortUrl
    illustrationImageUrl
    illustrations { imageUrl }
    license { name(locale: EN) }
    creator { nick }
  }
}`;

interface Creation {
  name: string;
  description?: string | null;
  illustrationImageUrl?: string | null;
  illustrations?: Array<{ imageUrl?: string | null }> | null;
  license?: { name?: string | null } | null;
  creator?: { nick?: string | null } | null;
}

interface GraphQLResponse {
  data?: { creation: Creation | null } | null;
  errors?: Array<{ message?: string }>;
}

export function createCults3d(ctx: SiteContext): SiteModule {
  const { cults3dUser: user, cults3dKey: key } = ctx.creds;

  async function preview(url: string): Promise<ImportPreview> {
    const ref = parseModelUrl(url);
    if (ref?.site !== "cults3d") throw new ImportError("Not a Cults3D model URL");
    if (!user || !key) return fallbackPreview(ctx, url, "cults3d", CULTS3D_BLOCKER_NO_CREDS);

    let body: GraphQLResponse;
    try {
      body = await ctx.http.json<GraphQLResponse>(GRAPHQL_URL, {
        label: "Cults3D",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`,
        },
        body: JSON.stringify({ query: CREATION_QUERY, variables: { slug: ref.id } }),
      });
    } catch (err) {
      if (err instanceof ImportError && /HTTP (401|403)$/.test(err.message)) {
        throw new ImportError("Cults3D rejected the API credentials");
      }
      throw err;
    }
    if (body.errors?.length) {
      throw new ImportError(`Cults3D API error: ${body.errors.map((e) => e.message ?? "unknown").join("; ")}`);
    }
    const c = body.data?.creation;
    if (!c) throw new ImportError("Cults3D has no such model");

    return {
      source: {
        site: "cults3d",
        url,
        title: c.name.trim(),
        author: c.creator?.nick ?? null,
        license: c.license?.name ?? null,
        description: toMarkdown(c.description),
        images: uniqueStrings([c.illustrationImageUrl, ...(c.illustrations ?? []).map((i) => i.imageUrl)]),
      },
      files: [],
      blocker: CULTS3D_BLOCKER_NO_FILES,
    };
  }

  return {
    preview,
    download: async () => {
      throw new ImportError(CULTS3D_BLOCKER_NO_FILES);
    },
  };
}
