import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerBinaries } from "../src/binaries.ts";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawer-bins-"));
  await writeFile(join(dir, "codex"), "#!/bin/sh\n");
  await chmod(join(dir, "codex"), 0o755);
  await writeFile(join(dir, "cli.js"), "");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("unset or empty: the provider finds its CLI itself", async () => {
  expect(await providerBinaries({ DRAWER_AGENT_CODEX_BIN: "" })).toEqual({});
});

test("the runner's own environment names each CLI", async () => {
  expect(await providerBinaries({ DRAWER_AGENT_CODEX_BIN: join(dir, "codex"), DRAWER_AGENT_CLAUDE_BIN: join(dir, "cli.js") })).toEqual({
    codex: join(dir, "codex"),
    claude: join(dir, "cli.js"),
  });
});

test("a relative, missing or non-executable path stops start-up, naming the variable", async () => {
  await expect(providerBinaries({ DRAWER_AGENT_PI_BIN: "bin/pi" })).rejects.toThrow("DRAWER_AGENT_PI_BIN=bin/pi: must be an absolute path");
  await expect(providerBinaries({ DRAWER_AGENT_GEMINI_BIN: join(dir, "nope") })).rejects.toThrow("does not exist");
  await expect(providerBinaries({ DRAWER_AGENT_CODEX_BIN: join(dir, "cli.js") })).rejects.toThrow("is not executable");
  await expect(providerBinaries({ DRAWER_AGENT_CODEX_BIN: dir })).rejects.toThrow("is not a file");
});
