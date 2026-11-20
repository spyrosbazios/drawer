/** Server URL and cache locations. */
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

const nonEmpty = (value: string | undefined): string | undefined => (value && value.length > 0 ? value : undefined);

export function stateFile(env: Env): string {
  const base = nonEmpty(env.XDG_STATE_HOME) ?? join(homedir(), ".local", "state");
  return join(base, "drawer", "server.json");
}

export function rendersDir(env: Env): string {
  const base = nonEmpty(env.XDG_CACHE_HOME) ?? join(homedir(), ".cache");
  return join(base, "drawer", "renders");
}

export function author(env: Env): string {
  return nonEmpty(env.DRAWER_AUTHOR) ?? "agent";
}

/** `DRAWER_URL`, else the saved server, else null. */
export async function resolveServerUrl(env: Env): Promise<string | null> {
  const fromEnv = nonEmpty(env.DRAWER_URL);
  if (fromEnv) return normalizeUrl(fromEnv);
  const file = Bun.file(stateFile(env));
  if (!(await file.exists())) return null;
  try {
    const saved = (await file.json()) as { url?: unknown };
    return typeof saved.url === "string" ? normalizeUrl(saved.url) : null;
  } catch {
    return null;
  }
}

export async function saveServerUrl(env: Env, url: string): Promise<string> {
  const path = stateFile(env);
  await Bun.write(path, `${JSON.stringify({ url })}\n`);
  return path;
}

export function normalizeUrl(raw: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}
