import type { ContextNode, FileKind } from "@drawer/shared/api";
import { UsageError, parseFileArg } from "../args.ts";
import type { Command } from "../command.ts";
import { emit, formatMesh, oneLine } from "../output.ts";

const KINDS: readonly FileKind[] = ["markdown", "scad", "mesh", "image", "pdf", "text", "binary"];

export const search: Command = {
  name: "search",
  usage: ["drawer search <project> <words...> [--kind k] [--limit n]"],
  summary: "full-text search over one project's notes, SCAD and text files (and mesh names/info); one line per hit",
  details: `Searches one project; use _library for the library. Words are plain text (no query syntax); the last word matches as a prefix.\nKinds: ${KINDS.join(", ")}. Hit line: <project>/<path>  <snippet>, the match wrapped in « ».`,
  flags: { string: ["kind", "limit"] },
  async run(ctx, args) {
    const [project, ...words] = args.positionals;
    if (!project || words.length === 0) throw new UsageError("usage: drawer search <project> <words...>");
    const kind = args.str("kind");
    if (kind !== undefined && !KINDS.includes(kind as FileKind)) throw new UsageError(`--kind must be one of ${KINDS.join(", ")}`);
    const client = await ctx.client();
    const result = await client.search(project, { q: words.join(" "), kind: kind as FileKind | undefined, limit: args.int("limit") });
    emit(ctx.mode, result, () => (result.hits.length === 0 ? "no hits" : result.hits.map((h) => `${project}/${h.path}  ${oneLine(h.snippet)}`).join("\n")));
  },
};

function nodeHeader(n: ContextNode): string {
  const reached = n.via
    ? `via ${n.via.relation} [[${n.via.target}]] in ${n.via.fromProject}/${n.via.from}`
    : "root";
  return `== ${n.project}/${n.path}  [${n.kind}]  ${reached}  depth ${n.depth}`;
}

function nodeBody(n: ContextNode): string {
  if (n.content !== null) return n.truncated ? `${n.content}\n[... truncated]` : n.content;
  if (n.mesh) return `(${n.mesh.format} mesh: ${formatMesh(n.mesh)})`;
  return "(no text content)";
}

export const context: Command = {
  name: "context",
  usage: ["drawer context <project>/<path> [--depth 2] [--max-bytes 4000]"],
  summary: "a file plus everything linked to or from it (breadth-first, at most 30 nodes), with content",
  details:
    "Prints each node as a header line (path, kind, how it was reached) followed by its content. Unlike other\n" +
    "commands this prints text even when piped; --json gives the raw ContextResponse.",
  flags: { string: ["depth", "max-bytes"] },
  textDefault: true,
  async run(ctx, args) {
    const file = parseFileArg(args.positionals[0]);
    if (args.positionals.length > 1) throw new UsageError("context takes one file argument");
    ctx.subject = args.positionals[0];
    const client = await ctx.client();
    const result = await client.context(file.project, file.path, { depth: args.int("depth"), maxBytes: args.int("max-bytes") });
    emit(ctx.mode, result, () => result.nodes.map((n) => `${nodeHeader(n)}\n${nodeBody(n)}`).join("\n\n"));
  },
};
