import { describe, expect, it } from 'vitest';
import { createAiJobService } from '../src/onboarding/ai/jobs';
import type { AiJobRecord, AiModuleDraftRun, TemplateOutline } from '../src/onboarding/contracts';
import { createModuleRuns, reconcileModuleRuns, approveLesson, approveQuestions, updateLesson, updateQuestions, modulesComplete } from '../src/onboarding/ai/module-lifecycle';
import { validApprovedLesson } from '../src/onboarding/ai/module-draft';
import { buildFallbackLesson } from '../src/onboarding/ai/fallback-lessons';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { aiSource, generatedTemplate, seedAiSource } from './helpers/ai-template-fixture';

const admin = { userId: 'admin-1', roomId: 'room-a', access: 'admin' as const };
const outline: TemplateOutline = { revision: 1, flags: [], taskCoverage: [], modules: generatedTemplate.modules.map((m, order) => ({ moduleLocalId: m.localId, frameKey: m.frameKey, order, title: m.title, description: m.description, estimatedMinutes: m.estimatedMinutes, objectives: m.objectives, featureIds: m.featureIds, sourceSectionIds: ['source-1#s1'], responsibilityIndexes: [] })) };
const lesson = generatedTemplate.modules[0];
function approvedRun(): AiModuleDraftRun {
  let run = updateLesson(createModuleRuns(outline)[0], 0, lesson, 'ai');
  run = approveLesson(run, 1);
  run = updateQuestions(run, 0, lesson.questions);
  return approveQuestions(run, 1);
}
async function setup(kind: 'normal' | 'advanced' = 'normal') {
  const store = new MemoryOnboardingStore();
  await seedAiSource(store);
  await store.create('room-a', 'onboarding_ai_jobs', {
    jobId: 'inventory', kind: 'inventory', status: 'completed', sourceIds: ['source-1'], promptVersion: 'old', calls: [], stageOutputs: {},
    result: { systemSummary: { purpose: 'Orders', modules: [], sourceRefs: [{ sectionId: 'source-1#s1', quote: aiSource.sections![0].text }] }, glossary: [], features: [], flags: [] },
    operationId: 'inventory', createdBy: 'admin-1', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
  });
  const service = createAiJobService(store, { now: () => '2026-10-28T01:00:00.000Z' });
  const job = await service.startJob(admin, { kind: 'template', inventoryJobId: 'inventory', templateKind: kind, operationId: 'template', ...(kind === 'advanced' ? { roleProfile: { department: 'Sales', role: 'Agent', responsibilities: ['Create orders', 'Review orders'] } } : {}) });
  return { store, service, job };
}
function active(job: AiJobRecord) { return job.moduleRuns![0]; }
function lessonOutput() { const { localId: _id, frameKey: _frame, featureIds: _features, questions: _questions, ...rest } = lesson; return { ...rest, flags: [] }; }
function manualLesson(run: AiModuleDraftRun) {
  return { ...lesson, localId: run.outline.moduleLocalId, frameKey: run.outline.frameKey, featureIds: run.outline.featureIds, questions: [] };
}

async function approveManualPair(service: ReturnType<typeof createAiJobService>, job: AiJobRecord, run: AiModuleDraftRun) {
  const input = { jobId: job.jobId, moduleLocalId: run.outline.moduleLocalId };
  let current = await service.updateModuleLesson(admin, { ...input, expectedVersion: run.lessonVersion, module: manualLesson(run) });
  let edited = current.moduleRuns!.find((item) => item.outline.moduleLocalId === input.moduleLocalId)!;
  current = await service.approveModuleLesson(admin, { ...input, expectedVersion: edited.lessonVersion });
  edited = current.moduleRuns!.find((item) => item.outline.moduleLocalId === input.moduleLocalId)!;
  current = await service.updateModuleQuestions(admin, { ...input, expectedVersion: edited.questionVersion, questions: lesson.questions });
  edited = current.moduleRuns!.find((item) => item.outline.moduleLocalId === input.moduleLocalId)!;
  return service.approveModuleQuestions(admin, { ...input, expectedVersion: edited.questionVersion });
}

describe('module lifecycle transitions', () => {
  it('rejects a first-question request captured before an approved lesson is replaced', () => {
    const firstLesson = approveLesson(updateLesson(createModuleRuns(outline)[0], 0, lesson, 'manual'), 1);
    const staleQuestionVersion = firstLesson.questionVersion;
    expect(staleQuestionVersion).toBe(0);
    expect(firstLesson.questionDraft).toBeUndefined();

    const replacement = updateLesson(firstLesson, 1, { ...lesson, title: 'Lesson version two' }, 'manual');
    const secondLesson = approveLesson(replacement, 2);

    expect(() => updateQuestions(secondLesson, staleQuestionVersion, lesson.questions)).toThrow('Questions require the current approved lesson and version.');
    expect(secondLesson.questionVersion).toBe(1);
    expect(secondLesson.questionDraft).toBeUndefined();
    expect(updateQuestions(secondLesson, 1, lesson.questions)).toMatchObject({ questionVersion: 2, questionLessonVersion: 2, questionState: 'review_ready' });
  });
  it('does not carry flags from a replaced draft into a new lesson or question version', () => {
    const flag = { type: 'ambiguous' as const, severity: 'warning' as const, message: 'Old draft', questionForAdmin: 'Verify?', location: { blockLocalId: 'old-block' }, evidence: [] };
    const run = { ...approvedRun(), lessonFlags: [flag], questionFlags: [flag] };
    expect(updateLesson(run, 1, lesson, 'manual').lessonFlags).toEqual([]);
    expect(updateQuestions(run, 1, lesson.questions).questionFlags).toEqual([]);
  });
  it('increments versions, requires approval order, and rejects stale versions', () => {
    const run = createModuleRuns(outline)[0];
    expect(run).toMatchObject({ lessonState: 'queued', lessonVersion: 0, questionState: 'blocked', questionVersion: 0 });
    expect(() => approveLesson(run, 0)).toThrow();
    expect(() => updateQuestions(run, 0, lesson.questions)).toThrow();
    const approved = approvedRun();
    expect(approved).toMatchObject({ lessonState: 'approved', lessonVersion: 1, approvedLessonVersion: 1, questionState: 'approved', questionVersion: 1, approvedQuestionVersion: 1, questionLessonVersion: 1 });
    expect(() => updateLesson(approved, 0, lesson, 'manual')).toThrow();
    expect(() => approveQuestions(approved, 0)).toThrow();
    expect(modulesComplete([approved])).toBe(true);
    const changed = updateLesson(approved, 1, { ...lesson, title: 'Updated' }, 'manual');
    expect(changed).toMatchObject({ lessonVersion: 2, lessonState: 'review_ready', questionState: 'stale', questionVersion: 2 });
    expect(changed.approvedLessonVersion).toBeUndefined();
    expect(changed.approvedQuestionVersion).toBeUndefined();
    expect(modulesComplete([changed])).toBe(false);
    expect(approved.lessonDraft?.title).toBe('Module 1');
  });
  it('preserves approvals on reorder but invalidates only source/skeleton changes and tombstones', () => {
    const runs = [approvedRun(), ...createModuleRuns(outline).slice(1)];
    const reordered = { ...outline, revision: 2, modules: [...outline.modules].reverse().map((m, order) => ({ ...m, order })) };
    const next = reconcileModuleRuns(runs, reordered);
    expect(next.find((r) => r.outline.moduleLocalId === 'm1')).toMatchObject({ lessonState: 'approved', questionState: 'approved', outlineRevision: 2 });
    for (const patch of [{ sourceSectionIds: ['other'] }, { objectives: ['Changed'] }, { title: 'Changed' }, { tombstoned: true }]) {
      const changed = reconcileModuleRuns(runs, { ...outline, revision: 2, modules: outline.modules.map((m) => m.moduleLocalId === 'm1' ? { ...m, ...patch } : m) });
      expect(changed[0]).toMatchObject({ lessonState: 'stale', questionState: 'stale', lessonVersion: 2, questionVersion: 2 });
      expect(changed[0].approvedLessonVersion).toBeUndefined();
      expect(changed[1].lessonState).toBe('queued');
      expect(modulesComplete(changed)).toBe(false);
    }
  });
});

describe('persisted module jobs', () => {
  it('rejects malformed skeleton metadata and schema-invalid fallback even when it is source-only', async () => {
    const { service, job } = await setup();
    for (const patch of [{ title: 123 }, { estimatedMinutes: -1 }, { objectives: [null] }]) {
      await expect(service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'update', moduleLocalId: active(job).outline.moduleLocalId, patch: patch as never }] })).rejects.toThrow();
    }
    const module = { ...active(job).outline, title: 123 as unknown as string };
    const fallback = buildFallbackLesson({ outline: module, sections: aiSource.sections! });
    if (fallback.kind !== 'draft') throw new Error('No fallback');
    expect(validApprovedLesson(fallback.module, { module, sections: aiSource.sections!, features: [], responsibilities: [], templateKind: 'advanced' }, 'fallback')).toBe(false);
  });
  it('keeps another module call and its worker lease when an approved module is edited', async () => {
    const { service, job } = await setup();
    await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: job.outline!.modules.map((module) => ({ type: 'update', moduleLocalId: module.moduleLocalId, patch: { sourceSectionIds: ['source-1#s1'] } })) });
    let current = await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
    current = await approveManualPair(service, current, active(current));
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    if (step.kind !== 'ai_call') throw new Error('No second module call');
    expect((await service.getJob(admin, job.jobId)).calls.at(-1)?.moduleLocalId).toBe(job.moduleRuns![1].outline.moduleLocalId);
    await service.updateModuleLesson(admin, { jobId: job.jobId, moduleLocalId: active(current).outline.moduleLocalId, expectedVersion: 1, module: { ...manualLesson(active(current)), title: 'Manual update' } });
    current = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab', callId: step.callId, text: JSON.stringify(lessonOutput()) });
    expect(current.moduleRuns![1].lessonState).toBe('review_ready');
    expect(active(current).lessonDraft?.title).toBe('Manual update');
  });
  it('retains tombstones and approval audit when a module is replaced with the same frame', async () => {
    const { service, job } = await setup();
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    const approved = await approveManualPair(service, job, active(job));
    const moduleLocalId = active(job).outline.moduleLocalId;
    const replacement = await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'delete', moduleLocalId }, { type: 'add', module: active(job).outline }] });
    const tombstone = replacement.moduleRuns!.find((run) => run.outline.moduleLocalId === moduleLocalId)!;
    expect(tombstone).toMatchObject({ outline: { tombstoned: true }, lessonState: 'stale', questionState: 'stale' });
    expect(replacement.moduleRuns![0].outline.moduleLocalId).not.toBe(moduleLocalId);
    expect(replacement.stageOutputs.__moduleAudit).toEqual(approved.stageOutputs.__moduleAudit);
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
    await expect(service.approveModuleLesson(admin, { jobId: job.jobId, moduleLocalId, expectedVersion: tombstone.lessonVersion })).rejects.toThrow();
  });
  it('rejects unknown edit types, foreign frames and blank/duplicate source selections before prompting', async () => {
    const { service, job } = await setup();
    await expect(service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'bogus', moduleLocalId: active(job).outline.moduleLocalId, order: 3 } as never] })).rejects.toThrow();
    await expect(service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'add', module: { ...active(job).outline, frameKey: 'foreign-frame', order: 4 } }] })).rejects.toThrow();
    for (const sourceSectionIds of [[''], ['source-1#s1', 'source-1#s1']]) {
      const row = await service.getJob(admin, job.jobId);
      const changed = await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: row.outline!.revision, edits: [{ type: 'update', moduleLocalId: active(job).outline.moduleLocalId, patch: { sourceSectionIds } }] });
      await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: changed.outline!.revision });
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
      expect(active(await service.getJob(admin, job.jobId)).lessonState).toBe('manual_required');
    }
  });
  it('rejects metadata forgeries and invalid question counts while allowing explicit manual authoring', async () => {
    const { service, job } = await setup();
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    const input = { jobId: job.jobId, moduleLocalId: active(job).outline.moduleLocalId, expectedVersion: 0 };
    await expect(service.updateModuleLesson(admin, { ...input, module: { ...manualLesson(active(job)), localId: 'forged' } })).rejects.toThrow();
    await service.updateModuleLesson(admin, { ...input, module: manualLesson(active(job)) });
    await service.approveModuleLesson(admin, { ...input, expectedVersion: 1 });
    await expect(service.updateModuleQuestions(admin, { ...input, questions: lesson.questions.slice(0, 2) })).rejects.toThrow();
    await expect(service.updateModuleQuestions(admin, { ...input, questions: lesson.questions.map((q) => ({ ...q, blockIds: ['foreign'] })) })).rejects.toThrow();
    const current = await service.updateModuleQuestions(admin, { ...input, questions: lesson.questions });
    expect(active(current)).toMatchObject({ lessonProvenance: 'manual', questionState: 'review_ready', questionVersion: 1 });
    await expect(service.approveModuleQuestions(admin, { ...input, expectedVersion: 0 })).rejects.toThrow();
  });
  it('completes only current approved pairs and reopens completed jobs when their sources change', async () => {
    const { service, store, job } = await setup();
    const edited = await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: job.outline!.modules.map((module) => ({ type: 'update', moduleLocalId: module.moduleLocalId, patch: { sourceSectionIds: ['source-1#s1'] } })) });
    let current = await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
    for (const run of edited.moduleRuns!) current = await approveManualPair(service, current, run);
    expect((await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' })).kind).toBe('done');
    const source = (await store.query('room-a', 'onboarding_sources')).records[0];
    await store.update('room-a', 'onboarding_sources', String(source.id), { sections: [{ ...aiSource.sections![0], text: aiSource.sections![0].text + ' A revised instruction.' }] });
    const next = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    expect(next.kind).toBe('ai_call');
    current = await service.getJob(admin, job.jobId);
    expect(current.status).toBe('running');
    expect(current.moduleRuns!.every((run) => run.approvedLessonVersion === undefined && run.approvedQuestionVersion === undefined)).toBe(true);
    expect(current.stageOutputs.__moduleAudit).toHaveLength(8);
  });
  it('preserves approved snapshots through reorder and manual edits while failing stale concurrent writes', async () => {
    const { service, job } = await setup();
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    let current = await approveManualPair(service, job, active(job));
    const moduleLocalId = active(job).outline.moduleLocalId;
    const audit = current.stageOutputs.__moduleAudit;
    current = await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'reorder', moduleLocalId, order: 3 }] });
    expect(current.moduleRuns!.find((run) => run.outline.moduleLocalId === moduleLocalId)).toMatchObject({ lessonState: 'approved', questionState: 'approved' });
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
    const input = { jobId: job.jobId, moduleLocalId, expectedVersion: 1, module: { ...manualLesson(active(job)), title: 'Edited title' } };
    const results = await Promise.allSettled([service.updateModuleLesson(admin, input), service.updateModuleLesson(admin, input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    current = await service.getJob(admin, job.jobId);
    const run = current.moduleRuns!.find((r) => r.outline.moduleLocalId === moduleLocalId)!;
    expect(run).toMatchObject({ lessonVersion: 2, lessonState: 'review_ready', lessonProvenance: 'manual', questionState: 'stale', questionLessonVersion: 1 });
    expect(current.stageOutputs.__moduleAudit).toEqual(audit);
    await expect(service.approveModuleQuestions(admin, { jobId: job.jobId, moduleLocalId, expectedVersion: run.questionVersion })).rejects.toThrow();
  });
  it('invalidates only modules using the changed source and discards completed output from the old source version', async () => {
    const { service, store, job } = await setup();
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    if (step.kind !== 'ai_call') throw new Error('No call');
    const source = (await store.query('room-a', 'onboarding_sources')).records[0];
    await store.update('room-a', 'onboarding_sources', String(source.id), { sections: [{ ...aiSource.sections![0], text: aiSource.sections![0].text + ' Updated.' }] });
    await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab', callId: step.callId, text: JSON.stringify(lessonOutput()) });
    const current = await service.getJob(admin, job.jobId);
    expect(active(current).lessonState).toBe('stale');
    expect(current.moduleRuns![1].lessonVersion).toBe(0);
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' })).resolves.toMatchObject({ kind: 'ai_call' });
  });
  it('does not give another worker an unapproved or superseded active call', async () => {
    const { service, job } = await setup();
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    if (step.kind !== 'ai_call') throw new Error('No call');
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'other' })).resolves.toMatchObject({ kind: 'wait' });
    await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'update', moduleLocalId: active(job).outline.moduleLocalId, patch: { objectives: ['Updated', 'Outline'] } }] });
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
    await expect(service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab', callId: step.callId, text: JSON.stringify(lessonOutput()) })).rejects.toThrow();
    await expect(service.approveModuleLesson(admin, { jobId: job.jobId, moduleLocalId: active(job).outline.moduleLocalId, expectedVersion: 1 })).rejects.toThrow();
  });
  it('turns invalid active lesson output into fallback, then safely retries only that module', async () => {
    const { service, job } = await setup();
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    if (step.kind !== 'ai_call') throw new Error('No call');
    let invalid = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab', callId: step.callId, text: '{invalid' });
    expect(active(invalid)).toMatchObject({ lessonState: 'drafting', lessonVersion: 0, lessonAttempts: 1, schemaRepairs: 1 });
    const repair = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    if (repair.kind !== 'ai_call') throw new Error('No schema repair');
    invalid = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab', callId: repair.callId, text: '{still-invalid' });
    expect(active(invalid)).toMatchObject({ lessonState: 'fallback_review', lessonVersion: 1, lessonAttempts: 2, schemaRepairs: 1 });
    const retried = await service.retryModule(admin, { jobId: job.jobId, moduleLocalId: active(job).outline.moduleLocalId, target: 'lesson' });
    expect(active(retried)).toMatchObject({ lessonState: 'queued', lessonVersion: 2 });
    expect(retried.moduleRuns![1].lessonVersion).toBe(0);
    const next = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    expect(next.kind).toBe('ai_call');
    if (next.kind === 'ai_call') expect(next.callId).not.toBe(step.callId);
  });
  it('starts module_v2 awaiting outline approval, then reviews lesson and questions before completion', async () => {
    const { service, job } = await setup();
    expect(job).toMatchObject({ pipelineVersion: 'module_v2', outline: { revision: 1 }, calls: [] });
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    expect(step.kind).toBe('ai_call');
    if (step.kind !== 'ai_call') throw new Error('No module call');
    let draft = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab', callId: step.callId, text: JSON.stringify(lessonOutput()) });
    expect(active(draft)).toMatchObject({ lessonState: 'review_ready', lessonVersion: 1, questionState: 'blocked' });
    const moduleLocalId = active(draft).outline.moduleLocalId;
    await service.approveModuleLesson(admin, { jobId: job.jobId, moduleLocalId, expectedVersion: 1 });
    const qstep = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    if (qstep.kind !== 'ai_call') throw new Error('No question call');
    draft = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab', callId: qstep.callId, text: JSON.stringify({ questions: lesson.questions, flags: [] }) });
    expect(active(draft)).toMatchObject({ questionState: 'review_ready', questionVersion: 1, questionLessonVersion: 1 });
    draft = await service.approveModuleQuestions(admin, { jobId: job.jobId, moduleLocalId, expectedVersion: 1 });
    expect(active(draft).questionState).toBe('approved');
    expect(draft.stageOutputs.__moduleAudit).toEqual(expect.arrayContaining([expect.objectContaining({ target: 'lesson', version: 1 }), expect.objectContaining({ target: 'questions', version: 1, lessonVersion: 1 })]));
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
    expect((await service.getJob(admin, job.jobId)).status).toBe('running');
  });
  it('enforces admin, room, owner, revision and atomic version checks', async () => {
    const { service, job } = await setup();
    for (const [actor, code] of [[{ ...admin, access: 'learner' }, 'ADMIN_REQUIRED'], [{ ...admin, userId: 'other' }, 'JOB_OWNER_REQUIRED'], [{ ...admin, roomId: 'other' }, 'JOB_NOT_FOUND']] as const) {
      await expect(service.approveOutline(actor, { jobId: job.jobId, expectedRevision: 1 })).rejects.toMatchObject({ code });
    }
    await expect(service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 0 })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    const edits = [{ type: 'update' as const, moduleLocalId: active(job).outline.moduleLocalId, patch: { title: 'Reviewed' } }];
    const races = await Promise.allSettled([service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits }), service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits })]);
    expect(races.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.getJob(admin, job.jobId)).outline?.revision).toBe(2);
  });
  it('terminal lesson failures preserve other modules and produce approvable advanced fallback', async () => {
    const { service, job } = await setup('advanced');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    if (step.kind !== 'ai_call') throw new Error('No module call');
    const failed = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab', callId: step.callId, kind: 'failed' });
    expect(failed.status).toBe('running');
    expect(active(failed)).toMatchObject({ lessonState: 'fallback_review', lessonProvenance: 'fallback' });
    expect(active(failed).lessonDraft?.blocks.some((b) => b.kind === 'scenario')).toBe(false);
    await service.approveModuleLesson(admin, { jobId: job.jobId, moduleLocalId: active(failed).outline.moduleLocalId, expectedVersion: 1 });
    const qstep = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
    expect(qstep).toMatchObject({ kind: 'ai_call', prompt: expect.stringContaining('questions') });
    if (qstep.kind !== 'ai_call') throw new Error('No fallback question call');
    const questions = lesson.questions.map((question) => ({ ...question, blockIds: [active(failed).lessonDraft!.blocks[0].localId] }));
    const questionDraft = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab', callId: qstep.callId, text: JSON.stringify({ questions, flags: [] }) });
    expect(active(questionDraft)).toMatchObject({ lessonProvenance: 'fallback', questionState: 'review_ready' });
    const approved = await service.approveModuleQuestions(admin, { jobId: job.jobId, moduleLocalId: active(failed).outline.moduleLocalId, expectedVersion: active(questionDraft).questionVersion });
    expect(active(approved).questionState).toBe('approved');
  });
  it('missing exact sources become manual placeholders, block questions and completion, and never use unrelated context', async () => {
    const { service, job } = await setup();
    const moduleLocalId = active(job).outline.moduleLocalId;
    await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'update', moduleLocalId, patch: { sourceSectionIds: ['unresolved'] } }] });
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
    const missing = await service.getJob(admin, job.jobId);
    expect(active(missing).lessonState).toBe('manual_required');
    expect(missing.calls).toEqual([]);
    await expect(service.approveModuleLesson(admin, { jobId: job.jobId, moduleLocalId, expectedVersion: active(missing).lessonVersion })).rejects.toThrow();
    await expect(service.retryModule(admin, { jobId: job.jobId, moduleLocalId, target: 'questions' })).rejects.toThrow();
  });
});

it('allows approved manual content without sources while rejecting invalid and forged fallback lessons', async () => {
  const { service, job } = await setup();
  const moduleLocalId = active(job).outline.moduleLocalId;
  const edited = await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: [{ type: 'update', moduleLocalId, patch: { sourceSectionIds: [] } }] });
  await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: edited.outline!.revision });
  await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
  const placeholder = active(await service.getJob(admin, job.jobId));
  expect(placeholder.lessonState).toBe('manual_required');
  const content = { ...manualLesson(placeholder), blocks: manualLesson(placeholder).blocks.map((block) => ({ ...block, sourceRefs: [] })) };
  const args = { jobId: job.jobId, moduleLocalId };
  await expect(service.updateModuleLesson(admin, { ...args, expectedVersion: placeholder.lessonVersion, module: { ...content, blocks: [] } })).rejects.toThrow();
  const context = { module: placeholder.outline, sections: [], features: [], responsibilities: [], templateKind: 'normal' as const };
  expect(validApprovedLesson(content, context, 'fallback')).toBe(false);
  let current = await service.updateModuleLesson(admin, { ...args, expectedVersion: placeholder.lessonVersion, module: content });
  current = await service.approveModuleLesson(admin, { ...args, expectedVersion: active(current).lessonVersion });
  expect(active(current)).toMatchObject({ lessonState: 'approved', lessonProvenance: 'manual' });
  await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab' });
  expect(active(await service.getJob(admin, job.jobId)).lessonState).toBe('approved');
  const qs = lesson.questions.map((question) => ({ ...question, sourceRefs: [] }));
  current = await service.updateModuleQuestions(admin, { ...args, expectedVersion: active(current).questionVersion, questions: qs });
  current = await service.approveModuleQuestions(admin, { ...args, expectedVersion: active(current).questionVersion });
  expect(active(current)).toMatchObject({ questionState: 'approved', questionLessonVersion: active(current).lessonVersion });
});
