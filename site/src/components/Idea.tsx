import { FolderGit2, MessageSquareText, Ruler, SquareCode } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Heading, Reveal, Spotlight } from "./ui";

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: MessageSquareText,
    title: "You state intent",
    body: "Write the brief, attach a photo or a datasheet, answer the agent's one question. Afterwards you change intent only: a spec, a parameter value, a waiver, a print result. There is no model editor and no sketcher.",
  },
  {
    icon: SquareCode,
    title: "The agent models",
    body: "It reads the project, writes a spec with a tolerance on every size that matters, then writes a parametric OpenSCAD model. After every write it reads the report and fixes the first failing gate.",
  },
  {
    icon: Ruler,
    title: "The server measures and decides",
    body: "Every model is rendered and measured on the mesh: bores, gaps, walls, bed contact, overhangs, whether it fits the bed. The status comes only from those gates. Nothing trusts what the model says about itself.",
  },
  {
    icon: FolderGit2,
    title: "Files are the truth",
    body: "A project is a plain folder: brief, parts, specs, assembly, references and notes. Every attempt is a revision you can restore or compare. Notes are the project's memory.",
  },
];

export function Idea() {
  return (
    <section id="idea" aria-labelledby="idea-title" className="relative py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-8">
        <Heading id="idea-title" eyebrow="How it works" title="A person decides what. The agent decides how. The mesh decides whether.">
          Each side has one job, and the gates keep the agent honest: it cannot mark anything done, it can only make the gates pass.
        </Heading>
        <ol className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="min-w-0">
              <Reveal delay={i * 90} className="h-full">
                <Spotlight className="group h-full rounded-2xl border border-line bg-card p-6">
                  <div className="flex items-center justify-between">
                    <span className="grid size-11 place-items-center rounded-xl bg-brand-wash text-brand transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6">
                      <Icon className="size-5" aria-hidden="true" />
                    </span>
                    <span className="font-mono text-[13px] text-faint">0{i + 1}</span>
                  </div>
                  <h3 className="mt-6 text-lg font-semibold tracking-tight text-balance">{title}</h3>
                  <p className="mt-2 text-[15px] text-dim text-pretty">{body}</p>
                </Spotlight>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
