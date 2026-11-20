import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Revision } from "@drawer/shared/api";
import { isoSeconds } from "../util.ts";

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitInfo {
  id: string;
  date: string;
}

/** Git author identity from the free-form Author string of a request. */
export function commitAuthor(author: string): CommitAuthor {
  const name = author.replace(/[<>\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) || "agent";
  const local = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return { name, email: `${local}@drawer.local` };
}

interface RunOptions {
  author?: CommitAuthor;
  date?: string;
  stdin?: string;
  /** Extra environment variables, e.g. GIT_INDEX_FILE. */
  env?: Record<string, string>;
  /** Do not point GIT_DIR at the project (for `git init`). */
  noGitDir?: boolean;
  allowFail?: boolean;
}

interface RunResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

export class GitError extends Error {
  override name = "GitError";
}

const CONFIG_ARGS = [
  "-c", "safe.directory=*",
  "-c", "core.quotepath=off",
  "-c", "core.autocrlf=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgsign=false",
  "-c", "gc.auto=0",
];

/**
 * Runs the `git` binary against project repositories only. Every call sets GIT_DIR to
 * `<project>/.git` and GIT_CEILING_DIRECTORIES to the projects dir, so git can never discover
 * (or write to) a repository outside DRAWER_DATA, and ignores the user's own git config.
 */
export class Git {
  constructor(private readonly projectsDir: string) {}

  async run(dir: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      GIT_CEILING_DIRECTORIES: this.projectsDir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    if (!opts.noGitDir) {
      env.GIT_DIR = join(dir, ".git");
      env.GIT_WORK_TREE = dir;
    }
    Object.assign(env, opts.env);
    if (opts.author) {
      const date = opts.date ?? isoSeconds();
      env.GIT_AUTHOR_NAME = opts.author.name;
      env.GIT_AUTHOR_EMAIL = opts.author.email;
      env.GIT_COMMITTER_NAME = opts.author.name;
      env.GIT_COMMITTER_EMAIL = opts.author.email;
      env.GIT_AUTHOR_DATE = date;
      env.GIT_COMMITTER_DATE = date;
    }
    const proc = Bun.spawn(["git", ...CONFIG_ARGS, ...args], {
      cwd: dir,
      env,
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0 && !opts.allowFail) {
      throw new GitError(`git ${args[0] ?? ""} failed (${code}): ${stderr.trim()}`);
    }
    return { code, stdout, stderr };
  }

  async init(dir: string): Promise<void> {
    await this.run(dir, ["init", "-q", "-b", "main"], { noGitDir: true });
    // project.json is server metadata, not content: keep it out of every commit without a tracked file.
    const info = join(dir, ".git", "info");
    await mkdir(info, { recursive: true });
    await writeFile(join(info, "exclude"), "/project.json\n");
  }

  async head(dir: string): Promise<string | null> {
    const { code, stdout } = await this.run(dir, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true });
    return code === 0 ? new TextDecoder().decode(stdout).trim() : null;
  }

  /** Stages everything and commits it; null when the work tree equals HEAD. */
  async commitAll(dir: string, author: string, message: string): Promise<CommitInfo | null> {
    await this.run(dir, ["add", "-A", "--", "."]);
    const { code } = await this.run(dir, ["diff", "--cached", "--quiet"], { allowFail: true });
    if (code === 0) return null;
    const who = commitAuthor(author);
    const date = isoSeconds();
    const body = message.replace(/\u0000/g, "").trim() || "update";
    await this.run(dir, ["commit", "-q", "--allow-empty-message", "-m", body], { author: who, date });
    const id = await this.head(dir);
    if (id === null) throw new GitError("commit left no HEAD");
    return { id, date };
  }

  async log(dir: string, opts: { path?: string; limit: number }): Promise<Revision[]> {
    const args = ["log", "--no-renames", "--name-only", `-n${opts.limit}`, "--format=%x1e%H%x1f%an%x1f%aI%x1f%B%x1f"];
    if (opts.path) args.push("--", opts.path);
    const { code, stdout } = await this.run(dir, args, { allowFail: true });
    if (code !== 0) return [];
    const revisions: Revision[] = [];
    for (const record of new TextDecoder().decode(stdout).split("\x1e")) {
      if (record.trim() === "") continue;
      const [id, author, date, message, rest] = record.split("\x1f");
      if (id === undefined || author === undefined || date === undefined || message === undefined) continue;
      const paths = (rest ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "" && line !== "project.json" && !line.endsWith("/.gitkeep") && line !== ".gitkeep");
      revisions.push({ id: id.trim(), author, message: message.trim(), date: new Date(date).toISOString(), paths });
    }
    return revisions;
  }

  /** Newest change per path across the whole history, plus the newest change overall. */
  async provenance(dir: string): Promise<{ last: { at: string; by: string } | null; byPath: Map<string, { at: string; by: string }> }> {
    const { code, stdout } = await this.run(dir, ["log", "--no-renames", "--name-only", "--format=%x1e%aI%x1f%an%x1f"], { allowFail: true });
    const byPath = new Map<string, { at: string; by: string }>();
    let last: { at: string; by: string } | null = null;
    if (code !== 0) return { last, byPath };
    for (const record of new TextDecoder().decode(stdout).split("\x1e")) {
      if (record.trim() === "") continue;
      const [date, author, rest] = record.split("\x1f");
      if (date === undefined || author === undefined) continue;
      const stamp = { at: new Date(date).toISOString(), by: author };
      last ??= stamp;
      for (const line of (rest ?? "").split("\n")) {
        const path = line.trim();
        if (path !== "" && !byPath.has(path)) byPath.set(path, stamp);
      }
    }
    return { last, byPath };
  }

  /** File bytes at a revision; null when the revision or the path in it does not exist. */
  async show(dir: string, revision: string, path: string): Promise<Uint8Array | null> {
    const { code, stdout } = await this.run(dir, ["show", `${revision}:${path}`], { allowFail: true });
    return code === 0 ? stdout : null;
  }

  async revisionExists(dir: string, revision: string): Promise<boolean> {
    const { code } = await this.run(dir, ["cat-file", "-e", `${revision}^{commit}`], { allowFail: true });
    return code === 0;
  }

  /** Writes the whole tree of a revision into `dest` (an empty directory), using a throw-away index file. */
  async checkoutTree(dir: string, revision: string, dest: string, indexFile: string): Promise<void> {
    const env = { GIT_INDEX_FILE: indexFile };
    await this.run(dir, ["read-tree", revision], { env });
    await this.run(dir, ["checkout-index", "-a", "-f", `--prefix=${dest}/`], { env });
  }
}
