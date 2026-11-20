import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ContextResponse, FileInfo, Project, SearchResponse, TreeResponse } from "@drawer/shared/api";
import { createApp } from "../src/app.ts";
import { harness, TEST_HOST, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.newProject("one");
  await h.newProject("two");
  await h.write("one", "notes/holder.md", "---\ntitle: Earbuds holder\n---\n# Earbuds holder\nThe snap hinge needs 0.3 mm clearance. [[../src/holder.scad]]\n- [spec] hinge pin 3 mm");
  await h.write("one", "src/holder.scad", "// parametric holder\nmodule holder() { cube(10); }\nuse <lib/x.scad>");
  await h.write("one", "refs/model.stl", "solid x");
  await h.write("one", "refs/notes.txt", "plain text about hinges");
  await h.write("two", "notes/other.md", "# Other\nsomething unrelated, mentions hinge too");
  await h.write("two", "refs/blob.bin", "\u0000\u0001\u0002 hinge");
});
afterAll(async () => {
  await h.close();
});

const search = async (query: string, project = "one"): Promise<SearchResponse["hits"]> => {
  const res = await h.get<SearchResponse>(`/api/projects/${project}/search?${query}`);
  expect(res.status).toBe(200);
  return res.json.hits;
};

describe("search", () => {
  test("finds words in one project's content, with a « » snippet and a title", async () => {
    const hits = await search("q=hinge");
    expect(hits.map((x) => x.path).sort()).toEqual(["notes/holder.md", "refs/notes.txt"]);
    expect((await search("q=hinge", "two")).map((x) => x.path)).toEqual(["notes/other.md"]);
    const note = hits.find((x) => x.path === "notes/holder.md");
    expect(note?.title).toBe("Earbuds holder");
    expect(note?.kind).toBe("markdown");
    expect(note?.snippet).toContain("«hinge»");
    expect(note?.score).toBeGreaterThan(0);
  });

  test("a trailing * is implied: the last word matches as a prefix", async () => {
    expect((await search("q=earb")).map((x) => x.path)).toContain("notes/holder.md");
    expect((await search("q=hinge+clear")).map((x) => x.path)).toEqual(["notes/holder.md"]);
    expect(await search("q=clear+hinge")).toEqual([]);
  });

  test("matches paths and scad content; mesh files by name and mesh info", async () => {
    expect((await search("q=holder&kind=scad")).map((x) => x.path)).toEqual(["src/holder.scad"]);
    expect((await search("q=model&kind=mesh")).map((x) => x.path)).toEqual(["refs/model.stl"]);
    expect((await search("q=triangles&kind=mesh")).map((x) => x.path)).toEqual(["refs/model.stl"]);
  });

  test("kind filters; the library is searchable; an unknown project is 404", async () => {
    expect((await search("q=hinge&kind=text")).map((x) => x.path)).toEqual(["refs/notes.txt"]);
    expect((await h.get("/api/projects/one/search?q=x&kind=bogus")).status).toBe(400);
    expect((await search("q=printer", "_library")).map((x) => x.path)).toContain("printer.md");
    expect((await h.get("/api/projects/nope/search?q=x")).status).toBe(404);
  });

  test("limit caps the hits; syntax characters are plain words; empty q is invalid", async () => {
    expect(await search("q=hinge&limit=1")).toHaveLength(1);
    for (const q of ['"', "AND", "(", "a OR", "NEAR(x", "x*", "-", "col:on"]) {
      const res = await h.get(`/api/projects/one/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
    }
    expect((await h.get("/api/projects/one/search?q=")).status).toBe(400);
    expect((await h.get("/api/projects/one/search")).status).toBe(400);
    expect(await search("q=!!!")).toEqual([]);
  });

  test("results follow edits and deletions", async () => {
    const rev = await h.write("two", "notes/temp.md", "zebracrossing");
    expect((await search("q=zebracrossing", "two")).map((x) => x.path)).toEqual(["notes/temp.md"]);
    await h.post("/api/projects/two/edit/notes/temp.md", { rev, old: "zebracrossing", new: "giraffe" });
    expect(await search("q=zebracrossing", "two")).toEqual([]);
    expect((await search("q=giraffe", "two")).map((x) => x.path)).toEqual(["notes/temp.md"]);
    const rev2 = (await h.get("/api/projects/two/files/notes/temp.md")).headers.get("x-drawer-rev") as string;
    await h.del("/api/projects/two/files/notes/temp.md", { "x-drawer-rev": rev2 });
    expect(await search("q=giraffe", "two")).toEqual([]);
  });
});

describe("context", () => {
  test("walks links in both directions, breadth first, with via and truncation", async () => {
    await h.newProject("ctx");
    await h.write("ctx", "a.md", "# A\nlinks to [[b]]");
    await h.write("ctx", "b.md", "# B\n- depends_on [[c]]");
    await h.write("ctx", "c.md", "# C\n" + "long ".repeat(500));
    await h.write("ctx", "d.md", "# D\nmentions [[a]]");
    await h.write("ctx", "far.md", "# Far\n[[c]] and [[ctx/e]]");
    await h.write("ctx", "e.md", "# E");
    await h.write("ctx", "m.stl", "solid m");

    const d1 = await h.get<ContextResponse>("/api/projects/ctx/context/a.md?depth=1");
    expect(d1.json.root).toBe("a.md");
    expect(d1.json.nodes.map((n) => `${n.depth}:${n.path}`)).toEqual(["0:a.md", "1:b.md", "1:d.md"]);
    expect(d1.json.nodes[0]?.via).toBeNull();
    expect(d1.json.nodes[1]?.via).toMatchObject({ from: "a.md", to: "b.md", relation: "links_to" });
    expect(d1.json.nodes[2]?.via).toMatchObject({ from: "d.md", to: "a.md" });
    expect(d1.json.nodes[0]?.content).toContain("links to [[b]]");

    const d2 = await h.get<ContextResponse>("/api/projects/ctx/context/a.md?depth=2&maxBytes=60");
    expect(d2.json.nodes.map((n) => `${n.depth}:${n.path}`)).toEqual(["0:a.md", "1:b.md", "1:d.md", "2:c.md"]);
    const c = d2.json.nodes.find((n) => n.path === "c.md");
    expect(c?.via).toMatchObject({ relation: "depends_on", from: "b.md" });
    expect(c?.truncated).toBe(true);
    expect(c?.content?.length).toBeLessThanOrEqual(60);

    const d3 = await h.get<ContextResponse>("/api/projects/ctx/context/a.md?depth=3");
    expect(d3.json.nodes.map((n) => n.path)).toContain("far.md");
    expect((await h.get<ContextResponse>("/api/projects/ctx/context/a.md?depth=0")).json.nodes).toHaveLength(1);
  });

  test("binary nodes carry no content, meshes carry mesh info; unknown files are 404", async () => {
    await h.write("ctx", "mesh-note.md", "[[m.stl]]");
    const res = await h.get<ContextResponse>("/api/projects/ctx/context/mesh-note.md");
    const mesh = res.json.nodes.find((n) => n.path === "m.stl");
    expect(mesh).toMatchObject({ kind: "mesh", content: null, truncated: false });
    expect(mesh?.mesh?.triangles).toBe(12);
    expect((await h.get("/api/projects/ctx/context/nope.md")).status).toBe(404);
    expect((await h.get("/api/projects/ctx/context/a.md?depth=x")).status).toBe(400);
  });

  test("never returns more than 30 nodes", async () => {
    await h.newProject("hub");
    const links = Array.from({ length: 45 }, (_, i) => `[[leaf${i}]]`).join("\n");
    await h.write("hub", "hub.md", links);
    for (let i = 0; i < 45; i++) await h.write("hub", `leaf${i}.md`, `# leaf ${i}`);
    const res = await h.get<ContextResponse>("/api/projects/hub/context/hub.md?depth=2");
    expect(res.json.nodes).toHaveLength(30);
  });
});

type GetJson = (path: string) => Promise<any>;

async function snapshot(getJson: GetJson): Promise<unknown> {
  const projects = ((await getJson("/api/projects")).projects as Project[]).map((p) => p.slug);
  const out: Record<string, unknown> = {};
  for (const slug of [...projects.sort(), "_library"]) {
    const tree = ((await getJson(`/api/projects/${slug}/tree`)) as TreeResponse).entries;
    const infos: FileInfo[] = [];
    for (const e of tree) if (e.type === "file") infos.push(await getJson(`/api/projects/${slug}/info/${e.path}`));
    out[slug] = { tree, infos };
  }
  out.search = [];
  for (const slug of [...projects, "_library"]) {
    for (const q of ["hinge", "holder", "earb", "triangles", "leaf1", "printer"]) (out.search as unknown[]).push(await getJson(`/api/projects/${slug}/search?q=${q}&limit=100`));
  }
  out.projects = await getJson("/api/projects");
  return out;
}

describe("reindex", () => {
  test("rebuilding from the files gives the same index as the incremental one", async () => {
    // a mix of operations: overwrite, move, delete, cross-project and unresolved links
    await h.write("one", "notes/late.md", "[[two/notes/other]] [[not-yet]]");
    await h.post("/api/projects/one/move", { from: "refs/notes.txt", to: "refs/moved/notes.txt" });
    const rev = await h.write("two", "notes/gone.md", "[[late]]");
    await h.del("/api/projects/two/files/notes/gone.md", { "x-drawer-rev": rev });
    await h.write("one", "notes/not-yet.md", "now exists");

    const before = await snapshot((path) => h.get(path).then((r) => r.json));
    const res = await h.post<{ files: number }>("/api/reindex");
    expect(res.status).toBe(200);
    expect(res.json.files).toBeGreaterThan(40);
    const after = await snapshot((path) => h.get(path).then((r) => r.json));
    expect(after).toEqual(before);
  });

  test("a deleted index.db is rebuilt on start", async () => {
    const before = await snapshot((path) => h.get(path).then((r) => r.json));
    await h.app.close();
    for (const suffix of ["", "-wal", "-shm"]) await rm(join(h.dataDir, `index.db${suffix}`), { force: true });
    h.app = createApp({ dataDir: h.dataDir, renderer: h.renderer, importers: h.importers, webDist: h.webDist, allowedHosts: [TEST_HOST] });
    await h.app.ready;
    expect(await snapshot((path) => h.get(path).then((r) => r.json))).toEqual(before);
  });
});
