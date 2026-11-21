import { GitBranch } from "lucide-react";
import { REPO } from "@/lib";
import { Brand, Container } from "./ui";

export function Footer() {
  return (
    <footer className="border-t border-hair">
      <Container className="flex flex-col gap-6 py-12 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <Brand />
          <p className="text-[15px] text-dim">A CAD workspace where an agent models and the mesh decides.</p>
        </div>
        <a href={REPO} className="inline-flex w-fit items-center gap-2 rounded-full border border-line bg-glass px-4 py-2 text-sm font-semibold transition-colors hover:border-brand-line hover:bg-raised">
          <GitBranch className="size-4 text-brand" aria-hidden="true" /> GitHub
        </a>
      </Container>
    </footer>
  );
}
