import { describe, expect, test } from "bun:test";
import { HEADER_AUTHOR, HEADER_MESSAGE, HEADER_REV } from "@drawer/shared/api";
import { UsageError, parseArgs, parseFileArg } from "../src/args.ts";
import { HEADER_AUTHOR as AUTHOR, HEADER_MESSAGE as MESSAGE, HEADER_REV as REV } from "../src/client.ts";

describe("parseArgs", () => {
  const spec = { string: ["old", "rev"], list: ["param"], boolean: ["all"], alias: { m: "message" }, } as const;

  test("flag values may be empty or start with a dash", () => {
    const parsed = parseArgs(["f", "--old", "-x", "--rev=", "--all"], spec);
    expect(parsed.positionals).toEqual(["f"]);
    expect(parsed.str("old")).toBe("-x");
    expect(parsed.str("rev")).toBe("");
    expect(parsed.bool("all")).toBe(true);
  });

  test("repeatable flags collect, aliases resolve, -- ends options", () => {
    const parsed = parseArgs(["--param", "a", "--param=b", "-m", "msg", "--", "--old"], { ...spec, string: [...spec.string, "message"] });
    expect(parsed.list("param")).toEqual(["a", "b"]);
    expect(parsed.str("message")).toBe("msg");
    expect(parsed.positionals).toEqual(["--old"]);
  });

  test("unknown options and missing values are usage errors", () => {
    expect(() => parseArgs(["--nope"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["--old"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["--all=1"], spec)).toThrow(UsageError);
  });

  test("int validates", () => {
    expect(parseArgs(["--n", "5"], { string: ["n"] }).int("n")).toBe(5);
    expect(() => parseArgs(["--n", "x"], { string: ["n"] }).int("n")).toThrow(UsageError);
  });
});

describe("parseFileArg", () => {
  test("splits project and path", () => {
    expect(parseFileArg("box/src/a.scad")).toEqual({ project: "box", path: "src/a.scad" });
    expect(parseFileArg("_library/AGENTS.md")).toEqual({ project: "_library", path: "AGENTS.md" });
  });
  test("rejects a bare project", () => {
    expect(() => parseFileArg("box")).toThrow(UsageError);
    expect(() => parseFileArg("box/")).toThrow(UsageError);
    expect(() => parseFileArg(undefined)).toThrow(UsageError);
  });
});

describe("shared contract", () => {
  test("header names match shared/src/api.ts", () => {
    expect([REV, AUTHOR, MESSAGE]).toEqual([HEADER_REV, HEADER_AUTHOR, HEADER_MESSAGE]);
  });
});
