import { ArrowUp } from "lucide-react";
import { buttonQuiet, Reveal } from "./ui";

export function Closing() {
  return (
    <section id="done" aria-labelledby="done-title" className="relative overflow-hidden border-t border-hair">
      <div className="pointer-events-none absolute top-1/2 left-1/2 h-[28rem] w-[56rem] max-w-[150vw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-glow opacity-40 blur-[130px]" aria-hidden="true" />
      <Reveal className="relative mx-auto max-w-3xl px-4 py-28 text-center sm:px-8 md:py-40">
        <h2 id="done-title" className="text-[clamp(2.25rem,6vw,4.25rem)] leading-[1.02] font-semibold tracking-[-0.04em] text-balance">
          A part is done when the mesh says so.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg text-dim text-pretty">
          You state what you need and review what comes back. The agent models, the server measures, and nobody marks anything finished by hand.
        </p>
        <div className="mt-10 flex justify-center">
          <a href="#top" className={buttonQuiet}>
            <ArrowUp className="size-4 text-brand" aria-hidden="true" /> Back to the top
          </a>
        </div>
      </Reveal>
    </section>
  );
}
