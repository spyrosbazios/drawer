import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Project, RenderResult, WriteResult } from "@drawer/shared/api";
import { MESH_INFO, harness, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.newProject("r");
});
afterAll(async () => {
  await h.close();
});

describe("render route", () => {
  test("renders a scad file and maps the output to URLs", async () => {
    await h.write("r", "src/a.scad", "cube(1);");
    const res = await h.post<RenderResult>("/api/projects/r/render/src/a.scad", {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ project: "r", path: "src/a.scad", cached: false, info: MESH_INFO, log: ["ECHO: hello"], warnings: [] });
    const { key } = res.json;
    expect(res.json.mesh).toBe(`/api/renders/${key}/mesh.stl`);
    expect(res.json.sheet).toBe(`/api/renders/${key}/sheet.png`);
    expect(Object.keys(res.json.views).sort()).toEqual(["front", "iso", "side", "top"]);
    expect(res.json.views.iso).toBe(`/api/renders/${key}/iso.png`);

    const req = h.renderer.renders.at(-1);
    expect(req?.size).toBe(800);
    expect(req?.views).toEqual(["iso", "front", "top", "side"]);
    expect(req?.file).toBe(join(h.dataDir, "projects", "r", "src", "a.scad"));
    expect(req?.searchPaths).toEqual([join(h.dataDir, "projects", "r"), join(h.dataDir, "projects", "_library")]);

    const png = await h.get(res.json.views.iso as string);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await h.get(res.json.mesh)).headers.get("content-type")).toBe("model/stl");
  });

  test("the second identical render is cached; views and size are honoured", async () => {
    const again = await h.post<RenderResult>("/api/projects/r/render/src/a.scad", {});
    expect(again.json.cached).toBe(true);
    const few = await h.post<RenderResult>("/api/projects/r/render/src/a.scad", { views: ["front", "front", "top"], size: 300 });
    expect(Object.keys(few.json.views).sort()).toEqual(["front", "top"]);
    expect(h.renderer.renders.at(-1)).toMatchObject({ size: 300, views: ["front", "top"] });
  });

  test("renders a mesh file", async () => {
    await h.write("r", "refs/m.stl", "solid m");
    const res = await h.post<RenderResult>("/api/projects/r/render/refs/m.stl");
    expect(res.status).toBe(200);
    expect(res.json.path).toBe("refs/m.stl");
  });

  test("a failing render is 422 render_failed with the renderer's message", async () => {
    await h.write("r", "src/bad.scad", "FAIL");
    const res = await h.post<{ error: string; message: string }>("/api/projects/r/render/src/bad.scad");
    expect(res.status).toBe(422);
    expect(res.json.error).toBe("render_failed");
    expect(res.json.message).toContain("Parser error");
  });

  test("rejects other kinds, bad options and missing files", async () => {
    await h.write("r", "notes/n.md", "# n");
    expect((await h.post("/api/projects/r/render/notes/n.md")).status).toBe(400);
    expect((await h.post("/api/projects/r/render/src/a.scad", { views: ["bottom"] })).status).toBe(400);
    expect((await h.post("/api/projects/r/render/src/a.scad", { size: 10 })).status).toBe(400);
    expect((await h.post("/api/projects/r/render/src/a.scad", { size: 800.5 })).status).toBe(400);
    expect((await h.post("/api/projects/r/render/src/nope.scad")).status).toBe(404);
    expect((await h.post("/api/projects/nope/render/src/a.scad")).status).toBe(404);
    expect((await h.post("/api/projects/r/render/..%2Fx.scad")).status).toBe(400);
  });

  test("`at` renders the revision's content from a temp copy that is removed afterwards", async () => {
    const v1 = await h.put<WriteResult>("/api/projects/r/files/src/hist.scad", "use <dep.scad>; // v1");
    await h.put("/api/projects/r/files/src/dep.scad", "module dep() {}");
    await h.put("/api/projects/r/files/src/hist.scad", "cube(2); // v2", { "x-drawer-rev": v1.json.rev });

    const res = await h.post<RenderResult>("/api/projects/r/render/src/hist.scad", { at: v1.json.revisionId });
    expect(res.status).toBe(200);
    const seen = h.renderer.seen.at(-1);
    expect(seen?.text).toBe("use <dep.scad>; // v1");
    const projectDir = join(h.dataDir, "projects", "r");
    expect(seen?.file.startsWith(projectDir)).toBe(false);
    expect(seen?.file.startsWith(join(h.dataDir, "tmp"))).toBe(true);
    const seenFile = seen?.file ?? "";
    expect(seen?.searchPaths).toEqual([seenFile.slice(0, -"src/hist.scad".length - 1), join(h.dataDir, "projects", "_library")]);
    await expect(stat(seenFile)).rejects.toThrow();

    const now = await h.post<RenderResult>("/api/projects/r/render/src/hist.scad");
    expect(h.renderer.seen.at(-1)?.text).toBe("cube(2); // v2");
    expect(now.json.key).not.toBe(res.json.key);

    expect((await h.post("/api/projects/r/render/src/hist.scad", { at: "0".repeat(40) })).status).toBe(404);
    expect((await h.post("/api/projects/r/render/src/hist.scad", { at: "zzz" })).status).toBe(400);
    const first = (await h.get<{ revisions: { id: string }[] }>("/api/projects/r/history?limit=500")).json.revisions.at(-1)?.id;
    expect((await h.post("/api/projects/r/render/src/hist.scad", { at: first })).status).toBe(404); // the file did not exist yet
  });
});

describe("renders route", () => {
  test("validates key and file name strictly", async () => {
    const res = await h.post<RenderResult>("/api/projects/r/render/src/a.scad", {});
    const { key } = res.json;
    for (const path of [
      `/api/renders/${key}/secret.txt`,
      `/api/renders/${key}/..%2Fmeta.json`,
      `/api/renders/..%2Fprojects/r`,
      `/api/renders/%2e%2e/index.db`,
      `/api/renders/${key}/iso.png/extra`,
      `/api/renders/${key}`,
      `/api/renders/bad!key/iso.png`,
      `/api/renders/${"a".repeat(64)}/iso.png`,
    ]) {
      expect((await h.get(path)).status).toBe(404);
    }
    expect((await h.get(`/api/renders/${key}/meta.json`)).status).toBe(200);
    expect((await h.get(`/api/renders/${key}/sheet.png`)).bytes.length).toBeGreaterThan(0);
  });
});

describe("thumbnail", () => {
  const project = async (slug: string) => (await h.get<Project>(`/api/projects/${slug}`)).json;

  test("a project with nothing to draw has no thumbnail; the cover picks src/*.scad, else a mesh", async () => {
    await h.newProject("cov");
    expect(await project("cov")).toMatchObject({ cover: null, thumbnail: null });
    await h.write("cov", "refs/z.stl", "solid z");
    expect((await project("cov")).cover).toBe("refs/z.stl");
    await h.write("cov", "src/b.scad", "cube(2);");
    await h.write("cov", "src/a.scad", "cube(1);");
    expect((await project("cov")).cover).toBe("src/a.scad");
  });

  test("is served immutable under a key of the picture's inputs, rendered once", async () => {
    const { thumbnail } = await project("cov");
    expect(thumbnail).toMatch(/^\/api\/projects\/cov\/thumbnail\/[0-9a-f]{32}\.png$/);
    const before = h.renderer.calls.thumbnail ?? 0;
    const renders = h.renderer.renders.length;
    const first = await h.get(thumbnail as string);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = first.headers.get("etag");
    expect(etag).toBe(`"${(thumbnail as string).split("/").pop()?.replace(".png", "")}"`);
    expect(h.renderer.renders.at(-1)?.views).toEqual(["iso", "front", "top", "side"]);
    expect(h.renderer.calls.thumbnail).toBe(before + 1);

    expect((await h.get(thumbnail as string)).status).toBe(200);
    expect((await h.get(thumbnail as string, { "if-none-match": etag as string })).status).toBe(304);
    expect(h.renderer.renders.length).toBe(renders + 1);
    expect(h.renderer.calls.thumbnail).toBe(before + 1);
  });

  test("changes only when the picture can: the cover file or a file it uses", async () => {
    const start = (await project("cov")).thumbnail;
    await h.write("cov", "notes/log.md", "- [learned] nothing that draws");
    await h.call("PATCH", "/api/projects/cov", { body: { title: "Covered" } });
    expect((await project("cov")).thumbnail).toBe(start);

    await h.write("cov", "src/inc.scad", "module x() {}");
    await h.write("cov", "src/a.scad", "use <inc.scad>\ncube(1);");
    const used = (await project("cov")).thumbnail;
    expect(used).not.toBe(start);
    await h.write("cov", "src/inc.scad", "module x() { cube(3); }");
    expect((await project("cov")).thumbnail).not.toBe(used);
    expect((await h.get(start as string)).status).toBe(200);
  });

  test("an outdated key that was never drawn is 404, and a bad name is 404", async () => {
    expect((await h.get("/api/projects/cov/thumbnail/0123456789abcdef0123456789abcdef.png")).status).toBe(404);
    expect((await h.get("/api/projects/cov/thumbnail/nope.png")).status).toBe(404);
  });

  test("a cover that does not render is skipped for the next candidate; none left is null", async () => {
    await h.call("PATCH", "/api/projects/cov", { body: { cover: "src/b.scad" } });
    await h.write("cov", "src/b.scad", "FAIL");
    const broken = (await project("cov")).thumbnail as string;
    expect((await h.get(broken)).status).toBe(404);
    const next = (await project("cov")).thumbnail as string;
    expect(next).not.toBe(broken);
    expect((await h.get(next)).status).toBe(200);
    expect(h.renderer.renders.at(-1)?.file.endsWith("src/a.scad")).toBe(true);

    await h.newProject("allbad");
    await h.write("allbad", "src/x.scad", "FAIL");
    expect((await h.get((await project("allbad")).thumbnail as string)).status).toBe(404);
    expect((await project("allbad")).thumbnail).toBeNull();
    const cleared = await h.call<Project>("PATCH", "/api/projects/cov", { body: { cover: null } });
    expect(cleared.json.cover).toBe("src/a.scad");
  });
});
