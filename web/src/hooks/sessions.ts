import type { AnswerBody, CreateSessionBody, DrawerEvent, FileAttachmentBody, Session, SessionDetail, SessionMessageBody } from "@drawer/shared/api";
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { mergeDetail } from "@/core/sessions";
import {
  answerQuestion,
  createSession,
  deleteSession,
  fileAttachment,
  getSession,
  listRunners,
  listSessions,
  sendMessage,
  stopSession,
  uploadAttachment,
  type UploadAttachmentOptions,
} from "@/services/sessions";

export const sessionKeys = {
  all: () => ["sessions"] as const,
  /** `project` "" = every project (Home). */
  list: (project?: string) => ["sessions", "list", project ?? ""] as const,
  detail: (id: string) => ["sessions", "detail", id] as const,
  runners: () => ["runners"] as const,
};

export const sessionsQuery = (project?: string) => queryOptions({ queryKey: sessionKeys.list(project), queryFn: () => listSessions(project) });

/** A session with all its items. Realtime keeps it current (`applySessionEvent`), so it never goes stale by itself. */
export const sessionQuery = (id: string) =>
  queryOptions({ queryKey: sessionKeys.detail(id), queryFn: () => getSession(id), staleTime: Infinity, refetchOnWindowFocus: false });

export const runnersQuery = () => queryOptions({ queryKey: sessionKeys.runners(), queryFn: listRunners, refetchInterval: 30_000 });

export const useSessions = (project?: string) => useQuery({ ...sessionsQuery(project), placeholderData: keepPreviousData });
export const useSession = (id: string | undefined) => useQuery({ ...sessionQuery(id ?? ""), enabled: id !== undefined });
/** Runners poll the server; a runner is gone after a minute without polling, so this refreshes every 30 s. */
export const useRunners = () => useQuery(runnersQuery());

/**
 * A mutation answered with the session. Lists take it as is; an open session fetches the items it has not
 * seen instead (the record alone would move its version past the item just sent, and `?since=` would skip it).
 */
function patchSession(qc: QueryClient, session: Session): void {
  qc.setQueriesData<Session[]>({ queryKey: ["sessions", "list"] }, (old) => old?.map((s) => (s.id === session.id ? session : s)));
  void catchUp(qc, session.id);
}

/** Starts a session in a project with its first message; it is `queued` until a runner claims it. */
export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { slug: string } & CreateSessionBody) =>
      createSession(v.slug, { message: v.message, refs: v.refs, attachments: v.attachments, provider: v.provider, model: v.model }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sessions", "list"] }),
  });
}

export function useSendMessage(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: SessionMessageBody) => sendMessage(id, body), onSuccess: (s) => patchSession(qc, s) });
}

/**
 * Uploads one file for the next message in `slug` (a new session's first message or a follow-up).
 * The result's `id` goes into `attachments` of `useCreateSession` / `useSendMessage`; until then it is
 * an unsent upload, dropped by the server after a day.
 */
export function useUploadAttachment(slug: string) {
  return useMutation({ mutationFn: (v: { file: File } & UploadAttachmentOptions) => uploadAttachment(slug, v.file, v) });
}

/** Files an attachment of session `id` into the project. The item's `filedAs` arrives through the session event. */
export function useFileAttachment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { attachmentId: string } & FileAttachmentBody) => fileAttachment(v.attachmentId, { path: v.path, rev: v.rev, message: v.message }),
    onSuccess: () => void catchUp(qc, id),
  });
}

export function useStopSession(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => stopSession(id), onSuccess: (s) => patchSession(qc, s) });
}

export function useAnswerQuestion(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: AnswerBody) => answerQuestion(id, body), onSuccess: (s) => patchSession(qc, s) });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSession(id),
    onSuccess: (_void, id) => {
      qc.removeQueries({ queryKey: sessionKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: ["sessions", "list"] });
    },
  });
}

// ---- realtime ------------------------------------------------------------------------------

type SessionEvent = Extract<DrawerEvent, { type: "session" }>;

/** One delta fetch per session at a time; an event that lands meanwhile asks for another round. */
const syncing = new Map<string, { again: boolean }>();

async function catchUp(qc: QueryClient, id: string): Promise<void> {
  const running = syncing.get(id);
  if (running) {
    running.again = true;
    return;
  }
  const state = { again: true };
  syncing.set(id, state);
  try {
    while (state.again) {
      state.again = false;
      const have = qc.getQueryData<SessionDetail>(sessionKeys.detail(id));
      if (!have) return;
      const delta = await getSession(id, have.session.version);
      qc.setQueryData<SessionDetail>(sessionKeys.detail(id), (old) => mergeDetail(old, delta));
    }
  } catch {
    // The next event or a reconnect retries; a full refetch repairs anything missed.
    void qc.invalidateQueries({ queryKey: sessionKeys.detail(id) });
  } finally {
    syncing.delete(id);
  }
}

/**
 * A `session` event: lists are patched in place (status and activity change often, so no refetch), a
 * session the lists do not know yet refetches them, and an open session fetches only what it has not
 * seen (`?since=<version>`), merged by seq.
 */
export function applySessionEvent(qc: QueryClient, e: SessionEvent): void {
  if (e.deleted) {
    qc.removeQueries({ queryKey: sessionKeys.detail(e.id) });
    void qc.invalidateQueries({ queryKey: ["sessions", "list"] });
    return;
  }
  let known = false;
  const patch = (s: Session): Session => {
    if (s.id !== e.id) return s;
    known = true;
    return s.version > e.version ? s : { ...s, status: e.status, activity: e.activity, version: e.version };
  };
  qc.setQueriesData<Session[]>({ queryKey: ["sessions", "list"] }, (old) => old?.map(patch));
  // Counts (pending, toolCalls) and updatedAt are not in the event: lists catch up on the next refetch.
  if (!known) void qc.invalidateQueries({ queryKey: ["sessions", "list"] });
  const have = qc.getQueryData<SessionDetail>(sessionKeys.detail(e.id));
  if (have && have.session.version < e.version) void catchUp(qc, e.id);
}
