// The small parts every section shares: scroll reveal, the hero's rising stage, a card that lights under the pointer,
// a frame that leans toward it, the section heading, the brand mark, and the frames the screenshots sit in.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode, RefObject } from "react";
import icon from "../../../assets/icon.svg";
import { cn } from "@/lib";
import type { Shot } from "@/shots";
import { useTheme } from "@/theme";

export function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <img src={icon} alt="" width={28} height={28} className="size-7" />
      <span className="text-[17px] font-semibold tracking-tight">drawer</span>
    </span>
  );
}

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-8", className)}>{children}</div>;
}

/** Rises and fades in once, when it scrolls into view (index.css .reveal). */
export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          el.dataset.in = "";
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={cn("reveal", className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/** True once the element has been on screen, for pieces that play a sequence the first time they are seen. */
export function useSeen(ref: RefObject<HTMLElement | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return seen;
}

/** How far `watch` has risen into the viewport, 0 (its top at the bottom edge) to 1 (its top `settle` of the way up), as
 *  a CSS variable on `ref`'s element, followed on scroll and resize without a re-render. */
function useRise(ref: RefObject<HTMLDivElement | null>, watch: RefObject<HTMLDivElement | null>, name: string, settle = 0.18) {
  useEffect(() => {
    const el = ref.current;
    const w = watch.current;
    if (!el || !w || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const tick = () => {
      raf = 0;
      const vh = innerHeight;
      const p = Math.min(1, Math.max(0, (vh - w.getBoundingClientRect().top) / (vh * (1 - settle))));
      el.style.setProperty(name, `${p}`);
    };
    const ask = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    tick();
    addEventListener("scroll", ask, { passive: true });
    addEventListener("resize", ask);
    return () => {
      removeEventListener("scroll", ask);
      removeEventListener("resize", ask);
      cancelAnimationFrame(raf);
    };
  }, [ref, watch, name, settle]);
}

/** The hero's reveal: the heading lifts a little and the screen, lying back in perspective, stands up to flat as it is
 *  scrolled into view (after Aceternity's container scroll animation, as the TEF Notes page does). Still when the
 *  visitor asks for no motion. */
export function ScrollStage({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  useRise(ref, plane, "--rise");
  return (
    <div ref={ref} className={cn("stage", className)}>
      <div className="stage-title">{title}</div>
      <div ref={plane} className="stage-plane">
        {children}
      </div>
    </div>
  );
}

/** A card that lights up under the pointer. */
export function Spotlight({ children, className }: { children: ReactNode; className?: string }) {
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div onPointerMove={move} className={cn("spot", className)}>
      {children}
    </div>
  );
}

/** Leans a few degrees toward the pointer, and settles flat when it leaves. Mouse and pen only. */
export function Tilt({ children, className, max = 5 }: { children: ReactNode; className?: string; max?: number }) {
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    e.currentTarget.style.setProperty("--ry", `${px * max * 2}deg`);
    e.currentTarget.style.setProperty("--rx", `${-py * max * 2}deg`);
  };
  const leave = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.style.setProperty("--rx", "0deg");
    e.currentTarget.style.setProperty("--ry", "0deg");
  };
  return (
    <div onPointerMove={move} onPointerLeave={leave} className={cn("tilt", className)}>
      {children}
    </div>
  );
}

export function Heading({ id, eyebrow, title, children, center = true }: { id: string; eyebrow: string; title: ReactNode; children?: ReactNode; center?: boolean }) {
  return (
    <Reveal className={cn("max-w-2xl", center && "mx-auto text-center")}>
      <p className="font-mono text-[13px] tracking-[0.16em] text-brand uppercase">{eyebrow}</p>
      <h2 id={id} className="mt-4 text-[clamp(2rem,4.6vw,3.4rem)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">
        {title}
      </h2>
      {children ? <p className="mt-5 text-lg text-dim text-pretty">{children}</p> : null}
    </Reveal>
  );
}

/** A screenshot. The dark capture is used when the page is dark, by the system or by the visitor's pick. */
export function ShotImg({ shot, eager, className, style }: { shot: Shot; eager?: boolean; className?: string; style?: CSSProperties }) {
  const { choice } = useTheme();
  const img = (
    <img
      src={choice === "dark" && shot.dark ? shot.dark : shot.light}
      alt={shot.alt}
      width={shot.width}
      height={shot.height}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={eager ? "high" : "auto"}
      className={className}
      style={style}
      draggable={false}
    />
  );
  if (shot.dark && choice === "system") {
    return (
      <picture>
        <source media="(prefers-color-scheme: dark)" srcSet={shot.dark} width={shot.width} height={shot.height} />
        {img}
      </picture>
    );
  }
  return img;
}

/** One region of a screenshot, close up, at a size that reads: `x`, `y`, `w`, `h` are fractions of the picture. */
export function Crop({ shot, x, y, w, h, className }: { shot: Shot; x: number; y: number; w: number; h: number; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden bg-card", className)} style={{ aspectRatio: `${shot.width * w} / ${shot.height * h}` }}>
      <ShotImg
        shot={shot}
        className="absolute max-w-none"
        style={{ width: `${100 / w}%`, height: "auto", left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%` }}
      />
    </div>
  );
}

/** Browser chrome in CSS around a screenshot (or anything else). */
export function BrowserFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-2xl border border-line bg-card shadow-lift ring-1 ring-hair", className)}>
      <div className="flex h-9 items-center gap-3 border-b border-line bg-raised/70 px-3.5 sm:h-10" aria-hidden="true">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-down/80" />
          <span className="size-2.5 rounded-full bg-warn/80" />
          <span className="size-2.5 rounded-full bg-up/80" />
        </div>
        <div className="mx-auto flex h-6 w-full max-w-72 items-center justify-center rounded-md bg-bg/70 px-3 font-mono text-[11px] text-faint">
          <span className="truncate">localhost:3050</span>
        </div>
        <div className="w-10 max-sm:hidden" />
      </div>
      {children}
    </div>
  );
}

/** A phone bezel in CSS: corners proportional to the frame, a camera hole, the screen inside. `className` places it. */
export function PhoneFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="relative rounded-[14%/6.2%] border border-line bg-raised p-[5px] shadow-lift ring-1 ring-hair sm:p-[6px]">
        <div className="relative overflow-hidden rounded-[12.5%/5.5%] bg-bg">
          {children}
        </div>
        <span className="absolute top-[20%] -right-[3px] h-[9%] w-[3px] rounded-r bg-line" aria-hidden="true" />
        <span className="absolute top-[32%] -right-[3px] h-[5%] w-[3px] rounded-r bg-line" aria-hidden="true" />
      </div>
    </div>
  );
}

export const buttonPrimary =
  "group inline-flex h-12 items-center justify-center gap-2 rounded-full bg-brand px-7 text-[15px] font-semibold text-on-brand shadow-[0_0_44px_-8px_var(--color-glow)] transition-transform hover:scale-[1.03]";
export const buttonQuiet =
  "inline-flex h-12 items-center justify-center gap-2 rounded-full border border-line bg-glass px-7 text-[15px] font-semibold backdrop-blur transition-colors hover:border-brand-line hover:bg-raised";
