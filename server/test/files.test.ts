import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileInfo, HistoryResponse, TreeResponse, WriteResult } from "@drawer/shared/api";
import { normalizePath } from "../src/store/paths.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.newProject("p");
});
afterAll(async () => {
  await h.close();
});

const url = (path: string) => `/api/projects/p/files/${path}`;

describe("write", () => {
  test("creates, and returns the rev of the bytes", async () => {
    const res = await h.put<WriteResult>(url("notes/a.md"), "hello", { "x-drawer-author": "agent", "x-drawer-message": encodeURIComponent("first note: hi") });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ project: "p", path: "notes/a.md", created: true });
    expect(res.json.rev).toBe(new Bun.CryptoHasher("sha256").update("hello").digest("hex").slice(0, 16));
    expect(res.json.revisionId).toMatch(/^[0-9a-f]{40}$/);
    const read = await h.get(url("notes/a.md"));
    expect(read.text).toBe("hello");
    expect(read.headers.get("x-drawer-rev")).toBe(res.json.rev);
  });

  test("creates parent directories and normalises the path", async () => {
    const res = await h.put<WriteResult>(url("deep//er/./x.txt"), "x");
    expect(res.json.path).toBe("deep/er/x.txt");
    expect((await stat(join(h.dataDir, "projects", "p", "deep", "er", "x.txt"))).isFile()).toBe(true);
  });

  test("sending a rev for a path that does not exist is not_found", async () => {
    const res = await h.put(url("ghost.md"), "x", { "x-drawer-rev": "0123456789abcdef" });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: "not_found" });
  });

  test("overwriting needs the current rev, else 409 with the current rev", async () => {
    const rev = (await h.get(url("notes/a.md"))).headers.get("x-drawer-rev") as string;
    const missing = await h.put<{ error: string; rev: string }>(url("notes/a.md"), "v2");
    expect(missing.status).toBe(409);
    expect(missing.json).toMatchObject({ error: "conflict", rev });
    const stale = await h.put<{ error: string; rev: string }>(url("notes/a.md"), "v2", { "x-drawer-rev": "ffffffffffffffff" });
    expect(stale.status).toBe(409);
    expect(stale.json.rev).toBe(rev);
    expect((await h.get(url("notes/a.md"))).text).toBe("hello");

    const ok = await h.put<WriteResult>(url("notes/a.md"), "v2", { "x-drawer-rev": rev });
    expect(ok.status).toBe(200);
    expect(ok.json.created).toBe(false);
    const star = await h.put<WriteResult>(url("notes/a.md"), "v3", { "x-drawer-rev": "*" });
    expect(star.status).toBe(200);
    expect((await h.get(url("notes/a.md"))).text).toBe("v3");
  });

  test("writing identical bytes commits nothing", async () => {
    const before = (await h.get<HistoryResponse>("/api/projects/p/history")).json.revisions.length;
    const rev = (await h.get(url("notes/a.md"))).headers.get("x-drawer-rev") as string;
    const res = await h.put<WriteResult>(url("notes/a.md"), "v3", { "x-drawer-rev": rev });
    expect(res.status).toBe(200);
    expect((await h.get<HistoryResponse>("/api/projects/p/history")).json.revisions.length).toBe(before);
  });

  test("a directory or a file in the way is invalid", async () => {
    expect((await h.put(url("notes"), "x", { "x-drawer-rev": "*" })).status).toBe(400);
    expect((await h.put(url("notes/a.md/inner.txt"), "x")).status).toBe(400);
  });

  test("binary bytes survive", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 0, 10]);
    await h.put(url("refs/blob.bin"), bytes);
    const read = await h.get(url("refs/blob.bin"));
    expect([...read.bytes]).toEqual([...bytes]);
    expect(read.headers.get("content-type")).toBe("application/octet-stream");
    const info = await h.get<FileInfo>("/api/projects/p/info/refs/blob.bin");
    expect(info.json.kind).toBe("binary");
  });

  test("?download=1 sets a content-disposition", async () => {
    const res = await h.get(`${url("notes/a.md")}?download=1`);
    expect(res.headers.get("content-disposition")).toContain('filename="a.md"');
  });
});

describe("edit", () => {
  test("replaces one exact occurrence", async () => {
    const rev = await h.write("p", "notes/e.md", "alpha beta gamma");
    const res = await h.post<WriteResult>("/api/projects/p/edit/notes/e.md", { rev, old: "beta", new: "BETA $& $1" });
    expect(res.status).toBe(200);
    expect((await h.get(url("notes/e.md"))).text).toBe("alpha BETA $& $1 gamma");
    expect(res.json.rev).not.toBe(rev);
  });

  test("edit_no_match: not found, ambiguous without replaceAll", async () => {
    let rev = await h.write("p", "notes/e2.md", "x y x");
    const none = await h.post<{ error: string }>("/api/projects/p/edit/notes/e2.md", { rev, old: "zzz", new: "q" });
    expect(none.status).toBe(422);
    expect(none.json.error).toBe("edit_no_match");
    const many = await h.post<{ error: string; message: string }>("/api/projects/p/edit/notes/e2.md", { rev, old: "x", new: "q" });
    expect(many.status).toBe(422);
    expect(many.json.error).toBe("edit_no_match");
    expect(many.json.message).toContain("2 times");
    expect((await h.get(url("notes/e2.md"))).text).toBe("x y x");
    const all = await h.post<WriteResult>("/api/projects/p/edit/notes/e2.md", { rev, old: "x", new: "q", replaceAll: true });
    expect(all.status).toBe(200);
    expect((await h.get(url("notes/e2.md"))).text).toBe("q y q");
    rev = all.json.rev;
    expect(rev).toBeTruthy();
  });

  test("edit is guarded by rev and limited to text files", async () => {
    await h.write("p", "notes/e3.md", "one");
    const stale = await h.post<{ error: string; rev: string }>("/api/projects/p/edit/notes/e3.md", { rev: "ffffffffffffffff", old: "one", new: "two" });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("conflict");
    expect(stale.json.rev).toHaveLength(16);
    const rev = await h.write("p", "refs/m.stl", "solid x");
    expect((await h.post("/api/projects/p/edit/refs/m.stl", { rev, old: "x", new: "y" })).status).toBe(400);
    const bin = await h.write("p", "refs/b.dat", "\u0000\u0001");
    expect((await h.post("/api/projects/p/edit/refs/b.dat", { rev: bin, old: "\u0001", new: "y" })).status).toBe(400);
    expect((await h.post("/api/projects/p/edit/notes/none.md", { rev, old: "a", new: "b" })).status).toBe(404);
    expect((await h.post("/api/projects/p/edit/notes/e3.md", { rev: "*", old: "", new: "b" })).status).toBe(400);
    expect((await h.post("/api/projects/p/edit/notes/e3.md", { rev: "*", old: "one" })).status).toBe(400);
  });
});

describe("path safety", () => {
  test("normalizePath", () => {
    expect(normalizePath("a//b/./c/")).toBe("a/b/c");
    expect(normalizePath("", { allowEmpty: true })).toBe("");
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "a/.git/config", ".GIT/x", "project.json", "a\\b", "a\u0000b", "", ".", ".."]) {
      expect(() => normalizePath(bad)).toThrow();
    }
    expect(normalizePath("notes/project.json")).toBe("notes/project.json");
  });

  test("traversal attempts over HTTP never leave the project", async () => {
    for (const path of ["..%2Fother", "a%2F..%2F..%2Fx", "%2Fetc%2Fpasswd", ".git%2Fconfig", "x/.git/hooks/pre-commit", "..%5Cx"]) {
      for (const method of ["GET", "PUT"] as const) {
        const res = await h.call(method, url(path), method === "PUT" ? { raw: "x", headers: { "x-drawer-rev": "*" } } : {});
        expect(res.status).toBe(400);
      }
    }
    expect((await h.put(url("project.json"), "{}", { "x-drawer-rev": "*" })).status).toBe(400);
    expect((await h.post("/api/projects/p/move", { from: "notes/a.md", to: "../escape.md" })).status).toBe(400);
    expect((await h.post("/api/projects/p/move", { from: "../x", to: "ok.md" })).status).toBe(400);
    expect((await h.post("/api/projects/p/move", { from: "notes/a.md", to: ".git/x" })).status).toBe(400);
    await expect(stat(join(h.dir, "escape.md"))).rejects.toThrow();
    await expect(stat(join(h.dataDir, "other"))).rejects.toThrow();
  });

  test("a project-less slug cannot address anything", async () => {
    expect((await h.get("/api/projects/..%2Fx/tree")).status).toBe(404);
    expect((await h.get("/api/projects/Nope/files/a.md")).status).toBe(404);
  });
});

describe("move and delete", () => {
  test("moves a file and a directory", async () => {
    await h.write("p", "src/part.scad", "cube(1);");
    const mv = await h.post<{ revisionId: string }>("/api/projects/p/move", { from: "src/part.scad", to: "src/new/part.scad", message: "reorganise" });
    expect(mv.status).toBe(200);
    expect(mv.json.revisionId).toMatch(/^[0-9a-f]{40}$/);
    expect((await h.get(url("src/part.scad"))).status).toBe(404);
    expect((await h.get(url("src/new/part.scad"))).text).toBe("cube(1);");

    const dir = await h.post("/api/projects/p/move", { from: "src/new", to: "src/renamed" });
    expect(dir.status).toBe(200);
    expect((await h.get(url("src/renamed/part.scad"))).text).toBe("cube(1);");
    const tree = await h.get<TreeResponse>("/api/projects/p/tree");
    expect(tree.json.entries.some((e) => e.path.startsWith("src/new"))).toBe(false);
  });

  test("move refuses a missing source, an existing target and moving into itself", async () => {
    expect((await h.post("/api/projects/p/move", { from: "nope.md", to: "x.md" })).status).toBe(404);
    const existing = await h.post<{ error: string }>("/api/projects/p/move", { from: "notes/e.md", to: "notes/e2.md" });
    expect(existing.status).toBe(409);
    expect(existing.json.error).toBe("exists");
    expect((await h.post("/api/projects/p/move", { from: "src", to: "src/inside" })).status).toBe(400);
  });

  test("delete needs the rev; directories need recursive", async () => {
    const rev = await h.write("p", "notes/del.md", "bye");
    const none = await h.del<{ error: string; rev: string }>(url("notes/del.md"));
    expect(none.status).toBe(409);
    expect(none.json.rev).toBe(rev);
    expect((await h.del(url("notes/del.md"), { "x-drawer-rev": "ffffffffffffffff" })).status).toBe(409);
    const ok = await h.del<{ revisionId: string }>(url("notes/del.md"), { "x-drawer-rev": rev });
    expect(ok.status).toBe(200);
    expect(ok.json.revisionId).toMatch(/^[0-9a-f]{40}$/);
    expect((await h.get(url("notes/del.md"))).status).toBe(404);
    expect((await h.del(url("notes/del.md"), { "x-drawer-rev": rev })).status).toBe(404);

    await h.write("p", "scratch/one.txt", "1");
    await h.write("p", "scratch/sub/two.txt", "2");
    expect((await h.del(url("scratch"))).status).toBe(400);
    expect((await h.del(`${url("scratch")}?recursive=1`)).status).toBe(200);
    const tree = await h.get<TreeResponse>("/api/projects/p/tree");
    expect(tree.json.entries.some((e) => e.path.startsWith("scratch"))).toBe(false);
    await expect(stat(join(h.dataDir, "projects", "p", "scratch"))).rejects.toThrow();
  });

  test("deleting the last file removes its emptied folders", async () => {
    const rev = await h.write("p", "tmp/only/file.txt", "x");
    await h.del(url("tmp/only/file.txt"), { "x-drawer-rev": rev });
    await expect(stat(join(h.dataDir, "projects", "p", "tmp"))).rejects.toThrow();
  });
});

describe("history", () => {
  test("lists revisions newest first with author, message and paths", async () => {
    await h.newProject("hist");
    await h.put("/api/projects/hist/files/notes/a.md", "1", { "x-drawer-author": "web", "x-drawer-message": encodeURIComponent("add a") });
    const rev = (await h.get("/api/projects/hist/files/notes/a.md")).headers.get("x-drawer-rev") as string;
    await h.put("/api/projects/hist/files/notes/a.md", "2", { "x-drawer-rev": rev, "x-drawer-author": "agent", "x-drawer-message": encodeURIComponent("change a") });
    await h.write("hist", "notes/b.md", "b");

    const all = await h.get<HistoryResponse>("/api/projects/hist/history");
    expect(all.json.revisions.map((r) => r.message)).toEqual(["create notes/b.md", "change a", "add a", "create project"]);
    expect(all.json.revisions[1]).toMatchObject({ author: "agent", paths: ["notes/a.md"] });
    expect(all.json.revisions[2]).toMatchObject({ author: "web" });
    expect(Number.isNaN(Date.parse(all.json.revisions[0]?.date ?? ""))).toBe(false);

    const one = await h.get<HistoryResponse>("/api/projects/hist/history?path=notes/a.md");
    expect(one.json.revisions.map((r) => r.message)).toEqual(["change a", "add a"]);
    const limited = await h.get<HistoryResponse>("/api/projects/hist/history?limit=1");
    expect(limited.json.revisions).toHaveLength(1);
    expect((await h.get("/api/projects/hist/history?limit=0")).status).toBe(400);
    expect((await h.get("/api/projects/hist/history?path=../x")).status).toBe(400);
  });

  test("?at= reads a past revision, including deleted files", async () => {
    await h.newProject("past");
    const first = await h.put<WriteResult>("/api/projects/past/files/notes/a.md", "one");
    const second = await h.put<WriteResult>("/api/projects/past/files/notes/a.md", "two", { "x-drawer-rev": first.json.rev });
    const old = await h.get(`/api/projects/past/files/notes/a.md?at=${first.json.revisionId}`);
    expect(old.status).toBe(200);
    expect(old.text).toBe("one");
    expect(old.headers.get("x-drawer-rev")).toBe(first.json.rev);
    expect((await h.get(`/api/projects/past/files/notes/a.md?at=${second.json.revisionId}`)).text).toBe("two");

    await h.del("/api/projects/past/files/notes/a.md", { "x-drawer-rev": second.json.rev });
    expect((await h.get("/api/projects/past/files/notes/a.md")).status).toBe(404);
    expect((await h.get(`/api/projects/past/files/notes/a.md?at=${second.json.revisionId}`)).text).toBe("two");

    expect((await h.get(`/api/projects/past/files/notes/a.md?at=${"0".repeat(40)}`)).status).toBe(404);
    expect((await h.get("/api/projects/past/files/notes/a.md?at=not-a-rev")).status).toBe(400);
    expect((await h.get(`/api/projects/past/files/notes/never.md?at=${first.json.revisionId}`)).status).toBe(404);
  });

  test("git never touches a repository outside DRAWER_DATA", async () => {
    // The data dir sits inside a temp dir with no repo; the drawer source repo is not reachable from it.
    const config = await readFile(join(h.dataDir, "projects", "p", ".git", "config"), "utf8");
    expect(config).not.toContain("remote");
    const head = await Bun.file(join(h.dataDir, "projects", "p", ".git", "HEAD")).text();
    expect(head.trim()).toBe("ref: refs/heads/main");
  });
});
