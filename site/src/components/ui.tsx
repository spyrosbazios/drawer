import type { ReactNode } from "react";
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

export function Section({ id, label, className, children }: { id: string; label: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("py-20 md:py-28", className)}>
      <Container>
        <p className="font-mono text-[13px] tracking-wide text-brand uppercase">{label}</p>
        {children}
      </Container>
    </section>
  );
}

export function Heading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={`${id}-title`} className="mt-3 max-w-3xl text-[clamp(1.75rem,4vw,2.75rem)] leading-[1.1] font-semibold tracking-[-0.03em] text-balance">
      {children}
    </h2>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="mt-5 max-w-2xl text-lg text-dim text-pretty">{children}</p>;
}

/** A screenshot in a frame. The dark capture is used when the page is dark, by the system or by the visitor's pick. */
export function Frame({ shot, className, eager }: { shot: Shot; className?: string; eager?: boolean }) {
  const { choice } = useTheme();
  const loading = eager ? "eager" : "lazy";
  const img = <img src={choice === "dark" && shot.dark ? shot.dark : shot.light} alt={shot.alt} width={shot.width} height={shot.height} loading={loading} decoding="async" fetchPriority={eager ? "high" : "auto"} className="block h-auto w-full" />;
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-card shadow-frame", className)}>
      {shot.dark && choice === "system" ? (
        <picture>
          <source media="(prefers-color-scheme: dark)" srcSet={shot.dark} width={shot.width} height={shot.height} />
          {img}
        </picture>
      ) : (
        img
      )}
    </div>
  );
}

export const buttonPrimary =
  "inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-5 text-[15px] font-semibold text-on-brand transition-opacity hover:opacity-90";
export const buttonQuiet =
  "inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-line bg-card px-5 text-[15px] font-semibold transition-colors hover:border-brand-line hover:bg-raised";
