import { describe, expect, test } from "bun:test";
import type { AssemblyReport, GateResult, PartReport, PartSummary, Session } from "@drawer/shared/api";
import { projectActivity } from "@/components/workspace/activity";
import { defaultSelection } from "@/components/workspace/default-selection";
import { briefHasContent, kickstartActions, kickstartPrompt } from "@/components/workspace/kickstart";
import { gatesSummary, reviewDefaults, specSummary } from "@/components/review/review-model";
import { parseFlags } from "@/lib/local-pref";

const session = (project: string, status: Session["status"]) => ({ id: `${project}-${status}`, project, status }) as Session;
const part = (id: string, source: PartSummary["source"] = "printed") => ({ id, source }) as PartSummary;
const gate = (id: string, status: GateResult["status"]): GateResult => ({ id, label: id, status, measured: null, expected: null, detail: null, hint: null, at: null });

describe("agent activity", () => {
  test("waiting outranks working, other projects and idle sessions do not count", () => {
    expect(projectActivity([session("a", "working"), session("a", "waiting")], "a")).toBe("waiting");
    expect(projectActivity([session("a", "idle"), session("b", "working")], "a")).toBeNull();
    expect(projectActivity([session("a", "working")], "a")).toBe("working");
    expect(projectActivity(undefined, "a")).toBeNull();
  });
});

describe("default selection", () => {
  test("assembly first, then the first printed part, else nothing", () => {
    const asm = {} as AssemblyReport;
    expect(defaultSelection([part("a")], asm, false)).toEqual({ kind: "assembly" });
    expect(defaultSelection([part("screw", "bought"), part("b")], null, false)).toEqual({ kind: "part", part: "b" });
    expect(defaultSelection([part("screw", "bought")], null, false)).toEqual({ kind: "part", part: "screw" });
    expect(defaultSelection([], null, false)).toBeNull();
  });
  test("the library never opens on an assembly", () => {
    expect(defaultSelection([part("a")], {} as AssemblyReport, true)).toEqual({ kind: "part", part: "a" });
  });
});

describe("kickstart", () => {
  const ctx = { library: false, hasBrief: false, refs: 0 };
  test("an empty brief starts with the interview, a written one with the first part", () => {
    expect(kickstartActions(ctx).map((a) => a.id)).toEqual(["interview", "import"]);
    expect(kickstartActions({ ...ctx, refs: 2 }).map((a) => a.id)).toEqual(["interview", "study-refs", "import"]);
    expect(kickstartActions({ ...ctx, hasBrief: true }).map((a) => a.id)).toEqual(["first-part", "plan", "interview", "import"]);
  });
  test("the library has one action", () => {
    expect(kickstartActions({ ...ctx, library: true }).map((a) => a.id)).toEqual(["library"]);
  });
  test("every prompt asks before modelling or follows the guide's order", () => {
    for (const a of kickstartActions({ ...ctx, hasBrief: true, refs: 1 })) if (a.kind === "prompt") expect(kickstartPrompt(a.id, { ...ctx, hasBrief: true, refs: 1 })).toContain("ask_user");
    expect(kickstartPrompt("interview", ctx)).toContain("brief is empty");
    expect(kickstartPrompt("interview", { ...ctx, hasBrief: true })).not.toContain("brief is empty");
    expect(kickstartPrompt("first-part", { ...ctx, refs: 3 })).toContain("3 references");
    expect(kickstartPrompt("first-part", ctx)).not.toContain("references under");
    expect(kickstartPrompt("library", { ...ctx, library: true })).toContain("do not change printer.json");
  });
  test("a brief with only a title is empty", () => {
    expect(briefHasContent("# New idea\n\n")).toBe(false);
    expect(briefHasContent(undefined)).toBe(false);
    expect(briefHasContent("# Tray\n\nA tray for pens.\n")).toBe(true);
  });
});

describe("review sections", () => {
  const report = (gates: GateResult[], dimensions: PartReport["spec"]["dimensions"] = [], next: string[] = []) =>
    ({ gates, passed: gates.filter((g) => g.status === "pass").length, total: gates.length, next, spec: { dimensions } }) as PartReport;
  const dim = (id: string) => ({ id, label: id, kind: "size" as const });

  test("failing things start open, passing ones closed", () => {
    const ok = reviewDefaults(report([gate("dim:a", "pass")], [dim("a")]));
    expect(ok).toMatchObject({ verdict: true, spec: false, gates: false, params: false, next: false });
    const bad = reviewDefaults(report([gate("dim:a", "fail")], [dim("a")], ["Raise arm_t"]));
    expect(bad).toMatchObject({ spec: true, gates: true, next: true });
  });
  test("a spec with no dimensions starts open", () => {
    expect(reviewDefaults(report([])).spec).toBe(true);
  });
  test("summaries", () => {
    const r = report([gate("dim:a", "fail"), gate("dim:b", "pass"), gate("lint", "warn")], [dim("a"), dim("b")]);
    expect(gatesSummary(r)).toEqual({ text: "2 failing", failing: true });
    expect(specSummary(r)).toEqual({ text: "1 of 2 failing", failing: true });
    const ok = report([gate("dim:a", "pass")], [dim("a")]);
    expect(gatesSummary(ok)).toEqual({ text: "1 of 1 pass", failing: false });
    expect(specSummary(ok)).toEqual({ text: "1 dimension", failing: false });
  });
});

describe("remembered section state", () => {
  test("only booleans survive", () => {
    expect(parseFlags({ a: true, b: false, c: "x", d: 1 })).toEqual({ a: true, b: false });
    expect(parseFlags([true])).toBeUndefined();
    expect(parseFlags(null)).toBeUndefined();
  });
});
