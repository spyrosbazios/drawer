import { HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/core/format";
import { useHistory } from "@/hooks/files";

/** The file is shown as of an old revision, read-only. */
export function RevisionBanner({ slug, path, at, onBack }: { slug: string; path: string; at: string; onBack: () => void }) {
  const history = useHistory(slug, path);
  const rev = history.data?.find((r) => r.id === at);
  return (
    <output className="flex flex-wrap items-center gap-2 border-b border-line bg-raised px-3 py-2 text-sm">
      <HistoryIcon className="size-4 shrink-0 text-dim" />
      <span className="mr-auto min-w-0 truncate">
        Read-only: revision {at.slice(0, 8)}
        {rev ? ` by ${rev.author}, ${formatRelative(rev.date)}${rev.message ? ` - ${rev.message}` : ""}` : ""}
      </span>
      <Button size="sm" variant="outline" onClick={onBack}>
        Back to current
      </Button>
    </output>
  );
}
