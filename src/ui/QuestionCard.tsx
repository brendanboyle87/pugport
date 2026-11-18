import type { Workflow } from '../shared/types';

/** ask_user's question while no later user message has answered it. */
export const openQuestion = (workflow: Workflow | undefined) =>
  workflow && !workflow.delegation && !workflow.deletedAt && !workflow.userQuestion?.answeredMessageId
    ? workflow.userQuestion
    : undefined;

/** A durable inline question; a button sends its option exactly as if the user had typed it. */
export function QuestionCard({
  question,
  onAnswer,
}: {
  question: NonNullable<Workflow['userQuestion']>;
  /** Absent while the composer holds a draft, which an answer would otherwise replace. */
  onAnswer?: (text: string) => void;
}) {
  return (
    <section className="question-card" aria-label="问题卡">
      <p>{question.text}</p>
      <div className="question-card-actions">
        {question.options.map((option, index) => (
          <button
            key={index}
            type="button"
            className={index ? 'button secondary' : 'button primary'}
            disabled={!onAnswer}
            title={onAnswer ? undefined : '先发送或清空输入框里的内容'}
            onClick={() => onAnswer?.(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </section>
  );
}
