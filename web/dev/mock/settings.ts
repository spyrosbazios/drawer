/** Workspace settings in memory, as the server keeps them in DRAWER_DATA/settings.json. */
import type { PatchSettingsBody, ProviderKind, ProviderSettings, Settings } from "../../../shared/src/api";
import { isModelId, PROVIDER_KINDS } from "../../../shared/src/api";
import { HttpError, broadcast } from "./http";

const fresh = (): ProviderSettings => ({ enabled: true, defaultModel: null, customModels: [] });

let settings: Settings = {
  defaultProvider: "claude",
  providers: { claude: { ...fresh(), defaultModel: "sonnet" }, codex: fresh(), pi: { ...fresh(), customModels: ["deepseek/deepseek-v4-pro"] }, gemini: { ...fresh(), enabled: false } },
};

export const getSettings = (): Settings => structuredClone(settings);

const isKind = (v: unknown): v is ProviderKind => PROVIDER_KINDS.some((k) => k === v);

/** People only, like the server: the author "agent" gets 403. */
export function patchSettings(body: PatchSettingsBody, author: string): Settings {
  if (author === "agent") throw new HttpError("forbidden", "settings are a person's decision");
  const next = structuredClone(settings);
  if (body.defaultProvider !== undefined) {
    if (!isKind(body.defaultProvider)) throw new HttpError("invalid", "no such provider");
    next.defaultProvider = body.defaultProvider;
  }
  for (const [kind, change] of Object.entries(body.providers ?? {})) {
    if (!isKind(kind)) throw new HttpError("invalid", `no such provider: ${kind}`);
    for (const key of Object.keys(change ?? {})) if (!["enabled", "defaultModel", "customModels"].includes(key)) throw new HttpError("invalid", `providers.${kind}.${key} is not a setting`);
    const models = [...(change?.customModels ?? []), ...(change?.defaultModel ? [change.defaultModel] : [])];
    if (models.some((m) => !isModelId(m))) throw new HttpError("invalid", `providers.${kind}: not a model id`);
    next.providers[kind] = { ...next.providers[kind], ...change };
  }
  if (!next.providers[next.defaultProvider].enabled) throw new HttpError("invalid", `the default provider (${next.defaultProvider}) must stay enabled: make another one the default first`);
  settings = next;
  broadcast({ type: "settings" });
  return getSettings();
}
