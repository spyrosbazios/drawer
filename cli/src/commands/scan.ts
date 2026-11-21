import { basename } from "node:path";
import { SCAN_UNITS, isMeshFormat } from "@drawer/shared/api";
import { UsageError } from "../args.ts";
import type { Command } from "../command.ts";
import { emit, formatMesh } from "../output.ts";

export const scan: Command = {
  name: "scan",
  usage: ["drawer scan add <project> <file> --name <name> [--units mm|cm|m|in]"],
  summary: "add a scan and normalize it to millimetres",
  details: "Supply original units for STL, OBJ and PLY. A 3MF supplies its own units.",
  flags: { string: ["name", "units"] },
  async run(ctx, args) {
    const [action, project, input, extra] = args.positionals;
    const name = args.str("name");
    if (action !== "add" || !project || !input || extra || !name) throw new UsageError("scan add needs a project, local file and --name");
    const filename = basename(input);
    const format = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    if (!isMeshFormat(format)) throw new UsageError("scan must be an STL, OBJ, 3MF or PLY file");
    const given = args.str("units");
    const units = SCAN_UNITS.find((unit) => unit === given);
    if (given !== undefined && !units) throw new UsageError("--units must be mm, cm, m or in");
    if (!units && format !== "3mf") throw new UsageError("--units is required for STL, OBJ and PLY");
    const bytes = await Bun.file(input).bytes();
    ctx.subject = `${project}/refs/${name}/scan.stl`;
    const client = await ctx.client();
    const result = await client.addScan(project, { name, filename, ...(units ? { units } : {}) }, bytes);
    emit(ctx.mode, result, () => `${result.project}/${result.path}\n${formatMesh(result.mesh)}\nNoise: ${result.noiseMm} mm\nSource: ${result.project}/${result.source}`);
  },
};
