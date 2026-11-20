/** Parser for the notes grammar in docs/SPEC.md: frontmatter, facts, relations, links. */

export interface ParsedFact {
  category: string;
  text: string;
  line: number;
}

export interface ParsedLink {
  relation: string;
  target: string;
  line: number;
}

export interface ParsedMarkdown {
  title: string | null;
  /** The text after the frontmatter. */
  body: string;
  facts: ParsedFact[];
  links: ParsedLink[];
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to plain stripping
    }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

interface Frontmatter {
  title: string | null;
  /** Number of source lines the frontmatter block occupies (including both fences). */
  lines: number;
}

function parseFrontmatter(lines: string[]): Frontmatter {
  const none: Frontmatter = { title: null, lines: 0 };
  if (lines[0]?.replace(/^﻿/, "").trimEnd() !== "---") return none;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trimEnd();
    if (line === "---" || line === "...") {
      end = i;
      break;
    }
  }
  if (end < 0) return none;
  let title: string | null = null;
  for (let i = 1; i < end; i++) {
    const match = /^title\s*:\s*(.*)$/.exec(lines[i] ?? "");
    if (match) title = unquote(match[1] ?? "") || null;
  }
  return { title, lines: end + 1 };
}

const FACT_RE = /^\s*[-*+]\s+\[([^\][]+)\]\s+(.*\S)\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const RELATION_RE = /^([A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z0-9_-]+){0,3})\s*\[\[/;
const WIKILINK_RE = /\[\[([^\][\n]+?)\]\]/g;
const FENCE_RE = /^\s*(```|~~~)/;

function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

/** `[[target|alias]]` -> `target`. */
function wikiTarget(raw: string): string {
  const pipe = raw.indexOf("|");
  return (pipe < 0 ? raw : raw.slice(0, pipe)).trim();
}

function relationName(words: string): string {
  return words.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function parseMarkdown(text: string): ParsedMarkdown {
  const lines = text.split(/\r?\n/);
  const fm = parseFrontmatter(lines);
  const facts: ParsedFact[] = [];
  const links: ParsedLink[] = [];
  const seenLinks = new Set<string>();
  const pushLink = (relation: string, target: string, line: number): void => {
    if (target === "") return;
    const key = `${relation}\u0000${target}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({ relation, target, line });
  };

  let title: string | null = fm.title;
  let fence: string | null = null;
  for (let i = fm.lines; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "```";
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const lineNo = i + 1;
    const prose = stripInlineCode(line);

    if (title === null) {
      const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(prose);
      if (heading) title = (heading[1] ?? "").trim() || null;
    }

    const fact = FACT_RE.exec(prose);
    let wikiSource = prose;
    let relationHandled = false;
    if (fact) {
      const category = (fact[1] ?? "").trim();
      if (category !== "" && category !== "x" && category !== "X") {
        const original = FACT_RE.exec(line);
        const rawText = (original?.[2] ?? fact[2] ?? "").trim();
        facts.push({ category, text: rawText, line: lineNo });
        wikiSource = prose;
        relationHandled = true;
      }
    }
    if (!relationHandled) {
      const bullet = BULLET_RE.exec(prose);
      if (bullet) {
        const content = bullet[1] ?? "";
        const first = /^\[\[([^\][\n]+?)\]\]/.exec(content);
        if (first) {
          pushLink("relates_to", wikiTarget(first[1] ?? ""), lineNo);
          wikiSource = content.slice(first[0].length);
        } else {
          const rel = RELATION_RE.exec(content);
          const after = rel ? /^\[\[([^\][\n]+?)\]\]/.exec(content.slice(rel[0].length - 2)) : null;
          if (rel && after) {
            pushLink(relationName(rel[1] ?? ""), wikiTarget(after[1] ?? ""), lineNo);
            wikiSource = content.slice(rel[0].length - 2 + after[0].length);
          }
        }
      }
    }
    for (const match of wikiSource.matchAll(WIKILINK_RE)) pushLink("links_to", wikiTarget(match[1] ?? ""), lineNo);
  }

  return { title, body: lines.slice(fm.lines).join("\n"), facts, links };
}
