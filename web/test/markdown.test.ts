import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Link } from "@drawer/shared/api";
import { remarkDrawer, resolveWikiTarget, splitWikiLinks, stripFrontmatter } from "@/core/markdown";

describe("frontmatter", () => {
  test("is removed from the body", () => {
    const { body, frontmatter } = stripFrontmatter("---\ntitle: A\ntags: [x]\n---\n# Heading\n");
    expect(body).toBe("# Heading\n");
    expect(frontmatter).toBe("title: A\ntags: [x]");
  });

  test("a horizontal rule is not frontmatter", () => {
    const text = "# Title\n\n---\n\ntext\n---\n";
    expect(stripFrontmatter(text).body).toBe(text);
    expect(stripFrontmatter("no frontmatter").frontmatter).toBeNull();
  });

  test("handles CRLF", () => {
    expect(stripFrontmatter("---\r\ntitle: A\r\n---\r\nbody").body).toBe("body");
  });
});

describe("wiki links", () => {
  test("splits prose around [[targets]]", () => {
    expect(splitWikiLinks("see [[notes/a]] and [[b]].")).toEqual([
      { kind: "text", value: "see " },
      { kind: "wiki", target: "notes/a" },
      { kind: "text", value: " and " },
      { kind: "wiki", target: "b" },
      { kind: "text", value: "." },
    ]);
    expect(splitWikiLinks("no links")).toEqual([{ kind: "text", value: "no links" }]);
    expect(splitWikiLinks("[[Library: tolerances]]")).toEqual([{ kind: "wiki", target: "Library: tolerances" }]);
  });

  const link = (target: string, to: string | null): Link => ({ from: "AGENTS.md", fromProject: "p", relation: "links_to", target, to, toProject: to ? "p" : null });

  test("resolves through FileInfo.outgoing; unresolved targets stay null", () => {
    const outgoing = [link("a", "notes/a.md"), link("gone", null)];
    expect(resolveWikiTarget("a", outgoing)?.to).toBe("notes/a.md");
    expect(resolveWikiTarget("gone", outgoing)).toBeNull();
    expect(resolveWikiTarget("unknown", outgoing)).toBeNull();
  });
});

describe("remark plugin", () => {
  const render = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkDrawer] }, md));

  test("fact categories become data-fact spans, the rest of the line stays text", () => {
    const html = render("- [decision] Print in PETG\n- [warning] mind the warp\n");
    expect(html).toContain('data-fact="decision"');
    expect(html).toContain('data-fact="warning"');
    expect(html).toContain("</span>Print in PETG</li>");
  });

  test("task list items are not facts", () => {
    const html = render("- [ ] todo item\n- [x] done item\n");
    expect(html).not.toContain("data-fact");
    expect(html).toContain('type="checkbox"');
  });

  test("[[links]] become data-wiki spans in prose, lists and facts", () => {
    const html = render("See [[notes/a]].\n\n- depends_on [[b]]\n- [todo] write [[c]]\n");
    expect(html).toContain('data-wiki="notes/a"');
    expect(html).toContain('data-wiki="b"');
    expect(html).toContain('data-wiki="c"');
    expect(html).toContain('data-fact="todo"');
  });

  test("code is left alone", () => {
    const html = render("`[[not-a-link]]`\n\n```\n- [fact] in code [[x]]\n```\n");
    expect(html).not.toContain("data-wiki");
    expect(html).not.toContain("data-fact");
  });
});
