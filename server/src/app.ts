import { join } from "node:path";
import type { Importers, Renderer } from "@drawer/shared/contracts";
import { ApiException, notFound } from "./errors.ts";
import { EventBus } from "./events.ts";
import { buildRouter, errorResponse } from "./http/handlers.ts";
import { SseRegistry } from "./http/sse.ts";
import { guardRequest } from "./http/guard.ts";
import { serveWeb } from "./http/static.ts";
import { Index } from "./index/indexer.ts";
import { Service } from "./service.ts";
import { createSessions } from "./sessions/index.ts";
import { SettingsStore } from "./settings.ts";
import { Store } from "./store/store.ts";

export interface AppOptions {
  dataDir: string;
  renderer: Renderer;
  importers: Importers;
  /** Directory of the built web app; null or a missing directory serves only the API. */
  webDist: string | null;
  /** Host names served besides IP literals and localhost (DRAWER_ALLOWED_HOSTS), normalised. See http/guard.ts. */
  allowedHosts: readonly string[];
}

export interface App {
  /** Handles one request, like `Bun.serve`'s fetch. Waits for startup to finish first. */
  fetch(req: Request): Promise<Response>;
  /** Resolves when the store and index are ready; rejects when startup failed. */
  ready: Promise<void>;
  /** Resolves when no part or assembly evaluation is queued or running. */
  drained(): Promise<void>;
  /** Ends event streams and closes the index. */
  close(): Promise<void>;
}

export function createApp(opts: AppOptions): App {
  const store = new Store(opts.dataDir);
  const bus = new EventBus();
  const sse = new SseRegistry();
  let service: Service | null = null;
  let index: Index | null = null;
  let router: ReturnType<typeof buildRouter> | null = null;
  const settings = new SettingsStore(opts.dataDir, bus);
  const sessions = createSessions({
    dataDir: opts.dataDir,
    bus,
    settings: () => settings.get(),
    projectExists: (slug) => store.has(slug),
    // Sessions start after the service, so it is there by the time a request files an attachment.
    writeFile: (slug, path, bytes, o) => {
      if (service === null) throw new ApiException("internal", "the server is still starting");
      return service.writeFile(slug, path, bytes, o);
    },
  });

  const ready = (async () => {
    await store.init();
    await settings.init();
    index = new Index(join(opts.dataDir, "index.db"), store.projectsDir, opts.renderer);
    service = new Service({ store, index, bus, renderer: opts.renderer, importers: opts.importers });
    router = buildRouter({ service, bus, sse, sessions, settings, renderCacheDir: store.renderCacheDir, meshCacheDir: store.meshCacheDir });
    await service.start(index.needsRebuild);
    await sessions.init();
  })();
  // A failed start surfaces through `ready` and through every request; avoid an unhandled rejection here.
  ready.catch(() => undefined);

  async function handle(req: Request): Promise<Response> {
    await ready;
    guardRequest(req, opts.allowedHosts);
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice("/api".length);
      const match = router?.match(req.method, path);
      if (!match) throw notFound(`no such route: ${req.method} ${url.pathname}`);
      return match.handler({ req, url, params: match.params, rest: match.rest });
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new ApiException("invalid", "only GET is served outside /api");
    if (opts.webDist === null) throw notFound("the web app is not served");
    return serveWeb(opts.webDist, url.pathname);
  }

  return {
    ready,
    async fetch(req) {
      try {
        return await handle(req);
      } catch (err) {
        return errorResponse(err);
      }
    },
    async drained() {
      await ready;
      await service?.parts.drained();
    },
    async close() {
      sse.closeAll();
      sessions.close();
      await ready.catch(() => undefined);
      await service?.close();
      index?.close();
    },
  };
}
