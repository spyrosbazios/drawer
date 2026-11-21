import type { PatchSettingsBody, Settings } from "@drawer/shared/api";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { getSettings, patchSettings } from "@/services/settings";
import { sessionKeys } from "./sessions";

export const settingsKeys = {
  all: () => ["settings"] as const,
};

/** Realtime keeps it current (a `settings` event), so it never goes stale by itself. */
export const settingsQuery = () => queryOptions({ queryKey: settingsKeys.all(), queryFn: getSettings, staleTime: Infinity });

export const useSettings = () => useQuery(settingsQuery());

export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchSettingsBody) => patchSettings(body),
    onSuccess: (settings) => qc.setQueryData<Settings>(settingsKeys.all(), settings),
  });
}

/** A `settings` event: someone changed them. A runner reports what it found on its next poll, so what it said before is stale too. */
export function applySettingsEvent(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: settingsKeys.all() });
  void qc.invalidateQueries({ queryKey: sessionKeys.runners() });
}
