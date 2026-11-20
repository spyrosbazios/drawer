import { basename, resolve } from "node:path";
import type { FileInfo, TreeEntry, WriteResult } from "@drawer/shared/api";
import { UsageError, parseFileArg } from "../args.ts";
import { ApiFailure } from "../client.ts";
import type { Command } from "../command.ts";
import { CliError, EXIT_CONFLICT, EXIT_NOT_FOUND } from "../command.ts";
import { finishWrite } from "../feedback.ts";
import { emit, formatMesh, formatSize, oneLine, writeBytes, writeErr } from "../output.ts";

// ---- ls ---------------------------------------------------------------------------------------

function treeText(entries: TreeEntry[], dir: string): string {
  const prefix = dir ? `${dir}/` : "";
  return entries
    .map((e) => {
      const rel = e.path.slice(prefix.length);
      const parts = rel.split("/");
      const indent = "  ".repeat(parts.length - 1);
      const name = parts[parts.length - 1] ?? rel;
      return e.type === "dir" ? `${indent}${name}/` : `${indent}${name}  ${e.kind ?? ""}  ${formatSize(e.size)}`;
    })
    .join("\n");
}

export const ls: Command = {
  name: "ls",
  usage: ["drawer ls <project> [dir]"],
  summary: "tree of a project (or of one folder in it) with kind and size",
  async run(ctx, args) {
    const [project, rawDir, ...extra] = args.positionals;
    if (!project || extra.length > 0) throw new UsageError("usage: drawer ls <project> [dir]");
    const dir = (rawDir ?? "").replace(/^\.?\/+|\/+$/g, "");
    const client = await ctx.client();
    const { entries } = await client.tree(project);
    const shown = dir ? entries.filter((e) => e.path.startsWith(`${dir}/`)) : entries;
    if (dir && shown.length === 0) throw new CliError(`no such directory ${project}/${dir}`, EXIT_NOT_FOUND);
    emit(ctx.mode, { entries: shown }, () => (shown.length === 0 ? "(empty)" : treeText(shown, dir)));
  },
};

// ---- cat --------------------------------------------------------------------------------------

export const cat: Command = {
  name: "cat",
  usage: ["drawer cat <project>/<path> [--at <revision-id>]"],
  summary: "file content on stdout (binary-safe), `rev <rev>` on stderr",
  details:
    "Keep the rev: edit, write --rev and rm need it. --at reads a past revision (ids from `drawer history`).\n" +
    "Always prints raw content, never JSON. Refuses to dump a binary file onto a terminal; use `drawer get`.",
  flags: { string: ["at"] },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    ctx.subject = args.positionals[0];
    const client = await ctx.client();
    const { bytes, rev } = await client.readFile(file.project, file.path, { at: args.str("at") });
    if (ctx.mode.tty && bytes.subarray(0, 8000).includes(0)) {
      throw new CliError(`${args.positionals[0]} is binary (${formatSize(bytes.length)}); use \`drawer get\` to download it`);
    }
    if (rev) writeErr(`rev ${rev}\n`);
    await writeBytes(bytes);
  },
};

// ---- info -------------------------------------------------------------------------------------

function infoText(info: FileInfo): string {
  const lines = [
    `${info.project}/${info.path}  ${info.kind}  ${formatSize(info.size)}  rev ${info.rev}`,
    `updated ${info.updatedAt} by ${info.updatedBy}`,
  ];
  if (info.mesh) lines.push(`mesh ${info.mesh.format}: ${formatMesh(info.mesh)}`);
  if (info.outline.length > 0) lines.push(`outline: ${info.outline.join(", ")}`);
  for (const f of info.facts) lines.push(`fact line ${f.line}: [${f.category}] ${oneLine(f.text)}`);
  for (const l of info.outgoing) lines.push(`-> ${l.relation} [[${l.target}]] ${l.to ? `${l.toProject}/${l.to}` : "(unresolved)"}`);
  for (const l of info.incoming) lines.push(`<- ${l.relation} from ${l.fromProject}/${l.from}`);
  return lines.join("\n");
}

export const info: Command = {
  name: "info",
  usage: ["drawer info <project>/<path>"],
  summary: "kind, size, rev, mesh dimensions, facts, links in and out, SCAD outline",
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    const client = await ctx.client();
    const result = await client.info(file.project, file.path);
    emit(ctx.mode, result, () => infoText(result));
  },
};

// ---- write ------------------------------------------------------------------------------------

async function readBody(from: string | undefined): Promise<Uint8Array> {
  if (from !== undefined) {
    const local = Bun.file(from);
    if (!(await local.exists())) throw new CliError(`--from: no such local file ${from}`);
    return new Uint8Array(await local.arrayBuffer());
  }
  if (process.stdin.isTTY) throw new UsageError("write needs the body on stdin or --from <local-file>");
  return new Uint8Array(await Bun.stdin.arrayBuffer());
}

export const write: Command = {
  name: "write",
  usage: ["drawer write <project>/<path> [--rev r] [-m msg] [--from <local-file>]", "            [--no-report]"],
  summary: "create or overwrite a file from stdin or a local file (binary-safe)",
  details:
    "Without --rev this creates the file and fails (exit 2) if it already exists. To overwrite, pass the rev you\n" +
    "read with `drawer cat`; if the file changed since, you get exit 2 and must re-read. -m becomes the revision\n" +
    "message: say what and why. Missing parent folders are created.\n" +
    "A .scad file prints OpenSCAD's errors and warnings with file:line. Writing a part's model (parts/<id>.scad) or\n" +
    "spec (parts/<id>.part.json) then waits for the server's evaluation and prints the part's report, so the\n" +
    "feedback arrives without a second command. --no-report skips the wait (`drawer report` gets it later).",
  flags: { string: ["rev", "message", "from"], boolean: ["no-report"], alias: { m: "message" } },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("write takes one file argument; the body comes from stdin or --from");
    ctx.subject = args.positionals[0];
    const rev = args.str("rev");
    const body = await readBody(args.str("from"));
    const client = await ctx.client();
    let result: WriteResult;
    try {
      result = await client.writeFile(file.project, file.path, body, { rev, message: args.str("message") });
    } catch (error) {
      if (rev === undefined && error instanceof ApiFailure && (error.code === "conflict" || error.code === "exists")) {
        const current = error.rev ? ` (current rev ${error.rev})` : "";
        throw new CliError(
          `${args.positionals[0]} already exists${current}. To overwrite, read it with \`drawer cat ${args.positionals[0]}\` and pass --rev <rev>.`,
          EXIT_CONFLICT,
        );
      }
      throw error;
    }
    await finishWrite(ctx, client, result, { verb: result.created ? "created" : "wrote", noReport: args.bool("no-report") });
  },
};

// ---- edit -------------------------------------------------------------------------------------

export const edit: Command = {
  name: "edit",
  usage: ["drawer edit <project>/<path> --rev r --old s --new s [--all] [-m msg]", "            [--no-report]"],
  summary: "replace an exact string in a text file, guarded by the rev",
  details:
    "Like Claude Code's Edit tool: --old must occur exactly once unless --all. A miss is `edit_no_match` (exit 1);\n" +
    "copy the text exactly from `drawer cat`. A stale --rev is exit 2: re-read, redo the change from the new text.\n" +
    "Prints the .scad check and, for a part's model or spec, the part's report, like `write`; --no-report skips the wait.",
  flags: { string: ["rev", "old", "new", "message"], boolean: ["all", "no-report"], alias: { m: "message" } },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    ctx.subject = args.positionals[0];
    const rev = args.str("rev");
    const oldText = args.str("old");
    const newText = args.str("new");
    if (rev === undefined) throw new UsageError("edit needs --rev (the rev printed by `drawer cat`)");
    if (oldText === undefined || oldText === "") throw new UsageError("edit needs a non-empty --old");
    if (newText === undefined) throw new UsageError("edit needs --new (may be empty to delete the old text)");
    const client = await ctx.client();
    let result: WriteResult;
    try {
      result = await client.edit(file.project, file.path, {
        rev,
        old: oldText,
        new: newText,
        replaceAll: args.bool("all") || undefined,
        message: args.str("message"),
      });
    } catch (error) {
      if (error instanceof ApiFailure && error.code === "edit_no_match") {
        throw new CliError(
          `edit_no_match: ${oneLine(error.message)} -- --old must match the file text exactly and occur once (or pass --all); \`drawer cat ${args.positionals[0]}\` and copy it`,
        );
      }
      throw error;
    }
    await finishWrite(ctx, client, result, { verb: "edited", noReport: args.bool("no-report") });
  },
};

// ---- rm, mv -----------------------------------------------------------------------------------

export const rm: Command = {
  name: "rm",
  usage: ["drawer rm <project>/<path> --rev r", "drawer rm <project>/<dir> --recursive"],
  summary: "delete a file (needs its rev) or a directory (--recursive)",
  flags: { string: ["rev", "message"], boolean: ["recursive"], alias: { m: "message" } },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    ctx.subject = args.positionals[0];
    const recursive = args.bool("recursive");
    const rev = args.str("rev");
    if (!recursive && rev === undefined) throw new UsageError("rm needs --rev (or --recursive for a directory)");
    const client = await ctx.client();
    const result = await client.deleteFile(file.project, file.path, { rev: recursive ? undefined : rev, recursive, message: args.str("message") });
    emit(ctx.mode, result, () => `deleted ${args.positionals[0]}  revision ${result.revisionId}`);
  },
};

export const mv: Command = {
  name: "mv",
  usage: ["drawer mv <project>/<path> <new-path> [-m msg]"],
  summary: "rename a file or directory inside its project",
  details: "<new-path> is relative to the same project (no project prefix); moving between projects is not supported.",
  flags: { string: ["message"], alias: { m: "message" } },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    const target = args.positionals[1];
    if (!target || args.positionals.length > 2) throw new UsageError("usage: drawer mv <project>/<path> <new-path>");
    ctx.subject = args.positionals[0];
    const client = await ctx.client();
    const result = await client.move(file.project, { from: file.path, to: target.replace(/^\/+/, ""), message: args.str("message") });
    emit(ctx.mode, result, () => `moved ${args.positionals[0]} -> ${file.project}/${target}  revision ${result.revisionId}`);
  },
};

// ---- get --------------------------------------------------------------------------------------

export const get: Command = {
  name: "get",
  usage: ["drawer get <project>/<path> [-o local]"],
  summary: "download a file (binary or text) to a local path",
  details: "Default destination: the file's basename in the current directory. `-o -` writes to stdout.",
  flags: { string: ["output"], alias: { o: "output" } },
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    ctx.subject = args.positionals[0];
    const client = await ctx.client();
    const { bytes, rev } = await client.readFile(file.project, file.path, { download: true });
    const out = args.str("output") ?? basename(file.path);
    if (out === "-") {
      await writeBytes(bytes);
      return;
    }
    const dest = resolve(out);
    await Bun.write(dest, bytes);
    emit(ctx.mode, { project: file.project, path: file.path, rev, bytes: bytes.length, out: dest }, () => `${dest}  ${formatSize(bytes.length)}`);
  },
};

// ---- history ----------------------------------------------------------------------------------

export const history: Command = {
  name: "history",
  usage: ["drawer history <project> [path] [--limit n]"],
  summary: "revisions of a project or one file, newest first (ids work with `cat --at` and `render`)",
  flags: { string: ["limit"] },
  async run(ctx, args) {
    const [project, path, ...extra] = args.positionals;
    if (!project || extra.length > 0) throw new UsageError("usage: drawer history <project> [path]");
    const client = await ctx.client();
    const result = await client.history(project, { path, limit: args.int("limit") });
    emit(ctx.mode, result, () =>
      result.revisions.length === 0
        ? "no revisions"
        : result.revisions.map((r) => `${r.id}  ${r.date}  ${r.author}  ${oneLine(r.message)}  (${r.paths.join(", ")})`).join("\n"),
    );
  },
};
