import { ArrowDown, Bot, Laptop, Play, Smartphone, SquareTerminal } from "lucide-react";
import { SHOTS } from "@/shots";
import { useTheme } from "@/theme";
import { TopographyBackground } from "./topography";
import { BrowserFrame, PhoneFrame, Reveal, ScrollStage, ShotImg, buttonPrimary, buttonQuiet } from "./ui";

const SURFACES = [
  [Laptop, "Web app"],
  [Smartphone, "Phone"],
  [SquareTerminal, "CLI"],
  [Bot, "Any agent"],
] as const;

export function Hero() {
  const { resolved } = useTheme();
  return (
    <section id="top" aria-labelledby="top-title" className="relative overflow-hidden pt-16 pb-24 sm:pt-24 md:pb-36">
      {/* The topography is drawn in the text colour at low opacity, and redrawn when the theme changes (the key). It takes
          the pointer for its hill and ripples, so the content above lets pointer events through except where it needs them. */}
      <div className="topo-mask absolute inset-x-0 top-0 h-[48rem]" aria-hidden="true">
        <TopographyBackground key={resolved} className={resolved === "dark" ? "text-fg opacity-30" : "text-fg opacity-[0.17]"} levels={14} scale={1.1} />
      </div>
      <div className="pointer-events-none absolute top-[-18rem] left-1/2 h-[40rem] w-[70rem] max-w-[160vw] -translate-x-1/2 rounded-full bg-glow opacity-40 blur-[140px]" aria-hidden="true" />

      <div className="pointer-events-none relative mx-auto max-w-6xl px-4 sm:px-8">
        <ScrollStage
          title={
            <Reveal className="mx-auto max-w-5xl text-center">
              <h1 id="top-title" className="pointer-events-auto mx-auto w-fit text-[clamp(2.4rem,6.2vw,4.6rem)] leading-[1.02] font-semibold tracking-[-0.045em] text-balance">
                An agent models your parts.{" "}
                <span className="block bg-gradient-to-b from-fg via-brand to-brand bg-clip-text text-transparent">The server checks them.</span>
              </h1>
              <p className="pointer-events-auto mx-auto mt-7 w-fit max-w-2xl text-lg text-dim text-pretty sm:text-xl">
                drawer is a CAD workspace for 3D printing. You say what you need. An agent writes the model in OpenSCAD. The server renders it,
                measures the mesh against the part's spec, and decides when the part is done.
              </p>
              <div className="pointer-events-auto mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <a href="#features" className={`${buttonPrimary} w-full sm:w-auto`}>
                  See it work <ArrowDown className="size-4 transition-transform group-hover:translate-y-0.5" aria-hidden="true" />
                </a>
                <a href="#tour" className={`${buttonQuiet} w-full sm:w-auto`}>
                  <Play className="size-4 text-brand" aria-hidden="true" /> Take the tour
                </a>
              </div>
              <ul className="mt-9 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-faint">
                {SURFACES.map(([Icon, label]) => (
                  <li key={label} className="flex items-center gap-2">
                    <Icon className="size-4" aria-hidden="true" /> {label}
                  </li>
                ))}
              </ul>
            </Reveal>
          }
        >
          <Reveal delay={150} className="pointer-events-auto relative mx-auto mt-16 max-w-5xl sm:mt-20">
            <div className="pointer-events-none absolute -inset-x-10 -top-6 -bottom-10 -z-10 rounded-[3rem] bg-glow-soft blur-3xl" aria-hidden="true" />
            <BrowserFrame className="w-[94%] sm:w-[92%]">
              <ShotImg shot={SHOTS.part} eager className="block h-auto w-full" />
            </BrowserFrame>
            <PhoneFrame className="animate-float absolute right-0 -bottom-8 w-[26%] max-w-[230px] min-w-[92px] sm:-bottom-12 md:right-[-1%]">
              <ShotImg shot={SHOTS.phone} eager className="block h-auto w-full" />
            </PhoneFrame>
          </Reveal>
        </ScrollStage>
      </div>
    </section>
  );
}
