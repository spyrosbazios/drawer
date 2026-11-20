/** Parsers for the values commands take: part arguments, parameter assignments, axes and points. */
import type { Axis, ParamValue, ParamValues, Vec3 } from "@drawer/shared/api";
import { UsageError } from "./args.ts";

export const PART_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Where a part's files live in its project (docs/SPEC.md "Store layout"). */
export const partModelPath = (id: string) => `parts/${id}.scad`;
export const partSpecPath = (id: string) => `parts/${id}.part.json`;

/** `<project>/<part-id>`; the project may be `_library`. */
export function parsePartArg(arg: string | undefined): { project: string; id: string } {
  if (!arg) throw new UsageError("missing part argument, expected <project>/<part-id>");
  const slash = arg.indexOf("/");
  const project = slash === -1 ? "" : arg.slice(0, slash);
  const id = slash === -1 ? "" : arg.slice(slash + 1);
  if (!project || !PART_ID.test(id)) {
    throw new UsageError(`"${arg}" is not <project>/<part-id> (a part id is lowercase letters, digits and dashes)`);
  }
  return { project, id };
}

const isNumber = (x: unknown): x is number => typeof x === "number";

/** A number, `true`/`false`, a JSON vector `[1,2,3]` or a quoted JSON string; anything else is a plain string. */
export function parseParamValue(raw: string): ParamValue {
  try {
    const value: unknown = JSON.parse(raw);
    if (isNumber(value) || typeof value === "boolean" || typeof value === "string") return value;
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      if (items.every(isNumber)) return items;
    }
  } catch {
    // not JSON: the text itself is the value
  }
  return raw;
}

/** `name=value` assignments. */
export function parseAssignments(items: readonly string[]): ParamValues {
  const values: ParamValues = {};
  for (const item of items) {
    const eq = item.indexOf("=");
    const name = eq === -1 ? "" : item.slice(0, eq);
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new UsageError(`"${item}" is not name=value`);
    values[name] = parseParamValue(item.slice(eq + 1));
  }
  return values;
}

export function parseAxis(raw: string | undefined, flag = "axis"): Axis {
  if (raw === "x" || raw === "y" || raw === "z") return raw;
  throw new UsageError(`--${flag} must be x, y or z`);
}

/** `x,y,z` */
export function parseVec3(raw: string | undefined, flag: string): Vec3 {
  const parts = (raw ?? "").split(",").map((p) => p.trim());
  const [x, y, z] = parts.map(Number);
  if (parts.length !== 3 || x === undefined || y === undefined || z === undefined || parts.some((p) => p === "") || ![x, y, z].every(Number.isFinite)) {
    throw new UsageError(`--${flag} takes three numbers: x,y,z`);
  }
  return [x, y, z];
}
