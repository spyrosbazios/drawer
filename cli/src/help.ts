import type { Command } from "./command.ts";

const ENV_HELP = `Environment:
  DRAWER_URL     server base URL (overrides the one saved by \`drawer server <url>\`)
  DRAWER_AUTHOR  author recorded on every write (default: agent)
  XDG_STATE_HOME, XDG_CACHE_HOME   where server.json and the render cache live`;

const GLOBAL_HELP = `Global options:
  --json   print one JSON document (default when stdout is not a terminal)
  --text   print human text even when piped
  -h, --help

Exit codes: 0 ok, 1 error (message on stderr), 2 conflict (re-read, then redo), 3 not found.
A file argument is <project>/<path>; the shared library is the project _library.`;

export function usageOverview(commands: readonly Command[]): string {
  const width = Math.max(...commands.flatMap((c) => c.usage.map((u) => u.length)));
  const rows = commands.flatMap((c) => c.usage.map((u, i) => `  ${u.padEnd(width)}  ${i === 0 ? c.summary : ""}`.trimEnd()));
  return `drawer: agent workspace for 3D parts: specs, models, gates, memory; over HTTP\n\nUsage:\n${rows.join("\n")}\n  ${"drawer help [<command>]".padEnd(width)}  this text, or details for one command\n\n${GLOBAL_HELP}\n\n${ENV_HELP}\n`;
}

export function commandHelp(command: Command): string {
  const usage = command.usage.map((u) => `  ${u}`).join("\n");
  const details = command.details ? `\n${command.details}\n` : "";
  return `${command.summary}\n\nUsage:\n${usage}\n${details}\n${GLOBAL_HELP}\n`;
}
