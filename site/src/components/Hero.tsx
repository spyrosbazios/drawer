import { ArrowDown, GitBranch } from "lucide-react";
import { REPO } from "@/lib";
import { SHOTS } from "@/shots";
import { Container, Frame, buttonPrimary, buttonQuiet } from "./ui";

export function Hero() {
  return (
    <section id="top" aria-labelledby="top-title" className="relative overflow-hidden pt-16 md:pt-24">
      <div className="grid-paper pointer-events-none absolute inset-x-0 top-0 h-[44rem] opacity-60" aria-hidden="true" />
      <Container className="relative">
        <p className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 font-mono text-[12.5px] text-dim">
          Open source, self-hosted, OpenSCAD inside
        </p>
        <h1 id="top-title" className="mt-6 max-w-4xl text-[clamp(2.4rem,6.4vw,4.6rem)] leading-[1.02] font-semibold tracking-[-0.045em] text-balance">
          An agent models your parts. The server checks them.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-dim text-pretty md:text-xl">
          drawer is a CAD workspace for 3D printing that you run yourself. You say what you need. An agent writes the
          model in OpenSCAD. The server renders it, measures the mesh against the part's spec, and decides when the part is
          done.
        </p>
        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          <a href="#get-started" className={buttonPrimary}>
            <ArrowDown className="size-4" aria-hidden="true" /> Run your own
          </a>
          <a href={REPO} className={buttonQuiet}>
            <GitBranch className="size-4 text-brand" aria-hidden="true" /> See the source
          </a>
        </div>
        <Frame shot={SHOTS.part} eager className="mt-14 md:mt-20" />
      </Container>
    </section>
  );
}
