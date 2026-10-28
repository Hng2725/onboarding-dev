import { describe, expect, it } from 'vitest';

import {
  createModuleLearningService,
  deriveModuleStates,
} from '../src/onboarding/module-learning';
import type { ModuleProgressRecord, TemplateSnapshot } from '../src/onboarding/contracts';
import {
  moduleAdmin,
  moduleLearner,
  moduleOtherLearner,
  seedAiAssignment,
} from './helpers/ai-assignment-fixture';

function answerEvery(
  started: Awaited<ReturnType<ReturnType<typeof createModuleLearningService>['startModuleQuiz']>>,
  correct = false,
) {
  return started.questions.map((question) => ({
    questionId: question.id,
    selectedOptionId: question.options.find((option) =>
      option.label === (correct ? 'Open Orders' : 'Open Reports'))!.id,
  }));
}

describe('per-module learning', () => {
  it('uses the exact state precedence: passed, locked, needs_support, quiz_failed, quiz_ready, learning, available', () => {
    const modules = Array.from({ length: 7 }, (_, index) => ({
      id: 'm' + String(index + 1),
      key: 'm' + String(index + 1),
      title: 'Module ' + String(index + 1),
      description: '',
      order: index + 1,
      resources: [],
      questions: [],
    }));
    const snapshot = {
      id: 'template', version: 1, source: 'ai_generated', status: 'published',
      employeeType: 'normal', title: 'States', description: '', modules,
      content: {
        assessmentMode: 'per_module', learningMode: 'free', maxAttemptsPerModule: 1,
        modules: modules.map((module) => ({
          moduleId: module.id, frameKey: module.key, objectives: ['a', 'b'],
          estimatedMinutes: 1, blocks: [],
        })),
        questionMeta: [],
      },
    } satisfies TemplateSnapshot;
    const base = {
      id: 'p', roomId: 'room-a', assignmentId: 'a', memberId: 'member-1',
      attemptCount: 0, extraAttempts: 0, createdAt: 't', updatedAt: 't',
    };
    const progress: ModuleProgressRecord[] = [
      { ...base, id: 'p1', moduleId: 'm1', passedAt: 't', attemptCount: 4 },
      { ...base, id: 'p2', moduleId: 'm2', attemptCount: 1 },
      { ...base, id: 'p3', moduleId: 'm3', attemptCount: 1, extraAttempts: 1 },
      { ...base, id: 'p4', moduleId: 'm4', lessonCompletedAt: 't' },
      { ...base, id: 'p5', moduleId: 'm5', openedAt: 't' },
      { ...base, id: 'p6', moduleId: 'm6' },
    ];

    expect(deriveModuleStates(snapshot, progress).map((state) => state.status)).toEqual([
      'passed', 'needs_support', 'quiz_failed', 'quiz_ready', 'learning', 'available', 'available',
    ]);
    const sequential = {
      ...snapshot,
      content: { ...snapshot.content, learningMode: 'sequential' as const },
    };
    const blockedProgress = progress.map((item) => item.moduleId === 'm1'
      ? { ...item, passedAt: undefined }
      : item);
    expect(deriveModuleStates(sequential, blockedProgress)[1].status).toBe('locked');
  });

  it('opens lessons, submits quizzes idempotently, unlocks the next module, and updates progress', async () => {
    const context = await seedAiAssignment();
    const service = createModuleLearningService(
      context.store,
      context.assignments,
      context.notifications,
      { now: context.now, randomInt: () => 0 },
    );
    const initial = await service.getModules(moduleLearner, context.assignment.id);
    expect(initial.map((module) => module.status)).toEqual([
      'available', 'locked', 'locked', 'locked',
    ]);
    await service.openModule(moduleLearner, context.assignment.id, initial[0].moduleId);
    expect((await service.getModules(moduleLearner, context.assignment.id))[0].status).toBe('learning');
    await service.completeLesson(moduleLearner, context.assignment.id, initial[0].moduleId);
    expect((await service.getModules(moduleLearner, context.assignment.id))[0].status).toBe('quiz_ready');
    expect((await context.assignments.listMine(moduleLearner))[0].progressPercent).toBe(13);
    const started = await service.startModuleQuiz(moduleLearner, context.assignment.id, initial[0].moduleId);
    const result = await service.submitModuleQuiz(moduleLearner, {
      assignmentId: context.assignment.id,
      moduleId: initial[0].moduleId,
      attemptId: started.attemptId,
      operationId: 'submit-module-1',
      answers: answerEvery(started, true),
    });
    const replay = await service.submitModuleQuiz(moduleLearner, {
      assignmentId: context.assignment.id,
      moduleId: initial[0].moduleId,
      attemptId: started.attemptId,
      operationId: 'submit-module-1',
      answers: answerEvery(started, true),
    });

    expect(result).toMatchObject({ score: 100, passed: true, attemptsUsed: 1, attemptsAllowed: 3 });
    expect(replay).toEqual(result);
    expect((await service.getModules(moduleLearner, context.assignment.id))
      .map((module) => module.status)).toEqual(['passed', 'available', 'locked', 'locked']);
    expect((await context.assignments.getMine(moduleLearner, context.assignment.id)).assignment.status)
      .toBe('in_progress');
    expect((await context.assignments.listMine(moduleLearner))[0].progressPercent).toBe(25);
  });

  it('enforces attempt limits, then an Admin retry grant restores quiz access', async () => {
    const context = await seedAiAssignment(1);
    const service = createModuleLearningService(
      context.store,
      context.assignments,
      context.notifications,
      { now: context.now, randomInt: () => 0 },
    );
    const moduleId = (await service.getModules(moduleLearner, context.assignment.id))[0].moduleId;
    await service.openModule(moduleLearner, context.assignment.id, moduleId);
    await service.completeLesson(moduleLearner, context.assignment.id, moduleId);
    const started = await service.startModuleQuiz(moduleLearner, context.assignment.id, moduleId);
    await service.submitModuleQuiz(moduleLearner, {
      assignmentId: context.assignment.id,
      moduleId,
      attemptId: started.attemptId,
      operationId: 'wrong-once',
      answers: answerEvery(started, false),
    });

    expect((await service.getModules(moduleLearner, context.assignment.id))[0].status).toBe('needs_support');
    await expect(service.startModuleQuiz(moduleLearner, context.assignment.id, moduleId))
      .rejects.toMatchObject({ code: 'MODULE_ATTEMPT_LIMIT' });
    await service.grantModuleRetry(moduleAdmin, context.assignment.id, moduleId);
    expect((await service.getModules(moduleLearner, context.assignment.id))[0].status).toBe('quiz_failed');
    await expect(service.startModuleQuiz(moduleLearner, context.assignment.id, moduleId))
      .resolves.toHaveProperty('attemptId');
  });

  it('summarizes modules needing support and open AI review flags for the Admin dashboard', async () => {
    const context = await seedAiAssignment(1);
    const service = createModuleLearningService(
      context.store,
      context.assignments,
      context.notifications,
      { now: context.now, randomInt: () => 0 },
    );
    const moduleId = (await service.getModules(moduleLearner, context.assignment.id))[0].moduleId;
    await service.openModule(moduleLearner, context.assignment.id, moduleId);
    await service.completeLesson(moduleLearner, context.assignment.id, moduleId);
    const started = await service.startModuleQuiz(moduleLearner, context.assignment.id, moduleId);
    await service.submitModuleQuiz(moduleLearner, {
      assignmentId: context.assignment.id,
      moduleId,
      attemptId: started.attemptId,
      operationId: 'dashboard-wrong-once',
      answers: answerEvery(started, false),
    });

    await expect(service.dashboardSummary(moduleAdmin)).resolves.toEqual({
      needsSupportModules: 1,
      openFlags: 1,
    });
    await expect(service.dashboardSummary(moduleLearner))
      .rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  });

  it('rejects cross-member access and completes the assignment after every module passes', async () => {
    const context = await seedAiAssignment();
    const service = createModuleLearningService(
      context.store,
      context.assignments,
      context.notifications,
      { now: context.now, randomInt: () => 0 },
    );
    await expect(service.getModules(moduleOtherLearner, context.assignment.id))
      .rejects.toMatchObject({ code: 'MEMBER_FORBIDDEN' });

    for (const module of await service.getModules(moduleLearner, context.assignment.id)) {
      await service.openModule(moduleLearner, context.assignment.id, module.moduleId);
      await service.completeLesson(moduleLearner, context.assignment.id, module.moduleId);
      const started = await service.startModuleQuiz(moduleLearner, context.assignment.id, module.moduleId);
      await service.submitModuleQuiz(moduleLearner, {
        assignmentId: context.assignment.id,
        moduleId: module.moduleId,
        attemptId: started.attemptId,
        operationId: 'pass-' + module.moduleId,
        answers: answerEvery(started, true),
      });
    }

    expect((await context.assignments.getMine(moduleLearner, context.assignment.id)).assignment.status)
      .toBe('passed');
    expect((await context.assignments.listMine(moduleLearner))[0].progressPercent).toBe(100);
    expect(context.deliveries.some((delivery) => delivery.memberId === moduleLearner.userId)).toBe(true);
  });
});
