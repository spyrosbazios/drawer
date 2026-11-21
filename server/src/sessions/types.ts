import type {
  Author,
  AnswerBody,
  CreateSessionBody,
  FileAttachmentBody,
  FileAttachmentResult,
  NewSessionItem,
  ProviderStatus,
  RunnerSessionPatch,
  RunnersResponse,
  RunnerWork,
  Session,
  SessionDetail,
  SessionItem,
  SessionAttachment,
  SessionMessageBody,
  WriteResult,
  Settings,
} from "@drawer/shared/api";
import type { EventBus } from "../events.ts";

export interface SessionsOptions {
  /** DRAWER_DATA; sessions live in `<dataDir>/sessions`. */
  dataDir: string;
  bus: EventBus;
  /** Whether a project exists (a session cannot be started on a missing one). */
  projectExists(slug: string): Promise<boolean>;
  /** The project write path every file write goes through (revision, index, events, evaluations). */
  writeFile(slug: string, path: string, bytes: Uint8Array, opts: { rev: string | undefined; author: Author; message: string | undefined }): Promise<WriteResult>;
  /** The current settings: which providers are enabled, and the defaults for a new session. */
  settings(): Settings;
  /** How long a runner may stay silent before it is forgotten. Default 60 000. */
  runnerTtlMs?: number;
  /** How often silent runners are looked for. Default 5 000. */
  sweepMs?: number;
}

/** Which runner process is calling: its configured id and the random nonce it picked at start. */
export interface RunnerIdentity {
  runner: string;
  boot: string;
}

/** What a runner says about itself on every poll. */
export interface RunnerQuery extends RunnerIdentity {
  providers: ProviderStatus[];
  accepting: boolean;
  /** Seconds, already capped. */
  wait: number;
}

export interface Sessions {
  /** Loads what is on disk. */
  init(): Promise<void>;
  /** Ends long polls and timers. */
  close(): void;

  list(project: string | null): Session[];
  create(project: string, body: CreateSessionBody, author: Author): Promise<Session>;
  detail(id: string, since: number): SessionDetail;
  addMessage(id: string, body: SessionMessageBody, author: Author): Promise<Session>;
  stop(id: string): Promise<Session>;
  answer(id: string, body: AnswerBody): Promise<Session>;
  remove(id: string): Promise<void>;
  /** Stores an upload of `project` until a message names it. */
  upload(project: string, name: string, bytes: Uint8Array): Promise<SessionAttachment>;
  /** An attachment's descriptor and where its bytes are on disk. */
  attachment(id: string): { attachment: SessionAttachment; file: string };
  /** Copies an attachment into its project as one revision and records where on its message. */
  fileAttachment(id: string, body: FileAttachmentBody, author: Author): Promise<FileAttachmentResult>;
  runners(): RunnersResponse;
  /** Long poll for a runner. */
  work(query: RunnerQuery, signal: AbortSignal): Promise<RunnerWork>;
  /** By the runner that holds the session only (409 conflict otherwise). */
  appendItem(id: string, item: NewSessionItem, by: RunnerIdentity): Promise<SessionItem>;
  /** By the runner that holds the session only (409 conflict otherwise). */
  patch(id: string, patch: RunnerSessionPatch, by: RunnerIdentity): Promise<Session>;
  /** Long poll for a question's answer; null when the wait ends first. */
  waitAnswer(id: string, questionId: string, wait: number, signal: AbortSignal): Promise<string[] | null>;
  /** The modelling guide, as markdown. */
  guide(): Promise<string>;
}
