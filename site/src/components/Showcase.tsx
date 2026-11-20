import { SHOTS } from "@/shots";
import type { Shot } from "@/shots";
import { Frame, Heading, Lead, Section } from "./ui";

const STOPS: { shot: Shot; title: string; body: string }[] = [
  {
    shot: SHOTS.home,
    title: "Projects, sessions and the shared library",
    body: "Home shows the sessions that wait for you, every project with its status, and the library every project reads: the printer profile, materials, tolerance notes and bought parts such as screws and magnets.",
  },
  {
    shot: SHOTS.session,
    title: "Talk to the agent beside the part",
    body: "The thread shows each tool call with what came back. The agent asks before its first model and when it is blocked; the question waits for your answer with the choices it offers.",
  },
  {
    shot: SHOTS.review,
    title: "Review changes intent, not code",
    body: "Each gate shows what was measured, what was expected and a hint. You can send a part back with a note, try a parameter value as a what-if before anything is written, waive a gate or record how a print came out. The agent has no tool for waiving.",
  },
  {
    shot: SHOTS.assembly,
    title: "Assemblies are measured too",
    body: "Place parts and bought hardware, state each fit as a clearance, contact or press mate, and the server reports the gap and overlap of every pair, clashes, floating parts and a bill of materials.",
  },
];

export function Showcase() {
  return (
    <Section id="tour" label="A tour" className="border-t border-line">
      <Heading id="tour">The same app on a laptop and a phone.</Heading>
      <Lead>Every screen here is the real web app, running against its built-in sample projects.</Lead>
      <div className="mt-16 space-y-20 md:space-y-28">
        {STOPS.map(({ shot, title, body }) => (
          <figure key={title} className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.2fr)] lg:gap-12">
            <figcaption>
              <h3 className="text-2xl font-semibold tracking-tight text-balance">{title}</h3>
              <p className="mt-3 text-[16px] text-dim text-pretty">{body}</p>
            </figcaption>
            <Frame shot={shot} />
          </figure>
        ))}
        <figure className="grid items-center gap-10 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <figcaption className="md:order-2">
            <h3 className="text-2xl font-semibold tracking-tight text-balance">On the phone, the same workspace</h3>
            <p className="mt-3 text-[16px] text-dim text-pretty">
              Below laptop width the app becomes a phone shell: outline, viewer, session and review behind a bottom bar. It
              is a PWA, so it installs from the browser.
            </p>
          </figcaption>
          <Frame shot={SHOTS.phone} className="mx-auto w-full max-w-[300px] rounded-[2rem] md:order-1" />
        </figure>
      </div>
    </Section>
  );
}
