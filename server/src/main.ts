import { createImporters } from "@drawer/importers";
import { createRenderer } from "@drawer/render";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { VERSION } from "./version.ts";

const config = loadConfig();

const app = createApp({
  dataDir: config.dataDir,
  renderer: createRenderer({ cacheDir: `${config.dataDir}/cache/renders`, openscadCmd: config.openscadCmd }),
  importers: createImporters(config.credentials),
  webDist: config.webDist,
  allowedHosts: config.allowedHosts,
});
await app.ready;

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 255,
  maxRequestBodySize: 210 * 1024 * 1024,
  fetch: (req) => app.fetch(req),
});

console.log(`drawer ${VERSION} listening on http://${config.host}:${server.port} (data: ${config.dataDir})`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
