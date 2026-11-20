import TurndownService from "turndown";

const HAS_TAG = /<\/?[a-z][a-z0-9-]*(\s[^>]*)?\/?>/i;

function createConverter(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    linkStyle: "inlined",
  });
  td.remove(["script", "style", "noscript", "iframe", "object", "embed", "template"]);
  // A link that runs script keeps its text and loses the link.
  td.addRule("unsafeLinks", {
    filter: (node) => node.nodeName === "A" && /^\s*(javascript|data|vbscript):/i.test(node.getAttribute("href") ?? ""),
    replacement: (content) => content,
  });
  return td;
}

const converter = createConverter();

/** HTML to markdown. Scripts, styles and frames are dropped. */
export function htmlToMarkdown(html: string): string {
  const md = converter.turndown(html);
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * For fields that sites serve as HTML or as plain text or markdown depending on the model:
 * text without any tag is already readable and is returned as it is.
 */
export function toMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  if (!HAS_TAG.test(text)) return text.replace(/\r\n/g, "\n").trim();
  return htmlToMarkdown(text);
}
