import { Box, Layers, LockKeyhole, Scale } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { LICENSE } from "@/lib";
import { Heading, Section } from "./ui";

const FACTS: { icon: LucideIcon; title: string; body: ReactNode }[] = [
  { icon: Box, title: "One container", body: "The server, the web app and OpenSCAD in one Docker image. Data is a bind-mounted folder you can read, copy and open in any editor." },
  { icon: Layers, title: "OpenSCAD with BOSL2 and MCAD", body: "A nightly OpenSCAD with the Manifold engine, headless, with BOSL2 and MCAD on the library path. A one-off library goes in the shared library project." },
  { icon: LockKeyhole, title: "No sign-in", body: "drawer has no accounts and no authentication. Keep it on a private network: your machine, your LAN or a tailnet." },
  {
    icon: Scale,
    title: "AGPL-3.0",
    body: (
      <>
        Free software under the{" "}
        <a href={LICENSE} className="underline decoration-line underline-offset-4 hover:text-fg">
          GNU Affero General Public License
        </a>
        . Read it, run it, change it.
      </>
    ),
  },
];

export function SelfHost() {
  return (
    <Section id="self-host" label="Self-hosting" className="border-t border-line">
      <Heading id="self-host">Runs on your machine, holds your files.</Heading>
      <dl className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2">
        {FACTS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex gap-4">
            <Icon className="mt-1 size-5 shrink-0 text-brand" aria-hidden="true" />
            <div>
              <dt className="font-semibold">{title}</dt>
              <dd className="mt-1 text-[15.5px] text-dim text-pretty">{body}</dd>
            </div>
          </div>
        ))}
      </dl>
    </Section>
  );
}
