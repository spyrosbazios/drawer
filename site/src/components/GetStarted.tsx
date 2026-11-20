import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { REPO } from "@/lib";
import { Heading, Lead, Section } from "./ui";

const COMMANDS = [`git clone ${REPO}.git`, "cd drawer", "cp .env.example .env", "docker compose up -d"];

export function GetStarted() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(COMMANDS.join("\n")).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => setCopied(false),
    );
  };
  return (
    <Section id="get-started" label="Get started" className="border-t border-line">
      <Heading id="get-started">Four commands on any machine with Docker.</Heading>
      <Lead>
        Compose pulls the image and publishes the app on port 3050 of the loopback address. Import tokens are optional and
        go in <code className="font-mono text-[0.9em] text-fg">.env</code>; Printables needs none.
      </Lead>
      <div className="mt-10 max-w-2xl overflow-hidden rounded-xl border border-line bg-card shadow-frame">
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <span className="font-mono text-[12.5px] text-faint">shell</span>
          <button type="button" onClick={copy} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-dim transition-colors hover:bg-raised hover:text-fg">
            {copied ? <Check className="size-3.5 text-up" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="overflow-x-auto p-5 font-mono text-[13.5px] leading-7">
          <code>
            {COMMANDS.map((c) => (
              <span key={c} className="block">
                <span className="text-faint select-none">$ </span>
                {c}
              </span>
            ))}
          </code>
        </pre>
      </div>
      <p className="mt-6 text-[16px] text-dim">
        Then open <span className="font-mono text-fg">http://localhost:3050</span>. To let an outside agent in, install the
        drawer CLI and the skill from the repository and point it at the server with{" "}
        <code className="font-mono text-[0.9em] text-fg">drawer server &lt;url&gt;</code>.
      </p>
      <span className="sr-only" aria-live="polite">
        {copied ? "Commands copied" : ""}
      </span>
    </Section>
  );
}
