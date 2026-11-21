import type { Session, SessionDetail, SessionItem, SessionStatus } from "@drawer/shared/api";

/**
 * Merges items fetched with `?since=` into what the cache holds. `seq` is an item's place and never
 * changes; a newer `version` of the same seq replaces it (a tool call finishing, a question answered).
 * The result is ordered by seq.
 */
export function mergeItems(have: readonly SessionItem[], incoming: readonly SessionItem[]): SessionItem[] {
  if (incoming.length === 0) return [...have];
  const bySeq = new Map<number, SessionItem>();
  for (const item of have) bySeq.set(item.seq, item);
  for (const item of incoming) {
    const old = bySeq.get(item.seq);
    if (!old || old.version <= item.version) bySeq.set(item.seq, item);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Applies a `?since=` response to a cached detail; the newer session record wins. */
export function mergeDetail(have: SessionDetail | undefined, delta: SessionDetail): SessionDetail {
  if (!have) return delta;
  const session = delta.session.version >= have.session.version ? delta.session : have.session;
  return { session, items: mergeItems(have.items, delta.items) };
}

/** A session a person should look at: the agent asked something. */
export const needsYou = (s: Pick<Session, "status">): boolean => s.status === "waiting";

/** The agent is busy (or about to be). */
export const isActive = (s: Pick<Session, "status">): boolean => s.status === "working" || s.status === "queued";

/** A turn is in progress: the agent is busy, or waits for an answer. The session can be stopped. */
export const isOngoing = (s: Pick<Session, "status">): boolean => isActive(s) || needsYou(s);

/** Whether a person can resume the session by sending a message. */
export const canResume = (status: SessionStatus): boolean => status === "stopped" || status === "failed" || status === "idle";

/** The session a workspace shows when the address names none: the project's newest. */
export function newestSession(sessions: readonly Session[] | undefined, project: string): Session | undefined {
  let best: Session | undefined;
  for (const s of sessions ?? []) {
    if (s.project !== project) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best;
}
