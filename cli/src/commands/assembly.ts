import type { AssemblySpec } from "@drawer/shared/api";
import { UsageError } from "../args.ts";
import type { Command } from "../command.ts";
import { CliError } from "../command.ts";
import { emit } from "../output.ts";
import { fetchPictures } from "../pictures.ts";
import { type LocalAssemblyReport, assemblyReportText } from "../report.ts";

async function readAssemblyFile(path: string): Promise<AssemblySpec> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new CliError(`--set: no such local file ${path}`);
  let value: unknown;
  try {
    value = await file.json();
  } catch {
    throw new CliError(`--set: ${path} is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CliError(`--set: ${path} must hold one JSON object (an AssemblySpec)`);
  return value as AssemblySpec;
}

export const assembly: Command = {
  name: "assembly",
  usage: ["drawer assembly <project> [--set file.json]"],
  summary: "the assembly report: clashes, mates, floating parts, bill of materials; --set replaces assembly.json first",
  details:
    "The assembly places copies of parts (instances: part id, rotate, translate) and states how they must meet (mates:\n" +
    "clearance, contact, press). --set reads an AssemblySpec from a local JSON file, writes it, and prints the report.\n" +
    "Without --set it prints the current report (exit 3 when the project has no assembly). Pictures as for `report`.",
  flags: { string: ["set"] },
  async run(ctx, args) {
    const [project, ...extra] = args.positionals;
    if (!project || extra.length > 0) throw new UsageError("usage: drawer assembly <project> [--set file.json]");
    const specFile = args.str("set");
    const spec = specFile === undefined ? null : await readAssemblyFile(specFile);
    const client = await ctx.client();
    const raw = spec === null ? await client.assembly(project) : await client.putAssembly(project, spec);
    const pictures = raw.render ? await fetchPictures(client, ctx.env, { sheet: raw.render.sheet, views: raw.render.views }) : null;
    const out: LocalAssemblyReport = { ...raw, pictures };
    emit(ctx.mode, out, () => assemblyReportText(out));
  },
};
