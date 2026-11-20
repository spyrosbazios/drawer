/**
 * Workspace settings: DRAWER_DATA/settings.json, one document for the whole server (not a project's).
 * It holds how each agent provider is used; logins stay with each provider's CLI on the runner's host,
 * so nothing secret is ever here. docs/SPEC.md → Settings.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isModelId, PROVIDER_KINDS, type ProviderKind, type ProviderSettings, type Settings } from "@drawer/shared/api";
import { invalid } from "./errors.ts";
import type { EventBus } from "./events.ts";
import type { Obj } from "./http/validate.ts";
import { isNodeError, Lock } from "./util.ts";

export const SETTINGS_FILE = "settings.json";

const MAX_CUSTOM_MODELS = 50;

export const isProviderKind = (value: unknown): value is ProviderKind => PROVIDER_KINDS.some((k) => k === value);

const providerDefaults = (): ProviderSettings => ({ enabled: true, defaultModel: null, customModels: [] });

export function defaultSettings(): Settings {
  return { defaultProvider: "claude", providers: { claude: providerDefaults(), codex: providerDefaults(), pi: providerDefaults(), gemini: providerDefaults() } };
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What to do with a key that is not a setting: a PATCH refuses it; the file drops it, so a key an
 * older version wrote (such as `binaryPath`, which let a client pick what the runner executes) is
 * gone after the next write instead of stopping the server.
 */
type UnknownKeys = "refuse" | "drop";

function modelId(value: unknown, where: string): string {
  const id = typeof value === "string" ? value.trim() : value;
  if (!isModelId(id)) throw invalid(`${where} must be a model id (letters, digits and . _ : / @ + -, starting with a letter or digit)`);
  return id;
}

function defaultModel(value: unknown, where: string): string | null {
  if (value === null || value === "") return null;
  return modelId(value, where);
}

function customModels(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw invalid(`${where} must be an array of model ids`);
  const ids = [...new Set(value.map((v, i) => modelId(v, `${where}[${i}]`)))];
  if (ids.length > MAX_CUSTOM_MODELS) throw invalid(`${where} may hold at most ${MAX_CUSTOM_MODELS} models`);
  return ids;
}

/** Applies the fields present in `patch` to `base`. */
function patchProvider(base: ProviderSettings, patch: unknown, where: string, unknown: UnknownKeys): ProviderSettings {
  if (!isObj(patch)) throw invalid(`${where} must be an object`);
  const next = { ...base, customModels: [...base.customModels] };
  for (const [key, value] of Object.entries(patch)) {
    const at = `${where}.${key}`;
    if (key === "enabled") {
      if (typeof value !== "boolean") throw invalid(`${at} must be a boolean`);
      next.enabled = value;
    } else if (key === "defaultModel") next.defaultModel = defaultModel(value, at);
    else if (key === "customModels") next.customModels = customModels(value, at);
    else if (unknown === "refuse") throw invalid(`${at} is not a setting`);
  }
  return next;
}

/** `base` with `patch` applied, validated as a whole. Pure; throws `invalid`. */
export function applySettingsPatch(base: Settings, patch: Obj, unknown: UnknownKeys = "refuse"): Settings {
  const next: Settings = { defaultProvider: base.defaultProvider, providers: { ...base.providers } };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "defaultProvider") {
      if (!isProviderKind(value)) throw invalid(`defaultProvider must be one of ${PROVIDER_KINDS.join(", ")}`);
      next.defaultProvider = value;
    } else if (key === "providers") {
      if (!isObj(value)) throw invalid("providers must be an object");
      for (const [kind, p] of Object.entries(value)) {
        if (!isProviderKind(kind)) throw invalid(`providers.${kind}: no such provider (known: ${PROVIDER_KINDS.join(", ")})`);
        next.providers[kind] = patchProvider(next.providers[kind], p, `providers.${kind}`, unknown);
      }
    } else if (unknown === "refuse") throw invalid(`${key} is not a setting`);
  }
  if (!next.providers[next.defaultProvider].enabled) {
    throw invalid(`the default provider (${next.defaultProvider}) must stay enabled: make another one the default first`);
  }
  return next;
}

export class SettingsStore {
  private current: Settings = defaultSettings();
  private readonly lock = new Lock();
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly bus: EventBus,
  ) {
    this.path = join(dataDir, SETTINGS_FILE);
  }

  /**
   * Reads the file. A missing file means the defaults; a file that does not parse stops the server
   * with the reason, so a hand edit is never overwritten silently. Keys that are not settings are
   * dropped (and gone from the file after the next write); known keys are validated as for a PATCH.
   */
  async init(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${this.path} is not valid JSON; fix or delete it`);
    }
    if (!isObj(parsed)) throw new Error(`${this.path} must hold a JSON object; fix or delete it`);
    try {
      this.current = applySettingsPatch(defaultSettings(), parsed, "drop");
    } catch (err) {
      throw new Error(`${this.path}: ${err instanceof Error ? err.message : String(err)}; fix or delete it`);
    }
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  async patch(body: Obj): Promise<Settings> {
    return this.lock.run(async () => {
      const next = applySettingsPatch(this.current, body);
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
      await rename(tmp, this.path);
      this.current = next;
      this.bus.emit({ type: "settings" });
      return this.get();
    });
  }
}
