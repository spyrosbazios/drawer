import type { SessionItem } from "@drawer/shared/api";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { groupRows, pinnedQuestion } from "@/components/session/model";
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
  tool(2, "Read parts/clip.scad", "ok", "module clip(wall = 1.2, gap = 3.2) { … }"),
  tool(3, "Rendered clip", "error", "ERROR: Parser error in file clip.scad, line 7: syntax error"),
  tool(4, "Evaluating clip", "running", null),
  { seq: 5, version: 5, at, type: "assistant", text: REPLY },
  { seq: 6, version: 6, at, type: "notice", level: "info", text: "Session resumed on runner dev" },
  { seq: 7, version: 7, at, type: "question", questionId: "q1", text: "Should the gap stay at 3.2 mm?", options: ["Keep 3.2 mm", "Widen to 3.4 mm"], answer: null },
];

export function Thread() {
  const pinned = pinnedQuestion(ITEMS);
  const rows = groupRows(ITEMS, pinned?.seq);
  const env = { queued: new Set<number>(), answering: false, onAnswer: () => undefined };
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <MessageScrollerProvider>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-4 p-3">
              {rows.map((row) => (
                <MessageScrollerItem key={row.kind === "steps" ? `s${row.key}` : row.item.seq}>
                  <RowView row={row} env={env} />
                </MessageScrollerItem>
              ))}
              {pinned && (
                <MessageScrollerItem>
                  <RowView row={{ kind: "item", item: pinned }} env={env} />
                </MessageScrollerItem>
              )}
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
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
