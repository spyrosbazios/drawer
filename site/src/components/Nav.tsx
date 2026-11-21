import { GitBranch, Moon, Sun } from "lucide-react";
import { REPO } from "@/lib";
import { useTheme } from "@/theme";
import { Brand, Container } from "./ui";

const LINKS = [
  ["How it works", "#idea"],
  ["Features", "#features"],
  ["Tour", "#tour"],
  ["Agents", "#agents"],
] as const;

export function Nav() {
  const { resolved, toggle } = useTheme();
  return (
    <header className="sticky top-0 z-50 border-b border-hair bg-bg/65 backdrop-blur-xl">
      <Container className="flex h-16 items-center justify-between gap-4">
        <a href="#top" aria-label="drawer, top of page">
          <Brand />
        </a>
        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {LINKS.map(([label, href]) => (
            <a key={href} href={href} className="rounded-full px-4 py-2 text-[15px] text-dim transition-colors hover:text-fg">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggle}
            aria-label={resolved === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
            className="grid size-10 place-items-center rounded-full text-dim transition-colors hover:bg-raised hover:text-fg"
          >
            {resolved === "dark" ? <Sun className="size-[18px]" aria-hidden="true" /> : <Moon className="size-[18px]" aria-hidden="true" />}
          </button>
          <a href={REPO} className="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-glass px-4 text-sm font-semibold transition-colors hover:border-brand-line hover:bg-raised">
            <GitBranch className="size-4 text-brand" aria-hidden="true" /> GitHub
          </a>
        </div>
      </Container>
    </header>
  );
}
