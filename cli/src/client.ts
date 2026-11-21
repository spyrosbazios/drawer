/** Typed fetch wrapper over every route in shared/src/api.ts. Only types are imported from @drawer/shared. */
import type {
  AlignBody,
  AlignResult,
  AnswerBody,
  ApiError,
  AssemblyReport,
  AssemblySpec,
  AttemptsResponse,
  CompareBody,
  CompareResult,
  ContextResponse,
  CreateProjectBody,
  CreateSessionBody,
  EditBody,
  EvaluateBody,
  Feature,
  FeaturesBody,
  FeaturesResult,
  FitBody,
  FileAttachmentBody,
  FileAttachmentResult,
  FileInfo,
  FileKind,
  Health,
  HistoryResponse,
  ImportBody,
  ImportPreview,
  ImportResult,
  LibraryProfile,
  MeasureBody,
  MeasureResult,
  MoveBody,
  NewSessionItem,
  PartReport,
  PartSpecBody,
  PartSummary,
  PartsResponse,
  PatchProjectBody,
  PatchSettingsBody,
  PrintBody,
  ProbeBody,
  ProbeResult,
  Project,
  ProjectOverview,
  RenderBody,
  RenderResult,
  RestoreBody,
  RunnerPoll,
  RunnerSessionPatch,
  RunnerWork,
  RunnersResponse,
  SearchResponse,
  ScanQuery,
  ScanResult,
  SectionBody,
  SectionResult,
  Session,
  SessionDetail,
  SessionItem,
  SessionAttachment,
  SessionMessageBody,
  SessionsResponse,
  SetParamsBody,
  Settings,
  SliceBody,
  SliceResult,
  TreeResponse,
  WaiveBody,
  WriteResult,
} from "@drawer/shared/api";

/** Same values as HEADER_REV / HEADER_AUTHOR / HEADER_MESSAGE in api.ts; test/client.test.ts asserts they match. */
export const HEADER_REV = "x-drawer-rev";
export const HEADER_AUTHOR = "x-drawer-author";
export const HEADER_MESSAGE = "x-drawer-message";

export type FailureCode = ApiError["error"] | "http" | "network";

/** A failed API call. `rev` is set on conflict. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: FailureCode,
    message: string,
    readonly rev?: string,
  ) {
    super(message);
  }
}

/** Who a runner is on the wire: its configured id and the random nonce of this process. */
export interface RunnerIdentity {
  runner: string;
  boot: string;
}

export interface FileContent {
  bytes: Uint8Array;
  rev: string | null;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  json?: unknown;
  rev?: string;
  message?: string;
}

/**
 * A project path as URL segments. `.` and `..` segments are refused here: `fetch` would resolve them
 * before the request leaves, and `files/../../other/...` would silently address another project.
 */
function encodePath(path: string): string {
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new ApiFailure(400, "invalid", `not a project path: ${path}`);
  return segments.map(encodeURIComponent).join("/");
}

function inferCode(status: number): FailureCode {
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 400) return "invalid";
  return "http";
}

export class Client {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly author: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    const suffix = qs.size > 0 ? `?${qs}` : "";
    return `${this.baseUrl}${path}${suffix}`;
  }

  private async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { [HEADER_AUTHOR]: this.author, ...(opts.headers ?? {}) };
    if (opts.rev !== undefined) headers[HEADER_REV] = opts.rev;
    if (opts.message) headers[HEADER_MESSAGE] = encodeURIComponent(opts.message);
    let body: Uint8Array | string | undefined = opts.body;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (body instanceof Uint8Array) {
      headers["content-type"] = "application/octet-stream";
    }

    let res: Response;
    try {
      res = await fetch(this.url(path, opts.query), { method, headers, body: body as RequestInit["body"] });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new ApiFailure(0, "network", `cannot reach drawer server at ${this.baseUrl}: ${reason}`);
    }
    if (res.ok) return res;
    throw await this.failure(res);
  }

  private async failure(res: Response): Promise<ApiFailure> {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as Partial<ApiError>;
      if (typeof parsed.error === "string") {
        return new ApiFailure(res.status, parsed.error, parsed.message ?? parsed.error, parsed.rev);
      }
    } catch {
      // not a JSON error body; fall through
    }
    const detail = text.trim().slice(0, 300) || res.statusText;
    return new ApiFailure(res.status, inferCode(res.status), `HTTP ${res.status}: ${detail}`);
  }

  private async getJson<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return (await (await this.request("GET", path, { query })).json()) as T;
  }

  private async sendJson<T>(method: string, path: string, json: unknown, opts: RequestOptions = {}): Promise<T> {
    return (await (await this.request(method, path, { ...opts, json })).json()) as T;
  }

  private projectPath(slug: string, rest = ""): string {
    return `/api/projects/${encodeURIComponent(slug)}${rest}`;
  }

  private filePath(slug: string, route: string, path: string): string {
    return this.projectPath(slug, `/${route}/${encodePath(path)}`);
  }

  // ---- service ----------------------------------------------------------------------------

  health(): Promise<Health> {
    return this.getJson<Health>("/api/health");
  }

  /** The SSE stream; the caller reads and closes it. */
  events(): Promise<Response> {
    return this.request("GET", "/api/events", { headers: { accept: "text/event-stream" } });
  }

  async reindex(): Promise<{ files: number }> {
    return (await (await this.request("POST", "/api/reindex")).json()) as { files: number };
  }

  // ---- projects ---------------------------------------------------------------------------

  async listProjects(): Promise<{ projects: Project[] }> {
    return this.getJson("/api/projects");
  }

  createProject(body: CreateProjectBody): Promise<Project> {
    return this.sendJson("POST", "/api/projects", body);
  }

  getProject(slug: string): Promise<Project> {
    return this.getJson(this.projectPath(slug));
  }

  patchProject(slug: string, body: PatchProjectBody): Promise<Project> {
    return this.sendJson("PATCH", this.projectPath(slug), body);
  }

  async deleteProject(slug: string): Promise<void> {
    await this.request("DELETE", this.projectPath(slug));
  }

  tree(slug: string): Promise<TreeResponse> {
    return this.getJson(this.projectPath(slug, "/tree"));
  }

  // ---- files ------------------------------------------------------------------------------

  /** Raw bytes plus the rev header. `at` reads a past revision. */
  async readFile(slug: string, path: string, opts: { at?: string; download?: boolean } = {}): Promise<FileContent> {
    const res = await this.request("GET", this.filePath(slug, "files", path), {
      query: { at: opts.at, download: opts.download ? "1" : undefined },
    });
    return { bytes: new Uint8Array(await res.arrayBuffer()), rev: res.headers.get(HEADER_REV) };
  }

  /** `rev` omitted creates; `rev` set overwrites if it is current; "*" overwrites unconditionally. */
  writeFile(slug: string, path: string, body: Uint8Array, opts: { rev?: string; message?: string } = {}): Promise<WriteResult> {
    return this.request("PUT", this.filePath(slug, "files", path), { body, rev: opts.rev, message: opts.message }).then(
      (res) => res.json() as Promise<WriteResult>,
    );
  }

  /** Deleting a directory: `recursive`, no rev. */
  async deleteFile(slug: string, path: string, opts: { rev?: string; recursive?: boolean; message?: string }): Promise<{ revisionId: string }> {
    const res = await this.request("DELETE", this.filePath(slug, "files", path), {
      rev: opts.rev,
      message: opts.message,
      query: { recursive: opts.recursive ? "1" : undefined },
    });
    return (await res.json()) as { revisionId: string };
  }

  edit(slug: string, path: string, body: EditBody): Promise<WriteResult> {
    const { message, ...rest } = body;
    return this.sendJson("POST", this.filePath(slug, "edit", path), rest, { message });
  }

  move(slug: string, body: MoveBody): Promise<{ revisionId: string }> {
    return this.sendJson("POST", this.projectPath(slug, "/move"), body);
  }

  info(slug: string, path: string): Promise<FileInfo> {
    return this.getJson(this.filePath(slug, "info", path));
  }

  history(slug: string, opts: { path?: string; limit?: number } = {}): Promise<HistoryResponse> {
    return this.getJson(this.projectPath(slug, "/history"), { path: opts.path, limit: opts.limit });
  }

  context(slug: string, path: string, opts: { depth?: number; maxBytes?: number } = {}): Promise<ContextResponse> {
    return this.getJson(this.filePath(slug, "context", path), { depth: opts.depth, maxBytes: opts.maxBytes });
  }

  // ---- render, search, import ---------------------------------------------------------------

  render(slug: string, path: string, body: RenderBody): Promise<RenderResult> {
    return this.sendJson("POST", this.filePath(slug, "render", path), body);
  }

  /** Download a server URL path such as /api/renders/<key>/sheet.png. */
  async download(urlPath: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request("GET", urlPath)).arrayBuffer());
  }

  search(slug: string, opts: { q: string; kind?: FileKind; limit?: number }): Promise<SearchResponse> {
    return this.getJson(this.projectPath(slug, "/search"), { q: opts.q, kind: opts.kind, limit: opts.limit });
  }

  importPreview(url: string): Promise<ImportPreview> {
    return this.sendJson("POST", "/api/import/preview", { url });
  }

  importInto(slug: string, body: ImportBody): Promise<ImportResult> {
    return this.sendJson("POST", this.projectPath(slug, "/import"), body);
  }

  // ---- parts ------------------------------------------------------------------------------

  private partPath(slug: string, id: string, rest = ""): string {
    return this.projectPath(slug, `/parts/${encodeURIComponent(id)}${rest}`);
  }

  overview(slug: string): Promise<ProjectOverview> {
    return this.getJson(this.projectPath(slug, "/overview"));
  }

  /** The modelling guide the server gives every agent, as markdown. */
  async guide(): Promise<string> {
    return (await this.request("GET", "/api/guide")).text();
  }

  libraryProfile(): Promise<LibraryProfile> {
    return this.getJson("/api/library/profile");
  }

  listParts(slug: string): Promise<PartsResponse> {
    return this.getJson(this.projectPath(slug, "/parts"));
  }

  /** Creates the part or replaces its spec. */
  putPart(slug: string, id: string, body: PartSpecBody): Promise<PartSummary> {
    return this.sendJson("PUT", this.partPath(slug, id), body);
  }

  async deletePart(slug: string, id: string): Promise<{ revisionId: string }> {
    return (await (await this.request("DELETE", this.partPath(slug, id))).json()) as { revisionId: string };
  }

  /** The current report; waits for a running evaluation. */
  partReport(slug: string, id: string): Promise<PartReport> {
    return this.getJson(this.partPath(slug, id, "/report"));
  }

  evaluatePart(slug: string, id: string, body: EvaluateBody = {}): Promise<PartReport> {
    return this.sendJson("POST", this.partPath(slug, id, "/evaluate"), body);
  }

  setParams(slug: string, id: string, body: SetParamsBody): Promise<WriteResult> {
    return this.sendJson("POST", this.partPath(slug, id, "/params"), body);
  }

  waive(slug: string, id: string, body: WaiveBody): Promise<PartSummary> {
    return this.sendJson("POST", this.partPath(slug, id, "/waive"), body);
  }

  recordPrint(slug: string, id: string, body: PrintBody): Promise<PartSummary> {
    return this.sendJson("POST", this.partPath(slug, id, "/prints"), body);
  }

  attempts(slug: string, id: string): Promise<AttemptsResponse> {
    return this.getJson(this.partPath(slug, id, "/attempts"));
  }

  restore(slug: string, id: string, body: RestoreBody): Promise<WriteResult> {
    return this.sendJson("POST", this.partPath(slug, id, "/restore"), body);
  }

  // ---- measuring any model ------------------------------------------------------------------

  measure(slug: string, path: string, body: MeasureBody = {}): Promise<MeasureResult> {
    return this.sendJson("POST", this.filePath(slug, "measure", path), body);
  }

  slice(slug: string, path: string, body: SliceBody): Promise<SliceResult> {
    return this.sendJson("POST", this.filePath(slug, "slice", path), body);
  }

  align(slug: string, path: string, body: AlignBody = {}): Promise<AlignResult> {
    return this.sendJson("POST", this.filePath(slug, "align", path), body);
  }

  features(slug: string, path: string, body: FeaturesBody = {}): Promise<FeaturesResult> {
    return this.sendJson("POST", this.filePath(slug, "features", path), body);
  }

  fit(slug: string, path: string, body: FitBody): Promise<Feature> {
    return this.sendJson("POST", this.filePath(slug, "fit", path), body);
  }

  probe(slug: string, path: string, body: ProbeBody): Promise<ProbeResult> {
    return this.sendJson("POST", this.filePath(slug, "probe", path), body);
  }

  section(slug: string, path: string, body: SectionBody): Promise<SectionResult> {
    return this.sendJson("POST", this.filePath(slug, "section", path), body);
  }

  async addScan(slug: string, query: ScanQuery, body: Uint8Array): Promise<ScanResult> {
    return (await (await this.request("POST", this.projectPath(slug, "/scans"), { query: { ...query }, body })).json()) as ScanResult;
  }

  compare(slug: string, body: CompareBody): Promise<CompareResult> {
    return this.sendJson("POST", this.projectPath(slug, "/compare"), body);
  }

  // ---- assembly -----------------------------------------------------------------------------

  /** The current report; waits for a running evaluation. `not_found` when the project has no assembly. */
  assembly(slug: string): Promise<AssemblyReport> {
    return this.getJson(this.projectPath(slug, "/assembly"));
  }

  putAssembly(slug: string, body: AssemblySpec): Promise<AssemblyReport> {
    return this.sendJson("PUT", this.projectPath(slug, "/assembly"), body);
  }

  evaluateAssembly(slug: string): Promise<AssemblyReport> {
    return this.sendJson("POST", this.projectPath(slug, "/assembly/evaluate"), {});
  }

  // ---- sessions -----------------------------------------------------------------------------

  listSessions(project?: string): Promise<SessionsResponse> {
    return this.getJson("/api/sessions", { project });
  }

  createSession(slug: string, body: CreateSessionBody): Promise<Session> {
    return this.sendJson("POST", this.projectPath(slug, "/sessions"), body);
  }

  /** `since`: only the items appended or changed after that session version. */
  session(id: string, since?: number): Promise<SessionDetail> {
    return this.getJson(`/api/sessions/${encodeURIComponent(id)}`, { since });
  }

  sendMessage(id: string, body: SessionMessageBody): Promise<Session> {
    return this.sendJson("POST", `/api/sessions/${encodeURIComponent(id)}/messages`, body);
  }

  stopSession(id: string): Promise<Session> {
    return this.sendJson("POST", `/api/sessions/${encodeURIComponent(id)}/stop`, {});
  }

  answer(id: string, body: AnswerBody): Promise<Session> {
    return this.sendJson("POST", `/api/sessions/${encodeURIComponent(id)}/answer`, body);
  }

  /** Uploads a file to send with a message; pass the returned id in `attachments`. */
  async uploadAttachment(slug: string, name: string, bytes: Uint8Array): Promise<SessionAttachment> {
    const res = await this.request("POST", this.projectPath(slug, "/attachments"), { body: bytes, query: { name } });
    return (await res.json()) as SessionAttachment;
  }

  /** The bytes of an attachment and its file name. */
  async attachmentBytes(id: string): Promise<{ bytes: Uint8Array; name: string }> {
    const res = await this.request("GET", `/api/attachments/${encodeURIComponent(id)}`, { query: { download: "1" } });
    const encoded = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") ?? "")?.[1];
    return { bytes: new Uint8Array(await res.arrayBuffer()), name: encoded ? decodeURIComponent(encoded) : id };
  }

  /** Copies an attachment into its project as one revision. */
  fileAttachment(id: string, body: FileAttachmentBody): Promise<FileAttachmentResult> {
    return this.sendJson("POST", `/api/attachments/${encodeURIComponent(id)}/file`, body);
  }

  async deleteSession(id: string): Promise<void> {
    await this.request("DELETE", `/api/sessions/${encodeURIComponent(id)}`);
  }

  runners(): Promise<RunnersResponse> {
    return this.getJson("/api/runners");
  }

  settings(): Promise<Settings> {
    return this.getJson("/api/settings");
  }

  /** People only: the server refuses the author "agent". */
  patchSettings(body: PatchSettingsBody): Promise<Settings> {
    return this.sendJson("PATCH", "/api/settings", body);
  }

  // ---- for an agent runner ------------------------------------------------------------------

  /** Long poll: the next piece of work for this runner, or null after `poll.wait` seconds. */
  runnerWork(poll: RunnerPoll): Promise<RunnerWork> {
    return this.sendJson("POST", "/api/runner/work", poll);
  }

  appendItem(id: string, item: NewSessionItem, runner: RunnerIdentity): Promise<SessionItem> {
    return this.sendJson("POST", `/api/sessions/${encodeURIComponent(id)}/items`, item, { query: { ...runner } });
  }

  patchSession(id: string, body: RunnerSessionPatch, runner: RunnerIdentity): Promise<Session> {
    return this.sendJson("PATCH", `/api/sessions/${encodeURIComponent(id)}`, body, { query: { ...runner } });
  }

  /** Long poll: the person's answers to a question (one for a single question), or null after `wait` seconds. */
  async waitAnswer(id: string, questionId: string, wait: number): Promise<string[] | null> {
    const body = await this.getJson<{ answers: string[] | null }>(`/api/sessions/${encodeURIComponent(id)}/answer`, { question: questionId, wait });
    return body.answers;
  }
}
