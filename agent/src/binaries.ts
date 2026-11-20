/**
 * Which CLI the runner runs for each provider: a decision of the runner's host, read from its own
 * environment at start-up and never from the server. Unset = the provider finds its CLI itself.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ProviderKind } from "@drawer/shared/api";

export const BINARY_ENV: Record<ProviderKind, string> = {
  claude: "DRAWER_AGENT_CLAUDE_BIN",
  codex: "DRAWER_AGENT_CODEX_BIN",
  pi: "DRAWER_AGENT_PI_BIN",
  gemini: "DRAWER_AGENT_GEMINI_BIN",
};

/**
 * The configured paths, checked: each must be absolute and an existing file; the CLIs that are
 * spawned directly must also be executable (Claude Code's SDK runs a `.js` path with node). Throws
 * one message naming every bad variable.
 */
export async function providerBinaries(env: Record<string, string | undefined>): Promise<Partial<Record<ProviderKind, string>>> {
  const found: Partial<Record<ProviderKind, string>> = {};
  const problems: string[] = [];
  for (const [kind, name] of Object.entries(BINARY_ENV) as [ProviderKind, string][]) {
    const path = env[name];
    if (path === undefined || path === "") continue;
    const problem = await badPath(path, kind !== "claude");
    if (problem === null) found[kind] = path;
    else problems.push(`${name}=${path}: ${problem}`);
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  return found;
}

async function badPath(path: string, executable: boolean): Promise<string | null> {
  if (!isAbsolute(path)) return "must be an absolute path";
  try {
    if (!(await stat(path)).isFile()) return "is not a file";
  } catch {
    return "does not exist";
  }
  if (!executable) return null;
  try {
    await access(path, constants.X_OK);
    return null;
  } catch {
    return "is not executable";
  }
}
