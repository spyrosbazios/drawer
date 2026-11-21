import type { Session } from "@drawer/shared/api";
import { toast } from "sonner";
import { isOngoing, newestSession } from "@/core/sessions";
import { useProjectNav } from "@/lib/nav";
import { useAgentOptions } from "./agents";
import { useCreateSession, useSendMessage, useSessions } from "./sessions";
import { useIsDesktop } from "./use-media";

/**
 * Sends a message to the agent from the workspace: into the project's newest session while it is not stopped
 * or failed (it queues if a turn is running), else a new session with the agent the person picked. Then shows
 * that session: the agent panel, on the phone its sheet. The one place the workspace starts a session.
 */
export function useStartAgent(slug: string) {
  const nav = useProjectNav(slug);
  const desktop = useIsDesktop();
  const sessions = useSessions(slug);
  const agent = useAgentOptions();
  const latest = newestSession(sessions.data, slug);
  const running = latest && latest.status !== "stopped" && latest.status !== "failed" ? latest : undefined;
  const send = useSendMessage(running?.id ?? "");
  const create = useCreateSession();

  const start = (message: string) => {
    const opened = { onSuccess: (s: { id: string }) => nav.openSession(s.id, { reveal: !desktop }), onError: (err: Error) => toast.error(err.message) };
    if (running) send.mutate({ text: message }, opened);
    else create.mutate({ slug, message, ...agent.request }, { ...opened, onSuccess: (s) => { agent.pick(null); opened.onSuccess(s); } });
  };
  /** The project's newest session while a turn of it is in progress: the agent is on it. */
  const ongoing: Session | undefined = latest && isOngoing(latest) ? latest : undefined;
  return { start, pending: send.isPending || create.isPending, noRunner: agent.noRunner, ongoing };
}
