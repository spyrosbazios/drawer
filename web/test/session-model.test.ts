import type { Session, SessionItem } from "@drawer/shared/api";
import { describe, expect, test } from "bun:test";
import type { StepItem } from "@/components/session/model";
import { firstLine, groupRows, groupStrip, lastLine, liveRow, pendingSeqs, pinnedQuestion, stepsTitle, thoughtLabel, visibleSteps } from "@/components/session/model";

const at = "2026-11-20T10:00:00Z";
const tool = (seq: number, summary = "x"): SessionItem => ({ seq, version: seq, at, type: "tool", callId: `c${seq}`, name: "t", summary, status: "ok", result: null, images: [] });
const think = (seq: number, status: "running" | "done" = "done", text = "Looking at it", seconds = 4): SessionItem => ({ seq, version: seq, at, type: "reasoning", reasoningId: `r${seq}`, text, status, seconds });
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

  test("thoughts fold into the run of tool calls they sit in; the group is titled by its tool calls", () => {
    const rows = groupRows([think(1), tool(2), think(3), tool(4), think(5), say(6)]);
    expect(rows.map((r) => r.kind)).toEqual(["steps", "item"]);
    const group = rows[0];
    expect(group?.kind === "steps" && group.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(group?.kind === "steps" && stepsTitle(group.items)).toBe("2 steps");
    const single = groupRows([think(1), tool(2)])[0];
    expect(single?.kind === "steps" && stepsTitle(single.items)).toBe("1 step");
  });

  test("a thought with no tool call in its run stays its own row", () => {
    const rows = groupRows([say(1), think(2), say(3), tool(4), say(5), think(6)]);
    expect(rows.map((r) => r.kind)).toEqual(["item", "thought", "item", "steps", "item", "thought"]);
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
  expect(visibleSteps(steps, null).map((t) => t.seq)).toEqual([3, 4]);
});

test("a folded group shows the live thought, and no other", () => {
  const items = [think(1), tool(2), think(3, "running")].filter((i): i is StepItem => i.type === "tool" || i.type === "reasoning");
  expect(visibleSteps(items, 3).map((t) => t.seq)).toEqual([3]);
  expect(visibleSteps(items, null).map((t) => t.seq)).toEqual([]);
});

describe("the live row", () => {
  const running = (seq: number): SessionItem => ({ ...tool(seq), status: "running" }) as SessionItem;

  test("only the newest item, a thought or a tool call still running, in a working session", () => {
    expect(liveRow([say(1), think(2, "running")], { status: "working" })).toBe(2);
    expect(liveRow([say(1), running(2)], { status: "working" })).toBe(2);
    expect(liveRow([think(1, "running"), say(2)], { status: "working" })).toBeNull();
    expect(liveRow([running(1), say(2)], { status: "working" })).toBeNull();
    expect(liveRow([think(1), tool(2)], { status: "working" })).toBeNull();
    expect(liveRow([running(1), think(2, "running")], { status: "working" })).toBe(2);
    expect(liveRow([think(1, "running"), running(2)], { status: "working" })).toBe(2);
    expect(liveRow([think(1, "running")], { status: "failed" })).toBeNull();
    expect(liveRow([running(1)], { status: "waiting" })).toBeNull();
    expect(liveRow(undefined, { status: "working" })).toBeNull();
  });

  test("never two: one seq is live even with several calls running", () => {
    const items = [running(1), running(2)];
    const live = liveRow(items, { status: "working" });
    expect(items.filter((i) => i.seq === live)).toHaveLength(1);
  });

  test("label and last line", () => {
    expect(thoughtLabel({ seconds: 0 }, true)).toBe("Thinking");
    expect(thoughtLabel({ seconds: 0 }, false)).toBe("Thought");
    expect(thoughtLabel({ seconds: 7 }, false)).toBe("Thought for 7s");
    expect(thoughtLabel({ seconds: 65 }, false)).toBe("Thought for 1m 5s");
    expect(lastLine("**Reading the brief**\n\nThe clip needs a thicker root.\n")).toBe("The clip needs a thicker root.");
    expect(lastLine("")).toBe("");
  });
});
