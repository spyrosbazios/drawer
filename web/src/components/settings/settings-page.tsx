import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, SettingsIcon } from "lucide-react";
import { LibrarySection } from "./library-section";
import { PrinterSection } from "./printer-section";
import { MaterialsSection } from "./materials-section";
import { AgentsSection } from "./agents-section";

/** `/settings`: workspace settings, one section per area. Add a section as a `SettingsSection`. */
export function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto scroll-contain">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-4 pb-safe md:px-6 md:py-6">
        <header className="space-y-1">
          <Link to="/" className="inline-flex items-center gap-1 text-xs text-dim hover:text-fg">
            <ArrowLeftIcon className="size-3.5" /> Projects
          </Link>
          <div className="flex items-center gap-2">
            <SettingsIcon className="size-5 text-dim" />
            <h1 className="text-lg font-medium">Settings</h1>
          </div>
        </header>
        <AgentsSection />
        <LibrarySection />
        <PrinterSection />
        <MaterialsSection />
      </div>
    </div>
  );
}
