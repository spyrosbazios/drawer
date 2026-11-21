import { BrainIcon } from "lucide-react";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { lastLine, thoughtLabel } from "./model";
import type { ReasoningItem } from "./model";

/**
 * What the model reported thinking (AI Elements' Reasoning pattern, on Trace): a collapsed line, "Thinking"
 * with the line it is on while it runs (the title shimmers: the live row of the thread), "Thought for 7s"
 * after. Opens to the whole text, line breaks kept. `running` is the thread's decision (`liveRow`).
 */
export function Thought({ item, running }: { item: ReasoningItem; running: boolean }) {
  const now = running ? lastLine(item.text) : "";
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined} className="text-xs">
          <TraceIcon>
            <BrainIcon />
          </TraceIcon>
          <TraceTitle className="shrink-0">{thoughtLabel(item, running)}</TraceTitle>
          {now !== "" && <TraceDescription className="min-w-0 shrink truncate">{now}</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{item.text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** A thought that is not part of a steps group: the model thought, then answered. */
export function StandaloneThought({ item, running }: { item: ReasoningItem; running: boolean }) {
  return (
    <Trace>
      <Thought item={item} running={running} />
    </Trace>
  );
}
