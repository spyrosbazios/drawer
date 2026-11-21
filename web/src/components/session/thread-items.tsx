import { CircleAlertIcon, InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import { cn } from "@/lib/utils";
import type { QuestionItem, Row } from "./model";
import ThreadMarkdown from "./markdown";
import { Question } from "./question";
import { StandaloneThought } from "./thinking";
import { ToolSteps } from "./tool-steps";
import { UserMessage } from "./user-message";

/** What a row needs from the session that the item itself does not carry. */
export interface RowEnv {
  /** Seqs of the person's messages the agent has not read yet. */
  queued: ReadonlySet<number>;
  /** The thought or tool call that is live right now (`liveRow`), the one live row; every other row is drawn as it is. */
  liveSeq: number | null;
  /** An answer is being sent. */
  answering: boolean;
  onAnswer: (question: QuestionItem, answers: string[]) => void;
}

function Assistant({ text }: { text: string }) {
  return (
    <Message>
      <MessageContent>
        <ThreadMarkdown text={text} />
      </MessageContent>
    </Message>
  );
}

function Notice({ level, text }: { level: "info" | "error"; text: string }) {
  const Icon = level === "error" ? CircleAlertIcon : InfoIcon;
  return (
    <Marker className={cn("text-xs", level === "error" && "text-destructive")}>
      <MarkerIcon>
        <Icon />
      </MarkerIcon>
      <MarkerContent>{text}</MarkerContent>
    </Marker>
  );
}

/**
 * THE place an item type gets its renderer: one case per `SessionItem` type. A new type is a new case here
 * (reasoning is drawn by `thinking.tsx`, in a steps group or alone); the exhaustive switch makes the compiler ask for it.
 */
export function RowView({ row, env }: { row: Row; env: RowEnv }): ReactNode {
  if (row.kind === "steps") return <ToolSteps items={row.items} liveSeq={env.liveSeq} />;
  if (row.kind === "thought") return <StandaloneThought item={row.item} running={row.item.seq === env.liveSeq} />;
  const item = row.item;
  switch (item.type) {
    case "user":
      return <UserMessage item={item} queued={env.queued.has(item.seq)} />;
    case "assistant":
      return <Assistant text={item.text} />;
    case "question":
      return <Question item={item} busy={env.answering} onAnswer={(a) => env.onAnswer(item, a)} />;
    case "notice":
      return <Notice level={item.level} text={item.text} />;
  }
}
