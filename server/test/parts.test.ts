import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  AssemblyReport,
  AttemptsResponse,
  CompareResult,
  DrawerEvent,
  LibraryProfile,
  MeasureResult,
  PartReport,
  PartSummary,
  PartsResponse,
  ProbeResult,
  Project,
  ProjectOverview,
  SectionResult,
  SliceResult,
  WriteResult,
} from "@drawer/shared/api";
import { createApp } from "../src/app.ts";
import { harness, TEST_HOST, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.newProject("p", { brief: "A clip that holds a 10 mm rod.", defaults: { material: "PETG" } });
});
afterAll(async () => {
  await h.close();
});

const MODEL = "// a clip\nw = 10; // [5:20]\nmodule clip() { cube([w, 20, 30]); }\nclip();\n// @size=w,20,30\n";

async function putPart(slug: string, id: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<PartSummary> {
  const res = await h.call<PartSummary>("PUT", `/api/projects/${slug}/parts/${id}`, { body, headers });
  if (res.status !== 200) throw new Error(`put part failed: ${res.status} ${res.text}`);
  return res.json;
}

async function writeModel(slug: string, id: string, text: string): Promise<WriteResult> {
  const res = await h.put<WriteResult>(`/api/projects/${slug}/files/parts/${id}.scad`, text, { "x-drawer-rev": "*" });
  if (res.status !== 200) throw new Error(`write failed: ${res.status} ${res.text}`);
  return res.json;
}

describe("project meta and starter", () => {
  test("a new project has a brief, parts/, and defaults; PATCH changes them", async () => {
    expect((await h.get("/api/projects/p/files/brief.md")).text).toContain("10 mm rod");
    const project = (await h.get<Project>("/api/projects/p")).json;
    expect(project.defaults).toEqual({ material: "PETG", strictness: "standard" });
    const patched = await h.call<Project>("PATCH", "/api/projects/p", { body: { defaults: { strictness: "quick" } } });
    expect(patched.json.defaults).toEqual({ material: "PETG", strictness: "quick" });
    expect((await h.call("PATCH", "/api/projects/p", { body: { defaults: { material: "Wood" } } })).status).toBe(400);
    await h.call("PATCH", "/api/projects/p", { body: { defaults: { strictness: "standard" } } });
  });

  test("the library profile is served", async () => {
    const res = await h.get<LibraryProfile>("/api/library/profile");
    expect(res.json.printer.bed).toEqual([256, 256, 256]);
    expect(res.json.materials.map((m) => [m.name, m.densityGCm3])).toEqual([
      ["PLA", 1.24],
      ["PETG", 1.27],
      ["ABS", 1.04],
      ["TPU", 1.21],
    ]);
  });
});

describe("structured-file validation", () => {
  test("an invalid spec, assembly or printer profile is 400 and nothing is written", async () => {
    const bad = await h.put<{ error: string; message: string }>("/api/projects/p/files/parts/x.part.json", JSON.stringify({ title: "X", source: "printed", material: "PLA", strictness: "extreme" }));
    expect(bad.status).toBe(400);
    expect(bad.json.message).toContain("strictness");
    expect((await h.get("/api/projects/p/files/parts/x.part.json")).status).toBe(404);
    expect((await h.put("/api/projects/p/files/parts/Bad_Id.part.json", "{}")).status).toBe(400);
    expect((await h.put("/api/projects/p/files/assembly.json", "not json")).status).toBe(400);
    const printer = await h.get("/api/projects/_library/files/printer.json");
    const res = await h.put<{ message: string }>("/api/projects/_library/files/printer.json", JSON.stringify({ ...JSON.parse(printer.text), nozzleMm: "big" }), { "x-drawer-rev": "*" });
    expect(res.status).toBe(400);
    expect(res.json.message).toContain("nozzleMm");
  });

  test("an edit that breaks a spec is refused", async () => {
    await putPart("p", "edited", { title: "Edited" });
    const file = await h.get("/api/projects/p/files/parts/edited.part.json");
    const res = await h.post("/api/projects/p/edit/parts/edited.part.json", { rev: file.headers.get("x-drawer-rev"), old: '"standard"', new: '"sloppy"' });
    expect(res.status).toBe(400);
    expect((await h.get("/api/projects/p/files/parts/edited.part.json")).text).toBe(file.text);
    await h.del("/api/projects/p/parts/edited");
  });
});

describe("parts", () => {
  test("PUT creates a part with the project's defaults; unknown fields are 400", async () => {
    const summary = await putPart("p", "clip", { title: "Clip", dimensions: [{ id: "width", label: "Width", kind: "size", axis: "x", nominal: 10, tol: 0.1 }] });
    expect(summary).toMatchObject({ id: "clip", title: "Clip", material: "PETG", strictness: "standard", source: "printed", status: "empty", model: null, spec: "parts/clip.part.json" });
    expect((await h.call("PUT", "/api/projects/p/parts/clip", { body: { title: "Clip", waivers: [] } })).status).toBe(400);
    expect((await h.call("PUT", "/api/projects/p/parts/Bad", { body: { title: "x" } })).status).toBe(400);
    const empty = await h.get<PartReport>("/api/projects/p/parts/clip/report");
    expect(empty.json).toMatchObject({ status: "empty", gates: [], mesh: null });
    expect(empty.json.next[0]).toContain("parts/clip.scad");
  });

  test("writing the model returns check and part, queues an evaluation, and the report passes", async () => {
    const write = await writeModel("p", "clip", MODEL);
    expect(write.part).toBe("clip");
    expect(write.check).toEqual({ ok: true, diagnostics: [] });
    await h.drained();
    const report = await h.get<PartReport>("/api/projects/p/parts/clip/report");
    expect(report.status).toBe(200);
    expect(report.json.status).toBe("passed");
    expect(report.json.gates.map((g) => `${g.id}:${g.status}`)).toEqual(["parses:pass", "solid:pass", "fits_bed:pass", "dim:width:pass", "lint:pass", "base:pass", "overhang:pass", "min_wall:pass"]);
    expect(report.json.massG).toBe(7.62);
    expect(report.json.whatIf).toBe(false);
    expect(report.json.params.map((p) => p.name)).toEqual(["w"]);
    expect((await h.get(report.json.render?.mesh as string)).status).toBe(200);
    expect(report.json.analysis?.thickness).toBe(report.json.render?.mesh.replace(/mesh\.stl$/, "thickness.f32"));
    const field = await h.get(report.json.analysis?.thickness as string);
    expect(field.status).toBe(200);
    expect(field.headers.get("content-type")).toBe("application/octet-stream");

    const list = await h.get<PartsResponse>("/api/projects/p/parts");
    expect(list.json.parts.map((p) => [p.id, p.status, p.passed, p.total, p.evaluating])).toEqual([["clip", "passed", 8, 8, false]]);
    expect((await h.get<Project>("/api/projects/p")).json.status).toMatchObject({ parts: 1, passed: 1, overall: "passed", assembly: "none" });
  });

  test("an unchanged part is not measured twice, and concurrent evaluations join", async () => {
    const before = { ...h.renderer.calls };
    const [a, b] = await Promise.all([h.post<PartReport>("/api/projects/p/parts/clip/evaluate", {}), h.post<PartReport>("/api/projects/p/parts/clip/evaluate", {})]);
    expect(a.json.status).toBe("passed");
    expect(b.json.evaluatedAt).toBe(a.json.evaluatedAt);
    expect(h.renderer.calls.analyse).toBe(before.analyse);

    // A write that touches no part queues nothing.
    await h.write("p", "notes/n.md", "# n");
    await h.drained();
    expect(h.renderer.calls.analyse).toBe(before.analyse);

    // Two different states: the second request queues behind the first and both are measured.
    await writeModel("p", "clip", MODEL.replace("w = 10;", "w = 10.05;"));
    const [c, d] = await Promise.all([h.get<PartReport>("/api/projects/p/parts/clip/report"), h.post<PartReport>("/api/projects/p/parts/clip/evaluate", {})]);
    expect(c.json.mesh?.bbox.size[0]).toBe(10.05);
    expect(d.json.evaluatedAt).toBe(c.json.evaluatedAt);
    expect(h.renderer.calls.analyse).toBe((before.analyse ?? 0) + 1);
  });

  test("a what-if evaluation changes nothing", async () => {
    const what = await h.post<PartReport>("/api/projects/p/parts/clip/evaluate", { params: { w: 14 } });
    expect(what.json.whatIf).toBe(true);
    expect(what.json.status).toBe("draft");
    const dim = what.json.gates.find((g) => g.id === "dim:width");
    expect(dim).toMatchObject({ status: "fail", measured: "14 mm" });
    expect(what.json.next[0]).toContain("Reduce the extent along x by 4 mm");
    expect((await h.get<PartReport>("/api/projects/p/parts/clip/report")).json.status).toBe("passed");
    expect((await h.get<PartsResponse>("/api/projects/p/parts")).json.parts[0]?.status).toBe("passed");
  });

  test("set params writes the model as one revision, guarded by rev", async () => {
    const file = await h.get("/api/projects/p/files/parts/clip.scad");
    const rev = file.headers.get("x-drawer-rev") as string;
    expect((await h.post("/api/projects/p/parts/clip/params", { rev: "0000000000000000", values: { w: 12 } })).status).toBe(409);
    expect((await h.post("/api/projects/p/parts/clip/params", { rev, values: { nope: 1 } })).status).toBe(400);
    const set = await h.post<WriteResult>("/api/projects/p/parts/clip/params", { rev, values: { w: 12 } });
    expect(set.status).toBe(200);
    expect(set.json.part).toBe("clip");
    expect((await h.get("/api/projects/p/files/parts/clip.scad")).text).toContain("w = 12;");
    const report = await h.get<PartReport>("/api/projects/p/parts/clip/report");
    expect(report.json.status).toBe("draft");
    expect(report.json.gates.find((g) => g.id === "dim:width")?.status).toBe("fail");
  });

  test("waivers: forbidden for the agent, a person's waiver counts as passing, an empty reason removes it", async () => {
    const agent = await h.post<{ error: string }>("/api/projects/p/parts/clip/waive", { gate: "dim:width", reason: "fine" });
    expect(agent.status).toBe(403);
    expect(agent.json.error).toBe("forbidden");
    const web = await h.post<PartSummary>("/api/projects/p/parts/clip/waive", { gate: "dim:width", reason: "12 mm is better" }, { "x-drawer-author": "web" });
    expect(web.status).toBe(200);
    const report = await h.get<PartReport>("/api/projects/p/parts/clip/report");
    expect(report.json.gates.find((g) => g.id === "dim:width")).toMatchObject({ status: "waived", detail: "12 mm is better" });
    expect(report.json.status).toBe("passed");

    // A direct write by the agent may not change waivers; one that keeps them is fine.
    const file = await h.get("/api/projects/p/files/parts/clip.part.json");
    const spec = JSON.parse(file.text);
    const stripped = await h.put("/api/projects/p/files/parts/clip.part.json", JSON.stringify({ ...spec, waivers: [] }), { "x-drawer-rev": file.headers.get("x-drawer-rev") as string });
    expect(stripped.status).toBe(403);
    const kept = await h.put<WriteResult>("/api/projects/p/files/parts/clip.part.json", JSON.stringify({ ...spec, description: "holds a rod" }), { "x-drawer-rev": file.headers.get("x-drawer-rev") as string });
    expect(kept.status).toBe(200);
    expect(kept.json).toMatchObject({ part: "clip", check: null });

    await h.post("/api/projects/p/parts/clip/waive", { gate: "dim:width", reason: "" }, { "x-drawer-author": "web" });
    expect((await h.get<PartReport>("/api/projects/p/parts/clip/report")).json.status).toBe("draft");
  });

  test("parses and solid cannot be waived, through the route or in the spec file", async () => {
    for (const gate of ["parses", "solid"]) {
      const res = await h.post<{ error: string; message: string }>("/api/projects/p/parts/clip/waive", { gate, reason: "ship it" }, { "x-drawer-author": "web" });
      expect(res.status).toBe(400);
      expect(res.json.message).toContain("cannot be waived");
    }
    const file = await h.get("/api/projects/p/files/parts/clip.part.json");
    const spec = JSON.parse(file.text);
    const waived = { ...spec, waivers: [{ gate: "solid", reason: "ship it", by: "web", at: "2026-01-01T00:00:00Z" }] };
    const res = await h.put("/api/projects/p/files/parts/clip.part.json", JSON.stringify(waived), { "x-drawer-rev": file.headers.get("x-drawer-rev") as string, "x-drawer-author": "web" });
    expect(res.status).toBe(400);
  });

  test("prints append to the spec", async () => {
    const res = await h.post<PartSummary>("/api/projects/p/parts/clip/prints", { outcome: "issue", note: "too tight" });
    expect(res.json.printed).toBe("issue");
    const spec = JSON.parse((await h.get("/api/projects/p/files/parts/clip.part.json")).text);
    expect(spec.prints).toHaveLength(1);
    expect(spec.prints[0]).toMatchObject({ outcome: "issue", note: "too tight" });
    expect(spec.prints[0].revisionId).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a model that does not build fails with a project-relative diagnostic", async () => {
    await putPart("p", "broken", { title: "Broken", strictness: "quick" });
    const write = await writeModel("p", "broken", "// x\nFAIL\n");
    expect(write.check?.ok).toBe(false);
    expect(write.check?.diagnostics[0]).toMatchObject({ level: "error", file: "parts/broken.scad", line: 1 });
    const report = await h.get<PartReport>("/api/projects/p/parts/broken/report");
    expect(report.json.status).toBe("failed");
    expect(report.json.gates.map((g) => `${g.id}:${g.status}`)).toEqual(["parses:fail", "solid:skipped", "fits_bed:skipped"]);
    expect(report.json.gates[0]?.detail).toContain("parts/broken.scad:1");
    expect((await h.get<Project>("/api/projects/p")).json.status).toMatchObject({ parts: 2, failed: 1, draft: 1, overall: "failed" });
  });

  test("a change to a file the model uses re-evaluates it", async () => {
    await putPart("p", "user", { title: "User", strictness: "quick" });
    await h.write("p", "lib/shape.scad", "module shape() {}\n");
    await writeModel("p", "user", "// u\nuse <lib/shape.scad>\nshape();\n");
    await h.drained();
    expect((await h.get<PartsResponse>("/api/projects/p/parts")).json.parts.find((p) => p.id === "user")?.status).toBe("passed");
    const before = h.renderer.calls.render ?? 0;
    await h.write("p", "lib/shape.scad", "module shape() { cube(1); }\n");
    await h.drained();
    expect(h.renderer.calls.render).toBeGreaterThan(before);
  });

  test("delete removes spec and model in one revision", async () => {
    const res = await h.del<{ revisionId: string }>("/api/projects/p/parts/broken");
    expect(res.status).toBe(200);
    const history = await h.get<{ revisions: { id: string; paths: string[] }[] }>("/api/projects/p/history?limit=1");
    expect(history.json.revisions[0]?.paths.sort()).toEqual(["parts/broken.part.json", "parts/broken.scad"]);
    expect((await h.get("/api/projects/p/parts/broken/report")).status).toBe(404);
  });
});

describe("attempts", () => {
  test("a restore makes an old attempt current and the next write branches from it", async () => {
    await h.newProject("att");
    await putPart("att", "a", { title: "A", strictness: "quick" });
    const v1 = await writeModel("att", "a", "// one\nw = 1;\n");
    await h.drained();
    const v2 = await writeModel("att", "a", "// two\nw = 2;\n");
    const restored = await h.post<WriteResult>("/api/projects/att/parts/a/restore", { revisionId: v1.revisionId });
    expect(restored.status).toBe(200);
    expect((await h.get("/api/projects/att/files/parts/a.scad")).text).toBe("// one\nw = 1;\n");
    const history = await h.get<{ revisions: { message: string }[] }>("/api/projects/att/history?limit=1");
    expect(history.json.revisions[0]?.message).toBe(`restore ${v1.revisionId}`);
    const v3 = await writeModel("att", "a", "// three\nw = 3;\n");
    await h.drained();

    const res = await h.get<AttemptsResponse>("/api/projects/att/parts/a/attempts");
    expect(res.json.attempts.map((a) => [a.revisionId, a.parent, a.current])).toEqual([
      [v1.revisionId, null, false],
      [v2.revisionId, v1.revisionId, false],
      [v3.revisionId, v1.revisionId, true],
    ]);
    expect(res.json.attempts[0]).toMatchObject({ status: "passed", passed: 3, total: 3 });
    expect(res.json.attempts[2]?.status).toBe("passed");
    expect((await h.post("/api/projects/att/parts/a/restore", { revisionId: "0123456789abcdef" })).status).toBe(404);
  });

  test("evaluate at a revision reads that revision", async () => {
    const first = (await h.get<AttemptsResponse>("/api/projects/att/parts/a/attempts")).json.attempts[0];
    const report = await h.post<PartReport>("/api/projects/att/parts/a/evaluate", { at: first?.revisionId });
    expect(report.json.revisionId).toBe(first?.revisionId as string);
    expect(report.json.params[0]?.value).toBe(1);
  });

  test("an attempt's status is from the current spec, or null", async () => {
    // A stricter spec: no attempt has been measured against it yet, except the current one once evaluated.
    await putPart("att", "a", { title: "A", strictness: "quick", dimensions: [{ id: "w", label: "Width", kind: "size", axis: "x", nominal: 99 }] });
    await h.drained();
    const attempts = (await h.get<AttemptsResponse>("/api/projects/att/parts/a/attempts")).json.attempts;
    expect(attempts.map((a) => a.status)).toEqual([null, null, "draft"]);

    // A what-if evaluation of the current model records nothing.
    const whatIf = await h.post<PartReport>("/api/projects/att/parts/a/evaluate", { params: { w: 5 } });
    expect(whatIf.json.whatIf).toBe(true);
    // Evaluating an old attempt at its own revision uses that revision's spec, not the current one.
    const first = attempts[0]?.revisionId as string;
    expect((await h.post<PartReport>("/api/projects/att/parts/a/evaluate", { at: first })).json.status).toBe("passed");
    expect((await h.get<AttemptsResponse>("/api/projects/att/parts/a/attempts")).json.attempts.map((a) => a.status)).toEqual([null, null, "draft"]);
  });
});

describe("measuring", () => {
  beforeAll(async () => {
    await h.newProject("m");
    await h.write("m", "refs/thing.scad", "// thing\n// @size=40,30,10 @hole=5 @probe=air,4\n");
    await h.write("m", "refs/oval.scad", "// @hole=5 @oval\n");
  });

  test("measure, slice, probe and section any file", async () => {
    const m = await h.post<MeasureResult>("/api/projects/m/measure/refs/thing.scad", {});
    expect(m.status).toBe(200);
    expect(m.json.mesh.bbox.size).toEqual([40, 30, 10]);
    expect(m.json.analysis.footprintMm2).toBe(1200);
    expect(m.json.analysis.overhang.angle).toBe(45);
    const previewCalls = h.renderer.calls.render;
    const s = await h.post<SliceResult>("/api/projects/m/slice/refs/thing.scad", { axis: "z", at: 5 });
    expect(s.json.contours[0]?.circle.diameter).toBe(5);
    const p = await h.post<ProbeResult>("/api/projects/m/probe/refs/thing.scad", { from: [1, 2, 3], axis: "x" });
    expect(p.json).toEqual({ inside: false, onSurface: false, distance: 4, low: -1, high: 3 });
    const sec = await h.post<SectionResult>("/api/projects/m/section/refs/thing.scad", { axis: "x", at: 0, size: 300 });
    expect(sec.json.image).toMatch(/^\/api\/renders\/[0-9a-f]+\/section-x-0-300\.png$/);
    expect((await h.get(sec.json.image)).headers.get("content-type")).toBe("image/png");
    expect(h.renderer.calls.render).toBe(previewCalls);
    expect((await h.post("/api/projects/m/slice/refs/thing.scad", { axis: "w", at: 5 })).status).toBe(400);
    expect((await h.post("/api/projects/m/probe/refs/thing.scad", { from: [1, 2], axis: "x" })).status).toBe(400);
    expect((await h.get("/api/renders/abcdefgh12345678/../x.png")).status).toBe(404);
  });

  test("compare two files", async () => {
    await h.write("m", "refs/wider.scad", "// @size=44,30,10 @volume=7\n");
    const res = await h.post<CompareResult>("/api/projects/m/compare", { a: { path: "refs/thing.scad" }, b: { path: "refs/wider.scad" } });
    expect(res.status).toBe(200);
    expect(res.json.sizeDelta).toEqual([4, 0, 0]);
    expect(res.json.volumeDeltaCm3).toBe(1);
    const aKey = res.json.a.render.mesh.split("/").at(-2);
    expect(res.json.deviation.field).toBe(res.json.b.render.mesh.replace(/mesh\.stl$/, `deviation-${aKey}.f32`));
    expect((await h.get(res.json.deviation.field)).status).toBe(200);
    expect((await h.post("/api/projects/m/compare", { a: { path: "refs/thing.scad", part: "x" }, b: { path: "refs/wider.scad" } })).status).toBe(400);
  });

  test("hole and gap dimensions are measured on the mesh", async () => {
    await putPart("m", "holder", {
      title: "Holder",
      strictness: "quick",
      dimensions: [
        { id: "bore", label: "Bore", kind: "hole", axis: "z", at: 5, nominal: 5, tol: 0.1 },
        { id: "slot", label: "Slot", kind: "gap", axis: "x", from: [1, 2, 3], min: 3 },
        { id: "skin", label: "Skin", kind: "wall", axis: "x", from: [1, 2, 3], min: 1 },
      ],
    });
    await writeModel("m", "holder", "// holder\n// @size=40,30,10 @hole=5 @probe=air,4\n");
    const report = await h.get<PartReport>("/api/projects/m/parts/holder/report");
    const gate = (id: string) => report.json.gates.find((g) => g.id === id);
    expect(gate("dim:bore")).toMatchObject({ status: "pass", measured: "5 mm", at: [20, 15, 5] });
    expect(gate("dim:slot")).toMatchObject({ status: "pass", measured: "4 mm" });
    expect(gate("dim:skin")?.status).toBe("fail");
    expect(gate("dim:skin")?.detail).toContain("in air");

    await writeModel("m", "holder", "// holder\n// @hole=5 @oval @probe=air,open\n");
    const oval = await h.get<PartReport>("/api/projects/m/parts/holder/report");
    expect(oval.json.gates.find((g) => g.id === "dim:bore")?.detail).toContain("not round");
    expect(oval.json.gates.find((g) => g.id === "dim:slot")?.detail).toContain("open to the outside");
  });

  test("a hole measures only openings, a boss only outlines of material", async () => {
    await putPart("m", "pin", {
      title: "Pin plate",
      strictness: "quick",
      dimensions: [
        { id: "bore", label: "Bore", kind: "hole", axis: "z", at: 5, nominal: 5, tol: 0.1 },
        { id: "peg", label: "Peg", kind: "boss", axis: "z", at: 5, near: [20, 15], nominal: 8, tol: 0.1 },
      ],
    });
    // A solid peg and no opening: the hole must not measure the peg's outline.
    await writeModel("m", "pin", "// pin\n// @size=40,30,10 @boss=8\n");
    const report = await h.get<PartReport>("/api/projects/m/parts/pin/report");
    const gate = (id: string) => report.json.gates.find((g) => g.id === id);
    expect(gate("dim:peg")).toMatchObject({ status: "pass", measured: "8 mm" });
    expect(gate("dim:bore")).toMatchObject({ status: "fail", detail: "no opening in the cross-section at z = 5" });
    expect(gate("dim:bore")?.hint).toContain("slice");

    await writeModel("m", "pin", "// pin\n// @size=40,30,10 @hole=5\n");
    const holeOnly = await h.get<PartReport>("/api/projects/m/parts/pin/report");
    expect(holeOnly.json.gates.find((g) => g.id === "dim:bore")).toMatchObject({ status: "pass", measured: "5 mm" });
    expect(holeOnly.json.gates.find((g) => g.id === "dim:peg")).toMatchObject({ status: "fail", detail: "no outline of material in the cross-section at z = 5" });
  });

  test("a gap or wall point on a face fails and says so", async () => {
    await putPart("m", "face", { title: "Face", strictness: "quick", dimensions: [{ id: "slot", label: "Slot", kind: "gap", axis: "x", from: [1, 2, 3], min: 3 }] });
    await writeModel("m", "face", "// face\n// @probe=surface,4\n");
    const report = await h.get<PartReport>("/api/projects/m/parts/face/report");
    const slot = report.json.gates.find((g) => g.id === "dim:slot");
    expect(slot).toMatchObject({ status: "fail", detail: "the point [1, 2, 3] lies on a face" });
    expect(slot?.hint).toContain("Move the point");
  });
});

describe("assembly", () => {
  test("PUT validates, writes and evaluates; parts changes re-evaluate it", async () => {
    await h.newProject("asm");
    await putPart("asm", "base", { title: "Base", strictness: "quick" });
    await putPart("asm", "lid", { title: "Lid", strictness: "quick", material: "PLA" });
    await writeModel("asm", "base", "// base\n// @size=10,10,10\n");
    await writeModel("asm", "lid", "// lid\n// @size=10,10,2 @volume=1\n");
    await putPart("_library", "m3", { title: "M3 screw", source: "bought", strictness: "quick" });
    await writeModel("_library", "m3", "// m3\n// @size=3,3,8\n");

    expect((await h.get("/api/projects/asm/assembly")).status).toBe(404);
    expect((await h.call("PUT", "/api/projects/asm/assembly", { body: { title: "A", instances: [{ id: "x", part: "base" }], mates: [{ id: "m", label: "M", a: "x", b: "nope", fit: "contact" }] } })).status).toBe(400);
    const empty = await h.call<{ message: string }>("PUT", "/api/projects/asm/assembly", { body: { title: "A", instances: [], mates: [] } });
    expect(empty.status).toBe(400);
    expect(empty.json.message).toContain("at least one");

    const spec = {
      title: "Box",
      instances: [
        { id: "base", part: "base", translate: [0, 0, 0], rotate: [0, 0, 0] },
        { id: "lid", part: "lid", translate: [0, 0, 10.2], rotate: [0, 0, 0] },
        { id: "lid2", part: "lid", translate: [0, 0, 12.2], rotate: [0, 0, 0] },
        { id: "screw", part: "_library/m3", translate: [10, 0, 0], rotate: [0, 0, 0] },
      ],
      mates: [{ id: "lid-fit", label: "Lid fit", a: "base", b: "lid", fit: "clearance", min: 0.1, max: 0.3 }],
    };
    const res = await h.call<AssemblyReport>("PUT", "/api/projects/asm/assembly", { body: spec });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("passed");
    expect(res.json.gates.map((g) => `${g.id}:${g.status}`)).toEqual(["parts:pass", "clash:pass", "mate:lid-fit:pass", "floating:pass", "bom:pass"]);
    expect(res.json.pairs.find((p) => p.a === "base" && p.b === "lid")?.gapMm).toBe(0.2);
    expect(res.json.instances.find((i) => i.id === "lid")?.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 10.2, 0, 0, 0, 1]);
    expect(res.json.bom).toEqual([
      { part: "base", title: "Base", count: 1, source: "printed", material: "PLA", massG: 7.44 },
      { part: "lid", title: "Lid", count: 2, source: "printed", material: "PLA", massG: 1.24 },
      { part: "_library/m3", title: "M3 screw", count: 1, source: "bought", material: null, massG: null },
    ]);
    expect(res.json.totalPrintedMassG).toBe(9.92);
    expect(res.json.render?.sheet).toMatch(/^\/api\/renders\/[0-9a-f]+\/sheet\.png$/);
    expect((await h.get<Project>("/api/projects/asm")).json.status).toMatchObject({ assembly: "passed", overall: "passed" });

    // The lid grows into the base: the mate and the clash fail after re-evaluation.
    await writeModel("asm", "lid", "// lid\n// @size=10,10,2 @min=0,0,-1 @volume=1\n");
    await h.drained();
    const again = await h.get<AssemblyReport>("/api/projects/asm/assembly");
    expect(again.json.gates.find((g) => g.id === "clash")?.status).toBe("fail");
    expect(again.json.gates.find((g) => g.id === "mate:lid-fit")?.status).toBe("fail");
    expect(again.json.status).toBe("draft");
    expect(h.renderer.calls.renderAssembly).toBeGreaterThanOrEqual(2);

    const overview = await h.get<ProjectOverview>("/api/projects/asm/overview");
    expect(overview.json.assembly).toMatchObject({ status: "draft", instances: 4 });
    expect(overview.json.assembly?.failing).toContain("No collisions");
    expect(overview.json.library.parts.map((p) => p.id)).toEqual(["m3"]);
  });
});

describe("overview and cover", () => {
  test("overview has brief, memory, parts, refs, notes and the library", async () => {
    const res = await h.get<ProjectOverview>("/api/projects/p/overview");
    expect(res.status).toBe(200);
    expect(res.json.brief).toContain("10 mm rod");
    expect(res.json.memory).toContain("Project memory");
    expect(res.json.parts.map((p) => p.id).sort()).toEqual(["clip", "user"]);
    expect(res.json.notes).toEqual(["notes/n.md"]);
    expect(res.json.references).toEqual([]);
    expect(res.json.assembly).toBeNull();
    expect(res.json.library.notes).toEqual(["AGENTS.md", "materials.md", "printer.md", "tolerances.md"]);
    expect(res.json.library.profile.printer.name).toBeString();
  });

  test("the cover prefers a part model", async () => {
    expect((await h.get<Project>("/api/projects/p")).json.cover).toBe("parts/clip.scad");
  });
});

describe("events", () => {
  test("an evaluation announces its start and its result", async () => {
    await h.newProject("ev2");
    await putPart("ev2", "e", { title: "E", strictness: "quick" });
    await h.drained();
    const res = await h.app.fetch(new Request("http://drawer.test/api/events"));
    const body = res.body?.getReader();
    if (!body) throw new Error("no body");
    const events: DrawerEvent[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    await writeModel("ev2", "e", "// e\nw = 1;\n");
    await h.drained();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !events.some((e) => e.type === "part" && !e.evaluating)) {
      const chunk = await Promise.race([body.read(), Bun.sleep(500).then(() => null)]);
      if (chunk === null || chunk.done) continue;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as DrawerEvent);
        end = buffer.indexOf("\n\n");
      }
    }
    await body.cancel();
    const parts = events.filter((e) => e.type === "part");
    expect(parts[0]).toMatchObject({ project: "ev2", part: "e", evaluating: true });
    expect(parts.at(-1)).toEqual({ type: "part", project: "ev2", part: "e", evaluating: false, status: "passed", passed: 3, total: 3 });
  });
});

describe("renderer upgrade", () => {
  test("a stored status is re-evaluated after the OpenSCAD version changes", async () => {
    const h2 = await harness();
    try {
      await h2.newProject("up");
      await h2.call("PUT", "/api/projects/up/parts/u", { body: { title: "U", strictness: "quick" } });
      await h2.put("/api/projects/up/files/parts/u.scad", "// u\nw = 1;\n", { "x-drawer-rev": "*" });
      await h2.drained();
      await h2.app.close();
      const before = h2.renderer.calls.render ?? 0;
      h2.renderer.openscadVersion = "OpenSCAD fake 2026.01";
      const again = createApp({ dataDir: h2.dataDir, renderer: h2.renderer, importers: h2.importers, webDist: null, allowedHosts: [TEST_HOST] });
      await again.ready;
      await again.drained();
      expect(h2.renderer.calls.render ?? 0).toBeGreaterThan(before);
      const res = await again.fetch(new Request("http://drawer.test/api/projects/up/parts"));
      expect(((await res.json()) as PartsResponse).parts[0]?.status).toBe("passed");
      await again.close();
    } finally {
      await rm(h2.dir, { recursive: true, force: true });
    }
  });
});

describe("library upkeep", () => {
  test("a library without printer.json and materials.json gets them back on start, in one commit", async () => {
    const h2 = await harness();
    try {
      // No route deletes them, so they go missing on disk, after a change that makes the starter's copy differ.
      for (const file of ["printer.json", "materials.json"]) {
        const cur = await h2.get(`/api/projects/_library/files/${file}`);
        const value = JSON.parse(cur.text);
        const changed = file === "printer.json" ? { ...value, name: "Gone" } : { materials: value.materials.slice(1) };
        expect((await h2.put(`/api/projects/_library/files/${file}`, JSON.stringify(changed), { "x-drawer-rev": cur.headers.get("x-drawer-rev") as string })).status).toBe(200);
      }
      await h2.app.close();
      for (const file of ["printer.json", "materials.json"]) await rm(join(h2.dataDir, "projects", "_library", file));
      const again = createApp({ dataDir: h2.dataDir, renderer: h2.renderer, importers: h2.importers, webDist: null, allowedHosts: [TEST_HOST] });
      await again.ready;
      const res = await again.fetch(new Request("http://drawer.test/api/projects/_library/history?limit=1"));
      const revisions = ((await res.json()) as { revisions: { author: string; paths: string[] }[] }).revisions;
      expect(revisions[0]?.author).toBe("system");
      expect(revisions[0]?.paths.sort()).toEqual(["materials.json", "printer.json"]);
      await again.close();
    } finally {
      await rm(h2.dir, { recursive: true, force: true });
    }
  });
});
