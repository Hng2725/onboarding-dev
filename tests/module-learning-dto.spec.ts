import { describe, expect, it } from 'vitest';

import { createModuleLearningService } from '../src/onboarding/module-learning';
import { moduleLearner, seedAiAssignment } from './helpers/ai-assignment-fixture';

describe('module learning DTO boundary', () => {
  it('omits internal materialization and artifact metadata from the assigned learner lesson', async () => {
    const context = await seedAiAssignment();
    const row = (await context.store.query('room-a', 'onboarding_assignments', { filter: { id: context.assignment.id } })).records[0];
    const snapshot = row.templateSnapshot as import('../src/onboarding/contracts').TemplateSnapshot;
    await context.store.update('room-a', 'onboarding_assignments', context.assignment.id, { templateSnapshot: { ...snapshot, content: { ...snapshot.content, moduleApproval: { fingerprint: 'private' }, publication: { pdfs: {}, jsonFileId: 'private' }, modules: snapshot.content!.modules.map((m) => ({ ...m, lessonProvenance: 'manual', approvedLessonVersion: 1 })) } } });
    const detail = await context.assignments.getMine(moduleLearner, context.assignment.id);
    expect(JSON.stringify(detail)).not.toMatch(/lessonProvenance|approvedLessonVersion|moduleApproval|publication/);
  });
  it('hides answer keys, explanations, and source refs until a submitted attempt is requested', async () => {
    const context = await seedAiAssignment();
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

    expect(JSON.stringify(started)).not.toContain('correctOption');
    expect(JSON.stringify(started)).not.toContain('explanation');
    expect(JSON.stringify(started)).not.toContain('sourceRefs');
    await expect(service.getModuleAttempt(moduleLearner, started.attemptId))
      .rejects.toMatchObject({ code: 'MODULE_ATTEMPT_NOT_FOUND' });

    const submitted = await service.submitModuleQuiz(moduleLearner, {
      assignmentId: context.assignment.id,
      moduleId,
      attemptId: started.attemptId,
      operationId: 'dto-submit',
      answers: started.questions.map((question) => ({
        questionId: question.id,
        selectedOptionId: question.options[0].id,
      })),
    });
    const fetched = await service.getModuleAttempt(moduleLearner, started.attemptId);

    expect(fetched).toEqual(submitted);
    expect(fetched.items[0]).toEqual(expect.objectContaining({
      correctOptionId: expect.any(String),
      explanation: expect.any(String),
      sourceRefs: expect.any(Array),
      blockIds: expect.any(Array),
    }));
  });
});
