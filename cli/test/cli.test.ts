import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContextResponse,
  FileInfo,
  HistoryResponse,
  ImportPreview,
  ImportResult,
  Project,
  SearchResponse,
  TreeResponse,
  WriteResult,
} from "@drawer/shared/api";
import { FakeDrawer, revOf } from "./fake-server.ts";
import { sandbox } from "./helpers.ts";

const fake = new FakeDrawer();
const sb = sandbox(fake.url);
afterAll(() => {
  fake.stop();
  sb.dispose();
});

const SCAD = "cube([10, 10, 10]);\n";

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
  fake.seed("box", "AGENTS.md", "# Box\n\n- [decision] use M3 screws #screws\n- main_part [[src/lid.scad]]\n");
  fake.seed("box", "src/lid.scad", SCAD);
  fake.seed("box", "refs/part.stl", new Uint8Array([0, 1, 2, 255]));
  fake.seed("_library", "tolerances.md", "# Tolerances\n- [fit] 0.2 mm clearance\n");
});

const lastWrite = () => [...fake.requests].reverse().find((r) => r.method !== "GET");

describe("server selection", () => {
  test("no server set exits 1 with one instruction line", async () => {
    const bare = sandbox(undefined);
    try {
      const r = await bare.run(["projects"]);
      expect(r.code).toBe(1);
      expect(r.err.trim().split("\n")).toHaveLength(1);
      expect(r.err).toContain("drawer server <url>");
      expect(r.out).toBe("");
    } finally {
      bare.dispose();
    }
  });

  test("`server <url>` verifies health and saves; later runs use it", async () => {
    const bare = sandbox(undefined);
    try {
      const set = await bare.run(["server", fake.url]);
      expect(set.code).toBe(0);
      expect(set.json<{ url: string }>().url).toBe(fake.url);
      expect(existsSync(join(bare.state, "drawer", "server.json"))).toBe(true);
      const list = await bare.run(["projects"]);
      expect(list.code).toBe(0);
      expect(list.json<{ projects: Project[] }>().projects.map((p) => p.slug)).toEqual(["box"]);
    } finally {
      bare.dispose();
    }
  });

  test("`server <url>` does not save an unreachable server", async () => {
    const bare = sandbox(undefined);
    try {
      const r = await bare.run(["server", "http://127.0.0.1:1"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("cannot reach");
      expect(existsSync(join(bare.state, "drawer", "server.json"))).toBe(false);
    } finally {
      bare.dispose();
    }
  });

  test("health", async () => {
    const r = await sb.run(["health"]);
    expect(r.json<{ ok: boolean; version: string }>()).toMatchObject({ ok: true, version: "0.1.0-fake" });
    const text = await sb.run(["health", "--text"]);
    expect(text.out).toContain("openscad 2026.01.01");
  });
});

describe("output modes", () => {
  test("JSON when piped, text with --text, one document", async () => {
    const json = await sb.run(["projects"]);
    expect(json.out.trim().split("\n")).toHaveLength(1);
    expect(json.json<{ projects: Project[] }>().projects[0]).toMatchObject({ slug: "box", title: "A box" });
    const text = await sb.run(["projects", "--text"]);
    expect(text.out).toMatch(/^box {2}A box {2}3 files/);
  });

  test("--json and --text together are a usage error", async () => {
    const r = await sb.run(["projects", "--json", "--text"]);
    expect(r.code).toBe(1);
  });

  test("author header defaults to agent and follows DRAWER_AUTHOR", async () => {
    await sb.run(["note", "box", "one"]);
    expect(lastWrite()?.headers["x-drawer-author"]).toBe("agent");
    await sb.run(["note", "box", "two"], { env: { DRAWER_AUTHOR: "claude-laptop" } });
    expect(lastWrite()?.headers["x-drawer-author"]).toBe("claude-laptop");
  });
});

describe("new and reindex", () => {
  test("new creates with title and description", async () => {
    const r = await sb.run(["new", "lamp", "--title", "Desk lamp", "--description", "A lamp"]);
    expect(r.code).toBe(0);
    expect(r.json<Project>()).toMatchObject({ slug: "lamp", title: "Desk lamp", description: "A lamp" });
    const body = JSON.parse(lastWrite()?.body ?? "{}");
    expect(body).toEqual({ slug: "lamp", title: "Desk lamp", description: "A lamp" });
  });

  test("new passes --from as fromUrl", async () => {
    await sb.run(["new", "holder", "--from", "https://www.printables.com/model/1"]);
    expect(JSON.parse(lastWrite()?.body ?? "{}").fromUrl).toBe("https://www.printables.com/model/1");
  });

  test("new on an existing slug exits 2; a bad slug exits 1", async () => {
    const exists = await sb.run(["new", "box"]);
    expect(exists.code).toBe(2);
    expect(exists.err).toContain("exists");
    expect((await sb.run(["new", "Bad Slug"])).code).toBe(1);
  });

    test("reindex", async () => {
    expect((await sb.run(["reindex"])).json<{ files: number }>().files).toBe(4);
  });
});

describe("ls", () => {
  test("JSON is the TreeResponse", async () => {
    const r = await sb.run(["ls", "box"]);
    const tree = r.json<TreeResponse>();
    expect(tree.entries.map((e) => e.path)).toEqual(["AGENTS.md", "refs", "refs/part.stl", "src", "src/lid.scad"]);
    expect(tree.entries[0]).toMatchObject({ type: "file", kind: "markdown" });
  });

  test("text is an indented tree with kind and size", async () => {
    const r = await sb.run(["ls", "box", "--text"]);
    expect(r.out.split("\n")).toEqual([
      expect.stringMatching(/^AGENTS\.md {2}markdown {2}\d+ B$/),
      "refs/",
      "  part.stl  mesh  4 B",
      "src/",
      "  lid.scad  scad  20 B",
      "",
    ]);
  });

  test("a directory argument limits the tree; a missing one exits 3", async () => {
    const r = await sb.run(["ls", "box", "src", "--text"]);
    expect(r.out).toBe("lid.scad  scad  20 B\n");
    const missing = await sb.run(["ls", "box", "nope"]);
    expect(missing.code).toBe(3);
  });
});

describe("cat, info, get", () => {
  test("cat writes content untouched to stdout and the rev to stderr", async () => {
    const r = await sb.run(["cat", "box/src/lid.scad"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(SCAD);
    expect(r.err).toBe(`rev ${revOf(new TextEncoder().encode(SCAD))}\n`);
  });

  test("cat --at asks for that revision", async () => {
    await sb.run(["cat", "box/src/lid.scad", "--at", "r7"]);
    expect(fake.requests.at(-1)?.query.at).toBe("r7");
  });

  test("cat of a missing file exits 3, nothing on stdout", async () => {
    const r = await sb.run(["cat", "box/src/none.scad"]);
    expect(r.code).toBe(3);
    expect(r.out).toBe("");
    expect(r.err).toContain("not found");
    expect((await sb.run(["cat", "ghost/a.md"])).code).toBe(3);
  });

  test("cat is binary-safe even with --json", async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    fake.seed("box", "refs/all.bin", bytes);
    const r = await sb.run(["cat", "box/refs/all.bin", "--json"]);
    expect(Array.from(r.stdout)).toEqual(Array.from(bytes));
  });

  test("a bare project is a usage error", async () => {
    const r = await sb.run(["cat", "box"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("<project>/<path>");
  });

  test("info returns FileInfo; text lists facts and links", async () => {
    const r = await sb.run(["info", "box/AGENTS.md"]);
    expect(r.json<FileInfo>()).toMatchObject({ project: "box", path: "AGENTS.md", kind: "markdown" });
    const text = await sb.run(["info", "box/AGENTS.md", "--text"]);
    expect(text.out).toContain("fact line 3: [decision] use M3 screws");
    expect(text.out).toContain("(unresolved)");
  });

  test("get downloads bytes to -o, to the basename by default, and to stdout with -o -", async () => {
    const out = join(sb.home, "dl", "part.bin");
    const r = await sb.run(["get", "box/refs/part.stl", "-o", out]);
    expect(r.json<{ out: string; bytes: number }>()).toMatchObject({ out, bytes: 4 });
    expect(Array.from(readFileSync(out))).toEqual([0, 1, 2, 255]);
    expect(fake.requests.at(-1)?.query.download).toBe("1");

    await sb.run(["get", "box/refs/part.stl"]);
    expect(Array.from(readFileSync(join(sb.home, "part.stl")))).toEqual([0, 1, 2, 255]);

    const piped = await sb.run(["get", "box/refs/part.stl", "-o", "-"]);
    expect(Array.from(piped.stdout)).toEqual([0, 1, 2, 255]);
  });
});

describe("write", () => {
  test("creates from stdin with a URI-encoded message and the author header", async () => {
    const r = await sb.run(["write", "box/notes/print.md", "-m", "print notes: 0.2 mm layer, 15% infill"], { stdin: "# Print\n" });
    expect(r.code).toBe(0);
    const result = r.json<WriteResult>();
    expect(result).toMatchObject({ project: "box", path: "notes/print.md", created: true });
    expect(fake.text("box", "notes/print.md")).toBe("# Print\n");
    const put = lastWrite();
    expect(put?.headers["x-drawer-message"]).toBe(encodeURIComponent("print notes: 0.2 mm layer, 15% infill"));
    expect(put?.headers["x-drawer-rev"]).toBeUndefined();
    expect(fake.revisions[0]?.message).toBe("print notes: 0.2 mm layer, 15% infill");
  });

  test("without --rev an existing file is exit 2 and untouched", async () => {
    const r = await sb.run(["write", "box/src/lid.scad"], { stdin: "x" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("already exists");
    expect(r.err).toContain("drawer cat box/src/lid.scad");
    expect(fake.text("box", "src/lid.scad")).toBe(SCAD);
  });

  test("with the current rev it overwrites and returns the new rev", async () => {
    const rev = revOf(new TextEncoder().encode(SCAD));
    const r = await sb.run(["write", "box/src/lid.scad", "--rev", rev], { stdin: "sphere(5);\n" });
    expect(r.code).toBe(0);
    expect(r.json<WriteResult>()).toMatchObject({ created: false, rev: revOf(new TextEncoder().encode("sphere(5);\n")) });
  });

  test("a stale rev is exit 2 with the current rev and a re-read instruction", async () => {
    const r = await sb.run(["write", "box/src/lid.scad", "--rev", "0000000000000000"], { stdin: "x" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("conflict");
    expect(r.err).toContain(revOf(new TextEncoder().encode(SCAD)));
    expect(r.err).toContain("drawer cat box/src/lid.scad");
    expect(r.err).toContain("do not retry blind");
    expect(fake.text("box", "src/lid.scad")).toBe(SCAD);
  });

  test("--from uploads a local file byte for byte", async () => {
    const bytes = new Uint8Array(512).map((_, i) => (i * 7) % 256);
    await Bun.write(join(sb.home, "blob.bin"), bytes);
    const r = await sb.run(["write", "box/refs/blob.bin", "--from", join(sb.home, "blob.bin")]);
    expect(r.code).toBe(0);
    expect(Array.from(fake.file("box", "refs/blob.bin")?.bytes ?? [])).toEqual(Array.from(bytes));
  });

  test("binary stdin round trips through write and get", async () => {
    const bytes = new Uint8Array(1024).map((_, i) => (i * 31 + 5) % 256);
    expect((await sb.run(["write", "box/refs/rt.stl"], { stdin: bytes })).code).toBe(0);
    const out = join(sb.home, "rt.out");
    await sb.run(["get", "box/refs/rt.stl", "-o", out]);
    expect(Array.from(readFileSync(out))).toEqual(Array.from(bytes));
    const cat = await sb.run(["cat", "box/refs/rt.stl"]);
    expect(Array.from(cat.stdout)).toEqual(Array.from(bytes));
  });

  test("--from with a missing local file exits 1", async () => {
    const r = await sb.run(["write", "box/a.md", "--from", join(sb.home, "nope")]);
    expect(r.code).toBe(1);
  });
});

describe("edit", () => {
  const rev = () => fake.file("box", "src/lid.scad")?.rev ?? "";

  test("replaces an exact string and prints the new rev", async () => {
    const r = await sb.run(["edit", "box/src/lid.scad", "--rev", rev(), "--old", "10, 10, 10", "--new", "20, 20, 5", "-m", "widen lid"]);
    expect(r.code).toBe(0);
    expect(fake.text("box", "src/lid.scad")).toBe("cube([20, 20, 5]);\n");
    expect(r.json<WriteResult>().rev).toBe(fake.file("box", "src/lid.scad")?.rev ?? "");
    expect(JSON.parse(lastWrite()?.body ?? "{}")).toEqual({ rev: expect.any(String), old: "10, 10, 10", new: "20, 20, 5" });
    expect(lastWrite()?.headers["x-drawer-message"]).toBe("widen%20lid");
    const text = await sb.run(["edit", "box/src/lid.scad", "--rev", rev(), "--old", "20", "--new", "30", "--all", "--text"]);
    expect(text.out).toMatch(/^edited box\/src\/lid\.scad {2}rev [0-9a-f]{16}\ncheck ok\n$/);
  });

  test("--new may be empty and values may start with a dash", async () => {
    fake.seed("box", "src/neg.scad", "a = -1;\n");
    const r = await sb.run(["edit", "box/src/neg.scad", "--rev", fake.file("box", "src/neg.scad")?.rev ?? "", "--old", "-1", "--new", ""]);
    expect(r.code).toBe(0);
    expect(fake.text("box", "src/neg.scad")).toBe("a = ;\n");
  });

  test("--all sends replaceAll; ambiguity without it is edit_no_match", async () => {
    fake.seed("box", "src/dup.scad", "x = 1;\ny = 1;\n");
    const r = await sb.run(["edit", "box/src/dup.scad", "--rev", fake.file("box", "src/dup.scad")?.rev ?? "", "--old", "1", "--new", "2"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("edit_no_match");
    expect(r.err).toContain("drawer cat box/src/dup.scad");
    const all = await sb.run(["edit", "box/src/dup.scad", "--rev", fake.file("box", "src/dup.scad")?.rev ?? "", "--old", "1", "--new", "2", "--all"]);
    expect(all.code).toBe(0);
    expect(fake.text("box", "src/dup.scad")).toBe("x = 2;\ny = 2;\n");
    expect(JSON.parse(lastWrite()?.body ?? "{}").replaceAll).toBe(true);
  });

  test("a missing old string is edit_no_match with the server message", async () => {
    const r = await sb.run(["edit", "box/src/lid.scad", "--rev", rev(), "--old", "sphere", "--new", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("edit_no_match: old string not found");
    expect(r.out).toBe("");
  });

  test("a stale rev is exit 2 and names the current rev", async () => {
    const r = await sb.run(["edit", "box/src/lid.scad", "--rev", "ffffffffffffffff", "--old", "cube", "--new", "x"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(rev());
    expect(r.err).toContain("drawer cat box/src/lid.scad");
  });

  test("missing --rev, --old or --new is a usage error that sends nothing", async () => {
    fake.requests.length = 0;
    expect((await sb.run(["edit", "box/src/lid.scad", "--old", "a", "--new", "b"])).code).toBe(1);
    expect((await sb.run(["edit", "box/src/lid.scad", "--rev", rev(), "--new", "b"])).code).toBe(1);
    expect((await sb.run(["edit", "box/src/lid.scad", "--rev", rev(), "--old", "a"])).code).toBe(1);
    expect(fake.requests).toHaveLength(0);
  });

  test("editing a missing file exits 3", async () => {
    expect((await sb.run(["edit", "box/src/none.scad", "--rev", "x", "--old", "a", "--new", "b"])).code).toBe(3);
  });
});

describe("rm and mv", () => {
  test("rm needs the rev and removes the file", async () => {
    expect((await sb.run(["rm", "box/src/lid.scad"])).code).toBe(1);
    const stale = await sb.run(["rm", "box/src/lid.scad", "--rev", "0000000000000000"]);
    expect(stale.code).toBe(2);
    const ok = await sb.run(["rm", "box/src/lid.scad", "--rev", fake.file("box", "src/lid.scad")?.rev ?? ""]);
    expect(ok.code).toBe(0);
    expect(ok.json<{ revisionId: string }>().revisionId).toMatch(/^r\d+$/);
    expect(fake.file("box", "src/lid.scad")).toBeUndefined();
  });

  test("rm --recursive deletes a directory without a rev", async () => {
    const r = await sb.run(["rm", "box/refs", "--recursive"]);
    expect(r.code).toBe(0);
    expect(fake.requests.at(-1)?.query.recursive).toBe("1");
    expect(fake.file("box", "refs/part.stl")).toBeUndefined();
  });

  test("mv renames within the project", async () => {
    const r = await sb.run(["mv", "box/src/lid.scad", "src/cover.scad", "-m", "rename lid"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(fake.requests.at(-1)?.body ?? "{}")).toEqual({ from: "src/lid.scad", to: "src/cover.scad", message: "rename lid" });
    expect(fake.text("box", "src/cover.scad")).toBe(SCAD);
    expect((await sb.run(["mv", "box/src/ghost.scad", "src/x.scad"])).code).toBe(3);
  });
});

describe("render", () => {
  test("downloads sheet and views into the cache and prints local paths, sheet first", async () => {
    fake.seed("box", "src/lid.scad", "cube(1);\n");
    const r = await sb.run(["render", "box/src/lid.scad", "--views", "iso,front", "--size", "600", "--text"]);
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    const sheet = lines[0]?.replace(/^sheet +/, "") ?? "";
    expect(sheet.startsWith(join(sb.cache, "drawer", "renders"))).toBe(true);
    expect(sheet.endsWith("/sheet.png")).toBe(true);
    expect(existsSync(sheet)).toBe(true);
    expect(lines[1]).toMatch(/^iso +\//);
    expect(lines[2]).toMatch(/^front +\//);
    expect(r.out).not.toContain("top ");
    expect(r.out).toContain("size 40 x 30 x 12.5 mm, volume 8.13 cm3, 1234 triangles");
    expect(r.out).toContain("warning: WARNING: variable x not specified");
    expect(r.out).toContain('log: ECHO: "wall", 2');
    expect(existsSync(lines[1]?.replace(/^iso +/, "") ?? "")).toBe(true);
    const body = JSON.parse(fake.requests.find((q) => q.method === "POST" && q.path.includes("/render/"))?.body ?? "{}");
    expect(body).toEqual({ views: ["iso", "front"], size: 600 });
  });

  test("JSON carries local paths and RenderResult fields; a second run skips existing files", async () => {
    fake.seed("box", "src/lid.scad", "cube(2);\n");
    const first = await sb.run(["render", "box/src/lid.scad"]);
    const result = first.json<{ key: string; sheet: string; views: Record<string, string>; info: { triangles: number }; log: string[]; warnings: string[]; mesh: string }>();
    expect(Object.keys(result.views)).toEqual(["iso", "front", "top", "side"]);
    expect(result.sheet).toBe(join(sb.cache, "drawer", "renders", result.key, "sheet.png"));
    expect(readFileSync(result.sheet).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result.info.triangles).toBe(1234);
    expect(result.mesh).toMatch(/^\/api\/renders\/[a-f0-9]{24}\/mesh\.stl$/);
    expect(result.mesh).not.toContain(result.key);
    expect(fake.downloads).toHaveLength(5);

    fake.downloads.length = 0;
    const second = await sb.run(["render", "box/src/lid.scad"]);
    expect(second.code).toBe(0);
    expect(fake.downloads).toHaveLength(0);
  });

  test("a failed render exits 1 with OpenSCAD's message", async () => {
    fake.seed("box", "src/bad.scad", "SYNTAX_ERROR");
    const r = await sb.run(["render", "box/src/bad.scad"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("render failed");
    expect(r.err).toContain("Parser error in file x.scad, line 1");
    expect(r.out).toBe("");
  });

  test("bad --views is a usage error; a missing file exits 3", async () => {
    expect((await sb.run(["render", "box/src/lid.scad", "--views", "iso,back"])).code).toBe(1);
    expect((await sb.run(["render", "box/src/none.scad"])).code).toBe(3);
  });
});

describe("search and context", () => {
  test("search prints one line per hit: project/path  snippet", async () => {
    const r = await sb.run(["search", "_library", "clearance", "--text"]);
    const lines = r.out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^_library\/tolerances\.md {2}.*0\.2 mm «clearance»/);
  });

  test("search hits one project, passes filters; JSON is SearchResponse", async () => {
    const r = await sb.run(["search", "box", "screws", "--kind", "markdown", "--limit", "5"]);
    expect(r.json<SearchResponse>().hits[0]).toMatchObject({ path: "AGENTS.md", kind: "markdown" });
    expect(fake.requests.at(-1)?.path).toBe("/api/projects/box/search");
    expect(fake.requests.at(-1)?.query).toEqual({ q: "screws", kind: "markdown", limit: "5" });
  });

  test("multiple words are joined; no hits says so; bad kind is a usage error", async () => {
    await sb.run(["search", "box", "main", "part"]);
    expect(fake.requests.at(-1)?.query.q).toBe("main part");
    expect((await sb.run(["search", "box", "zzzzqq", "--text"])).out).toBe("no hits\n");
    expect((await sb.run(["search", "box", "x", "--kind", "gif"])).code).toBe(1);
    expect((await sb.run(["search"])).code).toBe(1);
    expect((await sb.run(["search", "box"])).code).toBe(1);
  });

  test("context prints header lines and content as text even when piped", async () => {
    const r = await sb.run(["context", "box/AGENTS.md", "--depth", "1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("== box/AGENTS.md  [markdown]  root  depth 0\n# Box");
    expect(r.out).toContain("== _library/tolerances.md  [markdown]  via uses [[Library: tolerances.md]] in box/AGENTS.md  depth 1\n# Tolerances");
    expect(r.out).toContain("[... truncated]");
    expect(r.out).toContain("(stl mesh: size 40 x 30 x 12.5 mm");
    expect(fake.requests.at(-1)?.query.depth).toBe("1");
  });

  test("context --json is the ContextResponse; --max-bytes is forwarded", async () => {
    const r = await sb.run(["context", "box/AGENTS.md", "--json", "--max-bytes", "100"]);
    expect(r.json<ContextResponse>().nodes).toHaveLength(3);
    expect(fake.requests.at(-1)?.query.maxBytes).toBe("100");
  });
});

describe("history", () => {
  test("lists revisions, optionally for one path", async () => {
    const r = await sb.run(["history", "box"]);
    expect(r.json<HistoryResponse>().revisions.length).toBe(3);
    const one = await sb.run(["history", "box", "src/lid.scad", "--text"]);
    expect(one.out.trimEnd().split("\n")).toHaveLength(1);
    expect(one.out).toContain("(src/lid.scad)");
    expect(fake.requests.at(-1)?.query.path).toBe("src/lid.scad");
  });
});

describe("note", () => {
  test("creates notes/log.md with a heading and a fact line", async () => {
    const r = await sb.run(["note", "box", "wall 2 mm prints cleanly #print"]);
    expect(r.code).toBe(0);
    expect(r.json<WriteResult>()).toMatchObject({ path: "notes/log.md", created: true });
    expect(fake.text("box", "notes/log.md")).toBe("# Log\n\n- [note] wall 2 mm prints cleanly #print\n");
    expect(lastWrite()?.headers["x-drawer-message"]).toContain("note%3A");
  });

  test("appends to an existing file with a category, adding the missing newline", async () => {
    fake.seed("box", "notes/fit.md", "# Fit\n- [fit] old");
    const r = await sb.run(["note", "box", "lid", "needs", "0.3 mm", "--file", "notes/fit.md", "--category", "fit"]);
    expect(r.code).toBe(0);
    expect(r.json<WriteResult>().created).toBe(false);
    expect(fake.text("box", "notes/fit.md")).toBe("# Fit\n- [fit] old\n- [fit] lid needs 0.3 mm\n");
    expect(lastWrite()?.headers["x-drawer-rev"]).toBeDefined();
  });

  test("retries once when someone writes between read and write", async () => {
    fake.seed("box", "notes/log.md", "# Log\n");
    fake.beforeNextPut = () => fake.seed("box", "notes/log.md", "# Log\n- [note] concurrent\n");
    const r = await sb.run(["note", "box", "mine"]);
    expect(r.code).toBe(0);
    expect(fake.text("box", "notes/log.md")).toBe("# Log\n- [note] concurrent\n- [note] mine\n");
  });

  test("collapses newlines, rejects checkbox-like categories and empty text", async () => {
    await sb.run(["note", "box", "line one\nline two"]);
    expect(fake.text("box", "notes/log.md")).toContain("- [note] line one line two\n");
    expect((await sb.run(["note", "box", "x", "--category", "x"])).code).toBe(1);
    expect((await sb.run(["note", "box", "x", "--category", "two words"])).code).toBe(1);
    expect((await sb.run(["note", "box", ""])).code).toBe(1);
  });

  test("an unknown project exits 3", async () => {
    expect((await sb.run(["note", "ghost", "hi"])).code).toBe(3);
  });
});

describe("import and preview", () => {
  test("import posts url, name and file ids; JSON is ImportResult", async () => {
    const r = await sb.run(["import", "box", "https://www.printables.com/model/1", "--name", "holder", "--file-id", "f1"]);
    expect(r.code).toBe(0);
    expect(r.json<ImportResult>()).toMatchObject({ project: "box", dir: "refs/holder", written: ["refs/holder/source.md"] });
    expect(JSON.parse(lastWrite()?.body ?? "{}")).toEqual({ url: "https://www.printables.com/model/1", name: "holder", fileIds: ["f1"] });
    const text = await sb.run(["import", "box", "https://x.test/m", "--text"]);
    expect(text.out).toContain("skipped holder.step: not downloadable");
  });

  test("preview shows files and downloadability", async () => {
    const r = await sb.run(["preview", "https://www.printables.com/model/1"]);
    expect(r.json<ImportPreview>().files).toHaveLength(2);
    const text = await sb.run(["preview", "https://www.printables.com/model/1", "--text"]);
    expect(text.out).toContain("f2  holder.step  (not downloadable)");
    expect(text.out).toContain("licence CC-BY-4.0");
  });
});

describe("help and errors", () => {
  test("--help and help list every spec command", async () => {
    const r = await sb.run(["--help"]);
    expect(r.code).toBe(0);
    const names = [
      "server", "projects", "new", "ls", "cat", "info", "write", "edit", "rm", "mv", "get", "render", "search", "context", "history", "note", "import", "reindex", "health",
      "guide", "overview", "parts", "part", "report", "set", "measure", "slice", "probe", "section", "attempts", "restore", "compare", "assembly", "printed", "sessions", "session", "ask", "say", "attachments", "attachment", "file-attachment",
    ];
    for (const name of names) {
      expect(r.out).toContain(`drawer ${name}`);
    }
    expect((await sb.run(["help"])).out).toBe(r.out);
  });

  test("help <cmd> and <cmd> --help describe one command", async () => {
    const r = await sb.run(["help", "edit"]);
    expect(r.out).toContain("drawer edit <project>/<path> --rev r --old s --new s");
    expect((await sb.run(["edit", "--help"])).out).toBe(r.out);
  });

  test("no arguments prints help to stderr and exits 1; unknown commands exit 1", async () => {
    const none = await sb.run([]);
    expect(none.code).toBe(1);
    expect(none.err).toContain("Usage:");
    const unknown = await sb.run(["frobnicate"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown command");
    expect((await sb.run(["help", "frobnicate"])).code).toBe(1);
  });

  test("unreachable server is exit 1 with one line", async () => {
    const r = await sb.run(["projects"], { env: { DRAWER_URL: "http://127.0.0.1:1" } });
    expect(r.code).toBe(1);
    expect(r.err.trim().split("\n")).toHaveLength(1);
  });

  test("unknown options are usage errors", async () => {
    const r = await sb.run(["cat", "box/AGENTS.md", "--bogus"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown option --bogus");
  });
});
