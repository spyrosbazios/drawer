/**
 * Printables: the public GraphQL API behind the website (undocumented, anonymous). Query and
 * mutation shapes follow github.com/feodor-ra/printables-mcp and
 * github.com/tibetthetibz-alt/printables-graphql-api and were checked against the live API.
 */
import type { ImportFile, ImportPreview } from "@drawer/shared/api";
import { ImportError } from "@drawer/shared/contracts";
import { MAX_FILE_BYTES } from "../http";
import { toMarkdown } from "../markdown";
import { parseModelUrl } from "../detect";
import { safeFileName, toNumberOrNull, uniqueStrings, type SiteContext, type SiteModule } from "./context";

const GRAPHQL_URL = "https://api.printables.com/graphql/";
const MEDIA_BASE = "https://media.printables.com/";

const MODEL_QUERY = `
query DrawerModel($id: ID!) {
  model: print(id: $id) {
    id name slug summary description
    user { id handle publicUsername }
    license { id name abbreviation }
    images { filePath }
    stls { id name fileSize folder }
    otherFiles { id name fileSize folder }
  }
}`;

const DOWNLOAD_MUTATION = `
mutation DrawerDownloadLink($id: ID!, $modelId: ID!, $fileType: DownloadFileTypeEnum!) {
  result: getDownloadLink(id: $id, printId: $modelId, fileType: $fileType, source: model_detail) {
    ok
    errors { field messages }
    output { link ttl }
  }
}`;

interface PrintablesFile {
  id: string;
  name: string;
  fileSize?: number | null;
}

interface PrintablesModel {
  id: string;
  name: string;
  summary?: string | null;
  description?: string | null;
  user?: { publicUsername?: string | null; handle?: string | null } | null;
  license?: { name?: string | null; abbreviation?: string | null } | null;
  images?: Array<{ filePath: string }> | null;
  stls?: PrintablesFile[] | null;
  otherFiles?: PrintablesFile[] | null;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}

type FileType = "stl" | "other";

/** ImportFile ids carry the download category: "stl:2707023". */
function fileId(type: FileType, id: string): string {
  return `${type}:${id}`;
}

function parseFileId(id: string): { type: FileType; id: string } {
  const [type, rest] = id.split(":");
  if ((type === "stl" || type === "other") && rest) return { type, id: rest };
  throw new ImportError("Unknown Printables file id");
}

export function createPrintables(ctx: SiteContext): SiteModule {
  async function graphql<T>(query: string, variables: Record<string, string>): Promise<T> {
    const body = await ctx.http.json<GraphQLResponse<T>>(GRAPHQL_URL, {
      label: "Printables",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (body.errors?.length) {
      throw new ImportError(`Printables API error: ${body.errors.map((e) => e.message ?? "unknown").join("; ")}`);
    }
    if (!body.data) throw new ImportError("Printables returned no data");
    return body.data;
  }

  function modelId(url: string): string {
    const ref = parseModelUrl(url);
    if (ref?.site !== "printables") throw new ImportError("Not a Printables model URL");
    return ref.id;
  }

  async function preview(url: string): Promise<ImportPreview> {
    const id = modelId(url);
    const { model } = await graphql<{ model: PrintablesModel | null }>(MODEL_QUERY, { id });
    if (!model) throw new ImportError("Printables has no such model");

    const files: ImportFile[] = [
      ...(model.stls ?? []).map((f) => toImportFile("stl", f)),
      ...(model.otherFiles ?? []).map((f) => toImportFile("other", f)),
    ];
    const summary = toMarkdown(model.summary);
    const description = toMarkdown(model.description);
    return {
      source: {
        site: "printables",
        url,
        title: model.name.trim(),
        author: model.user?.publicUsername ?? model.user?.handle ?? null,
        license: model.license?.name ?? model.license?.abbreviation ?? null,
        description: description && description !== summary ? [summary, description].filter(Boolean).join("\n\n") : summary,
        images: (model.images ?? []).map((i) => MEDIA_BASE + i.filePath.replace(/^\/+/, "")),
      },
      files,
      blocker: null,
    };
  }

  function toImportFile(type: FileType, f: PrintablesFile): ImportFile {
    return {
      id: fileId(type, f.id),
      name: safeFileName(f.name, `file-${f.id}`),
      size: toNumberOrNull(f.fileSize),
      downloadable: true,
    };
  }

  async function download(url: string, file: ImportFile, destPath: string): Promise<void> {
    const modelRef = modelId(url);
    const target = parseFileId(file.id);
    const { result } = await graphql<{
      result: { ok: boolean; errors?: Array<{ messages?: string[] }> | null; output?: { link?: string } | null };
    }>(DOWNLOAD_MUTATION, { id: target.id, modelId: modelRef, fileType: target.type });
    const link = result.output?.link;
    if (!result.ok || !link) {
      const why = result.errors?.flatMap((e) => e.messages ?? []).join("; ");
      throw new ImportError(`Printables did not give a download link${why ? `: ${why}` : ""}`);
    }
    await ctx.http.download(link, { label: "Printables file server", maxBytes: MAX_FILE_BYTES, kind: "file" }, destPath);
  }

  return { preview, download };
}
