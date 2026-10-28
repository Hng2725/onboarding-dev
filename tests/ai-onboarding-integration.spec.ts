import { describe, expect, it, vi } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import { createAssignmentService } from '../src/onboarding/assignments';
import { createAiJobService } from '../src/onboarding/ai/jobs';
import { createAiPublishGuard, createAiReviewService } from '../src/onboarding/ai/review';
import { createSourceService } from '../src/onboarding/ai/sources';
import type { GeneratedTemplate } from '../src/onboarding/ai/validate';
import { createEmployeeService } from '../src/onboarding/employees';
import { createModuleLearningService } from '../src/onboarding/module-learning';
import { createTemplateService } from '../src/onboarding/templates';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { generatedTemplate } from './helpers/ai-template-fixture';
import { seedAiSource } from './helpers/ai-template-fixture';
import { approvedModuleJob } from './helpers/approved-module-fixture';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };
const learner: OnboardingActor = { userId: 'member-1', roomId: 'room-a', access: 'learner' };
const sourceQuote = 'Open the Orders menu and select Create order to begin a new order.';

function generatedWithEvidence(sectionId: string): GeneratedTemplate {
  const ref = { sectionId, quote: sourceQuote };
  return {
    ...generatedTemplate,
    modules: generatedTemplate.modules.map((module) => ({
      ...module,
      blocks: module.blocks.map((block) => ({
        ...block,
        sourceRefs: block.sourceRefs.length ? [ref] : [],
      })),
      questions: module.questions.map((question) => ({
        ...question,
        sourceRefs: [ref],
      })),
    })),
    flags: generatedTemplate.flags.map((flag) => ({ ...flag, evidence: [ref] })),
  };
}

function correctAnswers(started: {
  readonly questions: readonly {
    readonly id: string;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  }[];
}, correct: boolean) {
  return started.questions.map((question) => ({
    questionId: question.id,
    selectedOptionId: question.options.find((option) =>
      option.label === (correct ? 'Open Orders' : 'Open Reports'))!.id,
  }));
}

describe('AI onboarding integration', () => {
  it('materializes current approved module pairs on completion without publishing', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const job = approvedModuleJob();
    await store.create(admin.roomId, 'onboarding_ai_jobs', { ...job, status: 'running' });
    const jobs = createAiJobService(store);
    const completed = await jobs.nextStep(admin, { jobId: job.jobId, workerId: 'test-worker' });
    expect(completed).toMatchObject({ kind: 'done', job: { status: 'completed', result: { templateId: expect.any(String), version: 1 } } });
    const catalog = await createTemplateService(store).list(admin);
    expect(catalog.filter((t) => t.source === 'ai_generated')).toEqual([expect.objectContaining({ status: 'draft' })]);
    expect(await store.count(admin.roomId, 'onboarding_resources')).toBe(0);
  });
  it('runs document ingestion through generation, review, publish, assignment, retry, and completion', async () => {
    const store = new MemoryOnboardingStore();
    let tick = 0;
    const now = () => '2026-10-23T14:00:' + String(++tick).padStart(2, '0') + '.000Z';
    const markdown = '# Orders\n\n' + sourceQuote;
    const bytes = Buffer.from(markdown, 'utf8');
    const sources = createSourceService(store, {
      now,
      readFileMetadata: async () => ({
        fileId: 'file-orders',
        fileName: 'orders.md',
        mimeType: 'text/markdown',
        size: bytes.byteLength,
      }),
    });
    const source = await sources.ingestSource(admin, {
      operationId: 'source-integration',
      fileId: 'file-orders',
      fileName: 'orders.md',
      mimeType: 'text/markdown',
      base64: bytes.toString('base64'),
      systemName: 'Order System',
    });
    const storedSource = (await store.query<{
      readonly sourceId: string;
      readonly sections: readonly { readonly id: string; readonly text: string }[];
    }>('room-a', 'onboarding_sources', { filter: { sourceId: source.sourceId } })).records[0];
    const section = storedSource.sections.find((item) => item.text.includes(sourceQuote))!;

    const jobs = createAiJobService(store, { now });
    const inventoryJob = await jobs.startJob(admin, {
      kind: 'inventory',
      sourceIds: [source.sourceId],
      operationId: 'inventory-integration',
    });
    await jobs.nextStep(admin, { jobId: inventoryJob.jobId, workerId: 'integration-worker' });
    const inventory = await jobs.submitAiOutput(admin, {
      jobId: inventoryJob.jobId,
      workerId: 'integration-worker',
      callId: 'A1',
      text: JSON.stringify({
        systemSummary: {
          purpose: 'Manage orders',
          modules: ['Orders'],
          sourceRefs: [{ sectionId: section.id, quote: sourceQuote }],
        },
        glossary: [],
        features: [{
          localId: 'feat-1',
          name: 'Create order',
          module: 'Orders',
          purpose: 'Create a new order',
          steps: [{
            order: 1,
            action: 'Open Orders',
            sourceRefs: [{ sectionId: section.id, quote: sourceQuote }],
          }],
          audience: 'all',
          departments: [],
          roles: [],
          sourceRefs: [{ sectionId: section.id, quote: sourceQuote }],
        }],
        flags: [],
      }),
    });
    expect(inventory.status).toBe('completed');

    // Continue a persisted pre-module job through its original review/publish path.
    await store.create(admin.roomId, 'onboarding_ai_jobs', {
      jobId: 'legacy-template-integration',
      kind: 'template',
      pipelineVersion: 'legacy',
      status: 'running',
      inventoryJobId: inventoryJob.jobId,
      templateKind: 'normal',
      operationId: 'template-integration',
      sourceIds: inventory.sourceIds,
      promptVersion: '2026-10-23.1',
      calls: [{ callId: 'B-lessons', stage: 'B', operationId: 'legacy-template-integration:B-lessons', status: 'pending' }],
      stageOutputs: { __inventory: inventory.result, __repairMode: 'module' },
      createdBy: admin.userId, createdAt: now(), updatedAt: now(),
    });
    const templateJob = await jobs.getJob(admin, 'legacy-template-integration');
    const generated = generatedWithEvidence(section.id);
    await jobs.nextStep(admin, { jobId: templateJob.jobId, workerId: 'integration-worker' });
    await jobs.submitAiOutput(admin, {
      jobId: templateJob.jobId,
      workerId: 'integration-worker',
      callId: 'B-lessons',
      text: JSON.stringify(generated),
    });
    await jobs.nextStep(admin, { jobId: templateJob.jobId, workerId: 'integration-worker' });
    const verifying = await jobs.submitAiOutput(admin, {
      jobId: templateJob.jobId,
      workerId: 'integration-worker',
      callId: 'B-questions',
      text: JSON.stringify(generated),
    });
    const batches = verifying.stageOutputs.__verificationBatches as readonly (
      readonly { readonly id: string }[]
    )[];
    let completed = verifying;
    for (let index = 0; index < batches.length; index += 1) {
      await jobs.nextStep(admin, { jobId: templateJob.jobId, workerId: 'integration-worker' });
      completed = await jobs.submitAiOutput(admin, {
        jobId: templateJob.jobId,
        workerId: 'integration-worker',
        callId: 'D' + String(index + 1),
        text: JSON.stringify({
          verdicts: batches[index].map((claim) => ({
            id: claim.id,
            verdict: 'supported',
            reason: 'Supported by the uploaded guide.',
          })),
        }),
      });
    }
    expect(completed.status).toBe('completed');
    const output = completed.result as { readonly templateId: string; readonly version: number };

    const templates = createTemplateService(store, {
      now,
      publishGuard: createAiPublishGuard(store),
    });
    const review = createAiReviewService(store, templates, { now });
    const draft = await review.getReview(admin, output.templateId, output.version);
    const firstBlock = draft.content!.modules[0].blocks[0];
    const edited = await review.updateReview(admin, {
      templateId: draft.id,
      version: draft.version,
      expectedUpdatedAt: draft.updatedAt,
      ops: [{
        kind: 'update_block',
        moduleId: draft.content!.modules[0].moduleId,
        blockId: firstBlock.id,
        body: firstBlock.body + ' Admin reviewed.',
      }],
    });
    const warning = edited.flags!.find((flag) => flag.severity === 'warning')!;
    const clean = await review.resolveFlag(admin, {
      templateId: edited.id,
      version: edited.version,
      flagId: warning.id,
      action: 'accept',
      note: 'Reviewed by the process owner.',
      expectedUpdatedAt: edited.updatedAt,
    });
    const prepared = await review.updateReview(admin, {
      templateId: clean.id,
      version: clean.version,
      expectedUpdatedAt: clean.updatedAt,
      ops: clean.modules.map((module, index) => ({
        kind: 'upsert_generated_resource' as const,
        moduleId: module.id,
        resource: {
          id: `ai-lesson-pdf-${module.id}`,
          title: `Tài liệu ${module.title}`,
          kind: 'file' as const,
          required: true,
          fileId: `file-lesson-${index + 1}`,
        },
      })),
    });
    expect(prepared.modules.every((module) => module.resources.some((resource) =>
      resource.kind === 'file' && resource.required && Boolean(resource.fileId)))).toBe(true);
    const published = await templates.publish(
      admin,
      prepared.id,
      prepared.version,
      prepared.updatedAt,
    );

    const callPlatform = vi.fn().mockResolvedValue({
      members: [{ userId: 'admin-1' }, { userId: 'member-1' }],
    });
    const employees = createEmployeeService(store, { callPlatform, now });
    await employees.add(admin, { memberId: learner.userId, employeeType: 'normal' });
    const notifications = { notify: vi.fn().mockResolvedValue({ delivered: true }) };
    const assignments = createAssignmentService(store, templates, {
      employees,
      callPlatform,
      notifications,
      now,
    });
    const assigned = await assignments.assign(admin, {
      memberId: learner.userId,
      templateId: published.id,
      templateVersion: published.version,
    });
    const learning = createModuleLearningService(store, assignments, notifications, {
      now,
      randomInt: () => 0,
    });

    const initialModules = await learning.getModules(learner, assigned.assignment.id);
    for (let index = 0; index < initialModules.length; index += 1) {
      const moduleId = initialModules[index].moduleId;
      await learning.openModule(learner, assigned.assignment.id, moduleId);
      await learning.completeLesson(learner, assigned.assignment.id, moduleId);
      let started = await learning.startModuleQuiz(learner, assigned.assignment.id, moduleId);
      expect(JSON.stringify(started)).not.toMatch(/correctOption|explanation/);
      if (index === 0) {
        const failed = await learning.submitModuleQuiz(learner, {
          assignmentId: assigned.assignment.id,
          moduleId,
          attemptId: started.attemptId,
          operationId: 'fail-first-module',
          answers: correctAnswers(started, false),
        });
        expect(failed.passed).toBe(false);
        started = await learning.startModuleQuiz(learner, assigned.assignment.id, moduleId);
      }
      const passed = await learning.submitModuleQuiz(learner, {
        assignmentId: assigned.assignment.id,
        moduleId,
        attemptId: started.attemptId,
        operationId: 'pass-module-' + String(index),
        answers: correctAnswers(started, true),
      });
      expect(passed.passed).toBe(true);
    }

    const finalAssignment = await assignments.getMine(learner, assigned.assignment.id);
    expect(finalAssignment.assignment.status).toBe('passed');
    expect((await assignments.listMine(learner))[0].progressPercent).toBe(100);
    expect(notifications.notify).toHaveBeenCalled();
  });
});
