import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ScanResult, HistoryResponse } from "@drawer/shared/api";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.newProject("scans");
});
afterAll(async () => h.close());

const endpoint = "/api/projects/scans/scans?name=clamp&filename=clamp.stl&units=cm";

test("adds scan.stl and its source facts in one revision and refuses a duplicate", async () => {
  const body = new TextEncoder().encode("// @leaky @triangles=10");
  const result = await h.call<ScanResult>("POST", endpoint, { raw: body });
  expect(result.status).toBe(201);
  expect(result.json).toMatchObject({ project: "scans", path: "refs/clamp/scan.stl", source: "refs/clamp/source.md", mesh: { closed: false, triangles: 10 }, noiseMm: 0.02 });
  const history = await h.get<HistoryResponse>("/api/projects/scans/history");
  expect(history.json.revisions[0]).toMatchObject({ id: result.json.revisionId, paths: ["refs/clamp/scan.stl", "refs/clamp/source.md"] });
  const source = await h.get("/api/projects/scans/files/refs/clamp/source.md");
  expect(source.text).toContain("- [units_given] cm");
  expect(source.text).toContain("- [closed] false");
  expect((await h.call("POST", endpoint, { raw: body })).status).toBe(409);
  const probe = await h.post<{ message: string }>("/api/projects/scans/probe/refs/clamp/scan.stl", { from: [0, 0, 0], axis: "z" });
  expect(probe.status).toBe(422);
  expect(probe.json.message).toContain("open mesh");
});

test("requires units for unitless input and rejects point clouds, unsafe names and library scans", async () => {
  const raw = "POINT_CLOUD";
  expect((await h.call("POST", endpoint.replace("&units=cm", ""), { raw })).status).toBe(400);
  expect((await h.call("POST", endpoint.replace("clamp&", "../x&"), { raw })).status).toBe(400);
  expect((await h.call("POST", endpoint.replace("/scans/scans", "/_library/scans"), { raw })).status).toBe(400);
  const empty = await h.call<{ message: string }>("POST", endpoint.replace("clamp&", "cloud&"), { raw });
  expect(empty.status).toBe(422);
  expect(empty.json.message).toContain("point cloud");
  expect((await h.get("/api/projects/scans/files/refs/cloud/scan.stl")).status).toBe(404);
});

test("features and fit build only a mesh and serve the indexed feature field", async () => {
  await h.write("scans", "refs/part.stl", "solid");
  const prefix = "/api/projects/scans";
  const count = h.renderer.calls.render;
  const result = await h.post<import("@drawer/shared/api").FeaturesResult>(`${prefix}/features/refs/part.stl`, {});
  expect(result.status).toBe(200);
  expect(result.json.features[0]?.kind).toBe("plane");
  expect((await h.get(result.json.field)).status).toBe(200);
  expect((await h.get(result.json.mesh)).status).toBe(200);
  const fitted = await h.post<import("@drawer/shared/api").Feature>(`${prefix}/fit/refs/part.stl`, { at: [0, 0, 0], kind: "plane" });
  expect(fitted.json.kind).toBe("plane");
  expect((await h.post(`${prefix}/fit/refs/part.stl`, { at: [0, 0] })).status).toBe(400);
  expect((await h.post(`${prefix}/fit/refs/part.stl`, { at: [0, 0, 0], kind: "sphere" })).status).toBe(422);
  const shadow = await h.post<import("@drawer/shared/api").SliceResult>(`${prefix}/slice/refs/part.stl`, { axis: "z", shadow: true });
  expect(shadow.json).toMatchObject({ axis: "z", at: null, open: [] });
  expect((await h.post(`${prefix}/slice/refs/part.stl`, { axis: "z", shadow: true, at: 1 })).status).toBe(400);
  expect(h.renderer.calls.render).toBe(count);
});

test("a scanned part measures its placed file, follows changes and has no OpenSCAD model", async () => {
  const file = "refs/measurement.stl";
  await h.write("scans", file, "// @size=10,20,30 @leaky");
  const spec = {
    title: "Recorded object",
    source: "scanned",
    scan: { file, rotate: [0, 0, 90], translate: [2, 5, 8] },
    dimensions: [{ id: "width", label: "Width", kind: "size", axis: "x", nominal: 20, tol: 0.01 }],
  };
  const path = "/api/projects/scans/parts/recorded";
  expect((await h.call("PUT", path, { body: spec })).status).toBe(200);
  const report = async () => (await h.get<import("@drawer/shared/api").PartReport>(`${path}/report`)).json;
  const first = await report();
  expect(first.status).toBe("passed");
  expect(first.gates.map((gate) => gate.id)).toEqual(["parses", "dim:width"]);
  expect(first.mesh?.bbox.min).toEqual([-18, 5, 8]);
  const content = await h.get<import("@drawer/shared/api").FileInfo>("/api/projects/scans/info/parts/recorded.part.json");
  expect(content.json.outgoing).toMatchObject([{ relation: "scans", to: file }]);
  const aligned = await h.post<import("@drawer/shared/api").AlignResult>("/api/projects/scans/align/refs/measurement.stl", { to: { part: "recorded" } });
  expect(aligned.json.translate).toEqual([-18, 5, 8]);
  expect((await h.get(`${path}/attempts`)).json).toEqual({ attempts: [] });
  expect((await h.put("/api/projects/scans/files/parts/recorded.scad", "cube(10);")).status).toBe(400);
  expect((await h.call("PUT", "/api/projects/_library/parts/recorded", { body: spec })).status).toBe(400);
  await h.write("scans", file, "// @size=10,25,30 @leaky", { "x-drawer-rev": "*" });
  await h.drained();
  expect((await report()).status).toBe("draft");
  const raw = await h.get(`/api/projects/scans/files/${file}`);
  expect((await h.del(`/api/projects/scans/files/${file}`, { "x-drawer-rev": raw.headers.get("x-drawer-rev")! })).status).toBe(200);
  await h.drained();
  expect((await report()).status).toBe("failed");
  await h.write("scans", file, "// @size=10,20,30 @leaky");
  await h.drained();
  expect((await report()).status).toBe("passed");
});

test("a match follows its target's model, including both directions", async () => {
  const project = "/api/projects/scans";
  const spec = { title: "Copy", strictness: "quick", matches: [{ id: "surface", label: "Copy surface", to: "original", tol: 0.2 }] };
  await h.write("scans", "refs/original.stl", "// @size=10,20,30 @leaky");
  expect((await h.call("PUT", `${project}/parts/original`, { body: { title: "Original", source: "scanned", scan: { file: "refs/original.stl", rotate: [0, 0, 0], translate: [0, 0, 0] } } })).status).toBe(200);
  expect((await h.call("PUT", `${project}/parts/copy`, { body: spec })).status).toBe(200);
  await h.write("scans", "parts/copy.scad", "// @size=10,20,30");
  const report = async () => (await h.get<import("@drawer/shared/api").PartReport>(`${project}/parts/copy/report`)).json;
  expect((await report()).gates.find((g) => g.id === "match:surface")?.status).toBe("pass");
  const before = h.renderer.calls.deviation ?? 0;
  await h.write("scans", "refs/original.stl", "// @size=12,20,30 @leaky", { "x-drawer-rev": "*" });
  await h.drained();
  expect(h.renderer.calls.deviation).toBeGreaterThan(before);
  const changed = await report();
  expect(changed.status).toBe("draft");
  expect(changed.gates.find((g) => g.id === "match:surface")).toMatchObject({ status: "fail", at: [0, 0, 0] });
  const compared = await h.post<import("@drawer/shared/api").CompareResult>(`${project}/compare`, { a: { part: "original" }, b: { part: "copy" }, tol: 0.3 });
  expect(compared.json.deviation).toMatchObject({ tol: 0.3, within: 0.5, reverse: { within: 0.5 } });
});
