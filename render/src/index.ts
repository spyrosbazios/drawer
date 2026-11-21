/**
 * @drawer/render: OpenSCAD pipeline (STL, view PNGs, contact sheet) and pure mesh maths.
 * Implements the Renderer contract in @drawer/shared/contracts.
 *
 * Pipeline for one request (serialised by an internal queue):
 *   .scad: dependency pass (`-o x.echo -d deps`) → cache key → STL export (Manifold) → views
 *   mesh:  cache key → binary STL written in TypeScript → views of a wrapper that import()s it
 * Views use OpenSCAD's preview (OpenCSG), not --render: SCAD views get feature edges
 * (`--view=edges`), so faces square to an orthographic camera stay distinguishable, keep
 * color(), and skip a CSG pass per view; meshes need no Manifold repair to be looked at.
 * Mesh views have no edges: on a triangle soup they would draw every triangle.
 *
 * `check` runs on its own queue so it never waits behind a render. Measuring (analyse, slice,
 * probe, deviation, interference gap) runs in a worker (measure-worker.ts) and caches each result
 * as a file beside the cached mesh.stl; section, interference overlap and assemblies are
 * OpenSCAD runs on the render queue.
 */
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { MESH_FORMATS, type Axis, type Diagnostic, type FeatureKind, type MeshInfo, type ParamValues, type ProbeResult, type RenderView, type SliceResult, type Vec3 } from "@drawer/shared/api";
import {
  type AssemblyRenderOutput,
  type CheckOutput,
  type DeviationOutput,
  type MeshAnalysisOutput,
  type MeshOutput,
  type MeshRequest,
  type PlacedMesh,
  RenderError,
  type Renderer,
  type RendererOptions,
  type RenderOutput,
  type RenderProgress,
  type RenderRequest,
} from "@drawer/shared/contracts";
import { meshKey, renderKey, hashParts, PIPELINE_VERSION } from "./key";
import { MeasureClient } from "./measure-client";
import { meshFormatOf } from "./mesh";
import { applyParams, defineArgs, parseParams } from "./params";
import { parseDepsFile, parseDiagnostics, parseStderr, run, type RunResult } from "./process";
import { PROXY_TRIANGLES } from "./scan";
import { SerialQueue } from "./queue";
import { composeSheet } from "./sheet";
import { scaleDown } from "./thumbnail";

/** Camera rotation (x, y, z degrees) per view; see docs/SPEC.md → Rendering. */
const CAMERA: Record<RenderView, [number, number, number]> = {
  iso: [55, 0, 25],
  front: [90, 0, 0],
  top: [0, 0, 0],
  side: [90, 0, 90],
};
/** Built-in OpenSCAD scheme: blue-grey model on a light grey ground; legible on light and dark UIs. */
const COLOR_SCHEME = "Nord Light";
/** Looking at the cut face from the kept side's outside: down from +z, from +x, from +y. */
const SECTION_CAMERA: Record<Axis, [number, number, number]> = {
  z: [0, 0, 0],
  x: [90, 0, 90],
  y: [90, 0, 180],
};
/** Assembly instances cycle through these OpenSCAD colour names; highlighted ones are red. */
const PALETTE = ["SteelBlue", "Orange", "SeaGreen", "Gold", "MediumPurple", "Teal", "Tan", "SlateGray"];
const HIGHLIGHT_COLOUR = "Red";
const ASSEMBLY_MARKER = "assembly.json";
const THICKNESS_FILE = "thickness.f32";
const PROXY_MAPPING = "proxy-triangles.u32";
/** Above this gap two solids certainly share no volume: OpenSCAD is not asked. */
const CLEAR_GAP_MM = 0.001;
const CHECK_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 60_000;
const MAX_SIZE = 4096;

type MeshMeta = Pick<MeshOutput, "info" | "log" | "warnings">;

export function createRenderer(opts: RendererOptions): Renderer {
  const cmd = (opts.openscadCmd ?? "openscad").split(" ").filter((s) => s.length > 0);
  const timeoutMs = (opts.timeoutSeconds ?? 120) * 1000;
  const cacheDir = resolve(opts.cacheDir);
  const meshCache = join(cacheDir, "meshes");
  const renderCache = join(cacheDir, "renders");
  const queue = new SerialQueue();
  // Checks take seconds; they must not wait behind a two-minute render.
  const checkQueue = new SerialQueue();
  const measure = new MeasureClient();
  let versionPromise: Promise<string | null> | undefined;

  const version = (): Promise<string | null> => {
    versionPromise ??= run([...cmd, "--version"], { timeoutMs: VERSION_TIMEOUT_MS }).then(
      (r) => (r.code === 0 ? (/OpenSCAD version (\S+)/.exec(r.stdout + r.stderr)?.[1] ?? null) : null),
      () => null,
    );
    return versionPromise;
  };

  /** PNG export needs GL. EGL builds work without a display; otherwise borrow Xvfb when it exists. */
  const pngPrefix = (): string[] => (!process.env.DISPLAY && Bun.which("xvfb-run") ? ["xvfb-run", "-a"] : []);

  const mesh = async (req: MeshRequest, progress: (stage: "analysing" | "geometry", step: number) => void, deadline: number): Promise<MeshOutput> => {
    const started = performance.now();
    progress("analysing", 0);
    const file = resolve(req.file);
    const ext = extname(file).toLowerCase();
    const isScad = ext === ".scad";
    const meshFormat = meshFormatOf(file);
    if (!isScad && !meshFormat) throw new RenderError(`cannot render ${ext || "a file without extension"}: only .scad and these mesh formats: ${MESH_FORMATS.map((format) => `.${format}`).join(", ")}`);
    if (req.matrix && (isScad || req.matrix.length !== 16 || !req.matrix.every(Number.isFinite))) throw new RenderError("a mesh placement must be 16 finite numbers, row-major");
    const source = await readFile(file).catch((e: unknown) => {
      throw new RenderError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    });
    const env = { ...process.env, OPENSCADPATH: req.searchPaths.join(":") };
    // Parameter overrides apply to SCAD only; a mesh has none.
    const defines = isScad ? defineArgs(req.params) : [];
    const openscad = isScad ? await version() : null;
    if (isScad && openscad === null) throw new RenderError(`OpenSCAD cannot be run (command: ${cmd.join(" ")})`);
    const openscadRun = pipelineRun(env, deadline);
    await mkdir(meshCache, { recursive: true });
    const tmp = await mkdtemp(join(meshCache, ".tmp-"));
    try {
      let deps: string[] = [];
      if (isScad) {
        const echo = join(tmp, "deps.echo");
        const depsFile = join(tmp, "deps.d");
        const r = await openscadRun(["-o", echo, "-d", depsFile, ...defines, file], dirname(file), false);
        if (r.code !== 0) {
          // Echo export writes OpenSCAD's messages into the .echo file, not to stderr.
          const messages = await readFile(echo, "utf8").catch(() => "");
          throw new RenderError(`${messages}\n${r.stderr}`.trim() || `OpenSCAD exited with code ${r.code}`);
        }
        const listed = parseDepsFile(await readFile(depsFile, "utf8")).map((d) => resolve(dirname(file), d));
        deps = [...new Set(listed)].filter((d) => d !== file).sort();
      }
      const depBytes = await Promise.all(deps.map((d) => readFile(d).then((b) => new Uint8Array(b), () => new TextEncoder().encode(`missing:${d}`))));
      const key = meshKey({ file: source, format: ext, deps: depBytes, openscadVersion: openscad ?? "", defines, ...(req.matrix ? { matrix: req.matrix } : {}) });
      const dir = join(meshCache, key);
      const hit = await readMeshMeta(dir);
      if (hit) return { key, dir, cached: true, seconds: elapsed(started), ...hit };

      progress("geometry", 1);
      const meshPath = join(tmp, "mesh.stl");
      let log: string[] = [];
      let warnings: string[] = [];
      let info: MeshInfo;
      if (isScad) {
        const r = await openscadRun(["--backend=Manifold", "--export-format", "binstl", "-o", meshPath, ...defines, file], dirname(file), false);
        if (r.code !== 0 || !(await exists(meshPath))) throw new RenderError(r.stderr.trim() || `OpenSCAD exited with code ${r.code}`);
        ({ log, warnings } = parseStderr(r.stderr));
        info = (await measure.ask({ op: "info", file: meshPath })).info;
      } else {
        if (!meshFormat) throw new RenderError(`not a mesh file: ${file}`);
        info = (await measure.ask({ op: "convert", format: meshFormat, source, dest: meshPath, ...(req.matrix ? { matrix: req.matrix } : {}) })).info;
      }
      if (info.triangles === 0) throw new RenderError("the model is empty (no triangles)");
      await rm(join(tmp, "deps.echo"), { force: true });
      await rm(join(tmp, "deps.d"), { force: true });
      const meta = { info, log, warnings };
      await writeFile(join(tmp, "meta.json"), `${JSON.stringify(meta)}\n`);
      await publish(tmp, dir, "meta.json");
      return { key, dir, cached: false, seconds: elapsed(started), ...meta };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };

  const pipelineRun = (env: NodeJS.ProcessEnv, deadline: number) =>
    async (args: string[], cwd: string, png: boolean): Promise<RunResult> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RenderError(`render timed out after ${timeoutMs / 1000} s`);
      const r = await run([...(png ? pngPrefix() : []), ...cmd, ...args], { cwd, env, timeoutMs: remaining }).catch((e: unknown) => {
        throw new RenderError(`OpenSCAD cannot be run: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (r.timedOut) throw new RenderError(`render timed out after ${timeoutMs / 1000} s\n${r.stderr.trim()}`.trim());
      return r;
    };

  const drawMeshPath = async (dir: string, info: MeshInfo): Promise<string> => {
    const full = join(dir, "mesh.stl");
    if (info.triangles <= PROXY_TRIANGLES) return full;
    const path = join(dir, "proxy.stl");
    if (!(await exists(path))) {
      const tmp = await mkdtemp(join(meshCache, ".proxy-"));
      try {
        const dest = join(tmp, "proxy.stl");
        const mapping = join(tmp, PROXY_MAPPING);
        await measure.ask({ op: "proxy", mesh: full, dest, mapping });
        await rename(mapping, join(dir, PROXY_MAPPING));
        await rename(dest, path);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    return path;
  };

  const render = async (req: RenderRequest): Promise<RenderOutput> => {
    const started = performance.now();
    const deadline = Date.now() + timeoutMs;
    const views = [...new Set(req.views)];
    if (views.length === 0) throw new RenderError("no views requested");
    if (!Number.isInteger(req.size) || req.size < 16 || req.size > MAX_SIZE) throw new RenderError(`size must be an integer from 16 to ${MAX_SIZE}`);
    const openscad = await version();
    if (openscad === null) throw new RenderError(`OpenSCAD cannot be run (command: ${cmd.join(" ")})`);
    const total = views.length + 3;
    const progress = (stage: RenderProgress["stage"], step: number, view: RenderView | null = null): void => req.onProgress?.({ stage, step, total, view });
    const geometry = await mesh(req, progress, deadline);
    const key = renderKey(geometry.key, views, req.size, openscad);
    const dir = join(renderCache, key);
    const { info, log, warnings } = geometry;
    const file = resolve(req.file);
    const isScad = extname(file).toLowerCase() === ".scad";
    const proxy = !isScad && info.triangles > PROXY_TRIANGLES;
    const result = { key, meshKey: geometry.key, proxy, dir, views, info, log, warnings };
    if (await exists(join(dir, "meta.json"))) return { ...result, cached: true, seconds: elapsed(started) };

    const defines = isScad ? defineArgs(req.params) : [];
    const openscadRun = pipelineRun({ ...process.env, OPENSCADPATH: req.searchPaths.join(":") }, deadline);
    await mkdir(renderCache, { recursive: true });
    const tmp = await mkdtemp(join(renderCache, ".tmp-"));
    try {
      const wrapper = join(tmp, "view.scad");
      if (!isScad) {
        const meshPath = await drawMeshPath(geometry.dir, info);
        await writeFile(wrapper, `import(${JSON.stringify(meshPath)}, convexity = 10);\n`);
      }
      const cells: { view: RenderView; png: Uint8Array }[] = [];
      for (const [i, view] of views.entries()) {
        progress("views", 2 + i, view);
        const out = join(tmp, `${view}.png`);
        const [rx, ry, rz] = CAMERA[view];
        const r = await openscadRun(
          [
            "--backend=Manifold",
            "--preview",
            ...(isScad ? ["--view=edges"] : []),
            "--viewall",
            "--autocenter",
            `--imgsize=${req.size},${req.size}`,
            `--camera=0,0,0,${rx},${ry},${rz},0`,
            `--projection=${view === "iso" ? "p" : "o"}`,
            `--colorscheme=${COLOR_SCHEME}`,
            "-o",
            out,
            ...defines,
            isScad ? file : wrapper,
          ],
          isScad ? dirname(file) : cacheDir,
          true,
        );
        if (r.code !== 0 || !(await exists(out))) throw new RenderError(`${view} view failed:\n${r.stderr.trim()}`);
        cells.push({ view, png: new Uint8Array(await readFile(out)) });
      }

      // 4. Sheet, meta, publish atomically.
      progress("sheet", 2 + views.length);
      await writeFile(join(tmp, "sheet.png"), composeSheet(cells, req.size));
      await rm(wrapper, { force: true });
      await writeFile(join(tmp, "meta.json"), `${JSON.stringify({ meshKey: geometry.key, views, size: req.size })}\n`);
      await publish(tmp, dir, "meta.json");
      return { ...result, cached: false, seconds: elapsed(started) };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };

  // ---- check -------------------------------------------------------------------------

  const check = async (req: { file: string; searchPaths: string[]; params?: ParamValues }): Promise<CheckOutput> => {
    if ((await version()) === null) throw new RenderError(`OpenSCAD cannot be run (command: ${cmd.join(" ")})`);
    const file = resolve(req.file);
    const defines = defineArgs(req.params);
    await mkdir(cacheDir, { recursive: true });
    const tmp = await mkdtemp(join(cacheDir, ".check-"));
    try {
      const echo = join(tmp, "check.echo");
      const env = { ...process.env, OPENSCADPATH: req.searchPaths.join(":") };
      const r = await run([...cmd, "-o", echo, ...defines, file], { cwd: dirname(file), env, timeoutMs: CHECK_TIMEOUT_MS }).catch((e: unknown) => {
        throw new RenderError(`OpenSCAD cannot be run: ${e instanceof Error ? e.message : String(e)}`);
      });
      const echoText = await readFile(echo, "utf8").catch(() => "");
      const text = `${echoText}\n${r.stderr}`;
      const diagnostics: Diagnostic[] = parseDiagnostics(text).map((d) => ({ ...d, file: d.file === null ? null : resolve(dirname(file), d.file) }));
      if (r.timedOut) diagnostics.push({ level: "error", message: `check timed out after ${CHECK_TIMEOUT_MS / 1000} s`, file: null, line: null });
      else if (r.code !== 0 && !diagnostics.some((d) => d.level === "error")) {
        diagnostics.push({ level: "error", message: r.stderr.trim().split("\n").pop() || `OpenSCAD exited with code ${r.code}`, file: null, line: null });
      }
      const log = text.split(/\r?\n/).filter((l) => l.startsWith("ECHO:"));
      return { ok: r.code === 0 && !r.timedOut && !diagnostics.some((d) => d.level === "error"), diagnostics, log: [...new Set(log)] };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };

  // ---- measuring on a finished render -------------------------------------------------

  const keyDir = async (key: string): Promise<string> => {
    if (!/^[0-9a-f]{16,128}$/.test(key)) throw new RenderError(`not a render key: ${key}`);
    const dir = join(meshCache, key);
    if (!(await exists(join(dir, "mesh.stl")))) throw new RenderError(`no finished mesh with key ${key}`);
    return dir;
  };

  /** A JSON result cached as `name` in `dir`: computed once, then read back. */
  const cachedJson = async <T>(dir: string, name: string, compute: () => Promise<T>): Promise<T> => {
    const path = join(dir, name);
    const hit = await readFile(path, "utf8").then(
      (t) => JSON.parse(t) as T,
      () => null,
    );
    if (hit !== null) return hit;
    const value = await compute();
    await writeAtomic(path, `${JSON.stringify(value)}\n`);
    return value;
  };

  const ask = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      throw e instanceof RenderError ? e : new RenderError(e instanceof Error ? e.message : String(e));
    }
  };

  const analyse = (req: { key: string; overhangDeg: number }): Promise<MeshAnalysisOutput> =>
    ask(async () => {
      const dir = await keyDir(req.key);
      return cachedJson(dir, `analysis-${numName(req.overhangDeg)}.json`, async () => {
        const r = await measure.ask({ op: "analyse", mesh: join(dir, "mesh.stl"), overhangDeg: req.overhangDeg });
        let thicknessFile: string | null = null;
        if (r.analysis.wall !== null) {
          thicknessFile = THICKNESS_FILE;
          await writeAtomic(join(dir, THICKNESS_FILE), new Uint8Array(r.thickness.buffer, r.thickness.byteOffset, r.thickness.byteLength));
        }
        return { ...r.analysis, thicknessFile };
      });
    });

  const slice = (req: { key: string; axis: Axis; at: number | null }): Promise<SliceResult> =>
    ask(async () => {
      checkAxis(req.axis);
      const dir = await keyDir(req.key);
      const cache = req.at === null ? `shadow-${req.axis}.json` : `slice-${req.axis}-${numName(req.at)}.json`;
      return cachedJson(dir, cache, async () => {
        const r = await measure.ask({ op: "slice", mesh: join(dir, "mesh.stl"), axis: req.axis, at: req.at });
        return r.result;
      });
    });

  const projectField = async (dir: string, fieldFile: string): Promise<string> => {
    const name = fieldFile.replace(/\.f32$/, "-proxy.f32");
    if (await exists(join(dir, name))) return name;
    const map = await readFile(join(dir, PROXY_MAPPING));
    const field = await readFile(join(dir, fieldFile));
    const indices = new Uint32Array(map.buffer, map.byteOffset, map.length / 4);
    const values = new Float32Array(field.buffer, field.byteOffset, field.length / 4);
    const projected = Float32Array.from(indices, (i) => values[i]!);
    await writeAtomic(join(dir, name), new Uint8Array(projected.buffer));
    return name;
  };

  const features: Renderer["features"] = (req) =>
    ask(async () => {
      const dir = await keyDir(req.key);
      return cachedJson(dir, "features.json", async () => {
        const full = join(dir, "mesh.stl");
        const info = (await readMeshMeta(dir))?.info ?? (await measure.ask({ op: "info", file: full })).info;
        const meshFile = basename(await queue.run(() => drawMeshPath(dir, info)));
        const r = await measure.ask({ op: "features", mesh: full });
        await writeAtomic(join(dir, "features.f32"), new Uint8Array(r.values.buffer, r.values.byteOffset, r.values.byteLength));
        const fieldFile = meshFile === "proxy.stl" ? await projectField(dir, "features.f32") : "features.f32";
        return { features: r.features, fieldFile, meshFile };
      });
    });

  const fit = (req: { key: string; at: Vec3; kind?: FeatureKind }) =>
    ask(async () => {
      const dir = await keyDir(req.key);
      const { feature } = await measure.ask({ op: "fit", mesh: join(dir, "mesh.stl"), at: req.at, ...(req.kind ? { kind: req.kind } : {}) });
      return feature;
    });

  const align: Renderer["align"] = ({ key, to }) =>
    ask(async () => {
      const dir = await keyDir(key);
      const target = to ? join(await keyDir(to), "mesh.stl") : undefined;
      const { result } = await measure.ask({ op: "align", mesh: join(dir, "mesh.stl"), ...(target ? { to: target } : {}) });
      return result;
    });

  const probe = (req: { key: string; from: Vec3; axis: Axis }): Promise<ProbeResult> =>
    ask(async () => {
      checkAxis(req.axis);
      const dir = await keyDir(req.key);
      return cachedJson(dir, `probe-${req.axis}-${req.from.map(numName).join("_")}.json`, async () => {
        const r = await measure.ask({ op: "probe", mesh: join(dir, "mesh.stl"), from: req.from, axis: req.axis });
        return r.probe;
      });
    });

  const deviation: Renderer["deviation"] = (req) =>
    ask(async () => {
      const dirA = await keyDir(req.a);
      const dirB = await keyDir(req.b);
      const name = `deviation-${req.a}-${numName(req.tol)}`;
      const fieldFile = `${name}.f32`;
      const stats = await cachedJson(dirB, `${name}.json`, async () => {
        const r = await measure.ask({ op: "deviation", a: join(dirA, "mesh.stl"), b: join(dirB, "mesh.stl"), tol: req.tol });
        const { field, ...stats } = r.result;
        await writeAtomic(join(dirB, fieldFile), new Uint8Array(field.buffer, field.byteOffset, field.byteLength));
        return stats;
      });
      if (req.proxy) return { ...stats, fieldFile: await projectField(dirB, fieldFile), meshFile: "proxy.stl" } satisfies DeviationOutput;
      return { ...stats, fieldFile, meshFile: "mesh.stl" } satisfies DeviationOutput;
    });

  /** One OpenSCAD run outside render(): cwd is the cache directory, so every mesh.stl is reachable. */
  const openscadOnce = async (args: string[], png: boolean): Promise<RunResult> => {
    if ((await version()) === null) throw new RenderError(`OpenSCAD cannot be run (command: ${cmd.join(" ")})`);
    const r = await run([...(png ? pngPrefix() : []), ...cmd, ...args], { cwd: cacheDir, env: process.env, timeoutMs }).catch((e: unknown) => {
      throw new RenderError(`OpenSCAD cannot be run: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (r.timedOut) throw new RenderError(`OpenSCAD timed out after ${timeoutMs / 1000} s\n${r.stderr.trim()}`.trim());
    return r;
  };

  const interference: Renderer["interference"] = (req) =>
    ask(async () => {
      const dirA = await keyDir(req.a.key);
      const dirB = await keyDir(req.b.key);
      for (const m of [req.a.matrix, req.b.matrix]) {
        if (m.length !== 16 || !m.every(Number.isFinite)) throw new RenderError("a placement matrix is 16 finite numbers, row-major");
      }
      const id = hashParts([PIPELINE_VERSION, req.a.matrix.join(","), req.b.key, req.b.matrix.join(","), String(req.clearanceMm ?? 0)]).slice(0, 32);
      return cachedJson<Awaited<ReturnType<Renderer["interference"]>>>(dirA, `interference-${id}.json`, async () => {
        const meshA = join(dirA, "mesh.stl");
        const meshB = join(dirB, "mesh.stl");
        const g = await measure.ask({ op: "gap", a: { mesh: meshA, matrix: req.a.matrix }, b: { mesh: meshB, matrix: req.b.matrix }, clearanceMm: req.clearanceMm ?? 0 });
        if (g.penetration) return { gapMm: g.gapMm, overlapCm3: null, penetration: g.penetration };
        if (g.disjoint || g.gapMm > CLEAR_GAP_MM) return { gapMm: g.gapMm, overlapCm3: 0 };
        const overlapCm3 = await queue.run(async () => {
          await mkdir(cacheDir, { recursive: true });
          const tmp = await mkdtemp(join(cacheDir, ".overlap-"));
          try {
            const wrapper = join(tmp, "overlap.scad");
            const out = join(tmp, "overlap.stl");
            await writeFile(wrapper, `intersection() {\n  multmatrix(${matrixScad(req.a.matrix)}) import(${JSON.stringify(meshA)}, convexity = 10);\n  multmatrix(${matrixScad(req.b.matrix)}) import(${JSON.stringify(meshB)}, convexity = 10);\n}\n`);
            const r = await openscadOnce(["--backend=Manifold", "--export-format", "binstl", "-o", out, wrapper], false);
            if (!(await exists(out))) {
              // An empty intersection is no overlap; OpenSCAD refuses to export it.
              if (/empty/i.test(r.stderr)) return 0;
              throw new RenderError(r.stderr.trim() || `OpenSCAD exited with code ${r.code}`);
            }
            return roundTo(Math.abs((await measure.ask({ op: "volume", mesh: out })).mm3) / 1000, 6);
          } finally {
            await rm(tmp, { recursive: true, force: true });
          }
        });
        return { gapMm: g.gapMm, overlapCm3 };
      });
    });

  const section = (req: { key: string; axis: Axis; at: number; size: number }): Promise<string> =>
    ask(async () => {
      checkAxis(req.axis);
      if (!Number.isInteger(req.size) || req.size < 16 || req.size > MAX_SIZE) throw new RenderError(`size must be an integer from 16 to ${MAX_SIZE}`);
      const dir = await keyDir(req.key);
      const name = `section-${req.axis}-${numName(req.at)}-${req.size}.png`;
      if (await exists(join(dir, name))) return name;
      const meshPath = join(dir, "mesh.stl");
      const { min, max } = (await readMeshMeta(dir))?.info.bbox ?? (await measure.ask({ op: "info", file: meshPath })).info.bbox;
      const ai = AXIS_INDEX[req.axis];
      if (!(req.at > min[ai]! && req.at <= max[ai]!)) throw new RenderError(`the cut at ${req.axis} = ${req.at} misses the part (${min[ai]} to ${max[ai]})`);
      const margin = 1 + Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
      const lo: Vec3 = [min[0] - margin, min[1] - margin, min[2] - margin];
      const hi: Vec3 = [max[0] + margin, max[1] + margin, max[2] + margin];
      hi[ai] = req.at;
      const sizeV = hi.map((h, i) => h - lo[i]!);
      return queue.run(async () => {
        const tmp = await mkdtemp(join(cacheDir, ".section-"));
        try {
          const wrapper = join(tmp, "section.scad");
          const out = join(tmp, name);
          await writeFile(wrapper, `intersection() {\n  import(${JSON.stringify(meshPath)}, convexity = 10);\n  translate([${lo.join(", ")}]) cube([${sizeV.join(", ")}]);\n}\n`);
          const [rx, ry, rz] = SECTION_CAMERA[req.axis];
          const r = await openscadOnce(
            ["--backend=Manifold", "--render", "--viewall", "--autocenter", `--imgsize=${req.size},${req.size}`, `--camera=0,0,0,${rx},${ry},${rz},0`, "--projection=o", `--colorscheme=${COLOR_SCHEME}`, "-o", out, wrapper],
            true,
          );
          if (r.code !== 0 || !(await exists(out))) throw new RenderError(`section failed:\n${r.stderr.trim()}`);
          await rename(out, join(dir, name));
          return name;
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      });
    });

  const thumbnail = (req: { key: string; view: RenderView; size: number }): Promise<string> =>
    ask(async () => {
      if (!ALL_VIEW_NAMES.includes(req.view)) throw new RenderError(`not a view: ${req.view}`);
      if (!Number.isInteger(req.size) || req.size < 16 || req.size > MAX_SIZE) throw new RenderError(`size must be an integer from 16 to ${MAX_SIZE}`);
      if (!/^[0-9a-f]{16,128}$/.test(req.key)) throw new RenderError(`not a render key: ${req.key}`);
      const dir = join(renderCache, req.key);
      const name = `thumb-${req.view}-${req.size}.png`;
      if (await exists(join(dir, name))) return name;
      const source = await readFile(join(dir, `${req.view}.png`)).catch(() => {
        throw new RenderError(`the render ${req.key} has no ${req.view} view`);
      });
      await writeAtomic(join(dir, name), scaleDown(new Uint8Array(source), req.size));
      return name;
    });

  const renderAssembly = (req: { instances: (PlacedMesh & { id: string })[]; highlight: string[]; views: RenderView[]; size: number }): Promise<AssemblyRenderOutput> =>
    ask(async () => {
      const views = [...new Set(req.views)];
      if (views.length === 0) throw new RenderError("no views requested");
      if (req.instances.length === 0) throw new RenderError("an assembly needs at least one instance");
      if (!Number.isInteger(req.size) || req.size < 16 || req.size > MAX_SIZE) throw new RenderError(`size must be an integer from 16 to ${MAX_SIZE}`);
      const openscad = await version();
      if (openscad === null) throw new RenderError(`OpenSCAD cannot be run (command: ${cmd.join(" ")})`);
      const meshes: string[] = [];
      for (const inst of req.instances) {
        if (inst.matrix.length !== 16 || !inst.matrix.every(Number.isFinite)) throw new RenderError(`instance ${inst.id}: a placement matrix is 16 finite numbers, row-major`);
        meshes.push(await keyDir(inst.key));
      }
      const highlight = new Set(req.highlight);
      const key = hashParts([
        PIPELINE_VERSION,
        "assembly",
        openscad,
        views.join(","),
        String(req.size),
        ...req.instances.map((i) => `${i.key}|${i.matrix.join(",")}|${highlight.has(i.id) ? "1" : "0"}`),
      ]);
      const dir = join(renderCache, key);
      if (await exists(join(dir, ASSEMBLY_MARKER))) return { key, cached: true, dir, views };
      return queue.run(async () => {
        await mkdir(renderCache, { recursive: true });
        const tmp = await mkdtemp(join(renderCache, ".tmp-"));
        try {
          const wrapper = join(tmp, "assembly.scad");
          const paths: string[] = [];
          for (const dir of meshes) {
            const full = join(dir, "mesh.stl");
            const info = (await readMeshMeta(dir))?.info ?? (await measure.ask({ op: "info", file: full })).info;
            paths.push(await drawMeshPath(dir, info));
          }
          const body = req.instances
            .map((inst, i) => {
              const colour = highlight.has(inst.id) ? HIGHLIGHT_COLOUR : PALETTE[i % PALETTE.length]!;
              return `// ${inst.id.replace(/[\r\n]/g, " ")}\ncolor(${JSON.stringify(colour)}) multmatrix(${matrixScad(inst.matrix)}) import(${JSON.stringify(paths[i])}, convexity = 10);`;
            })
            .join("\n");
          await writeFile(wrapper, `${body}\n`);
          const cells: { view: RenderView; png: Uint8Array }[] = [];
          for (const view of views) {
            const out = join(tmp, `${view}.png`);
            const [rx, ry, rz] = CAMERA[view];
            const r = await openscadOnce(
              ["--backend=Manifold", "--preview", "--viewall", "--autocenter", `--imgsize=${req.size},${req.size}`, `--camera=0,0,0,${rx},${ry},${rz},0`, `--projection=${view === "iso" ? "p" : "o"}`, `--colorscheme=${COLOR_SCHEME}`, "-o", out, wrapper],
              true,
            );
            if (r.code !== 0 || !(await exists(out))) throw new RenderError(`${view} view failed:\n${r.stderr.trim()}`);
            cells.push({ view, png: new Uint8Array(await readFile(out)) });
          }
          await writeFile(join(tmp, "sheet.png"), composeSheet(cells, req.size));
          await rm(wrapper, { force: true });
          await writeFile(join(tmp, ASSEMBLY_MARKER), `${JSON.stringify({ key, instances: req.instances, highlight: [...highlight], views, size: req.size, openscad, createdAt: new Date().toISOString() }, null, 2)}\n`);
          try {
            await rename(tmp, dir);
          } catch (e) {
            if (!(await exists(join(dir, ASSEMBLY_MARKER)))) throw e;
          }
          return { key, cached: false, dir, views };
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      });
    });

  return {
    version,
    render: (req) => {
      req.onProgress?.({ stage: "queued", step: 0, total: new Set(req.views).size + 3, view: null });
      return ask(() => queue.run(() => render(req)));
    },
    mesh: (req) => ask(() => queue.run(() => mesh(req, () => {}, Date.now() + timeoutMs))),
    meshInfo: async (file) => (await measure.ask({ op: "info", file })).info,
    normalizeScan: (req) => ask(async () => (await measure.ask({ op: "normalize", ...req })).scan),
    check: (req) => checkQueue.run(() => check(req)),
    params: (source) => parseParams(source),
    applyParams: (source, values) => applyParams(source, values),
    analyse,
    slice,
    features,
    fit,
    align,
    probe,
    section,
    thumbnail,
    deviation,
    interference,
    renderAssembly,
  };
}

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };
const ALL_VIEW_NAMES: readonly RenderView[] = ["iso", "front", "top", "side"];

function checkAxis(axis: string): asserts axis is Axis {
  if (axis !== "x" && axis !== "y" && axis !== "z") throw new RenderError(`axis must be x, y or z, not ${axis}`);
}

/** A number as part of a cache file name: only [0-9a-z.-]. */
function numName(n: number): string {
  if (!Number.isFinite(n)) throw new RenderError(`${n} is not a finite number`);
  return String(n).toLowerCase().replace("+", "");
}

function matrixScad(m: number[]): string {
  return `[${[0, 1, 2, 3].map((r) => `[${m.slice(r * 4, r * 4 + 4).join(", ")}]`).join(", ")}]`;
}

function roundTo(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Write then rename, so a reader never sees half a file. */
async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function publish(tmp: string, dir: string, marker: string): Promise<void> {
  try {
    await rename(tmp, dir);
  } catch (err) {
    if (!(await exists(join(dir, marker)))) throw err;
  }
}

async function readMeshMeta(dir: string): Promise<MeshMeta | null> {
  try {
    return JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as MeshMeta;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started) / 1000;
}
