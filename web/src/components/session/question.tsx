import { MessageCircleQuestionIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Questionnaire, QuestionnaireActions, QuestionnaireChoice, QuestionnaireChoices, QuestionnaireInput, QuestionnaireItem, QuestionnaireSubmit, QuestionnaireTitle } from "@/components/ui/questionnaire";
import ThreadMarkdown, { InlineMarkdown } from "./markdown";
import type { QuestionItem } from "./model";
import { firstLine } from "./model";

/**
 * A question from the agent, its text drawn as markdown like the rest of what the agent says. Open: the one
 * loud thing in the thread (the session waits for it): the options as choices, or free text. Answered: a quiet
 * two-line record.
 */
export function Question({ item, busy, onAnswer }: { item: QuestionItem; busy: boolean; onAnswer: (answer: string) => void }) {
  if (item.answer !== null) {
    return (
      <Marker className="items-start">
        <MarkerIcon className="mt-0.5">
          <MessageCircleQuestionIcon />
        </MarkerIcon>
        <MarkerContent className="space-y-0.5">
          <span className="line-clamp-2 block" title={item.text}>
            {firstLine(item.text)}
          </span>
          <span className="block text-foreground">
            <InlineMarkdown text={item.answer} />
          </span>
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
        const answer = String(new FormData(event.currentTarget).get(item.questionId) ?? "").trim();
        if (answer !== "") onAnswer(answer);
      }}
    >
      <QuestionnaireItem name={item.questionId} required disabled={busy} className="gap-3">
        <QuestionnaireTitle className="mb-0! w-full font-sans text-sm font-normal">
          <ThreadMarkdown text={item.text} />
        </QuestionnaireTitle>
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
        <QuestionnaireSubmit size="sm" className="col-start-1">
          Answer
        </QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>
  );
}
