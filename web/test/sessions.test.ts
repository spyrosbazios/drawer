import type { Session, SessionItem } from "@drawer/shared/api";
import { describe, expect, test } from "bun:test";
import { mergeDetail, mergeItems, newestSession } from "@/core/sessions";

const tool = (seq: number, version: number, status: "running" | "ok"): SessionItem => ({
  seq,
  version,
  at: "2026-11-20T10:00:00Z",
  type: "tool",
  callId: `c${seq}`,
  name: "measure",
  summary: "measure",
  status,
  result: null,
  images: [],
});
const text = (seq: number, version: number): SessionItem => ({ seq, version, at: "2026-11-20T10:00:00Z", type: "assistant", text: `t${seq}` });

const session = (id: string, project: string, createdAt: string, version = 1): Session => ({
  id,
  project,
  title: id,
  provider: "claude",
  model: null,
  status: "idle",
  activity: null,
  pending: 0,
  toolCalls: 0,
  seq: 1,
  version,
  error: null,
  createdAt,
  updatedAt: createdAt,
});

describe("session items", () => {
  test("appends new seqs in order and replaces changed ones", () => {
    const merged = mergeItems([text(1, 1), tool(2, 2, "running")], [tool(2, 4, "ok"), text(3, 3)]);
    expect(merged.map((i) => [i.seq, i.version])).toEqual([
      [1, 1],
      [2, 4],
      [3, 3],
    ]);
    expect(merged[1]?.type === "tool" && merged[1].status).toBe("ok");
  });

  test("an older copy never overwrites a newer one", () => {
    expect(mergeItems([tool(2, 5, "ok")], [tool(2, 3, "running")])[0]?.version).toBe(5);
  });

  test("a delta keeps the newest session record", () => {
    const have = { session: session("a", "p", "x", 5), items: [text(1, 1)] };
    const merged = mergeDetail(have, { session: session("a", "p", "x", 7), items: [text(2, 7)] });
    expect(merged.session.version).toBe(7);
    expect(merged.items).toHaveLength(2);
  });

  test("newest session of a project", () => {
    const list = [session("a", "p", "2026-01-01"), session("b", "p", "2026-02-01"), session("c", "q", "2026-03-01")];
    expect(newestSession(list, "p")?.id).toBe("b");
    expect(newestSession(list, "z")).toBeUndefined();
  });
});
