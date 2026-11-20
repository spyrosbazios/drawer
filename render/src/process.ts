/**
 * Running OpenSCAD: spawn in its own process group, kill the whole group on timeout,
 * and turn its stderr into log lines and warnings.
 */
import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
}

/** Spawn errors (command not found) reject; a non-zero exit or a timeout resolves. */
export function run(argv: string[], opts: RunOptions): Promise<RunResult> {
  const [command, ...args] = argv;
  if (!command) return Promise.reject(new Error("empty command"));
  return new Promise((resolve, reject) => {
    // detached: the child leads a new process group, so a timeout can kill it and everything it spawned.
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, Math.max(1, opts.timeoutMs));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

export interface ParsedStderr {
  log: string[];
  warnings: string[];
}

/**
 * ECHO lines go to `log`; WARNING, DEPRECATED and (non-fatal) ERROR lines to `warnings`.
 * TRACE lines, render statistics and driver chatter are dropped.
 */
export function parseStderr(stderr: string): ParsedStderr {
  const log: string[] = [];
  const warnings: string[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("ECHO:")) log.push(line);
    else if (/^(WARNING|DEPRECATED|ERROR):/.test(line)) warnings.push(line);
  }
  return { log, warnings };
}

/** Dependency paths, as written, from a make-style file produced by `openscad -d`. */
export function parseDepsFile(text: string): string[] {
  const joined = text.replace(/\\\r?\n/g, " ");
  const colon = joined.search(/(?<!\\):\s/);
  if (colon < 0) return [];
  const body = joined.slice(colon + 1);
  const deps: string[] = [];
  for (const m of body.matchAll(/(?:\\.|[^\s\\])+/g)) deps.push(m[0].replace(/\\(.)/g, "$1"));
  return deps;
}

export interface ParsedDiagnostic {
  level: "error" | "warning";
  message: string;
  /** As OpenSCAD wrote it (absolute, or relative to the run's working directory); null when it names none. */
  file: string | null;
  line: number | null;
}

/**
 * ERROR and WARNING lines (DEPRECATED counts as a warning), each once, with the file and line
 * OpenSCAD names: `... in file foo.scad, line 12` or `... in file "foo.scad", line 12`.
 */
export function parseDiagnostics(text: string): ParsedDiagnostic[] {
  const out: ParsedDiagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(ERROR|WARNING|DEPRECATED):\s*(.*)$/.exec(line);
    if (!m || seen.has(line)) continue;
    seen.add(line);
    const message = (m[2] ?? "").trim();
    const where = /in file "?([^",]+?)"?,\s*line (\d+)/.exec(message);
    out.push({
      level: m[1] === "ERROR" ? "error" : "warning",
      message,
      file: where?.[1] ?? null,
      line: where?.[2] ? Number(where[2]) : null,
    });
  }
  return out;
}
