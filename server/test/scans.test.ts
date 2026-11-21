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
