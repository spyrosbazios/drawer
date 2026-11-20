import type { Project } from "@drawer/shared/api";
import { StatusChip } from "@/components/status/status-chip";

/** "3 parts · 2 passed · 1 draft"; null without parts (the chip already says so). */
export function statusLine(p: Project): string | null {
  const s = p.status;
  if (s.parts === 0) return null;
  const bits = [`${s.parts} ${s.parts === 1 ? "part" : "parts"}`];
  if (s.passed) bits.push(`${s.passed} passed`);
  if (s.draft) bits.push(`${s.draft} draft`);
  if (s.failed) bits.push(`${s.failed} failed`);
  if (s.pending) bits.push(`${s.pending} pending`);
  return bits.join(" · ");
}

/** The project's roll-up: the worst of its parts and assembly. */
export function ProjectStatusChip({ project }: { project: Project }) {
  const s = project.status;
  if (s.parts === 0) return <StatusChip kind="report" status="empty" label={project.source ? "reference" : "empty"} />;
  const label = s.assembly !== "none" && s.assembly !== "passed" && s.passed === s.parts ? `assembly ${s.assembly}` : undefined;
  return <StatusChip kind="report" status={s.overall} label={label} />;
}

/** Sort order of `overall` for the status column: worst first when descending. */
export const STATUS_RANK: Record<Project["status"]["overall"], number> = { failed: 4, draft: 3, pending: 2, passed: 1, empty: 0 };
