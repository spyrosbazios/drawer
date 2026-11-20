import type { ImportPreview, ImportResult, Project, Strictness } from "@drawer/shared/api";
import { UsageError } from "../args.ts";
import type { Command } from "../command.ts";
import { emit, formatSize, oneLine } from "../output.ts";

const STRICTNESS: readonly Strictness[] = ["quick", "standard", "functional"];
const SLUG = /^(?:[a-z0-9][a-z0-9-]*|_library)$/;

function projectLine(p: Project): string {
  return `${p.slug}  ${oneLine(p.title)}  ${p.fileCount} files  updated ${p.updatedAt} by ${p.updatedBy}`;
}

function projectText(p: Project): string {
  const lines = [projectLine(p)];
  if (p.description) lines.push(`  ${oneLine(p.description)}`);
  if (p.source) lines.push(`  source: ${p.source.site} ${p.source.url}`);
  lines.push(`  new parts: ${p.defaults.material}, ${p.defaults.strictness}`);
  return lines.join("\n");
}

export const projects: Command = {
  name: "projects",
  usage: ["drawer projects"],
  summary: "list projects, newest change first (the library is not listed)",
  async run(ctx) {
    const client = await ctx.client();
    const result = await client.listProjects();
    emit(ctx.mode, result, () => (result.projects.length === 0 ? "no projects" : result.projects.map(projectLine).join("\n")));
  },
};

export const newProject: Command = {
  name: "new",
  usage: [
    "drawer new <slug> [--title t] [--description d] [--from <url>]",
    '            [--brief "<text>"] [--material m] [--strictness quick|standard|functional]',
  ],
  summary: "create a project, optionally importing a model page into refs/",
  details:
    "<slug> is lowercase letters, digits and dashes. --from imports the URL right after creation. --brief is what is\n" +
    "needed, in the person's words (written to brief.md). --material and --strictness are what new parts start from.",
  flags: { string: ["title", "description", "from", "brief", "material", "strictness"] },
  async run(ctx, args) {
    const [slug, ...extra] = args.positionals;
    if (!slug || extra.length > 0) throw new UsageError("usage: drawer new <slug> [--title t] [--from <url>] [--brief text]");
    if (!SLUG.test(slug)) throw new UsageError(`bad slug "${slug}": use lowercase letters, digits and dashes`);
    const strictness = args.str("strictness");
    if (strictness !== undefined && !STRICTNESS.includes(strictness as Strictness)) throw new UsageError(`--strictness must be one of ${STRICTNESS.join(", ")}`);
    const material = args.str("material");
    const client = await ctx.client();
    const project = await client.createProject({
      slug,
      title: args.str("title"),
      description: args.str("description"),
      fromUrl: args.str("from"),
      brief: args.str("brief"),
      defaults: material !== undefined || strictness !== undefined ? { material, strictness: strictness as Strictness | undefined } : undefined,
    });
    emit(ctx.mode, project, () => `created ${projectText(project)}`);
  },
};

function importText(r: ImportResult): string {
  const lines = [`imported into ${r.project}/${r.dir}  (revision ${r.revisionId})`];
  for (const path of r.written) lines.push(`  wrote ${r.project}/${path}`);
  for (const s of r.skipped) lines.push(`  skipped ${s.name}: ${s.reason}`);
  return lines.join("\n");
}

export const importCmd: Command = {
  name: "import",
  usage: ["drawer import <project> <url> [--name n] [--file-id id]..."],
  summary: "download a model page (Printables, Thingiverse, ...) into <project>/refs/<name>/",
  details:
    "Writes the model files, up to 8 images and source.md (title, author, licence, URL) in one commit.\n" +
    "--name is the folder under refs/ (default: slug of the title). --file-id limits which files are fetched\n" +
    "(ids from `drawer preview <url>`); omitted = all downloadable ones. Files a site will not hand out are\n" +
    "listed under skipped: upload those by hand.",
  flags: { string: ["name"], list: ["file-id"] },
  async run(ctx, args) {
    const [slug, url, ...extra] = args.positionals;
    if (!slug || !url || extra.length > 0) throw new UsageError("usage: drawer import <project> <url> [--name n]");
    const client = await ctx.client();
    const ids = args.list("file-id");
    const result = await client.importInto(slug, { url, name: args.str("name"), fileIds: ids.length > 0 ? ids : undefined });
    emit(ctx.mode, result, () => importText(result));
  },
};

function previewText(p: ImportPreview): string {
  const lines = [`${p.source.site}  ${oneLine(p.source.title)}`];
  if (p.source.author) lines.push(`  author ${p.source.author}`);
  if (p.source.license) lines.push(`  licence ${p.source.license}`);
  if (p.blocker) lines.push(`  blocker: ${p.blocker}`);
  for (const f of p.files) {
    const parts = [f.id, f.name, formatSize(f.size ?? undefined), f.downloadable ? "" : "(not downloadable)"];
    lines.push(`  ${parts.filter(Boolean).join("  ")}`);
  }
  return lines.join("\n");
}

export const preview: Command = {
  name: "preview",
  usage: ["drawer preview <url>"],
  summary: "show what an import would fetch (metadata, files, blockers) without writing anything",
  async run(ctx, args) {
    const [url, ...extra] = args.positionals;
    if (!url || extra.length > 0) throw new UsageError("usage: drawer preview <url>");
    const client = await ctx.client();
    const result = await client.importPreview(url);
    emit(ctx.mode, result, () => previewText(result));
  },
};

export const reindex: Command = {
  name: "reindex",
  usage: ["drawer reindex"],
  summary: "rebuild the search index from the files",
  async run(ctx) {
    const client = await ctx.client();
    const result = await client.reindex();
    emit(ctx.mode, result, () => `reindexed ${result.files} files`);
  },
};
