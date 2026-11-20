/** What a write that touches a part prints: the check, and the server's verdict once the evaluation is done. */
import type { PartReport, WriteResult } from "@drawer/shared/api";
import { ApiFailure, type Client } from "./client.ts";
import type { Ctx } from "./command.ts";
import { CliError } from "./command.ts";
import type { Env } from "./config.ts";
import { emit } from "./output.ts";
import { fetchPictures } from "./pictures.ts";
import { type LocalPartReport, checkText, partReportText } from "./report.ts";
import { partModelPath, partSpecPath } from "./values.ts";

/** A part's report with its pictures in the local cache. */
export async function localPartReport(client: Client, env: Env, report: PartReport): Promise<LocalPartReport> {
  const pictures = report.render ? await fetchPictures(client, env, report.render) : null;
  return { ...report, pictures };
}

function writeText(verb: string, result: WriteResult, report: LocalPartReport | null, skipped: boolean): string {
  const lines = [`${verb} ${result.project}/${result.path}  rev ${result.rev}`];
  if (result.check) lines.push(...checkText(result.check));
  if (report) lines.push("", partReportText(report));
  else if (skipped && result.part) lines.push(`evaluation of ${result.part} queued; \`drawer report ${result.project}/${result.part}\` waits for it`);
  return lines.join("\n");
}

/**
 * Print the outcome of a write, edit, parameter change or restore. When the file is a part's model or
 * spec, join the queued evaluation and print its report (unless `noReport`). JSON is the WriteResult
 * with the report added under `report`.
 */
export async function finishWrite(ctx: Ctx, client: Client, result: WriteResult, opts: { verb: string; noReport: boolean }): Promise<void> {
  const part = result.part !== null && (result.path === partModelPath(result.part) || result.path === partSpecPath(result.part)) ? result.part : null;
  let report: LocalPartReport | null = null;
  let failure: string | null = null;
  if (part !== null && !opts.noReport) {
    try {
      report = await localPartReport(client, ctx.env, await client.evaluatePart(result.project, part));
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
      failure = error.message;
    }
  }
  emit(ctx.mode, report ? { ...result, report } : result, () => writeText(opts.verb, result, report, opts.noReport));
  if (failure !== null) {
    throw new CliError(`the write succeeded, but the report failed: ${failure}. Run \`drawer report ${result.project}/${part}\` for it.`);
  }
}
