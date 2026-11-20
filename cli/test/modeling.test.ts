import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AssemblyReport,
  Attempt,
  CompareResult,
  PartReport,
  PartSummary,
  Project,
  ProjectOverview,
  ProbeResult,
  Session,
  SessionDetail,
  SliceResult,
  WriteResult,
} from "@drawer/shared/api";
import { FakeDrawer } from "./fake-server.ts";
import { sandbox } from "./helpers.ts";

const fake = new FakeDrawer();
const sb = sandbox(fake.url);
afterAll(() => {
  fake.stop();
  sb.dispose();
});

const SPEC = { title: "Lid", class: "clip", description: "", source: "printed", material: "PETG", strictness: "standard", dimensions: [], waivers: [], prints: [] };
const MODEL = "// A lid\nwall = 1.6;\ncube([40, 30, 12.5]);\n";

type Spec = typeof SPEC;
const seedPart = (id: string, model: string | null = MODEL, spec: Partial<Spec> = {}) => {
  fake.seed("box", `parts/${id}.part.json`, JSON.stringify({ ...SPEC, ...spec }));
  if (model !== null) fake.seed("box", `parts/${id}.scad`, model);
};

const lastWrite = () => [...fake.requests].reverse().find((r) => r.method !== "GET");
const posts = (suffix: string) => fake.requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix));
const bodyOf = (request: { body: string } | undefined): Record<string, unknown> => JSON.parse(request?.body ?? "{}");
const cacheRoot = () => join(sb.cache, "drawer", "renders");

beforeEach(() => {
  for (const [slug] of fake.projects) if (slug !== "_library") fake.projects.delete(slug);
  fake.files.clear();
  fake.files.set("_library", new Map());
  fake.requests.length = 0;
  fake.downloads.length = 0;
  fake.revisions.length = 0;
  fake.modeling.attempts.clear();
  fake.modeling.sessions.clear();
  fake.failNext = null;
  fake.addProject("box", "A box");
  fake.seed("box", "AGENTS.md", "# Box\n- [decision] use M3 screws\n");
  fake.seed("box", "refs/original.stl", new Uint8Array([0, 1, 2, 255]));
});

// ---- write and edit feedback -------------------------------------------------------------------

describe("write and edit: check and report", () => {
  test("a .scad outside any part prints the check with file:line and waits for nothing", async () => {
    const r = await sb.run(["write", "box/src/x.scad", "--text"], { stdin: "SYNTAX_ERROR WARN_UNUSED\n" });
    expect(r.code).toBe(0);
    expect(r.out.split("\n").slice(0, 4)).toEqual([
      expect.stringMatching(/^created box\/src\/x\.scad {2}rev [0-9a-f]{16}$/),
      "check: 1 error, 1 warning",
      "  error   src/x.scad:1  syntax error",
      "  warning src/x.scad:2  variable x not specified",
    ]);
    expect(posts("/evaluate")).toHaveLength(0);
    const json = await sb.run(["write", "box/src/y.scad"], { stdin: "WARN_UNUSED\n" });
    expect(json.json<WriteResult>().check?.diagnostics[0]).toMatchObject({ level: "warning", file: "src/y.scad", line: 2 });
  });

  test("a clean .scad says `check ok`; other files print no check", async () => {
    expect((await sb.run(["write", "box/src/ok.scad", "--text"], { stdin: "cube(1);\n" })).out).toContain("\ncheck ok\n");
    const note = await sb.run(["write", "box/notes/a.md", "--text"], { stdin: "# A\n" });
    expect(note.out).toMatch(/^created box\/notes\/a\.md {2}rev [0-9a-f]{16}\n$/);
  });

  test("writing a part's model waits for the evaluation and prints the report", async () => {
    seedPart("lid", null);
    const r = await sb.run(["write", "box/parts/lid.scad", "--text"], { stdin: `${MODEL}THIN SMALL_BORE\n` });
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^created box\/parts\/lid\.scad {2}rev [0-9a-f]{16}$/);
    expect(lines[1]).toBe("check ok");
    expect(lines[2]).toBe("");
    expect(lines[3]).toMatch(/^draft 4\/6 {2}box\/lid {2}Lid {2}\(printed, PETG, standard\) {2}revision r\d+$/);
    expect(posts("/parts/lid/evaluate")).toHaveLength(1);
    expect(bodyOf(posts("/evaluate")[0])).toEqual({});
  });

  test("--no-report skips the wait and says how to get the report", async () => {
    seedPart("lid", null);
    const r = await sb.run(["write", "box/parts/lid.scad", "--no-report", "--text"], { stdin: MODEL });
    expect(r.code).toBe(0);
    expect(posts("/evaluate")).toHaveLength(0);
    expect(r.out).toContain("evaluation of lid queued; `drawer report box/lid` waits for it");
    expect(r.out).not.toContain("passed");
  });

  test("JSON is the WriteResult with the report and its local pictures", async () => {
    seedPart("lid", null);
    const r = await sb.run(["write", "box/parts/lid.scad"], { stdin: MODEL });
    const out = r.json<WriteResult & { report: PartReport & { pictures: { sheet: string; views: Record<string, string> } } }>();
    expect(out).toMatchObject({ project: "box", part: "lid", created: true, check: { ok: true } });
    expect(out.report).toMatchObject({ part: "lid", status: "passed", passed: 6, total: 6 });
    expect(out.report.pictures.sheet.startsWith(cacheRoot())).toBe(true);
    expect(existsSync(out.report.pictures.sheet)).toBe(true);
    expect(Object.keys(out.report.pictures.views)).toEqual(["iso", "front", "top", "side"]);
    const noReport = await sb.run(["write", "box/parts/lid.scad", "--rev", out.rev, "--no-report"], { stdin: MODEL });
    expect("report" in noReport.json<object>()).toBe(false);
  });

  test("a part's spec file triggers the evaluation too", async () => {
    seedPart("lid");
    const rev = fake.file("box", "parts/lid.part.json")?.rev ?? "";
    const r = await sb.run(["write", "box/parts/lid.part.json", "--rev", rev, "--text"], { stdin: JSON.stringify({ ...SPEC, title: "Lid v2" }) });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("check");
    expect(r.out).toContain("box/lid  Lid v2");
  });

  test("edit of a model prints the check and the report", async () => {
    seedPart("lid");
    const rev = fake.file("box", "parts/lid.scad")?.rev ?? "";
    const r = await sb.run(["edit", "box/parts/lid.scad", "--rev", rev, "--old", "wall = 1.6;", "--new", "wall = 0.8; THIN", "--text"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^edited box\/parts\/lid\.scad {2}rev [0-9a-f]{16}\ncheck ok\n\ndraft 5\/6 /);
    expect(r.out).toContain("fail    Thinnest wall  [min_wall]");
    expect(posts("/evaluate")).toHaveLength(1);
    const skipped = await sb.run(["edit", "box/parts/lid.scad", "--rev", fake.file("box", "parts/lid.scad")?.rev ?? "", "--old", "THIN", "--new", "", "--no-report"]);
    expect(skipped.code).toBe(0);
    expect(posts("/evaluate")).toHaveLength(1);
  });

  test("a model that does not parse: check errors, then a failed report with the hint", async () => {
    seedPart("lid", null);
    const r = await sb.run(["write", "box/parts/lid.scad", "--text"], { stdin: "SYNTAX_ERROR\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("check: 1 error, 0 warnings\n  error   parts/lid.scad:1  syntax error\n");
    expect(r.out).toContain("failed 0/1  box/lid");
    expect(r.out).toContain("fail    Builds a solid  [parses]\n        OpenSCAD reported an error\n        hint: fix the syntax error reported by the check, then write again\n");
    expect(r.out).toContain("skip    One watertight body  [solid]\n        no mesh: parses failed");
    expect(r.out).toContain("no mesh\n");
    expect(r.out).not.toContain("pictures:");
  });

  test("when the report fails after the write, the write stands and the error says so", async () => {
    const r = await sb.run(["write", "box/parts/orphan.scad"], { stdin: MODEL });
    expect(r.code).toBe(1);
    expect(r.err).toContain("the write succeeded, but the report failed: no part orphan");
    expect(r.err).toContain("drawer report box/orphan");
    expect(fake.text("box", "parts/orphan.scad")).toBe(MODEL);
    expect(r.json<WriteResult>().part).toBe("orphan");
  });
});

// ---- report ----------------------------------------------------------------------------------

describe("report", () => {
  test("text: verdict, failing gates first with hints, next steps, params, then pictures", async () => {
    seedPart("lid", `${MODEL}THIN SMALL_BORE\n`);
    const r = await sb.run(["report", "box/lid", "--text"]);
    expect(r.code).toBe(0);
    const text = r.out.replace(new RegExp(cacheRoot().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "<cache>").replace(/revision r\d+/, "revision rN").replace(/\/[0-9a-f]{16}0{8}\//g, "/<key>/");
    expect(text).toBe(
      [
        "draft 4/6  box/lid  Lid  (printed, PETG, standard)  revision rN",
        "size 40 x 30 x 12.5 mm, volume 8.13 cm3, 1234 triangles, 10.3 g",
        "fail    Bore for the M3 screw  [dim:bore]  measured 3.1 mm, expected 3.4 ±0.1 mm",
        "        hint: increase hole_d by 0.3",
        "        at 10, 5, 6",
        "fail    Thinnest wall  [min_wall]  measured 0.8 mm, expected >= 1.2 mm",
        "        the wall at the rim is too thin to print",
        "        hint: raise wall to at least 1.6",
        "pass    Builds a solid  [parses]",
        "pass    One watertight body  [solid]  measured 1 shell, expected 1 shell",
        "pass    Fits the bed  [fits_bed]  measured 40 x 30 mm, expected <= 220 x 220 mm",
        "pass    Source conventions  [lint]",
        "next:",
        "  1. Bore for the M3 screw: increase hole_d by 0.3",
        "  2. Thinnest wall: raise wall to at least 1.6",
        "params: wall=1.6",
        "pictures:",
        "  sheet  <cache>/<key>/sheet.png",
        "  iso    <cache>/<key>/iso.png",
        "  front  <cache>/<key>/front.png",
        "  top    <cache>/<key>/top.png",
        "  side   <cache>/<key>/side.png",
        "",
      ].join("\n"),
    );
    expect(fake.requests.some((q) => q.method === "POST")).toBe(false);
  });

  test("warnings sort after failures; a passed part says it is done", async () => {
    seedPart("lid", `${MODEL}NOLINT SMALL_BORE\n`);
    const warn = (await sb.run(["report", "box/lid", "--text"])).out.split("\n");
    expect(warn.findIndex((l) => l.startsWith("fail"))).toBeLessThan(warn.findIndex((l) => l.startsWith("warn")));
    expect(warn.findIndex((l) => l.startsWith("warn"))).toBeLessThan(warn.findIndex((l) => l.startsWith("pass")));

    seedPart("ok", MODEL);
    const ok = await sb.run(["report", "box/ok", "--text"]);
    expect(ok.out).toContain("passed 6/6  box/ok");
    expect(ok.out).toContain("done: every gate passes or is waived");
    expect(ok.out).not.toContain("next:");
  });

  test("a waived gate shows the waiver's reason", async () => {
    seedPart("lid", `${MODEL}SMALL_BORE\n`, { waivers: [{ gate: "dim:bore", reason: "printed and it fits", by: "web", at: "2026-11-20" }] as never });
    const r = await sb.run(["report", "box/lid", "--text"]);
    expect(r.out).toContain("passed 6/6");
    expect(r.out).toContain("waived  Bore for the M3 screw  [dim:bore]  measured 3.1 mm, expected 3.4 ±0.1 mm\n        waived: printed and it fits");
  });

  test("an empty part (no model) says what to do", async () => {
    seedPart("lid", null);
    const r = await sb.run(["report", "box/lid", "--text"]);
    expect(r.out).toContain("empty 0/0  box/lid");
    expect(r.out).toContain("1. write the model to parts/lid.scad");
  });

  test("JSON is the PartReport plus local picture paths", async () => {
    seedPart("lid");
    const r = await sb.run(["report", "box/lid"]);
    const report = r.json<PartReport & { pictures: { sheet: string } }>();
    expect(report).toMatchObject({ project: "box", part: "lid", status: "passed", whatIf: false });
    expect(report.render?.sheet).toMatch(/^\/api\/renders\//);
    expect(existsSync(report.pictures.sheet)).toBe(true);
  });

  test("--param is a what-if: it evaluates with the values and says so", async () => {
    seedPart("lid", `${MODEL}THIN\n`);
    const r = await sb.run(["report", "box/lid", "--param", "wall=2.4", "--param", "label=hi", "--param", "v=[1,2,3]", "--param", "on=true", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(posts("/evaluate")[0])).toEqual({ params: { wall: 2.4, label: "hi", v: [1, 2, 3], on: true } });
    expect(r.out).toContain("what-if passed 6/6  box/lid");
    expect(r.out).toContain("what-if: parameters were overridden and nothing was written; this is not the part's status");
    expect(r.out).toContain("params: wall=2.4");
  });

  test("--at evaluates a past revision", async () => {
    seedPart("lid");
    await sb.run(["report", "box/lid", "--at", "r3"]);
    expect(bodyOf(posts("/evaluate")[0])).toEqual({ at: "r3" });
  });

  test("exit 0 whatever the status; --require-passed exits 1 unless passed, output kept", async () => {
    seedPart("lid", `${MODEL}THIN\n`);
    expect((await sb.run(["report", "box/lid"])).code).toBe(0);
    const strict = await sb.run(["report", "box/lid", "--require-passed", "--text"]);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("draft 5/6");
    expect(strict.err).toContain("box/lid is draft 5/6, not passed");
    seedPart("ok");
    expect((await sb.run(["report", "box/ok", "--require-passed"])).code).toBe(0);
  });

  test("bad arguments are usage errors; an unknown part exits 3", async () => {
    expect((await sb.run(["report", "box"])).code).toBe(1);
    expect((await sb.run(["report", "box/Bad_Id"])).code).toBe(1);
    expect((await sb.run(["report", "box/lid", "--param", "wall"])).code).toBe(1);
    expect((await sb.run(["report", "box/ghost"])).code).toBe(3);
  });
});

// ---- set --------------------------------------------------------------------------------------

describe("set", () => {
  test("writes values into the model with its current rev, then prints the report", async () => {
    seedPart("lid", `${MODEL}THIN\n`);
    const rev = fake.file("box", "parts/lid.scad")?.rev;
    const r = await sb.run(["set", "box/lid", "wall=2.4", "-m", "thicker wall", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(posts("/params")[0])).toEqual({ rev, values: { wall: 2.4 }, message: "thicker wall" });
    expect(fake.text("box", "parts/lid.scad")).toContain("wall = 2.4;");
    expect(r.out).toMatch(/^set parameters in box\/parts\/lid\.scad {2}rev [0-9a-f]{16}\ncheck ok\n\n(draft|passed) /);
    expect(posts("/evaluate")).toHaveLength(1);
  });

  test("--no-report skips the evaluation; a name the model lacks is exit 1", async () => {
    seedPart("lid");
    expect((await sb.run(["set", "box/lid", "wall=3", "--no-report"])).code).toBe(0);
    expect(posts("/evaluate")).toHaveLength(0);
    const bad = await sb.run(["set", "box/lid", "nope=3"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("no top-level parameter nope");
  });

  test("usage errors send nothing; a part without a model is exit 3", async () => {
    seedPart("lid");
    fake.requests.length = 0;
    expect((await sb.run(["set", "box/lid"])).code).toBe(1);
    expect((await sb.run(["set", "box/lid", "wall"])).code).toBe(1);
    expect(fake.requests).toHaveLength(0);
    seedPart("bare", null);
    expect((await sb.run(["set", "box/bare", "wall=1"])).code).toBe(3);
  });
});

// ---- parts, part, overview, guide ---------------------------------------------------------------

describe("parts, part, overview, guide", () => {
  test("parts lists status and failing gates", async () => {
    seedPart("lid", `${MODEL}THIN SMALL_BORE\n`);
    seedPart("base");
    const text = await sb.run(["parts", "box", "--text"]);
    expect(text.out).toContain("base  passed 6/6  Lid [clip]  printed PETG standard\n");
    expect(text.out).toContain("lid  draft 4/6  Lid [clip]  printed PETG standard  failing: Bore for the M3 screw; Thinnest wall\n");
    expect((await sb.run(["parts", "box"])).json<{ parts: PartSummary[] }>().parts.map((p) => p.id)).toEqual(["lid", "base"]);
    fake.addProject("empty", "Empty");
    expect((await sb.run(["parts", "empty", "--text"])).out).toBe("no parts\n");
  });

  test("part creates from flags; the project's defaults fill the rest", async () => {
    const r = await sb.run(["part", "box/clip", "--title", "Snap clip", "--class", "snap-fit clip", "--strictness", "functional", "--description", "holds the lid"]);
    expect(r.code).toBe(0);
    expect(bodyOf(lastWrite())).toEqual({ title: "Snap clip", class: "snap-fit clip", description: "holds the lid", strictness: "functional" });
    expect(r.json<PartSummary>()).toMatchObject({ id: "clip", title: "Snap clip", strictness: "functional", status: "empty" });
    expect((await sb.run(["part", "box/clip2", "--title", "x", "--text"])).out).toMatch(/^box\/clip2 {2}empty 0\/0 /);
  });

  test("--spec reads a PartSpecBody and flags win over it", async () => {
    const dims = [{ id: "bore", label: "Bore", kind: "hole", axis: "z", at: 6, near: [10, 5], nominal: 3.4, tol: 0.1 }];
    await Bun.write(join(sb.home, "spec.json"), JSON.stringify({ title: "From file", material: "PLA", dimensions: dims }));
    const r = await sb.run(["part", "box/clip", "--spec", join(sb.home, "spec.json"), "--material", "PETG"]);
    expect(r.code).toBe(0);
    expect(bodyOf(lastWrite())).toEqual({ title: "From file", material: "PETG", dimensions: dims });
  });

  test("flags alone change an existing spec: its title is kept, waivers and prints are not sent", async () => {
    seedPart("lid", MODEL, { waivers: [{ gate: "lint", reason: "x", by: "web", at: "t" }] as never, prints: [{ revisionId: "r1", at: "t", outcome: "ok", note: "" }] as never });
    const r = await sb.run(["part", "box/lid", "--material", "PLA", "--source", "bought"]);
    expect(r.code).toBe(0);
    const body = bodyOf(lastWrite());
    expect(body).toMatchObject({ title: "Lid", class: "clip", material: "PLA", source: "bought", dimensions: [] });
    expect(body).not.toHaveProperty("waivers");
    expect(body).not.toHaveProperty("prints");
  });

  test("part errors: no title for a new part, nothing to set, bad values, unreadable spec", async () => {
    fake.requests.length = 0;
    expect((await sb.run(["part", "box/new", "--material", "PLA"])).err).toContain("--title is needed to create a part");
    expect((await sb.run(["part", "box/new"])).err).toContain("nothing to set");
    expect((await sb.run(["part", "box/new", "--title", "x", "--strictness", "lax"])).code).toBe(1);
    expect((await sb.run(["part", "box/new", "--title", "x", "--source", "bought-ish"])).code).toBe(1);
    expect((await sb.run(["part", "box/new", "--spec", join(sb.home, "missing.json")])).code).toBe(1);
    await Bun.write(join(sb.home, "bad.json"), "{nope");
    expect((await sb.run(["part", "box/new", "--spec", join(sb.home, "bad.json")])).err).toContain("not valid JSON");
    expect(fake.requests.filter((q) => q.method === "PUT")).toHaveLength(0);
  });

  test("a spec the server rejects is exit 1 with its message", async () => {
    await Bun.write(join(sb.home, "spec.json"), JSON.stringify({ title: "x", waivers: [] }));
    const r = await sb.run(["part", "box/clip", "--spec", join(sb.home, "spec.json")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown fields: waivers");
  });

  test("overview prints brief, memory, parts, assembly and the library", async () => {
    fake.seed("box", "brief.md", "A lid for the box, 40 mm wide.");
    fake.seed("box", "notes/fit.md", "# Fit\n");
    seedPart("lid", `${MODEL}THIN\n`);
    const text = await sb.run(["overview", "box", "--text"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("box  A box\nstatus empty: 0 parts");
    expect(text.out).toContain("new parts default to PETG, standard");
    expect(text.out).toContain("== brief (brief.md)\nA lid for the box, 40 mm wide.");
    expect(text.out).toContain("== project memory (AGENTS.md)\n# Box\n- [decision] use M3 screws");
    expect(text.out).toContain("== parts\nlid  draft 5/6  Lid [clip]  printed PETG standard  failing: Thinnest wall");
    expect(text.out).toContain("assembly: none");
    expect(text.out).toContain("references: refs/original.stl\nnotes: notes/fit.md");
    expect(text.out).toContain("printer: Test printer  bed 220 x 220 x 250 mm  nozzle 0.4  layer 0.2  min wall 1.2 mm");
    expect(text.out).toContain("material: PETG  1.27 g/cm3, min wall 1.2 mm  tough");
    expect(text.out).toContain("notes: tolerances.md");
    expect((await sb.run(["overview", "box"])).json<ProjectOverview>()).toMatchObject({ brief: "A lid for the box, 40 mm wide." });
    expect((await sb.run(["overview", "ghost"])).code).toBe(3);
  });

  test("guide prints the markdown untouched, even piped; --json wraps it", async () => {
    const r = await sb.run(["guide"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("# Modelling guide\n\nRead first.\n");
    expect((await sb.run(["guide", "--json"])).json<{ guide: string }>().guide).toContain("Modelling guide");
  });
});

// ---- measuring --------------------------------------------------------------------------------

describe("measure, slice, probe, section", () => {
  beforeEach(() => {
    fake.seed("box", "src/lid.scad", "cube(1);\n");
  });

  test("measure prints the analysis and local picture paths; --param and --at are sent", async () => {
    const r = await sb.run(["measure", "box/src/lid.scad", "--param", "wall=2", "--at", "r4", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(posts("/measure/src/lid.scad")[0])).toEqual({ revision: "r4", params: { wall: 2 } });
    expect(r.out).toContain("box/src/lid.scad\nsize 40 x 30 x 12.5 mm, volume 8.13 cm3, 1234 triangles\n");
    expect(r.out).toContain("shells 1, watertight, surface 4200 mm2");
    expect(r.out).toContain("base 600 mm2 of a 1200 mm2 footprint");
    expect(r.out).toContain("overhang 12.5 mm2 steeper than 45 deg (largest region at 10, 5, 6)");
    expect(r.out).toContain("thinnest wall 1.6 mm at 20, 15, 0.8");
    expect(r.out).toMatch(/pictures:\n {2}sheet {2}\S+\/sheet\.png\n {2}iso {4}\S+\/iso\.png/);
    const json = (await sb.run(["measure", "box/src/lid.scad"])).json<{ pictures: { sheet: string }; analysis: { shells: number } }>();
    expect(existsSync(json.pictures.sheet)).toBe(true);
    expect(json.analysis.shells).toBe(1);
    expect(bodyOf(posts("/measure/src/lid.scad")[1])).toEqual({});
    expect((await sb.run(["measure", "box/src/none.scad"])).code).toBe(3);
  });

  test("slice sends axis and plane and lists the outlines", async () => {
    const r = await sb.run(["slice", "box/src/lid.scad", "--axis", "z", "--at", "-1.5", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(posts("/slice/src/lid.scad")[0])).toEqual({ axis: "z", at: -1.5 });
    expect(r.out).toBe(
      [
        "slice z = -1.5: 2 outlines, coordinates are (x, y)",
        "1. material  area 1200 mm2  centre (20, 15)  size 40 x 30 mm  not round (best-fit circle 38 mm, rms 4)",
        "2. hole  area 9.1 mm2  centre (10, 5)  size 3.4 x 3.4 mm  round, diameter 3.4 mm",
        "",
      ].join("\n"),
    );
    expect((await sb.run(["slice", "box/src/lid.scad", "--axis", "x", "--at", "5", "--text"])).out).toContain("coordinates are (y, z)");
    expect((await sb.run(["slice", "box/src/lid.scad", "--axis", "z"], {})).code).toBe(1);
    expect((await sb.run(["slice", "box/src/lid.scad", "--axis", "w", "--at", "1"])).code).toBe(1);
    expect((await sb.run(["slice", "box/src/lid.scad", "--axis", "z", "--at", "abc"])).code).toBe(1);
    expect((await sb.run(["slice", "box/src/lid.scad", "--axis", "z", "--at", "1"])).json<SliceResult>().contours).toHaveLength(2);
  });

  test("probe sends the point and axis and reads the run", async () => {
    const inside = await sb.run(["probe", "box/src/lid.scad", "--from", "10,-5.5,3", "--axis", "x", "--text"]);
    expect(bodyOf(posts("/probe/src/lid.scad")[0])).toEqual({ from: [10, -5.5, 3], axis: "x" });
    expect(inside.out).toBe("inside material; the run along x is 3.2 mm, from 4 to 7.2\n");
    const air = await sb.run(["probe", "box/src/lid.scad", "--from", "0,0,0", "--axis", "y", "--text"]);
    expect(air.out).toBe("in air; the run along y is unbounded (it reaches outside the part)\n");
    expect((await sb.run(["probe", "box/src/lid.scad", "--from", "1,2", "--axis", "x"])).err).toContain("x,y,z");
    expect((await sb.run(["probe", "box/src/lid.scad", "--from", "1,2,", "--axis", "x"])).code).toBe(1);
    expect((await sb.run(["probe", "box/src/lid.scad", "--axis", "x"])).code).toBe(1);
    expect((await sb.run(["probe", "box/src/lid.scad", "--from", "1,2,3", "--axis", "x"])).json<ProbeResult>().inside).toBe(true);
  });

  test("section downloads the PNG into the cache and prints its path", async () => {
    const r = await sb.run(["section", "box/src/lid.scad", "--axis", "x", "--at", "0", "--size", "400", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(posts("/section/src/lid.scad")[0])).toEqual({ axis: "x", at: 0, size: 400 });
    const [head, path] = r.out.trimEnd().split("\n");
    expect(head).toBe("section x = 0");
    expect(path?.startsWith(cacheRoot())).toBe(true);
    expect(path?.endsWith("/section-x-0.png")).toBe(true);
    expect(existsSync(path ?? "")).toBe(true);
    const json = (await sb.run(["section", "box/src/lid.scad", "--axis", "x", "--at", "0"])).json<{ axis: string; at: number; image: string }>();
    expect(json).toMatchObject({ axis: "x", at: 0, image: path });
    expect(fake.downloads.filter((d) => d.endsWith("section-x-0.png"))).toHaveLength(1);
    expect((await sb.run(["section", "box/src/lid.scad", "--axis", "x"])).code).toBe(1);
  });
});

describe("compare", () => {
  test("sides are a part id or a path, with an optional @revision", async () => {
    fake.seed("box", "src/lid.scad", "cube(1);\n");
    const r = await sb.run(["compare", "box", "lid@r12", "refs/original.stl", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(posts("/compare")[0])).toEqual({ a: { part: "lid", at: "r12" }, b: { path: "refs/original.stl" } });
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toBe("b against a (mm, positive where b has more material): min -0.4, max +1.2, rms 0.31, 95% within 0.8, largest at (12, 4, 6) on b");
    expect(lines[1]).toBe("size delta +2 x 0 x -1 mm, volume delta +1.2 cm3");
    expect(lines[2]).toMatch(/^a {2}size 40 x 30 x 12.5 mm, volume 8.13 cm3/);
    expect(lines[3]).toMatch(/^b {2}size 40 x 30 x 12.5 mm, volume 9.3 cm3/);
    expect(lines[4]).toStartWith(`sheet a  ${cacheRoot()}/`);
    expect(lines[4]).toEndWith("/sheet.png");
    expect(lines[5]).toStartWith(`sheet b  ${cacheRoot()}/`);
    expect(existsSync(lines[4]?.replace("sheet a  ", "") ?? "")).toBe(true);
    expect(fake.downloads.filter((d) => d.endsWith(".png"))).toHaveLength(2);
  });

  test("JSON is the CompareResult with local sheets; arguments are checked", async () => {
    const r = await sb.run(["compare", "box", "lid", "lid@r2"]);
    const out = r.json<CompareResult & { sheets: { a: string; b: string } }>();
    expect(out.deviation.rms).toBe(0.31);
    expect(existsSync(out.sheets.a)).toBe(true);
    expect(bodyOf(posts("/compare")[0])).toEqual({ a: { part: "lid" }, b: { part: "lid", at: "r2" } });
    expect((await sb.run(["compare", "box", "lid"])).code).toBe(1);
    expect((await sb.run(["compare", "box", "lid", "lid@"])).code).toBe(1);
  });
});

// ---- attempts, restore, printed ------------------------------------------------------------------

describe("attempts, restore, printed", () => {
  const attempt = (revisionId: string, parent: string | null, extra: Partial<Attempt> = {}): Attempt => ({
    revisionId,
    parent,
    author: "agent",
    message: `try ${revisionId}`,
    date: "2026-11-20T10:00:00Z",
    current: false,
    status: "draft",
    passed: 4,
    total: 6,
    ...extra,
  });

  test("attempts prints the tree: children indented under their parent, the current one marked", async () => {
    seedPart("lid");
    fake.modeling.attempts.set("box/lid", [
      attempt("r1", null, { status: null, passed: null, total: null }),
      attempt("r2", "r1", { status: "failed", passed: 0, total: 1 }),
      attempt("r3", "r1"),
      attempt("r4", "r3", { status: "passed", passed: 6, total: 6, current: true }),
    ]);
    const r = await sb.run(["attempts", "box/lid", "--text"]);
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split("\n")).toEqual([
      "  r1  not evaluated  agent  2026-11-20T10:00:00Z  try r1",
      "    r2  failed 0/1  agent  2026-11-20T10:00:00Z  try r2",
      "    r3  draft 4/6  agent  2026-11-20T10:00:00Z  try r3",
      "*     r4  passed 6/6  agent  2026-11-20T10:00:00Z  try r4",
    ]);
    expect((await sb.run(["attempts", "box/lid"])).json<{ attempts: Attempt[] }>().attempts).toHaveLength(4);
    expect((await sb.run(["attempts", "box/ghost"])).code).toBe(3);
  });

  test("attempts: no attempts yet; an attempt whose parent is not listed is a root", async () => {
    seedPart("lid");
    expect((await sb.run(["attempts", "box/lid", "--text"])).out).toBe("no attempts\n");
    fake.modeling.attempts.set("box/lid", [attempt("r9", "r0", { current: true })]);
    expect((await sb.run(["attempts", "box/lid", "--text"])).out).toMatch(/^\* r9 /);
  });

  test("restore makes the attempt current and prints the report; unknown attempt exits 3", async () => {
    seedPart("lid");
    fake.modeling.attempts.set("box/lid", [attempt("r1", null)]);
    const r = await sb.run(["restore", "box/lid", "r1", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(posts("/restore")[0])).toEqual({ revisionId: "r1" });
    expect(r.out).toMatch(/^restored box\/parts\/lid\.scad {2}rev [0-9a-f]{16}\ncheck ok\n\npassed 6\/6/);
    expect(fake.text("box", "parts/lid.scad")).toContain("restored r1");
    expect((await sb.run(["restore", "box/lid", "r99"])).code).toBe(3);
    expect((await sb.run(["restore", "box/lid"])).code).toBe(1);
    const quiet = await sb.run(["restore", "box/lid", "r1", "--no-report"]);
    expect(quiet.code).toBe(0);
    expect(posts("/evaluate")).toHaveLength(1);
  });

  test("printed records the outcome and the note", async () => {
    seedPart("lid");
    const r = await sb.run(["printed", "box/lid", "issue", "snap", "arm", "cracked", "at the root", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(posts("/prints")[0])).toEqual({ outcome: "issue", note: "snap arm cracked at the root" });
    expect(r.out).toMatch(/^recorded print issue for box\/lid {2}passed 6\/6 .* printed issue\n$/);
    expect((await sb.run(["printed", "box/lid", "ok", ""])).code).toBe(0);
    expect(bodyOf(posts("/prints")[1])).toEqual({ outcome: "ok", note: "" });
    expect((await sb.run(["printed", "box/lid", "issue"])).code).toBe(1);
    expect((await sb.run(["printed", "box/lid", "fine", "x"])).code).toBe(1);
  });

  test("forbidden is an ordinary error that says a person has to do it in the web app", async () => {
    seedPart("lid");
    fake.failNext = { status: 403, error: "forbidden", message: "only a person can waive a gate" };
    const r = await sb.run(["printed", "box/lid", "ok", "fits"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("forbidden: only a person can waive a gate");
    expect(r.err).toContain("web app");
    expect(r.out).toBe("");
  });
});

// ---- assembly ---------------------------------------------------------------------------------

describe("assembly", () => {
  const spec = {
    title: "Box and lid",
    instances: [
      { id: "tray", part: "tray", translate: [0, 0, 0], rotate: [0, 0, 0] },
      { id: "lid", part: "lid", translate: [0, 0, 12], rotate: [0, 0, 0] },
    ],
    mates: [{ id: "m1", label: "lid on tray", a: "tray", b: "lid", fit: "clearance", min: 0.1, max: 0.3 }],
  };

  test("without an assembly it is exit 3", async () => {
    const r = await sb.run(["assembly", "box"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("has no assembly");
  });

  test("--set writes assembly.json from a local file and prints the report", async () => {
    await Bun.write(join(sb.home, "asm.json"), JSON.stringify(spec));
    const r = await sb.run(["assembly", "box", "--set", join(sb.home, "asm.json"), "--text"]);
    expect(r.code).toBe(0);
    expect(fake.requests.find((q) => q.method === "PUT")?.path).toBe("/api/projects/box/assembly");
    expect(bodyOf(fake.requests.find((q) => q.method === "PUT"))).toEqual(spec);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^passed 2\/2 {2}box assembly {2}Box and lid {2}\(2 instances, 1 mates, printed mass 24.8 g\) {2}revision r\d+$/);
    expect(lines).toContain("pass    Every part exists  [parts]");
    expect(lines).toContain("done: every gate passes or is waived");
    expect(lines).toContain("pairs:");
    expect(lines).toContain("  tray - lid  gap 0.2 mm  overlap 0 cm3");
    expect(lines).toContain("bom:");
    expect(lines).toContain("  2 x tray  Tray  (printed, PETG, 12.4 g each)");
    expect(lines).toContain("pictures:");
    expect(lines.find((l) => l.startsWith("  sheet"))?.endsWith("/sheet.png")).toBe(true);
  });

  test("a failing assembly lists the failing gate first, with its hint and the next steps", async () => {
    fake.seed("box", "assembly.json", JSON.stringify({ ...spec, title: "clash" }));
    const r = await sb.run(["assembly", "box", "--text"]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toMatch(/^draft 1\/2 {2}box assembly/);
    expect(lines[1]).toBe("fail    No clashes  [clash]  measured 2.5 mm3, expected <= 0.5 mm3");
    expect(lines[2]).toBe("        hint: move the lid up by 0.4 mm");
    expect(lines[3]).toBe("pass    Every part exists  [parts]");
    expect(lines).toContain("  1. clash: move the lid up by 0.4 mm");
  });

  test("JSON is the AssemblyReport with local pictures; a bad --set file is exit 1", async () => {
    fake.seed("box", "assembly.json", JSON.stringify(spec));
    const json = (await sb.run(["assembly", "box"])).json<AssemblyReport & { pictures: { sheet: string } }>();
    expect(json).toMatchObject({ status: "passed", passed: 2, total: 2 });
    expect(existsSync(json.pictures.sheet)).toBe(true);
    await Bun.write(join(sb.home, "bad.json"), "[1]");
    expect((await sb.run(["assembly", "box", "--set", join(sb.home, "bad.json")])).code).toBe(1);
    expect((await sb.run(["assembly", "box", "--set", join(sb.home, "nope.json")])).code).toBe(1);
    await Bun.write(join(sb.home, "invalid.json"), JSON.stringify({ title: 1 }));
    const invalid = await sb.run(["assembly", "box", "--set", join(sb.home, "invalid.json")]);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("invalid:");
  });
});

// ---- sessions ---------------------------------------------------------------------------------

describe("sessions", () => {
  test("ask starts a session with the message; sessions lists it", async () => {
    const r = await sb.run(["ask", "box", "make", "a", "lid", "40 mm wide", "--provider", "claude", "--model", "opus", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(lastWrite())).toEqual({ message: "make a lid 40 mm wide", provider: "claude", model: "opus" });
    expect(r.out).toMatch(/^started session s\d+ {2}queued; follow it with `drawer session s\d+`\n$/);
    const created = (await sb.run(["ask", "box", "second"])).json<Session>();
    expect(created).toMatchObject({ project: "box", status: "queued", title: "second" });
    const list = await sb.run(["sessions", "box", "--text"]);
    const lines = list.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^s\d+ {2}queued {2}box {2}second {2}0 tool calls {2}1 message pending$/);
    expect(fake.requests.at(-1)?.query.project).toBe("box");
    fake.addProject("other", "Other");
    expect((await sb.run(["sessions", "other", "--text"])).out).toBe("no sessions\n");
    expect((await sb.run(["sessions"])).json<{ sessions: Session[] }>().sessions).toHaveLength(2);
  });

  test("session prints the items compactly: who, tool summaries, thoughts, questions with their options", async () => {
    const id = (await sb.run(["ask", "box", "make a lid"])).json<Session>().id;
    fake.modeling.addSessionItem(id, { type: "assistant", text: "I will\nmeasure the tray first." });
    fake.modeling.addSessionItem(id, { type: "tool", callId: "c1", name: "measure", summary: "measure refs/tray.stl", status: "ok", result: "ok", images: [] });
    fake.modeling.addSessionItem(id, { type: "tool", callId: "c2", name: "write", summary: "write parts/lid.scad", status: "error", result: "conflict:\nrev is stale", images: [] });
    fake.modeling.addSessionItem(id, { type: "question", questionId: "q1", text: "Which fit?", options: ["sliding", "press"], answer: null });
    fake.modeling.addSessionItem(id, { type: "question", questionId: "q2", text: "Colour?", options: [], answer: "black" });
    fake.modeling.addSessionItem(id, { type: "reasoning", reasoningId: "r1", text: "The tray is\n60 mm wide.", status: "done", seconds: 7 });
    fake.modeling.addSessionItem(id, { type: "notice", level: "error", text: "the runner went away" });
    const r = await sb.run(["session", id, "--text"]);
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split("\n").slice(1)).toEqual([
      "#1 agent: make a lid",
      "#2 agent: I will measure the tray first.",
      "#3 tool ok: measure refs/tray.stl",
      "#4 tool error: write parts/lid.scad  -> conflict: rev is stale",
      "#5 question q1: Which fit?  options: 1) sliding  2) press  (unanswered)",
      "#6 question q2: Colour?  answer: black",
      "#7 thought (7s): The tray is 60 mm wide.",
      "#8 error: the runner went away",
    ]);
    expect(r.out.split("\n")[0]).toMatch(new RegExp(`^${id} {2}queued {2}box `));
    const after = await sb.run(["session", id, "--since", "5", "--json"]);
    expect(fake.requests.at(-1)?.query.since).toBe("5");
    expect(after.json<SessionDetail>().items.map((i) => i.seq)).toEqual([6, 7, 8]);
    expect((await sb.run(["session", "s999"])).code).toBe(3);
    expect((await sb.run(["session"])).code).toBe(1);
  });

  test("say sends a message to the session", async () => {
    const id = (await sb.run(["ask", "box", "start"])).json<Session>().id;
    const r = await sb.run(["say", id, "make", "it", "wider", "--text"]);
    expect(r.code).toBe(0);
    expect(bodyOf(lastWrite())).toEqual({ text: "make it wider" });
    expect(r.out).toBe(`sent to session ${id}  queued\n`);
    expect(fake.modeling.sessions.get(id)?.session.pending).toBe(2);
    expect((await sb.run(["say", id])).code).toBe(1);
    expect((await sb.run(["say", "s999", "hi"])).code).toBe(3);
    expect((await sb.run(["ask", "box"])).code).toBe(1);
  });
});

// ---- new --------------------------------------------------------------------------------------

describe("new: brief and defaults", () => {
  test("--brief, --material and --strictness reach the server", async () => {
    const r = await sb.run(["new", "lamp", "--brief", "A desk lamp base, 80 mm wide", "--material", "PLA", "--strictness", "functional"]);
    expect(r.code).toBe(0);
    expect(bodyOf(lastWrite())).toEqual({ slug: "lamp", brief: "A desk lamp base, 80 mm wide", defaults: { material: "PLA", strictness: "functional" } });
    expect(r.json<Project>().defaults).toEqual({ material: "PLA", strictness: "functional" });
    expect(fake.text("lamp", "brief.md")).toBe("A desk lamp base, 80 mm wide");
    expect((await sb.run(["new", "lamp2", "--material", "ABS", "--text"])).out).toContain("new parts: ABS, standard");
    expect(bodyOf(lastWrite())).toEqual({ slug: "lamp2", defaults: { material: "ABS" } });
  });

  test("a bad --strictness is a usage error and sends nothing", async () => {
    fake.requests.length = 0;
    const r = await sb.run(["new", "lamp", "--strictness", "lax"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--strictness must be one of quick, standard, functional");
    expect(fake.requests).toHaveLength(0);
  });
});
