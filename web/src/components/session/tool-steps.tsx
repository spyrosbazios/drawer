import { CheckIcon, CircleAlertIcon, CircleDashedIcon, ListChecksIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { ZoomImage } from "./image-zoom";
import type { ToolItem } from "./model";
import { visibleSteps } from "./model";

type Status = ToolItem["status"];

// A running step is a still icon: the thread's tail is the one animated thing while the agent works.
const ICON: Record<Status, ReactNode> = { running: <CircleDashedIcon />, ok: <CheckIcon />, error: <CircleAlertIcon /> };

/** One tool call: its one-line summary; expandable to the result text and the images it produced. */
function Step({ item }: { item: ToolItem }) {
  const expandable = item.result !== null || item.images.length > 0;
  const line = (
    <TraceLine status={item.status === "error" ? "error" : undefined} className="text-xs">
      <TraceIcon>
        {ICON[item.status]}
      </TraceIcon>
      <TraceTitle>{item.summary}</TraceTitle>
    </TraceLine>
  );
  return (
    <div className="min-w-0">
      {expandable ? (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="space-y-2">
            {item.result !== null && (
              <CodeBlock size="sm" variant={item.status === "error" ? "destructive" : "default"}>
                <CodeBlockContent wrap className="max-h-48">
                  {item.result}
                </CodeBlockContent>
              </CodeBlock>
            )}
            {item.images.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {item.images.map((src, i) => (
                  <ZoomImage key={src} src={src} alt={`${item.summary}, image ${i + 1}`} className="h-20 w-28" />
                ))}
              </div>
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        line
      )}
    </div>
  );
}

/**
 * Consecutive tool calls between two texts: one call stands alone; more fold into "N steps". Folded, the
 * step that is running and any that failed stay visible below the line; opened, every step is listed.
 */
export function ToolSteps({ items }: { items: readonly ToolItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 1 && items[0]) {
    return (
      <Trace>
        <Step item={items[0]} />
      </Trace>
    );
  }
  const shown = visibleSteps(items);
  return (
    <Trace className="gap-1.5">
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine className="text-xs">
            <TraceIcon>
              <ListChecksIcon />
            </TraceIcon>
            <TraceTitle>{items.length} steps</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="space-y-1.5">
          {items.map((t) => (
            <Step key={t.seq} item={t} />
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {!open && shown.map((t) => <Step key={t.seq} item={t} />)}
    </Trace>
  );
}
