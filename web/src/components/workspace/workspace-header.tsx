import type { Project } from "@drawer/shared/api";
import { LIBRARY_SLUG } from "@drawer/shared/api";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { AppLogo } from "@/components/app-logo";
import { AppMenu } from "@/components/app-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AddMenu } from "./add-menu";

interface Props {
  slug: string;
  project: Project | undefined;
  desktop: boolean;
  addMenu: Omit<Parameters<typeof AddMenu>[0], "iconOnly">;
}

/**
 * The one bar: logo and project name, then add and the app menu. Nothing about the agent, the side panels or
 * the project's settings lives here: each side panel folds itself, and the settings are in the centre's menubar.
 */
export function WorkspaceHeader({ slug, project, desktop, addMenu }: Props) {
  const title = slug === LIBRARY_SLUG ? "Library" : (project?.title ?? slug);

  if (!desktop) {
    return (
      <header className="pt-safe shrink-0 border-b border-line bg-card px-1">
        <div className="flex h-14 items-center gap-1">
          <Button asChild variant="ghost" size="icon" className="size-10" aria-label="All projects">
            <Link to="/">
              <ArrowLeftIcon />
            </Link>
          </Button>
          <h1 className="min-w-0 flex-1 truncate font-medium">{project ? title : <Skeleton className="h-5 w-32" />}</h1>
          <AddMenu {...addMenu} iconOnly />
          <AppMenu />
        </div>
      </header>
    );
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-card px-4">
      <AppLogo />
      <span className="text-faint" aria-hidden>
        /
      </span>
      <h1 className="min-w-0 flex-1 truncate font-medium">{project ? title : <Skeleton className="h-5 w-32" />}</h1>
      <div className="flex shrink-0 items-center gap-1">
        <AddMenu {...addMenu} />
        <AppMenu />
      </div>
    </header>
  );
}
