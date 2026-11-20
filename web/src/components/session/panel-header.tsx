import type { Session } from "@drawer/shared/api";
import { ChevronsUpDownIcon, PlayIcon, PlusIcon, SettingsIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { StatusChip } from "@/components/status/status-chip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatRelative } from "@/core/format";
import { isActive, needsYou } from "@/core/sessions";
import { useDeleteSession, useSendMessage, useSessions, useStopSession } from "@/hooks/sessions";
import { agentLabel } from "@/lib/agent-choice";
import { useProjectNav } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { AgentPicker } from "./agent-picker";

interface HeaderProps {
  slug: string;
  /** Undefined while composing a new session. */
  session: Session | undefined;
  /** Leaves the new-session composer (a session of the list was picked). */
  onSwitched: () => void;
  onNew: () => void;
}

function Switcher({ slug, current, onSwitched, onNew }: { slug: string; current: Session | undefined } & Pick<HeaderProps, "onSwitched" | "onNew">) {
  const sessions = useSessions(slug);
  const nav = useProjectNav(slug);
  const list = useMemo(() => (sessions.data ?? []).filter((s) => s.project === slug).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [sessions.data, slug]);
  const title = <span className="truncate">{current?.title ?? "New session"}</span>;
  if (list.length === 0) return <span className="min-w-0 flex-1 truncate px-1.5 text-sm font-medium">{title}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start px-1.5 text-left text-sm font-medium" aria-label="Switch session">
          {title}
          <ChevronsUpDownIcon className="shrink-0 text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1.5rem)]">
        <DropdownMenuItem onSelect={onNew}>
          <PlusIcon /> New session
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {list.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => {
              onSwitched();
              nav.openSession(s.id);
            }}
            className={cn("flex-col items-start gap-0.5", s.id === current?.id && "bg-raised")}
          >
            <span className="w-full truncate text-sm">{s.title}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-faint">
              <StatusChip kind="session" status={s.status} /> {formatRelative(s.createdAt)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Stop a session that is on a turn or waiting; Resume one that stopped or failed. */
function RunControl({ session }: { session: Session }) {
  const stop = useStopSession(session.id);
  const send = useSendMessage(session.id);
  const onError = (err: Error) => toast.error(err.message);
  if (isActive(session) || needsYou(session)) {
    return (
      <Button variant="outline" size="icon-sm" aria-label="Stop" title="Stop" disabled={stop.isPending} onClick={() => stop.mutate(undefined, { onError })}>
        <SquareIcon className="size-3 fill-current" />
      </Button>
    );
  }
  if (session.status === "stopped" || session.status === "failed") {
    return (
      <Button variant="outline" size="icon-sm" aria-label="Resume" title="Resume" disabled={send.isPending} onClick={() => send.mutate({ text: "Continue." }, { onError })}>
        <PlayIcon />
      </Button>
    );
  }
  return null;
}

function Settings({ session, onDelete }: { session: Session | undefined; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Agent settings" title="Agent settings">
          <SettingsIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1.5rem)] gap-3">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-dim">Agent for new sessions</p>
          <AgentPicker className="w-full" />
        </div>
        {session && (
          <>
            <dl className="flex items-baseline justify-between gap-3 border-t border-line pt-3 text-xs">
              <dt className="text-dim">This session</dt>
              <dd className="min-w-0 truncate" title={`${session.toolCalls} tool calls`}>
                {agentLabel({ provider: session.provider, model: session.model })} · {session.toolCalls} calls
              </dd>
            </dl>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start text-destructive hover:text-destructive"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
            >
              <Trash2Icon /> Delete session
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The agent panel's one header row: the session title with its switcher, THE status chip (state only; what the
 * agent is doing is the thread's tail), Stop / Resume, and the settings popover (agent choice, this session's
 * agent, delete).
 */
export function PanelHeader({ slug, session, onSwitched, onNew }: HeaderProps) {
  const del = useDeleteSession();
  const nav = useProjectNav(slug);
  const [deleting, setDeleting] = useState(false);
  return (
    <header className="flex items-center gap-1.5 border-b border-line py-1.5 pr-2 pl-1.5">
      <Switcher slug={slug} current={session} onSwitched={onSwitched} onNew={onNew} />
      {session && <StatusChip kind="session" status={session.status} />}
      {session && <RunControl session={session} />}
      <Settings session={session} onDelete={() => setDeleting(true)} />
      {session && (
        <AlertDialog open={deleting} onOpenChange={setDeleting}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this session?</AlertDialogTitle>
              <AlertDialogDescription>The conversation goes for every device. The project's parts, notes and attempts stay.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() =>
                  del.mutate(session.id, {
                    onSuccess: () => nav.openSession(undefined),
                    onError: (e) => toast.error(e.message),
                  })
                }
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </header>
  );
}
