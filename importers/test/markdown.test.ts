import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, toMarkdown } from "../src/markdown";

describe("html to markdown", () => {
  test("headings, emphasis, lists and links", () => {
    const md = htmlToMarkdown(
      '<h2>Print settings</h2><p>Use <strong>PETG</strong> and <em>0.2 mm</em> layers.</p><ul><li>3 walls</li><li>20% infill</li></ul><p><a href="https://example.com/x">more</a></p>',
    );
    expect(md).toBe("## Print settings\n\nUse **PETG** and *0.2 mm* layers.\n\n-   3 walls\n-   20% infill\n\n[more](https://example.com/x)");
  });

  test("scripts, styles and frames are dropped with their content", () => {
    const md = htmlToMarkdown('<p>Hello</p><script>alert("x")</script><style>p{color:red}</style><iframe src="https://e.example"></iframe><p>World</p>');
    expect(md).toBe("Hello\n\nWorld");
  });

  test("a javascript: link keeps its text and loses the link", () => {
    expect(htmlToMarkdown('<a href="javascript:alert(1)">click</a> <a href="https://ok.example">ok</a>')).toBe("click [ok](https://ok.example)");
  });

  test("images and code", () => {
    const md = htmlToMarkdown('<img src="https://e.example/a.png" alt="part"><pre><code>cube([1,2,3]);</code></pre>');
    expect(md).toContain("![part](https://e.example/a.png)");
    expect(md).toContain("```\ncube([1,2,3]);\n```");
  });

  test("unknown vendor tags keep their text", () => {
    expect(htmlToMarkdown("<boostme><boosttitle>Boost Me</boosttitle></boostme><p>text</p>")).toContain("text");
  });

  test("plain text and markdown pass through untouched", () => {
    expect(toMarkdown("Use *PETG*.\r\n\r\n- one")).toBe("Use *PETG*.\n\n- one");
    expect(toMarkdown(null)).toBe("");
    expect(toMarkdown("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
  });

  test("html is converted by toMarkdown", () => {
    expect(toMarkdown("<p>PETG/PLA/ABS</p>")).toBe("PETG/PLA/ABS");
  });
});
