import { describe, expect, test } from "bun:test";
import type { TreeEntry } from "@drawer/shared/api";
import { allDirs, buildTree, filesUnder, visibleRows } from "@/core/tree";

const file = (path: string, kind: TreeEntry["kind"] = "text"): TreeEntry => ({ path, type: "file", kind, size: 1, rev: "r" });
const dir = (path: string): TreeEntry => ({ path, type: "dir" });

describe("buildTree", () => {
  const entries: TreeEntry[] = [
    file("zeta.md", "markdown"),
    dir("src"),
    file("src/b.scad", "scad"),
    file("src/a.scad", "scad"),
    file("AGENTS.md", "markdown"),
    dir("notes"),
    file("notes/n10.md", "markdown"),
    file("notes/n2.md", "markdown"),
    file("alpha.md", "markdown"),
  ];

  test("folders first, natural order, AGENTS.md pinned at the very top", () => {
    const tree = buildTree(entries);
    expect(tree.map((n) => n.name)).toEqual(["AGENTS.md", "notes", "src", "alpha.md", "zeta.md"]);
    expect(tree.find((n) => n.name === "notes")?.children.map((n) => n.name)).toEqual(["n2.md", "n10.md"]);
    expect(tree.find((n) => n.name === "src")?.children.map((n) => n.name)).toEqual(["a.scad", "b.scad"]);
  });

  test("does not trust the server's order, and makes folders that only exist through a file path", () => {
    const tree = buildTree([file("a/b/c.md", "markdown"), file("a/d.md", "markdown")]);
    expect(tree.map((n) => n.path)).toEqual(["a"]);
    expect(tree[0]?.children.map((n) => n.path)).toEqual(["a/b", "a/d.md"]);
    expect(tree[0]?.children[0]?.children[0]?.path).toBe("a/b/c.md");
  });

  test(".gitkeep keeps its folder but is never shown", () => {
    const tree = buildTree([file("empty/.gitkeep"), file("full/.gitkeep"), file("full/x.md", "markdown")]);
    expect(tree.map((n) => n.name)).toEqual(["empty", "full"]);
    expect(tree[0]?.children).toEqual([]);
    expect(tree[1]?.children.map((n) => n.name)).toEqual(["x.md"]);
  });

  test("AGENTS.md is pinned only at the root", () => {
    const tree = buildTree([file("a.md"), file("sub/AGENTS.md"), file("sub/a.md")]);
    expect(tree.find((n) => n.name === "sub")?.children.map((n) => n.name)).toEqual(["a.md", "AGENTS.md"]);
  });
});

describe("visible rows", () => {
  const tree = buildTree([file("a/x.md"), file("a/b/y.md"), file("c.md")]);

  test("a folder's children appear only while it is expanded", () => {
    expect(visibleRows(tree, new Set()).map((r) => r.node.path)).toEqual(["a", "c.md"]);
    expect(visibleRows(tree, new Set(["a"])).map((r) => [r.node.path, r.depth])).toEqual([
      ["a", 0],
      ["a/b", 1],
      ["a/x.md", 1],
      ["c.md", 0],
    ]);
    expect(visibleRows(tree, new Set(["a", "a/b"])).map((r) => r.node.path)).toContain("a/b/y.md");
  });

  test("allDirs and filesUnder walk depth-first", () => {
    expect(allDirs(tree).map((n) => n.path)).toEqual(["a", "a/b"]);
    const a = tree[0];
    expect(a && filesUnder(a).map((e) => e.path)).toEqual(["a/b/y.md", "a/x.md"]);
  });
});
