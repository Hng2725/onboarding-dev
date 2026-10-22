import { describe, expect, it, vi } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import { createAssignmentService } from '../src/onboarding/assignments';
import { createAttemptService } from '../src/onboarding/attempts';
import { createTemplateService, type TemplateDraftInput } from '../src/onboarding/templates';
import { SYSTEM_TEMPLATES } from '../src/onboarding/system-templates';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };
const member: OnboardingActor = { userId: 'member-1', roomId: 'room-a', access: 'learner' };
const other: OnboardingActor = { userId: 'member-2', roomId: 'room-a', access: 'learner' };

function setup() {
  let sequence = 0;
  const store = new MemoryOnboardingStore();
  const templates = createTemplateService(store, {
    id: () => `stable-${++sequence}`,
    now: () => `2026-10-20T00:00:${String(++sequence).padStart(2, '0')}.000Z`,
  });
  const assignments = createAssignmentService(store, templates, {
    callPlatform: vi.fn().mockResolvedValue({ members: [
      { userId: 'admin-1' }, { userId: 'member-1' }, { userId: 'member-2' },
    ] }),
    notifications: { notify: vi.fn().mockResolvedValue({ delivered: true }) },
    now: () => '2026-10-20T01:00:00.000Z',
  });
  const attempts = createAttemptService(store, assignments, templates, {
    now: () => '2026-10-20T02:00:00.000Z',
  });
  return { store, templates, assignments, attempts };
}

async function foundation(setupResult: ReturnType<typeof setup>) {
  return (await setupResult.assignments.assign(admin, {
    memberId: 'member-1', employeeType: 'normal',
    templateId: 'privos-foundations', templateVersion: 1,
  })).assignment;
}

async function unlockAll(
  assignments: ReturnType<typeof createAssignmentService>,
  assignmentId: string,
) {
  const detail = await assignments.getMine(member, assignmentId);
  for (const module of detail.template.modules) {
    for (const resource of module.resources.filter((item) => item.required)) {
      await assignments.markResourceOpened(member, assignmentId, resource.id);
      await assignments.markResourceCompleted(member, assignmentId, resource.id);
    }
  }
}

function correctFoundationAnswers() {
  return SYSTEM_TEMPLATES[0].modules.flatMap((module) => module.questions.map((question) => ({
    questionId: question.id,
    selectedOptionIds: [...(question.correctOptionIds ?? [])],
  })));
}

async function customAssignment(
  context: ReturnType<typeof setup>,
  questions: TemplateDraftInput['modules'][number]['questions'],
) {
  const input: TemplateDraftInput = {
    title: 'Bài tùy chỉnh', description: '', employeeType: 'normal', maxAttempts: 1,
    ...(questions.some((question) => question.type !== 'essay') ? { passingScore: 70 } : {}),
    modules: [{
      key: 'custom', title: 'Bài học', description: '',
      resources: [{ title: 'Tài liệu', kind: 'link', required: true, sourceUrl: 'https://docs.privos.ai/' }],
      questions,
    }],
  };
  const draft = await context.templates.createDraft(admin, input);
  await context.templates.publish(admin, draft.id, 1, draft.updatedAt);
  const assignment = (await context.assignments.assign(admin, {
    memberId: 'member-1', employeeType: 'normal', templateId: draft.id, templateVersion: 1,
  })).assignment;
  await unlockAll(context.assignments, assignment.id);
  return assignment;
}

describe('onboarding attempt lifecycle', () => {
  it('does not create a draft until every required resource unlocks the exercise', async () => {
    const context = setup();
    const assignment = await foundation(context);

    await expect(context.attempts.getOrCreateDraft(member, assignment.id)).rejects.toMatchObject({
      code: 'EXERCISE_LOCKED',
    });
  });

  it('saves incomplete drafts but validates answer types and requires completeness on submit', async () => {
    const context = setup();
    const assignment = await foundation(context);
    await unlockAll(context.assignments, assignment.id);
    const draft = await context.attempts.getOrCreateDraft(member, assignment.id);

    await expect(context.attempts.saveDraft(member, {
      assignmentId: assignment.id, attemptId: draft.id, answers: [],
    })).resolves.toMatchObject({ id: draft.id, status: 'draft' });
    await expect(context.attempts.submit(member, {
      assignmentId: assignment.id, operationId: 'incomplete-submit',
    })).rejects.toMatchObject({ code: 'REQUIRED_ANSWER_MISSING' });
    await expect(context.attempts.saveDraft(member, {
      assignmentId: assignment.id,
      attemptId: draft.id,
      answers: correctFoundationAnswers().map((answer, index) => index === 0
        ? { ...answer, selectedOptionIds: ['not-an-option'] }
        : answer),
    })).rejects.toMatchObject({ code: 'ANSWER_INVALID' });
  });

  it('auto-scores choice answers and moves directly to overall evaluation', async () => {
    const context = setup();
    const assignment = await foundation(context);
    await unlockAll(context.assignments, assignment.id);
    const draft = await context.attempts.getOrCreateDraft(member, assignment.id);
    await context.attempts.saveDraft(member, {
      assignmentId: assignment.id, attemptId: draft.id, answers: correctFoundationAnswers(),
    });

    const result = await context.attempts.submit(member, {
      assignmentId: assignment.id, operationId: 'submit-foundations',
    });

    expect(result.mcScore).toMatchObject({ correctCount: 6, totalCount: 6, percentage: 100 });
    expect((await context.assignments.getMine(member, assignment.id)).assignment.status).toBe('awaiting_evaluation');
  });

  it('keeps essay-only attempts unscored and routes them to essay feedback', async () => {
    const context = setup();
    const assignment = await customAssignment(context, [
      { type: 'essay', prompt: 'Bạn sẽ áp dụng điều gì?', required: true },
    ]);
    const detail = await context.assignments.getMine(member, assignment.id);
    const questionId = detail.template.modules[0].questions[0].id;
    const draft = await context.attempts.getOrCreateDraft(member, assignment.id);
    await context.attempts.saveDraft(member, {
      assignmentId: assignment.id, attemptId: draft.id,
      answers: [{ questionId, essayText: 'Tôi sẽ làm theo quy trình.' }],
    });

    const result = await context.attempts.submit(member, {
      assignmentId: assignment.id, operationId: 'essay-submit',
    });

    expect(result.mcScore).toBeNull();
    expect((await context.assignments.getMine(member, assignment.id)).assignment.status).toBe('awaiting_essay_feedback');
  });

  it('never gives essays numeric weight in a mixed exercise', async () => {
    const context = setup();
    const assignment = await customAssignment(context, [
      {
        type: 'single_choice', prompt: 'Chọn đúng', required: true,
        options: [{ id: 'yes', label: 'Đúng' }, { id: 'no', label: 'Sai' }], correctOptionIds: ['yes'],
      },
      { type: 'essay', prompt: 'Giải thích', required: true },
    ]);
    const detail = await context.assignments.getMine(member, assignment.id);
    const [choice, essay] = detail.template.modules[0].questions;
    const draft = await context.attempts.getOrCreateDraft(member, assignment.id);
    await context.attempts.saveDraft(member, {
      assignmentId: assignment.id, attemptId: draft.id,
      answers: [
        { questionId: choice.id, selectedOptionIds: ['yes'] },
        { questionId: essay.id, essayText: 'Vì đây là đáp án đúng.' },
      ],
    });

    const result = await context.attempts.submit(member, { assignmentId: assignment.id, operationId: 'mixed' });
    expect(result.mcScore).toMatchObject({ correctCount: 1, totalCount: 1, percentage: 100 });
  });

  it('returns the same submission for one operation ID and rejects changed payload reuse', async () => {
    const context = setup();
    const assignment = await customAssignment(context, [
      { type: 'essay', prompt: 'Nêu một ý', required: true },
    ]);
    const detail = await context.assignments.getMine(member, assignment.id);
    const questionId = detail.template.modules[0].questions[0].id;
    const draft = await context.attempts.getOrCreateDraft(member, assignment.id);
    await context.attempts.saveDraft(member, {
      assignmentId: assignment.id, attemptId: draft.id, answers: [{ questionId, essayText: 'Ý thứ nhất' }],
    });
    const first = await context.attempts.submit(member, { assignmentId: assignment.id, operationId: 'same-op' });
    const second = await context.attempts.submit(member, { assignmentId: assignment.id, operationId: 'same-op' });
    expect(second.attemptId).toBe(first.attemptId);

    await context.assignments.grantRetry(admin, assignment.id);
    const retry = await context.attempts.getOrCreateDraft(member, assignment.id);
    await context.attempts.saveDraft(member, {
      assignmentId: assignment.id, attemptId: retry.id, answers: [{ questionId, essayText: 'Payload đã đổi' }],
    });
    await expect(context.attempts.submit(member, {
      assignmentId: assignment.id, operationId: 'same-op',
    })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });

  it('never reuses a submission operation ID for another assignment', async () => {
    const context = setup();
    const firstAssignment = await customAssignment(context, [
      { type: 'essay', prompt: 'Bài thứ nhất', required: true },
    ]);
    const firstDetail = await context.assignments.getMine(member, firstAssignment.id);
    const firstDraft = await context.attempts.getOrCreateDraft(member, firstAssignment.id);
    await context.attempts.saveDraft(member, {
      assignmentId: firstAssignment.id, attemptId: firstDraft.id,
      answers: [{ questionId: firstDetail.template.modules[0].questions[0].id, essayText: 'Một' }],
    });
    await context.attempts.submit(member, { assignmentId: firstAssignment.id, operationId: 'assignment-bound-op' });

    const secondAssignment = await customAssignment(context, [
      { type: 'essay', prompt: 'Bài thứ hai', required: true },
    ]);
    const secondDetail = await context.assignments.getMine(member, secondAssignment.id);
    const secondDraft = await context.attempts.getOrCreateDraft(member, secondAssignment.id);
    await context.attempts.saveDraft(member, {
      assignmentId: secondAssignment.id, attemptId: secondDraft.id,
      answers: [{ questionId: secondDetail.template.modules[0].questions[0].id, essayText: 'Hai' }],
    });

    await expect(context.attempts.submit(member, {
      assignmentId: secondAssignment.id, operationId: 'assignment-bound-op',
    })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });

  it('never returns answer keys or another learner result', async () => {
    const context = setup();
    const assignment = await foundation(context);
    await unlockAll(context.assignments, assignment.id);
    const draft = await context.attempts.getOrCreateDraft(member, assignment.id);
    await context.attempts.saveDraft(member, {
      assignmentId: assignment.id, attemptId: draft.id, answers: correctFoundationAnswers(),
    });
    const result = await context.attempts.submit(member, { assignmentId: assignment.id, operationId: 'private' });

    expect(JSON.stringify(result)).not.toContain('correctOptionIds');
    await expect(context.attempts.getLearnerResult(other, result.attemptId)).rejects.toMatchObject({
      code: 'MEMBER_FORBIDDEN',
    });
  });

  it('enforces attempt limits until an Admin grants retry', async () => {
    const context = setup();
    const assignment = await customAssignment(context, [
      { type: 'essay', prompt: 'Trả lời', required: true },
    ]);
    const detail = await context.assignments.getMine(member, assignment.id);
    const draft = await context.attempts.getOrCreateDraft(member, assignment.id);
    await context.attempts.saveDraft(member, {
      assignmentId: assignment.id, attemptId: draft.id,
      answers: [{ questionId: detail.template.modules[0].questions[0].id, essayText: 'Đã trả lời' }],
    });
    await context.attempts.submit(member, { assignmentId: assignment.id, operationId: 'limit' });

    await expect(context.attempts.getOrCreateDraft(member, assignment.id)).rejects.toMatchObject({ code: 'ATTEMPT_LIMIT' });
    await context.assignments.grantRetry(admin, assignment.id);
    await expect(context.attempts.getOrCreateDraft(member, assignment.id)).resolves.toMatchObject({ ordinal: 2 });
  });
});
