import { LIBRARY_SLUG } from "@drawer/shared/api";
import { Link } from "@tanstack/react-router";
import { DownloadIcon, InfoIcon, LibraryIcon, MonitorIcon, MoonIcon, RefreshCwIcon, SettingsIcon, SlidersHorizontalIcon, SunIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { checkForUpdates } from "@/components/pwa-updates";
import { useAppearance } from "@/hooks/use-appearance";
import { useInstall } from "@/lib/install";
import { isThemeChoice } from "@/core/theme";

/** Theme, library, settings, install and update controls. */
export function AppMenu() {
  const { choice, setChoice } = useAppearance();
  const { install } = useInstall();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="App menu" className="size-10 md:size-8">
          <SettingsIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={choice} onValueChange={(v) => isThemeChoice(v) && setChoice(v)}>
          <DropdownMenuRadioItem value="light">
            <SunIcon /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/p/$slug" params={{ slug: LIBRARY_SLUG }} search={{}}>
            <LibraryIcon /> Library
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <SlidersHorizontalIcon /> Settings
          </Link>
        </DropdownMenuItem>
        {install && (
          <DropdownMenuItem onSelect={() => void install()}>
            <DownloadIcon /> Install app
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() =>
            void checkForUpdates().then(() => toast.success("Checked for updates"), () => toast.error("Could not check for updates"))
          }
        >
          <RefreshCwIcon /> Check for updates
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-2 font-normal text-faint">
          <InfoIcon className="size-3.5" /> v{__APP_VERSION__} · build {__BUILD_ID__}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

