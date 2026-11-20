import type { Project } from "@drawer/shared/api";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { ProjectCover } from "@/components/project-cover";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative } from "@/core/format";
import { cn } from "@/lib/utils";
import { SORT_KEYS } from "@/lib/route-search";
import { ProjectStatusChip, statusLine } from "./project-status";
import type { SortDir, SortKey } from "@/lib/route-search";

const meta = (p: Project) => formatRelative(p.updatedAt);

export function ProjectCard({ project }: { project: Project }) {
  return (
    <Link
      to="/p/$slug"
      params={{ slug: project.slug }}
      search={{}}
      className="group flex flex-col overflow-hidden rounded-xl border border-line bg-card transition-colors hover:border-faint focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <ProjectCover thumbnail={project.thumbnail} className="aspect-[4/3] w-full" />
      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="truncate font-medium">{project.title}</h3>
        <StatusRow project={project} />
        <p className="mt-auto text-xs text-faint">{meta(project)}</p>
      </div>
    </Link>
  );
}

/** The phone's list: one row per project, thumbnail on the left. */
export function ProjectRow({ project }: { project: Project }) {
  return (
    <Link
      to="/p/$slug"
      params={{ slug: project.slug }}
      search={{}}
      className="flex min-h-16 items-center gap-3 rounded-xl border border-line bg-card p-2 active:bg-raised"
    >
      <ProjectCover thumbnail={project.thumbnail} className="size-14 shrink-0 rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="truncate font-medium">{project.title}</h3>
        <StatusRow project={project} />
      </div>
    </Link>
  );
}

/** The roll-up chip and, when there are parts, their counts: one line. */
export function StatusRow({ project }: { project: Project }) {
  const line = statusLine(project);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ProjectStatusChip project={project} />
      {line && <span className="truncate text-xs text-dim">{line}</span>}
    </div>
  );
}

export function ProjectSkeletons({ view }: { view: "grid" | "list" | "table" }) {
  if (view === "table") {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-11" />
        ))}
      </div>
    );
  }
  if (view === "list") {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-xl" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4" aria-busy="true">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-64 rounded-xl" />
      ))}
    </div>
  );
}

export function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDownIcon className="size-3.5 text-faint" />;
  return dir === "asc" ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />;
}

export const isSortKey = (v: string): v is SortKey => SORT_KEYS.some((k) => k === v);

export function SourceBadge({ project, className }: { project: Project; className?: string }) {
  if (!project.source) return <span className={cn("text-faint", className)}>-</span>;
  return (
    <Badge variant="outline" className={cn("font-normal capitalize", className)}>
      {project.source.site}
    </Badge>
  );
}
