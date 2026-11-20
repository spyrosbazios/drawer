/**
 * Pure helpers for the notes grammar (docs/SPEC.md "Notes grammar"). The server indexes facts and
 * links; the reader repeats just enough of the grammar to draw them.
 */
import type { Link } from "@drawer/shared/api";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function stripFrontmatter(text: string): { body: string; frontmatter: string | null } {
  const m = FRONTMATTER.exec(text);
  if (!m) return { body: text, frontmatter: null };
  return { body: text.slice(m[0].length), frontmatter: m[1] ?? "" };
}

export type InlinePart = { kind: "text"; value: string } | { kind: "wiki"; target: string };

const WIKI = /\[\[([^[\]\n]+)\]\]/g;

/** Splits prose into plain text and `[[target]]` references. */
export function splitWikiLinks(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const m of text.matchAll(WIKI)) {
    const index = m.index ?? 0;
    if (index > last) parts.push({ kind: "text", value: text.slice(last, index) });
    parts.push({ kind: "wiki", target: (m[1] ?? "").trim() });
    last = index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

/** The resolved outgoing link for a `[[target]]` written in the file, or null while it is unresolved. */
export function resolveWikiTarget(target: string, outgoing: readonly Link[]): Link | null {
  return outgoing.find((l) => l.target === target && l.to !== null) ?? null;
}

// ---- remark plugin ----------------------------------------------------------------------

/** The slice of an mdast node the plugin touches; kept local so no extra type package is needed. */
export interface MdNode {
  type: string;
  value?: string;
  checked?: boolean | null;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

const SKIP = new Set(["link", "linkReference", "code", "inlineCode", "html", "definition"]);

function wikiNodes(value: string): MdNode[] {
  return splitWikiLinks(value).map((part): MdNode =>
    part.kind === "text"
      ? { type: "text", value: part.value }
      : {
          type: "wikiLink",
          data: { hName: "span", hProperties: { "data-wiki": part.target } },
          children: [{ type: "text", value: part.target }],
        },
  );
}

function expandWiki(node: MdNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value !== undefined && child.value.includes("[[")) {
      next.push(...wikiNodes(child.value));
    } else {
      expandWiki(child);
      next.push(child);
    }
  }
  node.children = next;
}

const FACT_PREFIX = /^\[([^\]\n]+)\]\s+/;

function markFact(item: MdNode): void {
  if (item.checked !== undefined && item.checked !== null) return;
  const paragraph = item.children?.[0];
  const first = paragraph?.type === "paragraph" ? paragraph.children?.[0] : undefined;
  if (!paragraph?.children || first?.type !== "text" || first.value === undefined) return;
  const m = FACT_PREFIX.exec(first.value);
  if (!m) return;
  const category = (m[1] ?? "").trim();
  if (category === "" || /^[xX]$/.test(category)) return;
  const chip: MdNode = {
    type: "factCategory",
    data: { hName: "span", hProperties: { "data-fact": category } },
    children: [{ type: "text", value: category }],
  };
  const rest = first.value.slice(m[0].length);
  paragraph.children.splice(0, 1, chip, ...(rest === "" ? [] : [{ type: "text", value: rest }]));
}

function visitFacts(node: MdNode): void {
  if (node.type === "listItem") markFact(node);
  node.children?.forEach(visitFacts);
}

/** remark plugin: fact categories and `[[target]]` become `span`s carrying `data-fact` / `data-wiki`. */
export function remarkDrawer() {
  return (tree: MdNode): void => {
    visitFacts(tree);
    expandWiki(tree);
  };
}
