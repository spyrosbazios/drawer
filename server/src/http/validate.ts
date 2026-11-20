import type { Axis, ParamValues, Vec3 } from "@drawer/shared/api";
import { invalid } from "../errors.ts";

export type Obj = Record<string, unknown>;

/** The body as text, read in chunks and given up on as soon as it passes `max` bytes. */
async function readCapped(req: Request, max: number, tooLarge: () => Error): Promise<string> {
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The largest JSON body a route reads. File uploads do not come through here. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

export async function readJsonBody(req: Request, opts: { optional?: boolean; maxBytes?: number } = {}): Promise<Obj> {
  const max = opts.maxBytes ?? MAX_JSON_BYTES;
  const tooLarge = () => invalid(`the JSON body is larger than ${max} bytes`);
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  const text = await readCapped(req, max, tooLarge);
  if (text.trim() === "") {
    if (opts.optional) return {};
    throw invalid("a JSON body is required");
  }
  // A body in any other type is what a cross-site form or CORS "simple" request sends; refuse it.
  const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw invalid("a JSON body must be sent with content-type: application/json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("body must be a JSON object");
  return parsed as Obj;
}

export function reqString(obj: Obj, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw invalid(`${key} must be a string`);
  return value;
}

export function optString(obj: Obj, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`${key} must be a string`);
  return value;
}

export function optBool(obj: Obj, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(`${key} must be a boolean`);
  return value;
}

export function optStringArray(obj: Obj, key: string): string[] | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw invalid(`${key} must be an array of strings`);
  return value as string[];
}

export function optInt(obj: Obj, key: string, min: number, max: number): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid(`${key} must be an integer from ${min} to ${max}`);
  return value;
}

/** An optional integer query parameter. */
export function queryInt(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${key} must be an integer from ${min} to ${max}`);
  return n;
}

export function optNumber(obj: Obj, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`${key} must be a number`);
  return value;
}

export function reqNumber(obj: Obj, key: string): number {
  const value = optNumber(obj, key);
  if (value === undefined) throw invalid(`${key} must be a number`);
  return value;
}

export function reqAxis(obj: Obj, key: string): Axis {
  const value = obj[key];
  if (value !== "x" && value !== "y" && value !== "z") throw invalid(`${key} must be x, y or z`);
  return value;
}

export function reqVec3(obj: Obj, key: string): Vec3 {
  const value = obj[key];
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) throw invalid(`${key} must be [x, y, z] numbers`);
  return [value[0] as number, value[1] as number, value[2] as number];
}

/** Customizer values: numbers, strings, booleans or number vectors. */
export function optParams(obj: Obj, key: string): ParamValues | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${key} must be an object of parameter values`);
  const out: ParamValues = {};
  for (const [name, v] of Object.entries(value as Obj)) {
    const ok = (typeof v === "number" && Number.isFinite(v)) || typeof v === "string" || typeof v === "boolean" || (Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n)));
    if (!ok) throw invalid(`${key}.${name} must be a number, string, boolean or number array`);
    out[name] = v as ParamValues[string];
  }
  return out;
}

/** Rejects fields a route does not know. */
export function onlyFields(obj: Obj, allowed: readonly string[]): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw invalid(`unknown field${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}`);
}
