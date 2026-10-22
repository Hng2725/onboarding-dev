import { describe, expect, it } from 'vitest';

import { chooseContinueAssignment } from '../src/ui/onboarding/learner-dashboard';
import {
  buildSubmission,
  isExerciseUnlocked,
  nextSubmissionOperation,
  resourceViewState,
  validateRequiredAnswers,
} from '../src/ui/onboarding/learning-workspace';
import { resultPresentation } from '../src/ui/onboarding/results';

describe('Learner onboarding UI models', () => {
  it('continues the active assignment with the earliest due date', () => {
    expect(chooseContinueAssignment([
      { id: 'done', status: 'passed', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'later', status: 'in_progress', dueAt: '2026-10-28T00:00:00Z', assignedAt: '2026-10-02T00:00:00Z' },
      { id: 'earlier', status: 'assigned', dueAt: '2026-10-22T00:00:00Z', assignedAt: '2026-10-03T00:00:00Z' },
    ])?.id).toBe('earlier');
    expect(chooseContinueAssignment([
      { id: 'waiting', status: 'awaiting_evaluation', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'submitted', status: 'submitted', assignedAt: '2026-10-02T00:00:00Z' },
    ])).toBeUndefined();
  });

  it('keeps exercises locked until every required resource is opened and completed', () => {
    const resources = [{ id: 'r1', required: true }, { id: 'r2', required: false }];
    expect(isExerciseUnlocked(resources, [{ resourceId: 'r1', openedAt: 'now' }])).toBe(false);
    expect(isExerciseUnlocked(resources, [{ resourceId: 'r1', openedAt: 'now', completedAt: 'later' }])).toBe(true);
  });

  it('shows a recoverable broken-file state without clearing completion', () => {
    expect(resourceViewState({ resourceId: 'r1', openedAt: 'a', completedAt: 'b' }, new Error('missing'))).toEqual({
      completed: true, opened: true, recoverableError: 'missing', canRetry: true,
    });
  });

  it('identifies unanswered required questions', () => {
    const questions = [
      { id: 'q1', type: 'single_choice', prompt: 'P', required: true },
      { id: 'q2', type: 'essay', prompt: 'E', required: false },
    ] as const;
    expect(validateRequiredAnswers(questions, [])).toEqual(['q1']);
    expect(validateRequiredAnswers(questions, [{ questionId: 'q1', selectedOptionIds: ['a'] }])).toEqual([]);
  });

  it('keeps one operation ID for retries of the same answer payload', () => {
    const createId = () => 'op-new';
    const first = nextSubmissionOperation(null, [{ questionId: 'q1', selectedOptionIds: ['a'] }], createId);
    const retry = nextSubmissionOperation(first, [{ questionId: 'q1', selectedOptionIds: ['a'] }], () => 'should-not-change');
    const changed = nextSubmissionOperation(first, [{ questionId: 'q1', selectedOptionIds: ['b'] }], createId);
    expect(retry.operationId).toBe(first.operationId);
    expect(changed.operationId).toBe('op-new');
    expect(buildSubmission('assignment-1', first.operationId)).toEqual({ assignmentId: 'assignment-1', operationId: first.operationId });
  });

  it('shows a numeric score only when multiple-choice questions exist', () => {
    expect(resultPresentation({ mcScore: null })).toMatchObject({ showScore: false });
    expect(resultPresentation({ mcScore: { correctCount: 4, totalCount: 5, percentage: 80, results: [] } })).toMatchObject({
      showScore: true, scoreLabel: '80%',
    });
  });

  it('reveals published feedback and retry CTA only from a published evaluation', () => {
    expect(resultPresentation({ mcScore: null, essayFeedback: [{ id: 'f1' }] })).toMatchObject({ showFeedback: false, canRetry: false });
    expect(resultPresentation({ mcScore: null, evaluation: { conclusion: 'retry' }, essayFeedback: [{ id: 'f1' }] })).toMatchObject({
      showFeedback: true, conclusionLabel: 'Làm lại', canRetry: true,
    });
  });
});
