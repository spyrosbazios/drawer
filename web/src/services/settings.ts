import type { PatchSettingsBody, Settings } from "@drawer/shared/api";
import { settingsSchema } from "@/core/schemas";
import { api, read } from "./api";

export async function getSettings(): Promise<Settings> {
  const { data } = await api.get<unknown>("/settings");
  return read(settingsSchema, data);
}

/** Only the fields sent change. */
export async function patchSettings(body: PatchSettingsBody): Promise<Settings> {
  const { data } = await api.patch<unknown>("/settings", body);
  return read(settingsSchema, data);
}
