import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI = join(import.meta.dir, "..", "drawer.ts");

export interface RunResult {
  code: number;
  stdout: Uint8Array;
  out: string;
  err: string;
  json<T = unknown>(): T;
}

export interface Sandbox {
  home: string;
  state: string;
  cache: string;
  /** Run `bun cli/drawer.ts ...args` with stdout piped (so not a TTY). */
  run(args: string[], opts?: { stdin?: string | Uint8Array; env?: Record<string, string | undefined> }): Promise<RunResult>;
  dispose(): void;
}

/** A temp HOME with its own XDG dirs; DRAWER_URL points at `url` unless the test overrides it. */
export function sandbox(url: string | undefined): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "drawer-cli-test-"));
  const state = join(home, "state");
  const cache = join(home, "cache");
  return {
    home,
    state,
    cache,
    async run(args, opts = {}) {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_STATE_HOME: state,
        XDG_CACHE_HOME: cache,
      };
      if (url !== undefined) env.DRAWER_URL = url;
      for (const [key, value] of Object.entries(opts.env ?? {})) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      const proc = Bun.spawn([process.execPath, CLI, ...args], {
        cwd: home,
        env,
        stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
      const bytes = new Uint8Array(stdout);
      const out = new TextDecoder().decode(bytes);
      return { code, stdout: bytes, out, err, json: <T>() => JSON.parse(out) as T };
    },
    dispose() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
