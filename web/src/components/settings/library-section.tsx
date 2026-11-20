import { LIBRARY_SLUG } from "@drawer/shared/api";
import { Link } from "@tanstack/react-router";
import { BotIcon, LibraryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTree } from "@/hooks/files";
import { useLibraryParts, useLibraryProfile } from "@/hooks/library";
import { SettingsSection } from "./settings-section";

const isNote = (path: string) => path.endsWith(".md") && path !== "AGENTS.md" && (!path.includes("/") || path.startsWith("notes/"));
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Settings: what the library holds, and the way into it. Its setup is a session with the agent, in the library's workspace. */
export function LibrarySection() {
  const profile = useLibraryProfile();
  const tree = useTree(LIBRARY_SLUG);
  const parts = useLibraryParts();
  const loading = profile.isPending || tree.isPending || parts.isPending;
  const notes = (tree.data ?? []).filter((e) => e.type === "file" && isNote(e.path)).length;
  const unset = profile.data?.printerIsExample ?? false;
  return (
    <SettingsSection id="library" icon={<LibraryIcon className="size-4 text-faint" />} title="Library">
      <div className="flex flex-wrap items-center gap-3">
        {loading ? (
          <Skeleton className="h-5 w-64" />
        ) : (
          <p className="mr-auto text-sm text-dim">
            {count(notes, "note")} · {count(parts.data?.length ?? 0, "bought part")} ·{" "}
            {unset ? <span className="text-warn">printer not set up</span> : profile.data?.printer.name}
          </p>
        )}
        <Button asChild variant={unset ? "default" : "outline"} className="ml-auto">
          <Link to="/p/$slug" params={{ slug: LIBRARY_SLUG }} search={{}}>
            {unset ? <BotIcon /> : <LibraryIcon />}
            {unset ? "Set up with the agent" : "Open library"}
          </Link>
        </Button>
      </div>
    </SettingsSection>
  );
}
