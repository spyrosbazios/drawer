import { describe, expect, test } from "bun:test";
import type { BoundTool } from "../src/provider.ts";
import { foreignTools, mapSdkMessage, promptMessage, TOOL_USE_ID_META, toolFinished, toolHandler, toolUseIdOf } from "../src/providers/claude.ts";
import type { ToolOutput } from "../src/tools.ts";

describe("mapSdkMessage", () => {
  test("init gives the session id, model and tools", () => {
    const msg = {
      type: "system",
      subtype: "init",
      session_id: "abc",
      model: "claude-sonnet",
      tools: ["mcp__drawer__overview", "mcp__drawer__write_model"],
      cwd: "/tmp/x",
      mcp_servers: [{ name: "drawer", status: "connected" }],
    };
    expect(mapSdkMessage(msg)).toEqual([{ kind: "init", sessionId: "abc", model: "claude-sonnet", tools: ["mcp__drawer__overview", "mcp__drawer__write_model"] }]);
  });

  test("assistant text and tool_use blocks, in order", () => {
    const msg = {
      type: "assistant",
      parent_tool_use_id: null,
      session_id: "abc",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "  Reading the brief.  " },
          { type: "tool_use", id: "toolu_1", name: "mcp__drawer__overview", input: {} },
        ],
      },
    };
    expect(mapSdkMessage(msg)).toEqual([
      { kind: "text", text: "Reading the brief." },
      { kind: "tool_use", id: "toolu_1", name: "mcp__drawer__overview", input: {} },
    ]);
  });

  test("tool results from user messages", () => {
    const msg = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: true,
            content: [
              { type: "text", text: "conflict" },
              { type: "image", source: { type: "base64", data: "AA==", media_type: "image/png" } },
            ],
          },
        ],
      },
    };
    expect(mapSdkMessage(msg)).toEqual([{ kind: "tool_result", id: "toolu_1", isError: true, text: "conflict" }]);
  });

  test("subagent messages are ignored", () => {
    expect(mapSdkMessage({ type: "assistant", parent_tool_use_id: "toolu_9", message: { content: [{ type: "text", text: "x" }] } })).toEqual([]);
  });

  test("results: success, error result, error subtype", () => {
    expect(mapSdkMessage({ type: "result", subtype: "success", is_error: false, result: "ok" })).toEqual([{ kind: "result", ok: true, error: null }]);
    expect(mapSdkMessage({ type: "result", subtype: "success", is_error: true, result: "API Error: 529" })).toEqual([
      { kind: "result", ok: false, error: "Claude: API Error: 529" },
    ]);
    expect(mapSdkMessage({ type: "result", subtype: "error_max_turns", is_error: true, errors: [] })).toEqual([
      { kind: "result", ok: false, error: "Claude: error_max_turns" },
    ]);
    expect(mapSdkMessage({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom", "bang"] })).toEqual([
      { kind: "result", ok: false, error: "Claude: boom; bang" },
    ]);
  });

  test("other messages map to nothing", () => {
    expect(mapSdkMessage({ type: "system", subtype: "status" })).toEqual([]);
    expect(mapSdkMessage(null)).toEqual([]);
  });
});

test("foreignTools flags anything that is not drawer's", () => {
  expect(foreignTools(["mcp__drawer__overview", "Bash", "mcp__other__x"])).toEqual(["Bash", "mcp__other__x"]);
  expect(foreignTools(["mcp__drawer__overview"])).toEqual([]);
});

describe("tool results are matched to their call by tool_use id", () => {
  const out = (text: string): ToolOutput => ({ ok: true, text, summary: text, images: [], imageUrls: [`/api/renders/${text}/iso.png`] });
  const extra = (id: string) => ({ signal: new AbortController().signal, _meta: { [TOOL_USE_ID_META]: id } });

  test("the id comes from the request's _meta", () => {
    expect(toolUseIdOf(extra("toolu_7"))).toBe("toolu_7");
    expect(toolUseIdOf({})).toBeNull();
    expect(toolUseIdOf(null)).toBeNull();
  });

  test("two parallel calls of one tool finishing in reverse order keep their own results", async () => {
    const outputs = new Map<string, ToolOutput>();
    const release = new Map<string, () => void>();
    const view: BoundTool = {
      name: "view_part",
      description: "",
      input: {},
      call: async (input) => {
        const part = (input as { part: string }).part;
        await new Promise<void>((resolve) => release.set(part, resolve));
        return out(part);
      },
    };
    const handler = toolHandler(view, outputs);
    const first = handler({ part: "first" }, extra("toolu_1"));
    const second = handler({ part: "second" }, extra("toolu_2"));
    await Bun.sleep(1);
    release.get("second")?.();
    await second;
    release.get("first")?.();
    await first;
    const finished1 = toolFinished({ id: "toolu_1", isError: false, text: "" }, "view_part", outputs.get("toolu_1"));
    const finished2 = toolFinished({ id: "toolu_2", isError: false, text: "" }, "view_part", outputs.get("toolu_2"));
    expect(finished1).toMatchObject({ callId: "toolu_1", text: "first", images: ["/api/renders/first/iso.png"] });
    expect(finished2).toMatchObject({ callId: "toolu_2", text: "second", images: ["/api/renders/second/iso.png"] });
  });

  test("without an output the record comes from the tool_result", () => {
    expect(toolFinished({ id: "t", isError: true, text: "conflict\nmore" }, "write_model", undefined)).toEqual({
      type: "tool_finished",
      callId: "t",
      name: "write_model",
      ok: false,
      summary: "conflict",
      text: "conflict\nmore",
      images: [],
    });
  });
});

describe("promptMessage", () => {
  test("each message's text, then its images as base64 image blocks", () => {
    const msg = promptMessage([
      { text: "first", images: [{ mediaType: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff]) }] },
      { text: "second", images: [] },
    ]);
    expect(msg).toEqual({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } },
          { type: "text", text: "\n\nsecond" },
        ],
      },
    });
  });
});
