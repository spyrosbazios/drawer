import type { FlagSpec, Parsed } from "./args.ts";
import type { Client } from "./client.ts";
import type { Env } from "./config.ts";
import type { OutputMode } from "./output.ts";

export const EXIT_ERROR = 1;
export const EXIT_CONFLICT = 2;
export const EXIT_NOT_FOUND = 3;

/** A failure with a message for stderr and an exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_ERROR,
  ) {
    super(message);
  }
}

export interface Ctx {
  env: Env;
  mode: OutputMode;
  /** The client for the configured server; throws CliError when none is set. */
  client(): Promise<Client>;
  /** The `<project>/<path>` argument a command works on, used in conflict hints. */
  subject?: string;
}

export interface Command {
  name: string;
  /** One or more usage lines, shown by `drawer help <name>` and in the overview. */
  usage: string[];
  summary: string;
  /** Extra explanation for `drawer help <name>`. */
  details?: string;
  flags?: FlagSpec;
  /** Print text by default even when stdout is not a TTY (JSON only with --json). */
  textDefault?: boolean;
  run(ctx: Ctx, args: Parsed): Promise<void>;
}
