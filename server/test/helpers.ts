import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import type { ImportFile, ImportPreview, MeshInfo, ParamValue, ParamValues, ProbeResult, RenderView, ScadParam, SliceResult } from "@drawer/shared/api";
import {
  ImportError,
  RenderError,
  type AssemblyRenderOutput,
  type CheckOutput,
  type DeviationOutput,
  type Importers,
  type MeshAnalysisOutput,
  type RenderOutput,
  type RenderRequest,
  type Renderer,
} from "@drawer/shared/contracts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const MESH_INFO: MeshInfo = { format: "stl", closed: true, triangles: 12, bbox: { min: [0, 0, 0], max: [10, 20, 30], size: [10, 20, 30] }, volumeCm3: 6 };

export interface FakeRenderer extends Renderer {
  /** What version() answers; change it before a restart to simulate an OpenSCAD upgrade. */
  openscadVersion: string;
  renders: RenderRequest[];
  /** Text of each rendered file at the time of the call. */
  seen: { file: string; text: string; searchPaths: string[] }[];
  /** How often each method was called. */
  calls: Record<string, number>;
}

/** Top-level `name = value;` assignments before the first module or function, with an optional `// [min:max]`. */
function fakeParams(source: string): ScadParam[] {
  const out: ScadParam[] = [];
  const lines = source.split("\n");
  for (const [i, line] of lines.entries()) {
    if (/^\s*(module|function)\b/.test(line)) break;
    const m = /^([A-Za-z_]\w*)\s*=\s*([^;]+);\s*(?:\/\/\s*\[(-?[\d.]+):(-?[\d.]+)\])?/.exec(line);
    if (!m?.[1] || m[2] === undefined) continue;
    const raw = m[2].trim();
    const value: ParamValue = /^-?[\d.]+$/.test(raw) ? Number(raw) : raw === "true" || raw === "false" ? raw === "true" : raw.replace(/^"|"$/g, "");
    out.push({
      name: m[1],
      type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string",
      value,
      group: "",
      description: "",
      min: m[3] === undefined ? null : Number(m[3]),
      max: m[4] === undefined ? null : Number(m[4]),
      step: null,
      options: null,
      line: i + 1,
    });
  }
  return out;
}

/** What the fake knows about one render: marker values from the source, resolved against params. */
interface FakeSolid {
  info: MeshInfo;
  shells: number;
  watertight: boolean;
  base: number;
  overhang: number;
  wall: number;
  hole: number | null;
  boss: number | null;
  oval: boolean;
  probe: { inside: boolean; onSurface: boolean; distance: number | null } | null;
}

/**
 * Markers in the source drive the answers: `@size=x,y,z` `@min=x,y,z` `@volume=v` `@triangles=n`
 * `@shells=n` `@leaky` `@base=mm2` `@overhang=mm2` `@wall=mm` `@hole=d` (an opening) `@boss=d` (an
 * outline of material) `@oval` `@probe=solid|air|surface,<len>|open`. A value may name a parameter (`@size=w,20,30`), resolved from the
 * render's params, then from the source's own assignment. `FAIL` fails the render and the check.
 */
function fakeSolid(text: string, params: ParamValues | undefined): FakeSolid {
  const own = new Map(fakeParams(text).map((p) => [p.name, p.value]));
  const num = (token: string): number => {
    const t = token.trim();
    if (/^-?[\d.]+$/.test(t)) return Number(t);
    const v = params?.[t] ?? own.get(t);
    return typeof v === "number" ? v : Number.NaN;
  };
  const marker = (name: string): string | null => new RegExp(`@${name}(?:=([^\\s]+))?(?=\\s|$)`).exec(text)?.[1] ?? (text.includes(`@${name}`) ? "" : null);
  const vec = (name: string, fallback: [number, number, number]): [number, number, number] => {
    const m = marker(name);
    if (!m) return fallback;
    const [x, y, z] = m.split(",").map(num);
    return [x ?? 0, y ?? 0, z ?? 0];
  };
  const one = (name: string, fallback: number): number => {
    const m = marker(name);
    return m ? num(m) : fallback;
  };
  const size = vec("size", [10, 20, 30]);
  const min = vec("min", [0, 0, 0]);
  const probe = marker("probe");
  const [where, len] = (probe ?? "").split(",");
  return {
    info: { format: "stl", closed: marker("leaky") === null, triangles: one("triangles", 12), bbox: { min, max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]], size }, volumeCm3: one("volume", 6) },
    shells: one("shells", 1),
    watertight: marker("leaky") === null,
    base: one("base", 200),
    overhang: one("overhang", 0),
    wall: one("wall", 2),
    hole: marker("hole") === null ? null : one("hole", 0),
    boss: marker("boss") === null ? null : one("boss", 0),
    oval: marker("oval") !== null,
    probe: probe === null ? null : { inside: where === "solid", onSurface: where === "surface", distance: len === "open" ? null : Number(len) },
  };
}

function applyMatrix(m: number[], p: [number, number, number]): [number, number, number] {
  const row = (r: number): number => (m[r * 4] ?? 0) * p[0] + (m[r * 4 + 1] ?? 0) * p[1] + (m[r * 4 + 2] ?? 0) * p[2] + (m[r * 4 + 3] ?? 0);
  return [row(0), row(1), row(2)];
}

function placedBox(info: MeshInfo, m: number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = applyMatrix(m, [i & 1 ? info.bbox.max[0] : info.bbox.min[0], i & 2 ? info.bbox.max[1] : info.bbox.min[1], i & 4 ? info.bbox.max[2] : info.bbox.min[2]]);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, p[k] as number);
      max[k] = Math.max(max[k] as number, p[k] as number);
    }
  }
  return { min, max };
}

const sha = (...parts: string[]): string => new Bun.CryptoHasher("sha256").update(parts.join("\u0000")).digest("hex");

/** Writes the cache layout the real renderer writes. Answers come from markers in the source (see fakeSolid). */
export function fakeRenderer(cacheDir: string): FakeRenderer {
  const renders: RenderRequest[] = [];
  const meshCache = join(cacheDir, "meshes");
  const renderCache = join(cacheDir, "renders");
  const seen: FakeRenderer["seen"] = [];
  const calls: Record<string, number> = {};
  const solids = new Map<string, FakeSolid>();
  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const solid = (key: string): FakeSolid => {
    const s = solids.get(key);
    if (!s) throw new RenderError(`unknown render key ${key}`);
    return s;
  };
  const fake: FakeRenderer = {
    openscadVersion: "OpenSCAD fake 2025.01",
    renders,
    seen,
    calls,
    async version() {
      return fake.openscadVersion;
    },
    async render(req: RenderRequest): Promise<RenderOutput> {
      count("render");
      renders.push(req);
      const total = req.views.length + 3;
      req.onProgress?.({ stage: "queued", step: 0, total, view: null });
      req.onProgress?.({ stage: "geometry", step: 1, total, view: null });
      const mesh = await fake.mesh(req);
      const key = sha(mesh.key, req.views.join(","), String(req.size));
      const dir = join(renderCache, key);
      const cached = await Bun.file(join(dir, "meta.json")).exists();
      if (!cached) {
        await mkdir(dir, { recursive: true });
        for (const view of req.views) await writeFile(join(dir, `${view}.png`), PNG);
        await writeFile(join(dir, "sheet.png"), PNG);
        await writeFile(join(dir, "meta.json"), "{}");
      }
      return { ...mesh, key, meshKey: mesh.key, proxy: false, cached, dir, views: req.views as RenderView[] };
    },
    async mesh(req) {
      count("mesh");
      const text = await Bun.file(req.file).text();
      seen.push({ file: req.file, text, searchPaths: req.searchPaths });
      if (text.includes("FAIL")) throw new RenderError("ERROR: Parser error in line 1: syntax error");
      const key = sha(text, JSON.stringify(req.params ?? {}));
      const s = fakeSolid(text, req.params);
      solids.set(key, s);
      const dir = join(meshCache, key);
      const path = join(dir, "mesh.stl");
      const cached = await Bun.file(path).exists();
      if (!cached) {
        await mkdir(dir, { recursive: true });
        await writeFile(path, "solid fake\nendsolid fake\n");
      }
      return { key, cached, seconds: 0.01, dir, info: s.info, log: ["ECHO: hello"], warnings: [] };
    },
    async normalizeScan({ bytes, units }) {
      const text = new TextDecoder().decode(bytes);
      if (text.includes("POINT_CLOUD")) throw new RenderError("point cloud has no faces; export a triangulated surface");
      const info = fakeSolid(text, undefined).info;
      return { bytes, info, originalTriangles: info.triangles, degenerateTriangles: 0, debrisTriangles: 0, noiseMm: 0.02, unit: units ?? "millimeter" };
    },
    async meshInfo(file: string): Promise<MeshInfo> {
      if (basename(file).startsWith("bad")) throw new Error("unreadable mesh");
      return MESH_INFO;
    },
    async check(req): Promise<CheckOutput> {
      count("check");
      const text = await Bun.file(req.file).text();
      if (text.includes("FAIL")) return { ok: false, diagnostics: [{ level: "error", message: "Parser error: syntax error", file: req.file, line: 1 }], log: [] };
      const warnings: CheckOutput["diagnostics"] = text.includes("WARN") ? [{ level: "warning", message: "Ignoring unknown variable 'x'", file: req.file, line: 2 }] : [];
      return { ok: true, diagnostics: warnings, log: [] };
    },
    params(source: string): ScadParam[] {
      return fakeParams(source);
    },
    applyParams(source: string, values: ParamValues): string {
      const known = new Set(fakeParams(source).map((p) => p.name));
      let out = source;
      for (const [name, value] of Object.entries(values)) {
        if (!known.has(name)) throw new RenderError(`${name} is not a parameter`);
        out = out.replace(new RegExp(`^(${name}\\s*=\\s*)[^;]+;`, "m"), `$1${typeof value === "string" ? JSON.stringify(value) : String(value)};`);
      }
      return out;
    },
    async analyse(req): Promise<MeshAnalysisOutput> {
      count("analyse");
      const s = solid(req.key);
      const [x, y] = s.info.bbox.size;
      await writeFile(join(meshCache, req.key, "thickness.f32"), new Uint8Array(4 * s.info.triangles));
      return {
        shells: s.shells,
        watertight: s.watertight,
        surfaceAreaMm2: 100,
        baseAreaMm2: s.base,
        footprintMm2: x * y,
        overhang: { angle: req.overhangDeg, areaMm2: s.overhang, at: s.overhang > 0 ? [1, 2, 3] : null },
        wall: s.watertight ? { minMm: s.wall, at: [4, 5, 6] } : null,
        thicknessFile: s.watertight ? "thickness.f32" : null,
      };
    },
    async slice(req): Promise<SliceResult> {
      count("slice");
      const s = solid(req.key);
      const idx = { x: 0, y: 1, z: 2 }[req.axis];
      const [u, v] = [0, 1, 2].filter((k) => k !== idx) as [number, number];
      const centre: [number, number] = [((s.info.bbox.min[u] ?? 0) + (s.info.bbox.max[u] ?? 0)) / 2, ((s.info.bbox.min[v] ?? 0) + (s.info.bbox.max[v] ?? 0)) / 2];
      const round = (d: number, hole: boolean): SliceResult["contours"][number] => {
        const r = d / 2;
        return {
          hole,
          areaMm2: Math.PI * r * r,
          centre,
          bbox: { min: [centre[0] - r, centre[1] - r], max: [centre[0] + r, centre[1] + r] },
          circle: { centre, diameter: d, rms: s.oval ? d * 0.1 : 0.001, round: !s.oval },
          points: [],
        };
      };
      const contours: SliceResult["contours"] = [];
      if (s.hole !== null) contours.push(round(s.hole, true));
      if (s.boss !== null) contours.push(round(s.boss, false));
      return { axis: req.axis, at: req.at, contours, open: [] };
    },
    async features(req) {
      const s = solid(req.key);
      const fieldFile = "features.f32";
      await writeFile(join(meshCache, req.key, fieldFile), new Uint8Array(s.info.triangles * 4));
      return { features: [{ kind: "plane", origin: [0, 0, 0], direction: [0, 0, 1], diameter: null, length: null, side: null, areaMm2: 100, rms: 0, maxError: 0, coverage: 1 }], fieldFile, meshFile: "mesh.stl" };
    },
    async fit(req) {
      const { features } = await fake.features(req);
      return req.kind && req.kind !== "plane" ? null : features[0] ?? null;
    },
    async probe(req): Promise<ProbeResult> {
      count("probe");
      const p = solid(req.key).probe ?? { inside: true, onSurface: false, distance: 1 };
      const at = req.from[{ x: 0, y: 1, z: 2 }[req.axis]] ?? 0;
      return { inside: p.inside, onSurface: p.onSurface, distance: p.distance, low: p.distance === null ? null : at - p.distance / 2, high: p.distance === null ? null : at + p.distance / 2 };
    },
    async section(req): Promise<string> {
      count("section");
      solid(req.key);
      const name = `section-${req.axis}-${req.at}-${req.size}.png`;
      await writeFile(join(meshCache, req.key, name), PNG);
      return name;
    },
    async thumbnail(req): Promise<string> {
      count("thumbnail");
      const name = `thumb-${req.view}-${req.size}.png`;
      await writeFile(join(renderCache, req.key, name), PNG);
      return name;
    },
    async deviation(req): Promise<DeviationOutput> {
      count("deviation");
      const a = solid(req.a);
      const b = solid(req.b);
      const name = `deviation-${req.a}.f32`;
      await writeFile(join(meshCache, req.b, name), new Uint8Array(4 * b.info.triangles));
      const d = (b.info.bbox.size[0] ?? 0) - (a.info.bbox.size[0] ?? 0);
      return { min: Math.min(0, d), max: Math.max(0, d), rms: Math.abs(d) / 2, p95: Math.abs(d), at: d === 0 ? null : [0, 0, 0], fieldFile: name };
    },
    async interference(req) {
      count("interference");
      const a = placedBox(solid(req.a.key).info, req.a.matrix);
      const b = placedBox(solid(req.b.key).info, req.b.matrix);
      let gap2 = 0;
      let overlap = 1;
      for (let k = 0; k < 3; k++) {
        const g = Math.max(0, (a.min[k] as number) - (b.max[k] as number), (b.min[k] as number) - (a.max[k] as number));
        gap2 += g * g;
        overlap *= Math.max(0, Math.min(a.max[k] as number, b.max[k] as number) - Math.max(a.min[k] as number, b.min[k] as number));
      }
      return { gapMm: Math.round(Math.sqrt(gap2) * 1000) / 1000, overlapCm3: overlap / 1000 };
    },
    async renderAssembly(req): Promise<AssemblyRenderOutput> {
      count("renderAssembly");
      const key = sha("assembly", JSON.stringify(req));
      const dir = join(renderCache, key);
      const cached = await Bun.file(join(dir, "sheet.png")).exists();
      if (!cached) {
        await mkdir(dir, { recursive: true });
        for (const view of req.views) await writeFile(join(dir, `${view}.png`), PNG);
        await writeFile(join(dir, "sheet.png"), PNG);
      }
      return { key, cached, dir, views: req.views };
    },
  };
  return fake;
}

export interface FakeImporters extends Importers {
  previews: string[];
  downloads: { url: string; file: ImportFile }[];
}

export const FAKE_PREVIEW: ImportPreview = {
  source: {
    site: "printables",
    url: "https://www.printables.com/model/123-earbuds-holder",
    title: "Earbuds Holder",
    author: "someone",
    license: "CC BY 4.0",
    description: "A small holder.\n\n- prints without supports",
    images: Array.from({ length: 10 }, (_, i) => `https://img.example/${i + 1}.png`),
  },
  files: [
    { id: "f1", name: "holder.stl", size: 100, downloadable: true },
    { id: "f2", name: "../evil/name.stl", size: 50, downloadable: true },
    { id: "f3", name: "manual.pdf", size: null, downloadable: false },
  ],
  blocker: null,
};

export function fakeImporters(): FakeImporters {
  const previews: string[] = [];
  const downloads: FakeImporters["downloads"] = [];
  return {
    previews,
    downloads,
    detect: () => "printables",
    async preview(url: string) {
      previews.push(url);
      if (url.includes("missing")) throw new ImportError("model not found");
      return { ...FAKE_PREVIEW, source: { ...FAKE_PREVIEW.source, url } };
    },
    async download(url: string, file: ImportFile, destPath: string) {
      downloads.push({ url, file });
      if (file.id === "boom") throw new ImportError("download failed");
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, `solid ${file.name}\n`);
    },
    async downloadImage(imageUrl: string, destPath: string) {
      if (imageUrl.endsWith("/3.png")) throw new ImportError("image gone");
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, PNG);
    },
  };
}

/** The host name the harness's requests use; the harness's app allows it as DRAWER_ALLOWED_HOSTS would. */
export const TEST_HOST = "drawer.test";

export interface Reply<T = unknown> {
  status: number;
  headers: Headers;
  json: T;
  bytes: Uint8Array;
  text: string;
}

export interface Harness {
  dir: string;
  dataDir: string;
  webDist: string;
  app: App;
  renderer: FakeRenderer;
  importers: FakeImporters;
  call<T = any>(method: string, path: string, init?: { body?: unknown; raw?: Uint8Array | string; headers?: Record<string, string> }): Promise<Reply<T>>;
  get<T = any>(path: string, headers?: Record<string, string>): Promise<Reply<T>>;
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  put<T = any>(path: string, raw: Uint8Array | string, headers?: Record<string, string>): Promise<Reply<T>>;
  del<T = any>(path: string, headers?: Record<string, string>): Promise<Reply<T>>;
  /** Creates (or overwrites, with `*`) a file and returns its rev. */
  write(project: string, path: string, content: string, headers?: Record<string, string>): Promise<string>;
  newProject(slug: string, extra?: Record<string, unknown>): Promise<void>;
  /** Waits until no part or assembly evaluation is queued or running. */
  drained(): Promise<void>;
  close(): Promise<void>;
}

/** An in-process app on a fresh temp DRAWER_DATA, with fake renderer and importers. */
export async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "drawer-test-"));
  const dataDir = join(dir, "data");
  const webDist = join(dir, "web-dist");
  const renderer = fakeRenderer(join(dataDir, "cache"));
  const importers = fakeImporters();
  const app = createApp({ dataDir, renderer, importers, webDist, allowedHosts: [TEST_HOST] });
  await app.ready;

  async function call<T>(method: string, path: string, init: { body?: unknown; raw?: Uint8Array | string; headers?: Record<string, string> } = {}): Promise<Reply<T>> {
    const headers: Record<string, string> = { ...init.headers };
    let body: RequestInit["body"];
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    } else if (init.raw !== undefined) {
      body = init.raw;
    }
    const res = await h.app.fetch(new Request(`http://${TEST_HOST}${path}`, { method, headers, body }));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let json: unknown = null;
    if ((res.headers.get("content-type") ?? "").includes("json")) json = JSON.parse(text);
    return { status: res.status, headers: res.headers, json: json as T, bytes, text };
  }

  const h: Harness = {
    dir,
    dataDir,
    webDist,
    app,
    renderer,
    importers,
    call,
    get: (path, headers) => call("GET", path, { headers }),
    post: (path, body, headers) => call("POST", path, { body: body ?? {}, headers }),
    put: (path, raw, headers) => call("PUT", path, { raw, headers }),
    del: (path, headers) => call("DELETE", path, { headers }),
    async write(project, path, content, headers = {}) {
      const res = await call<{ rev: string }>("PUT", `/api/projects/${project}/files/${path}`, { raw: content, headers: { "x-drawer-rev": "*", ...headers } });
      if (res.status !== 200) throw new Error(`write ${project}/${path} failed: ${res.status} ${res.text}`);
      return res.json.rev;
    },
    async newProject(slug, extra = {}) {
      const res = await call("POST", "/api/projects", { body: { slug, ...extra } });
      if (res.status !== 201) throw new Error(`create ${slug} failed: ${res.status} ${res.text}`);
    },
    async drained() {
      await h.app.drained();
    },
    async close() {
      await h.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return h;
}
