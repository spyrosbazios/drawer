import type { AssemblyReport, PartSummary } from "@drawer/shared/api";
import type { Selection } from "@/lib/route-search";

/**
 * Where a project opens when the address selects nothing: the assembly when there is one, else the first
 * printed part, else the first part. null = the project has neither, so there is nothing to open and the
 * centre offers to kick it off instead.
 */
export function defaultSelection(parts: readonly PartSummary[], assembly: AssemblyReport | null | undefined, isLibrary: boolean): Selection | null {
  if (assembly && !isLibrary) return { kind: "assembly" };
  const first = parts.find((p) => p.source === "printed") ?? parts[0];
  return first ? { kind: "part", part: first.id } : null;
}
