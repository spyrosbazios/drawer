/**
 * The parity check: what the server reports for every part of a frozen data folder, recorded once and
 * reproduced after each refactoring step. A step that changes a status, a gate or a measurement shows up
 * here even where no test covers it.
 *
 *   bun scripts/parity.ts record <data folder> <baseline folder>
 *   bun scripts/parity.ts check <baseline folder> [--tolerance 1e-9]
 *
 * `record` copies the data folder's projects into the baseline, so later runs measure the same input, and
 * stores the reports beside them. The baseline holds real projects: keep it outside this repository.
 * Both commands work on a temporary copy and never write to the folder they read. They run the real
 * OpenSCAD named by DRAWER_OPENSCAD (AGENTS.md → Develop).
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createImporters } from "../importers/src/index";
import { createRenderer } from "../render/src/index";
import { createApp } from "../server/src/app";

/** Fields that differ between two runs of the same code on the same input. */
const VOLATILE = new Set(["seconds", "evaluatedAt"]);
/** A render's address holds its cache key, which changes whenever the pipeline version does. */
const RENDER_KEY = /\/api\/renders\/[0-9a-f]+\//g;
const DEFAULT_TOLERANCE = 1e-9;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A report without what legitimately differs from run to run: timings, and the cache keys inside render addresses. */
export function normalise(value: Json): Json {
  if (typeof value === "string") return value.replace(RENDER_KEY, "/api/renders/*/");
  if (Array.isArray(value)) return value.map(normalise);
  if (!isRecord(value)) return value;
  const out: { [key: string]: Json } = {};
  for (const [key, child] of Object.entries(value)) {
    if (VOLATILE.has(key)) continue;
    if (key === "render" && isRecord(child)) {
      const { key: _cacheKey, ...rest } = child;
      out[key] = normalise(rest);
    } else out[key] = normalise(child);
  }
  return out;
}

function show(value: Json | undefined): string {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Every place `actual` departs from `expected`. Numbers may differ by `tolerance`, relative above 1. */
export function differences(expected: Json | undefined, actual: Json | undefined, tolerance: number, path = ""): string[] {
  const where = path === "" ? "(whole report)" : path;
  if (expected === undefined || actual === undefined) return expected === actual ? [] : [`${where}: ${show(expected)} -> ${show(actual)}`];
  if (typeof expected === "number" && typeof actual === "number") {
    const allowed = tolerance * Math.max(1, Math.abs(expected), Math.abs(actual));
    return Math.abs(expected - actual) <= allowed ? [] : [`${where}: ${expected} -> ${actual}`];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const found: string[] = [];
    if (expected.length !== actual.length) found.push(`${where}: ${expected.length} entries -> ${actual.length}`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) found.push(...differences(expected[i], actual[i], tolerance, `${path}[${i}]`));
    return found;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap((key) => differences(expected[key], actual[key], tolerance, path === "" ? key : `${path}.${key}`));
  }
  return expected === actual ? [] : [`${where}: ${show(expected)} -> ${show(actual)}`];
}

interface Collected {
  /** Report file (relative to the baseline's `reports/`) → its normalised content. */
  reports: Map<string, Json>;
  /** Seconds each report took, by the same name. */
  seconds: Record<string, number>;
  openscad: string | null;
}

/** Evaluates every part and assembly of the projects under `dataDir`, on a temporary copy of them. */
async function collect(dataDir: string, openscadCmd: string): Promise<Collected> {
  const work = await mkdtemp(join(tmpdir(), "drawer-parity-"));
  try {
    await cp(join(dataDir, "projects"), join(work, "projects"), { recursive: true, preserveTimestamps: true });
    const renderer = createRenderer({ cacheDir: join(work, "cache"), openscadCmd });
    const app = createApp({ dataDir: work, renderer, importers: createImporters({}), webDist: null, allowedHosts: [] });
    try {
      const reports = new Map<string, Json>();
      const seconds: Record<string, number> = {};
      const get = async (name: string | null, route: string): Promise<Json> => {
        const started = performance.now();
        const response = await app.fetch(new Request(`http://localhost/api/${route}`));
        const body = (await response.json()) as Json;
        const result = response.ok ? body : { httpStatus: response.status, body };
        if (name !== null) {
          reports.set(name, normalise(result));
          seconds[name] = Math.round((performance.now() - started) * 10) / 10000;
        }
        return result;
      };
      const health = await get(null, "health");
      const listed = await get(null, "projects");
      if (!isRecord(listed) || !Array.isArray(listed.projects)) throw new Error(`cannot list projects: ${show(listed)}`);
      for (const project of listed.projects) {
        if (!isRecord(project) || typeof project.slug !== "string") continue;
        const slug = project.slug;
        const parts = await get(null, `projects/${slug}/parts`);
        if (!isRecord(parts) || !Array.isArray(parts.parts)) throw new Error(`cannot list the parts of ${slug}: ${show(parts)}`);
        for (const part of parts.parts) {
          if (isRecord(part) && typeof part.id === "string") await get(`${slug}/parts/${part.id}.json`, `projects/${slug}/parts/${part.id}/report`);
        }
        const assembly = await get(null, `projects/${slug}/assembly`);
        if (!(isRecord(assembly) && assembly.httpStatus === 404)) reports.set(`${slug}/assembly.json`, normalise(assembly));
        // Listed again once every report is in: the summaries then carry the settled statuses.
        await get(`${slug}/parts.json`, `projects/${slug}/parts`);
      }
      return { reports, seconds, openscad: isRecord(health) && typeof health.openscad === "string" ? health.openscad : null };
    } finally {
      await app.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(root, name)));
    else found.push(name);
  }
  return found;
}

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function record(dataDir: string, baseline: string, openscadCmd: string): Promise<number> {
  const repository = resolve(import.meta.dir, "..");
  if (!relative(repository, baseline).startsWith("..")) throw new Error("the baseline holds real projects: keep it outside this repository");
  if ((await readdir(baseline).catch(() => [])).length > 0) throw new Error(`${baseline} is not empty; a baseline is recorded once into a new folder`);
  await mkdir(baseline, { recursive: true });
  await cp(join(dataDir, "projects"), join(baseline, "data", "projects"), { recursive: true, preserveTimestamps: true });
  const { reports, seconds, openscad } = await collect(join(baseline, "data"), openscadCmd);
  for (const [name, report] of reports) {
    await mkdir(dirname(join(baseline, "reports", name)), { recursive: true });
    await writeFile(join(baseline, "reports", name), pretty(report));
  }
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository }).stdout.toString().trim();
  await writeFile(join(baseline, "meta.json"), pretty({ recordedAt: new Date().toISOString(), commit: commit === "" ? null : commit, openscad, seconds }));
  process.stdout.write(`recorded ${reports.size} reports with OpenSCAD ${openscad ?? "(none)"} into ${baseline}\n`);
  return 0;
}

async function check(baseline: string, tolerance: number, openscadCmd: string): Promise<number> {
  const meta = JSON.parse(await readFile(join(baseline, "meta.json"), "utf8")) as { openscad: string | null; seconds: Record<string, number> };
  const { reports, seconds, openscad } = await collect(join(baseline, "data"), openscadCmd);
  const names = [...new Set([...(await filesUnder(join(baseline, "reports"))), ...reports.keys()])].sort();
  const found: string[] = [];
  if (openscad !== meta.openscad) found.push(`OpenSCAD: ${meta.openscad ?? "(none)"} -> ${openscad ?? "(none)"}`);
  for (const name of names) {
    const expected = await readFile(join(baseline, "reports", name), "utf8").then((text) => JSON.parse(text) as Json, () => undefined);
    for (const line of differences(expected, reports.get(name), tolerance)) found.push(`${name}: ${line}`);
  }
  const total = (times: Record<string, number>): string => Object.values(times).reduce((sum, value) => sum + value, 0).toFixed(1);
  process.stdout.write(`${names.length} reports, ${found.length} differences; ${total(seconds)} s now, ${total(meta.seconds)} s when recorded\n`);
  for (const line of found) process.stdout.write(`${line}\n`);
  return found.length === 0 ? 0 : 1;
}

async function main(args: string[]): Promise<number> {
  const openscadCmd = process.env.DRAWER_OPENSCAD;
  const usage = "usage: parity.ts record <data folder> <baseline folder> | parity.ts check <baseline folder> [--tolerance <number>]";
  if (openscadCmd === undefined || openscadCmd === "") throw new Error("set DRAWER_OPENSCAD: the parity check measures real models");
  const [command, first, second, third] = args;
  if (command === "record" && first !== undefined && second !== undefined && third === undefined) return record(resolve(first), resolve(second), openscadCmd);
  if (command === "check" && first !== undefined && (second === undefined || (second === "--tolerance" && third !== undefined))) {
    const tolerance = third === undefined ? DEFAULT_TOLERANCE : Number(third);
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("the tolerance must be a number, zero or more");
    return check(resolve(first), tolerance, openscadCmd);
  }
  throw new Error(usage);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  });
}
