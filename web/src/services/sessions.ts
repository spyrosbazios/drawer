import type {
  AnswerBody,
  CreateSessionBody,
  FileAttachmentBody,
  FileAttachmentResult,
  RunnerInfo,
  Session,
  SessionAttachment,
  SessionDetail,
  SessionMessageBody,
} from "@drawer/shared/api";
import { fileAttachmentResultSchema, runnersSchema, sessionAttachmentSchema, sessionDetailSchema, sessionSchema, sessionsSchema } from "@/core/schemas";
import { api, read } from "./api";

const one = (id: string) => `/sessions/${encodeURIComponent(id)}`;

/** Newest first; every project when `project` is omitted. */
export async function listSessions(project?: string): Promise<Session[]> {
  const { data } = await api.get<unknown>("/sessions", { params: project ? { project } : undefined });
  return read(sessionsSchema, data).sessions;
}

export async function createSession(slug: string, body: CreateSessionBody): Promise<Session> {
  const { data } = await api.post<unknown>(`/projects/${encodeURIComponent(slug)}/sessions`, body);
  return read(sessionSchema, data);
}

/** With `since`: only the items appended or changed after that session version. */
export async function getSession(id: string, since?: number): Promise<SessionDetail> {
  const { data } = await api.get<unknown>(one(id), { params: since === undefined ? undefined : { since } });
  return read(sessionDetailSchema, data);
}

export async function sendMessage(id: string, body: SessionMessageBody): Promise<Session> {
  const { data } = await api.post<unknown>(`${one(id)}/messages`, body);
  return read(sessionSchema, data);
}

export async function stopSession(id: string): Promise<Session> {
  const { data } = await api.post<unknown>(`${one(id)}/stop`, {});
  return read(sessionSchema, data);
}

export async function answerQuestion(id: string, body: AnswerBody): Promise<Session> {
  const { data } = await api.post<unknown>(`${one(id)}/answer`, body);
  return read(sessionSchema, data);
}

export async function deleteSession(id: string): Promise<void> {
  await api.delete(one(id));
}

/** Runners seen in the last minute. Empty: new sessions stay queued. */
export async function listRunners(): Promise<RunnerInfo[]> {
  const { data } = await api.get<unknown>("/runners");
  return read(runnersSchema, data).runners;
}

export interface UploadAttachmentOptions {
  /** Defaults to the File's own name. */
  name?: string;
  /** 0..1 as the bytes go out. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Uploads a file to send with the next message of a session in `slug`; send the returned `id` in `attachments`. */
export async function uploadAttachment(slug: string, file: Blob, opts: UploadAttachmentOptions = {}): Promise<SessionAttachment> {
  const name = opts.name ?? (file instanceof File ? file.name : "attachment");
  const { data } = await api.post<unknown>(`/projects/${encodeURIComponent(slug)}/attachments`, file, {
    params: { name },
    headers: { "content-type": "application/octet-stream" },
    timeout: 0,
    signal: opts.signal,
    onUploadProgress: (e) => {
      if (opts.onProgress && e.total) opts.onProgress(e.loaded / e.total);
    },
  });
  return read(sessionAttachmentSchema, data);
}

/** Copies an attachment into its project at `body.path` as one revision. */
export async function fileAttachment(id: string, body: FileAttachmentBody): Promise<FileAttachmentResult> {
  const { data } = await api.post<unknown>(`/attachments/${encodeURIComponent(id)}/file`, body);
  return read(fileAttachmentResultSchema, data);
}

/** Where an `<img>`, a 3D loader or a download link gets an attachment's bytes. */
export function attachmentUrl(attachment: Pick<SessionAttachment, "url">, opts: { download?: boolean } = {}): string {
  return opts.download ? `${attachment.url}?download=1` : attachment.url;
}
