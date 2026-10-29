import { describe, expect, it, vi } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import {
  AiJobServiceError,
  buildVerificationClaims,
  createAiJobService,
  parseVerificationVerdicts,
  type AiJobService,
  type StartTemplateJobInput,
} from '../src/onboarding/ai/jobs';
import { AI_GENERATION_LIMITS } from '../src/onboarding/ai/limits';
import { createTemplateService } from '../src/onboarding/templates';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { generatedTemplate, seedAiSource } from './helpers/ai-template-fixture';
import { completePlan } from './helpers/complete-plan';
import { isModuleCovered } from '../src/onboarding/ai/outline-coverage';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };
const otherAdmin: OnboardingActor = { userId: 'admin-2', roomId: 'room-b', access: 'admin' };
const learner: OnboardingActor = { userId: 'member-1', roomId: 'room-a', access: 'learner' };

/** Existing persisted jobs exercise the legacy pipeline; new starts are always module_v2. */
async function seedLegacyTemplate(store: MemoryOnboardingStore, service: AiJobService, input: StartTemplateJobInput) {
  const inventory = await service.getJob(admin, input.inventoryJobId);
  const jobId = 'legacy-' + input.operationId;
  const callId = input.templateKind === 'advanced' ? 'C-lessons' : 'B-lessons';
  await store.create(admin.roomId, 'onboarding_ai_jobs', {
    ...input, jobId, status: 'running', sourceIds: inventory.sourceIds,
    promptVersion: '2026-10-23.1', calls: [{ callId, stage: input.templateKind === 'advanced' ? 'C' : 'B', operationId: jobId + ':' + callId, status: 'pending' }],
    stageOutputs: { __inventory: inventory.result, __repairMode: 'module' }, createdBy: admin.userId,
    createdAt: '2026-10-23T08:00:00.000Z', updatedAt: '2026-10-23T08:00:00.000Z',
  });
  const job = await service.getJob(admin, jobId);
  expect(job.pipelineVersion).toBeUndefined();
  expect(job.moduleRuns).toBeUndefined();
  return job;
}

const inventoryOutput = JSON.stringify({
  systemSummary: {
    purpose: 'Quản lý đơn hàng',
    modules: ['Bán hàng'],
    sourceRefs: [{
      sectionId: 'source-1#s1',
      quote: 'Bấm nút Gửi duyệt để chuyển đơn.',
    }],
  },
  glossary: [],
  features: [{
    localId: 'f1',
    name: 'Duyệt đơn',
    module: 'Bán hàng',
    purpose: 'Chuyển đơn sang bước duyệt',
    steps: [{
      order: 1,
      action: 'Bấm Gửi duyệt',
      sourceRefs: [{
        sectionId: 'source-1#s1',
        quote: 'Bấm nút Gửi duyệt để chuyển đơn.',
      }],
    }],
    audience: 'all',
    departments: [],
    roles: [],
    sourceRefs: [{
      sectionId: 'source-1#s1',
      quote: 'Bấm nút Gửi duyệt để chuyển đơn.',
    }],
  }],
  flags: [],
});

async function setup() {
  const store = new MemoryOnboardingStore();
  await store.create('room-a', 'onboarding_sources', {
    sourceId: 'source-1',
    kind: 'document',
    fileName: 'guide.md',
    checksum: 'checksum',
    systemName: 'PrivOS',
    status: 'ready',
    sections: [{
      id: 'source-1#s1',
      headingPath: ['Duyệt đơn'],
      text: 'Bấm nút Gửi duyệt để chuyển đơn.',
    }],
    textLength: 35,
    createdBy: 'admin-1',
    createdAt: '2026-10-23T08:00:00.000Z',
    updatedAt: '2026-10-23T08:00:00.000Z',
  });
  let nowMs = Date.parse('2026-10-23T08:00:00.000Z');
  const service = createAiJobService(store, { now: () => new Date(nowMs).toISOString() });
  return {
    service,
    store,
    advance(ms: number) { nowMs += ms; },
  };
}

describe('AI job service', () => {
  it('creates a grounded fallback question draft and records its provenance in approval audit', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    await store.create(admin.roomId, 'onboarding_ai_jobs', {
      jobId: 'inventory-fallback-questions', kind: 'inventory', status: 'completed', sourceIds: ['source-1'],
      promptVersion: 'old', calls: [], stageOutputs: {},
      result: { systemSummary: { purpose: 'Orders', modules: [], sourceRefs: generatedTemplate.modules[0].blocks[0].sourceRefs }, glossary: [], features: [], flags: [] },
      operationId: 'inventory-fallback-questions', createdBy: admin.userId,
      createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
    });
    const service = createAiJobService(store, { now: () => '2026-10-29T01:00:00.000Z' });
    const job = await service.startJob(admin, {
      kind: 'template', inventoryJobId: 'inventory-fallback-questions', templateKind: 'normal', operationId: 'fallback-questions',
    });
    await completePlan(service, admin, job);
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    const run = job.moduleRuns![0];
    const args = { jobId: job.jobId, moduleLocalId: run.outline.moduleLocalId };
    const module = { ...generatedTemplate.modules[0], localId: run.outline.moduleLocalId, frameKey: run.outline.frameKey, featureIds: run.outline.featureIds, questions: [] };
    let current = await service.updateModuleLesson(admin, { ...args, expectedVersion: 0, module });
    current = await service.approveModuleLesson(admin, { ...args, expectedVersion: current.moduleRuns![0].lessonVersion });

    await expect(service.useQuestionFallback(admin, { ...args, expectedVersion: 1 })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    current = await service.useQuestionFallback(admin, { ...args, expectedVersion: 0 });
    expect(current.moduleRuns![0]).toMatchObject({
      questionState: 'review_ready', questionVersion: 1, questionLessonVersion: 1, questionProvenance: 'fallback',
    });
    expect(current.moduleRuns![0].questionDraft).toHaveLength(3);

    current = await service.approveModuleQuestions(admin, { ...args, expectedVersion: 1 });
    expect((current.stageOutputs.__moduleAudit as readonly Record<string, unknown>[]).at(-1)).toMatchObject({
      target: 'questions', provenance: 'fallback', version: 1, lessonVersion: 1,
    });
  });

  it('passes the other active outline modules, sorted by order, as relatedModules in the lesson call', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    await store.create(admin.roomId, 'onboarding_ai_jobs', {
      jobId: 'inventory-related', kind: 'inventory', status: 'completed', sourceIds: ['source-1'],
      promptVersion: 'old', calls: [], stageOutputs: {},
      result: { systemSummary: { purpose: 'Orders', modules: [], sourceRefs: generatedTemplate.modules[0].blocks[0].sourceRefs }, glossary: [], features: [], flags: [] },
      operationId: 'inventory-related', createdBy: admin.userId,
      createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
    });
    const service = createAiJobService(store, { now: () => '2026-10-29T01:00:00.000Z' });
    let job = await service.startJob(admin, {
      kind: 'template', inventoryJobId: 'inventory-related', templateKind: 'normal', operationId: 'related',
    });
    await completePlan(service, admin, job);
    const modules = job.outline!.modules;
    expect(modules.length).toBeGreaterThanOrEqual(3);
    const tombstoneId = modules[modules.length - 1].moduleLocalId;
    const moveId = modules[0].moduleLocalId;
    job = await service.updateOutline(admin, {
      jobId: job.jobId, expectedRevision: 1,
      edits: [
        ...modules.map((m) => ({ type: 'update' as const, moduleLocalId: m.moduleLocalId, patch: { sourceSectionIds: ['source-1#s1'] } })),
        { type: 'delete' as const, moduleLocalId: tombstoneId },
        { type: 'add' as const, module: { ...modules[modules.length - 1], sourceSectionIds: ['source-1#s1'] } },
        { type: 'reorder' as const, moduleLocalId: moveId, order: 9 },
      ],
    });
    job = await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (step.kind !== 'ai_call') throw new Error('Expected a lesson call.');

    const current = await service.getJob(admin, job.jobId);
    const draftedId = current.calls.at(-1)!.moduleLocalId!;
    const active = current.moduleRuns!.map((run) => run.outline).filter((o) => !o.tombstoned);
    expect(current.moduleRuns!.some((run) => run.outline.moduleLocalId === tombstoneId && run.outline.tombstoned)).toBe(true);
    expect(active.length).toBeGreaterThanOrEqual(2);
    const expected = active.filter((o) => o.moduleLocalId !== draftedId).sort((a, b) => a.order - b.order).map((o) => ({ order: o.order, title: o.title }));
    const raw = step.systemContext.split('<module_data>')[1].split('</module_data>')[0].trim();
    const moduleData = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&')) as { relatedModules: unknown };
    expect(moduleData.relatedModules).toEqual(expected);
    expect(expected.length).toBe(active.length - 1);
    expect(expected.map((e) => e.order)).toEqual([...expected.map((e) => e.order)].sort((a, b) => a - b));
    expect(draftedId).not.toBe(moveId);
    expect(expected.at(-1)!.title).toBe(modules[0].title);
    expect(JSON.stringify(moduleData.relatedModules)).not.toContain(String(current.moduleRuns!.find((run) => run.outline.moduleLocalId === tombstoneId)!.outline.moduleLocalId));
  });

  it('rejects deterministic question fallback without grounded lesson blocks and leaves the run unchanged', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    await store.create(admin.roomId, 'onboarding_ai_jobs', {
      jobId: 'inventory-source-free-questions', kind: 'inventory', status: 'completed', sourceIds: ['source-1'],
      promptVersion: 'old', calls: [], stageOutputs: {},
      result: { systemSummary: { purpose: 'Orders', modules: [], sourceRefs: generatedTemplate.modules[0].blocks[0].sourceRefs }, glossary: [], features: [], flags: [] },
      operationId: 'inventory-source-free-questions', createdBy: admin.userId,
      createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
    });
    const service = createAiJobService(store, { now: () => '2026-10-29T01:00:00.000Z' });
    let job = await service.startJob(admin, {
      kind: 'template', inventoryJobId: 'inventory-source-free-questions', templateKind: 'normal', operationId: 'source-free-questions',
    });
    await completePlan(service, admin, job);
    const moduleLocalId = job.moduleRuns![0].outline.moduleLocalId;
    job = await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'update', moduleLocalId, patch: { sourceSectionIds: [] } }] });
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
    const run = job.moduleRuns![0];
    const module = {
      ...generatedTemplate.modules[0], localId: moduleLocalId, frameKey: run.outline.frameKey,
      featureIds: run.outline.featureIds, blocks: generatedTemplate.modules[0].blocks.map((block) => ({ ...block, sourceRefs: [] })), questions: [],
    };
    const args = { jobId: job.jobId, moduleLocalId };
    job = await service.updateModuleLesson(admin, { ...args, expectedVersion: run.lessonVersion, module });
    job = await service.approveModuleLesson(admin, { ...args, expectedVersion: job.moduleRuns![0].lessonVersion });
    const before = job.moduleRuns![0];

    await expect(service.useQuestionFallback(admin, { ...args, expectedVersion: before.questionVersion }))
      .rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect((await service.getJob(admin, job.jobId)).moduleRuns![0]).toEqual(before);
  });

  it('propagates optimistic conflict for questions captured before the first approved lesson is replaced', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const sourceRefs = generatedTemplate.modules[0].blocks[0].sourceRefs;
    await store.create(admin.roomId, 'onboarding_ai_jobs', {
      jobId: 'inventory-question-version', kind: 'inventory', status: 'completed', sourceIds: ['source-1'],
      promptVersion: 'old', calls: [], stageOutputs: {},
      result: { systemSummary: { purpose: 'Orders', modules: [], sourceRefs }, glossary: [], features: [], flags: [] },
      operationId: 'inventory-question-version', createdBy: admin.userId,
      createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
    });
    const service = createAiJobService(store, { now: () => '2026-10-28T01:00:00.000Z' });
    const job = await service.startJob(admin, {
      kind: 'template', inventoryJobId: 'inventory-question-version', templateKind: 'normal', operationId: 'question-version',
    });
    await completePlan(service, admin, job);
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    const outline = job.moduleRuns![0].outline;
    const input = { jobId: job.jobId, moduleLocalId: outline.moduleLocalId };
    const module = { ...generatedTemplate.modules[0], localId: outline.moduleLocalId, frameKey: outline.frameKey, featureIds: outline.featureIds, questions: [] };
    await service.updateModuleLesson(admin, { ...input, expectedVersion: 0, module });
    const first = await service.approveModuleLesson(admin, { ...input, expectedVersion: 1 });
    const staleRequest = { ...input, expectedVersion: first.moduleRuns![0].questionVersion, questions: generatedTemplate.modules[0].questions };
    expect(staleRequest.expectedVersion).toBe(0);

    await service.updateModuleLesson(admin, { ...input, expectedVersion: 1, module: { ...module, title: 'Lesson version two' } });
    await service.approveModuleLesson(admin, { ...input, expectedVersion: 2 });
    await expect(service.updateModuleQuestions(admin, staleRequest)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });

    const current = (await service.getJob(admin, job.jobId)).moduleRuns![0];
    expect(current).toMatchObject({ lessonVersion: 2, approvedLessonVersion: 2, questionVersion: 1, questionState: 'queued' });
    expect(current.questionDraft).toBeUndefined();
    expect(current.questionLessonVersion).toBeUndefined();
    const accepted = await service.updateModuleQuestions(admin, { ...staleRequest, expectedVersion: 1 });
    expect(accepted.moduleRuns![0]).toMatchObject({ questionVersion: 2, questionLessonVersion: 2, questionState: 'review_ready' });
  });
  it('builds one verification claim per learning sentence, step, and scored question', () => {
    const template = {
      ...generatedTemplate,
      modules: generatedTemplate.modules.map((module, moduleIndex) => moduleIndex === 0
        ? {
          ...module,
          blocks: [{
            localId: 'm1-concept',
            kind: 'concept' as const,
            title: 'Ignored heading',
            body: 'First documented fact. Second documented fact!',
            sourceRefs: module.blocks[0].sourceRefs,
          }, {
            localId: 'm1-steps',
            kind: 'steps' as const,
            body: 'Introductory copy is not a procedure step.',
            steps: [
              { order: 1, text: 'Open Orders.' },
              { order: 2, text: 'Choose Create order.' },
            ],
            sourceRefs: module.blocks[0].sourceRefs,
          }, module.blocks[1]],
        }
        : module),
    };

    const claims = buildVerificationClaims(template);
    const firstModule = claims.filter((claim) => claim.moduleLocalId === 'm1');

    expect(firstModule.filter((claim) => claim.blockLocalId === 'm1-concept')
      .map((claim) => claim.text)).toEqual([
      'First documented fact.',
      'Second documented fact!',
    ]);
    expect(firstModule.filter((claim) => claim.blockLocalId === 'm1-steps')
      .map((claim) => claim.text)).toEqual([
      'Open Orders.',
      'Choose Create order.',
    ]);
    expect(firstModule.filter((claim) => claim.kind === 'question')).toHaveLength(3);
    expect(firstModule.find((claim) => claim.questionLocalId === 'm1-q1')?.text)
      .toContain('Open Orders');
    expect(firstModule.find((claim) => claim.questionLocalId === 'm1-q1')?.text)
      .not.toContain('Open Reports');
    expect(firstModule.some((claim) => claim.text.includes('Ignored heading'))).toBe(false);
    expect(firstModule.some((claim) => claim.text.includes('Introductory copy'))).toBe(false);
  });

  it('treats omitted verification verdicts as partial', () => {
    const claims = buildVerificationClaims(generatedTemplate).slice(0, 2);

    expect(parseVerificationVerdicts({
      verdicts: [{
        id: claims[0].id,
        verdict: 'supported',
        reason: 'Fully supported.',
      }],
    }, claims)).toEqual([
      {
        id: claims[0].id,
        verdict: 'supported',
        reason: 'Fully supported.',
      },
      {
        id: claims[1].id,
        verdict: 'partial',
        reason: 'AI did not return a verdict for this claim.',
      },
    ]);
  });

  it('is admin-only, room-scoped, and idempotent for one start operation', async () => {
    const { service } = await setup();
    await expect(service.startJob(learner, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-1',
    })).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });

    const first = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-1',
    });
    const replay = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-1',
    });

    expect(replay).toEqual(first);
    expect(first.pipelineVersion).toBe('module_v2');
    await expect(service.getJob(otherAdmin, first.jobId)).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
  });

  it('leases one pending call, records its attempt idempotently, and lets another tab wait', async () => {
    const { service } = await setup();
    const job = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-lease',
    });

    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    expect(step).toMatchObject({
      kind: 'ai_call',
      callId: 'A1',
      operationId: job.jobId + ':A1',
      prompt: expect.stringContaining('object JSON'),
    });
    await expect(service.nextStep(admin, {
      jobId: job.jobId, workerId: 'tab-b',
    })).resolves.toMatchObject({ kind: 'wait' });

    await service.recordDispatch(admin, {
      jobId: job.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-1',
    });
    await service.recordDispatch(admin, {
      jobId: job.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-1',
    });
    await expect(service.recordDispatch(admin, {
      jobId: job.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-other',
    })).rejects.toMatchObject({ code: 'JOB_CALL_MISMATCH' });
    await expect(service.nextStep(admin, {
      jobId: job.jobId, workerId: 'tab-a',
    })).resolves.toMatchObject({
      kind: 'ai_call', attemptRef: 'attempt-1', startedAt: '2026-10-23T08:00:00.000Z',
    });
  });

  it('records provider and server-computed request sizes without storing prompt text', async () => {
    const { service } = await setup();
    const job = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-metadata',
    });
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (step.kind !== 'ai_call') throw new Error('Expected an AI call.');

    const recorded = await service.recordDispatch(admin, {
      jobId: job.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-1', provider: 'sandbox',
    });
    const call = recorded.calls.find((candidate) => candidate.callId === 'A1')!;

    expect(call).toMatchObject({
      provider: 'sandbox',
      promptChars: step.prompt.length,
      systemContextChars: step.systemContext?.length ?? 0,
    });
    const serialized = JSON.stringify(recorded.calls);
    expect(serialized).not.toContain(step.prompt);
    expect(serialized).not.toContain('Bấm nút Gửi duyệt để chuyển đơn.');
  });

  it('keeps legacy calls without provider readable', async () => {
    const { service, store } = await setup();
    await store.create('room-a', 'onboarding_ai_jobs', {
      jobId: 'legacy-native',
      kind: 'inventory',
      status: 'running',
      sourceIds: ['source-1'],
      promptVersion: '2026-10-23.1',
      calls: [{
        callId: 'A1', stage: 'A', operationId: 'legacy-native:A1', status: 'dispatched',
        attemptRef: 'native-chat:session-1:message-1',
      }],
      stageOutputs: { __plan: { batches: [['source-1#s1']] } },
      operationId: 'legacy-native-op',
      createdBy: 'admin-1',
      createdAt: '2026-10-23T08:00:00.000Z',
      updatedAt: '2026-10-23T08:00:00.000Z',
    });

    await expect(service.nextStep(admin, { jobId: 'legacy-native', workerId: 'tab-a' }))
      .resolves.toMatchObject({
        kind: 'ai_call',
        callId: 'A1',
        attemptRef: 'native-chat:session-1:message-1',
        provider: 'native_chat',
      });
    await expect(service.getJob(admin, 'legacy-native')).resolves.toMatchObject({
      calls: [expect.not.objectContaining({ provider: expect.anything() })],
    });
  });

  it('accepts agent narration before the JSON only for Native AI Chat calls', async () => {
    const { service } = await setup();
    const narrated = 'Đã đọc trọn vẹn dữ liệu. ' + inventoryOutput;
    for (const provider of ['sandbox', 'native_chat'] as const) {
      const job = await service.startJob(admin, {
        kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-narration-' + provider,
      });
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      await service.recordDispatch(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId: 'A1',
        attemptRef: provider === 'native_chat' ? 'native-chat:s:m-' + job.jobId : 'attempt-' + job.jobId,
        provider,
      });
      const result = await service.submitAiOutput(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId: 'A1', text: narrated,
      });

      expect(result.status).toBe(provider === 'native_chat' ? 'completed' : 'running');
    }
  });

  describe('provider attempt cleanup after cancel', () => {
    async function cancelledDispatchedJob() {
      const context = await setup();
      const job = await context.service.startJob(admin, {
        kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-cleanup',
      });
      await context.service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      await context.service.recordDispatch(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId: 'A1',
        attemptRef: 'native-chat:s:m', provider: 'native_chat',
      });
      const cancelled = await context.service.cancelJob(admin, job.jobId);
      return { ...context, job: cancelled };
    }

    it('marks only dispatched attempts pending when a job is cancelled', async () => {
      const { job } = await cancelledDispatchedJob();

      expect(job.status).toBe('cancelled');
      expect(job.calls).toEqual([
        expect.objectContaining({ callId: 'A1', status: 'dispatched', cleanupState: 'pending' }),
      ]);
    });

    it('moves the exact attempt from pending to confirmed or unknown', async () => {
      const { service, job } = await cancelledDispatchedJob();

      const unknown = await service.recordAttemptCleanup(admin, {
        jobId: job.jobId, callId: 'A1', attemptRef: 'native-chat:s:m',
        state: 'unknown', message: 'x'.repeat(900),
      });
      expect(unknown.calls[0]).toMatchObject({ cleanupState: 'unknown' });
      expect(unknown.calls[0].cleanupMessage).toHaveLength(500);

      const confirmed = await service.recordAttemptCleanup(admin, {
        jobId: job.jobId, callId: 'A1', attemptRef: 'native-chat:s:m', state: 'confirmed',
      });
      expect(confirmed.calls[0]).toMatchObject({ cleanupState: 'confirmed' });
      expect(confirmed.calls[0].cleanupMessage).toBeUndefined();
    });

    it('rejects a stale or different attempt reference', async () => {
      const { service, job } = await cancelledDispatchedJob();

      await expect(service.recordAttemptCleanup(admin, {
        jobId: job.jobId, callId: 'A1', attemptRef: 'native-chat:s:other', state: 'confirmed',
      })).rejects.toMatchObject({ code: 'JOB_CALL_MISMATCH' });
      await expect(service.recordAttemptCleanup(admin, {
        jobId: job.jobId, callId: 'A2', attemptRef: 'native-chat:s:m', state: 'confirmed',
      })).rejects.toMatchObject({ code: 'JOB_CALL_MISMATCH' });
    });

    it('does not let another room or a learner record cleanup', async () => {
      const { service, job } = await cancelledDispatchedJob();
      const input = {
        jobId: job.jobId, callId: 'A1', attemptRef: 'native-chat:s:m', state: 'confirmed' as const,
      };

      await expect(service.recordAttemptCleanup(otherAdmin, input))
        .rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
      await expect(service.recordAttemptCleanup(learner, input))
        .rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    });

    it('lets only the admin who created a job control it', async () => {
      const { service, job } = await cancelledDispatchedJob();
      const sameRoomAdmin: OnboardingActor = { userId: 'admin-3', roomId: 'room-a', access: 'admin' };
      const running = await service.startJob(admin, {
        kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-owner',
      });

      await expect(service.nextStep(sameRoomAdmin, { jobId: running.jobId, workerId: 'tab-x' }))
        .rejects.toMatchObject({ code: 'JOB_OWNER_REQUIRED' });
      await expect(service.cancelJob(sameRoomAdmin, running.jobId))
        .rejects.toMatchObject({ code: 'JOB_OWNER_REQUIRED' });
      await expect(service.retryJob(sameRoomAdmin, running.jobId))
        .rejects.toMatchObject({ code: 'JOB_OWNER_REQUIRED' });
      await expect(service.recordAttemptCleanup(sameRoomAdmin, {
        jobId: job.jobId, callId: 'A1', attemptRef: 'native-chat:s:m', state: 'confirmed',
      })).rejects.toMatchObject({ code: 'JOB_OWNER_REQUIRED' });
      await expect(service.getJob(sameRoomAdmin, running.jobId)).resolves.toMatchObject({ jobId: running.jobId });
    });

    it('records an attempt dispatched just before the job was cancelled as pending cleanup', async () => {
      const { service } = await setup();
      const job = await service.startJob(admin, {
        kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-late-dispatch',
      });
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      await service.cancelJob(admin, job.jobId);

      const recorded = await service.recordDispatch(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'native-chat:s:late', provider: 'native_chat',
      });

      expect(recorded.status).toBe('cancelled');
      expect(recorded.calls[0]).toMatchObject({
        attemptRef: 'native-chat:s:late', provider: 'native_chat', cleanupState: 'pending', status: 'dispatched',
      });
    });

    it('marks a timed-out attempt for cleanup because the provider may still be running', async () => {
      const { service } = await setup();
      const job = await service.startJob(admin, {
        kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-timeout-cleanup',
      });
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      await service.recordDispatch(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'native-chat:s:slow', provider: 'native_chat',
      });

      const failed = await service.reportAiFailure(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId: 'A1', kind: 'timeout',
      });

      expect(failed.calls[0]).toMatchObject({ status: 'failed', cleanupState: 'pending' });
    });

    it('treats a repeated identical report as idempotent and never downgrades confirmed', async () => {
      const { service, job } = await cancelledDispatchedJob();
      const input = {
        jobId: job.jobId, callId: 'A1', attemptRef: 'native-chat:s:m', state: 'confirmed' as const,
      };
      const first = await service.recordAttemptCleanup(admin, input);
      const second = await service.recordAttemptCleanup(admin, input);
      const late = await service.recordAttemptCleanup(admin, { ...input, state: 'unknown' });

      expect(second.updatedAt).toBe(first.updatedAt);
      expect(late.calls[0]).toMatchObject({ cleanupState: 'confirmed' });
    });
  });

  it('persists and validates output before completing an inventory job', async () => {
    const { service } = await setup();
    const job = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-complete',
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });

    const completed = await service.submitAiOutput(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'A1',
      text: inventoryOutput,
    });

    expect(completed).toMatchObject({
      status: 'completed',
      result: {
        features: [expect.objectContaining({ name: 'Duyệt đơn' })],
      },
    });
    await expect(service.nextStep(admin, {
      jobId: job.jobId, workerId: 'tab-a',
    })).resolves.toMatchObject({ kind: 'done' });
  });

  it('schedules at most two repair calls and then fails closed', async () => {
    const { service } = await setup();
    const job = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-repair',
    });

    for (const callId of ['A1', 'A1-r1', 'A1-r2']) {
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      const result = await service.submitAiOutput(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId, text: '{"bad":true}',
      });
      if (callId !== 'A1-r2') {
        expect(result).toMatchObject({
          status: 'running',
          calls: expect.arrayContaining([expect.objectContaining({
            callId: callId === 'A1' ? 'A1-r1' : 'A1-r2',
            status: 'pending',
          })]),
        });
      } else {
        expect(result).toMatchObject({ status: 'failed', errorCode: 'AI_OUTPUT_INVALID' });
      }
    }
  });

  it('releases the lease and clears the error on failure so a new tab can retry at once', async () => {
    const { service } = await setup();
    const job = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-release',
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-old' });
    const failed = await service.reportAiFailure(admin, {
      jobId: job.jobId, workerId: 'tab-old', callId: 'A1', kind: 'failed', message: 'AI_FAILED',
    });
    expect(failed).not.toHaveProperty('pumpLeaseUntil');

    const retried = await service.retryJob(admin, job.jobId);
    expect(retried).toMatchObject({ status: 'running' });
    expect(retried).not.toHaveProperty('errorCode');
    expect(retried).not.toHaveProperty('errorMessage');
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-new' }))
      .resolves.toMatchObject({ kind: 'ai_call', callId: 'A1-retry1' });
  });

  it('persists structured provider diagnostics on the failed call', async () => {
    const { service } = await setup();
    const job = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-diagnostics',
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    await service.recordDispatch(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'A1',
      attemptRef: 'attempt-diagnostics',
      provider: 'sandbox',
    });

    const failed = await service.reportAiFailure(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'A1',
      kind: 'failed',
      message: 'Provider credentials rejected',
      providerErrorCode: 'MODEL_PROVIDER_CREDENTIALS_REJECTED',
      providerPhase: 'model-call',
    });

    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'AI_FAILED',
      errorMessage: 'Provider credentials rejected',
      calls: [expect.objectContaining({
        callId: 'A1',
        status: 'failed',
        attemptRef: 'attempt-diagnostics',
        provider: 'sandbox',
        providerErrorCode: 'MODEL_PROVIDER_CREDENTIALS_REJECTED',
        providerPhase: 'model-call',
        errors: ['Provider credentials rejected'],
      })],
    });
  });

  it('redacts provider secrets again at the persistence boundary', async () => {
    const { service } = await setup();
    const job = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-redacted-diagnostics',
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });

    const failed = await service.reportAiFailure(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'A1',
      kind: 'failed',
      message: '{"token":"opaque-secret"}',
      diagnosticError: 'Authorization: Bearer bearer-secret',
    });

    expect(failed.errorMessage).toBe('{"token":"[REDACTED]"}');
    expect(failed.calls[0]).toMatchObject({
      errors: ['{"token":"[REDACTED]"}'],
      diagnosticError: 'Authorization: Bearer [REDACTED]',
    });
  });

  it('recovers a stale lease and resumes the recorded attempt without redispatch', async () => {
    const { advance, service } = await setup();
    const job = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-resume',
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-old' });
    await service.recordDispatch(admin, {
      jobId: job.jobId, workerId: 'tab-old', callId: 'A1', attemptRef: 'attempt-existing',
    });

    advance(91_000);

    await expect(service.nextStep(admin, {
      jobId: job.jobId, workerId: 'tab-new',
    })).resolves.toMatchObject({
      kind: 'ai_call',
      callId: 'A1',
      attemptRef: 'attempt-existing',
    });
  });

  it('does not mutate data for a mismatched call and supports cancel/retry after dispatch uncertainty', async () => {
    const { service } = await setup();
    const job = await service.startJob(admin, {
      kind: 'inventory', sourceIds: ['source-1'], operationId: 'start-control',
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    const before = await service.getJob(admin, job.jobId);
    await expect(service.submitAiOutput(admin, {
      jobId: job.jobId, workerId: 'tab-a', callId: 'wrong', text: inventoryOutput,
    })).rejects.toMatchObject({ code: 'JOB_CALL_MISMATCH' });
    expect(await service.getJob(admin, job.jobId)).toEqual(before);

    const failed = await service.reportAiFailure(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'A1',
      kind: 'dispatch_unknown',
    });
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'AI_DISPATCH_UNKNOWN' });
    const retried = await service.retryJob(admin, job.jobId);
    expect(retried).toMatchObject({
      status: 'running',
      calls: expect.arrayContaining([expect.objectContaining({ callId: 'A1-retry1', status: 'pending' })]),
    });
    const cancelled = await service.cancelJob(admin, retried.jobId);
    expect(cancelled.status).toBe('cancelled');
  });

  it('splits an oversized failed verification batch before retrying it', async () => {
    const store = new MemoryOnboardingStore();
    const claimCount = AI_GENERATION_LIMITS.maxClaimsPerVerificationCall * 3 + 1;
    const claims = Array.from({ length: claimCount }, (_, index) => ({
      id: 'question:q' + String(index + 1),
      kind: 'question',
      moduleLocalId: 'm1',
      questionLocalId: 'q' + String(index + 1),
      text: index === 0
        ? 'FIRST_BATCH_SENTINEL'
        : index === claimCount - 1 ? 'SECOND_BATCH_SENTINEL' : 'Claim ' + String(index + 1),
      quotes: [],
    }));
    await store.create('room-a', 'onboarding_ai_jobs', {
      jobId: 'verification-too-large',
      kind: 'template',
      status: 'failed',
      templateKind: 'normal',
      promptVersion: '2026-10-23.2',
      calls: [{
        callId: 'D1',
        stage: 'D',
        operationId: 'verification-too-large:D1',
        status: 'failed',
        errors: ['AI_FAILED'],
      }],
      stageOutputs: {
        __candidate: generatedTemplate,
        __verificationBatches: [claims],
      },
      errorCode: 'AI_FAILED',
      errorMessage: 'AI_FAILED',
      operationId: 'verification-too-large-op',
      createdBy: 'admin-1',
      createdAt: '2026-10-23T08:00:00.000Z',
      updatedAt: '2026-10-23T08:00:00.000Z',
    });
    const service = createAiJobService(store, {
      now: () => '2026-10-23T09:00:00.000Z',
    });

    const retried = await service.retryJob(admin, 'verification-too-large');

    expect(retried).toMatchObject({
      status: 'running',
      calls: [
        expect.objectContaining({ callId: 'D2', status: 'pending' }),
        expect.objectContaining({ callId: 'D3', status: 'pending' }),
        expect.objectContaining({ callId: 'D4', status: 'pending' }),
        expect.objectContaining({ callId: 'D5', status: 'pending' }),
      ],
    });
    expect((retried.stageOutputs.__verificationBatches as unknown[])).toHaveLength(4);

    const firstStep = await service.nextStep(admin, {
      jobId: retried.jobId,
      workerId: 'tab-a',
    });
    expect(firstStep).toMatchObject({
      kind: 'ai_call',
      callId: 'D2',
      systemContext: expect.stringContaining('FIRST_BATCH_SENTINEL'),
    });
    expect((firstStep as { systemContext: string }).systemContext)
      .not.toContain('SECOND_BATCH_SENTINEL');
    expect((firstStep as { systemContext: string }).systemContext)
      .toContain('&quot;claim&quot;');
    expect((firstStep as { systemContext: string }).systemContext)
      .not.toContain('moduleLocalId');
    expect((firstStep as { systemContext: string }).systemContext)
      .not.toContain('&quot;text&quot;');

    await service.reportAiFailure(admin, {
      jobId: retried.jobId,
      workerId: 'tab-a',
      callId: 'D2',
      kind: 'failed',
    });
    await service.retryJob(admin, retried.jobId);
    const retryStep = await service.nextStep(admin, {
      jobId: retried.jobId,
      workerId: 'tab-a',
    });
    expect(retryStep).toMatchObject({
      kind: 'ai_call',
      callId: 'D2-retry1',
      systemContext: expect.stringContaining('FIRST_BATCH_SENTINEL'),
    });
  });

  it('materializes a completed template job into an idempotent AI draft snapshot', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    await store.create('room-a', 'onboarding_ai_jobs', {
      jobId: 'inventory-ready',
      kind: 'inventory',
      status: 'completed',
      sourceIds: ['source-1'],
      promptVersion: '2026-10-23.1',
      calls: [],
      stageOutputs: {},
      result: { features: [{ id: 'feat-1', name: 'Orders' }], flags: [] },
      operationId: 'inventory-ready-op',
      createdBy: 'admin-1',
      createdAt: '2026-10-23T08:00:00.000Z',
      updatedAt: '2026-10-23T08:00:00.000Z',
    });
    const service = createAiJobService(store, {
      now: () => '2026-10-23T09:00:00.000Z',
    });
    const job = await seedLegacyTemplate(store, service, {
      kind: 'template',
      inventoryJobId: 'inventory-ready',
      templateKind: 'normal',
      operationId: 'template-ready-op',
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    await service.submitAiOutput(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'B-lessons',
      text: JSON.stringify(generatedTemplate),
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    const verifying = await service.submitAiOutput(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'B-questions',
      text: JSON.stringify(generatedTemplate),
    });
    expect(verifying).toMatchObject({
      status: 'running',
      calls: expect.arrayContaining([expect.objectContaining({ callId: 'D1', stage: 'D' })]),
    });
    const batches = verifying.stageOutputs.__verificationBatches as readonly (
      readonly { id: string }[]
    )[];
    let completed = verifying;
    for (let index = 0; index < batches.length; index += 1) {
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      completed = await service.submitAiOutput(admin, {
        jobId: job.jobId,
        workerId: 'tab-a',
        callId: 'D' + String(index + 1),
        text: JSON.stringify({
          verdicts: batches[index].map((claim) => ({
            id: claim.id,
            verdict: 'supported',
            reason: 'The quote supports this claim.',
          })),
        }),
      });
    }

    expect(completed).toMatchObject({
      status: 'completed',
      result: { templateId: expect.stringMatching(/^ai-template-/), version: 1 },
    });
    expect(await store.count('room-a', 'onboarding_templates')).toBe(1);
    expect(await store.count('room-a', 'onboarding_template_content')).toBe(1);
  });

  describe('module-scoped template repair', () => {
    const lessonsOf = (template: typeof generatedTemplate) => ({
      ...template,
      modules: template.modules.map(({ questions: _questions, ...module }) => module),
    });
    const questionsOf = (template: typeof generatedTemplate) => ({
      modules: template.modules.map((module) => ({ localId: module.localId, questions: module.questions })),
      flags: [],
    });

    async function templateJob(operationId: string) {
      const store = new MemoryOnboardingStore();
      await seedAiSource(store);
      await store.create('room-a', 'onboarding_ai_jobs', {
        jobId: 'inventory-' + operationId,
        kind: 'inventory',
        status: 'completed',
        sourceIds: ['source-1'],
        promptVersion: '2026-10-23.1',
        calls: [],
        stageOutputs: {},
        result: { features: [{ id: 'feat-1', name: 'Orders' }], flags: [] },
        operationId: 'inventory-op-' + operationId,
        createdBy: 'admin-1',
        createdAt: '2026-10-23T08:00:00.000Z',
        updatedAt: '2026-10-23T08:00:00.000Z',
      });
      const service = createAiJobService(store, { now: () => '2026-10-23T09:00:00.000Z' });
      const job = await seedLegacyTemplate(store, service, {
        kind: 'template',
        inventoryJobId: 'inventory-' + operationId,
        templateKind: 'normal',
        operationId,
      });
      const submit = async (callId: string, value: unknown) => {
        const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
        expect(step).toMatchObject({ kind: 'ai_call', callId });
        const result = await service.submitAiOutput(admin, {
          jobId: job.jobId, workerId: 'tab-a', callId, text: JSON.stringify(value),
        });
        return { step: step as { prompt: string; systemContext: string }, result };
      };
      return { service, store, job, submit };
    }

    it('validates lessons before questions and repairs only the invalid lesson module', async () => {
      const { service, job, submit } = await templateJob('module-lessons');
      const broken = lessonsOf(generatedTemplate);
      const brokenModules = broken.modules.map((module) => module.localId === 'm2'
        ? { ...module, blocks: [...module.blocks].reverse(), title: 'MODULE_TWO_BROKEN' }
        : { ...module, title: 'KEEP_' + module.localId });

      const first = await submit('B-lessons', { ...broken, modules: brokenModules });
      expect(first.result.calls.map((call) => call.callId)).toEqual(['B-lessons', 'B-lessons-r1']);

      const repairStep = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(repairStep).toMatchObject({ kind: 'ai_call', callId: 'B-lessons-r1' });
      const repair = repairStep as { prompt: string; systemContext: string };
      expect(repair.prompt).toContain('m2');
      expect(repair.systemContext).toContain('MODULE_TWO_BROKEN');
      expect(repair.systemContext).not.toContain('KEEP_m1');
      expect(repair.systemContext).not.toContain('KEEP_m3');

      const fixed = { ...brokenModules[1], blocks: lessonsOf(generatedTemplate).modules[1].blocks, title: 'Module 2 fixed' };
      const repaired = await service.submitAiOutput(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId: 'B-lessons-r1',
        text: JSON.stringify({ modules: [fixed] }),
      });

      expect(repaired.calls.map((call) => call.callId)).toEqual(['B-lessons', 'B-lessons-r1', 'B-questions']);
      const lessons = repaired.stageOutputs.__lessons as { modules: { localId: string; title: string }[] };
      expect(lessons.modules.map((module) => module.title))
        .toEqual(['KEEP_m1', 'Module 2 fixed', 'KEEP_m3', 'KEEP_m4']);
    });

    it('regenerates questions only for the module whose questions are invalid', async () => {
      const { service, job, submit } = await templateJob('module-questions');
      await submit('B-lessons', lessonsOf(generatedTemplate));
      const questions = questionsOf(generatedTemplate);
      questions.modules[2] = { ...questions.modules[2], questions: questions.modules[2].questions.slice(0, 1) };

      const first = await submit('B-questions', questions);
      expect(first.result.calls.at(-1)).toMatchObject({ callId: 'B-questions-r1', status: 'pending' });

      const repairStep = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      const repair = repairStep as { prompt: string; systemContext: string };
      expect(repair.prompt).toContain('m3');
      expect(repair.systemContext).toContain('m3-b1');
      expect(repair.systemContext).not.toContain('m1-b1');
      expect(repair.systemContext).not.toContain('m4-b1');

      const repaired = await service.submitAiOutput(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId: 'B-questions-r1',
        text: JSON.stringify({ modules: [questionsOf(generatedTemplate).modules[2]], flags: [] }),
      });
      expect(repaired.calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ callId: 'D1', status: 'pending' }),
      ]));
      const candidate = repaired.stageOutputs.__candidate as typeof generatedTemplate;
      expect(candidate.modules.map((module) => module.questions.length)).toEqual([3, 3, 3, 3]);
    });

    it('keeps a module repair prompt independent of the number of other modules', async () => {
      const { service, job, submit } = await templateJob('module-size');
      const lessons = lessonsOf(generatedTemplate);
      const padded = lessons.modules.map((module) => module.localId === 'm1'
        ? { ...module, objectives: ['Một'] }
        : { ...module, description: 'PAD '.repeat(110).trim() });
      await submit('B-lessons', { ...lessons, modules: padded });

      const repair = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' }) as {
        systemContext: string;
      };

      expect(repair.systemContext).not.toContain('PAD PAD');
    });

    it('repairs a module the model left out of the question output', async () => {
      const { service, job, submit } = await templateJob('module-missing');
      await submit('B-lessons', lessonsOf(generatedTemplate));
      const questions = questionsOf(generatedTemplate);
      await submit('B-questions', { ...questions, modules: questions.modules.filter((module) => module.localId !== 'm3') });

      const repaired = await submit('B-questions-r1', { modules: [questions.modules[2]], flags: [] });

      expect(repaired.result.calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ callId: 'D1', status: 'pending' }),
      ]));
      expect((repaired.result.stageOutputs.__candidate as typeof generatedTemplate).modules
        .map((module) => module.localId)).toEqual(['m1', 'm2', 'm3', 'm4']);
      expect(job.jobId).toBeTruthy();
      expect(service).toBeTruthy();
    });

    it('replaces rather than accumulates the repaired modules\' flags', async () => {
      const { submit } = await templateJob('module-flags');
      const lessons = lessonsOf(generatedTemplate);
      const flag = {
        type: 'ambiguous', severity: 'warning', message: 'Chưa rõ.', questionForAdmin: 'Ai dùng?',
        location: { moduleLocalId: 'm2' }, evidence: [],
      };
      const keep = { ...flag, message: 'Giữ cờ m1.', location: { moduleLocalId: 'm1' } };
      const broken = { ...lessons.modules[1], objectives: ['Một'] };
      await submit('B-lessons', {
        ...lessons, flags: [keep, flag], modules: lessons.modules.map((module, index) => index === 1 ? broken : module),
      });
      const r1 = await submit('B-lessons-r1', { modules: [broken], flags: [flag] });
      const r2 = await submit('B-lessons-r2', { modules: [lessons.modules[1]], flags: [flag] });

      expect(r1.step.systemContext).toContain('Chưa rõ.');
      expect((r2.result.stageOutputs.__lessons as { flags: unknown[] }).flags).toEqual([keep, flag]);
    });

    it('keeps a module-mode retry scoped and gives it a fresh repair budget', async () => {
      const { service, job, submit } = await templateJob('module-retry');
      const lessons = lessonsOf(generatedTemplate);
      const broken = { ...lessons.modules[0], objectives: ['Một'] };
      await submit('B-lessons', { ...lessons, modules: [broken, ...lessons.modules.slice(1)] });
      await submit('B-lessons-r1', { modules: [broken] });
      await submit('B-lessons-r2', { modules: [broken] });
      await service.retryJob(admin, job.jobId);

      const retry = await submit('B-lessons-retry1', { modules: [broken] });

      expect(retry.step.prompt).toContain('Chỉ sửa các module có localId: m1');
      expect(retry.result).toMatchObject({ status: 'running' });
      expect(retry.result.calls.at(-1)).toMatchObject({ callId: 'B-lessons-r3', status: 'pending' });
    });

    it('never sends the whole candidate for a question-stage retry', async () => {
      const { service, job, submit } = await templateJob('module-question-retry');
      await submit('B-lessons', lessonsOf(generatedTemplate));
      const questions = questionsOf(generatedTemplate);
      questions.modules[0] = { ...questions.modules[0], questions: [] };
      await submit('B-questions', questions);
      await submit('B-questions-r1', { modules: [questions.modules[0]], flags: [] });
      await submit('B-questions-r2', { modules: [questions.modules[0]], flags: [] });
      await service.retryJob(admin, job.jobId);

      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' }) as { prompt: string };

      expect(step.prompt).not.toContain('Sửa toàn bộ template');
      expect(step.prompt).toContain('m1');
    });

    it('fails with AI_OUTPUT_INVALID after two unsuccessful module repairs', async () => {
      const { service, job, submit } = await templateJob('module-fail');
      const lessons = lessonsOf(generatedTemplate);
      const broken = { ...lessons.modules[0], objectives: ['Một'] };
      await submit('B-lessons', { ...lessons, modules: [broken, ...lessons.modules.slice(1)] });
      await submit('B-lessons-r1', { modules: [broken] });
      const { result } = await submit('B-lessons-r2', { modules: [broken] });

      expect(result).toMatchObject({ status: 'failed', errorCode: 'AI_OUTPUT_INVALID' });
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' }))
        .resolves.toMatchObject({ kind: 'failed' });
    });
  });

  it('keeps the legacy whole-template repair for jobs created before module-scoped repair', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    await store.create('room-a', 'onboarding_ai_jobs', {
      jobId: 'inventory-question-repair',
      kind: 'inventory',
      status: 'completed',
      sourceIds: ['source-1'],
      promptVersion: '2026-10-23.1',
      calls: [],
      stageOutputs: {},
      result: { features: [{ id: 'feat-1', name: 'Orders' }], flags: [] },
      operationId: 'inventory-question-repair-op',
      createdBy: 'admin-1',
      createdAt: '2026-10-23T08:00:00.000Z',
      updatedAt: '2026-10-23T08:00:00.000Z',
    });
    const service = createAiJobService(store, {
      now: () => '2026-10-23T09:00:00.000Z',
    });
    const job = await seedLegacyTemplate(store, service, {
      kind: 'template',
      inventoryJobId: 'inventory-question-repair',
      templateKind: 'normal',
      operationId: 'template-question-repair-op',
    });
    const row = (await store.query<{ id: string; stageOutputs: Record<string, unknown> }>(
      'room-a', 'onboarding_ai_jobs', { filter: { jobId: job.jobId }, limit: 1 },
    )).records[0];
    const { __repairMode: _mode, ...legacyOutputs } = row.stageOutputs;
    await store.update('room-a', 'onboarding_ai_jobs', row.id, { stageOutputs: legacyOutputs });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    await service.submitAiOutput(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'B-lessons',
      text: JSON.stringify(generatedTemplate),
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    const invalidQuestionOutput = JSON.stringify({
      ...generatedTemplate,
      flags: [{
        type: 'conflict',
        severity: 'blocking',
        message: 'Conflicting labels.',
        questionForAdmin: 'Which label is current?',
        location: { frameKey: 't1-core', blockId: 'm1-b1' },
        evidence: [],
      }],
    });
    await service.submitAiOutput(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'B-questions',
      text: invalidQuestionOutput,
    });

    const repair = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    expect(repair).toMatchObject({
      kind: 'ai_call',
      callId: 'B-questions-r1',
      prompt: expect.stringContaining('Sửa toàn bộ template'),
    });
    expect((repair as { prompt: string }).prompt).toContain('blockLocalId');
    expect((repair as { prompt: string }).prompt).toContain('questions');
    expect(repair).toMatchObject({
      systemContext: expect.stringContaining('feature_inventory'),
    });

    await service.submitAiOutput(admin, {
      jobId: job.jobId, workerId: 'tab-a', callId: 'B-questions-r1',
      text: invalidQuestionOutput,
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    const failed = await service.submitAiOutput(admin, {
      jobId: job.jobId, workerId: 'tab-a', callId: 'B-questions-r2',
      text: invalidQuestionOutput,
    });
    expect(failed.status).toBe('failed');

    await service.retryJob(admin, job.jobId);
    const retry = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    expect(retry).toMatchObject({
      kind: 'ai_call',
      callId: 'B-questions-retry1',
      prompt: expect.stringContaining('Sửa toàn bộ template'),
    });
    const retried = await service.submitAiOutput(admin, {
      jobId: job.jobId,
      workerId: 'tab-a',
      callId: 'B-questions-retry1',
      text: JSON.stringify({
        modules: generatedTemplate.modules.map((module) => ({
          localId: module.localId,
          questions: module.questions,
        })),
        flags: [],
      }),
    });
    expect(retried.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'D1', status: 'pending' }),
    ]));
  });

  it('removes unsupported claims and records partial claims as review warnings', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    await store.create('room-a', 'onboarding_ai_jobs', {
      jobId: 'inventory-verify',
      kind: 'inventory',
      status: 'completed',
      sourceIds: ['source-1'],
      promptVersion: '2026-10-23.1',
      calls: [],
      stageOutputs: {},
      result: { features: [{ id: 'feat-1', name: 'Orders' }], flags: [] },
      operationId: 'inventory-verify-op',
      createdBy: 'admin-1',
      createdAt: '2026-10-23T08:00:00.000Z',
      updatedAt: '2026-10-23T08:00:00.000Z',
    });
    const service = createAiJobService(store, { now: () => '2026-10-23T09:00:00.000Z' });
    const job = await seedLegacyTemplate(store, service, {
      kind: 'template',
      inventoryJobId: 'inventory-verify',
      templateKind: 'normal',
      operationId: 'template-verify-op',
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    await service.submitAiOutput(admin, {
      jobId: job.jobId, workerId: 'tab-a', callId: 'B-lessons',
      text: JSON.stringify(generatedTemplate),
    });
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    const verifying = await service.submitAiOutput(admin, {
      jobId: job.jobId, workerId: 'tab-a', callId: 'B-questions',
      text: JSON.stringify(generatedTemplate),
    });
    const batches = verifying.stageOutputs.__verificationBatches as readonly (
      readonly { id: string; kind: string }[]
    )[];
    const allClaims = batches.flat();
    const unsupported = allClaims.find((claim) => claim.kind === 'question')!;
    const partial = allClaims.find((claim) => claim.kind === 'block')!;
    let completed = verifying;
    for (let index = 0; index < batches.length; index += 1) {
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      completed = await service.submitAiOutput(admin, {
        jobId: job.jobId, workerId: 'tab-a', callId: 'D' + String(index + 1),
        text: JSON.stringify({
          verdicts: batches[index].map((claim) => ({
            id: claim.id,
            verdict: claim.id === unsupported.id
              ? 'unsupported'
              : claim.id === partial.id ? 'partial' : 'supported',
            reason: 'Verification fixture.',
          })),
        }),
      });
    }
    const output = completed.result as { templateId: string; version: number };
    const templates = createTemplateService(store);
    const detail = await templates.getAdminDetail(admin, output.templateId, output.version);

    expect(detail.modules.flatMap((module) => module.questions)).toHaveLength(11);
    expect(detail.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ambiguous', severity: 'warning', status: 'open' }),
      expect.objectContaining({ type: 'generation_error', severity: 'blocking', status: 'open' }),
    ]));
    expect(detail.generationNotes?.join(' ')).toContain(unsupported.id);
  });

  describe('outline planner call (P)', () => {
    async function templateStart(operationId: string, templateKind: 'normal' | 'advanced' = 'normal') {
      const context = await setup();
      const inventory = await context.service.startJob(admin, { kind: 'inventory', sourceIds: ['source-1'], operationId: 'inventory-' + operationId });
      await context.service.nextStep(admin, { jobId: inventory.jobId, workerId: 'tab-a' });
      const done = await context.service.submitAiOutput(admin, { jobId: inventory.jobId, workerId: 'tab-a', callId: 'A1', text: inventoryOutput });
      const featureId = (done.result as { features: { featureId: string }[] }).features[0].featureId;
      const job = await context.service.startJob(admin, {
        kind: 'template', inventoryJobId: inventory.jobId, templateKind, operationId,
        ...(templateKind === 'advanced' ? { roleProfile: { responsibilities: ['Tạo đơn hàng', 'Duyệt đơn hàng'] } } : {}),
      });
      return { ...context, job, featureId };
    }
    const plan = (featureId: string) => ({ modules: [
      { title: 'Tổng quan quy trình bán hàng', description: 'Bức tranh chung.', estimatedMinutes: 10, objectives: ['Nắm quy trình'], featureIds: [featureId], sourceSectionIds: ['source-1#s1'], responsibilityIndexes: [], coverage: 'sufficient', gapNote: '' },
      { title: 'Gửi duyệt đơn hàng', description: 'Thao tác gửi duyệt.', estimatedMinutes: 15, objectives: ['Gửi duyệt đúng cách'], featureIds: [featureId], sourceSectionIds: ['source-1#s1'], responsibilityIndexes: [], coverage: 'sufficient', gapNote: '' },
      { title: 'Theo dõi đơn đã gửi', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: ['bogus#1'], responsibilityIndexes: [], coverage: 'sufficient', gapNote: '' },
      { title: 'Hỗ trợ khi gặp lỗi', description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [], coverage: 'insufficient', gapNote: 'Tài liệu chưa nói về lỗi.' },
    ] });

    it('enqueues plan-1 at start and dispatches it before anything else', async () => {
      const { service, job } = await templateStart('plan-dispatch');
      expect(job.outline!.revision).toBe(1);
      expect(job.planPending).toBe(true);
      expect(job.calls).toEqual([{ callId: 'plan-1', stage: 'P', planTarget: 'plan', status: 'pending', operationId: job.jobId + ':plan-1' }]);
      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(step).toMatchObject({ kind: 'ai_call', callId: 'plan-1', operationId: job.jobId + ':plan-1' });
      if (step.kind !== 'ai_call') throw new Error('Expected the planner call.');
      expect(step.systemContext).toContain('source-1#s1');
      expect(step.systemContext).not.toContain('Bấm nút Gửi duyệt để chuyển đơn.');
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'wait' });
      const recorded = await service.recordDispatch(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'plan-1', attemptRef: 'attempt-plan', provider: 'sandbox' });
      expect(recorded.calls[0]).toMatchObject({ status: 'dispatched', promptChars: step.prompt.length });
      expect(recorded.planPending).toBe(true);
    });

    it('rejects outline approval and edits while the planner is pending', async () => {
      const { service, job } = await templateStart('plan-approve-block');
      const conflict = { code: 'OPERATION_CONFLICT', message: 'AI đang lập lộ trình, vui lòng chờ.' };
      await expect(service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 })).rejects.toMatchObject(conflict);
      await expect(service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [] })).rejects.toMatchObject(conflict);
    });

    it('replaces the outline with a valid plan and then awaits the admin', async () => {
      const { service, job, featureId } = await templateStart('plan-valid');
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      const submitted = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'plan-1', text: JSON.stringify(plan(featureId)) });
      expect(submitted.planPending).toBe(false);
      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(step.kind).toBe('awaiting_admin');
      if (step.kind !== 'awaiting_admin') throw new Error('Expected admin review.');
      const outline = step.job.outline!;
      expect(outline.revision).toBe(2);
      expect(step.job.planPending).toBe(false);
      expect(step.job.stageOutputs.__planFallback).toBeUndefined();
      expect(outline.modules.map((m) => m.title)).toEqual(['Tổng quan quy trình bán hàng', 'Gửi duyệt đơn hàng', 'Theo dõi đơn đã gửi', 'Hỗ trợ khi gặp lỗi']);
      expect(outline.modules.map((m) => m.frameKey)).toEqual(['t1-overview', 't1-access', 't1-navigation', 't1-core']);
      expect(outline.modules[2]).toMatchObject({ sourceSectionIds: [], coverage: 'insufficient' });
      expect(step.job.moduleRuns!.map((run) => run.outline.moduleLocalId)).toEqual(outline.modules.map((m) => m.moduleLocalId));
      expect(step.job.moduleRuns!.every((run) => run.outlineRevision === 2 && run.lessonState === 'queued')).toBe(true);
      const approved = await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
      expect(approved.outlineApprovedRevision).toBe(2);
      const lesson = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(lesson).toMatchObject({ kind: 'ai_call', moduleTarget: 'lesson' });
    });

    it('keeps an advanced plan valid with task coverage built from responsibility indexes', async () => {
      const { service, job, featureId } = await templateStart('plan-advanced', 'advanced');
      const modules = [...plan(featureId).modules, { ...plan(featureId).modules[0], title: 'Phối hợp nhóm' }].map((m, i) => ({ ...m, responsibilityIndexes: i === 2 ? [0] : i === 3 ? [1] : [] }));
      const current = await completePlan(service, admin, job, { modules });
      expect(current.outline!.revision).toBe(2);
      expect(current.outline!.taskCoverage.map((c) => c.task)).toEqual(['Tạo đơn hàng', 'Duyệt đơn hàng']);
      await expect(service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 })).resolves.toMatchObject({ outlineApprovedRevision: 2 });
    });

    it('falls back to the deterministic outline after one schema repair', async () => {
      const { service, job } = await templateStart('plan-invalid');
      const deterministic = job.outline;
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      const first = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'plan-1', text: 'not json' });
      expect(first.planPending).toBe(true);
      expect(first.calls.at(-1)).toMatchObject({ callId: 'plan-1-r1', stage: 'P', planTarget: 'plan', repairOf: 'plan-1', retryKind: 'schema', status: 'pending' });
      const repair = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(repair).toMatchObject({ kind: 'ai_call', callId: 'plan-1-r1' });
      await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'plan-1-r1', text: 'not json' });
      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(step.kind).toBe('awaiting_admin');
      if (step.kind !== 'awaiting_admin') throw new Error('Expected admin review.');
      expect(step.job.outline).toEqual(deterministic);
      expect(step.job.outline!.revision).toBe(1);
      expect(step.job.stageOutputs.__planFallback).toBe(true);
      expect(step.job.planPending).toBe(false);
      expect(step.job.calls.filter((call) => call.stage === 'P').map((call) => [call.callId, call.status])).toEqual([['plan-1', 'invalid'], ['plan-1-r1', 'invalid']]);
      await expect(service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 })).resolves.toMatchObject({ outlineApprovedRevision: 1 });
    });

    it('retries a transient planner failure once and then falls back', async () => {
      const { service, job, advance } = await templateStart('plan-transient');
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      const failed = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'plan-1', kind: 'failed', message: 'busy', providerErrorCode: 'PROVIDER_TRANSIENT' });
      expect(failed.calls.at(-1)).toMatchObject({ callId: 'plan-1-retry1', stage: 'P', planTarget: 'plan', retryKind: 'transient', status: 'pending' });
      expect(failed.calls.at(-1)!.repairOf).toBeUndefined();
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'wait' });
      advance(3_000);
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'ai_call', callId: 'plan-1-retry1' });
      await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'plan-1-retry1', kind: 'failed', message: 'busy', providerErrorCode: 'PROVIDER_TRANSIENT' });
      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(step).toMatchObject({ kind: 'awaiting_admin', job: { planPending: false, stageOutputs: expect.objectContaining({ __planFallback: true }), outline: { revision: 1 } } });
    });

    it('falls back when the provider project stays busy past the wait limit', async () => {
      const { service, job, advance } = await templateStart('plan-busy');
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      const busy = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'plan-1', kind: 'failed', message: 'busy', providerErrorCode: 'PROJECT_BUSY' });
      expect(busy.calls.at(-1)).toMatchObject({ stage: 'P', retryKind: 'project_busy', status: 'pending' });
      expect(busy.providerWaitStartedAt).toBeDefined();
      advance(121_000);
      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(step).toMatchObject({ kind: 'awaiting_admin', job: { planPending: false, status: 'running', stageOutputs: expect.objectContaining({ __planFallback: true }) } });
    });

    it('blocks outline approval and edits until a completed plan is processed, then applies it', async () => {
      const { service, store, job, featureId } = await templateStart('plan-unprocessed');
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      const update = store.update.bind(store);
      let failRelease = true;
      const spy = vi.spyOn(store, 'update').mockImplementation(async (room, collection, id, data, options) => {
        if (failRelease && collection === 'onboarding_ai_room_leases' && data.expiresAt === '1970-01-01T00:00:00.000Z') {
          failRelease = false;
          throw new Error('Lease release transport failed');
        }
        return update(room, collection, id, data, options);
      });
      await expect(service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'plan-1', text: JSON.stringify(plan(featureId)) })).rejects.toThrow('Lease release transport failed');
      spy.mockRestore();
      const stored = await service.getJob(admin, job.jobId);
      expect(stored.calls[0].status).toBe('completed');
      expect(stored.planPending).toBe(false);
      expect(stored.outline!.revision).toBe(1);
      const conflict = { code: 'OPERATION_CONFLICT', message: 'AI đang lập lộ trình, vui lòng chờ.' };
      await expect(service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 })).rejects.toMatchObject(conflict);
      await expect(service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [] })).rejects.toMatchObject(conflict);
      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(step).toMatchObject({ kind: 'awaiting_admin', job: { outline: { revision: 2 }, planPending: false } });
      await expect(service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 })).resolves.toMatchObject({ outlineApprovedRevision: 2 });
    });

    it('falls back when the plan prompt is too large but rethrows store failures', async () => {
      const { service, store, job } = await templateStart('plan-too-large');
      const source = (await store.query<{ id: string }>(admin.roomId, 'onboarding_sources', { filter: { sourceId: 'source-1' } })).records[0];
      const sections = Array.from({ length: 1_500 }, (_, i) => ({ id: 'source-1#s' + String(i + 1), headingPath: ['Mục ' + String(i) + ' ' + 'x'.repeat(120)], text: 'Bấm nút Gửi duyệt để chuyển đơn số ' + String(i) + '.' }));
      await store.update(admin.roomId, 'onboarding_sources', source.id, { sections });
      const query = store.query.bind(store);
      let reads = 0;
      const spy = vi.spyOn(store, 'query').mockImplementation(async (room, collection, options) => {
        // syncModuleSources reads each module's source first; fail the planner's own read.
        if (collection === 'onboarding_sources' && ++reads > job.outline!.modules.length) throw new Error('Store unavailable');
        return query(room, collection, options);
      });
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).rejects.toThrow('Store unavailable');
      spy.mockRestore();
      const pending = await service.getJob(admin, job.jobId);
      expect(pending.planPending).toBe(true);
      expect(pending.stageOutputs.__planFallback).toBeUndefined();
      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(step).toMatchObject({ kind: 'awaiting_admin', job: { planPending: false, outline: { revision: 1 }, stageOutputs: expect.objectContaining({ __planFallback: true }) } });
      expect(step.kind === 'awaiting_admin' && step.job.calls[0]).toMatchObject({ status: 'failed' });
    });

    it('does not report planning for a cancelled job', async () => {
      const { service, job } = await templateStart('plan-cancelled');
      expect(job.planPending).toBe(true);
      const cancelled = await service.cancelJob(admin, job.jobId);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.calls[0].status).toBe('pending');
      expect(cancelled.planPending).toBe(false);
    });

    it('leaves a persisted module_v2 job without a planner call unchanged', async () => {
      const { service, store, job } = await templateStart('plan-legacy');
      const legacyId = 'legacy-v2';
      const { id: _id, roomId: _room, planPending: _pending, ...persisted } = job;
      await store.create(admin.roomId, 'onboarding_ai_jobs', { ...persisted, jobId: legacyId, operationId: 'legacy-v2-op', calls: [] });
      const legacy = await service.getJob(admin, legacyId);
      expect(legacy.planPending).toBe(false);
      await expect(service.nextStep(admin, { jobId: legacyId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
      await expect(service.approveOutline(admin, { jobId: legacyId, expectedRevision: 1 })).resolves.toMatchObject({ outlineApprovedRevision: 1 });
      await expect(service.nextStep(admin, { jobId: legacyId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'ai_call', moduleTarget: 'lesson' });
    });
  });

  describe('supplement from a new file (S), coverage override, add module', () => {
    const FAILED_NOTE = 'AI chưa đọc được tài liệu bổ sung. Hãy thử lại hoặc chọn đoạn thủ công.';
    async function coverageJob(operationId: string) {
      const context = await setup();
      const inventory = await context.service.startJob(admin, { kind: 'inventory', sourceIds: ['source-1'], operationId: 'inventory-' + operationId });
      await context.service.nextStep(admin, { jobId: inventory.jobId, workerId: 'tab-a' });
      await context.service.submitAiOutput(admin, { jobId: inventory.jobId, workerId: 'tab-a', callId: 'A1', text: inventoryOutput });
      const started = await context.service.startJob(admin, { kind: 'template', inventoryJobId: inventory.jobId, templateKind: 'normal', operationId });
      const job = await completePlan(context.service, admin, started);
      const covered = job.outline!.modules.find((m) => m.sourceSectionIds.length > 0)!;
      const target = job.outline!.modules.find((m) => m.coverage === 'insufficient')!;
      return { ...context, job, covered, target };
    }
    async function addSource(store: MemoryOnboardingStore, sourceId: string, sections: readonly { id: string; headingPath: string[]; text: string }[]) {
      await store.create(admin.roomId, 'onboarding_sources', {
        sourceId, kind: 'document', fileName: sourceId + '.md', checksum: 'checksum-' + sourceId, systemName: 'PrivOS', status: 'ready',
        sections, textLength: sections.reduce((sum, s) => sum + s.text.length, 0), createdBy: admin.userId,
        createdAt: '2026-10-23T08:00:00.000Z', updatedAt: '2026-10-23T08:00:00.000Z',
      });
    }
    const supportSections = [
      { id: 'source-2#s1', headingPath: ['Xử lý lỗi'], text: 'Liên hệ bộ phận hỗ trợ khi đơn bị lỗi.' },
      { id: 'source-2#s2', headingPath: ['Gửi lại đơn'], text: 'Bấm Gửi lại để gửi duyệt đơn lần nữa.' },
    ];
    const usableIds = (ids: readonly string[]) => new Set(ids);

    it('reads only the new file and attaches its sections to the target and another module', async () => {
      const { service, store, job, covered, target } = await coverageJob('supplement-flow');
      await addSource(store, 'source-2', supportSections);
      const queued = await service.supplementModuleDocument(admin, { jobId: job.jobId, expectedRevision: 1, moduleLocalId: target.moduleLocalId, sourceId: 'source-2' });
      expect(queued.planPending).toBe(true);
      expect(queued.sourceIds).toEqual(['source-1', 'source-2']);
      expect(queued.outline!.revision).toBe(1);
      expect(queued.calls.at(-1)).toMatchObject({ callId: 'supplement-1-b1', stage: 'S', planTarget: 'supplement', status: 'pending', supplementSourceId: 'source-2', supplementModuleLocalId: target.moduleLocalId, supplementBatch: 1 });
      await expect(service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [] })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });

      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      if (step.kind !== 'ai_call') throw new Error('Expected the supplement call.');
      expect(step.callId.startsWith('supplement-')).toBe(true);
      expect(step.systemContext).toContain('Liên hệ bộ phận hỗ trợ khi đơn bị lỗi.');
      expect(step.systemContext).not.toContain('source-1#s1');
      expect(step.systemContext).not.toContain('Bấm nút Gửi duyệt để chuyển đơn.');

      const submitted = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, text: JSON.stringify({
        attachments: [
          { moduleLocalId: target.moduleLocalId, sectionIds: ['source-2#s1', 'source-1#s1'], reason: 'Nói về xử lý lỗi.' },
          { moduleLocalId: covered.moduleLocalId, sectionIds: ['source-2#s2'], reason: 'Bổ sung thao tác gửi lại.' },
        ],
        coverageUpdates: [{ moduleLocalId: target.moduleLocalId, coverage: 'sufficient', gapNote: '' }],
      }) });
      expect(submitted.planPending).toBe(false);
      expect(submitted.outline!.revision).toBe(2);
      const usable = usableIds(['source-1#s1', 'source-2#s1', 'source-2#s2']);
      const nextTarget = submitted.outline!.modules.find((m) => m.moduleLocalId === target.moduleLocalId)!;
      expect(nextTarget.sourceSectionIds).toEqual(['source-2#s1']);
      expect(isModuleCovered(nextTarget, usable)).toBe(true);
      expect(submitted.outline!.flags.some((f) => f.location.moduleLocalId === target.moduleLocalId && f.type === 'missing')).toBe(false);
      const nextCovered = submitted.outline!.modules.find((m) => m.moduleLocalId === covered.moduleLocalId)!;
      expect(nextCovered.sourceSectionIds).toEqual(['source-1#s1', 'source-2#s2']);
      expect(submitted.moduleRuns!.every((run) => run.outlineRevision === 2)).toBe(true);
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'awaiting_admin', job: { outline: { revision: 2 } } });
    });

    it('runs one S call per batch in order and applies their merged result once', async () => {
      const { service, store, job, target } = await coverageJob('supplement-batches');
      const sections = Array.from({ length: 34 }, (_, i) => ({ id: 'source-3#s' + String(i + 1), headingPath: ['Mục ' + String(i + 1)], text: 'Nội dung mục ' + String(i + 1) + ' ' + 'a'.repeat(3_980) }));
      await addSource(store, 'source-3', sections);
      const queued = await service.supplementModuleDocument(admin, { jobId: job.jobId, expectedRevision: 1, moduleLocalId: target.moduleLocalId, sourceId: 'source-3' });
      expect(queued.calls.filter((call) => call.stage === 'S').map((call) => [call.callId, call.supplementBatch])).toEqual([['supplement-1-b1', 1], ['supplement-1-b2', 2]]);

      const first = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(first).toMatchObject({ kind: 'ai_call', callId: 'supplement-1-b1' });
      if (first.kind !== 'ai_call') throw new Error('Expected batch 1.');
      expect(first.systemContext).toContain('source-3#s1"');
      expect(first.systemContext).not.toContain('source-3#s34"');
      const afterFirst = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'supplement-1-b1', text: JSON.stringify({
        attachments: [{ moduleLocalId: target.moduleLocalId, sectionIds: ['source-3#s1'], reason: 'Liên quan.' }],
        coverageUpdates: [{ moduleLocalId: target.moduleLocalId, coverage: 'insufficient', gapNote: 'Còn thiếu phần cuối.' }],
      }) });
      expect(afterFirst.planPending).toBe(true);
      expect(afterFirst.outline!.revision).toBe(1);

      const second = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      expect(second).toMatchObject({ kind: 'ai_call', callId: 'supplement-1-b2' });
      if (second.kind !== 'ai_call') throw new Error('Expected batch 2.');
      expect(second.systemContext).toContain('source-3#s34"');
      expect(second.systemContext).not.toContain('source-3#s1"');
      const done = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'supplement-1-b2', text: JSON.stringify({
        attachments: [{ moduleLocalId: target.moduleLocalId, sectionIds: ['source-3#s34'], reason: 'Phần cuối.' }],
        coverageUpdates: [{ moduleLocalId: target.moduleLocalId, coverage: 'sufficient', gapNote: '' }],
      }) });
      expect(done.planPending).toBe(false);
      expect(done.outline!.revision).toBe(2);
      const module = done.outline!.modules.find((m) => m.moduleLocalId === target.moduleLocalId)!;
      expect(module.sourceSectionIds).toEqual(['source-3#s1', 'source-3#s34']);
      expect(module.coverage).toBe('sufficient');
    });

    it('skips a supplement batch after one schema repair and one failure, keeping the job running', async () => {
      const { service, store, job, target } = await coverageJob('supplement-skip');
      await addSource(store, 'source-2', supportSections);
      await service.supplementModuleDocument(admin, { jobId: job.jobId, expectedRevision: 1, moduleLocalId: target.moduleLocalId, sourceId: 'source-2' });
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      const invalid = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'supplement-1-b1', text: 'not json' });
      expect(invalid.calls.at(-1)).toMatchObject({ callId: 'supplement-1-b1-r1', stage: 'S', repairOf: 'supplement-1-b1', retryKind: 'schema', supplementSourceId: 'source-2', supplementModuleLocalId: target.moduleLocalId, supplementBatch: 1 });
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'ai_call', callId: 'supplement-1-b1-r1' });
      const failed = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'supplement-1-b1-r1', kind: 'failed', message: 'boom' });
      expect(failed.status).toBe('running');
      expect(failed.planPending).toBe(false);
      expect(failed.errorCode).toBeUndefined();
      expect(failed.calls.filter((call) => call.stage === 'S').map((call) => [call.callId, call.status])).toEqual([['supplement-1-b1', 'invalid'], ['supplement-1-b1-r1', 'failed']]);
      const module = failed.outline!.modules.find((m) => m.moduleLocalId === target.moduleLocalId)!;
      expect(module).toMatchObject({ coverage: 'insufficient', gapNote: FAILED_NOTE, sourceSectionIds: [] });
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'awaiting_admin', job: { status: 'running' } });
    });

    it('retries a transient supplement failure once before skipping', async () => {
      const { service, store, job, target, advance } = await coverageJob('supplement-transient');
      await addSource(store, 'source-2', supportSections);
      await service.supplementModuleDocument(admin, { jobId: job.jobId, expectedRevision: 1, moduleLocalId: target.moduleLocalId, sourceId: 'source-2' });
      await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      const first = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'supplement-1-b1', kind: 'failed', message: 'busy', providerErrorCode: 'PROVIDER_TRANSIENT' });
      expect(first.calls.at(-1)).toMatchObject({ callId: 'supplement-1-b1-retry1', stage: 'S', retryKind: 'transient', supplementSourceId: 'source-2' });
      advance(3_000);
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'ai_call', callId: 'supplement-1-b1-retry1' });
      const second = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'supplement-1-b1-retry1', kind: 'failed', message: 'busy', providerErrorCode: 'PROVIDER_TRANSIENT' });
      expect(second.planPending).toBe(false);
      expect(second.outline!.modules.find((m) => m.moduleLocalId === target.moduleLocalId)!.gapNote).toBe(FAILED_NOTE);
    });

    it('rejects a source the job already has, an unready source and a stale revision', async () => {
      const { service, store, job, target } = await coverageJob('supplement-reject');
      await expect(service.supplementModuleDocument(admin, { jobId: job.jobId, expectedRevision: 1, moduleLocalId: target.moduleLocalId, sourceId: 'source-1' }))
        .rejects.toMatchObject({ code: 'OPERATION_CONFLICT', message: 'Tài liệu này đã có trong lộ trình. Hãy dùng "Chọn đoạn từ tài liệu đã có".' });
      await expect(service.supplementModuleDocument(admin, { jobId: job.jobId, expectedRevision: 1, moduleLocalId: target.moduleLocalId, sourceId: 'missing' }))
        .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
      await addSource(store, 'source-2', supportSections);
      await expect(service.supplementModuleDocument(admin, { jobId: job.jobId, expectedRevision: 2, moduleLocalId: target.moduleLocalId, sourceId: 'source-2' }))
        .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
      await expect(service.supplementModuleDocument({ ...admin, roomId: 'room-b' }, { jobId: job.jobId, expectedRevision: 1, moduleLocalId: target.moduleLocalId, sourceId: 'source-2' }))
        .rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    });

    it('rejects a coverage override on a module without usable sections', async () => {
      const { service, job, covered, target } = await coverageJob('coverage-override');
      await expect(service.setCoverageOverride(admin, { jobId: job.jobId, expectedRevision: 1, moduleLocalId: target.moduleLocalId, override: true }))
        .rejects.toMatchObject({ code: 'COVERAGE_INCOMPLETE', message: 'Module chưa có đoạn tài liệu dùng được.' });
      const edited = await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'update', moduleLocalId: covered.moduleLocalId, patch: { coverage: 'insufficient', gapNote: 'Chưa đủ.' } }] });
      const overridden = await service.setCoverageOverride(admin, { jobId: job.jobId, expectedRevision: edited.outline!.revision, moduleLocalId: covered.moduleLocalId, override: true });
      expect(overridden.outline!.revision).toBe(edited.outline!.revision + 1);
      const module = overridden.outline!.modules.find((m) => m.moduleLocalId === covered.moduleLocalId)!;
      expect(module.coverageOverride).toBe(true);
      expect(isModuleCovered(module, usableIds(['source-1#s1']))).toBe(true);
    });

    it('marks a module sufficient after the admin picks sections for it', async () => {
      const { service, job, target } = await coverageJob('picker-sufficient');
      const updated = await service.supplementModuleSources(admin, { jobId: job.jobId, expectedRevision: 1, moduleLocalId: target.moduleLocalId, sourceIds: ['source-1'], sectionIds: ['source-1#s1'] });
      const module = updated.outline!.modules.find((m) => m.moduleLocalId === target.moduleLocalId)!;
      expect(module).toMatchObject({ sourceSectionIds: ['source-1#s1'], coverage: 'sufficient' });
      expect(isModuleCovered(module, usableIds(['source-1#s1']))).toBe(true);
    });

    it('adds a module on the next unused frame and lets AI pick sections from the catalog', async () => {
      const { service, job } = await coverageJob('add-module');
      const added = await service.addOutlineModule(admin, { jobId: job.jobId, expectedRevision: 1, title: 'Mẹo sử dụng', description: 'Các mẹo nhanh.' });
      expect(added.outline!.revision).toBe(2);
      const active = added.outline!.modules.filter((m) => !m.tombstoned);
      const module = active.at(-1)!;
      expect(active).toHaveLength(job.outline!.modules.length + 1);
      expect(module).toMatchObject({ title: 'Mẹo sử dụng', description: 'Các mẹo nhanh.', coverage: 'insufficient', sourceSectionIds: [], order: active.length - 1 });
      expect(job.outline!.modules.some((m) => m.frameKey === module.frameKey)).toBe(false);
      expect(added.planPending).toBe(true);
      expect(added.calls.at(-1)).toMatchObject({ callId: 'supplement-1-b1', stage: 'S', planTarget: 'supplement', supplementModuleLocalId: module.moduleLocalId, status: 'pending' });
      expect(added.calls.at(-1)!.supplementSourceId).toBeUndefined();

      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      if (step.kind !== 'ai_call') throw new Error('Expected the catalog call.');
      expect(step.callId).toBe('supplement-1-b1');
      expect(step.systemContext).toContain('source-1#s1');
      const done = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, text: JSON.stringify({
        attachments: [{ moduleLocalId: module.moduleLocalId, sectionIds: ['source-1#s1'], reason: 'Có mẹo gửi duyệt.' }],
        coverageUpdates: [{ moduleLocalId: module.moduleLocalId, coverage: 'sufficient', gapNote: '' }],
      }) });
      expect(done.outline!.revision).toBe(3);
      expect(isModuleCovered(done.outline!.modules.find((m) => m.moduleLocalId === module.moduleLocalId)!, usableIds(['source-1#s1']))).toBe(true);
    });
  });

  it('uses typed job errors', () => {
    expect(new AiJobServiceError('JOB_NOT_FOUND', 'missing')).toMatchObject({
      name: 'AiJobServiceError',
      code: 'JOB_NOT_FOUND',
    });
  });
});
