/**
 * Human text for what the server decides: part and assembly reports, check diagnostics, part lines.
 * Written for an agent that must know at once what to do: verdict first, failing gates first with
 * their hint, then what to do next, then where the pictures are.
 */
import type { AssemblyReport, GateResult, GateStatus, PartReport, PartSummary, ScadCheck, ScadParam } from "@drawer/shared/api";
import { formatMesh, num, oneLine } from "./output.ts";
import { type Pictures, pictureLines } from "./pictures.ts";

/** A report as printed with `--json`: the server's report plus the local paths of its pictures. */
export type LocalPartReport = PartReport & { pictures: Pictures | null };
export type LocalAssemblyReport = AssemblyReport & { pictures: Pictures | null };

const GATE_WORD: Record<GateStatus, string> = { fail: "fail", warn: "warn", pass: "pass", waived: "waived", skipped: "skip" };
/** Failing gates first, then warnings, then the rest in the server's order. */
const GATE_RANK: Record<GateStatus, number> = { fail: 0, warn: 1, pass: 2, waived: 2, skipped: 2 };
const INDENT = " ".repeat(8);

function gateLines(gate: GateResult): string[] {
  const head = `${GATE_WORD[gate.status].padEnd(6)}  ${gate.label}  [${gate.id}]`;
  let numbers = "";
  if (gate.measured !== null && gate.expected !== null) numbers = `  measured ${gate.measured}, expected ${gate.expected}`;
  else if (gate.measured !== null) numbers = `  measured ${gate.measured}`;
  else if (gate.expected !== null) numbers = `  expected ${gate.expected}`;
  const lines = [`${head}${numbers}`];
  if (gate.status === "pass") return lines;
  if (gate.detail) lines.push(`${INDENT}${gate.status === "waived" ? "waived: " : ""}${oneLine(gate.detail)}`);
  if (gate.hint) lines.push(`${INDENT}hint: ${oneLine(gate.hint)}`);
  if (gate.at) lines.push(`${INDENT}at ${gate.at.map(num).join(", ")}`);
  return lines;
}

function gatesText(gates: readonly GateResult[]): string[] {
  return [...gates].sort((a, b) => GATE_RANK[a.status] - GATE_RANK[b.status]).flatMap(gateLines);
}

function nextText(next: readonly string[], status: string): string[] {
  if (next.length === 0) return status === "passed" ? ["done: every gate passes or is waived"] : [];
  return ["next:", ...next.map((step, i) => `  ${i + 1}. ${oneLine(step)}`)];
}

const picturesText = (pictures: Pictures | null): string[] => (pictures ? ["pictures:", ...pictureLines(pictures).map((l) => `  ${l}`)] : []);

function paramValue(value: ScadParam["value"]): string {
  return typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.join(",")}]` : String(value);
}

export function partReportText(report: LocalPartReport): string {
  const { spec } = report;
  const verdict = `${report.whatIf ? "what-if " : ""}${report.status} ${report.passed}/${report.total}`;
  const lines = [`${verdict}  ${report.project}/${report.part}  ${oneLine(spec.title)}  (${spec.source}, ${spec.material}, ${spec.strictness})  revision ${report.revisionId}`];
  if (report.whatIf) lines.push("what-if: parameters were overridden and nothing was written; this is not the part's status");
  const facts = report.mesh ? formatMesh(report.mesh) : "no mesh";
  lines.push(report.massG === null ? facts : `${facts}, ${num(report.massG)} g`);
  lines.push(...gatesText(report.gates));
  lines.push(...nextText(report.next, report.status));
  if (report.params.length > 0) lines.push(`params: ${report.params.map((p) => `${p.name}=${paramValue(p.value)}`).join(" ")}`);
  lines.push(...picturesText(report.pictures));
  return lines.join("\n");
}

export function assemblyReportText(report: LocalAssemblyReport): string {
  const { spec } = report;
  const mass = report.totalPrintedMassG === null ? "" : `, printed mass ${num(report.totalPrintedMassG)} g`;
  const lines = [
    `${report.status} ${report.passed}/${report.total}  ${report.project} assembly  ${oneLine(spec.title)}  (${spec.instances.length} instances, ${spec.mates.length} mates${mass})  revision ${report.revisionId}`,
  ];
  lines.push(...gatesText(report.gates));
  lines.push(...nextText(report.next, report.status));
  if (report.pairs.length > 0) {
    lines.push("pairs:");
    for (const p of report.pairs) lines.push(`  ${p.a} - ${p.b}  gap ${num(p.gapMm)} mm  overlap ${num(p.overlapCm3)} cm3`);
  }
  if (report.bom.length > 0) {
    lines.push("bom:");
    for (const b of report.bom) {
      const material = b.material ? `, ${b.material}` : "";
      const each = b.massG === null ? "" : `, ${num(b.massG)} g each`;
      lines.push(`  ${b.count} x ${b.part}  ${oneLine(b.title)}  (${b.source}${material}${each})`);
    }
  }
  lines.push(...picturesText(report.pictures));
  return lines.join("\n");
}

/** OpenSCAD's errors and warnings for a written `.scad` file. */
export function checkText(check: ScadCheck): string[] {
  if (check.diagnostics.length === 0) return ["check ok"];
  const errors = check.diagnostics.filter((d) => d.level === "error").length;
  const warnings = check.diagnostics.length - errors;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines = [`check: ${count(errors, "error")}, ${count(warnings, "warning")}`];
  for (const d of check.diagnostics) {
    const where = d.file === null ? "" : `${d.file}${d.line === null ? "" : `:${d.line}`}  `;
    lines.push(`  ${d.level.padEnd(7)} ${where}${oneLine(d.message)}`);
  }
  return lines;
}

/** One part: `lid  draft 6/7  Lid  printed PETG standard`, then what fails. */
export function partLine(p: PartSummary): string {
  const evaluating = p.evaluating ? " (evaluating)" : "";
  const printed = p.printed === null ? "" : `  printed ${p.printed}`;
  const failing = p.failing.length > 0 ? `  failing: ${p.failing.join("; ")}` : "";
  const kind = p.class ? `${oneLine(p.title)} [${oneLine(p.class)}]` : oneLine(p.title);
  return `${p.id}  ${p.status} ${p.passed}/${p.total}${evaluating}  ${kind}  ${p.source} ${p.material} ${p.strictness}${printed}${failing}`;
}
