import { GitBranch } from "lucide-react";
import { LICENSE, REPO } from "@/lib";
import { Brand, Container } from "./ui";

export function Footer() {
  return (
    <footer className="border-t border-line">
      <Container className="flex flex-col gap-6 py-12 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <Brand />
          <p className="text-[15px] text-dim">Self-hosted, no sign-in, keep it on a private network.</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-[15px] text-dim">
          <a href={LICENSE} className="underline decoration-line underline-offset-4 hover:text-fg">
            AGPL-3.0
          </a>
          <a href={REPO} className="inline-flex items-center gap-2 hover:text-fg">
            <GitBranch className="size-4 text-brand" aria-hidden="true" /> spyrosbazios/drawer
          </a>
        </div>
      </Container>
    </footer>
  );
}
