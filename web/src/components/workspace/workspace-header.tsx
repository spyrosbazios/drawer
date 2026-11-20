import type { Project } from "@drawer/shared/api";
import { LIBRARY_SLUG } from "@drawer/shared/api";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PanelRightCloseIcon, PanelRightOpenIcon, SettingsIcon } from "lucide-react";
import { AppLogo } from "@/components/app-logo";
import { AppMenu } from "@/components/app-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActivityDot } from "./activity";
import type { Activity } from "./activity";
import { AddMenu } from "./add-menu";

interface Props {
  slug: string;
  project: Project | undefined;
  desktop: boolean;
  addMenu: Omit<Parameters<typeof AddMenu>[0], "iconOnly">;
  onSettings: () => void;
  /** Laptop only: the two side panels and their toggles. */
  outlineOpen: boolean;
  onToggleOutline: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** The agent's state, shown as a dot on the right-panel toggle while that panel is collapsed. */
  activity: Activity | null;
}

function Toggle({ label, shortcut, onClick, children }: { label: string; shortcut?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-8" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-2 text-faint">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The one bar: logo and project name, then what applies to the project as a whole (add, settings, the side
 * panels, the app menu). Nothing about the agent lives here but a dot; the agent has its own panel.
 */
export function WorkspaceHeader({ slug, project, desktop, addMenu, onSettings, outlineOpen, onToggleOutline, panelOpen, onTogglePanel, activity }: Props) {
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
          <Button variant="ghost" size="icon" className="size-10" aria-label="Project settings" onClick={onSettings}>
            <SettingsIcon />
          </Button>
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
        <Toggle label="Project settings" onClick={onSettings}>
          <SettingsIcon />
        </Toggle>
        <Toggle label={outlineOpen ? "Hide the sidebar" : "Show the sidebar"} shortcut="Ctrl B" onClick={onToggleOutline}>
          {outlineOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
        </Toggle>
        <Toggle label={panelOpen ? "Hide the side panel" : "Show the side panel"} onClick={onTogglePanel}>
          {panelOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
          {!panelOpen && <ActivityDot activity={activity} className="absolute top-1 right-1 ring-2 ring-card" />}
        </Toggle>
        <AppMenu />
      </div>
    </header>
  );
}
