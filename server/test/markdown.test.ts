import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../src/index/markdown.ts";
import { parseScad } from "../src/index/scad.ts";

describe("markdown notes grammar", () => {
  test("frontmatter: title; other keys are ignored", () => {
    expect(parseMarkdown('---\ntitle: "Hello: world"\ntags: [A, "b c", d]\nother: 1\n---\n# Ignored heading').title).toBe("Hello: world");
    expect(parseMarkdown("---\ntags: [A, b]\n---\nbody").body).toBe("body");
    expect(parseMarkdown("---\r\ntitle: Win\r\n---\r\nbody").title).toBe("Win");
  });

  test("title falls back to the first heading, then null", () => {
    expect(parseMarkdown("intro\n\n## Second level\n# later").title).toBe("Second level");
    expect(parseMarkdown("no heading here").title).toBeNull();
    expect(parseMarkdown("```\n# in code\n```\n").title).toBeNull();
  });

  test("facts: category, text, line numbers", () => {
    const md = parseMarkdown("---\ntitle: T\n---\n- [spec] wall is 1.2 mm\n  - [warning] nested fact\n* [note] star bullet");
    expect(md.facts).toEqual([
      { category: "spec", text: "wall is 1.2 mm", line: 4 },
      { category: "warning", text: "nested fact", line: 5 },
      { category: "note", text: "star bullet", line: 6 },
    ]);
  });

  test("checkboxes, markdown links and code are not facts", () => {
    const md = parseMarkdown("- [ ] open\n- [x] done\n- [X] done\n- [text](http://x) link\n```\n- [spec] in a fence\n```\n- plain");
    expect(md.facts).toEqual([]);
  });

  test("relations, bare relations and plain links", () => {
    const md = parseMarkdown(
      [
        "- implements [[src/body.scad]]",
        "- depends on [[other]]",
        "- [[bare]]",
        "- [[aliased|Shown]] and then [[tail]]",
        "Prose with [[inline]] and `[[in code]]`.",
        "- [x] task mentioning [[task-link]]",
        "- [spec] fact mentioning [[fact-link]]",
        "- this is a long sentence that happens to precede [[prose-target]]",
        "```",
        "[[fenced]]",
        "```",
      ].join("\n"),
    );
    expect(md.links.map((l) => `${l.relation}>${l.target}`)).toEqual([
      "implements>src/body.scad",
      "depends_on>other",
      "relates_to>bare",
      "relates_to>aliased",
      "links_to>tail",
      "links_to>inline",
      "links_to>task-link",
      "links_to>fact-link",
      "links_to>prose-target",
    ]);
  });

  test("duplicate links in one file are kept once", () => {
    const md = parseMarkdown("[[a]] and [[a]]\n- uses [[a]]\n- uses [[a]]");
    expect(md.links.map((l) => `${l.relation}>${l.target}`)).toEqual(["links_to>a", "uses>a"]);
  });
});

describe("scad parser", () => {
  test("use, include and import links; comments ignored", () => {
    const scad = parseScad(
      `// use <commented.scad>\nuse <lib/helper.scad>;\ninclude <../common.scad>\n/* include <block.scad> */\nimport("../refs/m.stl");\nimport(file = "b.dxf");\nuse <lib/helper.scad>;`,
    );
    expect(scad.links).toEqual([
      { relation: "uses", target: "lib/helper.scad" },
      { relation: "includes", target: "../common.scad" },
      { relation: "imports", target: "../refs/m.stl" },
      { relation: "imports", target: "b.dxf" },
    ]);
  });

  test("outline lists modules and functions once", () => {
    const scad = parseScad(`module body(w) {}\nfunction half(x) = x / 2;\nmodule body() {}\n// module hidden() {}\nmodule  lid() {}`);
    expect(scad.outline).toEqual(["body", "half", "lid"]);
  });
});
