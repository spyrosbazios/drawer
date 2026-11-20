import type { SessionRef } from "@drawer/shared/api";
import { BotIcon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { MessageScrollerProvider, useMessageScroller } from "@/components/ui/message-scroller";
import { isActive, needsYou } from "@/core/sessions";
import { useAgentOptions } from "@/hooks/agents";
import { useAnswerQuestion, useCreateSession, useRunners, useSendMessage, useSession, useStopSession } from "@/hooks/sessions";
import { useProjectNav } from "@/lib/nav";
import { draftKey } from "./composer-drafts";
import { Composer } from "./composer";
import { DropZone } from "./drop-zone";
import type { QuestionItem } from "./model";
import { PanelHeader } from "./panel-header";
import { Thread } from "./thread";
import { useAttachments } from "./use-attachments";
import { useWaitingTitle } from "./use-waiting-title";

/**
 * SLOT (feature: agent session). The right panel `session` (laptop) and the phone's session sheet.
 * Reads `useSession(sessionId)` (items kept current and merged by seq by realtime), `useRunners`, `useAgentOptions`,
 * `usePointed(slug)` for the picks to attach.
 *
 * Draws its own header (title and switcher, the ONE status chip, Stop/Resume, settings popover with the agent
 * choice), the thread (`thread.tsx`, one renderer per item type in `thread-items.tsx`; the activity text is
 * its tail and appears nowhere else), and the composer (picks and attached files as chips). Files can be
 * dropped anywhere on the panel; they upload at once and go with the next message. With `sessionId` undefined
 * (no session yet) the composer starts one and opens it. Unsent text and files live in `composer-drafts.ts`,
 * outside React.
 */
export interface SessionPanelProps {
  slug: string;
  /** The session to show: the URL's `session`, else the project's newest; undefined when there is none. */
  sessionId: string | undefined;
}

export function SessionPanel({ slug, sessionId }: SessionPanelProps) {
  // "New session" from the switcher: a local compose mode; the panel is keyed by session, so it resets on navigation.
  const [fresh, setFresh] = useState(false);
  if (sessionId === undefined || fresh) return <NewSession slug={slug} onSwitched={() => setFresh(false)} />;
  return <LiveSession slug={slug} id={sessionId} onNew={() => setFresh(true)} />;
}

function useNoRunner(): boolean {
  const runners = useRunners();
  return runners.isSuccess && runners.data.length === 0;
}

function NewSession({ slug, onSwitched }: { slug: string; onSwitched: () => void }) {
  const create = useCreateSession();
  const nav = useProjectNav(slug);
  const agent = useAgentOptions();
  const key = draftKey(slug, undefined);
  const attachments = useAttachments(slug, key);

  const send = async (message: string, refs: SessionRef[], files: string[]): Promise<boolean> => {
    try {
      const s = await create.mutateAsync({ slug, message, refs, attachments: files, ...agent.request });
      agent.pick(null);
      nav.openSession(s.id);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the session");
      return false;
    }
  };

  return (
    <DropZone onFiles={attachments.add} className="flex h-full min-h-0 flex-col">
      <PanelHeader slug={slug} session={undefined} onSwitched={onSwitched} onNew={onSwitched} />
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <BotIcon className="size-7 text-faint" aria-hidden />
        <p className="text-sm text-dim">Tell the agent what to make or change.</p>
        {agent.noRunner && (
          <Marker className="w-auto text-xs">
            <MarkerIcon>
              <UnplugIcon />
            </MarkerIcon>
            <MarkerContent>No agent runner is connected.</MarkerContent>
          </Marker>
        )}
      </div>
      <div className="p-3 pt-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Composer slug={slug} draftKey={key} placeholder="A clip for a 6 mm cable that snaps onto a 4 mm tray edge" attachments={attachments} busy={create.isPending} stoppable={false} onStop={onSwitched} onSend={send} />
      </div>
    </DropZone>
  );
}

function LiveSession({ slug, id, onNew }: { slug: string; id: string; onNew: () => void }) {
  const detail = useSession(id);
  const nav = useProjectNav(slug);
  useWaitingTitle(detail.data?.session.status === "waiting" ? detail.data.session.title : undefined);

  if (detail.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-dim">
        <p>This session could not be loaded{detail.error instanceof Error ? `: ${detail.error.message}` : "."}</p>
        <Button variant="outline" size="sm" onClick={() => nav.openSession(undefined)}>
          Show the newest session
        </Button>
      </div>
    );
  }
  return (
    <MessageScrollerProvider defaultScrollPosition="end">
      <LiveBody slug={slug} id={id} onNew={onNew} />
    </MessageScrollerProvider>
  );
}

function LiveBody({ slug, id, onNew }: { slug: string; id: string; onNew: () => void }) {
  const detail = useSession(id);
  const send = useSendMessage(id);
  const answer = useAnswerQuestion(id);
  const stop = useStopSession(id);
  const noRunner = useNoRunner();
  const { scrollToEnd } = useMessageScroller();
  const key = draftKey(slug, id);
  const attachments = useAttachments(slug, key);
  const session = detail.data?.session;

  const sendMessage = async (text: string, refs: SessionRef[], files: string[]): Promise<boolean> => {
    try {
      await send.mutateAsync({ text, refs, attachments: files });
      scrollToEnd({ behavior: "smooth" });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send");
      return false;
    }
  };
  const onAnswer = (q: QuestionItem, value: string) => answer.mutate({ questionId: q.questionId, answer: value }, { onError: (e) => toast.error(e.message) });

  return (
    <DropZone onFiles={attachments.add} className="flex h-full min-h-0 flex-col">
      <PanelHeader slug={slug} session={session} onSwitched={() => undefined} onNew={onNew} />
      <div className="min-h-0 flex-1">
        {session && <Thread slug={slug} session={session} items={detail.data?.items} noRunner={noRunner} answering={answer.isPending} onAnswer={onAnswer} />}
      </div>
      <div className="p-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Composer
          slug={slug}
          draftKey={key}
          placeholder="Message the agent"
          attachments={attachments}
          busy={send.isPending}
          stoppable={session !== undefined && (isActive(session) || needsYou(session))}
          onStop={() => stop.mutate(undefined, { onError: (e) => toast.error(e.message) })}
          onSend={sendMessage}
        />
      </div>
    </DropZone>
  );
}
