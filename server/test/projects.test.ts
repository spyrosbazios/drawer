import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Health, Project, TreeResponse } from "@drawer/shared/api";
import { createApp } from "../src/app.ts";
import { harness, TEST_HOST, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

describe("health", () => {
  test("reports the renderer version", async () => {
    const res = await h.get<Health>("/api/health");
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.openscad).toBe("OpenSCAD fake 2025.01");
  });
});

describe("project CRUD", () => {
  test("creates a project with the starter layout", async () => {
    const res = await h.post<Project>("/api/projects", { slug: "earbuds", title: "Earbuds holder", description: "d" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ slug: "earbuds", title: "Earbuds holder", description: "d", cover: null, source: null, updatedBy: "agent" });
    expect(res.json.fileCount).toBe(2);
    expect(res.json.defaults).toEqual({ material: "PLA", strictness: "standard" });
    expect(res.json.status).toEqual({ parts: 0, passed: 0, draft: 0, failed: 0, pending: 0, assembly: "none", overall: "empty" });

    const tree = await h.get<TreeResponse>("/api/projects/earbuds/tree");
    const paths = tree.json.entries.map((e) => `${e.type}:${e.path}`);
    expect(paths).toEqual(["dir:notes", "dir:parts", "dir:refs", "file:AGENTS.md", "file:brief.md"]);
    const agents = tree.json.entries.find((e) => e.path === "AGENTS.md");
    expect(agents).toMatchObject({ kind: "markdown", updatedBy: "agent" });
    expect(agents?.rev).toHaveLength(16);
  });

  test("keeps project.json and .git out of the tree and the file routes", async () => {
    const onDisk = await readdir(join(h.dataDir, "projects", "earbuds"));
    expect(onDisk).toContain("project.json");
    expect(onDisk).toContain(".git");
    const tree = await h.get<TreeResponse>("/api/projects/earbuds/tree");
    expect(tree.json.entries.some((e) => e.path === "project.json" || e.path.includes(".git"))).toBe(false);
    expect((await h.get("/api/projects/earbuds/files/project.json")).status).toBe(400);
    expect((await h.get("/api/projects/earbuds/files/.git/config")).status).toBe(400);
  });

  test("rejects bad and duplicate slugs", async () => {
    for (const slug of ["Bad Slug", "-x", "_library", "", "a/b", "../x"]) {
      const res = await h.post("/api/projects", { slug });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ error: "invalid" });
    }
    const dup = await h.post("/api/projects", { slug: "earbuds" });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ error: "exists" });
  });

  test("gets, lists newest change first, and patches", async () => {
    await h.newProject("zeta");
    await h.write("earbuds", "notes/touch.md", "# touch");
    const list = await h.get<{ projects: Project[] }>("/api/projects");
    expect(list.json.projects.map((p) => p.slug)).toEqual(["earbuds", "zeta"]);
    expect(list.json.projects.some((p) => p.slug === "_library")).toBe(false);

    const patched = await h.call<Project>("PATCH", "/api/projects/zeta", { body: { title: "Zeta", description: "x" }, headers: { "x-drawer-author": "web" } });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ title: "Zeta", description: "x", updatedBy: "web" });
    expect((await h.get<Project>("/api/projects/zeta")).json.title).toBe("Zeta");
    expect((await h.get("/api/projects/nope")).status).toBe(404);
    expect((await h.call("PATCH", "/api/projects/zeta", { body: { cover: "src/missing.scad" } })).status).toBe(400);
  });

  test("a project.json key the server no longer knows is ignored and dropped on the next write", async () => {
    await h.newProject("stale");
    const metaPath = join(h.dataDir, "projects", "stale", "project.json");
    await writeFile(metaPath, JSON.stringify({ ...JSON.parse(await readFile(metaPath, "utf8")), tags: ["old"] }));
    expect((await h.get<Project>("/api/projects/stale")).json).not.toHaveProperty("tags");
    await h.call("PATCH", "/api/projects/stale", { body: { description: "y" } });
    expect(JSON.parse(await readFile(metaPath, "utf8"))).not.toHaveProperty("tags");
  });

  test("delete moves the folder to trash", async () => {
    await h.newProject("gone");
    const res = await h.del("/api/projects/gone");
    expect(res.status).toBe(204);
    expect((await h.get("/api/projects/gone")).status).toBe(404);
    const trash = await readdir(join(h.dataDir, "trash"));
    expect(trash.some((n) => n.startsWith("gone-"))).toBe(true);
    await expect(stat(join(h.dataDir, "projects", "gone"))).rejects.toThrow();
    // the slug is free again
    await h.newProject("gone");
  });
});

describe("library", () => {
  test("exists with starter notes, is addressable, hidden from the list, undeletable", async () => {
    const tree = await h.get<TreeResponse>("/api/projects/_library/tree");
    expect(tree.status).toBe(200);
    expect(tree.json.entries.filter((e) => e.type === "file").map((e) => e.path)).toEqual(["AGENTS.md", "materials.json", "materials.md", "printer.json", "printer.md", "tolerances.md"]);
    expect(tree.json.entries.some((e) => e.type === "dir" && e.path === "parts")).toBe(true);
    const info = await h.get<{ facts: { category: string }[] }>("/api/projects/_library/info/printer.md");
    expect(info.json.facts.map((f) => f.category)).toContain("printer");
    expect((await h.get<Project>("/api/projects/_library")).json.title).toBe("Library");
    const del = await h.del("/api/projects/_library");
    expect(del.status).toBe(400);
  });

  test("takes writes only in its fixed layout, whatever the route", async () => {
    for (const ok of ["shared-fits.md", "notes/petg/drying.md", "lib/threads.scad", "lib/hw/m3.scad", "refs/m3/datasheet.pdf", "refs/m3/m3.stl"]) {
      expect({ ok, status: (await h.put(`/api/projects/_library/files/${ok}`, "x", { "x-drawer-rev": "*" })).status }).toEqual({ ok, status: 200 });
    }
    for (const bad of ["shared.scad", "lib/readme.md", "parts/notes.md", "parts/sub/m3.scad", "misc/x.md", "photo.png", "notes/x.txt", ".hidden.md"]) {
      const res = await h.put<{ message: string }>(`/api/projects/_library/files/${bad}`, "x", { "x-drawer-rev": "*" });
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
      expect(res.json.message).toContain("has no place in the library. It holds: AGENTS.md, printer.json, materials.json");
    }
    expect((await h.post("/api/projects/_library/edit/shared-fits.md", { rev: (await h.get("/api/projects/_library/files/shared-fits.md")).headers.get("x-drawer-rev"), old: "x", new: "y" })).status).toBe(200);
    expect((await h.post("/api/projects/_library/move", { from: "lib/hw", to: "hw" })).status).toBe(400);
    expect((await h.post("/api/projects/_library/move", { from: "shared-fits.md", to: "notes/fits.md" })).status).toBe(200);
    // Another project takes any path.
    await h.newProject("free");
    expect((await h.put("/api/projects/free/files/misc/x.scad", "x")).status).toBe(200);
  });

  test("printer.json and materials.json cannot be deleted or moved", async () => {
    for (const file of ["printer.json", "materials.json"]) {
      const rev = (await h.get(`/api/projects/_library/files/${file}`)).headers.get("x-drawer-rev") as string;
      const del = await h.del<{ message: string }>(`/api/projects/_library/files/${file}`, { "x-drawer-rev": rev });
      expect(del.status).toBe(400);
      expect(del.json.message).toBe(`${file} cannot be deleted or moved: change its values instead`);
      expect((await h.post("/api/projects/_library/move", { from: file, to: `refs/${file}` })).status).toBe(400);
    }
  });

  test("a library part is bought hardware", async () => {
    const printed = await h.call<{ message: string }>("PUT", "/api/projects/_library/parts/bracket", { body: { title: "Bracket" } });
    expect(printed.status).toBe(400);
    expect(printed.json.message).toContain('source "bought"');
    expect((await h.call("PUT", "/api/projects/_library/parts/m4", { body: { title: "M4 screw", source: "bought" } })).status).toBe(200);
    expect((await h.put("/api/projects/_library/files/parts/m4.scad", "cube(1);")).status).toBe(200);
  });

  test("the profile says whether the printer is still the starter's example", async () => {
    expect((await h.get<{ printerIsExample: boolean }>("/api/library/profile")).json.printerIsExample).toBe(true);
    const cur = await h.get("/api/projects/_library/files/printer.json");
    await h.put("/api/projects/_library/files/printer.json", JSON.stringify({ ...JSON.parse(cur.text), name: "Mine" }), { "x-drawer-rev": cur.headers.get("x-drawer-rev") as string });
    expect((await h.get<{ printerIsExample: boolean }>("/api/library/profile")).json.printerIsExample).toBe(false);
  });

  test("an existing library is not overwritten on restart, and the index survives it", async () => {
    const h2 = await harness();
    try {
      await h2.newProject("keep");
      const rev = await h2.write("_library", "printer.md", "# my printer\n- [printer] custom");
      await h2.app.close();
      const again = createApp({ dataDir: h2.dataDir, renderer: h2.renderer, importers: h2.importers, webDist: null, allowedHosts: [TEST_HOST] });
      await again.ready;
      const res = await again.fetch(new Request("http://drawer.test/api/projects/_library/files/printer.md"));
      expect(res.headers.get("x-drawer-rev")).toBe(rev);
      const info = await again.fetch(new Request("http://drawer.test/api/projects/keep/info/AGENTS.md"));
      expect(info.status).toBe(200);
      const hits = await again.fetch(new Request("http://drawer.test/api/projects/_library/search?q=custom"));
      expect(((await hits.json()) as { hits: unknown[] }).hits).toHaveLength(1);
      await again.close();
    } finally {
      await rm(h2.dir, { recursive: true, force: true });
    }
  });
});
