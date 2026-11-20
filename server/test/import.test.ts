import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileInfo, HistoryResponse, ImportPreview, ImportResult, Project } from "@drawer/shared/api";
import { FAKE_PREVIEW, harness, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.newProject("imp");
});
afterAll(async () => {
  await h.close();
});

const URL_OK = "https://www.printables.com/model/123-earbuds-holder";

describe("POST /import/preview", () => {
  test("returns what the importer reports", async () => {
    const res = await h.post<ImportPreview>("/api/import/preview", { url: URL_OK });
    expect(res.status).toBe(200);
    expect(res.json.source.title).toBe("Earbuds Holder");
    expect(res.json.files.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    expect(res.json.blocker).toBeNull();
  });

  test("bad input is 400, an importer failure is 502 import_failed", async () => {
    expect((await h.post("/api/import/preview", {})).status).toBe(400);
    expect((await h.post("/api/import/preview", { url: "not a url" })).status).toBe(400);
    expect((await h.post("/api/import/preview", { url: "file:///etc/passwd" })).status).toBe(400);
    const res = await h.post<{ error: string; message: string }>("/api/import/preview", { url: "https://x.example/missing" });
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ error: "import_failed", message: "model not found" });
  });
});

describe("POST /projects/:slug/import", () => {
  test("downloads files and images into refs/<name>/ in one commit by `import`", async () => {
    const res = await h.post<ImportResult>("/api/projects/imp/import", { url: URL_OK });
    expect(res.status).toBe(200);
    expect(res.json.project).toBe("imp");
    expect(res.json.dir).toBe("refs/earbuds-holder");
    const d = "refs/earbuds-holder";
    // images 1..8 are tried, #3 fails; file names from the site are made safe; f3 is not downloadable
    expect(res.json.written).toEqual([
      `${d}/holder.stl`,
      `${d}/name.stl`,
      ...[1, 2, 4, 5, 6, 7, 8].map((n) => `${d}/images/image-${n}.png`),
      `${d}/source.md`,
    ]);
    expect(res.json.skipped.map((s) => s.name).sort()).toEqual(["https://img.example/3.png", "manual.pdf"]);
    expect(res.json.skipped.find((s) => s.name === "manual.pdf")?.reason).toContain("upload it by hand");
    expect(res.json.skipped.find((s) => s.name.endsWith("3.png"))?.reason).toBe("image gone");

    expect(await readFile(join(h.dataDir, "projects", "imp", d, "holder.stl"), "utf8")).toBe("solid holder.stl\n");
    const history = await h.get<HistoryResponse>("/api/projects/imp/history");
    expect(history.json.revisions[0]).toMatchObject({ author: "import", id: res.json.revisionId });
    expect(history.json.revisions[0]?.paths.sort()).toEqual([...res.json.written].sort());
    expect(history.json.revisions[0]?.message).toContain("Earbuds Holder");
    expect(history.json.revisions[1]?.message).toBe("create project");

    const tree = await h.get<{ entries: { path: string; updatedBy?: string }[] }>("/api/projects/imp/tree");
    expect(tree.json.entries.find((e) => e.path === `${d}/holder.stl`)?.updatedBy).toBe("import");
  });

  test("source.md carries title frontmatter, author, license, URL and description", async () => {
    const text = await readFile(join(h.dataDir, "projects", "imp", "refs", "earbuds-holder", "source.md"), "utf8");
    expect(text.startsWith('---\ntitle: "Earbuds Holder"\n---\n')).toBe(true);
    expect(text).toContain("# Earbuds Holder");
    expect(text).toContain("- [author] someone");
    expect(text).toContain("- [license] CC BY 4.0");
    expect(text).toContain(`- [source] ${URL_OK}`);
    expect(text).toContain("A small holder.");
    const info = await h.get<FileInfo>("/api/projects/imp/info/refs/earbuds-holder/source.md");
    expect(info.json.facts.map((f) => f.category)).toEqual(["author", "license", "source", "site"]);
    expect((await h.get<FileInfo>("/api/projects/imp/info/refs/earbuds-holder/holder.stl")).json.mesh?.triangles).toBe(12);
  });

  test("importing into an existing folder is refused; name and fileIds are honoured", async () => {
    const dup = await h.post<{ error: string }>("/api/projects/imp/import", { url: URL_OK });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe("exists");

    const before = h.importers.downloads.length;
    const res = await h.post<ImportResult>("/api/projects/imp/import", { url: URL_OK, name: "My Holder!", fileIds: ["f1", "unknown"] });
    expect(res.status).toBe(200);
    expect(res.json.dir).toBe("refs/my-holder");
    expect(res.json.written.filter((p) => !p.includes("/images/"))).toEqual(["refs/my-holder/holder.stl", "refs/my-holder/source.md"]);
    expect(res.json.skipped.find((s) => s.name === "unknown")?.reason).toBe("not offered by the site");
    expect(h.importers.downloads.length - before).toBe(1);
  });

  test("errors: unknown project, missing url, importer failure leaves nothing behind", async () => {
    expect((await h.post("/api/projects/nope/import", { url: URL_OK })).status).toBe(404);
    expect((await h.post("/api/projects/imp/import", {})).status).toBe(400);
    const fail = await h.post("/api/projects/imp/import", { url: "https://x.example/missing" });
    expect(fail.status).toBe(502);
    const tree = await h.get<{ entries: { path: string }[] }>("/api/projects/imp/tree");
    expect(tree.json.entries.some((e) => e.path.includes("missing"))).toBe(false);
  });

  test("a failed file download is skipped, the rest still lands", async () => {
    const original = h.importers.preview;
    h.importers.preview = async (url) => ({ ...FAKE_PREVIEW, source: { ...FAKE_PREVIEW.source, url, images: [] }, files: [{ id: "boom", name: "a.stl", size: null, downloadable: true }, { id: "ok", name: "b.stl", size: null, downloadable: true }] });
    try {
      const res = await h.post<ImportResult>("/api/projects/imp/import", { url: URL_OK, name: "partial" });
      expect(res.json.written).toEqual(["refs/partial/b.stl", "refs/partial/source.md"]);
      expect(res.json.skipped).toEqual([{ name: "a.stl", reason: "download failed" }]);
    } finally {
      h.importers.preview = original;
    }
  });
});

describe("create with fromUrl", () => {
  test("creates the project, imports, and records the source", async () => {
    const res = await h.post<Project>("/api/projects", { slug: "from-url", fromUrl: URL_OK, fileIds: ["f1"] });
    expect(res.status).toBe(201);
    expect(res.json.source).toMatchObject({ site: "printables", url: URL_OK, title: "Earbuds Holder", license: "CC BY 4.0" });
    expect(typeof res.json.source?.importedAt).toBe("string");
    const tree = await h.get<{ entries: { path: string }[] }>("/api/projects/from-url/tree");
    const files = tree.json.entries.filter((e) => e.path.startsWith("refs/earbuds-holder/")).map((e) => e.path);
    expect(files).toContain("refs/earbuds-holder/holder.stl");
    expect(files).toContain("refs/earbuds-holder/source.md");
    expect(files).not.toContain("refs/earbuds-holder/name.stl");
    expect((await h.get<Project>("/api/projects/from-url")).json.source?.url).toBe(URL_OK);
  });

  test("a failing preview creates no project", async () => {
    const res = await h.post<{ error: string }>("/api/projects", { slug: "nothing", fromUrl: "https://x.example/missing" });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("import_failed");
    expect((await h.get("/api/projects/nothing")).status).toBe(404);
  });
});
