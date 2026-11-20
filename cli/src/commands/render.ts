import type { MeshInfo, RenderView } from "@drawer/shared/api";
import { UsageError, parseFileArg } from "../args.ts";
import type { Command } from "../command.ts";
import { emit, formatMesh } from "../output.ts";
import { VIEWS, fetchPictures, pictureLines } from "../pictures.ts";

function parseViews(raw: string | undefined): RenderView[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw.split(",").map((v) => v.trim()).filter(Boolean);
  const bad = names.filter((n) => !VIEWS.includes(n as RenderView));
  if (names.length === 0 || bad.length > 0) throw new UsageError(`--views takes a comma list of ${VIEWS.join(", ")}`);
  return names as RenderView[];
}

export interface LocalRender {
  project: string;
  path: string;
  key: string;
  cached: boolean;
  seconds: number;
  /** Server URL path of the STL (not downloaded). */
  mesh: string;
  /** Absolute local paths. */
  sheet: string;
  views: Partial<Record<RenderView, string>>;
  info: MeshInfo;
  log: string[];
  warnings: string[];
}

function renderText(r: LocalRender): string {
  const lines = pictureLines(r);
  lines.push(`${formatMesh(r.info)}  (${r.cached ? "cached" : `${r.seconds}s`})`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const l of r.log) lines.push(`log: ${l}`);
  return lines.join("\n");
}

export const render: Command = {
  name: "render",
  usage: ["drawer render <project>/<path> [--views iso,front] [--size 800] [--at <revision-id>]"],
  summary: "render a .scad or mesh on the server; download the sheet and views as local PNGs",
  details:
    "Files land in ${XDG_CACHE_HOME:-~/.cache}/drawer/renders/<key>/ (kept, never re-downloaded). Open the sheet\n" +
    "with your image Read tool. Output lists the paths (sheet first), mesh size in mm, volume, triangle count,\n" +
    "warnings and ECHO log lines. A failed render exits 1 with OpenSCAD's message. Views: iso, front, top, side.",
  flags: { string: ["views", "size", "at"] },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("render takes one file argument");
    ctx.subject = args.positionals[0];
    const views = parseViews(args.str("views"));
    const size = args.int("size");
    const client = await ctx.client();

    const result = await client.render(file.project, file.path, { views, size, at: args.str("at") });
    const pictures = await fetchPictures(client, ctx.env, result);
    const out: LocalRender = {
      project: result.project,
      path: result.path,
      key: result.key,
      cached: result.cached,
      seconds: result.seconds,
      mesh: result.mesh,
      sheet: pictures.sheet,
      views: pictures.views,
      info: result.info,
      log: result.log,
      warnings: result.warnings,
    };
    emit(ctx.mode, out, () => renderText(out));
  },
};
