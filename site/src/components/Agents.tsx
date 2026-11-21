import { Bot, Check, Terminal, X } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib";
import { Heading, Reveal, Spotlight, useSeen } from "./ui";

const PROVIDERS = ["Claude Code", "Codex", "Pi", "Gemini"];

/** The CLI's report, typed line by line the first time it is seen. */
const REPORT: { text: string; kind: "cmd" | "warn" | "down" | "plain" | "up" }[] = [
  { text: "drawer report box/lid --text", kind: "cmd" },
  { text: "draft 4/6  box/lid  Lid", kind: "warn" },
  { text: "fail    Thinnest wall  [min_wall]", kind: "down" },
  { text: "        measured 0.8 mm, expected >= 1.2 mm", kind: "plain" },
  { text: "pass    Builds a solid  [parses]", kind: "up" },
];

function Report() {
  const ref = useRef<HTMLPreElement>(null);
  const seen = useSeen(ref);
  const reduce = useReducedMotion() ?? false;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!seen || reduce) return;
    const t = setInterval(() => setShown((n) => Math.min(REPORT.length, n + 1)), 520);
    return () => clearInterval(t);
  }, [seen, reduce]);
  const count = reduce ? REPORT.length : shown;
  const tone = { cmd: "", warn: "text-warn", down: "text-down", plain: "text-dim", up: "text-up" };
  return (
    <pre ref={ref} className="mt-auto min-h-[8.5rem] overflow-x-auto rounded-xl border border-line bg-bg p-4 font-mono text-[13px] leading-6" aria-label="Output of drawer report">
      <code>
        {REPORT.map((l, i) => (
          <span key={l.text} className={cn("block transition-opacity duration-300", tone[l.kind], i < count ? "opacity-100" : "opacity-0")}>
            {l.kind === "cmd" ? <span className="text-faint">$ </span> : null}
            {l.text}
          </span>
        ))}
      </code>
    </pre>
  );
}

const TURN: { tool: string; ok: boolean }[] = [
  { tool: "drawer: write spec", ok: true },
  { tool: "drawer: write model", ok: true },
  { tool: "drawer: read report", ok: true },
  { tool: "shell", ok: false },
];

/** What the runner lets a turn use: drawer's tools, and a stop at anything else. */
function Guard() {
  return (
    <ul className="mt-auto space-y-1.5 rounded-xl border border-line bg-bg p-3 font-mono text-[13px]">
      {TURN.map(({ tool, ok }, i) => (
        <li
          key={tool}
          className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors duration-300", ok ? "group-hover:bg-up-wash" : "bg-down-wash text-down")}
          style={{ transitionDelay: ok ? `${i * 120}ms` : undefined }}
        >
          {ok ? <Check className="size-3.5 text-up" strokeWidth={2.5} aria-hidden="true" /> : <X className="size-3.5" strokeWidth={2.5} aria-hidden="true" />}
          <span className="flex-1">{tool}</span>
          <span className={cn("text-[12px]", ok ? "text-faint" : "")}>{ok ? "allowed" : "turn stopped"}</span>
        </li>
      ))}
    </ul>
  );
}

export function Agents() {
  return (
    <section id="agents" aria-labelledby="agents-title" className="relative py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-8">
        <Heading id="agents-title" eyebrow="Any agent" title="Bring your own agent, or use the one built in.">
          There is one HTTP API and no private path. The built-in agent's tools are thin calls to the same public routes the CLI uses.
        </Heading>
        <div className="mt-16 grid gap-4 md:grid-cols-2">
          <Reveal className="min-w-0">
            <Spotlight className="group flex h-full flex-col rounded-2xl border border-line bg-card p-6 md:p-8">
              <span className="grid size-11 place-items-center rounded-xl bg-brand-wash text-brand">
                <Terminal className="size-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-xl font-semibold tracking-tight">The drawer CLI and skill</h3>
              <p className="mt-2 text-[15.5px] text-dim text-pretty">
                Any coding agent that can run a command can model in drawer. The skill tells it to read the server's modelling guide each session, then write
                specs and models, read reports and record what it learned. Files stay on the server: the CLI keeps nothing locally but a cache of rendered
                pictures.
              </p>
              <Report />
            </Spotlight>
          </Reveal>
          <Reveal delay={100} className="min-w-0">
            <Spotlight className="group flex h-full flex-col rounded-2xl border border-line bg-card p-6 md:p-8">
              <span className="grid size-11 place-items-center rounded-xl bg-brand-wash text-brand">
                <Bot className="size-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-xl font-semibold tracking-tight">The built-in runner</h3>
              <p className="mt-2 text-[15.5px] text-dim text-pretty">
                Start a session in the web app and a runner on your machine drives the agent you picked. The model gets drawer's tools and nothing else: no
                shell, no file system, no web. A turn that tries any other tool is stopped, and its paths reach only its own project and the shared library.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {PROVIDERS.map((p) => (
                  <span key={p} className="inline-flex h-8 items-center rounded-full border border-line px-3 text-[13px] font-medium text-dim transition-colors hover:border-brand-line hover:text-fg">
                    {p}
                  </span>
                ))}
              </div>
              <Guard />
            </Spotlight>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
