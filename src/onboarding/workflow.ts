import type {
  AnswerRecord,
  AssignmentStatus,
  EssayFeedbackRecord,
  FinalConclusion,
  MultipleChoiceScore,
  OnboardingQuestion,
  ResourceProgressRecord,
  TemplateResource,
} from './contracts';

function sameOptionSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return actualSet.size === expected.length && expected.every((id) => actualSet.has(id));
}

export function scoreMultipleChoice(
  questions: readonly OnboardingQuestion[],
  answers: readonly AnswerRecord[],
): MultipleChoiceScore | null {
  const scoredQuestions = questions.filter((question) => question.type !== 'essay');
  if (scoredQuestions.length === 0) return null;

  const answersByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const results = scoredQuestions.map((question) => {
    const selected = answersByQuestion.get(question.id)?.selectedOptionIds ?? [];
    const expected = question.correctOptionIds ?? [];
    const correct = question.type === 'single_choice'
      ? selected.length === 1 && expected.length === 1 && selected[0] === expected[0]
      : sameOptionSet(selected, expected);
    return { questionId: question.id, correct };
  });
  const correctCount = results.filter((result) => result.correct).length;

  return {
    correctCount,
    totalCount: results.length,
    percentage: Math.round((correctCount / results.length) * 100),
    results,
  };
}

export function canUnlockExercise(
  resources: readonly TemplateResource[],
  progress: readonly ResourceProgressRecord[],
): boolean {
  const progressByResource = new Map(progress.map((entry) => [entry.resourceId, entry]));
  return resources
    .filter((resource) => resource.required)
    .every((resource) => {
      const entry = progressByResource.get(resource.id);
      return Boolean(entry?.openedAt && entry.completedAt);
    });
}

export function canEvaluateAttempt(
  questions: readonly OnboardingQuestion[],
  answers: readonly AnswerRecord[],
  feedback: readonly EssayFeedbackRecord[],
): boolean {
  const essayQuestionIds = new Set(
    questions.filter((question) => question.type === 'essay').map((question) => question.id),
  );
  if (essayQuestionIds.size === 0) return true;

  const essayAnswers = answers.filter((answer) => essayQuestionIds.has(answer.questionId));
  if (essayAnswers.length !== essayQuestionIds.size) return false;

  const reviewedAnswerIds = new Set(
    feedback
      .filter((entry) => entry.reviewed && entry.comment.trim().length > 0)
      .map((entry) => entry.answerId),
  );
  return essayAnswers.every((answer) => reviewedAnswerIds.has(answer.id));
}

export interface AssignmentTransitionInput {
  readonly currentStatus: AssignmentStatus;
  readonly started?: boolean;
  readonly submitted?: boolean;
  readonly hasEssays?: boolean;
  readonly essayFeedbackComplete?: boolean;
  readonly conclusion?: FinalConclusion;
}

export function nextAssignmentStatus(input: AssignmentTransitionInput): AssignmentStatus {
  if (input.conclusion) return input.conclusion;
  if (input.submitted) {
    return input.hasEssays && !input.essayFeedbackComplete
      ? 'awaiting_essay_feedback'
      : 'awaiting_evaluation';
  }
  if (input.essayFeedbackComplete && input.currentStatus === 'awaiting_essay_feedback') {
    return 'awaiting_evaluation';
  }
  if (input.started && input.currentStatus === 'assigned') return 'in_progress';
  return input.currentStatus;
}
