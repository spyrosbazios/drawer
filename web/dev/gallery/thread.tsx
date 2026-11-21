import type { SessionItem } from "@drawer/shared/api";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { groupRows, liveRow, pinnedQuestion, rowKey } from "@/components/session/model";
import { RowView } from "@/components/session/thread-items";

const at = "2026-11-20T10:00:00Z";

const REPLY = `The clip now meets the spec. I thickened the root of the arm, which was the only failing gate:

- **Wall thickness**: 1.6 mm at the root (spec: at least 1.2 mm)
- **Dimensions**: 82.0 × 40.0 × 24.0 mm, unchanged

\`\`\`openscad
module clip(wall = 1.6, gap = 3.2) {
  difference() {
    cube([82, 40, 24]);
    translate([wall, wall, -1]) cube([82 - 2 * wall, gap, 26]);
  }
}
\`\`\`

The \`gap\` parameter stays at 3.2 mm so it still fits the 3 mm shelf.`;

const think = (seq: number, text: string, status: "running" | "done", seconds: number): SessionItem => ({ seq, version: seq, at, type: "reasoning", reasoningId: `r${seq}`, text, status, seconds });
const tool = (seq: number, summary: string, status: "running" | "ok" | "error", result: string | null): SessionItem => ({ seq, version: seq, at, type: "tool", callId: `c${seq}`, name: "t", summary, status, result, images: [] });

/** The thread as drawer stores it: `SessionItem[]` from shared/src/api.ts, drawn by the app's own row renderers. */
const ITEMS: SessionItem[] = [
  {
    seq: 1,
    version: 1,
    at,
    type: "user",
    text: "The clip arm snapped at the root on the first print. Make it stronger.",
    refs: [{ kind: "part", part: "clip" }],
    attachments: [
      { id: "a1", name: "broken-clip.svg", mediaType: "image/svg+xml", size: 1800, kind: "image", url: "/favicon.svg", filedAs: null },
      { id: "a2", name: "tray-mount.stl", mediaType: "model/stl", size: 2_400_000, kind: "mesh", url: "/api/attachments/a2", filedAs: "refs/tray-mount.stl" },
    ],
    author: "web",
  },
  think(2, "The photo shows the arm cracked where it meets the body.\n\nThat points at a thin root: read the part before changing anything.", "done", 6),
  tool(3, "Read parts/clip.scad", "ok", "module clip(wall = 1.2, gap = 3.2) { … }"),
  tool(4, "Rendered clip", "error", "ERROR: Parser error in file clip.scad, line 7: syntax error"),
  think(5, "The render failed on a missing semicolon. Fix it, thicken the root to 1.6 mm, render again.", "done", 3),
  tool(6, "Evaluated clip", "ok", "9/10 gates pass; the wall gate was the only failure."),
  { seq: 7, version: 7, at, type: "assistant", text: REPLY },
  { seq: 8, version: 8, at, type: "notice", level: "info", text: "Session resumed on runner dev" },
  think(9, "The gap could stay at 3.2 mm, but widening it helps a thicker arm snap on.\n\nWorth asking.", "done", 8),
  { seq: 10, version: 10, at, type: "question", questionId: "q1", text: "Should the gap stay at 3.2 mm?", options: ["Keep 3.2 mm", "Widen to 3.4 mm"], answer: null },
];

/** The same thread mid-turn (`?thread=live`): the agent is thinking, the thought is the one live row. */
const LIVE_ITEMS: SessionItem[] = [
  ITEMS[0] as SessionItem,
  think(2, "The photo shows the arm cracked where it meets the body.", "done", 6),
  tool(3, "Read parts/clip.scad", "ok", "module clip(wall = 1.2, gap = 3.2) { … }"),
  tool(4, "Evaluated clip", "ok", "9/10 gates pass; the wall gate was the only failure."),
  think(5, "The wall gate fails at the root.\n\nThicken it to 1.6 mm and keep the slot at 3.2 mm, so the clip still grips the 3 mm shelf.", "running", 4),
];

export function Thread() {
  const live = new URLSearchParams(location.search).get("thread") === "live";
  const items = live ? LIVE_ITEMS : ITEMS;
  const pinned = pinnedQuestion(items);
  const rows = groupRows(items, pinned?.seq);
  const liveSeq = liveRow(items, { status: "working" });
  const env = { queued: new Set<number>(), liveSeq, answering: false, onAnswer: () => undefined };
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <MessageScrollerProvider>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-4 p-3">
              {rows.map((row) => (
                <MessageScrollerItem key={rowKey(row)}>
                  <RowView row={row} env={env} />
                </MessageScrollerItem>
              ))}
              {pinned && (
                <MessageScrollerItem>
                  <RowView row={{ kind: "item", item: pinned }} env={env} />
                </MessageScrollerItem>
              )}
              {liveSeq === null && (
                <MessageScrollerItem>
                  <Marker asChild className="text-xs">
                    <output>
                      <MarkerIcon>
                        <Spinner />
                      </MarkerIcon>
                      <MarkerContent className="shimmer">evaluating clip</MarkerContent>
                    </output>
                  </Marker>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
