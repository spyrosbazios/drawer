import { describe, expect, test } from "bun:test";
import { summarizeCall } from "../src/format.ts";
import { drawerTools } from "../src/tools.ts";

describe("what a running call says", () => {
  test("a verb and the thing, never an id or a hash", () => {
    expect(summarizeCall("file_attachment", { id: "0000000000000003", path: "refs/datasheet.pdf" })).toBe("filing an attachment as refs/datasheet.pdf");
    expect(summarizeCall("view_attachment", { id: "0000000000000003" })).toBe("looking at an attachment");
    expect(summarizeCall("list_attachments", {})).toBe("listing the attachments");
    expect(summarizeCall("restore_attempt", { part: "cable-clip", revision_id: "a1b2c3d" })).toBe("restoring an earlier attempt of cable-clip");
    expect(summarizeCall("write_model", { part: "cable-clip", content: "cube(1);" })).toBe("writing cable-clip");
  });

  test("a missing or odd input still reads as a sentence", () => {
    expect(summarizeCall("file_attachment", null)).toBe("filing an attachment");
    expect(summarizeCall("read_file", { path: 3 })).toBe("reading");
    expect(summarizeCall("unknown_tool", { part: "x" })).toBe("unknown_tool");
  });

  test("every tool has its own words, none falls back to its code name", () => {
    for (const tool of drawerTools) expect(summarizeCall(tool.name, {})).not.toBe(tool.name);
  });
});
