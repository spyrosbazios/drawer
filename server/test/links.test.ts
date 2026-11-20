import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FileInfo, Link } from "@drawer/shared/api";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.newProject("a");
  await h.newProject("b");
});
afterAll(async () => {
  await h.close();
});

const info = async (project: string, path: string): Promise<FileInfo> => {
  const res = await h.get<FileInfo>(`/api/projects/${project}/info/${path}`);
  expect(res.status).toBe(200);
  return res.json;
};

const link = (links: Link[], target: string): Link => {
  const found = links.find((l) => l.target === target);
  if (!found) throw new Error(`no link with target ${target}: ${JSON.stringify(links)}`);
  return found;
};

describe("markdown link resolution", () => {
  test("exact path, relative path, basename, library and cross-project targets", async () => {
    await h.write("a", "src/body.scad", "module body() {}");
    await h.write("a", "src/bracket.scad", "module bracket() {}");
    await h.write("a", "notes/y.md", "# y");
    await h.write("a", "notes/dup.md", "one");
    await h.write("a", "refs/dup.md", "two");
    await h.write("b", "notes/other.md", "# other");
    await h.write(
      "a",
      "notes/x.md",
      [
        "---",
        "title: X",
        "---",
        "- implements [[src/body.scad]]",
        "- see also [[../src/bracket.scad]]",
        "- [[y]]",
        "- [[bracket.scad]]",
        "Prose: [[Library: printer]], [[_library/tolerances]], [[b/notes/other]], [[nothing-here]].",
      ].join("\n"),
    );
    await h.write("a", "top.md", "[[dup]] and [[notes/dup]]");
    const { outgoing } = await info("a", "notes/x.md");
    expect(link(outgoing, "src/body.scad")).toMatchObject({ relation: "implements", to: "src/body.scad", toProject: "a", from: "notes/x.md", fromProject: "a" });
    expect(link(outgoing, "../src/bracket.scad")).toMatchObject({ relation: "see_also", to: "src/bracket.scad", toProject: "a" });
    expect(link(outgoing, "y")).toMatchObject({ relation: "relates_to", to: "notes/y.md", toProject: "a" });
    expect(link(outgoing, "bracket.scad")).toMatchObject({ to: "src/bracket.scad" });
    expect(link(outgoing, "Library: printer")).toMatchObject({ relation: "links_to", to: "printer.md", toProject: "_library" });
    expect(link(outgoing, "_library/tolerances")).toMatchObject({ to: "tolerances.md", toProject: "_library" });
    expect(link(outgoing, "b/notes/other")).toMatchObject({ to: "notes/other.md", toProject: "b" });
    // from the project root, `dup` has two candidates (notes/dup.md, refs/dup.md): not unique
    const top = (await info("a", "top.md")).outgoing;
    expect(link(top, "dup")).toMatchObject({ to: null, toProject: null });
    expect(link(top, "notes/dup")).toMatchObject({ to: "notes/dup.md", toProject: "a" });
    expect(link(outgoing, "nothing-here")).toMatchObject({ to: null, toProject: null });
  });

  test("incoming links include other projects and the library", async () => {
    await h.write("b", "notes/uses-a.md", "[[a/src/body.scad]]");
    const body = await info("a", "src/body.scad");
    expect(body.incoming.map((l) => `${l.fromProject}:${l.from}`).sort()).toEqual(["a:notes/x.md", "b:notes/uses-a.md"]);
    const printer = await info("_library", "printer.md");
    expect(printer.incoming.map((l) => `${l.fromProject}:${l.from}`)).toContain("a:notes/x.md");
  });

  test("an unresolved link resolves when its target appears, and unresolves when it goes", async () => {
    await h.write("a", "notes/waiting.md", "needs [[later-note]] and [[b/later-b]]");
    let out = (await info("a", "notes/waiting.md")).outgoing;
    expect(link(out, "later-note").to).toBeNull();

    const rev = await h.write("a", "notes/later-note.md", "# arrived");
    await h.write("b", "later-b.md", "# arrived in b");
    out = (await info("a", "notes/waiting.md")).outgoing;
    expect(link(out, "later-note")).toMatchObject({ to: "notes/later-note.md", toProject: "a" });
    expect(link(out, "b/later-b")).toMatchObject({ to: "later-b.md", toProject: "b" });
    expect((await info("a", "notes/later-note.md")).incoming.map((l) => l.from)).toEqual(["notes/waiting.md"]);

    await h.del("/api/projects/a/files/notes/later-note.md", { "x-drawer-rev": rev });
    out = (await info("a", "notes/waiting.md")).outgoing;
    expect(link(out, "later-note").to).toBeNull();
  });

  test("a basename that becomes ambiguous stops resolving; moving a target re-resolves", async () => {
    await h.write("a", "notes/solo.md", "# solo");
    await h.write("a", "pointer.md", "[[solo]]");
    expect(link((await info("a", "pointer.md")).outgoing, "solo").to).toBe("notes/solo.md");
    await h.write("a", "refs/solo.md", "# second");
    expect(link((await info("a", "pointer.md")).outgoing, "solo").to).toBeNull();
    await h.post("/api/projects/a/move", { from: "refs/solo.md", to: "refs/renamed.md" });
    expect(link((await info("a", "pointer.md")).outgoing, "solo").to).toBe("notes/solo.md");
    await h.post("/api/projects/a/move", { from: "notes/solo.md", to: "notes/moved/solo.md" });
    expect(link((await info("a", "pointer.md")).outgoing, "solo").to).toBe("notes/moved/solo.md");
  });

  test("editing a file replaces its links", async () => {
    const rev = await h.write("a", "notes/edit-links.md", "[[y]]");
    await h.post("/api/projects/a/edit/notes/edit-links.md", { rev, old: "[[y]]", new: "[[body.scad]]" });
    const out = (await info("a", "notes/edit-links.md")).outgoing;
    expect(out.map((l) => l.target)).toEqual(["body.scad"]);
    expect(out[0]?.to).toBe("src/body.scad");
    expect((await info("a", "notes/y.md")).incoming.map((l) => l.from)).not.toContain("notes/edit-links.md");
  });
});

describe("scad links and outline", () => {
  test("use/include/import resolve relative to the file, the project root, then the library", async () => {
    await h.write("a", "src/lib/helper.scad", "module helper() {}");
    await h.write("a", "common.scad", "x = 1;");
    await h.write("a", "refs/m.stl", "solid m");
    await h.write("_library", "lib/shared.scad", "module shared() {}");
    await h.write(
      "a",
      "src/main.scad",
      [
        "// use <commented.scad>",
        "use <lib/helper.scad>;",
        "include <../common.scad>",
        "use <common.scad>",
        "use <lib/shared.scad>",
        "use <MCAD/boxes.scad>",
        'import("../refs/m.stl");',
        "module main() { helper(); }",
        "function area(w, h) = w * h;",
      ].join("\n"),
    );
    const main = await info("a", "src/main.scad");
    expect(main.kind).toBe("scad");
    expect(main.outline).toEqual(["main", "area"]);
    const byTarget = (t: string, rel: string) => main.outgoing.find((l) => l.target === t && l.relation === rel);
    expect(byTarget("lib/helper.scad", "uses")).toMatchObject({ to: "src/lib/helper.scad", toProject: "a" });
    expect(byTarget("../common.scad", "includes")).toMatchObject({ to: "common.scad", toProject: "a" });
    expect(byTarget("common.scad", "uses")).toMatchObject({ to: "common.scad", toProject: "a" });
    expect(byTarget("lib/shared.scad", "uses")).toMatchObject({ to: "lib/shared.scad", toProject: "_library" });
    expect(byTarget("MCAD/boxes.scad", "uses")).toMatchObject({ to: null, toProject: null });
    expect(byTarget("../refs/m.stl", "imports")).toMatchObject({ to: "refs/m.stl", toProject: "a" });
    expect(main.outgoing.some((l) => l.target === "commented.scad")).toBe(false);

    expect((await info("a", "src/lib/helper.scad")).incoming.map((l) => l.from)).toEqual(["src/main.scad"]);
  });

  test("a scad dependency written later is picked up", async () => {
    await h.write("a", "src/needs.scad", "use <later.scad>");
    expect((await info("a", "src/needs.scad")).outgoing[0]?.to).toBeNull();
    await h.write("a", "src/later.scad", "module later() {}");
    expect((await info("a", "src/needs.scad")).outgoing[0]).toMatchObject({ to: "src/later.scad", toProject: "a" });
  });
});

describe("facts and mesh info", () => {
  test("FileInfo carries facts with line numbers and mesh info", async () => {
    await h.write("a", "notes/facts.md", "---\ntitle: F\n---\n# F\n- [spec] wall 1.2 mm\n- [ ] not a fact");
    const f = await info("a", "notes/facts.md");
    expect(f.facts).toEqual([{ category: "spec", text: "wall 1.2 mm", path: "notes/facts.md", line: 5 }]);
    expect(f.kind).toBe("markdown");

    await h.write("a", "refs/ok.stl", "solid ok");
    await h.write("a", "refs/bad.stl", "solid bad");
    expect((await info("a", "refs/ok.stl")).mesh).toMatchObject({ format: "stl", triangles: 12 });
    expect((await info("a", "refs/bad.stl")).mesh).toBeNull();
    expect((await info("a", "refs/ok.stl")).facts).toEqual([]);
  });

  test("info of a missing file is not_found", async () => {
    expect((await h.get("/api/projects/a/info/nope.md")).status).toBe(404);
  });
});
