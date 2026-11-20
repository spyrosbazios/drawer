/**
 * The attempt tree of a part, derived from the history of its model (docs/SPEC.md → Attempts).
 */
import type { Attempt, Author, ReportStatus } from "@drawer/shared/api";

export const RESTORE_RE = /^restore ([0-9a-f]{7,40})$/;

/** One revision that touched the model, oldest first. `modelRev` is null when the revision removed it. */
export interface ModelRevision {
  id: string;
  author: Author;
  message: string;
  date: string;
  modelRev: string | null;
}

export type EvalLookup = (modelRev: string) => { status: ReportStatus; passed: number; total: number } | null;

/**
 * Every revision that wrote the model is an attempt whose parent is the attempt current before it. A
 * restore revision makes an older attempt current without being an attempt itself; a removal leaves
 * nothing current.
 */
export function deriveAttempts(revisions: ModelRevision[], lookup: EvalLookup, modelExists: boolean): Attempt[] {
  const attempts: Attempt[] = [];
  let pointer: string | null = null;
  for (const rev of revisions) {
    const restore = RESTORE_RE.exec(rev.message);
    if (restore?.[1]) {
      const prefix = restore[1];
      const target = attempts.find((a) => a.revisionId.startsWith(prefix));
      if (target) {
        pointer = target.revisionId;
        continue;
      }
    }
    if (rev.modelRev === null) {
      pointer = null;
      continue;
    }
    const evaluated = lookup(rev.modelRev);
    attempts.push({
      revisionId: rev.id,
      parent: pointer,
      author: rev.author,
      message: rev.message,
      date: rev.date,
      current: false,
      status: evaluated?.status ?? null,
      passed: evaluated?.passed ?? null,
      total: evaluated?.total ?? null,
    });
    pointer = rev.id;
  }
  if (modelExists && pointer !== null) {
    const current = attempts.find((a) => a.revisionId === pointer);
    if (current) current.current = true;
  }
  return attempts;
}
