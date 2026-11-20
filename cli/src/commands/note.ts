import { basename } from "node:path";
import type { WriteResult } from "@drawer/shared/api";
import { UsageError } from "../args.ts";
import { ApiFailure, type Client } from "../client.ts";
import type { Command } from "../command.ts";
import { emit, oneLine } from "../output.ts";

const DEFAULT_FILE = "notes/log.md";
const DEFAULT_CATEGORY = "note";
/** `[x]` and `[ ]` are checkboxes, not facts, so "x" is not a usable category. */
const CATEGORY = /^(?![xX]$)[A-Za-z][\w-]*$/;

function heading(file: string): string {
  const stem = basename(file).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Notes";
  return `# ${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const isClash = (error: unknown): boolean => error instanceof ApiFailure && (error.code === "conflict" || error.code === "exists");

/** Read-modify-write: append `line` to `file`, creating it with a heading. Retries once if someone else wrote in between. */
async function appendLine(client: Client, project: string, file: string, line: string, message: string): Promise<WriteResult> {
  for (let attempt = 0; ; attempt++) {
    let current: { text: string; rev: string } | null = null;
    try {
      const read = await client.readFile(project, file);
      current = { text: decoder.decode(read.bytes), rev: read.rev ?? "*" };
    } catch (error) {
      if (!(error instanceof ApiFailure && error.code === "not_found")) throw error;
    }

    try {
      if (current === null) return await client.writeFile(project, file, encoder.encode(`${heading(file)}\n\n${line}\n`), { message });
      const separator = current.text === "" || current.text.endsWith("\n") ? "" : "\n";
      return await client.writeFile(project, file, encoder.encode(`${current.text}${separator}${line}\n`), { rev: current.rev, message });
    } catch (error) {
      if (attempt === 0 && isClash(error)) continue;
      throw error;
    }
  }
}

export const note: Command = {
  name: "note",
  usage: ['drawer note <project> "<text>" [--file notes/log.md] [--category c] [-m msg]'],
  summary: "append a fact line `- [category] text` to a note (creating the file with a heading)",
  details:
    `Default file ${DEFAULT_FILE}, default category ${DEFAULT_CATEGORY}. Reads the file, appends, writes\n` +
    "it back guarded by the rev, and retries once if someone else wrote meanwhile. The file path is project-relative.",
  flags: { string: ["file", "category", "message"], alias: { m: "message" } },
  async run(ctx, args) {
    const [project, ...words] = args.positionals;
    const text = oneLine(words.join(" "));
    if (!project || !text) throw new UsageError('usage: drawer note <project> "<text>" [--file notes/log.md] [--category c]');
    const category = args.str("category") ?? DEFAULT_CATEGORY;
    if (!CATEGORY.test(category)) throw new UsageError(`bad category "${category}": a word of letters, digits, _ or -`);
    const file = (args.str("file") ?? DEFAULT_FILE).replace(/^\.?\/+/, "");
    const message = args.str("message") ?? `note: ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`;
    ctx.subject = `${project}/${file}`;
    const client = await ctx.client();
    const result = await appendLine(client, project, file, `- [${category}] ${text}`, message);
    emit(ctx.mode, result, () => `noted in ${result.project}/${result.path}  rev ${result.rev}`);
  },
};
