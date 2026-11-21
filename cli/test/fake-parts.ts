/**
 * The modelling half of the fake server: parts, reports, measuring, assemblies, sessions, the guide.
 * Behaviour is driven by markers in the model text so tests can steer a report:
 *   SYNTAX_ERROR  the model does not parse (status failed)
 *   WARN_UNUSED   OpenSCAD warns about a variable
 *   SMALL_BORE    dimension gate dim:bore fails
 *   THIN          min_wall fails, unless a what-if sets wall >= 1.6
 *   NOLINT        lint warns
 */
import type {
  ProviderKind,
  ApiError,
  AssemblyReport,
  AssemblySpec,
  Attempt,
  CompareResult,
  GateResult,
  LibraryProfile,
  MeshAnalysis,
  MeshInfo,
  ParamValues,
  PartReport,
  PartSpec,
  PartSummary,
  Project,
  ProjectOverview,
  RenderRef,
  ReportStatus,
  ScadCheck,
  Session,
  SessionItem,
  WriteResult,
} from "@drawer/shared/api";

export interface StoredFile {
  bytes: Uint8Array;
  rev: string;
  updatedBy: string;
}

/** What the modelling routes need from the file store. */
export interface FakeStore {
  files: Map<string, Map<string, StoredFile>>;
  projects: Map<string, Project>;
  write(project: string, path: string, text: string, author: string, message: string): StoredFile;
  lastRevisionId(): string;
}

export const MESH: MeshInfo = {
  format: "stl",
  closed: true, triangles: 1234,
  bbox: { min: [0, 0, 0], max: [40, 30, 12.5], size: [40, 30, 12.5] },
  volumeCm3: 8.125,
};

const ANALYSIS: MeshAnalysis = {
  shells: 1,
  watertight: true,
  surfaceAreaMm2: 4200,
  baseAreaMm2: 600,
  footprintMm2: 1200,
  overhang: { angle: 45, areaMm2: 12.5, at: [10, 5, 6] },
  wall: { minMm: 1.6, at: [20, 15, 0.8] },
  thickness: null,
};

const PROFILE: LibraryProfile = {
  printer: { name: "Test printer", bed: [220, 220, 250], nozzleMm: 0.4, layerMm: 0.2, minWallMm: 1.2, maxOverhangDeg: 45, maxOverhangAreaMm2: 50, clearance: { sliding: 0.25, press: 0.1 } },
  materials: [{ name: "PETG", densityGCm3: 1.27, minWallMm: 1.2, notes: "tough" }],
  printerIsExample: false,
};

const DEFAULT_SPEC: Omit<PartSpec, "title"> = {
  class: "",
  description: "",
  source: "printed",
  material: "PETG",
  strictness: "standard",
  dimensions: [],
  waivers: [],
  prints: [],
};
const SPEC_FIELDS = new Set(["title", "class", "description", "source", "material", "strictness", "dimensions"]);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function apiError(status: number, error: ApiError["error"], message: string, rev?: string): Response {
  return json(rev === undefined ? { error, message } : { error, message, rev }, status);
}

const dec = new TextDecoder();
const parse = (text: string): Record<string, unknown> => (text.trim() === "" ? {} : (JSON.parse(text) as Record<string, unknown>));

export const partOfPath = (path: string): string | null => /^parts\/([a-z0-9][a-z0-9-]*)\.(?:scad|part\.json)$/.exec(path)?.[1] ?? null;

function refFor(meshKey: string): RenderRef {
  const key = new Bun.CryptoHasher("sha256").update(meshKey).digest("hex").slice(0, 24);
  return {
    key,
    mesh: `/api/renders/${meshKey}/mesh.stl`,
    views: { iso: `/api/renders/${key}/iso.png`, front: `/api/renders/${key}/front.png`, top: `/api/renders/${key}/top.png`, side: `/api/renders/${key}/side.png` },
    sheet: `/api/renders/${key}/sheet.png`,
  };
}

const gate = (id: string, label: string, status: GateResult["status"], extra: Partial<GateResult> = {}): GateResult => ({
  id,
  label,
  status,
  measured: null,
  expected: null,
  detail: null,
  hint: null,
  at: null,
  ...extra,
});

export class FakeModeling {
  /** `<project>/<part>` -> attempts, oldest first. Tests set these. */
  readonly attempts = new Map<string, Attempt[]>();
  readonly sessions = new Map<string, { session: Session; items: SessionItem[] }>();
  private sessionCounter = 0;

  constructor(private readonly store: FakeStore) {}

  // ---- hooks for the file routes ----------------------------------------------------------------

  /** `.scad` writes return OpenSCAD's check. */
  checkFor(path: string, text: string): ScadCheck | null {
    if (!path.endsWith(".scad")) return null;
    const diagnostics: ScadCheck["diagnostics"] = [];
    if (text.includes("SYNTAX_ERROR")) diagnostics.push({ level: "error", message: "syntax error", file: path, line: 1 });
    if (text.includes("WARN_UNUSED")) diagnostics.push({ level: "warning", message: "variable x not specified", file: path, line: 2 });
    return { ok: !diagnostics.some((d) => d.level === "error"), diagnostics };
  }

  writeResult(project: string, path: string, file: StoredFile, created: boolean, text: string): WriteResult {
    return { project, path, rev: file.rev, created, revisionId: this.store.lastRevisionId(), check: this.checkFor(path, text), part: partOfPath(path) };
  }

  addSessionItem(id: string, item: Record<string, unknown>): void {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`no session ${id}`);
    entry.session.seq += 1;
    entry.session.version += 1;
    entry.items.push({ ...item, seq: entry.session.seq, version: entry.session.version, at: new Date().toISOString() } as SessionItem);
  }

  // ---- reports ----------------------------------------------------------------------------------

  private text(project: string, path: string): string | null {
    const file = this.store.files.get(project)?.get(path);
    return file ? dec.decode(file.bytes) : null;
  }

  private spec(project: string, id: string): PartSpec | null {
    const raw = this.text(project, `parts/${id}.part.json`);
    return raw === null ? null : (JSON.parse(raw) as PartSpec);
  }

  private report(project: string, id: string, params?: ParamValues): PartReport | null {
    const spec = this.spec(project, id);
    if (!spec) return null;
    const model = this.text(project, `parts/${id}.scad`);
    const modelRev = this.store.files.get(project)?.get(`parts/${id}.scad`)?.rev ?? "empty";
    const gates: GateResult[] = [];
    if (model !== null && model.includes("SYNTAX_ERROR")) {
      gates.push(gate("parses", "Builds a solid", "fail", { detail: "OpenSCAD reported an error", hint: "fix the syntax error reported by the check, then write again" }));
      gates.push(gate("solid", "One watertight body", "skipped", { detail: "no mesh: parses failed" }));
    } else if (model !== null) {
      gates.push(gate("parses", "Builds a solid", "pass"));
      gates.push(gate("solid", "One watertight body", "pass", { measured: "1 shell", expected: "1 shell" }));
      gates.push(gate("fits_bed", "Fits the bed", "pass", { measured: "40 x 30 mm", expected: "<= 220 x 220 mm" }));
      if (model.includes("SMALL_BORE")) {
        gates.push(gate("dim:bore", "Bore for the M3 screw", "fail", { measured: "3.1 mm", expected: "3.4 ±0.1 mm", hint: "increase hole_d by 0.3", at: [10, 5, 6] }));
      } else gates.push(gate("dim:bore", "Bore for the M3 screw", "pass", { measured: "3.4 mm", expected: "3.4 ±0.1 mm" }));
      const wall = params?.wall;
      if (model.includes("THIN") && !(typeof wall === "number" && wall >= 1.6)) {
        gates.push(gate("min_wall", "Thinnest wall", "fail", { measured: "0.8 mm", expected: ">= 1.2 mm", detail: "the wall at the rim is too thin to print", hint: "raise wall to at least 1.6" }));
      } else gates.push(gate("min_wall", "Thinnest wall", "pass", { measured: "1.6 mm", expected: ">= 1.2 mm" }));
      if (model.includes("NOLINT")) gates.push(gate("lint", "Source conventions", "warn", { detail: "9 unexplained numeric literals inside modules", hint: "name them as parameters" }));
      else gates.push(gate("lint", "Source conventions", "pass"));
    }
    for (const w of spec.waivers) {
      const g = gates.find((x) => x.id === w.gate);
      if (g) {
        g.status = "waived";
        g.detail = w.reason;
      }
    }
    const parsesFailed = gates.some((g) => g.id === "parses" && g.status === "fail");
    const status: ReportStatus = model === null ? "empty" : parsesFailed ? "failed" : gates.some((g) => g.status === "fail") ? "draft" : "passed";
    const counted = gates.filter((g) => g.status !== "skipped");
    const passed = counted.filter((g) => g.status !== "fail").length;
    const next = gates.filter((g) => g.status === "fail" && g.hint).map((g) => `${g.label}: ${g.hint}`);
    if (status === "empty") next.push(`write the model to parts/${id}.scad`);
    return {
      project,
      part: id,
      revisionId: this.store.lastRevisionId(),
      status,
      passed,
      total: counted.length,
      gates,
      spec,
      mesh: model === null || status === "failed" ? null : MESH,
      analysis: model === null || status === "failed" ? null : ANALYSIS,
      render: model === null || status === "failed" ? null : refFor(`${modelRev}${params ? "wi" : ""}`.padEnd(24, "0")),
      params: [{ name: "wall", type: "number", value: typeof params?.wall === "number" ? params.wall : 1.6, group: "", description: "", min: null, max: null, step: null, options: null, line: 3 }],
      massG: model === null || status === "failed" ? null : 10.3,
      next,
      whatIf: params !== undefined,
      seconds: 0.4,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private summary(project: string, id: string): PartSummary | null {
    const report = this.report(project, id);
    if (!report) return null;
    const { spec } = report;
    return {
      project,
      id,
      title: spec.title,
      class: spec.class,
      source: spec.source,
      material: spec.material,
      strictness: spec.strictness,
      spec: `parts/${id}.part.json`,
      model: this.text(project, `parts/${id}.scad`) === null ? null : `parts/${id}.scad`,
      status: report.status,
      passed: report.passed,
      total: report.total,
      failing: report.gates.filter((g) => g.status === "fail").map((g) => g.label),
      evaluating: false,
      printed: spec.prints.at(-1)?.outcome ?? null,
      updatedAt: new Date().toISOString(),
      updatedBy: "agent",
    };
  }

  private partIds(project: string): string[] {
    return [...(this.store.files.get(project)?.keys() ?? [])].flatMap((p) => /^parts\/([a-z0-9][a-z0-9-]*)\.part\.json$/.exec(p)?.[1] ?? []);
  }

  private assemblyReport(project: string): AssemblyReport | null {
    const raw = this.text(project, "assembly.json");
    if (raw === null) return null;
    const spec = JSON.parse(raw) as AssemblySpec;
    const clash = spec.title.includes("clash");
    const gates = [
      gate("parts", "Every part exists", "pass"),
      gate("clash", "No clashes", clash ? "fail" : "pass", clash ? { measured: "2.5 mm3", expected: "<= 0.5 mm3", hint: "move the lid up by 0.4 mm" } : {}),
    ];
    return {
      project,
      revisionId: this.store.lastRevisionId(),
      status: clash ? "draft" : "passed",
      passed: clash ? 1 : 2,
      total: 2,
      gates,
      spec,
      instances: spec.instances.map((i) => ({ id: i.id, part: i.part, partStatus: "passed" as const, mesh: null, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })),
      pairs: spec.instances.length > 1 ? [{ a: spec.instances[0]?.id ?? "a", b: spec.instances[1]?.id ?? "b", gapMm: 0.2, overlapCm3: clash ? 0.0025 : 0 }] : [],
      bom: [{ part: "tray", title: "Tray", count: 2, source: "printed", material: "PETG", massG: 12.4 }],
      totalPrintedMassG: 24.8,
      render: (({ mesh: _mesh, ...rest }) => rest)(refFor("asm".padEnd(24, "0"))),
      next: clash ? ["clash: move the lid up by 0.4 mm"] : [],
      seconds: 0.9,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private overview(slug: string): ProjectOverview {
    const project = this.store.projects.get(slug) as Project;
    const parts = this.partIds(slug).flatMap((id) => this.summary(slug, id) ?? []);
    const asm = this.assemblyReport(slug);
    return {
      project,
      brief: this.text(slug, "brief.md") ?? "",
      memory: this.text(slug, "AGENTS.md") ?? "",
      parts,
      assembly: asm ? { status: asm.status, instances: asm.spec.instances.length, failing: asm.gates.filter((g) => g.status === "fail").map((g) => g.label) } : null,
      references: [...(this.store.files.get(slug)?.keys() ?? [])].filter((p) => p.startsWith("refs/")),
      notes: [...(this.store.files.get(slug)?.keys() ?? [])].filter((p) => p.startsWith("notes/")),
      library: { profile: PROFILE, notes: ["tolerances.md"], parts: [] },
    };
  }

  // ---- routing ----------------------------------------------------------------------------------

  /** `route` is the path after /api, split on "/". Returns null for routes the base fake owns. */
  handle(route: string[], method: string, query: Record<string, string>, bodyText: string, author: string): Response | null {
    if (route[0] === "guide") return new Response("# Modelling guide\n\nRead first.\n", { headers: { "content-type": "text/markdown" } });
    if (route[0] === "library" && route[1] === "profile") return json(PROFILE);
    if (route[0] === "sessions") return this.sessionRoute(route, method, query, bodyText);
    if (route[0] !== "projects" || route.length < 3) return null;
    const slug = route[1] as string;
    if (!this.store.projects.has(slug)) return apiError(404, "not_found", `no project ${slug}`);
    const sub = route[2];
    const rest = route.slice(3);
    switch (sub) {
      case "overview":
        return json(this.overview(slug));
      case "parts":
        return this.partsRoute(slug, rest, method, bodyText, author);
      case "assembly":
        return this.assemblyRoute(slug, method, bodyText, author);
      case "compare":
        return this.compare(bodyText);
      case "sessions":
        return method === "POST" ? this.createSession(slug, bodyText) : null;
      case "measure":
      case "slice":
      case "probe":
      case "section":
        return this.measuring(sub, slug, rest.join("/"), bodyText);
      default:
        return null;
    }
  }

  private partsRoute(slug: string, rest: string[], method: string, bodyText: string, author: string): Response {
    const [id, action] = rest;
    if (id === undefined) return json({ parts: this.partIds(slug).flatMap((p) => this.summary(slug, p) ?? []) });
    const spec = this.spec(slug, id);
    if (action === undefined && method === "PUT") {
      const body = parse(bodyText);
      const unknown = Object.keys(body).filter((k) => !SPEC_FIELDS.has(k));
      if (unknown.length > 0) return apiError(400, "invalid", `unknown fields: ${unknown.join(", ")}`);
      if (typeof body.title !== "string") return apiError(400, "invalid", "title is required");
      const defaults = this.store.projects.get(slug)?.defaults;
      const next = { ...DEFAULT_SPEC, ...(defaults ?? {}), ...body, waivers: spec?.waivers ?? [], prints: spec?.prints ?? [] };
      this.store.write(slug, `parts/${id}.part.json`, `${JSON.stringify(next, null, 2)}\n`, author, `spec ${id}`);
      return json(this.summary(slug, id));
    }
    if (!spec) return apiError(404, "not_found", `no part ${id}`);
    switch (action) {
      case "report":
        return json(this.report(slug, id));
      case "evaluate": {
        const body = parse(bodyText);
        return json(this.report(slug, id, body.params as ParamValues | undefined));
      }
      case "params":
        return this.setParams(slug, id, bodyText, author);
      case "waive":
        return author === "agent" ? apiError(403, "forbidden", "only a person can waive a gate") : json(this.summary(slug, id));
      case "prints": {
        const body = parse(bodyText) as { outcome: "ok" | "issue"; note: string };
        spec.prints.push({ revisionId: this.store.lastRevisionId(), at: new Date().toISOString(), outcome: body.outcome, note: body.note });
        this.store.write(slug, `parts/${id}.part.json`, `${JSON.stringify(spec, null, 2)}\n`, author, `print ${body.outcome}`);
        return json(this.summary(slug, id));
      }
      case "attempts":
        return json({ attempts: this.attempts.get(`${slug}/${id}`) ?? [] });
      case "restore": {
        const body = parse(bodyText) as { revisionId: string };
        if (!(this.attempts.get(`${slug}/${id}`) ?? []).some((a) => a.revisionId === body.revisionId)) return apiError(404, "not_found", `no attempt ${body.revisionId}`);
        const text = `// restored ${body.revisionId}\ncube(1);\n`;
        const file = this.store.write(slug, `parts/${id}.scad`, text, author, `restore ${body.revisionId}`);
        return json(this.writeResult(slug, `parts/${id}.scad`, file, false, text));
      }
      default:
        return apiError(404, "not_found", `no route parts/${id}/${action ?? ""}`);
    }
  }

  private setParams(slug: string, id: string, bodyText: string, author: string): Response {
    const body = parse(bodyText) as { rev: string; values: ParamValues; message?: string };
    const path = `parts/${id}.scad`;
    const file = this.store.files.get(slug)?.get(path);
    if (!file) return apiError(404, "not_found", `no model for ${id}`);
    if (body.rev !== file.rev) return apiError(409, "conflict", "rev is not current", file.rev);
    let text = dec.decode(file.bytes);
    for (const [name, value] of Object.entries(body.values)) {
      const pattern = new RegExp(`^(${name}\\s*=\\s*)[^;]*;`, "m");
      if (!pattern.test(text)) return apiError(400, "invalid", `no top-level parameter ${name}`);
      text = text.replace(pattern, (_m, head: string) => `${head}${JSON.stringify(value)};`);
    }
    const saved = this.store.write(slug, path, text, author, body.message ?? `set ${Object.keys(body.values).join(", ")}`);
    return json(this.writeResult(slug, path, saved, false, text));
  }

  private measuring(kind: string, slug: string, path: string, bodyText: string): Response {
    const file = this.store.files.get(slug)?.get(path);
    if (!file) return apiError(404, "not_found", `no file ${path}`);
    const body = parse(bodyText);
    if (kind === "measure") return json({ project: slug, path, mesh: MESH, analysis: ANALYSIS, render: refFor(`${file.rev}00000000`.slice(0, 24)) });
    if (kind === "probe") {
      const from = body.from as number[];
      return json(from[0] === 0 ? { inside: false, distance: null, low: null, high: null } : { inside: true, distance: 3.2, low: 4, high: 7.2 });
    }
    if (kind === "section") return json({ axis: body.axis, at: body.at, image: `/api/renders/${file.rev}00000000/section-${String(body.axis)}-${String(body.at)}.png` });
    return json({
      axis: body.axis,
      at: body.at,
      contours: [
        { hole: false, areaMm2: 1200, centre: [20, 15], bbox: { min: [0, 0], max: [40, 30] }, circle: { centre: [20, 15], diameter: 38, rms: 4, round: false }, points: [] },
        { hole: true, areaMm2: 9.1, centre: [10, 5], bbox: { min: [8.3, 3.3], max: [11.7, 6.7] }, circle: { centre: [10, 5], diameter: 3.4, rms: 0.01, round: true }, points: [] },
      ],
    });
  }

  private compare(bodyText: string): Response {
    const body = parse(bodyText) as { a: { part?: string; path?: string; at?: string }; b: { part?: string; path?: string; at?: string } };
    const key = (side: typeof body.a) => `cmp-${side.part ?? side.path ?? "x"}-${side.at ?? "now"}`.replace(/[^a-z0-9-]/gi, "-");
    const result: CompareResult = {
      a: { render: refFor(key(body.a)), mesh: MESH },
      b: { render: refFor(key(body.b)), mesh: { ...MESH, volumeCm3: 9.3 } },
      deviation: { min: -0.4, max: 1.2, rms: 0.31, p95: 0.8, at: [12, 4, 6], field: `/api/renders/${key(body.b)}/deviation.f32` },
      volumeDeltaCm3: 1.2,
      sizeDelta: [2, 0, -1],
    };
    return json(result);
  }

  private assemblyRoute(slug: string, method: string, bodyText: string, author: string): Response {
    if (method === "PUT") {
      let spec: AssemblySpec;
      try {
        spec = JSON.parse(bodyText) as AssemblySpec;
      } catch {
        return apiError(400, "invalid", "assembly.json is not valid JSON");
      }
      if (typeof spec.title !== "string" || !Array.isArray(spec.instances)) return apiError(400, "invalid", "assembly needs title and instances");
      this.store.write(slug, "assembly.json", `${JSON.stringify(spec, null, 2)}\n`, author, "assembly");
    }
    const report = this.assemblyReport(slug);
    if (!report) return apiError(404, "not_found", `${slug} has no assembly`);
    return json(report);
  }

  // ---- sessions ---------------------------------------------------------------------------------

  private createSession(slug: string, bodyText: string): Response {
    const body = parse(bodyText) as { message: string; provider?: ProviderKind; model?: string };
    const id = `s${++this.sessionCounter}`;
    const now = new Date().toISOString();
    const session: Session = {
      id,
      project: slug,
      title: body.message.slice(0, 60),
      provider: body.provider ?? "claude",
      model: body.model ?? null,
      status: "queued",
      activity: null,
      pending: 1,
      toolCalls: 0,
      seq: 1,
      version: 1,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, { session, items: [{ seq: 1, version: 1, at: now, type: "user", text: body.message, refs: [], attachments: [], author: "agent" }] });
    return json(session, 201);
  }

  private sessionRoute(route: string[], method: string, query: Record<string, string>, bodyText: string): Response {
    const id = route[1];
    if (id === undefined) {
      const all = [...this.sessions.values()].map((s) => s.session).filter((s) => !query.project || s.project === query.project);
      return json({ sessions: all.reverse() });
    }
    const entry = this.sessions.get(id);
    if (!entry) return apiError(404, "not_found", `no session ${id}`);
    if (route[2] === "messages" && method === "POST") {
      const body = parse(bodyText) as { text: string };
      entry.session.pending += 1;
      this.addSessionItem(id, { type: "user", text: body.text, refs: [], attachments: [], author: "agent" });
      return json(entry.session);
    }
    if (route[2] === "answer" && method === "POST") {
      const body = parse(bodyText) as { questionId: string; answers: string[] };
      const index = entry.items.findIndex((i) => i.type === "question" && i.questionId === body.questionId);
      const item = entry.items[index];
      if (item?.type !== "question") return apiError(404, "not_found", `no such question: ${body.questionId}`);
      if (item.answers !== null) return apiError(409, "conflict", `question ${body.questionId} was already answered`);
      entry.session.version += 1;
      entry.items[index] = { ...item, answers: body.answers, version: entry.session.version };
      return json(entry.session);
    }
    const since = query.since === undefined ? 0 : Number(query.since);
    return json({ session: entry.session, items: entry.items.filter((i) => i.version > since) });
  }
}
