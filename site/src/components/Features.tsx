import { GitCompareArrows, History } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib";
import { SHOTS } from "@/shots";
import { GateList, Library, Pairs, Thread, WhatIf } from "./mocks";
import { Crop, Heading, PhoneFrame, Reveal, ShotImg, Spotlight } from "./ui";

/** One tile of the grid: a short title, a sentence, and the feature drawn below it. `className` places the tile in the grid. */
function Tile({ title, text, className, delay = 0, children }: { title: string; text: string; className?: string; delay?: number; children: ReactNode }) {
  return (
    <Reveal delay={delay} className={cn("min-w-0", className)}>
      <Spotlight className="group flex h-full flex-col rounded-2xl border border-line bg-card p-5 sm:p-6">
        <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
        <p className="mt-1.5 max-w-md text-[15.5px] text-dim text-pretty">{text}</p>
        <div className="mt-5 flex flex-1 flex-col justify-end">{children}</div>
      </Spotlight>
    </Reveal>
  );
}

/** The attempt tree from the session screen, with the two things you can do with an attempt appearing on hover. */
function Attempts() {
  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="hov-zoom origin-left">
          <Crop shot={SHOTS.session} x={0.18} y={0.85} w={0.27} h={0.105} />
        </div>
      </div>
      <div className="hov-rise mt-3 flex flex-wrap gap-2">
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-card px-3 text-[13px] font-medium shadow-sm">
          <GitCompareArrows className="size-3.5 text-brand" aria-hidden="true" /> Compare r3 and r5
        </span>
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-card px-3 text-[13px] font-medium shadow-sm">
          <History className="size-3.5 text-brand" aria-hidden="true" /> Restore
        </span>
      </div>
    </div>
  );
}

export function Features() {
  return (
    <section id="features" aria-labelledby="features-title" className="relative py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-8">
        <Heading id="features-title" eyebrow="Features" title="Watch the work get done.">
          The gates, the thread, the attempts and the assembly, as the app shows them. Hover a tile to play it.
        </Heading>
        <div className="mt-16 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Tile className="md:col-span-2" title="The mesh decides." text="Every model is rendered and measured: bores, walls, gaps, bed contact, overhangs. The status comes only from those gates, and no client can set it.">
            <GateList />
          </Tile>
          <Tile className="lg:row-span-2" delay={80} title="The agent shows its work." text="Each tool call is a step in the thread, with what came back. It asks before its first model, and when it is blocked.">
            <Thread />
          </Tile>
          <Tile delay={40} title="Try a value first." text="Slide a parameter and watch the gates re-measure, before anything is written.">
            <WhatIf />
          </Tile>
          <Tile className="md:col-span-2 lg:col-span-1" delay={80} title="Every attempt is kept." text="Each write is a revision of a plain git folder. Restore one, or compare two on the model.">
            <Attempts />
          </Tile>
          <Tile className="md:col-span-2" title="Assemblies are measured too." text="State each fit as a clearance, contact or press mate. The server reports the gap and overlap of every pair, clashes and floating parts.">
            <Pairs />
          </Tile>
          <Tile className="md:col-span-2 lg:col-span-1 lg:row-span-2" delay={80} title="A phone shell, installable." text="Below laptop width the app is outline, viewer, session and review behind a bottom bar. It is a PWA.">
            <PhoneFrame className="mx-auto w-full max-w-[250px]">
              <ShotImg shot={SHOTS.phone} className="hov-zoom block h-auto w-full origin-top" />
            </PhoneFrame>
          </Tile>
          <Tile className="md:col-span-2" title="One shared library." text="The printer profile, materials, tolerance notes and bought parts that every project reads.">
            <Library />
          </Tile>
        </div>
      </div>
    </section>
  );
}
