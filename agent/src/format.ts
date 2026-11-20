/** Plain-text renderings of API results for the modelling agent: short, failing things first. */
import type {
  AssemblyReport,
  Attempt,
  GateResult,
  MeshAnalysis,
  MeshInfo,
  ParamValue,
  PartReport,
  PartSummary,
  ProjectOverview,
  ScadCheck,
  SessionAttachment,
  SessionRef,
  Vec3,
} from "@drawer/shared/api";

const num = (n: number, digits = 2): string => String(Number(n.toFixed(digits)));
export const vec = (v: readonly number[]): string => `(${v.map((n) => num(n)).join(", ")})`;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated: ${text.length - max} more characters]`;
}

/** One line, at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function formatValue(value: ParamValue): string {
  return Array.isArray(value) ? `[${value.join(", ")}]` : typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function formatCheck(check: ScadCheck | null): string | null {
  if (!check) return null;
  if (check.diagnostics.length === 0) return "Check: no errors or warnings.";
  const lines = check.diagnostics.map((d) => {
    const where = d.file ? ` ${d.file}${d.line !== null ? `:${d.line}` : ""}` : d.line !== null ? ` line ${d.line}` : "";
    return `- ${d.level}${where}: ${d.message}`;
  });
  return [`Check: ${check.ok ? "ok" : "ERRORS"}`, ...lines].join("\n");
}

function formatGate(g: GateResult): string {
  const parts = [`- ${g.label} [${g.status}]`];
  const facts: string[] = [];
  if (g.measured !== null) facts.push(`measured ${g.measured}`);
  if (g.expected !== null) facts.push(`expected ${g.expected}`);
  if (facts.length > 0) parts.push(`: ${facts.join(", ")}`);
  if (g.at) parts.push(` at ${vec(g.at)}`);
  if (g.detail) parts.push(`. ${g.detail}`);
  if (g.hint) parts.push(`. Hint: ${g.hint}`);
  return parts.join("");
}

function formatMesh(mesh: MeshInfo | null, massG: number | null): string | null {
  if (!mesh) return null;
  const [x, y, z] = mesh.bbox.size;
  const volume = mesh.volumeCm3 !== null ? `, volume ${num(mesh.volumeCm3)} cm³` : "";
  const mass = massG !== null ? `, mass ${num(massG, 1)} g` : "";
  return `Mesh: ${num(x)} × ${num(y)} × ${num(z)} mm, min ${vec(mesh.bbox.min)}${volume}${mass}`;
}

function formatAnalysis(a: MeshAnalysis | null): string | null {
  if (!a) return null;
  const wall = a.wall ? `, thinnest wall ${num(a.wall.minMm)} mm at ${vec(a.wall.at)}` : "";
  return `Analysis: ${a.shells} shell(s), ${a.watertight ? "watertight" : "NOT watertight"}, base ${num(a.baseAreaMm2, 1)} mm² of ${num(a.footprintMm2, 1)} mm² footprint, overhang ${num(a.overhang.areaMm2, 1)} mm² beyond ${a.overhang.angle}°${wall}`;
}

/** Gates split as the agent should read them: failures first, then warnings, then a compact list of the rest. */
function formatGates(gates: GateResult[]): string[] {
  const failing = gates.filter((g) => g.status === "fail");
  const warning = gates.filter((g) => g.status === "warn");
  const rest = gates.filter((g) => g.status !== "fail" && g.status !== "warn");
  const lines: string[] = [];
  if (failing.length > 0) lines.push("Failing:", ...failing.map(formatGate));
  if (warning.length > 0) lines.push("Warnings:", ...warning.map(formatGate));
  if (rest.length > 0) lines.push(`Other gates: ${rest.map((g) => `${g.label} ${g.status}${g.status === "waived" && g.detail ? ` (${g.detail})` : ""}`).join("; ")}`);
  return lines;
}

/** The status line plus the rest, ending with the server's most important next step. */
export function formatPartReport(r: PartReport): string {
  const lines = [`Part ${r.part}: ${r.status.toUpperCase()} (${r.passed}/${r.total} gates)${r.whatIf ? " — what-if, nothing written" : ""}`];
  lines.push(...formatGates(r.gates));
  const mesh = formatMesh(r.mesh, r.massG);
  if (mesh) lines.push(mesh);
  const analysis = formatAnalysis(r.analysis);
  if (analysis) lines.push(analysis);
  if (r.params.length > 0) lines.push(`Params: ${r.params.map((p) => `${p.name}=${formatValue(p.value)}`).join(", ")}`);
  lines.push(`Revision ${r.revisionId}`);
  const next = r.next[0];
  if (next) lines.push(`Next: ${next}`);
  return lines.join("\n");
}

export function summarizePartReport(r: PartReport): string {
  const failing = r.gates.filter((g) => g.status === "fail").map((g) => g.label);
  return `${r.part}: ${r.status} ${r.passed}/${r.total}${failing.length > 0 ? `, failing ${failing.join(", ")}` : ""}${r.whatIf ? " (what-if)" : ""}`;
}

export function formatAssemblyReport(r: AssemblyReport): string {
  const lines = [`Assembly "${r.spec.title}": ${r.status.toUpperCase()} (${r.passed}/${r.total} gates)`];
  lines.push(...formatGates(r.gates));
  if (r.instances.length > 0) lines.push(`Instances: ${r.instances.map((i) => `${i.id}=${i.part} (${i.partStatus})`).join(", ")}`);
  if (r.pairs.length > 0) lines.push("Pairs:", ...r.pairs.map((p) => `- ${p.a}/${p.b}: gap ${num(p.gapMm)} mm, overlap ${num(p.overlapCm3 * 1000)} mm³`));
  if (r.bom.length > 0) lines.push(`BOM: ${r.bom.map((b) => `${b.count}× ${b.part} (${b.source}${b.massG !== null ? `, ${num(b.massG, 1)} g` : ""})`).join(", ")}`);
  if (r.totalPrintedMassG !== null) lines.push(`Printed mass: ${num(r.totalPrintedMassG, 1)} g`);
  const next = r.next[0];
  if (next) lines.push(`Next: ${next}`);
  return lines.join("\n");
}

export function summarizeAssemblyReport(r: AssemblyReport): string {
  const failing = r.gates.filter((g) => g.status === "fail").map((g) => g.label);
  return `assembly: ${r.status} ${r.passed}/${r.total}${failing.length > 0 ? `, failing ${failing.join(", ")}` : ""}`;
}

function partLine(p: PartSummary): string {
  const failing = p.failing.length > 0 ? `, failing: ${p.failing.join(", ")}` : "";
  const model = p.model ? "" : ", no model yet";
  return `- ${p.id} "${p.title}" (${p.class || "unclassified"}, ${p.source}, ${p.material}, ${p.strictness}): ${p.status} ${p.passed}/${p.total}${failing}${model}${p.evaluating ? ", evaluating" : ""}`;
}

export function formatOverview(o: ProjectOverview): string {
  const p = o.project;
  const lines = [
    `Project ${p.slug}: "${p.title}" — overall ${p.status.overall} (parts ${p.status.parts}: ${p.status.passed} passed, ${p.status.draft} draft, ${p.status.failed} failed, ${p.status.pending} pending)`,
    `Defaults: material ${p.defaults.material}, strictness ${p.defaults.strictness}`,
  ];
  if (p.description) lines.push(`Description: ${p.description}`);
  lines.push("", "## Brief", o.brief.trim() ? truncate(o.brief.trim(), 4000) : "(none)");
  lines.push("", "## Project memory (AGENTS.md)", o.memory.trim() ? truncate(o.memory.trim(), 4000) : "(empty)");
  lines.push("", "## Parts", ...(o.parts.length > 0 ? o.parts.map(partLine) : ["(none)"]));
  lines.push(
    "",
    "## Assembly",
    o.assembly ? `${o.assembly.status}, ${o.assembly.instances} instance(s)${o.assembly.failing.length > 0 ? `, failing: ${o.assembly.failing.join(", ")}` : ""}` : "(none)",
  );
  lines.push("", "## References", ...(o.references.length > 0 ? o.references.map((r) => `- ${r}`) : ["(none)"]));
  lines.push("", "## Notes", ...(o.notes.length > 0 ? o.notes.map((n) => `- ${n}`) : ["(none)"]));
  const pr = o.library.profile.printer;
  lines.push(
    "",
    "## Library",
    `Printer ${pr.name}: bed ${pr.bed.join(" × ")} mm, nozzle ${pr.nozzleMm} mm, layer ${pr.layerMm} mm, min wall ${pr.minWallMm} mm, max overhang ${pr.maxOverhangDeg}° (${pr.maxOverhangAreaMm2} mm² tolerated), clearance sliding ${pr.clearance.sliding} / press ${pr.clearance.press} mm`,
    `Materials: ${o.library.profile.materials.map((m) => `${m.name} (${m.densityGCm3} g/cm³${m.minWallMm !== null ? `, min wall ${m.minWallMm}` : ""})`).join(", ") || "(none)"}`,
    `Library notes: ${o.library.notes.join(", ") || "(none)"}`,
    `Library parts: ${o.library.parts.map((lp) => `_library/${lp.id} (${lp.title})`).join(", ") || "(none)"}`,
  );
  return lines.join("\n");
}

export function formatAttempts(attempts: Attempt[]): string {
  if (attempts.length === 0) return "No attempts yet.";
  return attempts
    .map((a) => {
      const status = a.status === null ? "not evaluated" : `${a.status} ${a.passed ?? "?"}/${a.total ?? "?"}`;
      return `- ${a.revisionId}${a.current ? " (current)" : ""} parent ${a.parent ?? "none"}, ${a.date}, ${a.author}: ${status} — ${a.message}`;
    })
    .join("\n");
}

const point = (v: Vec3): string => vec(v);

/** A person's reference to something in the viewer, as plain text for the agent. */
export function formatRef(ref: SessionRef): string {
  if (ref.kind === "part") return `[points at part ${ref.part}]`;
  if (ref.kind === "file") return `[points at file ${ref.path}]`;
  const normal = ref.normal ? `, face normal ${point(ref.normal)}` : "";
  return `[points at part ${ref.part}, position ${point(ref.position)}${normal}]`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** An attachment as one line for the agent; `shown` when its image follows the message. */
export function formatAttachment(a: SessionAttachment, shown: boolean): string {
  const where = a.filedAs ? `, filed as ${a.filedAs}` : ", not filed yet";
  const image = shown ? ", shown below" : "";
  return `[attached ${a.id}: "${a.name}", ${a.kind}, ${a.mediaType.split(";")[0]}, ${size(a.size)}${where}${image}]`;
}
