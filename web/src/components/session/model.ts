/**
 * Pure helpers of the session feature: how items become rows, which question is pinned, which part a
 * tool summary names, and how Home's strip groups sessions. No React here; tested in `test/session-model.test.ts`.
 */
import type { Session, SessionItem } from "@drawer/shared/api";

export type ToolItem = Extract<SessionItem, { type: "tool" }>;
export type QuestionItem = Extract<SessionItem, { type: "question" }>;

/** A row of the log: one item, or a run of consecutive tool calls drawn tightly as "steps". */
export type Row = { kind: "item"; item: Exclude<SessionItem, ToolItem> } | { kind: "steps"; key: number; items: ToolItem[] };

/** The question the person still has to answer: the newest unanswered one, if any. */
export function pinnedQuestion(items: readonly SessionItem[]): QuestionItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === "question" && it.answer === null) return it;
  }
  return undefined;
}

/** Items in order, consecutive tool calls grouped; the pinned question is left out (it is drawn above the composer). */
export function groupRows(items: readonly SessionItem[], pinnedSeq?: number): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.seq === pinnedSeq) continue;
    if (item.type === "tool") {
      const last = rows.at(-1);
      if (last?.kind === "steps") last.items.push(item);
      else rows.push({ kind: "steps", key: item.seq, items: [item] });
    } else rows.push({ kind: "item", item });
  }
  return rows;
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

/** What a group of tool calls needs to show while folded: the steps still running and the ones that failed. */
export function visibleSteps(items: readonly ToolItem[]): ToolItem[] {
  return items.filter((t) => t.status !== "ok");
}
