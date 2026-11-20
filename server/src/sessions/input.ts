/** Hand-written validation of what people and runners send to the session routes. */
import { isModelId, isResumeHandle, PROVIDER_KINDS, type ProviderState, type ProviderStatus } from "@drawer/shared/api";
import type {
  AnswerBody,
  CreateSessionBody,
  FileAttachmentBody,
  NewSessionItem,
  RunnerSessionPatch,
  SessionMessageBody,
  SessionRef,
  SessionStatus,
  Vec3,
} from "@drawer/shared/api";
import { MAX_ATTACHMENTS } from "@drawer/shared/api";
import { invalid } from "../errors.ts";
import { normalizePath } from "../store/paths.ts";
import { isProviderKind } from "../settings.ts";
import type { Obj } from "../http/validate.ts";
import { onlyFields, optString, reqString } from "../http/validate.ts";
import type { RunnerIdentity, RunnerQuery } from "./types.ts";

export const MAX_WAIT_SECONDS = 30;
/** Limits on what goes into a session item (the runner trims to these before it sends). */
export const LIMITS = {
  /** A message, an assistant text, a question, a notice, an answer. */
  text: 100_000,
  toolSummary: 300,
  toolResult: 20_000,
  toolImages: 16,
  reasoning: 8_000,
  options: 12,
  option: 200,
} as const;
const STATUSES: SessionStatus[] = ["queued", "working", "waiting", "idle", "stopped", "failed"];

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capped(obj: Obj, key: string, max: number): string {
  const value = reqString(obj, key);
  if (value.length > max) throw invalid(`${key} must be at most ${max} characters`);
  return value;
}

/** Server URL paths of images: `/api/...`. */
function imagePaths(obj: Obj): string[] {
  const value = strings(obj, "images");
  if (value.length > LIMITS.toolImages) throw invalid(`images must have at most ${LIMITS.toolImages} entries`);
  if (!value.every((v) => v.startsWith("/api/") && v.length <= 1000)) throw invalid("images must be server URL paths starting with /api/");
  return value;
}

function options(obj: Obj): string[] {
  const value = strings(obj, "options");
  if (value.length > LIMITS.options) throw invalid(`options must have at most ${LIMITS.options} entries`);
  if (value.some((v) => v.length > LIMITS.option)) throw invalid(`each option must be at most ${LIMITS.option} characters`);
  return value;
}

function nonEmpty(obj: Obj, key: string): string {
  const value = reqString(obj, key);
  if (value.trim() === "") throw invalid(`${key} must not be empty`);
  return value;
}

function strings(obj: Obj, key: string): string[] {
  const value = obj[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw invalid(`${key} must be an array of strings`);
  return value as string[];
}

function vec3(value: unknown, what: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw invalid(`${what} must be three numbers`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function ref(value: unknown, index: number): SessionRef {
  if (!isObj(value)) throw invalid(`refs[${index}] must be an object`);
  switch (value.kind) {
    case "part":
      return { kind: "part", part: nonEmpty(value, "part") };
    case "point": {
      const normal = value.normal === undefined || value.normal === null ? null : vec3(value.normal, `refs[${index}].normal`);
      return { kind: "point", part: nonEmpty(value, "part"), position: vec3(value.position, `refs[${index}].position`), normal };
    }
    case "file":
      return { kind: "file", path: nonEmpty(value, "path") };
    default:
      throw invalid(`refs[${index}].kind must be part, point or file`);
  }
}

function refs(obj: Obj): SessionRef[] {
  const value = obj.refs;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("refs must be an array");
  return value.map(ref);
}

/** Ids of uploads; the manager checks they exist and are unsent. */
function attachmentIds(obj: Obj): string[] {
  const ids = strings(obj, "attachments");
  if (ids.length > MAX_ATTACHMENTS) throw invalid(`a message may carry at most ${MAX_ATTACHMENTS} attachments`);
  return ids;
}

/** A message's text, which may be empty only when attachments come with it. */
function messageText(obj: Obj, key: string, attachments: string[]): string {
  const text = capped(obj, key, LIMITS.text).trim();
  if (text === "" && attachments.length === 0) throw invalid(`${key} must not be empty without attachments`);
  return text;
}

export function createSessionBody(obj: Obj): Required<Pick<CreateSessionBody, "message" | "refs" | "attachments">> & CreateSessionBody {
  const attachments = attachmentIds(obj);
  const message = messageText(obj, "message", attachments);
  const provider = obj.provider ?? undefined;
  if (provider !== undefined && !isProviderKind(provider)) throw invalid(`provider must be one of ${PROVIDER_KINDS.join(", ")}`);
  const model = optString(obj, "model");
  if (model !== undefined && !isModelId(model)) throw invalid("model must be a model id (letters, digits and . _ : / @ + -, starting with a letter or digit)");
  return { message, refs: refs(obj), attachments, ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) };
}

export function messageBody(obj: Obj): Required<SessionMessageBody> {
  const attachments = attachmentIds(obj);
  return { text: messageText(obj, "text", attachments), refs: refs(obj), attachments };
}

export function fileAttachmentBody(obj: Obj): FileAttachmentBody {
  const rev = optString(obj, "rev");
  const message = optString(obj, "message");
  return { path: normalizePath(nonEmpty(obj, "path")), ...(rev === undefined ? {} : { rev }), ...(message === undefined ? {} : { message }) };
}

export function answerBody(obj: Obj): AnswerBody {
  return { questionId: nonEmpty(obj, "questionId"), answer: capped(obj, "answer", LIMITS.text) };
}

export function newItem(obj: Obj): NewSessionItem {
  switch (obj.type) {
    case "assistant":
      return { type: "assistant", text: capped(obj, "text", LIMITS.text) };
    case "tool": {
      const status = obj.status;
      if (status !== "running" && status !== "ok" && status !== "error") throw invalid("status must be running, ok or error");
      return {
        type: "tool",
        callId: nonEmpty(obj, "callId"),
        name: nonEmpty(obj, "name"),
        summary: capped(obj, "summary", LIMITS.toolSummary),
        status,
        result: obj.result === undefined || obj.result === null ? null : capped(obj, "result", LIMITS.toolResult),
        images: imagePaths(obj),
      };
    }
    case "question":
      return { type: "question", questionId: nonEmpty(obj, "questionId"), text: capped(obj, "text", LIMITS.text), options: options(obj) };
    case "reasoning": {
      const status = obj.status;
      if (status !== "running" && status !== "done") throw invalid("status must be running or done");
      const seconds = obj.seconds;
      if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0) throw invalid("seconds must be a non-negative integer");
      return { type: "reasoning", reasoningId: nonEmpty(obj, "reasoningId"), text: capped(obj, "text", LIMITS.reasoning), status, seconds };
    }
    case "notice": {
      const level = obj.level;
      if (level !== "info" && level !== "error") throw invalid("level must be info or error");
      return { type: "notice", level, text: capped(obj, "text", LIMITS.text) };
    }
    default:
      throw invalid("type must be assistant, tool, question, reasoning or notice");
  }
}

export function sessionPatch(obj: Obj): RunnerSessionPatch {
  const out: RunnerSessionPatch = {};
  if (obj.status !== undefined) {
    if (typeof obj.status !== "string" || !STATUSES.includes(obj.status as SessionStatus)) {
      throw invalid(`status must be one of ${STATUSES.join(", ")}`);
    }
    out.status = obj.status as SessionStatus;
  }
  for (const key of ["activity", "error", "resume"] as const) {
    const value = obj[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") throw invalid(`${key} must be a string or null`);
    if (key === "resume" && value !== null && !isResumeHandle(value)) throw invalid("resume must be a provider session handle (letters, digits and . _ : -)");
    out[key] = value;
  }
  return out;
}

/** `wait` in seconds: absent is 0, anything above the cap is the cap. */
function capWait(n: number): number {
  if (!Number.isFinite(n) || n < 0) throw invalid("wait must be a number of seconds, 0 or more");
  return Math.min(n, MAX_WAIT_SECONDS);
}

/** `wait` from the query of a GET long poll. */
export function waitSeconds(url: URL): number {
  const raw = url.searchParams.get("wait");
  if (raw === null || raw === "") return 0;
  return capWait(Number(raw));
}

/** `runner` and `boot` from the query: who is calling. */
export function runnerIdentity(url: URL): RunnerIdentity {
  const runner = url.searchParams.get("runner")?.trim() ?? "";
  if (runner === "") throw invalid("runner is required");
  const boot = url.searchParams.get("boot")?.trim() ?? "";
  if (boot === "") throw invalid("boot is required");
  return { runner, boot };
}

const PROVIDER_STATES: ProviderState[] = ["ready", "disabled", "not_installed", "signed_out", "unavailable"];
const STATUS_MODELS = 500;

function providerStatus(entry: unknown, i: number): ProviderStatus {
  const at = `providers[${i}]`;
  if (!isObj(entry)) throw invalid(`${at} must be an object`);
  if (!isProviderKind(entry.kind)) throw invalid(`${at}.kind must be one of ${PROVIDER_KINDS.join(", ")}`);
  if (!PROVIDER_STATES.some((s) => s === entry.state)) throw invalid(`${at}.state must be one of ${PROVIDER_STATES.join(", ")}`);
  const models = strings(entry, "models");
  if (models.length > STATUS_MODELS || models.some((m) => m.length > 200)) throw invalid(`${at}.models: at most ${STATUS_MODELS} ids of 200 characters`);
  const nullable = (key: "version" | "message" | "binary", max: number): string | null => {
    const value = entry[key] ?? null;
    if (value !== null && typeof value !== "string") throw invalid(`${at}.${key} must be a string or null`);
    return value === null ? null : value.slice(0, max);
  };
  return { kind: entry.kind, state: entry.state as ProviderState, version: nullable("version", 100), models, message: nullable("message", 500), binary: nullable("binary", 500) };
}

/** The body of POST /runner/work. */
export function runnerPoll(obj: Obj): RunnerQuery {
  onlyFields(obj, ["runner", "boot", "providers", "accepting", "wait"]);
  const runner = typeof obj.runner === "string" ? obj.runner.trim() : "";
  if (runner === "") throw invalid("runner is required");
  const boot = typeof obj.boot === "string" ? obj.boot.trim() : "";
  if (boot === "") throw invalid("boot is required");
  if (!Array.isArray(obj.providers)) throw invalid("providers must be an array of provider statuses");
  const providers = obj.providers.map(providerStatus);
  if (new Set(providers.map((p) => p.kind)).size !== providers.length) throw invalid("providers must name each kind once");
  if (typeof obj.accepting !== "boolean") throw invalid("accepting must be a boolean");
  const wait = obj.wait ?? 0;
  if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0) throw invalid("wait must be a number of seconds, 0 or more");
  return { runner, boot, providers, accepting: obj.accepting, wait: Math.min(wait, MAX_WAIT_SECONDS) };
}
