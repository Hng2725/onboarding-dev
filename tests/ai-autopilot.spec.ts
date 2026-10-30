import { describe, expect, it, vi } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import type { AiJobRecord, AiModuleDraftRun } from '../src/onboarding/contracts';
import { createAiJobService, type AiJobService } from '../src/onboarding/ai/jobs';
import { createTemplateService } from '../src/onboarding/templates';
import { createAiReviewService } from '../src/onboarding/ai/review';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { aiSource, generatedTemplate, seedAiSource } from './helpers/ai-template-fixture';
import { completePlan } from './helpers/complete-plan';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };
const workerId = 'autopilot-worker';
const ordersQuote = aiSource.sections![0].text;
const supportQuote = 'Contact the support desk when an order fails to submit correctly.';
const sectionQuotes: Readonly<Record<string, string>> = { 'source-1#s1': ordersQuote, 'source-2#s1': supportQuote };
const FALLBACK_WARNING = 'Bài học được dựng trực tiếp từ tài liệu nguồn, nên rà soát cách diễn đạt.';

/** Four covered modules: module 3 is grounded only in source-2, the others in source-1. */
function plan(sections: readonly (readonly string[])[] = [['source-1#s1'], ['source-1#s1'], ['source-2#s1'], ['source-1#s1']]) {
  return {
    modules: sections.map((sourceSectionIds, index) => ({
      title: 'Bài ' + String(index + 1), description: 'Mô tả bài ' + String(index + 1), estimatedMinutes: 10,
      objectives: ['Nắm quy trình', 'Áp dụng quy trình'], featureIds: [], sourceSectionIds: [...sourceSectionIds], responsibilityIndexes: [],
      coverage: sourceSectionIds.length ? 'sufficient' : 'insufficient', gapNote: sourceSectionIds.length ? '' : 'Thiếu tài liệu.',
    })),
  };
}

async function autopilotJob(operationId: string, sections?: readonly (readonly string[])[]) {
  const store = new MemoryOnboardingStore();
  await seedAiSource(store);
  await store.create(admin.roomId, 'onboarding_sources', {
    sourceId: 'source-2', kind: 'document', fileName: 'support.md', checksum: 'checksum-2', systemName: 'Order System', status: 'ready',
    sections: [{ id: 'source-2#s1', headingPath: ['Support'], text: supportQuote }], textLength: supportQuote.length,
    createdBy: admin.userId, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
  });
  await store.create(admin.roomId, 'onboarding_ai_jobs', {
    jobId: 'inventory-autopilot', kind: 'inventory', status: 'completed', sourceIds: ['source-1', 'source-2'], promptVersion: 'test', calls: [], stageOutputs: {},
    result: { systemSummary: { purpose: 'Orders', modules: [], sourceRefs: [{ sectionId: 'source-1#s1', quote: ordersQuote }] }, glossary: [], features: [], flags: [] },
    operationId: 'inventory-autopilot', createdBy: admin.userId, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
  });
  const service = createAiJobService(store, { now: () => '2026-10-29T01:00:00.000Z' });
  const started = await service.startJob(admin, { kind: 'template', inventoryJobId: 'inventory-autopilot', templateKind: 'normal', operationId });
  const job = await completePlan(service, admin, started, plan(sections), workerId);
  return { store, service, job };
}

function lessonOutput(run: AiModuleDraftRun): string {
  const sectionId = run.outline.sourceSectionIds[0];
  const prefix = 'm' + String(run.outline.order + 1);
  return JSON.stringify({
    title: 'Bài học ' + String(run.outline.order + 1), description: 'Quy trình đơn hàng.', estimatedMinutes: 8,
    objectives: ['Hiểu quy trình', 'Áp dụng quy trình'],
    blocks: [
      { localId: prefix + '-b1', kind: 'concept', title: 'Quy trình', body: 'Làm theo **tài liệu** để xử lý đơn.', sourceRefs: [{ sectionId, quote: sectionQuotes[sectionId] }] },
      { localId: prefix + '-summary', kind: 'summary', body: 'Ôn lại quy trình.', sourceRefs: [] },
    ],
    flags: [],
  });
}

function questionOutput(run: AiModuleDraftRun): string {
  const block = run.lessonDraft!.blocks.find((item) => item.kind !== 'summary')!;
  return JSON.stringify({
    questions: generatedTemplate.modules[0].questions.map((question, index) => ({
      ...question, localId: run.outline.moduleLocalId + '-q' + String(index + 1), blockIds: [block.localId], sourceRefs: block.sourceRefs,
    })),
    flags: [],
  });
}

type Responder = (run: AiModuleDraftRun, target: 'lesson' | 'questions', attempt: number) => string;
const valid: Responder = (run, target) => target === 'lesson' ? lessonOutput(run) : questionOutput(run);

/** Pumps like the client: every ai_call gets an output; stops at the first non-call step or after `limit` submissions. */
async function pump(service: AiJobService, jobId: string, respond: Responder = valid, limit = 40) {
  const order: string[] = [];
  for (let submitted = 0; submitted < limit; submitted += 1) {
    const step = await service.nextStep(admin, { jobId, workerId });
    if (step.kind !== 'ai_call') return { step, order };
    const job = await service.getJob(admin, jobId);
    const call = job.calls.find((item) => item.callId === step.callId)!;
    const run = job.moduleRuns!.find((item) => item.outline.moduleLocalId === call.moduleLocalId)!;
    const target = step.moduleTarget!;
    order.push(target + ':' + String(run.outline.order + 1));
    const attempt = order.filter((item) => item === target + ':' + String(run.outline.order + 1)).length;
    await service.submitAiOutput(admin, { jobId, workerId, callId: step.callId, text: respond(run, target, attempt) });
  }
  return { step: undefined, order };
}

function audit(job: AiJobRecord): readonly Record<string, unknown>[] {
  return (job.stageOutputs.__moduleAudit ?? []) as readonly Record<string, unknown>[];
}

describe('AI template autopilot', () => {
  it('writes and self-approves every module in order after the outline is approved', async () => {
    const { service, job } = await autopilotJob('autopilot-flow');
    expect(job.autoApprove).toBe(true);
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });

    const { step, order } = await pump(service, job.jobId);

    expect(order).toEqual(['lesson:1', 'questions:1', 'lesson:2', 'questions:2', 'lesson:3', 'questions:3', 'lesson:4', 'questions:4']);
    expect(step).toMatchObject({ kind: 'done', job: { status: 'completed', result: { templateId: expect.any(String) } } });
    const done = step!.job;
    expect(done.moduleRuns!.every((run) => run.lessonState === 'approved' && run.questionState === 'approved')).toBe(true);
    const entries = audit(done);
    expect(entries).toHaveLength(8);
    expect(entries.every((entry) => entry.approvedBy === 'autopilot')).toBe(true);
    expect(entries.map((entry) => entry.target)).toEqual(['lesson', 'questions', 'lesson', 'questions', 'lesson', 'questions', 'lesson', 'questions']);
  });

  it('self-approves the source fallback lesson with a warning after an invalid lesson and its repair', async () => {
    const { service, job } = await autopilotJob('autopilot-fallback');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    const first = job.moduleRuns!.find((run) => run.outline.order === 0)!;

    const { step, order } = await pump(service, job.jobId, (run, target, attempt) => run.outline.order === 0 && target === 'lesson' && attempt <= 2 ? '{"title": 1}' : valid(run, target, attempt));

    expect(order.slice(0, 3)).toEqual(['lesson:1', 'lesson:1', 'questions:1']);
    expect(step).toMatchObject({ kind: 'done' });
    const run = step!.job.moduleRuns!.find((item) => item.outline.moduleLocalId === first.outline.moduleLocalId)!;
    expect(run).toMatchObject({ lessonState: 'approved', lessonProvenance: 'fallback', questionState: 'approved' });
    const warnings = run.lessonFlags!.filter((flag) => flag.message === FALLBACK_WARNING);
    expect(warnings).toEqual([{
      type: 'low_quality_source', severity: 'warning', message: FALLBACK_WARNING,
      questionForAdmin: 'Kiểm tra và chỉnh câu chữ nếu cần.', location: { moduleLocalId: first.outline.moduleLocalId }, evidence: [],
    }]);
    const lessonAudit = audit(step!.job).filter((entry) => entry.target === 'lesson' && entry.moduleLocalId === first.outline.moduleLocalId);
    expect(lessonAudit).toHaveLength(1);
    expect(lessonAudit[0]).toMatchObject({ provenance: 'fallback', approvedBy: 'autopilot', flags: warnings });
  });

  it('rejects outline approval while a module lacks usable sources', async () => {
    const { service, job } = await autopilotJob('autopilot-gate', [['source-1#s1'], ['source-1#s1'], [], ['source-1#s1']]);
    await expect(service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision }))
      .rejects.toMatchObject({ code: 'COVERAGE_INCOMPLETE', message: 'Còn module chưa đủ tài liệu.' });
  });

  it('returns to the admin when a referenced source is deleted mid-run', async () => {
    const { store, service, job } = await autopilotJob('autopilot-deleted');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    const { order } = await pump(service, job.jobId, valid, 2);
    expect(order).toEqual(['lesson:1', 'questions:1']);
    const source = (await store.query<{ id: string }>(admin.roomId, 'onboarding_sources', { filter: { sourceId: 'source-2' } })).records[0];
    await store.update(admin.roomId, 'onboarding_sources', source.id, { deletedAt: '2026-10-29T01:00:00.000Z' });

    const step = await service.nextStep(admin, { jobId: job.jobId, workerId });

    expect(step.kind).toBe('awaiting_admin');
    expect(step.job.outlineApprovedRevision).toBe(0);
    const [first, , third] = [...step.job.moduleRuns!].sort((a, b) => a.outline.order - b.outline.order);
    expect(first).toMatchObject({ lessonState: 'approved', questionState: 'approved' });
    expect(third.lessonState).not.toBe('fallback_review');
    expect(third.lessonDraft).toBeUndefined();
    expect(step.job.calls.filter((call) => call.status === 'pending' || call.status === 'dispatched')).toEqual([]);
    await expect(service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision })).rejects.toMatchObject({ code: 'COVERAGE_INCOMPLETE' });
  });

  it('pauses without losing approved modules and resumes without redrafting them', async () => {
    const { service, job } = await autopilotJob('autopilot-pause');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    await pump(service, job.jobId, valid, 2);
    const live = await service.nextStep(admin, { jobId: job.jobId, workerId });
    if (live.kind !== 'ai_call') throw new Error('Expected the second lesson call.');
    await service.recordDispatch(admin, { jobId: job.jobId, workerId, callId: live.callId, attemptRef: 'attempt-m2', provider: 'sandbox' });

    const paused = await service.pauseAutopilot(admin, { jobId: job.jobId });

    expect(paused.outlineApprovedRevision).toBe(0);
    expect(paused.calls.find((call) => call.callId === live.callId)).toMatchObject({ status: 'failed', errors: ['Tạm dừng bởi Admin.'], cleanupState: 'pending' });
    expect(paused.pumpedBy).toBeUndefined();
    const runs = [...paused.moduleRuns!].sort((a, b) => a.outline.order - b.outline.order);
    expect(runs[0]).toMatchObject({ lessonState: 'approved', questionState: 'approved' });
    expect(runs[1].lessonState).toBe('queued');
    await expect(service.pauseAutopilot(admin, { jobId: job.jobId })).resolves.toMatchObject({ outlineApprovedRevision: 0, updatedAt: paused.updatedAt });
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId })).resolves.toMatchObject({ kind: 'awaiting_admin' });

    await service.recordAttemptCleanup(admin, { jobId: job.jobId, callId: live.callId, attemptRef: 'attempt-m2', state: 'confirmed' });
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: paused.outline!.revision });
    const { step, order } = await pump(service, job.jobId);

    expect(order).toEqual(['lesson:2', 'questions:2', 'lesson:3', 'questions:3', 'lesson:4', 'questions:4']);
    expect(step).toMatchObject({ kind: 'done' });
    expect(audit(step!.job).filter((entry) => entry.moduleLocalId === runs[0].outline.moduleLocalId)).toHaveLength(2);
    expect(step!.job.moduleRuns!.find((run) => run.outline.moduleLocalId === runs[0].outline.moduleLocalId)!.lessonVersion).toBe(runs[0].lessonVersion);
  });

  it('leaves failed questions to the client recovery and then approves the fallback questions', async () => {
    const { service, job } = await autopilotJob('autopilot-question-recovery');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    await pump(service, job.jobId, valid, 1);
    const questions = await service.nextStep(admin, { jobId: job.jobId, workerId });
    expect(questions).toMatchObject({ kind: 'ai_call', moduleTarget: 'questions' });
    if (questions.kind !== 'ai_call') throw new Error('Expected the first question call.');
    const failed = await service.reportAiFailure(admin, { jobId: job.jobId, workerId, callId: questions.callId, kind: 'failed', provider: 'native_chat', providerErrorCode: 'DISPATCH_NOT_STARTED' });
    const first = failed.moduleRuns!.find((run) => run.outline.order === 0)!;
    expect(first.questionState).toBe('failed');

    await expect(service.nextStep(admin, { jobId: job.jobId, workerId })).resolves.toMatchObject({ kind: 'awaiting_admin', job: { outlineApprovedRevision: job.outline!.revision } });
    await service.useQuestionFallback(admin, { jobId: job.jobId, moduleLocalId: first.outline.moduleLocalId, expectedVersion: first.questionVersion });
    const { step, order } = await pump(service, job.jobId);

    expect(order[0]).toBe('lesson:2');
    expect(step).toMatchObject({ kind: 'done' });
    const recovered = step!.job.moduleRuns!.find((run) => run.outline.moduleLocalId === first.outline.moduleLocalId)!;
    expect(recovered).toMatchObject({ questionState: 'approved', questionProvenance: 'fallback' });
    expect(audit(step!.job).filter((entry) => entry.target === 'questions' && entry.moduleLocalId === first.outline.moduleLocalId)).toEqual([
      expect.objectContaining({ provenance: 'fallback', approvedBy: 'autopilot' }),
    ]);
  });

  it('only pauses a running job', async () => {
    const { service, job } = await autopilotJob('autopilot-pause-done');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    await expect(pump(service, job.jobId)).resolves.toMatchObject({ step: { kind: 'done' } });
    await expect(service.pauseAutopilot(admin, { jobId: job.jobId })).rejects.toMatchObject({ code: 'JOB_NOT_RUNNING' });
    await expect(service.pauseAutopilot({ ...admin, userId: 'admin-2' }, { jobId: job.jobId })).rejects.toMatchObject({ code: 'JOB_OWNER_REQUIRED' });
  });

  it('lets a completed job be approved again from coverage and pumped back to done', async () => {
    const { service, job } = await autopilotJob('autopilot-reapprove-done');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    const first = await pump(service, job.jobId);
    expect(first.step).toMatchObject({ kind: 'done', job: { status: 'completed' } });
    const reapproved = await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    expect(reapproved).toMatchObject({ status: 'completed', outlineApprovedRevision: job.outline!.revision });
    const again = await pump(service, job.jobId);
    expect(again.order).toEqual([]);
    expect(again.step).toMatchObject({ kind: 'done', job: { status: 'completed', result: first.step!.job.result } });
  });

  it('edits a completed module lesson through the job: questions regenerate and the draft re-materializes', async () => {
    const { service, job } = await autopilotJob('autopilot-edit-done');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    const done = (await pump(service, job.jobId)).step!.job;
    const run = done.moduleRuns![0];
    const edited = await service.updateModuleLesson(admin, {
      jobId: done.jobId, moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion,
      module: { ...run.lessonDraft!, title: 'Bài học đã sửa' },
    });
    expect(edited).toMatchObject({ status: 'running', result: null });
    const { step, order } = await pump(service, done.jobId);
    expect(order).toEqual(['questions:' + String(run.outline.order + 1)]);
    expect(step).toMatchObject({ kind: 'done', job: { status: 'completed' } });
    const after = step!.job.moduleRuns![0];
    expect(after).toMatchObject({ lessonState: 'approved', lessonProvenance: 'manual', questionState: 'approved' });
    expect(after.lessonDraft!.title).toBe('Bài học đã sửa');
    expect(step!.job.result).toBeTruthy();
  });

  it('switches a legacy-mode job to autopilot and approves its review-ready lesson once', async () => {
    const { store, service, job } = await autopilotJob('autopilot-legacy');
    const { id: _id, roomId: _room, planPending: _pending, autoApprove: _auto, ...persisted } = job;
    await store.create(admin.roomId, 'onboarding_ai_jobs', { ...persisted, jobId: 'legacy-manual', operationId: 'legacy-manual-op' });
    const legacy = await service.getJob(admin, 'legacy-manual');
    expect(legacy.autoApprove).toBeUndefined();
    await service.approveOutline(admin, { jobId: legacy.jobId, expectedRevision: legacy.outline!.revision });
    const run = legacy.moduleRuns!.find((item) => item.outline.order === 0)!;
    const lesson = { ...JSON.parse(lessonOutput(run)), localId: run.outline.moduleLocalId, frameKey: run.outline.frameKey, featureIds: run.outline.featureIds, questions: [] };
    delete lesson.flags;
    const ready = await service.updateModuleLesson(admin, { jobId: legacy.jobId, moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion, module: lesson });
    expect(ready.moduleRuns!.find((item) => item.outline.moduleLocalId === run.outline.moduleLocalId)!.lessonState).toBe('review_ready');

    const enabled = await service.enableAutopilot(admin, { jobId: legacy.jobId });
    expect(enabled.autoApprove).toBe(true);
    await expect(service.enableAutopilot(admin, { jobId: legacy.jobId })).resolves.toMatchObject({ autoApprove: true, updatedAt: enabled.updatedAt });

    const step = await service.nextStep(admin, { jobId: legacy.jobId, workerId });
    expect(step).toMatchObject({ kind: 'ai_call', moduleTarget: 'questions' });
    await service.nextStep(admin, { jobId: legacy.jobId, workerId });
    const current = await service.getJob(admin, legacy.jobId);
    expect(current.moduleRuns!.find((item) => item.outline.moduleLocalId === run.outline.moduleLocalId)!.lessonState).toBe('approved');
    const entries = audit(current).filter((entry) => entry.target === 'lesson' && entry.moduleLocalId === run.outline.moduleLocalId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ approvedBy: 'autopilot', provenance: 'manual' });
  });
});

describe('autopilot next_step cost', () => {
  it('answers a completed job whose template exists with done, without re-running approval or materialization', async () => {
    const { store, service, job } = await autopilotJob('autopilot-done-shortcut');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    const first = await pump(service, job.jobId);
    expect(first.step).toMatchObject({ kind: 'done' });
    const query = vi.spyOn(store, 'query');
    const update = vi.spyOn(store, 'update');
    const create = vi.spyOn(store, 'create');
    const again = await service.nextStep(admin, { jobId: job.jobId, workerId });
    expect(again).toMatchObject({ kind: 'done', job: { status: 'completed', result: first.step!.job.result } });
    // Only the source check that would reopen a changed job remains: one read per source.
    expect(query.mock.calls.filter(([, collection]) => collection === 'onboarding_sources').length).toBeLessThanOrEqual(2);
    expect(query.mock.calls.filter(([, collection]) => collection === 'onboarding_template_content')).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('materializes again when the completed job lost its template', async () => {
    const { store, service, job } = await autopilotJob('autopilot-done-missing');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    const first = (await pump(service, job.jobId)).step!.job;
    const result = first.result as { templateId: string; version: number };
    await createTemplateService(store).deleteDraft(admin, result.templateId, result.version);
    const create = vi.spyOn(store, 'create');
    const again = await service.nextStep(admin, { jobId: job.jobId, workerId });
    expect(again).toMatchObject({ kind: 'done' });
    expect(create.mock.calls.some(([, collection]) => collection === 'onboarding_templates')).toBe(true);
  });

  it('reads each job source once per next_step', async () => {
    const { store, service, job } = await autopilotJob('autopilot-source-cache');
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    const first = await service.nextStep(admin, { jobId: job.jobId, workerId });
    expect(first.kind).toBe('ai_call');
    const current = await service.getJob(admin, job.jobId);
    const call = current.calls.find((item) => item.callId === (first as { callId: string }).callId)!;
    const run = current.moduleRuns!.find((item) => item.outline.moduleLocalId === call.moduleLocalId)!;
    await service.submitAiOutput(admin, { jobId: job.jobId, workerId, callId: call.callId, text: lessonOutput(run) });
    const query = vi.spyOn(store, 'query');
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId });
    expect(step).toMatchObject({ kind: 'ai_call', moduleTarget: 'questions' });
    const sourceReads = query.mock.calls.filter(([, collection]) => collection === 'onboarding_sources');
    expect(sourceReads.length).toBeLessThanOrEqual(2);
  });
});

describe('flag resolutions across re-materialization', () => {
  const BLOCKING = 'Tài liệu chưa nêu hạn chót xử lý đơn.';
  const flagged: Responder = (run, target, attempt) => {
    if (target !== 'lesson' || run.outline.order !== 0) return valid(run, target, attempt);
    const lesson = JSON.parse(lessonOutput(run));
    return JSON.stringify({ ...lesson, flags: [{ type: 'missing', severity: 'blocking', message: BLOCKING, questionForAdmin: 'Hạn chót là bao lâu?', evidence: [] }] });
  };

  async function resolvedTemplate(operationId: string) {
    const { store, service, job } = await autopilotJob(operationId);
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: job.outline!.revision });
    const done = (await pump(service, job.jobId, flagged)).step!.job;
    const result = done.result as { templateId: string; version: number };
    const review = createAiReviewService(store, createTemplateService(store));
    const detail = await review.getReview(admin, result.templateId, result.version);
    const flag = detail.flags.find((item) => item.message === BLOCKING)!;
    expect(flag).toMatchObject({ severity: 'blocking', status: 'open' });
    await review.resolveFlag(admin, { templateId: result.templateId, version: result.version, flagId: flag.id, action: 'add_note', note: 'Hạn chót là 2 ngày làm việc.' });
    return { service, review, done, result };
  }

  async function edit(service: AiJobService, done: AiJobRecord, order: number) {
    const run = done.moduleRuns!.find((item) => item.outline.order === order)!;
    await service.updateModuleLesson(admin, {
      jobId: done.jobId, moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion,
      module: { ...run.lessonDraft!, title: 'Bài học đã sửa ' + String(order) },
    });
    const { step } = await pump(service, done.jobId);
    expect(step).toMatchObject({ kind: 'done' });
    return step!.job.result as { templateId: string; version: number };
  }

  it('keeps a resolved blocking flag resolved after another module is edited and re-materialized', async () => {
    const { service, review, done, result } = await resolvedTemplate('flags-carry');
    const after = await edit(service, done, 1);
    const detail = await review.getReview(admin, after.templateId, after.version);
    const flag = detail.flags.find((item) => item.message === BLOCKING)!;
    expect(flag).toMatchObject({ status: 'resolved', resolution: { action: 'add_note', note: 'Hạn chót là 2 ngày làm việc.' } });
    expect(detail.content.modules.find((module) => module.moduleId === flag.location.moduleId)).toBeTruthy();
    expect(after.templateId).toBe(result.templateId);
  });

  it('drops the resolution when editing the flagged module removes the flag', async () => {
    const { service, review, done } = await resolvedTemplate('flags-drop');
    const after = await edit(service, done, 0);
    const detail = await review.getReview(admin, after.templateId, after.version);
    expect(detail.flags.filter((item) => item.message === BLOCKING)).toEqual([]);
    expect(detail.flags.every((item) => item.status === 'open' && item.resolution === undefined)).toBe(true);
  });
});
