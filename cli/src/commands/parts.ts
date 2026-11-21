import { PART_SOURCES } from "@drawer/shared/api";
import type { Attempt, LibraryProfile, PartSpecBody, ProjectOverview, Strictness } from "@drawer/shared/api";
import { UsageError } from "../args.ts";
import { ApiFailure } from "../client.ts";
import type { Command } from "../command.ts";
import { CliError } from "../command.ts";
import { finishWrite, localPartReport } from "../feedback.ts";
import { emit, num, oneLine } from "../output.ts";
import { type LocalPartReport, partLine, partReportText } from "../report.ts";
import { parseAssignments, parsePartArg, partModelPath, partSpecPath } from "../values.ts";

const STRICTNESS: readonly Strictness[] = ["quick", "standard", "functional"];

// ---- guide ------------------------------------------------------------------------------------

export const guide: Command = {
  name: "guide",
  usage: ["drawer guide"],
  summary: "the modelling guide the server gives every agent (read it first, then follow it)",
  details: "Markdown on stdout (a JSON document `{guide}` with --json). It is the one place the method is written down.",
  textDefault: true,
  async run(ctx) {
    const client = await ctx.client();
    const text = await client.guide();
    emit(ctx.mode, { guide: text }, () => text);
  },
};

// ---- overview, parts ----------------------------------------------------------------------------

function profileText(profile: LibraryProfile): string[] {
  const p = profile.printer;
  const lines = [
    `printer: ${oneLine(p.name)}${profile.printerIsExample ? " (the starter's example: the library is not set up)" : ""}  bed ${p.bed.map(num).join(" x ")} mm  nozzle ${num(p.nozzleMm)}  layer ${num(p.layerMm)}  min wall ${num(p.minWallMm)} mm`,
    `  overhang up to ${num(p.maxOverhangDeg)} deg, ${num(p.maxOverhangAreaMm2)} mm2 tolerated  clearance sliding ${num(p.clearance.sliding)} press ${num(p.clearance.press)} mm per side`,
  ];
  for (const m of profile.materials) {
    const wall = m.minWallMm === null ? "" : `, min wall ${num(m.minWallMm)} mm`;
    lines.push(`material: ${m.name}  ${num(m.densityGCm3)} g/cm3${wall}${m.notes ? `  ${oneLine(m.notes)}` : ""}`);
  }
  return lines;
}

function section(title: string, body: string): string[] {
  return ["", `== ${title}`, body.trim() === "" ? "(empty)" : body.trimEnd()];
}

function overviewText(o: ProjectOverview): string {
  const { project: p } = o;
  const s = p.status;
  const lines = [
    `${p.slug}  ${oneLine(p.title)}`,
    `status ${s.overall}: ${s.parts} parts (${s.passed} passed, ${s.draft} draft, ${s.failed} failed, ${s.pending} pending), assembly ${s.assembly}`,
    `new parts default to ${p.defaults.material}, ${p.defaults.strictness}`,
  ];
  lines.push(...section("brief (brief.md)", o.brief));
  lines.push(...section("project memory (AGENTS.md)", o.memory));
  lines.push("", "== parts");
  lines.push(...(o.parts.length === 0 ? ["(none)"] : o.parts.map((part) => partLine(part))));
  if (o.assembly) {
    const failing = o.assembly.failing.length > 0 ? `  failing: ${o.assembly.failing.join("; ")}` : "";
    lines.push(`assembly: ${o.assembly.status}, ${o.assembly.instances} instances${failing}`);
  } else lines.push("assembly: none");
  if (o.references.length > 0) lines.push("", `references: ${o.references.join(", ")}`);
  if (o.notes.length > 0) lines.push(`notes: ${o.notes.join(", ")}`);
  lines.push("", "== library");
  lines.push(...profileText(o.library.profile));
  if (o.library.notes.length > 0) lines.push(`notes: ${o.library.notes.join(", ")}`);
  if (o.library.parts.length > 0) lines.push("parts (use as _library/<id>):", ...o.library.parts.map((part) => `  ${partLine(part)}`));
  return lines.join("\n");
}

export const overview: Command = {
  name: "overview",
  usage: ["drawer overview <project>"],
  summary: "what to read first: brief, project memory, parts with status, printer, materials, library",
  details: "Read the files it lists (`drawer cat`) before modelling. Use --text for the readable form.",
  async run(ctx, args) {
    const [project, ...extra] = args.positionals;
    if (!project || extra.length > 0) throw new UsageError("usage: drawer overview <project>");
    const client = await ctx.client();
    const result = await client.overview(project);
    emit(ctx.mode, result, () => overviewText(result));
  },
};

export const parts: Command = {
  name: "parts",
  usage: ["drawer parts <project>"],
  summary: "the parts of a project with their status and failing gates",
  async run(ctx, args) {
    const [project, ...extra] = args.positionals;
    if (!project || extra.length > 0) throw new UsageError("usage: drawer parts <project>");
    const client = await ctx.client();
    const result = await client.listParts(project);
    emit(ctx.mode, result, () => (result.parts.length === 0 ? "no parts" : result.parts.map((p) => partLine(p)).join("\n")));
  },
};

// ---- part -------------------------------------------------------------------------------------

async function readSpecFile(path: string): Promise<Partial<PartSpecBody>> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new CliError(`--spec: no such local file ${path}`);
  let value: unknown;
  try {
    value = await file.json();
  } catch {
    throw new CliError(`--spec: ${path} is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CliError(`--spec: ${path} must hold one JSON object (a PartSpecBody)`);
  return value as Partial<PartSpecBody>;
}

export const part: Command = {
  name: "part",
  usage: [
    "drawer part <project>/<id> [--title t] [--class c] [--material m] [--strictness s]",
    "            [--source printed|bought|scanned] [--description d] [--spec file.json]",
  ],
  summary: "create a part or change its spec",
  details:
    "The spec says what must be true of the model: dimensions with tolerances, material, strictness. --spec reads a\n" +
    "PartSpecBody from a local JSON file (title, class, description, source, material, strictness, dimensions); flags\n" +
    "override it. Without --spec the flags change the part's existing spec, so --title is only needed to create one.\n" +
    "Waivers are a person's decision and cannot be set here. Then write the model: parts/<id>.scad.",
  flags: { string: ["title", "class", "material", "strictness", "source", "description", "spec"] },
  async run(ctx, args) {
    const { project, id } = parsePartArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("part takes one <project>/<id> argument");
    const strictness = args.str("strictness");
    if (strictness !== undefined && !STRICTNESS.includes(strictness as Strictness)) throw new UsageError(`--strictness must be one of ${STRICTNESS.join(", ")}`);
    const requested = args.str("source");
    const source = PART_SOURCES.find((value) => value === requested);
    if (requested !== undefined && source === undefined) throw new UsageError("--source must be printed, bought or scanned");
    const flags: Partial<PartSpecBody> = {};
    const title = args.str("title");
    if (title !== undefined) flags.title = title;
    const cls = args.str("class");
    if (cls !== undefined) flags.class = cls;
    const description = args.str("description");
    if (description !== undefined) flags.description = description;
    const material = args.str("material");
    if (material !== undefined) flags.material = material;
    if (strictness !== undefined) flags.strictness = strictness as Strictness;
    if (source !== undefined) flags.source = source;
    const specFile = args.str("spec");
    if (specFile === undefined && Object.keys(flags).length === 0) throw new UsageError("nothing to set: give --spec or at least one of --title, --class, --description, --material, --strictness, --source");

    const client = await ctx.client();
    let base: Partial<PartSpecBody> = {};
    if (specFile !== undefined) base = await readSpecFile(specFile);
    else {
      try {
        const existing = await client.readFile(project, partSpecPath(id));
        const { waivers: _waivers, prints: _prints, ...editable } = JSON.parse(new TextDecoder().decode(existing.bytes)) as Partial<PartSpecBody> & { waivers?: unknown; prints?: unknown };
        base = editable;
      } catch (error) {
        if (!(error instanceof ApiFailure && error.code === "not_found")) throw error;
      }
    }
    const body = { ...base, ...flags };
    if (source && source !== "scanned") delete body.scan;
    if (source && source !== "printed") delete body.matches;
    if (typeof body.title !== "string" || body.title === "") throw new UsageError("--title is needed to create a part (or a \"title\" in --spec)");
    const summary = await client.putPart(project, id, { ...body, title: body.title });
    emit(ctx.mode, summary, () => `${project}/${partLine(summary)}`);
  },
};

// ---- report, set ------------------------------------------------------------------------------

export const report: Command = {
  name: "report",
  usage: ["drawer report <project>/<id> [--param name=value]... [--at <rev-id>]", "            [--require-passed]"],
  summary: "the server's verdict on a part: gates, what to do next, pictures",
  details:
    "Waits for a running evaluation. Prints the status (`draft 6/7`), one line per gate with failing gates first and\n" +
    "their hint, the next steps, and the local paths of the pictures (open the sheet with your image Read tool).\n" +
    "--json is the raw report plus `pictures` (local paths). Exit 0 whatever the status: the report is the output;\n" +
    "--require-passed exits 1 unless the status is `passed`.\n" +
    "--param evaluates the model with those top-level values overridden (a what-if: nothing is written, the part's\n" +
    "status is unchanged); values are numbers, true/false, [1,2,3] vectors, or strings (quote a numeric string).\n" +
    "--at evaluates the part as of a past revision (ids from `drawer history`).",
  flags: { list: ["param"], string: ["at"], boolean: ["require-passed"] },
  async run(ctx, args) {
    const { project, id } = parsePartArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("report takes one <project>/<id> argument");
    ctx.subject = `${project}/${partModelPath(id)}`;
    const params = parseAssignments(args.list("param"));
    const at = args.str("at");
    const client = await ctx.client();
    const raw = Object.keys(params).length > 0 || at !== undefined ? await client.evaluatePart(project, id, { at, params: Object.keys(params).length > 0 ? params : undefined }) : await client.partReport(project, id);
    const result = await localPartReport(client, ctx.env, raw);
    emit(ctx.mode, result, () => partReportText(result));
    if (args.bool("require-passed") && result.status !== "passed") throw new CliError(`${project}/${id} is ${result.status} ${result.passed}/${result.total}, not passed`);
  },
};

export const set: Command = {
  name: "set",
  usage: ["drawer set <project>/<id> name=value... [-m msg] [--no-report]"],
  summary: "write parameter values into the model's parameter block",
  details:
    "One revision; the model must declare each name as a top-level parameter. Values as for `report --param`.\n" +
    "Prints the .scad check and the part's report, like `write`; --no-report skips the wait.",
  flags: { string: ["message"], boolean: ["no-report"], alias: { m: "message" } },
  async run(ctx, args) {
    const [partArg, ...assignments] = args.positionals;
    const { project, id } = parsePartArg(partArg);
    if (assignments.length === 0) throw new UsageError("usage: drawer set <project>/<id> name=value...");
    const values = parseAssignments(assignments);
    const modelPath = partModelPath(id);
    ctx.subject = `${project}/${modelPath}`;
    const client = await ctx.client();
    const model = await client.readFile(project, modelPath);
    if (model.rev === null) throw new CliError("the server sent no rev for the model");
    const result = await client.setParams(project, id, { rev: model.rev, values, message: args.str("message") });
    await finishWrite(ctx, client, result, { verb: "set parameters in", noReport: args.bool("no-report") });
  },
};

// ---- attempts, restore, printed -----------------------------------------------------------------

function attemptLine(a: Attempt, depth: number): string {
  const verdict = a.status === null ? "not evaluated" : `${a.status} ${a.passed ?? 0}/${a.total ?? 0}`;
  return `${a.current ? "*" : " "} ${"  ".repeat(depth)}${a.revisionId}  ${verdict}  ${a.author}  ${a.date}  ${oneLine(a.message)}`;
}

/** Children under their parent, indented one level each; an attempt whose parent is not listed is a root. */
function attemptsText(attempts: readonly Attempt[]): string {
  const ids = new Set(attempts.map((a) => a.revisionId));
  const children = new Map<string | null, Attempt[]>();
  for (const a of attempts) {
    const key = a.parent !== null && ids.has(a.parent) ? a.parent : null;
    children.set(key, [...(children.get(key) ?? []), a]);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of children.get(parent) ?? []) {
      lines.push(attemptLine(a, depth));
      walk(a.revisionId, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

export const attempts: Command = {
  name: "attempts",
  usage: ["drawer attempts <project>/<id>"],
  summary: "the part's attempt tree (every model write is one); * marks the current attempt",
  details: "Children are indented under the attempt they were made from. `drawer restore` goes back to one; `drawer compare` shows what differs.",
  async run(ctx, args) {
    const { project, id } = parsePartArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("attempts takes one <project>/<id> argument");
    const client = await ctx.client();
    const result = await client.attempts(project, id);
    emit(ctx.mode, result, () => (result.attempts.length === 0 ? "no attempts" : attemptsText(result.attempts)));
  },
};

export const restore: Command = {
  name: "restore",
  usage: ["drawer restore <project>/<id> <rev-id> [--no-report]"],
  summary: "make an old attempt's model current again",
  details: "Not a new attempt: the next model write becomes a child of the restored one. Prints the part's report like `write`.",
  flags: { boolean: ["no-report"] },
  async run(ctx, args) {
    const { project, id } = parsePartArg(args.positionals[0]);
    const revisionId = args.positionals[1];
    if (!revisionId || args.positionals.length > 2) throw new UsageError("usage: drawer restore <project>/<id> <rev-id>");
    ctx.subject = `${project}/${partModelPath(id)}`;
    const client = await ctx.client();
    const result = await client.restore(project, id, { revisionId });
    await finishWrite(ctx, client, result, { verb: "restored", noReport: args.bool("no-report") });
  },
};

export const printed: Command = {
  name: "printed",
  usage: ['drawer printed <project>/<id> ok|issue "<note>"'],
  summary: "record how a print of the part's current revision turned out",
  details: "ok: it printed and fit. issue: it did not; the note says what went wrong. Then add what you learned to the project notes.",
  async run(ctx, args) {
    const [partArg, outcome, ...words] = args.positionals;
    const { project, id } = parsePartArg(partArg);
    if (outcome !== "ok" && outcome !== "issue") throw new UsageError('usage: drawer printed <project>/<id> ok|issue "<note>"');
    const note = oneLine(words.join(" "));
    if (outcome === "issue" && note === "") throw new UsageError("an issue needs a note saying what went wrong");
    const client = await ctx.client();
    const summary = await client.recordPrint(project, id, { outcome, note });
    emit(ctx.mode, summary, () => `recorded print ${outcome} for ${project}/${partLine(summary)}`);
  },
};
