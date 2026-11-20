import type { GateStatus, ProviderState, ReportStatus, SessionStatus } from "@drawer/shared/api";
import { LoaderCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Full class strings so Tailwind sees them; every colour is a theme token. */
const TONE = {
  up: "border-up/40 bg-up/12 text-up",
  down: "border-down/40 bg-down/12 text-down",
  warn: "border-warn/40 bg-warn/12 text-warn",
  run: "border-run/40 bg-run/12 text-run",
  dim: "border-line bg-raised text-dim",
  faint: "border-line bg-transparent text-faint",
  waived: "border-cat2/40 bg-cat2/12 text-cat2",
} as const;
type Tone = keyof typeof TONE;

const REPORT: Record<ReportStatus, { label: string; tone: Tone }> = {
  passed: { label: "passed", tone: "up" },
  draft: { label: "draft", tone: "warn" },
  failed: { label: "failed", tone: "down" },
  empty: { label: "no model", tone: "faint" },
  pending: { label: "pending", tone: "dim" },
};

const GATE: Record<GateStatus, { label: string; tone: Tone }> = {
  pass: { label: "pass", tone: "up" },
  fail: { label: "fail", tone: "down" },
  warn: { label: "warn", tone: "warn" },
  skipped: { label: "skipped", tone: "faint" },
  waived: { label: "waived", tone: "waived" },
};

const SESSION: Record<SessionStatus, { label: string; tone: Tone }> = {
  queued: { label: "queued", tone: "dim" },
  working: { label: "working", tone: "run" },
  waiting: { label: "waiting for you", tone: "warn" },
  idle: { label: "idle", tone: "dim" },
  stopped: { label: "stopped", tone: "faint" },
  failed: { label: "failed", tone: "down" },
};

const PROVIDER: Record<ProviderState, { label: string; tone: Tone }> = {
  ready: { label: "ready", tone: "up" },
  disabled: { label: "off", tone: "faint" },
  not_installed: { label: "not installed", tone: "dim" },
  signed_out: { label: "not signed in", tone: "warn" },
  unavailable: { label: "unavailable", tone: "down" },
};

/** Any status the app draws, tagged with what it is the status of. */
export type AnyStatus =
  | { kind: "report"; status: ReportStatus }
  | { kind: "gate"; status: GateStatus }
  | { kind: "session"; status: SessionStatus }
  | { kind: "provider"; status: ProviderState };

export type StatusChipProps = AnyStatus & {
  className?: string;
  size?: "sm" | "md";
  /** Replaces the default label ("draft 6/7"). */
  label?: string;
  /** Shows a spinner (an evaluation running). */
  busy?: boolean;
};

function defOf(s: AnyStatus): { label: string; tone: Tone } {
  switch (s.kind) {
    case "report":
      return REPORT[s.status];
    case "gate":
      return GATE[s.status];
    case "session":
      return SESSION[s.status];
    case "provider":
      return PROVIDER[s.status];
  }
}

/** Text colour class of a status, for icons and inline text beside a chip. */
export const statusText = (s: AnyStatus): string => TONE_TEXT[defOf(s).tone];

const TONE_TEXT: Record<Tone, string> = { up: "text-up", down: "text-down", warn: "text-warn", run: "text-run", dim: "text-dim", faint: "text-faint", waived: "text-cat2" };

/** The one way a status is drawn: part and assembly reports, gates, sessions and agent providers. */
export function StatusChip(props: StatusChipProps) {
  const { className, size = "sm", label, busy = false } = props;
  const def = defOf(props);
  const spinning = busy || (props.kind === "session" && props.status === "working");
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border font-medium whitespace-nowrap tabular-nums",
        size === "sm" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-xs",
        TONE[def.tone],
        className,
      )}
    >
      {spinning && <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />}
      {label ?? def.label}
    </span>
  );
}
