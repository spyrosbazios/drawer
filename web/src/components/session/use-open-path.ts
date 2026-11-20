import { ASSEMBLY_FILE } from "@drawer/shared/api";
import { partIdOf } from "@/core/parts";
import { useProjectNav } from "@/lib/nav";
import type { ThreadActions } from "./thread-context";

/** The workspace's own way to open a project path, as the outline does it. */
export function useOpenPath(slug: string): Pick<ThreadActions, "openPart" | "openPath"> {
  const nav = useProjectNav(slug);
  return {
    openPart: nav.selectPart,
    openPath: (path) => {
      const part = partIdOf(path);
      if (part) nav.selectPart(part);
      else if (path === ASSEMBLY_FILE) nav.selectAssembly();
      else nav.selectFile(path);
    },
  };
}
