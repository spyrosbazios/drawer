import type { Command } from "../command.ts";
import { CliError } from "../command.ts";
import { UsageError } from "../args.ts";
import { Client } from "../client.ts";
import { author, normalizeUrl, resolveServerUrl, saveServerUrl } from "../config.ts";
import { emit } from "../output.ts";
import type { Health } from "@drawer/shared/api";

const healthText = (url: string, health: Health) =>
  `${url}  ok  version ${health.version}  openscad ${health.openscad ?? "unavailable"}`;

export const server: Command = {
  name: "server",
  usage: ["drawer server [<url>]"],
  summary: "set and verify the server (no argument: show the current one)",
  details:
    "Checks /api/health before saving the URL to ${XDG_STATE_HOME:-~/.local/state}/drawer/server.json.\n" +
    "DRAWER_URL in the environment overrides the saved value.",
  async run(ctx, args) {
    const [raw, ...extra] = args.positionals;
    if (extra.length > 0) throw new UsageError("server takes at most one URL");
    if (raw === undefined) {
      const url = await resolveServerUrl(ctx.env);
      if (!url) throw new CliError("no server set: run `drawer server <url>` or set DRAWER_URL");
      emit(ctx.mode, { url }, () => url);
      return;
    }
    const url = normalizeUrl(raw);
    const health = await new Client(url, author(ctx.env)).health();
    if (health.ok !== true) throw new CliError(`${url} answered /api/health but did not report ok`);
    const file = await saveServerUrl(ctx.env, url);
    emit(ctx.mode, { url, saved: file, health }, () => `${healthText(url, health)}\nsaved to ${file}`);
  },
};

export const health: Command = {
  name: "health",
  usage: ["drawer health"],
  summary: "show server version and whether OpenSCAD is available",
  async run(ctx) {
    const client = await ctx.client();
    const result = await client.health();
    emit(ctx.mode, result, () => healthText(client.baseUrl, result));
  },
};
