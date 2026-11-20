import type { DrawerEvent } from "@drawer/shared/api";
import { ASSEMBLY_FILE, LIBRARY_SLUG, MATERIALS_FILE, PART_DIR, PRINTER_FILE } from "@drawer/shared/api";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { openRealtime } from "@/services/realtime";
import { applyAssemblyEvent, assemblyKeys } from "./assembly";
import { fileKeys, notAtOrUnder } from "./files";
import { libraryKeys } from "./library";
import { applyPartEvent, partKeys } from "./parts";
import { projectKeys } from "./projects";
import { searchKeys } from "./search";
import { applyRenderProgress } from "./render-progress";
import { applySessionEvent } from "./sessions";
import { applySettingsEvent } from "./settings";

/** What a server event makes stale. Lists are sorted and filtered, so invalidating beats patching, except where events are frequent. */
export function applyEvent(qc: QueryClient, e: DrawerEvent): void {
  const inv = (queryKey: readonly unknown[]) => void qc.invalidateQueries({ queryKey });
  switch (e.type) {
    case "project":
      inv(projectKeys.list());
      if (e.action === "deleted") {
        qc.removeQueries({ queryKey: projectKeys.detail(e.slug) });
        qc.removeQueries({ queryKey: projectKeys.overview(e.slug) });
      } else {
        inv(projectKeys.detail(e.slug));
        inv(projectKeys.overview(e.slug));
      }
      break;
    case "file":
      inv(fileKeys.tree(e.project));
      // The server announces a move as `deleted` for the old path and `moved` for the new one; either path
      // may be a folder. A deleted path is never refetched: for a viewer still showing it, that is a 404.
      if (e.action !== "deleted") inv(["file", e.project, e.path]);
      // Links in other files may point at this one, so every other info of the project is stale.
      void qc.invalidateQueries({ queryKey: ["info", e.project], predicate: e.action === "deleted" ? notAtOrUnder(e.path) : undefined });
      inv(["history", e.project]);
      inv(projectKeys.detail(e.project));
      inv(projectKeys.list());
      inv(projectKeys.overview(e.project));
      inv(searchKeys.project(e.project));
      // A spec or model write is followed by `part` events; a spec's title or class only shows in the list.
      if (e.path === PART_DIR || e.path.startsWith(`${PART_DIR}/`)) inv(partKeys.list(e.project));
      if (e.path === ASSEMBLY_FILE) inv(assemblyKeys.report(e.project));
      if (e.project === LIBRARY_SLUG && (e.path === PRINTER_FILE || e.path === MATERIALS_FILE)) inv(libraryKeys.profile());
      break;
    case "render":
      break;
    case "render_progress":
      applyRenderProgress(qc, e, Date.now());
      break;
    case "part":
      applyPartEvent(qc, e);
      break;
    case "assembly":
      applyAssemblyEvent(qc, e);
      break;
    case "session":
      applySessionEvent(qc, e);
      break;
    case "settings":
      applySettingsEvent(qc);
      break;
  }
}

/** Every query family the event stream keeps current: refreshed after a reconnect, when events were missed. */
const STREAMED = ["projects", "project", "tree", "file", "info", "history", "search", "overview", "parts", "part", "assembly", "sessions", "library-profile", "settings"];

/** Mounted once in the root: keeps every open screen current within a second, with no polling. */
export function useRealtimeSync(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      openRealtime(
        (e) => applyEvent(qc, e),
        () => {
          for (const key of STREAMED) void qc.invalidateQueries({ queryKey: [key] });
        },
      ),
    [qc],
  );
}
