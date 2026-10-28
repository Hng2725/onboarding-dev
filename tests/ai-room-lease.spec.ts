import { describe, expect, it, vi } from 'vitest';

import { createAiJobService } from '../src/onboarding/ai/jobs';
import { AI_GENERATION_LIMITS } from '../src/onboarding/ai/limits';
import { acquireRoomAiLease, refreshRoomAiLease, releaseRoomAiLease } from '../src/onboarding/ai/room-ai-lease';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { aiSource, generatedTemplate, seedAiSource } from './helpers/ai-template-fixture';
import { pumpAiJob, type AiPumpApi } from '../src/ui/onboarding/ai/ai-pump';
import type { AiGateway } from '../src/ui/onboarding/ai/ai-gateway-sandbox';

const admin = { userId: 'admin-1', roomId: 'room-a', access: 'admin' as const };
const inventory = {
  systemSummary: { purpose: 'Orders', modules: [], sourceRefs: [{ sectionId: 'source-1#s1', quote: aiSource.sections![0].text }] },
  glossary: [], features: [], flags: [],
};

async function setup(maxPageSize?: number) {
  const store = new MemoryOnboardingStore(maxPageSize);
  await seedAiSource(store);
  let time = Date.parse('2026-10-28T01:00:00.000Z');
  const now = () => new Date(time).toISOString();
  const service = createAiJobService(store, { now });
  const other = createAiJobService(store, { now });
  async function inventoryJob(operationId: string) {
    return service.startJob(admin, { kind: 'inventory', sourceIds: ['source-1'], operationId });
  }
  async function templateJob(operationId = 'template', templateKind: 'normal' | 'advanced' = 'normal') {
    if (!(await store.query(admin.roomId, 'onboarding_ai_jobs', { filter: { jobId: 'inventory' } })).records.length) {
      await store.create(admin.roomId, 'onboarding_ai_jobs', {
        jobId: 'inventory', kind: 'inventory', status: 'completed', sourceIds: ['source-1'], promptVersion: 'old', calls: [], stageOutputs: {}, result: inventory,
        operationId: 'inventory', createdBy: admin.userId, createdAt: now(), updatedAt: now(),
      });
    }
    const job = await service.startJob(admin, {
      kind: 'template', inventoryJobId: 'inventory', templateKind, operationId,
      ...(templateKind === 'advanced' ? { roleProfile: { department: 'Sales', role: 'Agent', responsibilities: ['Create orders', 'Review orders'] } } : {}),
    });
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 1 });
    return service.getJob(admin, job.jobId);
  }
  return { store, service, other, now, advance: (ms: number) => { time += ms; }, inventoryJob, templateJob };
}

describe('room AI serialization', () => {
  it('releases terminal evidence after a release transport failure, including repeated cleanup confirmation', async () => {
    for (const outcome of ['output', 'cleanup'] as const) {
      const { service, other, inventoryJob, store } = await setup();
      const first = await inventoryJob('first');
      const second = await inventoryJob('second');
      await service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-a' });
      await service.recordDispatch(admin, { jobId: first.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-1', provider: 'sandbox' });
      if (outcome === 'cleanup') await service.cancelJob(admin, first.jobId);
      const update = store.update.bind(store);
      let fail = true;
      vi.spyOn(store, 'update').mockImplementation(async (room, collection, id, data, options) => {
        if (fail && collection === 'onboarding_ai_room_leases' && data.expiresAt === '1970-01-01T00:00:00.000Z') {
          fail = false;
          throw new Error('Lease release transport failed');
        }
        return update(room, collection, id, data, options);
      });
      if (outcome === 'cleanup') {
        const input = { jobId: first.jobId, callId: 'A1', attemptRef: 'attempt-1', state: 'confirmed' as const };
        await expect(service.recordAttemptCleanup(admin, input)).rejects.toThrow('Lease release transport failed');
        await service.recordAttemptCleanup(admin, input);
      } else {
        await expect(service.submitAiOutput(admin, { jobId: first.jobId, workerId: 'tab-a', callId: 'A1', text: JSON.stringify(inventory) })).rejects.toThrow('Lease release transport failed');
        await service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-a' });
      }
      await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'ai_call' });
    }
  });

  it('never reissues an unrecorded dispatch claim, even to the same holder or after expiry', async () => {
    const { service, other, inventoryJob, advance } = await setup();
    const first = await inventoryJob('first');
    const second = await inventoryJob('second');
    await service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-a' });
    await expect(service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'wait' });
    advance(AI_GENERATION_LIMITS.pumpLeaseMs + 1);
    await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'wait' });
    await expect(other.nextStep(admin, { jobId: first.jobId, workerId: 'tab-new' })).resolves.toMatchObject({ kind: 'wait' });
    // A delayed dispatch acknowledgement remains recordable after the heartbeat expired.
    await service.recordDispatch(admin, { jobId: first.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-late', provider: 'sandbox' });
    advance(AI_GENERATION_LIMITS.pumpLeaseMs + 1);
    await expect(other.nextStep(admin, { jobId: first.jobId, workerId: 'tab-new' })).resolves.toMatchObject({ kind: 'ai_call', attemptRef: 'attempt-late' });
  });

  it('releases a claim only when its holder proves dispatch never began', async () => {
    const { service, other, inventoryJob } = await setup();
    const job = await inventoryJob('first');
    await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    await expect(other.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-b', callId: 'A1', kind: 'failed', providerErrorCode: 'DISPATCH_NOT_STARTED' })).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });
    const abandoned = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: 'A1', kind: 'failed', providerErrorCode: 'DISPATCH_NOT_STARTED' });
    expect(abandoned.status).toBe('running');
    expect(abandoned.calls[0].status).toBe('pending');
    await expect(other.nextStep(admin, { jobId: job.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'ai_call', callId: 'A1' });
  });

  it('retains an uncertain dispatch or a timeout fence until the actual attempt is confirmed stopped', async () => {
    for (const kind of ['dispatch_unknown', 'timeout'] as const) {
      const { service, other, inventoryJob, advance } = await setup();
      const first = await inventoryJob('first');
      const second = await inventoryJob('second');
      await service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-a' });
      if (kind === 'timeout') await service.recordDispatch(admin, { jobId: first.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-1', provider: 'sandbox' });
      await service.reportAiFailure(admin, { jobId: first.jobId, workerId: 'tab-a', callId: 'A1', kind });
      advance(AI_GENERATION_LIMITS.pumpLeaseMs + 1);
      await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'wait' });
      if (kind === 'timeout') {
        await service.recordAttemptCleanup(admin, { jobId: first.jobId, callId: 'A1', attemptRef: 'attempt-1', state: 'confirmed' });
        await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'ai_call' });
      }
    }
  });

  it('does not release a cancelled claim before its late attempt can be recorded and cleaned up', async () => {
    const { service, other, inventoryJob, advance } = await setup();
    const first = await inventoryJob('first');
    const second = await inventoryJob('second');
    await service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-a' });
    await service.cancelJob(admin, first.jobId);
    advance(AI_GENERATION_LIMITS.pumpLeaseMs + 1);
    await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'wait' });
    await service.recordDispatch(admin, { jobId: first.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-late', provider: 'sandbox' });
    await service.recordAttemptCleanup(admin, { jobId: first.jobId, callId: 'A1', attemptRef: 'attempt-late', state: 'confirmed' });
    await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'ai_call' });
  });

  it('fences recorded legacy attempts that predate the room-lease collection', async () => {
    const { service, inventoryJob, store } = await setup(1);
    await inventoryJob('unused');
    const legacy = await inventoryJob('legacy');
    await store.update(admin.roomId, 'onboarding_ai_jobs', legacy.id, { calls: [{ ...legacy.calls[0], status: 'dispatched', attemptRef: 'attempt-legacy', provider: 'sandbox' }] });
    const next = await inventoryJob('next');
    await expect(service.nextStep(admin, { jobId: next.jobId, workerId: 'tab-new' })).resolves.toMatchObject({ kind: 'wait' });
    await expect(service.nextStep(admin, { jobId: legacy.jobId, workerId: 'tab-old' })).resolves.toMatchObject({ kind: 'ai_call', attemptRef: 'attempt-legacy' });
  });

  it('gives exactly one of two service instances a dispatch across inventory and Template 1/2', async () => {
    const { service, other, inventoryJob, templateJob, store } = await setup();
    const jobs = [await inventoryJob('first'), await templateJob('second'), await templateJob('third', 'advanced')];
    const steps = await Promise.all(jobs.map((job, index) => (index ? other : service).nextStep(admin, { jobId: job.jobId, workerId: 'tab-' + index })));
    expect(steps.map((step) => step.kind).sort()).toEqual(['ai_call', 'wait', 'wait']);
    expect((await store.query(admin.roomId, 'onboarding_ai_room_leases')).records).toHaveLength(1);
  });

  it('turns same-job races into wait instead of throwing or issuing a second dispatch', async () => {
    const { service, other, templateJob } = await setup();
    const job = await templateJob();
    const steps = await Promise.all([
      service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' }),
      other.nextStep(admin, { jobId: job.jobId, workerId: 'tab-b' }),
    ]);
    expect(steps.map((step) => step.kind).sort()).toEqual(['ai_call', 'wait']);
  });

  it('releases terminal inventory work for another job', async () => {
    const { service, other, inventoryJob } = await setup();
    const first = await inventoryJob('first');
    const second = await inventoryJob('second');
    await service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-a' });
    await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'wait' });
    await service.submitAiOutput(admin, { jobId: first.jobId, workerId: 'tab-a', callId: 'A1', text: JSON.stringify(inventory) });
    await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'ai_call' });
  });

  it('adopts an expired live attempt without unlocking any other job', async () => {
    const { service, other, inventoryJob, advance } = await setup();
    const first = await inventoryJob('first');
    const second = await inventoryJob('second');
    await service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-old' });
    await service.recordDispatch(admin, { jobId: first.jobId, workerId: 'tab-old', callId: 'A1', attemptRef: 'native-chat:s:m', provider: 'native_chat' });
    advance(AI_GENERATION_LIMITS.pumpLeaseMs + 1);
    await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'wait' });
    await expect(other.nextStep(admin, { jobId: first.jobId, workerId: 'tab-new' })).resolves.toMatchObject({ kind: 'ai_call', attemptRef: 'native-chat:s:m', provider: 'native_chat' });
    await expect(service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-old' })).resolves.toMatchObject({ kind: 'wait' });
    await expect(service.submitAiOutput(admin, { jobId: first.jobId, workerId: 'tab-old', callId: 'A1', text: '{}' })).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });
  });

  it('keeps explicit cancellation fenced until cleanup is confirmed, including after expiry', async () => {
    const { service, other, inventoryJob, advance } = await setup();
    const first = await inventoryJob('first');
    const second = await inventoryJob('second');
    await service.nextStep(admin, { jobId: first.jobId, workerId: 'tab-a' });
    await service.recordDispatch(admin, { jobId: first.jobId, workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-1', provider: 'sandbox' });
    await service.cancelJob(admin, first.jobId);
    advance(AI_GENERATION_LIMITS.pumpLeaseMs + 1);
    await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'wait' });
    await service.recordAttemptCleanup(admin, { jobId: first.jobId, callId: 'A1', attemptRef: 'attempt-1', state: 'unknown' });
    await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'wait' });
    await service.recordAttemptCleanup(admin, { jobId: first.jobId, callId: 'A1', attemptRef: 'attempt-1', state: 'confirmed' });
    await expect(other.nextStep(admin, { jobId: second.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'ai_call' });
    // A repeated old cleanup report cannot release the new holder's lease.
    await service.recordAttemptCleanup(admin, { jobId: first.jobId, callId: 'A1', attemptRef: 'attempt-1', state: 'confirmed' });
    const third = await inventoryJob('third');
    await expect(service.nextStep(admin, { jobId: third.jobId, workerId: 'tab-c' })).resolves.toMatchObject({ kind: 'wait' });
  });
});

describe('atomic room lease operations', () => {
  it('returns wait when App Platform wraps an optimistic conflict in a plain transport error', async () => {
    const store = new MemoryOnboardingStore();
    await acquireRoomAiLease(store, admin, { jobId: 'old', callId: 'A1', holderId: 'old', now: '2026-10-28T00:00:00.000Z' });
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation(async (room, collection, id, data, options) => {
      try { return await update(room, collection, id, data, options); }
      catch { throw new Error('mcpapp.db.update failed: OPERATION_CONFLICT'); }
    });
    const results = await Promise.all(['a', 'b'].map((holderId) => acquireRoomAiLease(store, admin, { jobId: holderId, callId: 'A1', holderId, now: '2026-10-28T00:02:00.000Z' })));
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  it('uses unique creation and expected-updated-at for concurrent expired takeovers', async () => {
    const store = new MemoryOnboardingStore();
    const now = '2026-10-28T00:00:00.000Z';
    const contenders = ['a', 'b'].map((id) => ({ jobId: 'job-' + id, callId: 'A1', holderId: 'tab-' + id, now }));
    const initial = await Promise.all(contenders.map((input) => acquireRoomAiLease(store, admin, input)));
    expect(initial.filter((result) => result.acquired)).toHaveLength(1);
    const expired = await Promise.all(contenders.map((input) => acquireRoomAiLease(store, admin, { ...input, holderId: input.holderId + '-new', now: '2026-10-28T00:02:00.000Z' })));
    expect(expired.filter((result) => result.acquired)).toHaveLength(1);
    expect((await store.query(admin.roomId, 'onboarding_ai_room_leases')).records).toHaveLength(1);
  });

  it('rejects stale refresh and ignores release unless job, call and holder all match', async () => {
    const store = new MemoryOnboardingStore();
    const input = { jobId: 'job-a', callId: 'A1', holderId: 'tab-a', now: '2026-10-28T00:00:00.000Z' };
    await acquireRoomAiLease(store, admin, input);
    for (const patch of [{ jobId: 'other' }, { callId: 'other' }, { holderId: 'other' }]) {
      await expect(refreshRoomAiLease(store, admin, { ...input, ...patch })).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });
      await releaseRoomAiLease(store, admin, { ...input, ...patch });
      await expect(acquireRoomAiLease(store, admin, { ...input, jobId: 'other-job', holderId: 'other-tab' })).resolves.toMatchObject({ acquired: false });
    }
    await refreshRoomAiLease(store, admin, { ...input, now: '2026-10-28T00:01:00.000Z' });
    await expect(acquireRoomAiLease(store, admin, { ...input, jobId: 'other-job', now: '2026-10-28T00:02:00.000Z' })).resolves.toMatchObject({ acquired: false });
    await releaseRoomAiLease(store, admin, input);
    await expect(acquireRoomAiLease(store, admin, { ...input, jobId: 'other-job' })).resolves.toMatchObject({ acquired: true });
    await expect(acquireRoomAiLease(store, { ...admin, roomId: 'room-b' }, input)).resolves.toMatchObject({ acquired: true });
  });
});

describe('bounded provider waiting and module recovery', () => {
  it('does not expire provider wait while a retry dispatch acknowledgement is still in flight', async () => {
    const { service, templateJob, inventoryJob, advance } = await setup();
    const job = await templateJob();
    const first = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (first.kind !== 'ai_call') throw new Error('Expected first call');
    await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: first.callId, kind: 'failed', providerErrorCode: 'PROJECT_BUSY' });
    advance(3_000);
    const retry = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (retry.kind !== 'ai_call') throw new Error('Expected retry');
    advance(120_000);
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-new' })).resolves.toMatchObject({ kind: 'wait' });
    const other = await inventoryJob('other');
    await expect(service.nextStep(admin, { jobId: other.jobId, workerId: 'tab-other' })).resolves.toMatchObject({ kind: 'wait' });
  });

  it('does not dispatch a queued room waiter after another module enters review', async () => {
    const { service, inventoryJob, templateJob } = await setup();
    const blocker = await inventoryJob('blocker');
    await service.nextStep(admin, { jobId: blocker.jobId, workerId: 'blocker' });
    const job = await templateJob();
    const edited = await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: job.outline!.modules.map((module) => ({ type: 'update', moduleLocalId: module.moduleLocalId, patch: { sourceSectionIds: ['source-1#s1'] } })) });
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'wait' });
    const run = edited.moduleRuns![1];
    await service.updateModuleLesson(admin, { jobId: job.jobId, moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion, module: { ...generatedTemplate.modules[1], localId: run.outline.moduleLocalId, frameKey: run.outline.frameKey, featureIds: run.outline.featureIds, questions: [] } });
    await service.submitAiOutput(admin, { jobId: blocker.jobId, workerId: 'blocker', callId: 'A1', text: JSON.stringify(inventory) });
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
  });

  it('gives a manual retry a fresh provider wait budget after the busy module is edited', async () => {
    const { service, templateJob, advance, now } = await setup();
    const job = await templateJob();
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (step.kind !== 'ai_call') throw new Error('Expected call');
    await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, kind: 'failed', providerErrorCode: 'PROJECT_BUSY' });
    const run = job.moduleRuns![0];
    const edited = await service.updateModuleLesson(admin, { jobId: job.jobId, moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion, module: { ...generatedTemplate.modules[0], localId: run.outline.moduleLocalId, frameKey: run.outline.frameKey, featureIds: run.outline.featureIds, questions: [] } });
    await service.approveModuleLesson(admin, { jobId: job.jobId, moduleLocalId: run.outline.moduleLocalId, expectedVersion: edited.moduleRuns![0].lessonVersion });
    advance(120_001);
    const question = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (question.kind !== 'ai_call') throw new Error('Expected question call');
    const waiting = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: question.callId, kind: 'failed', providerErrorCode: 'PROJECT_BUSY' });
    expect(waiting.moduleRuns![0].questionState).toBe('drafting');
    expect(waiting.providerWaitStartedAt).toBe(now());
  });

  it('shares the one-repair and one-transient-retry budgets between a module lesson and its questions', async () => {
    const { service, templateJob, advance } = await setup();
    const job = await templateJob();
    let step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (step.kind !== 'ai_call') throw new Error('Expected lesson');
    await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, kind: 'failed', providerErrorCode: 'MODEL_PROVIDER_UNAVAILABLE' });
    advance(3_000);
    step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (step.kind !== 'ai_call') throw new Error('Expected retry');
    await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, text: '{invalid' });
    step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (step.kind !== 'ai_call') throw new Error('Expected repair');
    const { localId: _id, frameKey: _frame, featureIds: _features, questions: _questions, ...lesson } = generatedTemplate.modules[0];
    const current = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, text: JSON.stringify({ ...lesson, flags: [] }) });
    await service.approveModuleLesson(admin, { jobId: job.jobId, moduleLocalId: current.moduleRuns![0].outline.moduleLocalId, expectedVersion: current.moduleRuns![0].lessonVersion });
    step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (step.kind !== 'ai_call') throw new Error('Expected questions');
    const failed = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, text: '{invalid-questions' });
    expect(failed.moduleRuns![0]).toMatchObject({ lessonState: 'approved', questionState: 'failed', transientRetries: 1, schemaRepairs: 1 });
    expect(failed.moduleRuns![0].lessonDraft).toEqual(current.moduleRuns![0].lessonDraft);
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
    expect(failed.calls).toHaveLength(4);
  });

  it('honors review of a later module before dispatching any earlier queued module', async () => {
    const { service, templateJob } = await setup();
    const job = await templateJob();
    const edited = await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: job.outline!.modules.map((module) => ({ type: 'update', moduleLocalId: module.moduleLocalId, patch: { sourceSectionIds: ['source-1#s1'] } })) });
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
    const run = edited.moduleRuns![1];
    await service.updateModuleLesson(admin, { jobId: job.jobId, moduleLocalId: run.outline.moduleLocalId, expectedVersion: run.lessonVersion, module: { ...generatedTemplate.modules[1], localId: run.outline.moduleLocalId, frameKey: run.outline.frameKey, featureIds: run.outline.featureIds, questions: [] } });
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
    expect((await service.getJob(admin, job.jobId)).calls).toHaveLength(0);
  });

  it('retries PROJECT_BUSY with increasing bounded delays and an unchanged original deadline', async () => {
    const { service, templateJob, advance, now } = await setup();
    const job = await templateJob();
    const waits: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
      if (step.kind === 'awaiting_admin') break;
      if (step.kind !== 'ai_call') throw new Error('Expected bounded retry');
      const waiting = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, kind: 'failed', providerErrorCode: 'PROJECT_BUSY' });
      expect(waiting.providerWaitStartedAt).toBe('2026-10-28T01:00:00.000Z');
      const delay = Date.parse(waiting.nextRetryAt!) - Date.parse(now());
      waits.push(delay);
      await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'wait' });
      advance(delay);
    }
    expect(waits).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 15_000]);
    expect((await service.getJob(admin, job.jobId)).moduleRuns![0]).toMatchObject({ lessonState: 'fallback_review', transientRetries: 0 });
  });

  it('persists PROJECT_BUSY backoff, never dispatches before it, then falls back at the wait bound', async () => {
    const { service, other, templateJob, advance, now } = await setup();
    const job = await templateJob();
    const before = job.moduleRuns!.slice(1);
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (step.kind !== 'ai_call') throw new Error('Expected lesson call');
    const waiting = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, kind: 'failed', providerErrorCode: 'PROJECT_BUSY' });
    expect(waiting.moduleRuns![0]).toMatchObject({ lessonState: 'drafting', providerWaitStartedAt: now(), nextRetryAt: '2026-10-28T01:00:03.000Z' });
    for (let index = 0; index < 10; index += 1) {
      await expect(other.nextStep(admin, { jobId: job.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'wait' });
    }
    expect((await service.getJob(admin, job.jobId)).moduleRuns![0].lessonAttempts).toBe(1);
    advance(120_001);
    await expect(other.nextStep(admin, { jobId: job.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
    const fallback = await service.getJob(admin, job.jobId);
    expect(fallback.moduleRuns![0]).toMatchObject({ lessonState: 'fallback_review', lessonProvenance: 'fallback' });
    expect(fallback.moduleRuns![0].nextRetryAt).toBeUndefined();
    expect(fallback.moduleRuns!.slice(1)).toEqual(before);
  });

  it('allows one automatic terminal transient retry and then falls back only the active module', async () => {
    const { service, templateJob, advance } = await setup();
    const job = await templateJob();
    const first = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (first.kind !== 'ai_call') throw new Error('Expected lesson call');
    const waiting = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: first.callId, kind: 'failed', providerErrorCode: 'MODEL_PROVIDER_UNAVAILABLE' });
    expect(waiting.moduleRuns![0]).toMatchObject({ lessonState: 'drafting', transientRetries: 1 });
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'wait' });
    advance(3_000);
    const retry = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (retry.kind !== 'ai_call') throw new Error('Expected retry');
    expect(retry.operationId).not.toBe(first.operationId);
    const fallback = await service.reportAiFailure(admin, { jobId: job.jobId, workerId: 'tab-a', callId: retry.callId, kind: 'failed', providerErrorCode: 'MODEL_PROVIDER_UNAVAILABLE' });
    expect(fallback.moduleRuns![0]).toMatchObject({ lessonState: 'fallback_review', transientRetries: 1, lessonAttempts: 2 });
    expect(fallback.moduleRuns!.slice(1)).toEqual(waiting.moduleRuns!.slice(1));
  });

  it('spends at most one schema repair before fallback and releases the room for another job', async () => {
    const { service, other, templateJob, inventoryJob } = await setup();
    const job = await templateJob();
    const otherJob = await inventoryJob('other');
    const first = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (first.kind !== 'ai_call') throw new Error('Expected lesson call');
    let current = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: first.callId, text: '{invalid' });
    expect(current.moduleRuns![0]).toMatchObject({ lessonState: 'drafting', schemaRepairs: 1 });
    const repair = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (repair.kind !== 'ai_call') throw new Error('Expected schema repair');
    expect(repair.prompt + repair.systemContext).toContain('{invalid');
    current = await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: repair.callId, text: '{still-invalid' });
    expect(current.moduleRuns![0]).toMatchObject({ lessonState: 'fallback_review', schemaRepairs: 1, lessonAttempts: 2 });
    await expect(other.nextStep(admin, { jobId: otherJob.jobId, workerId: 'tab-b' })).resolves.toMatchObject({ kind: 'ai_call' });
  });

  it('stops at lesson review even when later modules have usable sources', async () => {
    const { service, templateJob } = await setup();
    const job = await templateJob();
    await service.updateOutline(admin, { jobId: job.jobId, expectedRevision: 1, edits: job.outline!.modules.map((module) => ({ type: 'update', moduleLocalId: module.moduleLocalId, patch: { sourceSectionIds: ['source-1#s1'] } })) });
    await service.approveOutline(admin, { jobId: job.jobId, expectedRevision: 2 });
    const step = await service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' });
    if (step.kind !== 'ai_call') throw new Error('Expected lesson call');
    const { localId: _id, frameKey: _frame, featureIds: _features, questions: _questions, ...lesson } = generatedTemplate.modules[0];
    await service.submitAiOutput(admin, { jobId: job.jobId, workerId: 'tab-a', callId: step.callId, text: JSON.stringify({ ...lesson, flags: [] }) });
    await expect(service.nextStep(admin, { jobId: job.jobId, workerId: 'tab-a' })).resolves.toMatchObject({ kind: 'awaiting_admin' });
    expect((await service.getJob(admin, job.jobId)).calls).toHaveLength(1);
  });
});

describe('persisted pump reconnect', () => {
  it('refreshes an expired polling lease after a suspended tab before persisting the final deadline result', async () => {
    const { service, inventoryJob, advance, now } = await setup();
    const job = await inventoryJob('suspend');
    const api: AiPumpApi = {
      async adminAi<T>(action: string, args: Record<string, unknown>) {
        const result = action === 'next_step' ? await service.nextStep(admin, args as never)
          : action === 'record_dispatch' ? await service.recordDispatch(admin, args as never)
            : action === 'submit_ai_output' ? await service.submitAiOutput(admin, args as never)
              : await service.reportAiFailure(admin, args as never);
        return result as T;
      },
    };
    const gateway: AiGateway = {
      dispatch: vi.fn().mockResolvedValue({ attemptRef: 'attempt-1' }),
      status: vi.fn().mockResolvedValueOnce({ state: 'running' }).mockResolvedValue({ state: 'completed', text: JSON.stringify(inventory) }),
      cancel: vi.fn(),
    };
    await expect(pumpAiJob({ api, gateway, provider: 'sandbox', jobId: job.jobId, workerId: 'tab-a', nowMs: () => Date.parse(now()), sleep: async () => { advance(AI_GENERATION_LIMITS.maxPollMs + 1); } })).resolves.toMatchObject({ status: 'completed' });
    expect(gateway.status).toHaveBeenCalledTimes(2);
    expect(gateway.cancel).not.toHaveBeenCalled();
  });

  it('closes after record_dispatch, adopts through a new service, and stops before any later module', async () => {
    const { service, other, templateJob, advance } = await setup();
    const job = await templateJob();
    const controller = new AbortController();
    let activeService = service;
    const api: AiPumpApi = {
      async adminAi<T>(action: string, args: Record<string, unknown>) {
        let result: unknown;
        if (action === 'next_step') result = await activeService.nextStep(admin, args as never);
        else if (action === 'record_dispatch') {
          result = await activeService.recordDispatch(admin, args as never);
          controller.abort(new Error('modal closed'));
        } else if (action === 'submit_ai_output') result = await activeService.submitAiOutput(admin, args as never);
        else throw new Error('Unexpected action: ' + action);
        return result as T;
      },
    };
    const { localId: _id, frameKey: _frame, featureIds: _features, questions: _questions, ...lesson } = generatedTemplate.modules[0];
    const gateway: AiGateway = {
      dispatch: vi.fn().mockResolvedValue({ attemptRef: 'native-chat:s:exact' }),
      status: vi.fn().mockResolvedValue({ state: 'completed', text: JSON.stringify({ ...lesson, flags: [] }) }),
      cancel: vi.fn(),
    };
    await expect(pumpAiJob({ api, gateway, provider: 'native_chat', jobId: job.jobId, workerId: 'tab-old', signal: controller.signal })).rejects.toThrow('modal closed');
    expect(gateway.status).not.toHaveBeenCalled();
    expect((await service.getJob(admin, job.jobId)).calls).toHaveLength(1);
    activeService = other;
    advance(AI_GENERATION_LIMITS.pumpLeaseMs + 1);
    const result = await pumpAiJob({ api, gateway, provider: 'native_chat', jobId: job.jobId, workerId: 'tab-new' });
    expect(result.moduleRuns![0].lessonState).toBe('review_ready');
    expect(result.calls).toHaveLength(1);
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(gateway.status).toHaveBeenCalledWith('native-chat:s:exact', undefined);
    expect(gateway.cancel).not.toHaveBeenCalled();
  });
});
