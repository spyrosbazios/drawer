/**
 * Pure helpers of the session feature: how items become rows, which question is pinned and what its form answers, which part a
 * tool summary names, and how Home's strip groups sessions. No React here; tested in `test/session-model.test.ts`.
 */
import type { Session, SessionItem } from "@drawer/shared/api";

export type ToolItem = Extract<SessionItem, { type: "tool" }>;
export type QuestionItem = Extract<SessionItem, { type: "question" }>;
export type ReasoningItem = Extract<SessionItem, { type: "reasoning" }>;
/** What a "steps" group folds: tool calls, and the thoughts between them. */
export type StepItem = ToolItem | ReasoningItem;

/**
 * A row of the log: one item; a thought on its own; or a run of consecutive tool calls and thoughts drawn
 * tightly as "steps". A run with a tool call in it is one group (a lone call stands alone); a run of
 * thoughts only (the model thought, then answered) stays as thought rows, so a turn reads: steps, answer.
 */
export type Row =
  | { kind: "item"; item: Exclude<SessionItem, StepItem> }
  | { kind: "thought"; item: ReasoningItem }
  | { kind: "steps"; key: number; items: StepItem[] };

/** The row's stable key: the item's seq, or `s<seq of its first item>` for a group. */
export function rowKey(row: Row): string {
  return row.kind === "steps" ? `s${row.key}` : String(row.item.seq);
}

/** The question the person still has to answer: the newest unanswered one, if any. */
export function pinnedQuestion(items: readonly SessionItem[]): QuestionItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === "question" && it.answers === null) return it;
  }
  return undefined;
}

/** A question form's values (the picks in order, then the typed text) as the answers to send: trimmed, blanks and repeats dropped. */
export function answersOf(values: readonly FormDataEntryValue[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const answer = typeof v === "string" ? v.trim() : "";
    if (answer !== "" && !out.includes(answer)) out.push(answer);
  }
  return out;
}

/** Items in order, runs of tool calls and thoughts grouped; the pinned question is left out (it is drawn above the composer). */
export function groupRows(items: readonly SessionItem[], pinnedSeq?: number): Row[] {
  const rows: Row[] = [];
  let run: StepItem[] = [];
  const endRun = () => {
    if (run.some((i) => i.type === "tool")) rows.push({ kind: "steps", key: (run[0] as StepItem).seq, items: run });
    else for (const item of run) if (item.type === "reasoning") rows.push({ kind: "thought", item });
    run = [];
  };
  for (const item of items) {
    if (item.seq === pinnedSeq) continue;
    if (item.type === "tool" || item.type === "reasoning") run.push(item);
    else {
      endRun();
      rows.push({ kind: "item", item });
    }
  }
  endRun();
  return rows;
}

/**
 * The seq of the row that is live: the newest item when it is a thought or a tool call still running, in a
 * session that is working. The thread has exactly one live row: that one when there is one, else the tail
 * (the session's activity), which gives way to it.
 */
export function liveRow(items: readonly SessionItem[] | undefined, session: Pick<Session, "status">): number | null {
  const last = items?.at(-1);
  return session.status === "working" && (last?.type === "reasoning" || last?.type === "tool") && last.status === "running" ? last.seq : null;
}

/** "Thinking" while it runs; afterwards "Thought for 7s" (just "Thought" under a second). */
export function thoughtLabel(item: Pick<ReasoningItem, "seconds">, running: boolean): string {
  if (running) return "Thinking";
  if (item.seconds < 1) return "Thought";
  return item.seconds < 60 ? `Thought for ${item.seconds}s` : `Thought for ${Math.floor(item.seconds / 60)}m ${item.seconds % 60}s`;
}

/** The last non-empty line of a thought, without markdown emphasis: what it is on right now. */
export function lastLine(text: string): string {
  return firstLine(text.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "");
}

/** The first non-empty line of a text, without markdown emphasis or heading marks. */
export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  // An underscore inside a word (arm_t) is a name, not emphasis: markdown leaves it alone, and so does this.
  return line
    .replace(/^#+\s*/, "")
    .replace(/[*`]/g, "")
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "")
    .trim();
}

export interface StripGroups {
  waiting: Session[];
  working: Session[];
  queued: Session[];
  /** idle, failed or stopped within the last day, newest first, at most `recentMax`. */
  recent: Session[];
}

const RECENT_MS = 24 * 3600_000;
const newestFirst = (a: Session, b: Session) => b.updatedAt.localeCompare(a.updatedAt);

/** Home's strip, grouped by what needs the person: waiting, then working, queued, recently finished. */
export function groupStrip(sessions: readonly Session[], now: number, recentMax = 4): StripGroups {
  const by = (status: Session["status"]) => sessions.filter((s) => s.status === status).sort(newestFirst);
  const recent = sessions
    .filter((s) => (s.status === "idle" || s.status === "failed" || s.status === "stopped") && now - Date.parse(s.updatedAt) < RECENT_MS)
    .sort(newestFirst)
    .slice(0, recentMax);
  return { waiting: by("waiting"), working: by("working"), queued: by("queued"), recent };
}

/**
 * The user messages the agent has not seen yet, shown as "queued" in the thread: the newest `pending` of
 * them, while a turn runs or waits for an answer. In the other states the header chip already says it.
 */
export function pendingSeqs(items: readonly SessionItem[], session: Pick<Session, "status" | "pending">): ReadonlySet<number> {
  const out = new Set<number>();
  if (session.pending <= 0 || (session.status !== "working" && session.status !== "waiting")) return out;
  for (let i = items.length - 1; i >= 0 && out.size < session.pending; i--) {
    const it = items[i];
    if (it?.type === "user") out.add(it.seq);
  }
  return out;
}

/** What a folded group still shows: the tool calls that are running or failed, and the live thought. */
export function visibleSteps(items: readonly StepItem[], liveSeq: number | null): StepItem[] {
  return items.filter((i) => (i.type === "tool" ? i.status !== "ok" : i.seq === liveSeq));
}

/** How a group is titled: by its tool calls, since the thoughts are what happened between them. */
export function stepsTitle(items: readonly StepItem[]): string {
  const calls = items.filter((i) => i.type === "tool").length;
  return `${calls} ${calls === 1 ? "step" : "steps"}`;
}
