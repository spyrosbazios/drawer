import { FolderGit2, MessageSquareText, Ruler, SquareCode } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Heading, Lead, Section } from "./ui";

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
    body: "Every model is rendered and measured on the mesh: bores, gaps, walls, bed contact, overhangs, whether it fits the bed. The status comes only from those gates. No client can set it, and nothing trusts what the model says about itself.",
  },
  {
    icon: FolderGit2,
    title: "Files are the truth",
    body: "A project is a plain folder: brief, parts, specs, assembly, references and notes. The server keeps each one as a git repository, so every attempt is a revision you can restore or compare. Notes are the project's memory.",
  },
];

export function Idea() {
  return (
    <Section id="idea" label="How it works">
      <Heading id="idea">A person decides what. The agent decides how. The mesh decides whether.</Heading>
      <Lead>Each side has one job, and the gates keep the agent honest: it cannot mark anything done, it can only make the gates pass.</Lead>
      <ol className="mt-14 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="bg-card p-6 md:p-8">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-brand-wash text-brand">
                <Icon className="size-[18px]" aria-hidden="true" />
              </span>
              <span className="font-mono text-[13px] text-faint">0{i + 1}</span>
            </div>
            <h3 className="mt-5 text-xl font-semibold tracking-tight">{title}</h3>
            <p className="mt-2 text-[15.5px] text-dim text-pretty">{body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
