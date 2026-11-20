import { describe, expect, test } from "bun:test";
import { parseSearch, selectionOf, stringifySearch, validateHomeSearch, validateProjectSearch, withSelection } from "@/lib/route-search";

describe("plain search params", () => {
  test("parse and stringify are plain query strings", () => {
    expect(parseSearch("?a=1&b=two%20words")).toEqual({ a: "1", b: "two words" });
    expect(stringifySearch({ a: "1", b: "two words" })).toBe("?a=1&b=two+words");
    expect(stringifySearch({})).toBe("");
  });

  test("drops empty values and renders booleans", () => {
    expect(stringifySearch({ a: undefined, b: "", c: false, d: null, f: true })).toBe("?f=1");
  });

});

describe("home search", () => {
  test("keeps what it understands, drops the rest and the defaults", () => {
    expect(validateHomeSearch({ view: "table", sort: "status", dir: "asc", q: "stand", tags: "a,b", new: "1", junk: "x" })).toEqual({
      view: "table",
      sort: "status",
      dir: "asc",
      q: "stand",
      new: true,
    });
    expect(validateHomeSearch({ view: "grid", sort: "updated", dir: "desc" })).toEqual({});
    expect(validateHomeSearch({ view: "carousel", sort: "colour", dir: "sideways", new: "0" })).toEqual({});
  });
});

describe("project search", () => {
  test("a part with its mode, revision and compare; panel, session and sheet", () => {
    expect(validateProjectSearch({ part: "clip", mode: "thickness", at: "r4", compare: "r3", panel: "review", session: "s1", sheet: "review" })).toEqual({
      part: "clip",
      mode: "thickness",
      at: "r4",
      compare: "r3",
      panel: "review",
      session: "s1",
      sheet: "review",
    });
  });

  test("one selection: part beats assembly beats file", () => {
    expect(validateProjectSearch({ part: "a", assembly: "1", file: "x.md" })).toEqual({ part: "a" });
    expect(validateProjectSearch({ assembly: "1", file: "x.md" })).toEqual({ assembly: true });
    expect(validateProjectSearch({ file: "x.md" })).toEqual({ file: "x.md" });
  });

  test("params that mean nothing for the selection are dropped", () => {
    expect(validateProjectSearch({ file: "a.md", mode: "section", compare: "r1", edit: "1" })).toEqual({ file: "a.md", edit: true });
    expect(validateProjectSearch({ part: "p", edit: "1" })).toEqual({ part: "p" });
    expect(validateProjectSearch({ at: "r1", mode: "code", compare: "r2" })).toEqual({});
    expect(validateProjectSearch({ assembly: "1", at: "r1" })).toEqual({ assembly: true });
    expect(validateProjectSearch({ file: "a.md", at: "r1", edit: "1" })).toEqual({ file: "a.md", at: "r1" });
  });

  test("defaults are implicit and unknown values are dropped", () => {
    expect(validateProjectSearch({ part: "p", mode: "shaded", panel: "session" })).toEqual({ part: "p" });
    expect(validateProjectSearch({ part: "p", mode: "xray", panel: "info", sheet: "files" })).toEqual({ part: "p" });
    expect(validateProjectSearch({ panel: "none" })).toEqual({ panel: "none" });
  });

  test("changing the selection keeps panel, session and sheet and clears the rest", () => {
    const s = validateProjectSearch({ part: "p", mode: "code", at: "r1", compare: "r0", panel: "review", session: "s", sheet: "review" });
    expect(withSelection(s, { kind: "file", path: "brief.md" })).toEqual({ panel: "review", session: "s", sheet: "review", file: "brief.md" });
    expect(selectionOf(withSelection(s, { kind: "assembly" }))).toEqual({ kind: "assembly" });
    expect(selectionOf({})).toEqual({ kind: "none" });
  });
});
