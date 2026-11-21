/**
 * A stand-in for the drawer server, for developing and checking the web app without the real one.
 * In-memory, follows shared/src/api.ts. Never imported by src/, so it is not in the bundle.
 *
 *   MOCK_PORT=3952 bun run dev/mock-server.ts     then   VITE_API_TARGET=http://127.0.0.1:3952 bun run dev
 *
 * Knobs: MOCK_LATENCY (ms per request), MOCK_RENDER_MS, MOCK_EVAL_MS, MOCK_AGENT_MS. Seeded data: dev/mock/seed.ts.
 */
import { HEADER_AUTHOR, HEADER_MESSAGE, HEADER_REV, LIBRARY_SLUG, MATERIALS_FILE, PRINTER_FILE, SCAN_UNITS } from "../../shared/src/api";
import type {
  PatchSettingsBody,
  AlignBody,
  AlignResult,
  AnswerBody,
  AssemblySpec,
  CompareBody,
  CreateProjectBody,
  CreateSessionBody,
  FileAttachmentBody,
  FeaturesBody,
  FitBody,
  EvaluateBody,
  LibraryProfile,
  MaterialsFile,
  MeasureBody,
  PartSpecBody,
  PatchProjectBody,
  PrintBody,
  PrinterProfile,
  ProbeBody,
  RenderResult,
  ScanResult,
  SearchHit,
  SectionBody,
  SessionMessageBody,
  SetParamsBody,
  SliceBody,
  WaiveBody,
} from "../../shared/src/api";
import { cubeStl, meshInfoOfBoxes, meshInfoOfStl, png } from "./mock/geometry";
import * as settings from "./mock/settings";
import { HttpError, STATUS, body, broadcast, eventStream, fail, json, startHeartbeat } from "./mock/http";
import * as parts from "./mock/parts";
import { seed } from "./mock/seed";
import * as sessions from "./mock/sessions";
import { createProject, decoder, encoder, getProject, head, importFixture, importInto, infoOf, kindOf, now, projects, put, record, treeOf, validPath } from "./mock/store";

const PORT = Number(process.env.MOCK_PORT ?? 3951);

const listProjects = () =>
  [...projects.values()]
    .filter((p) => p.meta.slug !== LIBRARY_SLUG)
    .map(parts.projectOut)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** Like the server: printer.json and materials.json as stored, and whether the printer is still the starter's example. */
function libraryProfile(): LibraryProfile {
  const lib = getProject(LIBRARY_SLUG);
  const read = <T>(path: string, fallback: T): T => {
    const v = head(lib, path);
    try {
      return v ? (JSON.parse(decoder.decode(v.bytes)) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const printer = read<PrinterProfile>(PRINTER_FILE, parts.PRINTER);
  return { printer, materials: read<MaterialsFile>(MATERIALS_FILE, { materials: parts.MATERIALS }).materials, printerIsExample: printer.name === "Example FDM printer" };
}

/** Like the server (server/src/library-layout.ts): the library takes writes only in its fixed layout. */
const LIBRARY_PLACES =
  "AGENTS.md, printer.json, materials.json, shared notes as <name>.md or notes/<name>.md, bought parts as parts/<id>.part.json and parts/<id>.scad, shared OpenSCAD modules under lib/ (.scad), and references for bought parts under refs/";
function libraryPlace(path: string): void {
  const seg = path.split("/");
  const name = seg.at(-1) ?? "";
  const ok =
    seg.length === 1
      ? name === PRINTER_FILE || name === MATERIALS_FILE || /^[^.].*\.md$/.test(name)
      : seg[0] === "parts"
        ? seg.length === 2 && /^[a-z0-9][a-z0-9-]*(\.scad|\.part\.json)$/.test(name)
        : seg[0] === "notes"
          ? /^[^.].*\.md$/.test(name)
          : seg[0] === "lib"
            ? /^[^.].*\.scad$/.test(name)
            : seg[0] === "refs";
  if (!ok) throw new HttpError("invalid", `${path} has no place in the library. It holds: ${LIBRARY_PLACES}`);
}
function libraryKeeps(path: string): void {
  if (path === PRINTER_FILE || path === MATERIALS_FILE) throw new HttpError("invalid", `${path} cannot be deleted or moved: change its values instead`);
}

function renderOf(slug: string, path: string, at: string | undefined): RenderResult {
  const kind = kindOf(path);
  if (kind !== "scad" && kind !== "mesh" && !path.endsWith(".part.json")) throw new HttpError("invalid", "Only .scad and mesh files render");
  const p = getProject(slug);
  const v = at ? p.files.get(path)?.versions.find((x) => x.revisionId === at) : head(p, path);
  if (!v) throw new HttpError("not_found", `No such file or revision: ${path}`);
  const text = kind === "scad" ? decoder.decode(v.bytes) : "";
  if (text.includes("FAIL")) throw new HttpError("render_failed", `ERROR: Parser error in file "${path}", line 1: syntax error\nCan't parse file '${path}'!`);
  const boxes = parts.boxesOfFile(slug, path, at);
  const { ref } = parts.renderBoxes(boxes);
  return { project: slug, path, key: ref.key, cached: false, seconds: 1.4, mesh: ref.mesh, views: ref.views, sheet: ref.sheet, info: meshInfoOfBoxes(boxes), log: text.includes("echo(") ? ['ECHO: "size", 20'] : [], warnings: [] };
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = decodeURIComponent(url.pathname);
  const author = req.headers.get(HEADER_AUTHOR) ?? "web";
  const method = req.method;
  await Bun.sleep(Number(process.env.MOCK_LATENCY ?? 40));

  if (!path.startsWith("/api/")) return new Response("mock server: API only", { status: 404 });
  const route = path.slice(4);
  let m: RegExpExecArray | null;

  if (route === "/health") return json({ ok: true, version: "mock", openscad: "mock 2025.01" });
  if (route === "/events") return eventStream();
  if (route === "/guide") return new Response("# Modelling guide (mock)\n", { headers: { "content-type": "text/markdown" } });
  if (route === "/library/profile") return json(libraryProfile());
  if (route === "/runners") return json({ runners: sessions.RUNNERS.map((r) => ({ ...r, lastSeen: now() })) });
  if (route === "/settings" && method === "GET") return json(settings.getSettings());
  if (route === "/settings" && method === "PATCH") {
    const next = settings.patchSettings(await body<PatchSettingsBody>(req), author);
    sessions.reportAfterPoll(next);
    return json(next);
  }

  // ---- projects ----
  if (route === "/projects" && method === "GET") return json({ projects: listProjects() });
  if (route === "/projects" && method === "POST") {
    const b = await body<CreateProjectBody>(req);
    if (!b.slug || !/^[a-z0-9][a-z0-9-]*$/.test(b.slug)) throw new HttpError("invalid", "Invalid slug");
    if (projects.has(b.slug)) throw new HttpError("exists", `Project ${b.slug} exists`);
    const p = createProject(b.slug, b.title ?? b.slug);
    p.meta.description = b.description ?? "";
    p.meta.defaults = { material: b.defaults?.material ?? "PETG", strictness: b.defaults?.strictness ?? "standard" };
    put(p, "AGENTS.md", encoder.encode(`# ${p.meta.title}\n\nProject memory. Read [[brief]] first.\n`), author, "Create project");
    put(p, "brief.md", encoder.encode(`# ${p.meta.title}\n\n${b.brief ?? ""}\n`), author, "Brief");
    if (b.fromUrl) {
      const preview = importFixture(b.fromUrl);
      p.meta.source = { ...preview.source, importedAt: now() };
      importInto(p, b.fromUrl, b.fileIds, undefined);
    }
    broadcast({ type: "project", action: "created", slug: p.meta.slug });
    return json(parts.projectOut(p), 201);
  }

  m = /^\/projects\/([^/]+)$/.exec(route);
  if (m?.[1]) {
    const slug = m[1];
    if (method === "GET") return json(parts.projectOut(getProject(slug)));
    if (method === "PATCH") {
      const p = getProject(slug);
      const b = await body<PatchProjectBody>(req);
      const { defaults, ...rest } = b;
      Object.assign(p.meta, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
      if (defaults) p.meta.defaults = { ...p.meta.defaults, ...defaults };
      p.meta.updatedAt = now();
      p.meta.updatedBy = author;
      broadcast({ type: "project", action: "updated", slug });
      return json(parts.projectOut(p));
    }
    if (method === "DELETE") {
      if (slug === LIBRARY_SLUG) throw new HttpError("invalid", "The library cannot be deleted");
      getProject(slug);
      projects.delete(slug);
      broadcast({ type: "project", action: "deleted", slug });
      return new Response(null, { status: 204 });
    }
  }

  m = /^\/projects\/([^/]+)\/overview$/.exec(route);
  if (m?.[1]) {
    const p = getProject(m[1]);
    const lib = getProject(LIBRARY_SLUG);
    const live = [...p.files.entries()].filter(([, f]) => !f.deleted).map(([k]) => k);
    const text = (k: string) => {
      const v = head(p, k);
      return v ? decoder.decode(v.bytes) : "";
    };
    let assembly = null;
    try {
      const a = parts.currentAssembly(m[1]);
      assembly = { status: a.status, instances: a.instances.length, failing: a.gates.filter((g) => g.status === "fail").map((g) => g.label) };
    } catch {
      assembly = null;
    }
    return json({
      project: parts.projectOut(p),
      brief: text("brief.md"),
      memory: text("AGENTS.md"),
      parts: parts.listParts(m[1]),
      assembly,
      references: live.filter((k) => k.startsWith("refs/")).sort(),
      notes: live.filter((k) => k.startsWith("notes/")).sort(),
      library: { profile: libraryProfile(), notes: [...lib.files.keys()].filter((k) => k.endsWith(".md")).sort(), parts: parts.listParts(LIBRARY_SLUG) },
    });
  }

  m = /^\/projects\/([^/]+)\/thumbnail\/([0-9a-f]{32})\.png$/.exec(route);
  if (m?.[1] && m[2]) {
    const p = parts.projectOut(getProject(m[1]));
    if (!p.cover || !p.thumbnail?.endsWith(`/${m[2]}.png`)) return fail("not_found", "This thumbnail is out of date", 404);
    try {
      const png = parts.previews.get(renderOf(m[1], p.cover, undefined).key);
      if (!png) return fail("not_found", "Nothing renders", 404);
      return new Response(png, { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable", etag: `"${m[2]}"` } });
    } catch {
      return fail("not_found", "Nothing renders", 404);
    }
  }

  m = /^\/projects\/([^/]+)\/tree$/.exec(route);
  if (m?.[1]) return json({ entries: treeOf(getProject(m[1])) });

  // ---- files ----
  m = /^\/projects\/([^/]+)\/files\/(.+)$/.exec(route);
  if (m?.[1] && m[2]) {
    const slug = m[1];
    const file = validPath(m[2]);
    const p = getProject(slug);
    const rev = req.headers.get(HEADER_REV);
    if (method === "GET") {
      const at = url.searchParams.get("at");
      const f = p.files.get(file);
      const v = at ? f?.versions.find((x) => x.revisionId === at) : head(p, file);
      if (!v) throw new HttpError("not_found", `No file ${file}`);
      const type = kindOf(file) === "image" ? (file.endsWith(".png") ? "image/png" : "image/svg+xml") : kindOf(file) === "pdf" ? "application/pdf" : "application/octet-stream";
      const disposition = url.searchParams.get("download") ? { "content-disposition": `attachment; filename="${file.split("/").pop()}"` } : {};
      return new Response(v.bytes, { headers: { "content-type": type, [HEADER_REV]: v.rev, ...disposition } });
    }
    if (method === "PUT") {
      if (slug === LIBRARY_SLUG) libraryPlace(file);
      const current = head(p, file);
      if (rev !== null && !current) throw new HttpError("not_found", `No file ${file} to overwrite`);
      if (current && rev === null) throw new HttpError("conflict", "x-drawer-rev is required to overwrite", current.rev);
      if (current && rev !== "*" && rev !== current.rev) throw new HttpError("conflict", "The file changed since you read it", current.rev);
      const bytes = new Uint8Array(await req.arrayBuffer());
      const message = decodeURIComponent(req.headers.get(HEADER_MESSAGE) ?? `Write ${file}`);
      const res = put(p, file, bytes, author, message);
      broadcast({ type: "file", action: "written", project: slug, path: file, rev: res.rev, author });
      const part = parts.onPartFileWritten(slug, file, res.revisionId, author, message);
      const check = kindOf(file) === "scad" ? { ok: !decoder.decode(bytes).includes("FAIL"), diagnostics: [] } : null;
      return json({ project: slug, path: file, rev: res.rev, created: res.created, revisionId: res.revisionId, check, part }, res.created ? 201 : 200);
    }
    if (method === "DELETE") {
      if (slug === LIBRARY_SLUG) libraryKeeps(file);
      const recursive = url.searchParams.get("recursive");
      const targets = recursive ? [...p.files.keys()].filter((k) => k === file || k.startsWith(`${file}/`)) : [file];
      if (!recursive) {
        const current = head(p, file);
        if (!current) throw new HttpError("not_found", `No file ${file}`);
        if (rev !== current.rev) throw new HttpError("conflict", "The file changed since you read it", current.rev);
      }
      for (const t of targets) {
        const f = p.files.get(t);
        if (f) f.deleted = true;
        broadcast({ type: "file", action: "deleted", project: slug, path: t, rev: null, author });
      }
      const revision = record(p, author, `Delete ${file}`, targets);
      p.meta.fileCount = [...p.files.values()].filter((x) => !x.deleted).length;
      return json({ revisionId: revision.id });
    }
  }

  m = /^\/projects\/([^/]+)\/move$/.exec(route);
  if (m?.[1] && method === "POST") {
    const slug = m[1];
    const p = getProject(slug);
    const b = await body<{ from: string; to: string }>(req);
    const to = validPath(b.to);
    const moved = [...p.files.keys()].filter((k) => k === b.from || k.startsWith(`${b.from}/`));
    if (moved.length === 0) throw new HttpError("not_found", `Nothing at ${b.from}`);
    if (slug === LIBRARY_SLUG) {
      libraryKeeps(b.from);
      for (const k of moved) libraryPlace(to + k.slice(b.from.length));
    }
    for (const k of moved) if (head(p, to + k.slice(b.from.length))) throw new HttpError("exists", `${to + k.slice(b.from.length)} exists`);
    broadcast({ type: "file", action: "deleted", project: slug, path: b.from, rev: null, author });
    for (const k of moved) {
      const f = p.files.get(k);
      if (!f) continue;
      p.files.delete(k);
      p.files.set(to + k.slice(b.from.length), f);
    }
    broadcast({ type: "file", action: "moved", project: slug, path: to, rev: null, author });
    const revision = record(p, author, `Move ${b.from} to ${to}`, [b.from, to]);
    return json({ revisionId: revision.id });
  }

  m = /^\/projects\/([^/]+)\/info\/(.+)$/.exec(route);
  if (m?.[1] && m[2]) {
    const info = infoOf(m[1], getProject(m[1]), validPath(m[2]));
    if (!info) throw new HttpError("not_found", `No file ${m[2]}`);
    return json(info);
  }

  m = /^\/projects\/([^/]+)\/history$/.exec(route);
  if (m?.[1]) {
    const p = getProject(m[1]);
    const file = url.searchParams.get("path");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return json({ revisions: p.revisions.filter((r) => !file || r.paths.includes(file)).slice(0, limit) });
  }

  m = /^\/projects\/([^/]+)\/render\/(.+)$/.exec(route);
  if (m?.[1] && m[2] && method === "POST") {
    getProject(m[1]);
    const b = await req.json().catch(() => ({}) as { at?: string });
    const at = (b as { at?: string }).at;
    // The stages the real renderer reports, spread over MOCK_RENDER_MS (geometry takes most of it).
    const total = 7;
    const progress = { type: "render_progress", project: m[1], path: m[2], at: at ?? null, total } as const;
    const ms = Number(process.env.MOCK_RENDER_MS ?? 500);
    const stages = [
      { stage: "queued", step: 0, view: null, share: 0.05 },
      { stage: "analysing", step: 0, view: null, share: 0.05 },
      { stage: "geometry", step: 1, view: null, share: 0.5 },
      { stage: "views", step: 2, view: "iso", share: 0.09 },
      { stage: "views", step: 3, view: "front", share: 0.09 },
      { stage: "views", step: 4, view: "top", share: 0.09 },
      { stage: "views", step: 5, view: "side", share: 0.09 },
      { stage: "sheet", step: 6, view: null, share: 0.04 },
    ] as const;
    for (const { share, ...s } of stages) {
      broadcast({ ...progress, ...s });
      await Bun.sleep(ms * share);
    }
    let result: RenderResult;
    try {
      result = renderOf(m[1], validPath(m[2]), at);
    } catch (err) {
      broadcast({ ...progress, stage: "failed", step: 0, view: null });
      throw err;
    }
    broadcast({ ...progress, stage: "done", step: total, view: null });
    broadcast({ type: "render", project: m[1], path: m[2], key: result.key });
    return json(result);
  }

  m = /^\/projects\/([^/]+)\/scans$/.exec(route);
  if (m?.[1] && method === "POST") {
    const project = m[1];
    const p = getProject(project);
    const name = url.searchParams.get("name") ?? "";
    const filename = url.searchParams.get("filename") ?? "";
    const units = SCAN_UNITS.find((unit) => unit === url.searchParams.get("units"));
    const embedded = filename.toLowerCase().endsWith(".3mf");
    if (project === LIBRARY_SLUG || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || kindOf(filename) !== "mesh" || (!embedded && !units)) {
      throw new HttpError("invalid", "Choose a scan name, mesh filename and original units");
    }
    if ((await req.arrayBuffer()).byteLength === 0) throw new HttpError("render_failed", "point cloud has no faces");
    const path = `refs/${name}/scan.stl`;
    const source = `refs/${name}/source.md`;
    if (head(p, path) || head(p, source)) throw new HttpError("exists", `refs/${name} already exists`);
    const size = units === "in" ? 25.4 : units === "m" ? 1000 : units === "cm" ? 10 : 1;
    const stl = cubeStl(embedded ? 10 : size * 10);
    const mesh = meshInfoOfStl(stl);
    const noiseMm = 0.02;
    const message = `add scan ${name}`;
    const revision = record(p, author, message, [path, source]);
    const note = encoder.encode(`# Scan source\n\n- [filename] ${JSON.stringify(filename)}\n- [closed] true\n- [noise_mm] ${noiseMm}\n`);
    for (const [file, bytes] of [[path, stl], [source, note]] as const) {
      const saved = put(p, file, bytes, author, message, revision);
      broadcast({ type: "file", action: "written", project, path: file, rev: saved.rev, author });
    }
    return json({ project, path, source, revisionId: revision.id, mesh, noiseMm } satisfies ScanResult, 201);
  }

  // ---- measuring ----
  m = /^\/projects\/([^/]+)\/(measure|align|features|fit|slice|probe|section)\/(.+)$/.exec(route);
  if (m?.[1] && m[2] && m[3] && method === "POST") {
    const [, slug, op, file] = m;
    await Bun.sleep(150);
    switch (op) {
      case "measure": {
        const b = await body<MeasureBody>(req);
        return json(parts.measure(slug, validPath(file), b.revision));
      }
      case "align": {
        const b = await body<AlignBody>(req);
        const shape = parts.boxesOfFile(slug, validPath(file), b.revision);
        const { min } = meshInfoOfBoxes(shape).bbox;
        return json({ rotate: [0, 0, 0], translate: [-min[0], -min[1], -min[2]], rms: b.to ? 0 : null, ambiguous: [] } satisfies AlignResult);
      }
      case "features": {
        const b = await body<FeaturesBody>(req);
        return json(parts.featuresOfFile(slug, validPath(file), b.revision));
      }
      case "fit": {
        const b = await body<FitBody>(req);
        const result = parts.featuresOfFile(slug, validPath(file), b.revision).features.find((feature) => !b.kind || feature.kind === b.kind);
        if (!result) throw new HttpError("render_failed", "No fitting surface at that point");
        return json(result);
      }
      case "slice": {
        const b = await body<SliceBody>(req);
        return json(parts.slice(slug, validPath(file), b.axis, b.shadow ? null : b.at ?? 0, b.revision));
      }
      case "probe": {
        const b = await body<ProbeBody>(req);
        return json(parts.probe(slug, validPath(file), b.from, b.axis, b.revision));
      }
      default: {
        const b = await body<SectionBody>(req);
        return json(parts.section(slug, validPath(file), b.axis, b.at, b.revision));
      }
    }
  }

  m = /^\/projects\/([^/]+)\/compare$/.exec(route);
  if (m?.[1] && method === "POST") {
    const b = await body<CompareBody>(req);
    await Bun.sleep(300);
    return json(parts.compare(m[1], b.a, b.b));
  }

  // ---- parts ----
  m = /^\/projects\/([^/]+)\/parts$/.exec(route);
  if (m?.[1] && method === "GET") return json({ parts: parts.listParts(m[1]) });

  m = /^\/projects\/([^/]+)\/parts\/([^/]+)(?:\/([a-z]+))?$/.exec(route);
  if (m?.[1] && m[2]) {
    const [, slug, id, action] = m;
    if (!action && method === "PUT") {
      const b = await body<PartSpecBody>(req);
      if (slug === LIBRARY_SLUG && b.source !== "bought") throw new HttpError("invalid", `a library part is bought hardware: give parts/${id}.part.json source "bought"; a printed part belongs in its project`);
      return json(parts.putPart(slug, id, b, author));
    }
    if (!action && method === "DELETE") return json({ revisionId: parts.deletePart(slug, id, author) });
    if (action === "report" && method === "GET") {
      parts.specOf(getProject(slug), id);
      return json(parts.currentReport(slug, id));
    }
    if (action === "evaluate" && method === "POST") {
      const b = await body<EvaluateBody>(req);
      await Bun.sleep(b.params ? 250 : 400);
      return json(b.params || b.at ? parts.computeReport(slug, id, { at: b.at, params: b.params }) : parts.currentReport(slug, id));
    }
    if (action === "params" && method === "POST") return json(parts.setParams(slug, id, await body<SetParamsBody>(req), author));
    if (action === "waive" && method === "POST") return json(parts.waive(slug, id, await body<WaiveBody>(req), author));
    if (action === "prints" && method === "POST") return json(parts.recordPrint(slug, id, await body<PrintBody>(req), author));
    if (action === "attempts" && method === "GET") return json({ attempts: parts.attemptsOf(slug, id) });
    if (action === "restore" && method === "POST") return json(parts.restore(slug, id, (await body<{ revisionId: string }>(req)).revisionId, author));
  }

  // ---- assembly ----
  m = /^\/projects\/([^/]+)\/assembly(\/evaluate)?$/.exec(route);
  if (m?.[1]) {
    const slug = m[1];
    if (method === "GET") return json(parts.currentAssembly(slug));
    if (method === "PUT") return json(parts.putAssembly(slug, await body<AssemblySpec>(req), author));
    if (method === "POST" && m[2]) {
      await Bun.sleep(300);
      return json(parts.computeAssembly(slug));
    }
  }

  // ---- sessions ----
  if (route === "/sessions" && method === "GET") return json({ sessions: sessions.listSessions(url.searchParams.get("project")) });
  m = /^\/projects\/([^/]+)\/sessions$/.exec(route);
  if (m?.[1] && method === "POST") {
    const b = await body<CreateSessionBody>(req);
    return json(sessions.createSession(m[1], b.message ?? "", b.refs ?? [], b.attachments ?? [], author, b.provider, b.model), 201);
  }
  m = /^\/projects\/([^/]+)\/attachments$/.exec(route);
  if (m?.[1] && method === "POST") {
    const name = url.searchParams.get("name") ?? "";
    if (!name.trim()) throw new HttpError("invalid", "name is required (the file name)");
    return json(sessions.uploadAttachment(m[1], name, new Uint8Array(await req.arrayBuffer())), 201);
  }
  m = /^\/attachments\/([^/]+)(\/file)?$/.exec(route);
  if (m?.[1]) {
    if (!m[2] && method === "GET") {
      const a = sessions.attachmentBytes(m[1]);
      const disposition = url.searchParams.get("download") ? { "content-disposition": `attachment; filename="${a.attachment.name}"` } : {};
      return new Response(a.bytes, { headers: { "content-type": a.attachment.mediaType, ...disposition } });
    }
    if (m[2] && method === "POST") {
      const b = await body<FileAttachmentBody>(req);
      return json(sessions.fileAttachment(m[1], b.path, b.rev, author, b.message));
    }
  }
  m = /^\/sessions\/([^/]+)(?:\/([a-z]+))?$/.exec(route);
  if (m?.[1]) {
    const [, id, action] = m;
    if (!action && method === "GET") {
      const since = url.searchParams.get("since");
      return json(sessions.detail(id, since === null ? null : Number(since)));
    }
    if (!action && method === "DELETE") {
      sessions.remove(id);
      return new Response(null, { status: 204 });
    }
    if (action === "messages" && method === "POST") {
      const b = await body<SessionMessageBody>(req);
      return json(sessions.message(id, b.text ?? "", b.refs ?? [], b.attachments ?? [], author));
    }
    if (action === "stop" && method === "POST") return json(sessions.stop(id));
    if (action === "answer" && method === "POST") {
      const b = await body<AnswerBody>(req);
      return json(sessions.answer(id, b.questionId, b.answers));
    }
  }

  // ---- imports ----
  m = /^\/projects\/([^/]+)\/import$/.exec(route);
  if (m?.[1] && method === "POST") {
    const p = getProject(m[1]);
    const b = await body<{ url: string; fileIds?: string[]; name?: string }>(req);
    const result = importInto(p, b.url, b.fileIds, b.name);
    for (const w of result.written) broadcast({ type: "file", action: "written", project: m[1], path: w, rev: head(p, w)?.rev ?? null, author: "import" });
    return json(result);
  }

  if (route === "/import/preview" && method === "POST") {
    const b = await body<{ url?: string }>(req);
    try {
      new URL(b.url ?? "");
    } catch {
      throw new HttpError("invalid", "That is not a URL");
    }
    await Bun.sleep(300);
    return json(importFixture(b.url ?? ""));
  }

  // ---- render outputs: meshes, views, fields ----
  m = /^\/renders\/([^/]+)\/(.+)$/.exec(route);
  if (m?.[1] && m[2]) {
    const immutable = { "cache-control": "public, max-age=31536000, immutable" };
    const mesh = parts.meshes.get(m[1]);
    if (mesh && m[2] === "mesh.stl") return new Response(mesh.stl, { headers: { "content-type": "model/stl", ...immutable } });
    if (mesh && m[2].endsWith(".f32")) {
      const field = mesh.fields.get(m[2]);
      if (!field) throw new HttpError("not_found", `No field ${m[2]}`);
      return new Response(field, { headers: { "content-type": "application/octet-stream", ...immutable } });
    }
    if (mesh && m[2].startsWith("section-")) return new Response(png(256, 256, 120), { headers: { "content-type": "image/png", ...immutable } });
    const view = parts.previews.get(m[1]);
    if (!view) throw new HttpError("not_found", "No such render");
    return new Response(view, { headers: { "content-type": "image/png", ...immutable } });
  }

  m = /^\/projects\/([^/]+)\/search$/.exec(route);
  if (m?.[1]) {
    const p = getProject(m[1]);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (q === "") throw new HttpError("invalid", "q is required");
    const kindFilter = url.searchParams.get("kind");
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const hits: SearchHit[] = [];
    for (const [file, f] of p.files) {
      const v = f.deleted ? null : f.versions[0];
      if (!v) continue;
      const kind = kindOf(file);
      if (kindFilter && kind !== kindFilter) continue;
      const text = ["markdown", "scad", "text"].includes(kind) ? decoder.decode(v.bytes) : "";
      const i = `${file}\n${text}`.toLowerCase().indexOf(q);
      if (i < 0) continue;
      const at = text.toLowerCase().indexOf(q);
      const snippet = at < 0 ? file : `${text.slice(Math.max(0, at - 30), at)}«${text.slice(at, at + q.length)}»${text.slice(at + q.length, at + q.length + 50)}`.replace(/\n/g, " ");
      hits.push({ path: file, kind, title: /^#\s+(.+)$/m.exec(text)?.[1] ?? file.split("/").pop() ?? file, snippet, score: -i });
    }
    return json({ hits: hits.sort((a, b) => b.score - a.score).slice(0, limit) });
  }

  if (route === "/reindex" && method === "POST") return json({ files: [...projects.values()].reduce((n, p) => n + p.files.size, 0) });

  throw new HttpError("not_found", `No route ${method} ${route}`);
}

seed();

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    try {
      return await handle(req);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.code, err.message, STATUS[err.code], err.rev);
      return fail("internal", err instanceof Error ? err.message : "error", 500);
    }
  },
});

startHeartbeat();
