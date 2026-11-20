import { Bot, Terminal } from "lucide-react";
import { Heading, Lead, Section } from "./ui";

export function Agents() {
  return (
    <Section id="agents" label="Any agent" className="border-t border-line">
      <Heading id="agents">Bring your own agent, or use the one built in.</Heading>
      <Lead>There is one HTTP API and no private path. The built-in agent's tools are thin calls to the same public routes the CLI uses.</Lead>
      <div className="mt-12 grid gap-6 md:grid-cols-2">
        <article className="min-w-0 rounded-xl border border-line bg-card p-6 md:p-8">
          <Terminal className="size-6 text-brand" aria-hidden="true" />
          <h3 className="mt-4 text-xl font-semibold tracking-tight">The drawer CLI and skill</h3>
          <p className="mt-2 text-[15.5px] text-dim text-pretty">
            Any coding agent that can run a command can model in drawer. The skill tells it to read the server's modelling
            guide each session, then write specs and models, read reports and record what it learned. Files stay on the
            server: the CLI keeps nothing locally but a cache of rendered pictures.
          </p>
          <pre className="mt-6 overflow-x-auto rounded-lg border border-line bg-bg p-4 font-mono text-[13px] leading-6">
            <code>
              <span className="text-faint">$ </span>drawer report box/lid --text{"\n"}
              <span className="text-warn">draft</span> 4/6  box/lid  Lid{"\n"}
              <span className="text-down">fail</span>    Thinnest wall  [min_wall]{"\n"}
              {"        "}measured 0.8 mm, expected {">="} 1.2 mm{"\n"}
              <span className="text-up">pass</span>    Builds a solid  [parses]
            </code>
          </pre>
        </article>
        <article className="min-w-0 rounded-xl border border-line bg-card p-6 md:p-8">
          <Bot className="size-6 text-brand" aria-hidden="true" />
          <h3 className="mt-4 text-xl font-semibold tracking-tight">The built-in runner</h3>
          <p className="mt-2 text-[15.5px] text-dim text-pretty">
            Start a session in the web app and a runner on your machine drives Claude Code, Codex, Pi or Gemini, whichever
            you picked. The model gets drawer's tools and nothing else: no shell, no file system, no web. A turn that shows or
            tries any other tool is stopped, and its paths reach only its own project and the shared library.
          </p>
          <p className="mt-4 text-[15.5px] text-dim text-pretty">
            The server never talks to a model provider. Each provider sits behind an adapter in the runner, which uses the
            login that CLI already has on its host.
          </p>
        </article>
      </div>
    </Section>
  );
}
