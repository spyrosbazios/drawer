import type { Session, SessionItem } from "@drawer/shared/api";
import { ArrowDownIcon, CircleAlertIcon, UnplugIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo } from "react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerViewport, useMessageScroller } from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { groupRows, liveRow, pendingSeqs, pinnedQuestion, rowKey } from "./model";
import type { QuestionItem } from "./model";
import { RowView } from "./thread-items";
import { ThreadContext } from "./thread-context";
import { useOpenPath } from "./use-open-path";

interface ThreadProps {
  slug: string;
  session: Session;
  /** Undefined while loading. */
  items: readonly SessionItem[] | undefined;
  noRunner: boolean;
  answering: boolean;
  onAnswer: (question: QuestionItem, answer: string) => void;
}

/** The end of the thread: what the agent is doing right now (the one place the activity text appears), or why it is not. */
function Tail({ session, noRunner, liveRow }: { session: Session; noRunner: boolean; liveRow: boolean }) {
  // A running thought or tool call is the live row (it shimmers), so the tail gives way to it.
  if (session.status === "working" && liveRow) return null;
  if (session.status === "working") {
    return (
      <Marker asChild className="text-xs">
        <output>
          <MarkerIcon>
            <Spinner />
          </MarkerIcon>
          <MarkerContent className="shimmer">{session.activity ?? "working"}</MarkerContent>
        </output>
      </Marker>
    );
  }
  if (session.status === "queued" && noRunner) {
    return (
      <Marker className="text-xs">
        <MarkerIcon>
          <UnplugIcon />
        </MarkerIcon>
        <MarkerContent>No agent runner is connected: the session waits for one.</MarkerContent>
      </Marker>
    );
  }
  if (session.status === "failed") {
    return (
      <Marker className="text-xs text-destructive">
        <MarkerIcon>
          <CircleAlertIcon />
        </MarkerIcon>
        <MarkerContent>{session.error ?? "The session failed."}</MarkerContent>
      </Marker>
    );
  }
  return null;
}

/**
 * The conversation: `SessionItem[]` as rows (one renderer per item type in `thread-items.tsx`), stuck to the
 * bottom as it grows with a jump-to-latest button, the open question last, the live tail after it.
 */
export function Thread({ slug, session, items, noRunner, answering, onAnswer }: ThreadProps) {
  const opener = useOpenPath(slug);
  const pinned = useMemo(() => (items ? pinnedQuestion(items) : undefined), [items]);
  const rows = useMemo(() => (items ? groupRows(items, pinned?.seq) : []), [items, pinned]);
  const liveSeq = liveRow(items, session);
  const env = useMemo(() => ({ queued: items ? pendingSeqs(items, session) : new Set<number>(), liveSeq, answering, onAnswer }), [items, session, liveSeq, answering, onAnswer]);

  // The scroller opens at the end by itself only for rows present at mount; ours arrive after the fetch.
  const { scrollToEnd } = useMessageScroller();
  const toEnd = useEffectEvent(() => scrollToEnd({ behavior: "instant" }));
  const loaded = items !== undefined;
  useEffect(() => {
    if (!loaded) return;
    // Rows off screen are sized by estimate until painted: scroll once they have been, then again.
    const frames = [0, 0];
    frames[0] = requestAnimationFrame(() => {
      toEnd();
      frames[1] = requestAnimationFrame(toEnd);
    });
    return () => frames.forEach(cancelAnimationFrame);
  }, [loaded]);

  return (
    <ThreadContext value={opener}>
      <MessageScroller>
          <MessageScrollerViewport data-scroll-restoration-id={`detail|session|${session.id}`} aria-label="Conversation with the agent">
            <MessageScrollerContent className="gap-4 p-3">
              {!items && (
                <div className="space-y-2" aria-busy="true">
                  <Skeleton className="ml-10 h-12" />
                  <Skeleton className="h-20" />
                  <Skeleton className="h-8" />
                </div>
              )}
              {rows.map((row) => (
                <MessageScrollerItem key={rowKey(row)} messageId={rowKey(row)}>
                  <RowView row={row} env={env} />
                </MessageScrollerItem>
              ))}
              {pinned && (
                <MessageScrollerItem key={pinned.seq} messageId={String(pinned.seq)}>
                  <RowView row={{ kind: "item", item: pinned }} env={env} />
                </MessageScrollerItem>
              )}
              <MessageScrollerItem messageId="tail" className="empty:hidden">
                <Tail session={session} noRunner={noRunner} liveRow={liveSeq !== null} />
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton size="xs" className="bottom-3">
            <ArrowDownIcon /> Latest
          </MessageScrollerButton>
      </MessageScroller>
    </ThreadContext>
  );
}
