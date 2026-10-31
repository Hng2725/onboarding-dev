import { describe, expect, it, vi } from 'vitest';

import type { AiJobRecord, AiModuleDraftRun, AiProvider, TemplateOutlineModule } from '../src/onboarding/contracts';
import {
  choosePumpProvider,
  planQuestionRecovery,
  pumpWithQuestionRecovery,
  shouldBoundNativeQuestionPoll,
  shouldUseNativeForPump,
} from '../src/ui/onboarding/ai/question-recovery';

const outline: TemplateOutlineModule = {
  moduleLocalId: 'module-access', frameKey: 't1-access', order: 1,
  title: 'Tài khoản', description: '', estimatedMinutes: 10,
  objectives: [], featureIds: [], sourceSectionIds: ['section-1'], responsibilityIndexes: [],
};

const lesson = {
  localId: outline.moduleLocalId, frameKey: outline.frameKey, title: outline.title,
  description: '', estimatedMinutes: 10, objectives: [], featureIds: [], questions: [],
  blocks: [{
    localId: 'block-1', kind: 'concept' as const, body: 'Bật xác thực đa yếu tố.',
    sourceRefs: [{ sectionId: 'section-1', quote: 'Bật xác thực đa yếu tố.' }],
  }],
};

function run(questionState: AiModuleDraftRun['questionState'], questionVersion = 1): AiModuleDraftRun {
  return {
    outline, outlineRevision: 1, lessonState: 'approved', lessonVersion: 1,
    approvedLessonVersion: 1, lessonDraft: lesson, lessonProvenance: 'fallback',
    questionState, questionVersion,
  };
}

function job(input: {
  readonly state?: AiModuleDraftRun['questionState'];
  readonly version?: number;
  readonly provider?: AiProvider;
  readonly callModuleId?: string;
  readonly callVersion?: number;
  readonly target?: 'lesson' | 'questions';
  readonly sourced?: boolean;
} = {}): AiJobRecord {
  const current = run(input.state ?? 'failed', input.version ?? 1);
  const lessonDraft = input.sourced === false
    ? { ...lesson, blocks: lesson.blocks.map((block) => ({ ...block, sourceRefs: [] })) }
    : lesson;
  return {
    id: 'row', roomId: 'room', jobId: 'job', kind: 'template', status: 'running',
    pipelineVersion: 'module_v2', templateKind: 'normal', promptVersion: 'test',
    calls: input.provider ? [{
      callId: 'call-1', stage: 'B', operationId: 'job:call-1', status: 'failed',
      provider: input.provider, attemptRef: input.provider === 'native_chat' ? 'native-chat:s:m' : 'sandbox-attempt',
      moduleLocalId: input.callModuleId ?? outline.moduleLocalId,
      moduleTarget: input.target ?? 'questions', moduleVersion: input.callVersion ?? current.questionVersion,
    }] : [],
    moduleRuns: [{ ...current, lessonDraft }], stageOutputs: {}, operationId: 'operation',
    createdBy: 'admin', createdAt: 'now', updatedAt: 'now',
  };
}

describe('question recovery planning', () => {
  it('does not carry a previous module Native preference into a new module question', () => {
    const moduleJob = job({ provider: 'native_chat' });
    expect(shouldUseNativeForPump(moduleJob, false, true)).toBe(false);
    expect(shouldUseNativeForPump(moduleJob, true, true)).toBe(true);
    expect(shouldUseNativeForPump({ ...moduleJob, kind: 'inventory' }, false, true)).toBe(true);
  });

  it('runs a chosen Native pass on Sandbox while a Native attempt still awaits cleanup proof', () => {
    const moduleJob = job({ provider: 'native_chat' });
    const choice = (patch: Partial<Parameters<typeof choosePumpProvider>[0]>) => choosePumpProvider({
      job: moduleJob, explicitlyPreferred: true, persistedPreference: true, nativeAvailable: true, nativeBlocked: false, ...patch,
    });
    expect(choice({})).toBe('native_chat');
    expect(choice({ nativeBlocked: true })).toBe('sandbox');
    expect(choice({ nativeAvailable: false })).toBe('sandbox');
    expect(choice({ explicitlyPreferred: false })).toBe('sandbox');
  });

  it('bounds explicit and adopted Native question attempts', () => {
    const queued = { ...job(), moduleRuns: [run('queued', 2)] };
    expect(shouldBoundNativeQuestionPoll(queued, true, true)).toBe(true);
    const native = job({ provider: 'native_chat', state: 'drafting' });
    const adopted = { ...native, calls: native.calls.map((call) => ({ ...call, status: 'dispatched' as const })) };
    expect(shouldBoundNativeQuestionPoll(adopted, false, false)).toBe(true);
    expect(shouldBoundNativeQuestionPoll(job({ provider: 'sandbox', state: 'drafting' }), false, false)).toBe(false);
  });

  it('uses the fallback for a failed questions call that never reached a provider', () => {
    const base = job({ provider: 'sandbox' });
    const unsent = { ...base, calls: base.calls.map(({ provider: _provider, attemptRef: _attempt, ...call }) => call) };
    expect(planQuestionRecovery(unsent, true)).toEqual({
      kind: 'use_fallback', moduleLocalId: outline.moduleLocalId, expectedVersion: 1,
    });
  });

  it('retries a failed Sandbox question once with Native when available', () => {
    expect(planQuestionRecovery(job({ provider: 'sandbox' }), true)).toEqual({
      kind: 'retry_native', moduleLocalId: outline.moduleLocalId, expectedVersion: 1,
    });
  });

  it('uses fallback after Native failure or immediately when Native is unavailable', () => {
    expect(planQuestionRecovery(job({ provider: 'native_chat' }), true)).toEqual({
      kind: 'use_fallback', moduleLocalId: outline.moduleLocalId, expectedVersion: 1,
    });
    expect(planQuestionRecovery(job({ provider: 'sandbox' }), false)).toEqual({
      kind: 'use_fallback', moduleLocalId: outline.moduleLocalId, expectedVersion: 1,
    });
  });

  it('ignores unrelated, completed, stale-version, lesson, and source-free failures', () => {
    expect(planQuestionRecovery(job({ provider: 'sandbox', state: 'approved' }), true)).toBeNull();
    expect(planQuestionRecovery(job({ provider: 'sandbox', callModuleId: 'other' }), true)).toBeNull();
    expect(planQuestionRecovery(job({ provider: 'sandbox', callVersion: 0 }), true)).toBeNull();
    expect(planQuestionRecovery(job({ provider: 'sandbox', target: 'lesson' }), true)).toBeNull();
    expect(planQuestionRecovery(job({ provider: 'sandbox', sourced: false }), true)).toBeNull();
  });

  it('uses persisted Native history after reload instead of retrying Native again', () => {
    const persisted = job({ provider: 'native_chat' });
    expect(planQuestionRecovery(structuredClone(persisted), true)?.kind).toBe('use_fallback');
  });
});

describe('bounded question recovery orchestration', () => {
  it('runs Sandbox, retries with Native once, then creates fallback without a third dispatch', async () => {
    const sandboxFailed = job({ provider: 'sandbox', version: 1 });
    const nativeQueued = { ...sandboxFailed, moduleRuns: [run('queued', 2)] };
    const nativeFailed = job({ provider: 'native_chat', version: 2, callVersion: 2 });
    const fallbackReady = { ...nativeFailed, moduleRuns: [{ ...run('review_ready', 3), questionProvenance: 'fallback' as const }] };
    const providers: boolean[] = [];
    const pumpOnce = vi.fn(async (_job: AiJobRecord, preferNative: boolean, _recovering?: string) => {
      providers.push(preferNative);
      return preferNative ? nativeFailed : sandboxFailed;
    });
    const runAction = vi.fn(async (action: string) => action === 'retry_module'
      ? { job: nativeQueued }
      : { job: fallbackReady });

    const result = await pumpWithQuestionRecovery({
      initialJob: sandboxFailed, nativeAvailable: true, initialPreferNative: false, pumpOnce, runAction,
    });

    expect(result).toBe(fallbackReady);
    expect(providers).toEqual([false, true]);
    // Only the Native retry pass is scoped to the module whose questions it recovers.
    expect(pumpOnce.mock.calls.map((call) => call[2])).toEqual([undefined, outline.moduleLocalId]);
    expect(runAction.mock.calls.map(([action]) => action)).toEqual(['retry_module', 'use_question_fallback']);
    expect(runAction).toHaveBeenNthCalledWith(1, 'retry_module', {
      moduleLocalId: outline.moduleLocalId, target: 'questions', expectedVersion: 1,
    });
    expect(runAction).toHaveBeenNthCalledWith(2, 'use_question_fallback', {
      moduleLocalId: outline.moduleLocalId, expectedVersion: 2,
    });
  });
});
