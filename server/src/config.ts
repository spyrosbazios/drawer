import { resolve } from "node:path";
import type { ImportCredentials } from "@drawer/shared/contracts";
import { DEFAULT_PORT } from "@drawer/shared/api";
import { normalizeHostname } from "./http/guard.ts";

export interface Config {
  dataDir: string;
  port: number;
  host: string;
  /** DRAWER_ALLOWED_HOSTS: host names served besides IP literals and localhost (http/guard.ts). */
  allowedHosts: string[];
  openscadCmd: string;
  webDist: string;
  credentials: ImportCredentials;
}

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function credentials(env: Env): ImportCredentials {
  const out: ImportCredentials = {};
  const set = <K extends keyof ImportCredentials>(key: K, value: string | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  set("thingiverseToken", nonEmpty(env.THINGIVERSE_TOKEN));
  set("makerworldToken", nonEmpty(env.MAKERWORLD_TOKEN));
  set("cults3dUser", nonEmpty(env.CULTS3D_USER));
  set("cults3dKey", nonEmpty(env.CULTS3D_KEY));
  set("myminifactoryKey", nonEmpty(env.MYMINIFACTORY_KEY));
  return out;
}

/** DRAWER_ALLOWED_HOSTS: comma-separated host names (no scheme, no port), normalised for comparison. */
function allowedHosts(env: Env): string[] {
  const raw = nonEmpty(env.DRAWER_ALLOWED_HOSTS);
  if (raw === undefined) return [];
  const names = raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  for (const name of names) {
    if (!/^[A-Za-z0-9.-]+$/.test(name) || name.startsWith(".")) {
      throw new Error(`invalid DRAWER_ALLOWED_HOSTS entry "${name}": list bare host names such as drawer.lan, without scheme or port`);
    }
  }
  return names.map(normalizeHostname);
}

export function loadConfig(env: Env = process.env): Config {
  const portText = nonEmpty(env.PORT);
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid PORT: ${portText}`);
  const webDist = nonEmpty(env.DRAWER_WEB_DIST);
  return {
    dataDir: resolve(nonEmpty(env.DRAWER_DATA) ?? "./data"),
    port,
    host: nonEmpty(env.DRAWER_HOST) ?? "127.0.0.1",
    allowedHosts: allowedHosts(env),
    openscadCmd: nonEmpty(env.DRAWER_OPENSCAD) ?? "openscad",
    webDist: webDist === undefined ? resolve(import.meta.dir, "../../web/dist") : resolve(webDist),
    credentials: credentials(env),
  };
}
