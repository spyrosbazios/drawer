import { useState } from "react";
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import ThreadMarkdown, { InlineMarkdown } from "./markdown";
import type { QuestionItem } from "./model";
import { answersOf, firstLine } from "./model";

/**
 * A question from the agent, its text drawn as markdown like the rest of what the agent says. Open: the one
 * loud thing in the thread (the session waits for it): the options as choices (checkboxes when the agent lets
 * the person pick several), or free text, which a multiple question takes beside the picks. Answered: a quiet
 * record, one line per answer of a multiple question.
 */
export function Question({ item, busy, onAnswer }: { item: QuestionItem; busy: boolean; onAnswer: (answers: string[]) => void }) {
  // A multiple question cannot be sent empty; a single one keeps the questionnaire's own required check.
  const [picked, setPicked] = useState(false);
  if (item.answers !== null) {
    return (
      <Marker className="items-start">
        <MarkerIcon className="mt-0.5">
          <MessageCircleQuestionIcon />
        </MarkerIcon>
        <MarkerContent className="space-y-0.5">
          <span className="line-clamp-2 block" title={item.text}>
            {firstLine(item.text)}
          </span>
          {item.multiple ? (
            <ul className="space-y-0.5 text-foreground" aria-label="Answers">
              {item.answers.map((a) => (
                <li key={a} className="flex items-start gap-1.5">
                  <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <InlineMarkdown text={a} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="block text-foreground">
              <InlineMarkdown text={item.answers[0] ?? ""} />
            </span>
          )}
        </MarkerContent>
      </Marker>
    );
  }
  return (
    <Questionnaire
      aria-label="Question from the agent"
      className="gap-3 rounded-xl border border-warn/50 bg-card p-3 shadow-md ring-3 ring-warn/15"
      onSubmit={(event) => {
        event.preventDefault();
        const answers = answersOf(new FormData(event.currentTarget).getAll(item.questionId));
        if (answers.length > 0) onAnswer(item.multiple ? answers : answers.slice(0, 1));
      }}
    >
      <QuestionnaireItem name={item.questionId} required multiple={item.multiple} disabled={busy} className="gap-3" onStatusChange={(status) => setPicked(status === "answered")}>
        <QuestionnaireTitle className="mb-0! w-full font-sans text-sm font-normal">
          <ThreadMarkdown text={item.text} />
        </QuestionnaireTitle>
        {item.multiple && <QuestionnaireDescription className="-mt-1 text-xs">Pick any that apply.</QuestionnaireDescription>}
        <QuestionnaireChoices>
          {item.options.map((o) => (
            <QuestionnaireChoice key={o} value={o}>
              <InlineMarkdown text={o} />
            </QuestionnaireChoice>
          ))}
          <QuestionnaireInput aria-label="Another answer" placeholder="Something else…" />
        </QuestionnaireChoices>
      </QuestionnaireItem>
      <QuestionnaireActions className="grid-cols-1 justify-items-end">
        <QuestionnaireSubmit size="sm" className="col-start-1" disabled={item.multiple && !picked}>
          Answer
        </QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>
  );
}
