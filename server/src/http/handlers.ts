import { posix } from "node:path";
import type { CreateProjectBody, FileKind, ImportBody, PatchProjectBody, RenderBody, RenderView, SearchResponse } from "@drawer/shared/api";
import { HEADER_AUTHOR, HEADER_MESSAGE, HEADER_REV } from "@drawer/shared/api";
import { ApiException, forbidden, invalid, notFound } from "../errors.ts";
import { ALL_VIEWS, type Service } from "../service.ts";
import { mimeFor, normalizePath } from "../store/paths.ts";
import { attachmentHeader, isActiveContent } from "./download.ts";
import { Router, type RouteContext } from "./router.ts";
import { sseResponse, type SseRegistry } from "./sse.ts";
import { optBool, optInt, optParams, optString, optStringArray, queryInt, readJsonBody, reqString } from "./validate.ts";
import { registerPartRoutes } from "./parts-routes.ts";
import type { EventBus } from "../events.ts";
import { registerSessionRoutes, type Sessions } from "../sessions/index.ts";
import type { SettingsStore } from "../settings.ts";

const MAX_UPLOAD = 200 * 1024 * 1024;
const FILE_KINDS: FileKind[] = ["markdown", "scad", "mesh", "image", "pdf", "text", "binary"];
const RENDER_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const RENDER_FILE_RE = /^[a-z0-9][a-z0-9._-]*\.(png|stl|f32|json)$/;
const RENDER_TYPES: Record<string, string> = { png: "image/png", stl: "model/stl", f32: "application/octet-stream", json: "application/json" };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function author(req: Request): string {
  return req.headers.get(HEADER_AUTHOR)?.trim() || "agent";
}

function message(req: Request): string | undefined {
  const raw = req.headers.get(HEADER_MESSAGE);
  if (raw === null) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function revHeader(req: Request): string | undefined {
  return req.headers.get(HEADER_REV)?.trim() || undefined;
}

/** For responses whose URL names their content: a key, a hash or a past revision. */
const IMMUTABLE = "public, max-age=31536000, immutable";

function filePath(ctx: RouteContext): string {
  return normalizePath(ctx.rest);
}

function createProjectBody(obj: Record<string, unknown>): CreateProjectBody {
  const title = optString(obj, "title");
  const description = optString(obj, "description");
  const fromUrl = optString(obj, "fromUrl");
  const fileIds = optStringArray(obj, "fileIds");
  const brief = optString(obj, "brief");
  return {
    slug: reqString(obj, "slug"),
    ...(brief === undefined ? {} : { brief }),
    ...(obj.defaults === undefined ? {} : { defaults: obj.defaults as CreateProjectBody["defaults"] & object }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(fromUrl === undefined ? {} : { fromUrl }),
    ...(fileIds === undefined ? {} : { fileIds }),
  };
}

function patchProjectBody(obj: Record<string, unknown>): PatchProjectBody {
  const out: PatchProjectBody = {};
  const title = optString(obj, "title");
  const description = optString(obj, "description");
  if (title !== undefined) out.title = title;
  if (description !== undefined) out.description = description;
  if (obj.defaults !== undefined) out.defaults = obj.defaults as PatchProjectBody["defaults"] & object;
  if ("cover" in obj) {
    if (obj.cover !== null && typeof obj.cover !== "string") throw invalid("cover must be a string or null");
    out.cover = obj.cover as string | null;
  }
  return out;
}

function renderBody(obj: Record<string, unknown>): RenderBody {
  const out: RenderBody = {};
  const views = optStringArray(obj, "views");
  if (views !== undefined) {
    const bad = views.filter((v) => !(ALL_VIEWS as string[]).includes(v));
    if (bad.length > 0) throw invalid(`unknown views: ${bad.join(", ")} (use ${ALL_VIEWS.join(", ")})`);
    out.views = views as RenderView[];
  }
  const size = optInt(obj, "size", 64, 4096);
  if (size !== undefined) out.size = size;
  const at = optString(obj, "at");
  if (at !== undefined) out.at = at;
  const params = optParams(obj, "params");
  if (params !== undefined) out.params = params;
  return out;
}

export interface HandlerDeps {
  service: Service;
  bus: EventBus;
  sse: SseRegistry;
  sessions: Sessions;
  settings: SettingsStore;
  renderCacheDir: string;
  meshCacheDir: string;
}

export function buildRouter({ service, bus, sse, sessions, settings, renderCacheDir, meshCacheDir }: HandlerDeps): Router {
  const r = new Router();
  registerSessionRoutes(r, sessions);

  r.add("GET", "/settings", () => json(settings.get()));
  r.add("PATCH", "/settings", async ({ req }) => {
    if (author(req) === "agent") throw forbidden("settings are a person's decision; ask them to change it in the web app");
    return json(await settings.patch(await readJsonBody(req)));
  });

  r.add("GET", "/health", async () => json(await service.health()));
  r.add("GET", "/events", ({ req }) => sseResponse(bus, sse, req.signal));

  r.add("GET", "/projects", async () => json({ projects: await service.listProjects() }));
  r.add("POST", "/projects", async ({ req }) => json(await service.createProject(createProjectBody(await readJsonBody(req)), author(req)), 201));
  r.add("GET", "/projects/:slug", async ({ params }) => json(await service.getProject(params.slug as string)));
  r.add("PATCH", "/projects/:slug", async ({ req, params }) =>
    json(await service.patchProject(params.slug as string, patchProjectBody(await readJsonBody(req)), author(req))),
  );
  r.add("DELETE", "/projects/:slug", async ({ params }) => {
    await service.deleteProject(params.slug as string);
    return new Response(null, { status: 204 });
  });
  r.add("GET", "/projects/:slug/thumbnail/:file", async ({ req, params }) => {
    const key = /^([0-9a-f]{32})\.png$/.exec(params.file as string)?.[1];
    if (key === undefined) throw notFound("no such thumbnail");
    const headers = { "content-type": "image/png", "cache-control": IMMUTABLE, etag: `"${key}"`, "x-content-type-options": "nosniff" };
    if (req.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
    return new Response(await service.thumbnail(params.slug as string, key), { headers });
  });
  r.add("GET", "/projects/:slug/tree", async ({ params }) => json(await service.tree(params.slug as string)));

  r.add("GET", "/projects/:slug/files/*", async (ctx) => {
    const path = filePath(ctx);
    const at = ctx.url.searchParams.get("at") ?? undefined;
    const file = await service.readFile(ctx.params.slug as string, path, at);
    const headers: Record<string, string> = {
      "content-type": mimeFor(path, file.kind),
      [HEADER_REV]: file.rev,
      "x-content-type-options": "nosniff",
    };
    if (isActiveContent(path)) headers["content-security-policy"] = "sandbox";
    if (ctx.url.searchParams.get("download") === "1") headers["content-disposition"] = attachmentHeader(path);
    if (at !== undefined) headers["cache-control"] = IMMUTABLE;
    return new Response(file.source.type === "file" ? Bun.file(file.source.abs) : file.source.bytes, { headers });
  });
  r.add("PUT", "/projects/:slug/files/*", async (ctx) => {
    const path = filePath(ctx);
    const declared = Number(ctx.req.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD) throw invalid("upload exceeds the 200 MB limit");
    const bytes = new Uint8Array(await ctx.req.arrayBuffer());
    return json(await service.writeFile(ctx.params.slug as string, path, bytes, { rev: revHeader(ctx.req), author: author(ctx.req), message: message(ctx.req) }));
  });
  r.add("DELETE", "/projects/:slug/files/*", async (ctx) =>
    json(
      await service.deleteFile(
        ctx.params.slug as string,
        filePath(ctx),
        { rev: revHeader(ctx.req), recursive: ["1", "true"].includes(ctx.url.searchParams.get("recursive") ?? ""), message: message(ctx.req) },
        author(ctx.req),
      ),
    ),
  );
  r.add("POST", "/projects/:slug/edit/*", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    return json(
      await service.editFile(
        ctx.params.slug as string,
        filePath(ctx),
        { rev: reqString(body, "rev"), old: reqString(body, "old"), new: reqString(body, "new"), replaceAll: optBool(body, "replaceAll") ?? false, message: optString(body, "message") },
        author(ctx.req),
      ),
    );
  });
  r.add("POST", "/projects/:slug/move", async ({ req, params }) => {
    const body = await readJsonBody(req);
    const from = normalizePath(reqString(body, "from"));
    const to = normalizePath(reqString(body, "to"));
    return json(await service.moveFile(params.slug as string, from, to, optString(body, "message"), author(req)));
  });
  r.add("GET", "/projects/:slug/info/*", async (ctx) => json(await service.info(ctx.params.slug as string, filePath(ctx))));
  r.add("GET", "/projects/:slug/history", async ({ url, params }) => {
    const path = normalizePath(url.searchParams.get("path") ?? "", { allowEmpty: true });
    return json(await service.history(params.slug as string, path, queryInt(url, "limit", 50, 1, 500)));
  });
  r.add("GET", "/projects/:slug/context/*", async (ctx) =>
    json(await service.context(ctx.params.slug as string, filePath(ctx), queryInt(ctx.url, "depth", 2, 0, 5), queryInt(ctx.url, "maxBytes", 4000, 0, 1_000_000))),
  );
  r.add("POST", "/projects/:slug/render/*", async (ctx) =>
    json(await service.render(ctx.params.slug as string, filePath(ctx), renderBody(await readJsonBody(ctx.req, { optional: true })))),
  );
  r.add("POST", "/projects/:slug/import", async ({ req, params }) => {
    const body = await readJsonBody(req);
    const name = optString(body, "name");
    const fileIds = optStringArray(body, "fileIds");
    const importBody: ImportBody = { url: reqString(body, "url"), ...(fileIds === undefined ? {} : { fileIds }), ...(name === undefined ? {} : { name }) };
    return json(await service.importProject(params.slug as string, importBody));
  });
  r.add("POST", "/import/preview", async ({ req }) => json(await service.previewImport(reqString(await readJsonBody(req), "url"))));

  registerPartRoutes(r, service, { json, author });

  r.add("GET", "/renders/*", async ({ req, rest }) => {
    const [key, file, ...extra] = rest.split("/");
    const ext = file === undefined || !RENDER_FILE_RE.test(file) ? undefined : file.slice(file.lastIndexOf(".") + 1);
    const type = ext === undefined ? undefined : RENDER_TYPES[ext];
    if (key === undefined || file === undefined || extra.length > 0 || !RENDER_KEY_RE.test(key) || type === undefined) throw notFound("no such render");
    const headers = { "content-type": type, "cache-control": IMMUTABLE, etag: `"${key}/${file}"`, "x-content-type-options": "nosniff" };
    if (req.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
    const root = ext === "stl" || ext === "f32" || file.startsWith("section-") ? meshCacheDir : renderCacheDir;
    const handle = Bun.file(`${root}/${key}/${file}`);
    if (!(await handle.exists())) throw notFound("no such render");
    return new Response(handle, { headers });
  });

  r.add("GET", "/projects/:slug/search", async ({ params, url }) => {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (q === "") throw invalid("q is required");
    const kind = url.searchParams.get("kind") ?? undefined;
    if (kind !== undefined && !(FILE_KINDS as string[]).includes(kind)) throw invalid(`kind must be one of ${FILE_KINDS.join(", ")}`);
    const hits = await service.search(params.slug as string, { q, limit: queryInt(url, "limit", 20, 1, 100), ...(kind ? { kind: kind as FileKind } : {}) });
    return json({ hits } satisfies SearchResponse);
  });
  r.add("POST", "/reindex", async () => json(await service.reindex()));

  return r;
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiException) return json(err.toBody(), err.status);
  console.error("unhandled error:", err);
  return json({ error: "internal", message: "internal error" }, 500);
}
