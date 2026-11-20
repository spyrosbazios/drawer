/** All CLI output goes through here. */
import type { MeshInfo } from "@drawer/shared/api";
import { UsageError } from "./args.ts";

export function writeOut(text: string): void {
  process.stdout.write(text);
}

export function writeErr(text: string): void {
  process.stderr.write(text);
}

export async function writeBytes(bytes: Uint8Array): Promise<void> {
  await Bun.write(Bun.stdout, bytes);
}

export interface OutputMode {
  /** True when one JSON document should be printed. */
  json: boolean;
  /** True when stdout is a terminal (JSON is pretty-printed there). */
  tty: boolean;
}

/** `--json` forces JSON, `--text` forces text, otherwise JSON exactly when stdout is not a TTY. */
export function resolveMode(flags: { json: boolean; text: boolean }, tty: boolean): OutputMode {
  if (flags.json && flags.text) throw new UsageError("--json and --text are mutually exclusive");
  return { json: flags.json || (!flags.text && !tty), tty };
}

/** Print `value` as one JSON document, or `text()` when the mode is human. */
export function emit(mode: OutputMode, value: unknown, text: () => string): void {
  if (mode.json) writeOut(`${JSON.stringify(value, null, mode.tty ? 2 : undefined)}\n`);
  else {
    const body = text();
    writeOut(body.endsWith("\n") ? body : `${body}\n`);
  }
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A number rounded to two decimals, as short text. */
export const num = (n: number): string => String(Math.round(n * 100) / 100);

export function formatMesh(mesh: MeshInfo): string {
  const [x, y, z] = mesh.bbox.size;
  const volume = mesh.volumeCm3 === null ? "" : `, volume ${num(mesh.volumeCm3)} cm3`;
  return `size ${num(x)} x ${num(y)} x ${num(z)} mm${volume}, ${mesh.triangles} triangles`;
}

/** Collapse whitespace so a snippet or title fits on one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
