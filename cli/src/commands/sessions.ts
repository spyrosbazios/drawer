import { basename, resolve } from "node:path";
import { PROVIDER_KINDS, type RunnersResponse, type Session, type SessionAttachment, type SessionDetail, type SessionItem, type SessionRef, type Settings } from "@drawer/shared/api";
import { UsageError, type Parsed } from "../args.ts";
import type { Client } from "../client.ts";
import type { Command } from "../command.ts";
import { emit, formatSize, num, oneLine, writeBytes } from "../output.ts";

const clip = (text: string, max = 400): string => {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};

function sessionLine(s: Session): string {
  const activity = s.activity ? `  ${oneLine(s.activity)}` : "";
  const pending = s.pending > 0 ? `  ${s.pending} message${s.pending === 1 ? "" : "s"} pending` : "";
  const error = s.error ? `  error: ${oneLine(s.error)}` : "";
  return `${s.id}  ${s.status}  ${s.project}  ${clip(s.title, 60)}  ${s.toolCalls} tool calls${activity}${pending}${error}`;
}

function refText(ref: SessionRef): string {
  switch (ref.kind) {
    case "part":
      return `part ${ref.part}`;
    case "point":
      return `point on ${ref.part} at ${ref.position.map(num).join(", ")}`;
    case "file":
      return `file ${ref.path}`;
  }
}

function attachmentText(a: SessionAttachment): string {
  return `${a.name} (${a.kind}, ${formatSize(a.size)}, id ${a.id})${a.filedAs ? ` filed as ${a.filedAs}` : ""}`;
}

function itemText(item: SessionItem): string {
  const head = `#${item.seq}`;
  switch (item.type) {
    case "user": {
      const refs = item.refs.length > 0 ? `  [${item.refs.map(refText).join("; ")}]` : "";
      const attached = item.attachments.length > 0 ? `  [attached: ${item.attachments.map(attachmentText).join("; ")}]` : "";
      return `${head} ${item.author}: ${clip(item.text)}${refs}${attached}`;
    }
    case "assistant":
      return `${head} agent: ${clip(item.text)}`;
    case "tool": {
      const failure = item.status === "error" && item.result ? `  -> ${clip(item.result, 200)}` : "";
      return `${head} tool ${item.status}: ${clip(item.summary, 200)}${failure}`;
    }
    case "question": {
      const options = item.options.length > 0 ? `  options: ${item.options.map((o, i) => `${i + 1}) ${oneLine(o)}`).join("  ")}` : "";
      const answer = item.answer === null ? "  (unanswered)" : `  answer: ${clip(item.answer, 200)}`;
      return `${head} question ${item.questionId}: ${clip(item.text)}${options}${answer}`;
    }
    case "notice":
      return `${head} ${item.level}: ${clip(item.text)}`;
  }
}

function detailText(d: SessionDetail): string {
  return [sessionLine(d.session), ...d.items.map(itemText)].join("\n");
}

export const sessions: Command = {
  name: "sessions",
  usage: ["drawer sessions [project]"],
  summary: "agent sessions, newest first",
  async run(ctx, args) {
    const [project, ...extra] = args.positionals;
    if (extra.length > 0) throw new UsageError("usage: drawer sessions [project]");
    const client = await ctx.client();
    const result = await client.listSessions(project);
    emit(ctx.mode, result, () => (result.sessions.length === 0 ? "no sessions" : result.sessions.map(sessionLine).join("\n")));
  },
};

export const session: Command = {
  name: "session",
  usage: ["drawer session <id> [--since <version>]"],
  summary: "one session's items: messages, tool calls, questions with their options",
  details: "--since <version> prints only the items appended or changed after that session version.",
  flags: { string: ["since"] },
  async run(ctx, args) {
    const [id, ...extra] = args.positionals;
    if (!id || extra.length > 0) throw new UsageError("usage: drawer session <id> [--since <version>]");
    const client = await ctx.client();
    const detail = await client.session(id, args.int("since"));
    emit(ctx.mode, detail, () => detailText(detail));
  },
};

/** Uploads each `--attach` file to the project and returns the ids to send. */
async function uploadAll(client: Client, project: string, args: Parsed): Promise<string[]> {
  const ids: string[] = [];
  for (const local of args.list("attach")) {
    const file = Bun.file(resolve(local));
    if (!(await file.exists())) throw new UsageError(`no such file: ${local}`);
    ids.push((await client.uploadAttachment(project, basename(local), await file.bytes())).id);
  }
  return ids;
}

export const ask: Command = {
  name: "ask",
  usage: ['drawer ask <project> "<message>" [--attach <local-file>]... [--provider p] [--model m]'],
  summary: "start an agent session on a project with a first message",
  details:
    "The built-in agent works on the project; follow it with `drawer session <id>`, talk to it with `drawer say`. --attach sends a local file with the message (a photo, a reference mesh, a datasheet); the agent sees it and files what is worth keeping into the project. The message may be empty when files are attached.",
  flags: { string: ["provider", "model"], list: ["attach"] },
  async run(ctx, args) {
    const [project, ...words] = args.positionals;
    const message = words.join(" ").trim();
    if (!project || (message === "" && args.list("attach").length === 0)) throw new UsageError('usage: drawer ask <project> "<message>" [--attach <file>]...');
    const named = args.str("provider");
    const provider = PROVIDER_KINDS.find((k) => k === named);
    if (named !== undefined && provider === undefined) throw new UsageError(`--provider must be one of ${PROVIDER_KINDS.join(", ")}`);
    const client = await ctx.client();
    const attachments = await uploadAll(client, project, args);
    const created = await client.createSession(project, { message, ...(attachments.length > 0 ? { attachments } : {}), provider, model: args.str("model") });
    emit(ctx.mode, created, () => `started session ${created.id}  ${created.status}; follow it with \`drawer session ${created.id}\``);
  },
};

export const say: Command = {
  name: "say",
  usage: ['drawer say <session-id> "<message>" [--attach <local-file>]...'],
  summary: "send a message to a session",
  details: "--attach sends a local file with the message; the message may be empty when files are attached.",
  flags: { list: ["attach"] },
  async run(ctx, args) {
    const [id, ...words] = args.positionals;
    const text = words.join(" ").trim();
    if (!id || (text === "" && args.list("attach").length === 0)) throw new UsageError('usage: drawer say <session-id> "<message>" [--attach <file>]...');
    const client = await ctx.client();
    const project = (await client.session(id, Number.MAX_SAFE_INTEGER)).session.project;
    const attachments = await uploadAll(client, project, args);
    const updated = await client.sendMessage(id, { text, ...(attachments.length > 0 ? { attachments } : {}) });
    emit(ctx.mode, updated, () => `sent to session ${updated.id}  ${updated.status}`);
  },
};

export const attachments: Command = {
  name: "attachments",
  usage: ["drawer attachments <session-id>"],
  summary: "the files people attached to a session's messages, and where each was filed",
  async run(ctx, args) {
    const [id, ...extra] = args.positionals;
    if (!id || extra.length > 0) throw new UsageError("usage: drawer attachments <session-id>");
    const client = await ctx.client();
    const detail = await client.session(id);
    const list = detail.items.flatMap((item) => (item.type === "user" ? item.attachments.map((a) => ({ ...a, message: item.seq })) : []));
    emit(ctx.mode, { attachments: list }, () =>
      list.length === 0 ? "no attachments" : list.map((a) => `${a.id}  #${a.message}  ${a.name}  ${a.kind}  ${formatSize(a.size)}${a.filedAs ? `  filed as ${a.filedAs}` : ""}`).join("\n"),
    );
  },
};

export const attachment: Command = {
  name: "attachment",
  usage: ["drawer attachment <attachment-id> [-o local]"],
  summary: "download an attachment",
  details: "Default destination: its file name in the current directory. `-o -` writes to stdout.",
  flags: { string: ["output"], alias: { o: "output" } },
  async run(ctx, args) {
    const [id, ...extra] = args.positionals;
    if (!id || extra.length > 0) throw new UsageError("usage: drawer attachment <attachment-id> [-o local]");
    const client = await ctx.client();
    const { bytes, name } = await client.attachmentBytes(id);
    const out = args.str("output") ?? name;
    if (out === "-") {
      await writeBytes(bytes);
      return;
    }
    const dest = resolve(out);
    await Bun.write(dest, bytes);
    emit(ctx.mode, { id, name, bytes: bytes.length, out: dest }, () => `${dest}  ${formatSize(bytes.length)}`);
  },
};

export const fileAttachment: Command = {
  name: "file-attachment",
  usage: ["drawer file-attachment <attachment-id> <path> [--rev r] [-m msg]"],
  summary: "copy an attachment into its project at <path> (project-relative) as one revision",
  details: "Without --rev the path must not exist yet; --rev <current rev> (or *) replaces the file there.",
  flags: { string: ["rev", "message"], alias: { m: "message" } },
  async run(ctx, args) {
    const [id, path, ...extra] = args.positionals;
    if (!id || !path || extra.length > 0) throw new UsageError("usage: drawer file-attachment <attachment-id> <path>");
    const client = await ctx.client();
    const res = await client.fileAttachment(id, { path, rev: args.str("rev"), message: args.str("message") });
    emit(ctx.mode, res, () => `filed ${res.attachment.name} as ${res.write.project}/${res.write.path}  rev ${res.write.rev}`);
  },
};

function agentsText(settings: Settings, runners: RunnersResponse): string {
  const lines = [`default: ${settings.defaultProvider}`];
  for (const kind of PROVIDER_KINDS) {
    const own = settings.providers[kind];
    const model = own.defaultModel ?? "provider default";
    const found = runners.runners.flatMap((r) => r.providers.filter((p) => p.kind === kind).map((p) => `${r.id}: ${p.state}${p.version ? ` ${p.version}` : ""}${p.message ? ` (${oneLine(p.message)})` : ""}`));
    lines.push(`${kind.padEnd(7)} ${own.enabled ? "on " : "off"}  model ${model}${own.customModels.length > 0 ? ` +${own.customModels.join(",")}` : ""}  ${found.join("; ") || "no runner"}`);
  }
  return lines.join("\n");
}

export const agents: Command = {
  name: "agents",
  usage: ["drawer agents"],
  summary: "the agent providers: settings, and what each connected runner found",
  details: "Settings change in the web app (Settings → Agents); an agent cannot change them.",
  async run(ctx, args) {
    if (args.positionals.length > 0) throw new UsageError("usage: drawer agents");
    const client = await ctx.client();
    const [settings, runners] = await Promise.all([client.settings(), client.runners()]);
    emit(ctx.mode, { settings, runners: runners.runners }, () => agentsText(settings, runners));
  },
};
