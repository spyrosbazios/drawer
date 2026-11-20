import type { Axis, CompareResult, CompareSide, MeasureResult, ProbeResult, SliceContour, SliceResult } from "@drawer/shared/api";
import { UsageError, parseFileArg } from "../args.ts";
import type { Command } from "../command.ts";
import { emit, formatMesh, num } from "../output.ts";
import { type Pictures, fetchPicture, fetchPictures, pictureLines } from "../pictures.ts";
import { PART_ID, parseAssignments, parseAxis, parseVec3 } from "../values.ts";

const AXES: readonly Axis[] = ["x", "y", "z"];

// ---- measure ----------------------------------------------------------------------------------

type LocalMeasure = MeasureResult & { pictures: Pictures };

function measureText(r: LocalMeasure): string {
  const a = r.analysis;
  const lines = [
    `${r.project}/${r.path}`,
    formatMesh(r.mesh),
    `shells ${a.shells}, ${a.watertight ? "watertight" : "not watertight"}, surface ${num(a.surfaceAreaMm2)} mm2`,
    `base ${num(a.baseAreaMm2)} mm2 of a ${num(a.footprintMm2)} mm2 footprint`,
    `overhang ${num(a.overhang.areaMm2)} mm2 steeper than ${num(a.overhang.angle)} deg${a.overhang.at ? ` (largest region at ${a.overhang.at.map(num).join(", ")})` : ""}`,
    a.wall ? `thinnest wall ${num(a.wall.minMm)} mm at ${a.wall.at.map(num).join(", ")}` : "thinnest wall unknown (mesh is not closed)",
    "pictures:",
    ...pictureLines(r.pictures).map((l) => `  ${l}`),
  ];
  return lines.join("\n");
}

export const measure: Command = {
  name: "measure",
  usage: ["drawer measure <project>/<path> [--param name=value]... [--at <rev-id>]"],
  summary: "mesh info and analysis of any .scad or mesh file: shells, base, overhang, thinnest wall",
  details:
    "Works on a part's model, a reference, a library part. Downloads the render like `drawer render` and prints the\n" +
    "local paths. --param overrides top-level values for this measurement only; --at measures a past revision.",
  flags: { list: ["param"], string: ["at"] },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("measure takes one file argument");
    ctx.subject = args.positionals[0];
    const params = parseAssignments(args.list("param"));
    const client = await ctx.client();
    const result = await client.measure(file.project, file.path, { revision: args.str("at"), params: Object.keys(params).length > 0 ? params : undefined });
    const out: LocalMeasure = { ...result, pictures: await fetchPictures(client, ctx.env, result.render) };
    emit(ctx.mode, out, () => measureText(out));
  },
};

// ---- slice ------------------------------------------------------------------------------------

function contourLine(c: SliceContour, index: number): string {
  const circle = c.circle;
  const shape = circle.round ? `round, diameter ${num(circle.diameter)} mm` : `not round (best-fit circle ${num(circle.diameter)} mm, rms ${num(circle.rms)})`;
  const size = [c.bbox.max[0] - c.bbox.min[0], c.bbox.max[1] - c.bbox.min[1]].map(num).join(" x ");
  return `${index + 1}. ${c.hole ? "hole" : "material"}  area ${num(c.areaMm2)} mm2  centre (${c.centre.map(num).join(", ")})  size ${size} mm  ${shape}`;
}

function sliceText(r: SliceResult): string {
  const [u, v] = AXES.filter((a) => a !== r.axis);
  const lines = [`slice ${r.axis} = ${num(r.at)}: ${r.contours.length} outlines, coordinates are (${u}, ${v})`];
  lines.push(...r.contours.map(contourLine));
  return lines.join("\n");
}

export const slice: Command = {
  name: "slice",
  usage: ["drawer slice <project>/<path> --axis z --at 5"],
  summary: "cross-section outlines at a plane: area, centre, size and best-fit circle of each",
  details: "Use it to find where a feature really is before changing a spec point, and to read a hole's true diameter. `--json` includes the outline points.",
  flags: { string: ["axis", "at"] },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("slice takes one file argument");
    const axis = parseAxis(args.str("axis"));
    const at = args.num("at");
    if (at === undefined) throw new UsageError("slice needs --at <position along the axis, mm>");
    ctx.subject = args.positionals[0];
    const client = await ctx.client();
    const result = await client.slice(file.project, file.path, { axis, at });
    emit(ctx.mode, result, () => sliceText(result));
  },
};

// ---- probe ------------------------------------------------------------------------------------

function probeText(r: ProbeResult, axis: Axis): string {
  const what = r.inside ? "inside material" : "in air";
  if (r.distance === null) return `${what}; the run along ${axis} is unbounded (it reaches outside the part)`;
  return `${what}; the run along ${axis} is ${num(r.distance)} mm, from ${num(r.low ?? 0)} to ${num(r.high ?? 0)}`;
}

export const probe: Command = {
  name: "probe",
  usage: ["drawer probe <project>/<path> --from x,y,z --axis x"],
  summary: "is a point inside material, and how long is the run of material or air through it",
  details: "The same measurement a `gap` or `wall` dimension makes: a ray through the point along the axis, both directions.",
  flags: { string: ["from", "axis"] },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("probe takes one file argument");
    const from = parseVec3(args.str("from"), "from");
    const axis = parseAxis(args.str("axis"));
    ctx.subject = args.positionals[0];
    const client = await ctx.client();
    const result = await client.probe(file.project, file.path, { from, axis });
    emit(ctx.mode, result, () => probeText(result, axis));
  },
};

// ---- section ----------------------------------------------------------------------------------

export const section: Command = {
  name: "section",
  usage: ["drawer section <project>/<path> --axis x --at 0 [--size 800]"],
  summary: "a PNG of the part cut at a plane (lower side kept); downloads it and prints the local path",
  details: "Open the PNG with your image Read tool. Use it to see inside: wall thickness, a bore that stops short, a hidden void.",
  flags: { string: ["axis", "at", "size"] },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("section takes one file argument");
    const axis = parseAxis(args.str("axis"));
    const at = args.num("at");
    if (at === undefined) throw new UsageError("section needs --at <position along the axis, mm>");
    ctx.subject = args.positionals[0];
    const client = await ctx.client();
    const result = await client.section(file.project, file.path, { axis, at, size: args.int("size") });
    const image = await fetchPicture(client, ctx.env, result.image);
    const out = { axis: result.axis, at: result.at, image };
    emit(ctx.mode, out, () => `section ${out.axis} = ${num(out.at)}\n${image}`);
  },
};

// ---- compare ----------------------------------------------------------------------------------

/** A part id (`lid`) or a file path (`refs/original.stl`), optionally `@<rev-id>`. */
function parseSide(raw: string | undefined, name: string): CompareSide {
  if (!raw) throw new UsageError(`missing ${name}: a part id or a path, optionally @<rev-id>`);
  const at = raw.lastIndexOf("@");
  const ref = at === -1 ? raw : raw.slice(0, at);
  const rev = at === -1 ? undefined : raw.slice(at + 1);
  if (ref === "" || rev === "") throw new UsageError(`"${raw}" is not <part-or-path>[@<rev-id>]`);
  const side: CompareSide = PART_ID.test(ref) ? { part: ref } : { path: ref };
  if (rev !== undefined) side.at = rev;
  return side;
}

type LocalCompare = CompareResult & { sheets: { a: string; b: string } };

const signed = (n: number) => `${n > 0 ? "+" : ""}${num(n)}`;

function compareText(r: LocalCompare): string {
  const d = r.deviation;
  const lines = [
    `b against a (mm, positive where b has more material): min ${signed(d.min)}, max ${signed(d.max)}, rms ${num(d.rms)}, 95% within ${num(d.p95)}${d.at ? `, largest at (${d.at.map(num).join(", ")}) on b` : ""}`,
    `size delta ${r.sizeDelta.map(signed).join(" x ")} mm${r.volumeDeltaCm3 === null ? "" : `, volume delta ${signed(r.volumeDeltaCm3)} cm3`}`,
    `a  ${formatMesh(r.a.mesh)}`,
    `b  ${formatMesh(r.b.mesh)}`,
    `sheet a  ${r.sheets.a}`,
    `sheet b  ${r.sheets.b}`,
  ];
  return lines.join("\n");
}

export const compare: Command = {
  name: "compare",
  usage: ["drawer compare <project> <a> <b>"],
  summary: "how b differs from a: deviation, volume and size deltas, both sheets",
  details:
    "a and b are each a part id or a project path, optionally @<rev-id> (`lid@r12`, `refs/original.stl`). Use it to see exactly\n" +
    "what a change did, or how a model deviates from a reference. Prints the local paths of both sheets.",
  async run(ctx, args) {
    const [project, a, b, ...extra] = args.positionals;
    if (!project || extra.length > 0) throw new UsageError("usage: drawer compare <project> <a> <b>");
    const sides = { a: parseSide(a, "a"), b: parseSide(b, "b") };
    const client = await ctx.client();
    const result = await client.compare(project, sides);
    const out: LocalCompare = {
      ...result,
      sheets: { a: await fetchPicture(client, ctx.env, result.a.render.sheet), b: await fetchPicture(client, ctx.env, result.b.render.sheet) },
    };
    emit(ctx.mode, out, () => compareText(out));
  },
};
