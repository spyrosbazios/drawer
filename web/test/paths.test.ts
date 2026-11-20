import { describe, expect, test } from "bun:test";
import { DraftStore } from "@/core/drafts";
import { formatBytes, formatRelative } from "@/core/format";
import { ancestorsOf, baseName, dirName, encodePath, extOf, isAtOrUnder, isValidRelPath, joinPath, remapMoved } from "@/core/paths";
import { newProjectUploadPath, uploadPathIn } from "@/core/upload";

describe("paths", () => {
  test("base, dir, ext", () => {
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(dirName("a/b/c.md")).toBe("a/b");
    expect(dirName("c.md")).toBe("");
    expect(extOf("a/B.SCAD")).toBe(".scad");
    expect(extOf(".gitkeep")).toBe("");
    expect(extOf("noext")).toBe("");
  });

  test("join ignores empty and dot parts", () => {
    expect(joinPath("", "notes", "a.md")).toBe("notes/a.md");
    expect(joinPath("a/", "./b")).toBe("a/b");
  });

  test("validity follows the server's rules", () => {
    for (const ok of ["a.md", "notes/a b.md", "a/.gitkeep"]) expect(isValidRelPath(ok)).toBe(true);
    for (const bad of ["", "/abs", "a//b", "a/../b", "./a", "a/", ".git/config", "a/.git/x", "project.json", "a\\b"]) expect(isValidRelPath(bad)).toBe(false);
  });

  test("encodePath encodes each segment but keeps the slashes", () => {
    expect(encodePath("notes/a b#1.md")).toBe("notes/a%20b%231.md");
  });

  test("ancestors and moves", () => {
    expect(ancestorsOf("a/b/c.md")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("c.md")).toEqual([]);
    expect(remapMoved("a/b.md", "a", "z")).toBe("z/b.md");
    expect(remapMoved("a/b.md", "a/b.md", "c.md")).toBe("c.md");
    expect(remapMoved("ab/b.md", "a", "z")).toBe("ab/b.md");
    expect(isAtOrUnder("a", "a")).toBe(true);
    expect(isAtOrUnder("a/b/c.md", "a")).toBe(true);
    expect(isAtOrUnder("ab/c.md", "a")).toBe(false);
  });
});

describe("upload targets", () => {
  test("a new project's references all go to refs/", () => {
    expect(newProjectUploadPath("holder.scad")).toBe("refs/holder.scad");
    expect(newProjectUploadPath("HOLDER.SCAD")).toBe("refs/HOLDER.SCAD");
    expect(newProjectUploadPath("photo.png")).toBe("refs/photo.png");
    expect(newProjectUploadPath("model.stl")).toBe("refs/model.stl");
  });

  test("into a folder", () => {
    expect(uploadPathIn("refs/x", "a.stl")).toBe("refs/x/a.stl");
    expect(uploadPathIn("", "a.stl")).toBe("a.stl");
  });
});

describe("formatting", () => {
  test("bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(null)).toBe("unknown size");
  });

  test("relative time", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(formatRelative("2026-11-20T11:59:50Z", now)).toBe("just now");
    expect(formatRelative("2026-11-20T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatRelative("2026-11-19T12:00:00Z", now)).toBe("yesterday");
    expect(formatRelative("garbage", now)).toBe("unknown");
  });
});

describe("draft store", () => {
  const key = DraftStore.key("p", "a.md");
  const base = { text: "one", rev: "r1" };

  test("an edit is a draft; typing back to the base clears it", () => {
    const s = new DraftStore();
    s.edit(key, "two", base);
    expect(s.isDirty(key)).toBe(true);
    expect(s.get(key)).toEqual({ text: "two", baseText: "one", baseRev: "r1" });
    s.edit(key, "one", { text: "one", rev: "r1" });
    expect(s.isDirty(key)).toBe(false);
  });

  test("the draft keeps the rev it started from even when later edits pass a newer base", () => {
    const s = new DraftStore();
    s.edit(key, "two", base);
    s.edit(key, "three", { text: "newer", rev: "r2" });
    expect(s.get(key)?.baseRev).toBe("r1");
  });

  test("rebase keeps the user's text on newer content", () => {
    const s = new DraftStore();
    s.edit(key, "mine", base);
    s.rebase(key, { text: "theirs", rev: "r2" });
    expect(s.get(key)).toEqual({ text: "mine", baseText: "theirs", baseRev: "r2" });
    s.rebase(key, { text: "mine", rev: "r3" });
    expect(s.isDirty(key)).toBe(false);
  });

  test("moves and deletes follow the files", () => {
    const s = new DraftStore();
    s.edit(DraftStore.key("p", "a/x.md"), "x", base);
    s.edit(DraftStore.key("p", "b.md"), "b", base);
    s.edit(DraftStore.key("q", "a/x.md"), "other project", base);
    s.rename("p", (path) => remapMoved(path, "a", "z"));
    expect(s.dirtyPaths("p").sort()).toEqual(["b.md", "z/x.md"]);
    s.clearUnder("p", "z");
    expect(s.dirtyPaths("p")).toEqual(["b.md"]);
    expect(s.dirtyPaths("q")).toEqual(["a/x.md"]);
  });

  test("subscribers hear about changes", () => {
    const s = new DraftStore();
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s.edit(key, "two", base);
    s.clear(key);
    off();
    s.edit(key, "three", base);
    expect(calls).toBe(2);
  });
});
