import { LIBRARY_SLUG } from "@drawer/shared/api";
import { useNavigate } from "@tanstack/react-router";
import { useCreateSession, useSendMessage, useSessions } from "@/hooks/sessions";
import { useProjectNav } from "@/lib/nav";
import { partHome } from "./assembly-model";

/**
 * Sends a message to the agent: into the project's newest session (it queues if a turn is running), or a
 * new session when there is none. Then shows that session.
 */
export function useAskAgent(slug: string) {
  const sessions = useSessions(slug);
  const latest = [...(sessions.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const send = useSendMessage(latest?.id ?? "");
  const create = useCreateSession();
  const nav = useProjectNav(slug);
  const ask = (message: string) => {
    if (latest) send.mutate({ text: message }, { onSuccess: (s) => nav.openSession(s.id) });
    else create.mutate({ slug, message }, { onSuccess: (s) => nav.openSession(s.id) });
  };
  return { ask, pending: send.isPending || create.isPending, error: send.error ?? create.error };
}

/** Opens a part of the assembly: in this project, or in the library project for "_library/<id>". */
export function useOpenPart(slug: string) {
  const nav = useProjectNav(slug);
  const navigate = useNavigate();
  return (part: string) => {
    const home = partHome(part);
    if (home.library) void navigate({ to: "/p/$slug", params: { slug: LIBRARY_SLUG }, search: { part: home.id } });
    else nav.selectPart(home.id);
  };
}
