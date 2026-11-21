// Small animated pieces of the app drawn in JSX where a screenshot does not carry the motion: a gate list that ticks to
// green, a slider whose gate flips, an assembly clash that clears, an agent thread that types. Each one plays a short
// loop while it is on screen and shows its last frame, still, when the visitor asks for no motion.
import { useReducedMotion } from "motion/react";
import { Check, CircleDashed, LoaderCircle, Package, Printer, Ruler, SquareCode, Layers, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib";

/** Whether the element is on screen right now. */
function useVisible(ref: RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}

/** A step counter, 0 to `last`, that advances every `ms` while `ref` is on screen, holds the last step for a while and then
 *  starts over. With reduced motion it stays on `last`. */
function useLoop(ref: RefObject<HTMLElement | null>, last: number, ms: number, hold = 6) {
  const reduce = useReducedMotion() ?? false;
  const visible = useVisible(ref);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!visible || reduce) return;
    const t = setInterval(() => setN((i) => (i + 1) % (last + 1 + hold)), ms);
    return () => clearInterval(t);
  }, [visible, reduce, last, ms, hold]);
  return reduce ? last : Math.min(n, last);
}

type Verdict = "pending" | "run" | "pass" | "fail";

const PILL: Record<Verdict, string> = {
  pending: "border-line text-faint",
  run: "border-run/40 bg-run-wash text-run",
  pass: "border-up/30 bg-up-wash text-up",
  fail: "border-down/30 bg-down-wash text-down",
};
const LABEL: Record<Verdict, string> = { pending: "waiting", run: "measuring", pass: "pass", fail: "fail" };

function Pill({ v, label }: { v: Verdict; label?: string }) {
  const Icon = v === "pass" ? Check : v === "fail" ? X : v === "run" ? LoaderCircle : CircleDashed;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[12px] font-medium transition-colors duration-300", PILL[v])}>
      <Icon className={cn("size-3", v === "run" && "animate-spin")} strokeWidth={2.5} aria-hidden="true" />
      {label ?? LABEL[v]}
    </span>
  );
}

/** The part's status chip: draft in the warning colour, passed in the success one. */
function Status({ passed, children }: { passed: boolean; children: ReactNode }) {
  return (
    <span className={cn("inline-flex h-6 items-center rounded-full border px-2.5 text-[12px] font-medium transition-colors duration-300", passed ? "border-up/30 bg-up-wash text-up" : "border-warn/30 bg-warn-wash text-warn")}>
      {children}
    </span>
  );
}

const GATES = [
  ["Builds", "36 triangles"],
  ["One closed body", "1 body, watertight"],
  ["Fits the bed", "24 × 9.4 × 12 mm"],
  ["Cable bore", "6.4 mm / 6.4 ± 0.1 mm"],
  ["Height", "12 mm / 12 ± 0.2 mm"],
] as const;

/** The review panel's gate list, ticking: five gates pass, the snap arm wall fails at 1.2 mm, the agent raises the
 *  parameter, the server measures again and the part passes. */
export function GateList() {
  const ref = useRef<HTMLDivElement>(null);
  const s = useLoop(ref, 9, 650);
  const verdict = (k: number): Verdict => (s > k ? "pass" : s === k ? "run" : "pending");
  const arm: Verdict = s < 5 ? "pending" : s === 5 || s === 8 ? "run" : s >= 9 ? "pass" : "fail";
  const passes = Math.min(s, 5) + (arm === "pass" ? 1 : 0);
  const passed = arm === "pass";
  return (
    <div ref={ref} className="rounded-xl border border-line bg-bg/60">
      <ul className="divide-y divide-line">
        {GATES.map(([name, note], k) => (
          <li key={name} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-[14.5px] font-medium">{name}</p>
              <p className="truncate font-mono text-[12px] text-faint">{note}</p>
            </div>
            <Pill v={verdict(k)} />
          </li>
        ))}
        <li className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-[14.5px] font-medium">Snap arm wall</p>
            <p className="truncate font-mono text-[12px] text-faint">{passed || s === 8 ? "1.6 mm" : "1.2 mm"} / ≥ 1.6 mm</p>
          </div>
          <Pill v={arm} />
        </li>
      </ul>
      <div className={cn("flex items-center gap-2 border-t border-line px-4 py-2.5 font-mono text-[12.5px] text-dim transition-opacity duration-300", s >= 7 ? "opacity-100" : "opacity-0")} aria-hidden={s < 7}>
        <SquareCode className="size-4 shrink-0 text-brand" aria-hidden="true" />
        <span className="truncate">agent: arm_t = 1.6</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-3 text-[14px]">
        <Status passed={passed}>{passed ? "passed" : "draft"}</Status>
        <span>{passes} of 6 gates pass</span>
        <span className={cn("text-[13px] text-down transition-opacity duration-300", arm === "fail" ? "opacity-100" : "opacity-0")}>failing: Snap arm wall</span>
      </div>
    </div>
  );
}

const STEPS = [1.2, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8];

/** A parameter as a slider, the what-if the review panel offers: the wall is measured at each value, nothing is written. */
export function WhatIf() {
  const ref = useRef<HTMLDivElement>(null);
  const s = useLoop(ref, STEPS.length - 1, 600);
  const v = STEPS[s] ?? 1.2;
  const ok = v >= 1.6;
  const at = ((v - 1) / 1) * 100;
  return (
    <div ref={ref} className="space-y-4 rounded-xl border border-line bg-bg/60 p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[13px] text-dim">arm_t</span>
        <span className="font-mono text-[14px] font-medium tabular-nums">{v.toFixed(1)} mm</span>
      </div>
      <div className="relative h-6" aria-hidden="true">
        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-raised" />
        <div className={cn("absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full transition-[width,background-color] duration-500", ok ? "bg-up" : "bg-down")} style={{ width: `${at}%` }} />
        <div className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-faint" style={{ left: "60%" }} />
        <div className={cn("absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-card shadow-sm transition-[left,border-color] duration-500", ok ? "border-up" : "border-down")} style={{ left: `${at}%` }} />
      </div>
      <div className="flex items-center justify-between gap-3 text-[14px]">
        <span>Snap arm wall <span className="font-mono text-[12px] text-faint">≥ 1.6 mm</span></span>
        <Pill v={ok ? "pass" : "fail"} />
      </div>
      <p className="text-[12.5px] text-faint">A what-if. Nothing is written until you keep it.</p>
    </div>
  );
}

const OVERLAP = [504, 504, 420, 300, 180, 60, 0];

/** The assembly's pair table: the clip clashes with the tray, then is moved away and the overlap reads zero. */
export function Pairs() {
  const ref = useRef<HTMLDivElement>(null);
  const s = useLoop(ref, OVERLAP.length - 1, 650);
  const o = OVERLAP[s] ?? 0;
  const clear = o === 0;
  return (
    <div ref={ref} className="rounded-xl border border-line bg-bg/60 text-[14px]">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-line px-4 py-2 font-mono text-[11.5px] tracking-wide text-faint uppercase">
        <span>Pair</span>
        <span className="text-right">Gap</span>
        <span className="min-w-24 text-right">Overlap</span>
      </div>
      {[
        { pair: "tray × clip", overlap: o, v: clear ? "pass" : "fail", label: clear ? "ok" : "clash" },
        { pair: "tray × screw-1", overlap: 0, v: "pass", label: "ok" },
        { pair: "tray × screw-2", overlap: 0, v: "pass", label: "ok" },
      ].map((r) => (
        <div key={r.pair} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-line px-4 py-2 last:border-b-0">
          <span className="truncate">{r.pair}</span>
          <span className="font-mono text-[12.5px] text-dim tabular-nums">0 mm</span>
          <span className="flex min-w-24 items-center justify-end gap-2">
            <span className={cn("font-mono text-[12.5px] tabular-nums transition-colors", r.overlap > 0 ? "text-down" : "text-dim")}>{r.overlap} mm³</span>
            <Pill v={r.v as Verdict} label={r.label} />
          </span>
        </div>
      ))}
      <p className={cn("border-t px-4 py-2.5 text-[13px] text-dim transition-opacity duration-300", clear ? "border-transparent opacity-0" : "border-line opacity-100")} aria-hidden={clear}>
        Move clip away from tray, or mate them as a press fit.
      </p>
    </div>
  );
}

/** Types `text` once `active`, then keeps a blinking caret. Remount it (a `key`) to start over. */
function Typed({ text, active }: { text: string; active: boolean }) {
  const reduce = useReducedMotion() ?? false;
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active || reduce) return;
    const t = setInterval(() => setN((i) => Math.min(text.length, i + 1)), 28);
    return () => clearInterval(t);
  }, [active, reduce, text]);
  return (
    <>
      {text.slice(0, reduce ? text.length : n)}
      <span className={cn("ml-px inline-block h-4 w-0.5 translate-y-0.5 bg-brand", active && n < text.length ? "" : "animate-caret")} aria-hidden="true" />
    </>
  );
}

const TOOLS: [string, string][] = [
  ["write spec", "4 dimensions, ± tolerances"],
  ["write model", "cable-clip.scad"],
  ["read report", "9 of 10 gates pass"],
];

/** The agent's thread: a request, three tool steps with what came back, its reading of the failing gate, and the one
 *  question it asks, with the choices it offers. */
export function Thread() {
  const ref = useRef<HTMLDivElement>(null);
  const s = useLoop(ref, 8, 900);
  const show = (at: number) => cn("transition-[opacity,transform] duration-500", s >= at ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0");
  return (
    <div ref={ref} className="flex-1 space-y-3 rounded-xl border border-line bg-bg/60 p-4 text-[14px]">
      <p className={cn("ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md bg-raised px-3.5 py-2", show(1))}>Clip for a 6 mm cable on the 4 mm tray edge.</p>
      <ul className="space-y-1.5 font-mono text-[12.5px]">
        {TOOLS.map(([name, out], i) => {
          const done = s > i + 2;
          return (
            <li key={name} className={cn("flex items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5", show(i + 2))}>
              {done ? <Check className="size-3.5 shrink-0 text-up" strokeWidth={2.5} aria-hidden="true" /> : <LoaderCircle className="size-3.5 shrink-0 animate-spin text-run" aria-hidden="true" />}
              <span className="shrink-0">{name}</span>
              <span className="truncate text-faint">{out}</span>
            </li>
          );
        })}
      </ul>
      <p className={cn("leading-snug", show(5))}>
        <Typed key={String(s >= 5)} text="The snap arm is 1.2 mm; the library says PETG cracks under 1.6 mm." active={s >= 5} />
      </p>
      <div className={cn("rounded-xl border border-warn/40 bg-warn-wash p-3", show(7))}>
        <p className="leading-snug font-medium">Raise arm_t from 1.2 to 1.8 mm? It stays openable by hand.</p>
        <div className="mt-2.5 space-y-1.5">
          {["Agree", "Change something"].map((o, i) => (
            <span key={o} className={cn("flex items-center gap-2.5 rounded-lg border bg-card px-3 py-1.5 transition-colors duration-300", i === 0 && s >= 8 ? "border-brand bg-brand-wash" : "border-line")}>
              <span className={cn("grid size-4 place-items-center rounded-full border transition-colors duration-300", i === 0 && s >= 8 ? "border-brand bg-brand" : "border-line")}>
                {i === 0 && s >= 8 ? <Check className="size-2.5 text-on-brand" strokeWidth={3.5} aria-hidden="true" /> : null}
              </span>
              {o}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const LIBRARY = [
  [Printer, "Printer profile", "250 × 210 × 220 mm bed"],
  [Layers, "Materials", "PETG, PLA"],
  [Ruler, "Tolerance notes", "PETG arms under 1.6 mm crack"],
  [Package, "Bought parts", "M3 × 8 screw, magnets"],
] as const;

/** The shared library as a list of what every project reads. */
export function Library() {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {LIBRARY.map(([Icon, name, note], i) => (
        <li key={name} className="flex items-center gap-3 rounded-xl border border-line bg-bg/60 px-3.5 py-3 transition-colors group-hover:border-brand-line">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-wash text-brand">
            <Icon className="size-[18px]" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14.5px] font-medium">{name}</span>
            <span className="block truncate text-[12.5px] text-faint">{note}</span>
          </span>
          <Check className="hov-rise size-4 shrink-0 text-up" strokeWidth={2.5} style={{ transitionDelay: `${i * 90}ms` }} aria-hidden="true" />
        </li>
      ))}
    </ul>
  );
}
