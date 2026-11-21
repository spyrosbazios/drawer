import { UsageError, parseArgs } from "./args.ts";
import { ApiFailure, Client } from "./client.ts";
import type { Command, Ctx } from "./command.ts";
import { CliError, EXIT_CONFLICT, EXIT_ERROR, EXIT_NOT_FOUND } from "./command.ts";
import { assembly } from "./commands/assembly.ts";
import { cat, edit, get, history, info, ls, mv, rm, write } from "./commands/files.ts";
import { compare, measure, probe, section, slice } from "./commands/measure.ts";
import { note } from "./commands/note.ts";
import { attempts, guide, overview, part, parts, printed, report, restore, set } from "./commands/parts.ts";
import { importCmd, newProject, preview, projects, reindex } from "./commands/projects.ts";
import { render } from "./commands/render.ts";
import { scan } from "./commands/scan.ts";
import { context, search } from "./commands/search.ts";
import { health, server } from "./commands/server.ts";
import { answer, ask, attachment, attachments, fileAttachment, say, session, sessions } from "./commands/sessions.ts";
import { agents } from "./commands/sessions.ts";
import { author, resolveServerUrl, type Env } from "./config.ts";
import { commandHelp, usageOverview } from "./help.ts";
import { resolveMode, writeErr, writeOut } from "./output.ts";

/** In the order of docs/SPEC.md "CLI", then the additions. */
export const COMMANDS: readonly Command[] = [
  server,
  projects,
  newProject,
  ls,
  cat,
  info,
  write,
  edit,
  rm,
  mv,
  get,
  render,
  search,
  context,
  history,
  note,
  importCmd,
  scan,
  reindex,
  guide,
  overview,
  parts,
  part,
  report,
  set,
  measure,
  slice,
  probe,
  section,
  attempts,
  restore,
  compare,
  assembly,
  printed,
  sessions,
  session,
  ask,
  say,
  answer,
  attachments,
  attachment,
  fileAttachment,
  agents,
  health,
  preview,
];

function describeFailure(error: ApiFailure, subject: string | undefined): CliError {
  const file = subject ?? "<file>";
  switch (error.code) {
    case "not_found":
      return new CliError(`not found: ${error.message}`, EXIT_NOT_FOUND);
    case "conflict": {
      const rev = error.rev ? ` Current rev is ${error.rev}.` : "";
      return new CliError(
        `conflict: ${error.message}${rev} Re-read with \`drawer cat ${file}\` and redo your change from the new text; do not retry blind.`,
        EXIT_CONFLICT,
      );
    }
    case "exists":
      return new CliError(`exists: ${error.message}`, EXIT_CONFLICT);
    case "forbidden":
      return new CliError(
        `forbidden: ${error.message}. Only a person can do this, in the web app (a waiver, for one). Tell the person what is needed and why; do not retry.`,
        EXIT_ERROR,
      );
    case "render_failed":
      return new CliError(`render failed:\n${error.message}`, EXIT_ERROR);
    case "network":
      return new CliError(error.message, EXIT_ERROR);
    default:
      return new CliError(`${error.code}: ${error.message}`, EXIT_ERROR);
  }
}

function fail(error: unknown, command: Command | undefined, subject: string | undefined): number {
  let cli: CliError;
  if (error instanceof CliError) cli = error;
  else if (error instanceof ApiFailure) cli = describeFailure(error, subject);
  else if (error instanceof UsageError) {
    const hint = command ? `usage: ${command.usage[0]}  (drawer help ${command.name})` : "drawer help";
    cli = new CliError(`${error.message}\n${hint}`, EXIT_ERROR);
  } else cli = new CliError(`unexpected error: ${error instanceof Error ? error.message : String(error)}`, EXIT_ERROR);
  writeErr(`drawer: ${cli.message}\n`);
  return cli.exitCode;
}

/** Runs one invocation and returns the exit code. */
export async function main(argv: readonly string[], env: Env): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined) {
    writeErr(usageOverview(COMMANDS));
    return EXIT_ERROR;
  }
  if (first === "--help" || first === "-h") {
    writeOut(usageOverview(COMMANDS));
    return 0;
  }
  if (first === "help") {
    const name = rest[0];
    if (name === undefined) {
      writeOut(usageOverview(COMMANDS));
      return 0;
    }
    const target = COMMANDS.find((c) => c.name === name);
    if (!target) return fail(new CliError(`unknown command "${name}"; run \`drawer help\``), undefined, undefined);
    writeOut(commandHelp(target));
    return 0;
  }

  const command = COMMANDS.find((c) => c.name === first);
  if (!command) return fail(new CliError(`unknown command "${first}"; run \`drawer help\``), undefined, undefined);

  const ctx: Ctx = {
    env,
    mode: { json: false, tty: false },
    async client() {
      const url = await resolveServerUrl(env);
      if (!url) throw new CliError("no server set: run `drawer server <url>` or set DRAWER_URL");
      return new Client(url, author(env));
    },
  };

  try {
    const args = parseArgs(rest, command.flags);
    if (args.bool("help")) {
      writeOut(commandHelp(command));
      return 0;
    }
    const tty = process.stdout.isTTY === true;
    ctx.mode = command.textDefault
      ? { json: args.bool("json") && !args.bool("text"), tty }
      : resolveMode({ json: args.bool("json"), text: args.bool("text") }, tty);
    await command.run(ctx, args);
    return 0;
  } catch (error) {
    return fail(error, command, ctx.subject);
  }
}
