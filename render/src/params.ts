/**
 * OpenSCAD Customizer parameters: parse them from source, write new values back into the
 * source, and turn values into `-D` arguments. Pure text functions.
 *
 * Only top-level assignments BEFORE the first module/function definition are customizable:
 * `-D` on a later variable is shadowed by its own assignment, so offering it would be a knob
 * that silently does nothing.
 */
import type { ParamValue, ParamValues, ScadParam } from "@drawer/shared/api";
import { RenderError } from "@drawer/shared/contracts";

const NUM_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

interface Located extends ScadParam {
  /** Offsets in the source of the value expression (without the `;`). */
  valueStart: number;
  valueEnd: number;
}

/**
 * The source with block comments blanked (newlines kept, so offsets and line numbers stay
 * valid), and the lines that carry a `/* [Section] *\/` marker.
 */
function maskBlockComments(src: string): { masked: string; sections: Map<number, string> } {
  const chars = src.split("");
  const sections = new Map<number, string>();
  let line = 0;
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      inStr = false;
      i++;
      continue;
    }
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      const body = src.slice(i + 2, close === -1 ? src.length : close);
      const section = /^\s*\[([^\]]*)\]\s*$/.exec(body);
      if (section) sections.set(line, (section[1] ?? "").trim());
      for (let j = i; j < end; j++) {
        if (src[j] === "\n") line++;
        else chars[j] = " ";
      }
      i = end;
      continue;
    }
    i++;
  }
  return { masked: chars.join(""), sections };
}

/** Index of the first `//` outside a string literal, or -1. */
function lineCommentAt(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}

function parseLiteral(raw: string): { type: ScadParam["type"]; value: ParamValue } | null {
  const v = raw.trim();
  if (v === "true") return { type: "boolean", value: true };
  if (v === "false") return { type: "boolean", value: false };
  if (NUM_RE.test(v)) return { type: "number", value: Number(v) };
  const str = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
  if (str) return { type: "string", value: (str[1] ?? "").replace(/\\(.)/g, "$1") };
  const vec = /^\[(.*)\]$/.exec(v);
  if (vec) {
    const parts = (vec[1] ?? "").split(",").map((s) => s.trim());
    if (parts.length > 0 && parts.every((p) => NUM_RE.test(p))) return { type: "vector", value: parts.map(Number) };
  }
  // Expressions are real OpenSCAD but not something a form can round-trip.
  return null;
}

type Annotation = { kind: "range"; min: number; max: number; step: number | null } | { kind: "options"; options: { value: number | string; label: string }[] } | null;

/** The `// [...]` forms: [min:max], [min:step:max], [a, b, c], [a:Label, b:Label]. */
function parseAnnotation(comment: string): { annotation: Annotation; description: string } {
  const m = /^\[([^\]]*)\]\s*(.*)$/.exec(comment.trim());
  if (!m) return { annotation: null, description: comment.trim() };
  const body = (m[1] ?? "").trim();
  const rest = (m[2] ?? "").trim();
  const literal = (s: string): number | string => (NUM_RE.test(s) ? Number(s) : s);
  if (body.includes(",")) {
    const options = body
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((t) => {
        const labelled = /^([^:]+):(.*)$/.exec(t);
        if (labelled) return { value: literal((labelled[1] ?? "").trim()), label: (labelled[2] ?? "").trim() };
        return { value: literal(t), label: t };
      });
    return { annotation: { kind: "options", options }, description: rest };
  }
  const nums = body.split(":").map((s) => s.trim());
  if (nums.length >= 2 && nums.length <= 3 && nums.every((n) => NUM_RE.test(n))) {
    const p = nums.map(Number);
    const annotation: Annotation = p.length === 2 ? { kind: "range", min: p[0]!, max: p[1]!, step: null } : { kind: "range", min: p[0]!, step: p[1]!, max: p[2]! };
    return { annotation, description: rest };
  }
  if (body) return { annotation: { kind: "options", options: [{ value: literal(body), label: body }] }, description: rest };
  return { annotation: null, description: comment.trim() };
}

function locate(src: string): Located[] {
  const { masked, sections } = maskBlockComments(src);
  const cut = /(^|\n)[ \t]*(module|function)\s+[A-Za-z_$][\w$]*\s*\(/.exec(masked);
  const regionEnd = cut ? cut.index + (cut[1] ?? "").length : masked.length;

  const params: Located[] = [];
  let group = "";
  let pending = "";
  let offset = 0;
  let lineNo = 0;
  while (offset < regionEnd) {
    const nl = masked.indexOf("\n", offset);
    const end = Math.min(nl === -1 ? masked.length : nl, regionEnd);
    const line = masked.slice(offset, end).replace(/\r$/, "");
    const lineStart = offset;
    const thisLine = lineNo;
    offset = end + 1;
    lineNo++;

    const section = sections.get(thisLine);
    if (section !== undefined) {
      group = section;
      pending = "";
    }
    const at = lineCommentAt(line);
    const code = at < 0 ? line : line.slice(0, at);
    const comment = at < 0 ? "" : line.slice(at + 2).trim();
    if (!code.trim()) {
      if (comment && !comment.startsWith("[")) pending = comment;
      else if (!comment && section === undefined) pending = "";
      continue;
    }
    const m = /^(\s*)([A-Za-z_$][\w$]*)(\s*=\s*)(.*?)\s*;\s*$/.exec(code);
    if (!m) {
      pending = "";
      continue;
    }
    const name = m[2] ?? "";
    const rawValue = m[4] ?? "";
    const literal = parseLiteral(rawValue);
    const description = pending;
    pending = "";
    if (!literal) continue;
    const prev = params.findIndex((p) => p.name === name);
    if (prev !== -1) params.splice(prev, 1); // the last assignment wins
    if (group.toLowerCase() === "hidden") continue;
    const { annotation, description: trailing } = parseAnnotation(comment);
    const valueStart = lineStart + (m[1] ?? "").length + name.length + (m[3] ?? "").length;
    const param: Located = {
      name,
      type: literal.type,
      value: literal.value,
      group,
      description: trailing || description,
      min: null,
      max: null,
      step: null,
      options: null,
      line: thisLine + 1,
      valueStart,
      valueEnd: valueStart + rawValue.length,
    };
    if (annotation?.kind === "options") param.options = annotation.options;
    else if (annotation?.kind === "range" && literal.type === "number") {
      param.min = annotation.min;
      param.max = annotation.max;
      param.step = annotation.step;
    }
    params.push(param);
  }
  return params;
}

export function parseParams(source: string): ScadParam[] {
  return locate(source).map(({ valueStart: _s, valueEnd: _e, ...p }) => p);
}

/** OpenSCAD source text for a value; throws RenderError for one that has none. */
export function formatValue(name: string, value: ParamValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RenderError(`parameter ${name}: ${value} is not a finite number`);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "number" && Number.isFinite(v))) return `[${value.map(String).join(", ")}]`;
  throw new RenderError(`parameter ${name}: unsupported value`);
}

/** `-D name=value` arguments, in name order (stable for the cache key). */
export function defineArgs(values: ParamValues | undefined): string[] {
  if (!values) return [];
  const args: string[] = [];
  for (const name of Object.keys(values).sort()) {
    if (!IDENT_RE.test(name)) throw new RenderError(`parameter name "${name}" is not an OpenSCAD identifier`);
    args.push("-D", `${name}=${formatValue(name, values[name] as ParamValue)}`);
  }
  return args;
}

function typeOf(value: ParamValue): ScadParam["type"] {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "vector";
}

export function applyParams(source: string, values: ParamValues): string {
  const located = locate(source);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const [name, value] of Object.entries(values)) {
    const p = located.find((q) => q.name === name);
    if (!p) throw new RenderError(`"${name}" is not a parameter of this model`);
    if (typeOf(value) !== p.type) throw new RenderError(`parameter ${name} is a ${p.type}, not a ${typeOf(value)}`);
    if (p.type === "vector" && Array.isArray(value) && Array.isArray(p.value) && value.length !== p.value.length) {
      throw new RenderError(`parameter ${name} has ${p.value.length} components, not ${value.length}`);
    }
    edits.push({ start: p.valueStart, end: p.valueEnd, text: formatValue(name, value) });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
