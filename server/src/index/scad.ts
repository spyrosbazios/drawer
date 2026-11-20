/** Links and outline of an OpenSCAD file. */

export interface ScadLink {
  relation: "uses" | "includes" | "imports";
  target: string;
}

export interface ParsedScad {
  links: ScadLink[];
  /** Module and function names defined in the file, in order of appearance. */
  outline: string[];
}

/** Replaces comments with spaces (newlines kept); string literals are left alone. */
function blankComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function parseScad(text: string): ParsedScad {
  const code = blankComments(text);
  const links: ScadLink[] = [];
  const seen = new Set<string>();
  const push = (relation: ScadLink["relation"], target: string): void => {
    const key = `${relation}\u0000${target}`;
    if (target === "" || seen.has(key)) return;
    seen.add(key);
    links.push({ relation, target });
  };
  for (const m of code.matchAll(/\b(use|include)\s*<([^>\n]+)>/g)) {
    push(m[1] === "use" ? "uses" : "includes", (m[2] ?? "").trim());
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*(?:file\s*=\s*)?"([^"\n]+)"/g)) push("imports", (m[1] ?? "").trim());

  const outline: string[] = [];
  for (const m of code.matchAll(/\b(?:module|function)\s+([A-Za-z_$][\w$]*)/g)) {
    const name = m[1] ?? "";
    if (!outline.includes(name)) outline.push(name);
  }
  return { links, outline };
}
