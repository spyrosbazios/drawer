/** Hand-rolled argument parsing. Flags take their value from the next token even when it starts with "-". */

export class UsageError extends Error {}

export interface FlagSpec {
  /** Flags that take one value, e.g. "rev". Long name without dashes. */
  string?: readonly string[];
  /** Flags that take one value and may repeat, e.g. "param". */
  list?: readonly string[];
  /** Flags without a value. */
  boolean?: readonly string[];
  /** Single-letter or alternative names, mapped to long names: { m: "message", o: "output" }. */
  alias?: Readonly<Record<string, string>>;
}

/** Flags every command accepts. */
const GLOBAL_BOOLEAN = ["json", "text", "help"];
const GLOBAL_ALIAS: Record<string, string> = { h: "help" };

export class Parsed {
  constructor(
    readonly positionals: string[],
    private readonly values: Map<string, string[]>,
    private readonly flags: Set<string>,
  ) {}

  str(name: string): string | undefined {
    const all = this.values.get(name);
    return all?.[all.length - 1];
  }

  list(name: string): string[] {
    return this.values.get(name) ?? [];
  }

  bool(name: string): boolean {
    return this.flags.has(name);
  }

  /** Integer flag; throws UsageError on garbage. */
  int(name: string): number | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} expects a whole number, got "${raw}"`);
    return Number(raw);
  }

  /** Decimal number flag (negative and fractional allowed); throws UsageError on garbage. */
  num(name: string): number | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) throw new UsageError(`--${name} expects a number, got "${raw}"`);
    return value;
  }
}

export function parseArgs(argv: readonly string[], spec: FlagSpec = {}): Parsed {
  const stringFlags = new Set([...(spec.string ?? []), ...(spec.list ?? [])]);
  const boolFlags = new Set([...(spec.boolean ?? []), ...GLOBAL_BOOLEAN]);
  const alias = { ...GLOBAL_ALIAS, ...(spec.alias ?? {}) };
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  const push = (name: string, value: string) => {
    const existing = values.get(name);
    if (existing) existing.push(value);
    else values.set(name, [value]);
  };

  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (onlyPositionals || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }

    let name: string;
    let inline: string | undefined;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inline = eq === -1 ? undefined : token.slice(eq + 1);
    } else {
      name = token.slice(1);
      if (name.length !== 1) throw new UsageError(`unknown option ${token}`);
    }
    name = alias[name] ?? name;

    if (boolFlags.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags.add(name);
    } else if (stringFlags.has(name)) {
      let value = inline;
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
        i += 1;
        value = argv[i] as string;
      }
      push(name, value);
    } else {
      throw new UsageError(`unknown option ${token}`);
    }
  }
  return new Parsed(positionals, values, flags);
}

/** Split `<project>/<path>` into its parts. */
export function parseFileArg(arg: string | undefined): { project: string; path: string } {
  if (!arg) throw new UsageError("missing file argument, expected <project>/<path>");
  const clean = arg.replace(/^\.\//, "");
  const slash = clean.indexOf("/");
  const project = slash === -1 ? "" : clean.slice(0, slash);
  const path = slash === -1 ? "" : clean.slice(slash + 1);
  if (!project || !path) throw new UsageError(`"${arg}" is not <project>/<path>`);
  return { project, path };
}
