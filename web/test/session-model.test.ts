import type { Session, SessionItem } from "@drawer/shared/api";
import { describe, expect, test } from "bun:test";
import { firstLine, groupRows, groupStrip, pendingSeqs, pinnedQuestion, visibleSteps } from "@/components/session/model";

const at = "2026-11-20T10:00:00Z";
const tool = (seq: number, summary = "x"): SessionItem => ({ seq, version: seq, at, type: "tool", callId: `c${seq}`, name: "t", summary, status: "ok", result: null, images: [] });
const say = (seq: number): SessionItem => ({ seq, version: seq, at, type: "assistant", text: "hi" });
const ask = (seq: number, answer: string | null): SessionItem => ({ seq, version: seq, at, type: "question", questionId: `q${seq}`, text: "Agree?", options: ["Agree"], answer });

const s = (id: string, status: Session["status"], updatedAt: string): Session => ({
  id,
  project: "p",
  title: id,
  provider: "claude",
  model: null,
  status,
  activity: null,
  pending: 0,
  toolCalls: 0,
  seq: 1,
  version: 1,
  error: null,
  createdAt: updatedAt,
  updatedAt,
});

describe("session rows", () => {
  test("consecutive tool calls group into one steps row", () => {
    const rows = groupRows([say(1), tool(2), tool(3), say(4), tool(5)]);
    expect(rows.map((r) => (r.kind === "steps" ? r.items.map((i) => i.seq) : r.item.seq))).toEqual([1, [2, 3], 4, [5]]);
  });

  test("the pinned question is left out of the log", () => {
    const items = [ask(1, "Agree"), tool(2), ask(3, null)];
    const pinned = pinnedQuestion(items);
    expect(pinned?.seq).toBe(3);
    expect(groupRows(items, pinned?.seq)).toHaveLength(2);
  });

  test("no pinned question once every question is answered", () => {
    expect(pinnedQuestion([ask(1, "Agree"), say(2)])).toBeUndefined();
  });
});

describe("strip groups", () => {
  test("by what needs the person; old finished ones drop out", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    const g = groupStrip(
      [s("done", "idle", "2026-11-20T11:00:00Z"), s("old", "idle", "2026-11-18T11:00:00Z"), s("run", "working", "2026-11-20T11:59:00Z"), s("ask", "waiting", "2026-11-20T10:00:00Z"), s("q", "queued", at), s("bad", "failed", "2026-11-20T11:30:00Z")],
      now,
    );
    expect([g.waiting, g.working, g.queued, g.recent].map((l) => l.map((x) => x.id))).toEqual([["ask"], ["run"], ["q"], ["bad", "done"]]);
  });
});

test("first line strips markdown marks", () => {
  expect(firstLine("\n## **Before** I start\nmore")).toBe("Before I start");
  expect(firstLine("_Before_ I change it: raise `arm_t` to 1.8 mm")).toBe("Before I change it: raise arm_t to 1.8 mm");
});

describe("queued messages", () => {
  const me = (seq: number): SessionItem => ({ seq, version: seq, at, type: "user", text: "x", refs: [], attachments: [], author: "web" });
  const items = [me(1), say(2), me(3), me(4)];

  test("the newest `pending` user messages are queued while a turn runs", () => {
    expect([...pendingSeqs(items, { status: "working", pending: 2 })]).toEqual([4, 3]);
    expect([...pendingSeqs(items, { status: "waiting", pending: 1 })]).toEqual([4]);
  });

  test("other states say it in the header chip, not on the bubble", () => {
    expect(pendingSeqs(items, { status: "queued", pending: 1 }).size).toBe(0);
    expect(pendingSeqs(items, { status: "working", pending: 0 }).size).toBe(0);
  });
});

test("a folded group keeps the running and the failed steps in view", () => {
  const run: SessionItem = { ...tool(3), status: "running" } as SessionItem;
  const bad: SessionItem = { ...tool(4), status: "error" } as SessionItem;
  const steps = [tool(2), run, bad].filter((i) => i.type === "tool");
  expect(visibleSteps(steps).map((t) => t.seq)).toEqual([3, 4]);
});
