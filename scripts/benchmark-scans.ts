/** Time scan intake and measurements on a generated noisy surface. Run through heavy. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderer } from "../render/src/index";
import { toBinaryStl } from "../render/src/mesh";
import { createImporters } from "../importers/src/index";
import { createApp } from "../server/src/app";
import type { ScanResult } from "../shared/src/api";

const side = 1000;
const heights = new Float32Array((side + 1) ** 2);
let seed = 0x9324;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed + 0.5) / 2 ** 32;
};
for (let i = 0; i < heights.length; i++) {
  heights[i] = 0.015 * Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next());
}

function surface(): Uint8Array {
  const positions = new Float32Array(side * side * 18);
  let offset = 0;
  const put = (x: number, y: number) => {
    positions[offset++] = x * 0.2;
    positions[offset++] = y * 0.2;
    positions[offset++] = heights[y * (side + 1) + x]!;
  };
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      put(x, y);
      put(x + 1, y);
      put(x + 1, y + 1);
      put(x, y);
      put(x + 1, y + 1);
      put(x, y + 1);
    }
  }
  return toBinaryStl(positions);
}

const peakMiB = () => Math.round(process.resourceUsage().maxRSS / 1024);
const root = await mkdtemp(join(tmpdir(), "drawer-scan-bench-"));
const renderer = createRenderer({ cacheDir: join(root, "cache"), openscadCmd: "/unavailable" });
const app = createApp({ dataDir: root, renderer, importers: createImporters({}), webDist: null, allowedHosts: [] });
async function post(route: string, payload: Uint8Array | object): Promise<Response> {
  const binary = payload instanceof Uint8Array;
  const response = await app.fetch(
    new Request(`http://localhost/api/${route}`, {
      method: "POST",
      headers: { "content-type": binary ? "application/octet-stream" : "application/json" },
      body: binary ? new Blob([payload as Uint8Array<ArrayBuffer>]) : JSON.stringify(payload),
    }),
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response;
}
try {
  await post("projects", { slug: "bench" });
  let bytes: Uint8Array | null = surface();
  const baselineMiB = peakMiB();
  let start = performance.now();
  const scan: ScanResult = await (await post("projects/bench/scans?name=noisy&filename=noisy.stl&units=mm", bytes)).json();
  bytes = null;
  const intake = { seconds: (performance.now() - start) / 1000, peakMiB: peakMiB() };
  start = performance.now();
  const mesh = await renderer.mesh({ file: join(root, "projects", "bench", scan.path), searchPaths: [] });
  await renderer.analyse({ key: mesh.key, overhangDeg: 45 });
  const analyse = { seconds: (performance.now() - start) / 1000, peakMiB: peakMiB() };
  process.stdout.write(`${JSON.stringify({ triangles: mesh.info.triangles, noiseMm: scan.noiseMm, baselineMiB, intake, analyse })}\n`);
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
