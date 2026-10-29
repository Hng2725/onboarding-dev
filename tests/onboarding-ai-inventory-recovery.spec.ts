import { describe, expect, it } from 'vitest';

import type { AiCallRecord, AiJobRecord } from '../src/onboarding/contracts';
import {
  isInventoryNativeFallbackCandidate,
  pumpWithInventoryRecovery,
} from '../src/ui/onboarding/ai/inventory-recovery';

function failedCall(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    callId: 'A1',
    stage: 'A',
    operationId: 'job-inventory:A1',
    status: 'failed',
    provider: 'sandbox',
    attemptRef: 'sandbox-attempt-1',
    providerErrorCode: 'worker_failed',
    errors: ['Worker exited with code 1'],
    ...overrides,
  };
}

function inventoryJob(overrides: Partial<AiJobRecord> = {}): AiJobRecord {
  return {
    jobId: 'job-inventory',
    roomId: 'room-1',
    kind: 'inventory',
    status: 'failed',
    promptVersion: 'v1',
    calls: [failedCall()],
    stageOutputs: {},
    errorCode: 'AI_FAILED',
    errorMessage: 'Worker exited with code 1',
    operationId: 'operation-1',
    createdBy: 'admin-1',
    createdAt: '2026-10-29T08:17:00.000Z',
    updatedAt: '2026-10-29T08:17:11.446Z',
    ...overrides,
  };
}

describe('inventory Native fallback eligibility', () => {
  it.each([
    failedCall({ providerErrorCode: 'worker_failed', errors: ['Worker exited with code 1'] }),
    failedCall({ providerErrorCode: 'WORKER_FAILED', errors: ['Sandbox worker failed'] }),
    failedCall({ providerErrorCode: undefined, errors: ['Worker exited with code 137'] }),
  ])('accepts a terminal Sandbox worker crash', (call) => {
    expect(isInventoryNativeFallbackCandidate(inventoryJob({ calls: [call] }))).toBe(true);
  });

  it('rejects a job whose history already contains a Native attempt', () => {
    const native = failedCall({
      callId: 'A1-retry1',
      provider: 'native_chat',
      attemptRef: 'native-chat:session-1:message-1',
    });

    expect(isInventoryNativeFallbackCandidate(inventoryJob({
      calls: [failedCall(), native],
    }))).toBe(false);
  });

  it('uses the newest terminal call so invalid output cannot reuse an older worker crash', () => {
    const invalid = failedCall({
      callId: 'A1-retry1',
      status: 'invalid',
      providerErrorCode: undefined,
      errors: ['inventory.items: expected an array'],
    });

    expect(isInventoryNativeFallbackCandidate(inventoryJob({
      errorCode: 'AI_OUTPUT_INVALID',
      errorMessage: 'inventory.items: expected an array',
      calls: [failedCall(), invalid],
    }))).toBe(false);
  });

  it.each([
    inventoryJob({ kind: 'template' }),
    inventoryJob({ status: 'cancelled' }),
    inventoryJob({
      errorCode: 'AI_OUTPUT_INVALID',
      errorMessage: 'Output did not match schema',
      calls: [failedCall({ providerErrorCode: 'AI_OUTPUT_INVALID', errors: ['Output did not match schema'] })],
    }),
    inventoryJob({
      calls: [failedCall({ providerErrorCode: 'AI_PERMISSION_DENIED', errors: ['Permission denied'] })],
    }),
    inventoryJob({
      calls: [failedCall({ providerErrorCode: 'SOURCE_NO_TEXT', errors: ['No text found'] })],
    }),
  ])('rejects failures that are not an eligible inventory worker crash', (job) => {
    expect(isInventoryNativeFallbackCandidate(job)).toBe(false);
  });
});

describe('bounded inventory Native recovery', () => {
  const running = inventoryJob({ status: 'running', errorCode: undefined, errorMessage: undefined });
  const failed = inventoryJob();
  const retried = inventoryJob({
    status: 'running',
    errorCode: undefined,
    errorMessage: undefined,
    calls: [
      failedCall(),
      failedCall({
        callId: 'A1-retry1',
        status: 'pending',
        provider: undefined,
        attemptRef: undefined,
        providerErrorCode: undefined,
        errors: undefined,
      }),
    ],
  });
  const completed = inventoryJob({ status: 'completed', errorCode: undefined, errorMessage: undefined });

  it('returns the successful first provider pass without recovery work', async () => {
    const events: string[] = [];

    const result = await pumpWithInventoryRecovery({
      initialJob: running,
      initialPreferNative: false,
      nativeAvailable: true,
      pumpOnce: async (_job, preferNative) => {
        events.push(preferNative ? 'pump:native' : 'pump:sandbox');
        return completed;
      },
      reloadJob: async () => { events.push('reload'); return failed; },
      retryJob: async () => { events.push('retry'); return retried; },
    });

    expect(result).toBe(completed);
    expect(events).toEqual(['pump:sandbox']);
  });

  it('reloads a crashed Sandbox job and completes one Native retry', async () => {
    const events: string[] = [];
    const sandboxError = new Error('Worker exited with code 1');

    const result = await pumpWithInventoryRecovery({
      initialJob: running,
      initialPreferNative: false,
      nativeAvailable: true,
      pumpOnce: async (_job, preferNative) => {
        events.push(preferNative ? 'pump:native' : 'pump:sandbox');
        if (!preferNative) throw sandboxError;
        return completed;
      },
      reloadJob: async (jobId) => { events.push('reload:' + jobId); return failed; },
      retryJob: async (jobId) => { events.push('retry:' + jobId); return retried; },
    });

    expect(result).toBe(completed);
    expect(events).toEqual([
      'pump:sandbox',
      'reload:job-inventory',
      'retry:job-inventory',
      'pump:native',
    ]);
  });

  it('leaves a crashed Sandbox job untouched when Native is unavailable', async () => {
    const events: string[] = [];
    const sandboxError = new Error('Worker exited with code 1');

    await expect(pumpWithInventoryRecovery({
      initialJob: running,
      initialPreferNative: false,
      nativeAvailable: false,
      pumpOnce: async () => { events.push('pump:sandbox'); throw sandboxError; },
      reloadJob: async () => { events.push('reload'); return failed; },
      retryJob: async () => { events.push('retry'); return retried; },
    })).rejects.toBe(sandboxError);

    expect(events).toEqual(['pump:sandbox']);
  });

  it('does not retry an ineligible persisted failure', async () => {
    const events: string[] = [];
    const providerError = new Error('Permission denied');
    const permissionFailure = inventoryJob({
      errorMessage: 'Permission denied',
      calls: [failedCall({ providerErrorCode: 'AI_PERMISSION_DENIED', errors: ['Permission denied'] })],
    });

    await expect(pumpWithInventoryRecovery({
      initialJob: running,
      initialPreferNative: false,
      nativeAvailable: true,
      pumpOnce: async () => { events.push('pump:sandbox'); throw providerError; },
      reloadJob: async () => { events.push('reload'); return permissionFailure; },
      retryJob: async () => { events.push('retry'); return retried; },
    })).rejects.toBe(providerError);

    expect(events).toEqual(['pump:sandbox', 'reload']);
  });

  it('stops after a failed Native fallback without a third provider pass', async () => {
    const events: string[] = [];
    const sandboxError = new Error('Worker exited with code 1');
    const nativeError = new Error('Native AI failed');

    await expect(pumpWithInventoryRecovery({
      initialJob: running,
      initialPreferNative: false,
      nativeAvailable: true,
      pumpOnce: async (_job, preferNative) => {
        events.push(preferNative ? 'pump:native' : 'pump:sandbox');
        if (!preferNative) throw sandboxError;
        throw nativeError;
      },
      reloadJob: async () => { events.push('reload'); return failed; },
      retryJob: async () => { events.push('retry'); return retried; },
    })).rejects.toBe(nativeError);

    expect(events).toEqual(['pump:sandbox', 'reload', 'retry', 'pump:native']);
  });

  it('never creates a second fallback for a job already using Native', async () => {
    const events: string[] = [];
    const nativeError = new Error('Native AI failed');

    await expect(pumpWithInventoryRecovery({
      initialJob: retried,
      initialPreferNative: true,
      nativeAvailable: true,
      pumpOnce: async (_job, preferNative) => {
        events.push(preferNative ? 'pump:native' : 'pump:sandbox');
        throw nativeError;
      },
      reloadJob: async () => { events.push('reload'); return failed; },
      retryJob: async () => { events.push('retry'); return retried; },
    })).rejects.toBe(nativeError);

    expect(events).toEqual(['pump:native']);
  });

  it('adapts get_job and retry_job responses without replacing call history', async () => {
    const actions: Array<{ action: string; jobId: string }> = [];
    const completedRetry = inventoryJob({
      status: 'completed',
      errorCode: undefined,
      errorMessage: undefined,
      calls: [
        failedCall(),
        failedCall({
          callId: 'A1-retry1',
          status: 'completed',
          provider: 'native_chat',
          attemptRef: 'native-chat:session-1:message-1',
          providerErrorCode: undefined,
          errors: undefined,
        }),
      ],
    });
    const adminAi = async (action: 'get_job' | 'retry_job', jobId: string) => {
      actions.push({ action, jobId });
      return { job: action === 'get_job' ? failed : retried };
    };

    const result = await pumpWithInventoryRecovery({
      initialJob: running,
      initialPreferNative: false,
      nativeAvailable: true,
      pumpOnce: async (_job, preferNative) => {
        if (!preferNative) throw new Error('Worker exited with code 1');
        return completedRetry;
      },
      reloadJob: async (jobId) => (await adminAi('get_job', jobId)).job,
      retryJob: async (jobId) => (await adminAi('retry_job', jobId)).job,
    });

    expect(actions).toEqual([
      { action: 'get_job', jobId: 'job-inventory' },
      { action: 'retry_job', jobId: 'job-inventory' },
    ]);
    expect(result.calls.map((call) => call.callId)).toEqual(['A1', 'A1-retry1']);
    expect(result.calls.map((call) => call.provider)).toEqual(['sandbox', 'native_chat']);
  });

  it('does not queue a retry when the modal closes during the recovery lookup', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    let markReloadStarted!: () => void;
    let resolveReload!: (job: AiJobRecord) => void;
    const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
    const reloadResult = new Promise<AiJobRecord>((resolve) => { resolveReload = resolve; });

    const operation = pumpWithInventoryRecovery({
      initialJob: running,
      initialPreferNative: false,
      nativeAvailable: true,
      signal: controller.signal,
      pumpOnce: async () => { events.push('pump:sandbox'); throw new Error('Worker exited with code 1'); },
      reloadJob: async () => { events.push('reload'); markReloadStarted(); return reloadResult; },
      retryJob: async () => { events.push('retry'); return retried; },
    });

    await reloadStarted;
    controller.abort();
    resolveReload(failed);

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual(['pump:sandbox', 'reload']);
  });

  it('does not dispatch Native when the modal closes while the retry is queued', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    let markRetryStarted!: () => void;
    let resolveRetry!: (job: AiJobRecord) => void;
    const retryStarted = new Promise<void>((resolve) => { markRetryStarted = resolve; });
    const retryResult = new Promise<AiJobRecord>((resolve) => { resolveRetry = resolve; });

    const operation = pumpWithInventoryRecovery({
      initialJob: running,
      initialPreferNative: false,
      nativeAvailable: true,
      signal: controller.signal,
      pumpOnce: async (_job, preferNative) => {
        events.push(preferNative ? 'pump:native' : 'pump:sandbox');
        throw new Error('Worker exited with code 1');
      },
      reloadJob: async () => { events.push('reload'); return failed; },
      retryJob: async () => { events.push('retry'); markRetryStarted(); return retryResult; },
    });

    await retryStarted;
    controller.abort();
    resolveRetry(retried);

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual(['pump:sandbox', 'reload', 'retry']);
  });
});
