import { Download } from "lucide-react";
import { Heading, Lead, Section } from "./ui";

const SITES: [string, string][] = [
  ["Printables", "Details and files, no account needed"],
  ["Thingiverse", "Details and files, with an API token"],
  ["MakerWorld", "Details; files with an account token"],
  ["Cults3D", "Details only, by the site's policy"],
  ["MyMiniFactory", "Details only"],
];

export function Imports() {
  return (
    <Section id="imports" label="Imports" className="border-t border-line">
      <Heading id="imports">Start from a model someone already shared.</Heading>
      <Lead>
        Paste a link and drawer files the model, up to eight images and a source note with the title, author, licence and
        address under the project's references. Keep the licence; link derived parts back to it.
      </Lead>
      <ul className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {SITES.map(([name, what]) => (
          <li key={name} className="rounded-xl border border-line bg-card p-5">
            <Download className="size-[18px] text-brand" aria-hidden="true" />
            <p className="mt-3 font-semibold">{name}</p>
            <p className="mt-1 text-sm text-dim">{what}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
