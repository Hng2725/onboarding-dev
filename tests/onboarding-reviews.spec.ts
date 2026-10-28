import { describe, expect, it, vi } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import { createAssignmentService } from '../src/onboarding/assignments';
import { createAttemptService } from '../src/onboarding/attempts';
import { createEmployeeService } from '../src/onboarding/employees';
import { createReviewService } from '../src/onboarding/reviews';
import { createTemplateService, type TemplateQuestionInput } from '../src/onboarding/templates';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };
const learner: OnboardingActor = { userId: 'member-1', roomId: 'room-a', access: 'learner' };
const other: OnboardingActor = { userId: 'member-2', roomId: 'room-a', access: 'learner' };

function setup() {
  let sequence = 0;
  const store = new MemoryOnboardingStore();
  const templates = createTemplateService(store, {
    allowLegacyManualCreation: true,
    id: () => `stable-${++sequence}`,
    now: () => `2026-10-20T00:00:${String(++sequence).padStart(2, '0')}.000Z`,
  });
  const notifications = { notify: vi.fn().mockResolvedValue({ delivered: true }) };
  const callPlatform = vi.fn().mockResolvedValue({ members: [
      { userId: 'admin-1' }, { userId: 'member-1' }, { userId: 'member-2' },
    ] });
  const employees = createEmployeeService(store, { callPlatform });
  const assignments = createAssignmentService(store, templates, {
    callPlatform,
    employees,
    notifications,
    now: () => '2026-10-20T01:00:00.000Z',
  });
  const attempts = createAttemptService(store, assignments, templates, {
    now: () => '2026-10-20T02:00:00.000Z',
  });
  const reviews = createReviewService(store, assignments, attempts, {
    notifications,
    now: () => '2026-10-20T03:00:00.000Z',
  });
  return { store, templates, employees, assignments, attempts, reviews, notifications };
}

async function ensureEmployee(context: ReturnType<typeof setup>) {
  try {
    await context.employees.getByMemberId(admin, 'member-1');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EMPLOYEE_NOT_FOUND')) throw error;
    await context.employees.add(admin, { memberId: 'member-1', employeeType: 'normal' });
  }
}

async function submitted(
  context: ReturnType<typeof setup>,
  questions: readonly TemplateQuestionInput[],
) {
  await ensureEmployee(context);
  const templateInput = {
    title: 'Bài đánh giá', description: '', employeeType: 'normal' as const,
    ...(questions.some((question) => question.type !== 'essay') ? { passingScore: 70 } : {}),
    modules: [{
      key: 'lesson', title: 'Bài học', description: '',
      resources: [{ title: 'Tài liệu', kind: 'link' as const, required: true, sourceUrl: 'https://docs.privos.ai/' }],
      questions,
    }],
  };
  const draftTemplate = await context.templates.createDraft(admin, templateInput);
  await context.templates.publish(admin, draftTemplate.id, 1, draftTemplate.updatedAt);
  const assignment = (await context.assignments.assign(admin, {
    memberId: 'member-1', templateId: draftTemplate.id, templateVersion: 1,
  })).assignment;
  const detail = await context.assignments.getMine(learner, assignment.id);
  const resource = detail.template.modules[0].resources[0];
  await context.assignments.markResourceOpened(learner, assignment.id, resource.id);
  await context.assignments.markResourceCompleted(learner, assignment.id, resource.id);
  const attempt = await context.attempts.getOrCreateDraft(learner, assignment.id);
  const savedAnswers = detail.template.modules[0].questions.map((question, index) => question.type === 'essay'
    ? { questionId: question.id, essayText: `Bài tự luận ${index + 1}` }
    : { questionId: question.id, selectedOptionIds: ['yes'] });
  await context.attempts.saveDraft(learner, {
    assignmentId: assignment.id, attemptId: attempt.id, answers: savedAnswers,
  });
  const result = await context.attempts.submit(learner, {
    assignmentId: assignment.id, operationId: `submit-${++sequenceForOperation}`,
  });
  return { assignment, attemptId: result.attemptId };
}

let sequenceForOperation = 0;
const essay = (prompt: string): TemplateQuestionInput => ({ type: 'essay', prompt, required: true });
const choice: TemplateQuestionInput = {
  type: 'single_choice', prompt: 'Chọn đáp án', required: true,
  options: [{ id: 'yes', label: 'Đúng' }, { id: 'no', label: 'Sai' }], correctOptionIds: ['yes'],
};

const evaluation = (attemptId: string, operationId = 'evaluate-1') => ({
  attemptId,
  operationId,
  completionLevel: 'Hoàn thành tốt',
  strengths: 'Nắm đúng quy trình',
  improvements: 'Cần thêm ví dụ thực tế',
  publicComment: 'Tiếp tục phát huy.',
  conclusion: 'passed' as const,
});

describe('onboarding review service', () => {
  it('queues every submitted essay exactly once and stores comment-only feedback', async () => {
    const context = setup();
    const { attemptId } = await submitted(context, [essay('Câu 1'), essay('Câu 2')]);

    const queue = await context.reviews.listEssayQueue(admin);
    expect(queue).toHaveLength(2);
    expect(new Set(queue.map((item) => item.answerId)).size).toBe(2);
    const feedback = await context.reviews.saveEssayFeedback(admin, {
      attemptId, answerId: queue[0].answerId, comment: 'Lập luận rõ ràng.',
    });

    expect(feedback).toMatchObject({ comment: 'Lập luận rõ ràng.', reviewerId: 'admin-1' });
    expect(feedback).not.toHaveProperty('score');
    expect((await context.reviews.listEssayQueue(admin)).filter((item) => !item.reviewed)).toHaveLength(1);
  });

  it('writes a unique operation ID for every essay feedback audit event', async () => {
    const context = setup();
    const { attemptId } = await submitted(context, [essay('Câu 1'), essay('Câu 2')]);
    const queue = await context.reviews.listEssayQueue(admin);

    for (const item of queue) {
      await context.reviews.saveEssayFeedback(admin, {
        attemptId, answerId: item.answerId, comment: 'Đã nhận xét.',
      });
    }

    const audits = await context.store.query('room-a', 'onboarding_audit_events');
    const operationIds = audits.records.map((record) => record.operationId);
    expect(operationIds.every((operationId) => typeof operationId === 'string' && operationId.length > 0)).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('blocks overall evaluation until every essay has feedback', async () => {
    const context = setup();
    const { attemptId } = await submitted(context, [essay('Câu 1'), essay('Câu 2')]);
    const queue = await context.reviews.listEssayQueue(admin);
    await context.reviews.saveEssayFeedback(admin, {
      attemptId, answerId: queue[0].answerId, comment: 'Đã nhận xét.',
    });

    await expect(context.reviews.publishEvaluation(admin, evaluation(attemptId))).rejects.toMatchObject({
      code: 'ESSAY_FEEDBACK_REQUIRED',
    });
  });

  it('puts a multiple-choice-only submission directly in the evaluation queue', async () => {
    const context = setup();
    const { attemptId } = await submitted(context, [choice]);

    expect(await context.reviews.listEssayQueue(admin)).toEqual([]);
    expect(await context.reviews.listEvaluationQueue(admin)).toEqual([
      expect.objectContaining({ attemptId }),
    ]);
  });

  it('requires every overall evaluation field and an exact conclusion', async () => {
    const context = setup();
    const { attemptId } = await submitted(context, [choice]);

    await expect(context.reviews.publishEvaluation(admin, {
      ...evaluation(attemptId), strengths: '', conclusion: 'unknown' as 'passed',
    })).rejects.toMatchObject({ code: 'EVALUATION_INVALID' });
  });

  it.each([
    ['passed', 'passed'],
    ['failed', 'failed'],
    ['retry', 'in_progress'],
  ] as const)('maps %s to assignment status %s', async (conclusion, status) => {
    const context = setup();
    const { assignment, attemptId } = await submitted(context, [choice]);

    const result = await context.reviews.publishEvaluation(admin, {
      ...evaluation(attemptId, `evaluate-${conclusion}`), conclusion,
    });

    expect(result.evaluation.conclusion).toBe(conclusion);
    expect((await context.assignments.getAdminDetail(admin, assignment.id)).assignment.status).toBe(status);
    if (conclusion === 'retry') {
      await expect(context.attempts.getOrCreateDraft(learner, assignment.id)).resolves.toMatchObject({ ordinal: 2 });
    }
  });

  it('publishes the same evaluation operation idempotently', async () => {
    const context = setup();
    const { attemptId } = await submitted(context, [choice]);
    const first = await context.reviews.publishEvaluation(admin, evaluation(attemptId, 'same-evaluation'));
    const second = await context.reviews.publishEvaluation(admin, evaluation(attemptId, 'same-evaluation'));

    expect(second.evaluation.id).toBe(first.evaluation.id);
    expect(await context.store.count('room-a', 'onboarding_evaluations', { attemptId })).toBe(1);
  });

  it('shows published feedback/evaluation only to the assigned learner', async () => {
    const context = setup();
    const { assignment, attemptId } = await submitted(context, [essay('Tự luận')]);
    const [queued] = await context.reviews.listEssayQueue(admin);
    await context.reviews.saveEssayFeedback(admin, {
      attemptId, answerId: queued.answerId, comment: 'Nhận xét công khai.',
    });
    await context.reviews.publishEvaluation(admin, evaluation(attemptId));

    const published = await context.reviews.getPublishedFeedback(learner, assignment.id);
    expect(published.essayFeedback).toHaveLength(1);
    expect(published.evaluation).toMatchObject({ conclusion: 'passed' });
    expect(published.evaluation).not.toHaveProperty('roomId');
    expect(published.evaluation).not.toHaveProperty('operationId');
    await expect(context.reviews.getPublishedFeedback(other, assignment.id)).rejects.toMatchObject({
      code: 'MEMBER_FORBIDDEN',
    });
  });
});
