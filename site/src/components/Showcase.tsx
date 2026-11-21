import { Check, FolderOpen, MessageSquare, Boxes, ClipboardCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib";
import { SHOTS } from "@/shots";
import type { Shot } from "@/shots";
import { BrowserFrame, Heading, PhoneFrame, Reveal, ShotImg, Tilt } from "./ui";

const AUTO_MS = 7000;
/** On a phone the screenshot is cropped to this share of its width and height (a 4:5 window onto the part that matters). */
const FOCUS_W = 0.4;
const FOCUS_H = 0.8;

const STOPS: { icon: LucideIcon; label: string; shot: Shot; title: string; body: string; points: string[]; focus: { x: number; y: number } }[] = [
  {
    icon: MessageSquare,
    label: "The thread",
    shot: SHOTS.session,
    title: "Talk to the agent beside the part",
    body: "The thread shows each tool call with what came back. The agent asks before its first model and when it is blocked; the question waits for your answer with the choices it offers.",
    points: ["Its reading of the failing gate, with the code it means", "A question with Agree and Change something as answers"],
    focus: { x: 0.6, y: 0.12 },
  },
  {
    icon: ClipboardCheck,
    label: "Review",
    shot: SHOTS.review,
    title: "Review changes intent, not code",
    body: "Each gate shows what was measured, what was expected and a hint. Send a part back with a note, try a parameter value, waive a gate or record how a print came out. The agent has no tool for waiving.",
    points: ["Measured against expected, gate by gate", "Send back, what-if, waive, print result"],
    focus: { x: 0.6, y: 0.1 },
  },
  {
    icon: Boxes,
    label: "Assembly",
    shot: SHOTS.assembly,
    title: "Assemblies are measured too",
    body: "Place parts and bought hardware, state each fit as a clearance, contact or press mate, and the server reports the gap and overlap of every pair, clashes, floating parts and a bill of materials.",
    points: ["A clash between two parts, in volume", "Mates, pairs and the assembly's own gates"],
    focus: { x: 0.6, y: 0.1 },
  },
  {
    icon: FolderOpen,
    label: "Home",
    shot: SHOTS.home,
    title: "Projects, sessions and the library",
    body: "Home shows the sessions that wait for you, every project with its status, and the library every project reads.",
    points: ["A session waiting for an answer, one working, one finished", "Each project with its parts and what passed"],
    focus: { x: 0.05, y: 0.08 },
  },
];

/** The screens as tabs: the active one is shown in a browser frame and its text expands, advancing by itself until the
 *  visitor picks one (and never, with reduced motion). */
function Tour() {
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);
  const [paused, setPaused] = useState(false);
  const reduce = useReducedMotion() ?? false;
  const run = auto && !reduce;
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const pick = (i: number, focus = false) => {
    setActive(i);
    setAuto(false);
    if (focus) tabs.current[i]?.focus();
  };
  const key = (e: KeyboardEvent, i: number) => {
    const n = STOPS.length;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") pick((i + 1) % n, true);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") pick((i + n - 1) % n, true);
    else return;
    e.preventDefault();
  };

  return (
    <div className="mt-16 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.1fr)] lg:gap-12" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
      <div role="tablist" aria-label="Screens" aria-orientation="vertical" className="space-y-2 lg:order-1">
        {STOPS.map(({ icon: Icon, label, title, body, points }, i) => {
          const on = i === active;
          return (
            <div key={label} className={cn("relative overflow-hidden rounded-2xl border bg-card transition-colors", on ? "border-brand-line" : "border-line hover:border-brand-line")}>
              <button
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`tour-tab-${i}`}
                aria-selected={on}
                aria-controls={`tour-panel-${i}`}
                tabIndex={on ? 0 : -1}
                onClick={() => pick(i)}
                onKeyDown={(e) => key(e, i)}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
              >
                <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg transition-colors", on ? "bg-brand text-on-brand" : "bg-brand-wash text-brand")}>
                  <Icon className="size-[18px]" aria-hidden="true" />
                </span>
                <span className="text-[16px] font-semibold tracking-tight">{label}</span>
              </button>
              <div id={`tour-panel-${i}`} role="tabpanel" aria-labelledby={`tour-tab-${i}`} hidden={!on} className="px-4 pb-5">
                <h3 className="text-lg font-semibold tracking-tight text-balance">{title}</h3>
                <p className="mt-1.5 text-[15px] text-dim text-pretty">{body}</p>
                <ul className="mt-4 space-y-2">
                  {points.map((p) => (
                    <li key={p} className="flex items-start gap-2.5 text-[14.5px]">
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-wash text-brand">
                        <Check className="size-3" strokeWidth={3} aria-hidden="true" />
                      </span>
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              {on && run ? (
                <span
                  key={active}
                  className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brand"
                  style={{ animation: `tour-progress ${AUTO_MS}ms linear forwards`, animationPlayState: paused ? "paused" : "running" }}
                  onAnimationEnd={() => setActive((a) => (a + 1) % STOPS.length)}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="min-w-0 sm:hidden lg:order-2">
        <div className="relative overflow-hidden rounded-2xl border border-line bg-card shadow-lift ring-1 ring-hair" style={{ aspectRatio: "4 / 5" }}>
          {STOPS.map(({ shot, label, focus }, i) => (
            <ShotImg
              key={label}
              shot={shot}
              className={cn("absolute max-w-none transition-opacity duration-500", i === active ? "opacity-100" : "opacity-0")}
              style={{ width: `${100 / FOCUS_W}%`, height: "auto", left: `${(-focus.x / FOCUS_W) * 100}%`, top: `${(-focus.y / FOCUS_H) * 100}%` }}
            />
          ))}
        </div>
      </div>
      <Tilt max={3} className="hidden min-w-0 sm:block lg:order-2">
        <BrowserFrame>
          <div className="relative" style={{ aspectRatio: `${SHOTS.home.width} / ${SHOTS.home.height}` }}>
            {STOPS.map(({ shot, label }, i) => (
              <ShotImg
                key={label}
                shot={shot}
                className={cn("absolute inset-0 block h-full w-full object-cover object-top transition-opacity duration-500", i === active ? "opacity-100" : "opacity-0")}
              />
            ))}
          </div>
        </BrowserFrame>
      </Tilt>
    </div>
  );
}

function Phone() {
  return (
    <div className="mt-28 grid items-center gap-12 md:mt-36 md:grid-cols-2 lg:gap-20">
      <Reveal>
        <p className="font-mono text-[13px] tracking-[0.16em] text-brand uppercase">On the phone</p>
        <h3 className="mt-4 text-[clamp(1.75rem,3.4vw,2.6rem)] leading-[1.08] font-semibold tracking-[-0.03em] text-balance">The same workspace, below laptop width.</h3>
        <p className="mt-5 text-lg text-dim text-pretty">
          The app becomes a phone shell: outline, viewer, session and review behind a bottom bar. It is a PWA, so it installs from the browser.
        </p>
        <ul className="mt-7 space-y-3">
          {["The 3D viewer with its attempts and its status", "The thread, so you can answer the agent away from the desk", "Review: gates, parameters and Send back"].map((p) => (
            <li key={p} className="flex items-start gap-3 text-[15.5px]">
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-wash text-brand">
                <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              </span>
              {p}
            </li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={100} className="relative">
        <div className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-glow-soft blur-3xl" aria-hidden="true" />
        <Tilt max={7}>
          <PhoneFrame className="mx-auto w-full max-w-[290px]">
            <ShotImg shot={SHOTS.phone} className="block h-auto w-full" />
          </PhoneFrame>
        </Tilt>
      </Reveal>
    </div>
  );
}

export function Showcase() {
  return (
    <section id="tour" aria-labelledby="tour-title" className="relative border-y border-hair bg-card/40 py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-8">
        <Heading id="tour-title" eyebrow="A tour" title="The same app on a laptop and a phone.">
          Every screen here is the real web app, running against its built-in sample projects.
        </Heading>
        <Tour />
        <Phone />
      </div>
    </section>
  );
}
