import { describe, expect, it, vi } from 'vitest';

import { AiGatewayError, type AiGateway } from '../src/ui/onboarding/ai/ai-gateway-sandbox';
import type { AiJobRecord } from '../src/onboarding/contracts';
import {
  AI_PUMP_STALLED,
  AiPumpStalledError,
  isTransportFailure,
  jobChangeApplied,
  pumpAiJob,
  reconcileJobAfterTransportFailure,
  TRANSIENT_RETRY_DELAYS_MS,
  withTransientRetry,
} from '../src/ui/onboarding/ai/ai-pump';

describe('AI browser pump', () => {
  it.each(['changed', 'closed'] as const)('relinquishes a new unused heartbeat grant when polling is %s', async (outcome) => {
    let time = 0;
    const controller = new AbortController();
    const adminAi = vi.fn()
      .mockResolvedValueOnce({ kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p', attemptRef: 'attempt-1' })
      .mockImplementationOnce(async () => {
        if (outcome === 'closed') controller.abort(new Error('closed'));
        return { kind: 'ai_call', callId: 'A2', operationId: 'job-1:A2', prompt: 'p' };
      })
      .mockResolvedValue({ jobId: 'job-1', status: 'running' });
    const gateway: AiGateway = { dispatch: vi.fn(), status: vi.fn().mockResolvedValue({ state: 'running' }), cancel: vi.fn() };
    await expect(pumpAiJob({
      api: { adminAi }, gateway, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a', signal: controller.signal,
      nowMs: () => time, sleep: async () => { time += 45_000; },
    })).rejects.toThrow(outcome === 'closed' ? 'closed' : 'AI job step changed while polling.');
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', {
      jobId: 'job-1', workerId: 'tab-a', callId: 'A2', kind: 'failed', providerErrorCode: 'DISPATCH_NOT_STARTED',
    });
    expect(gateway.dispatch).not.toHaveBeenCalled();
    expect(gateway.cancel).not.toHaveBeenCalled();
  });

  it('releases a dispatch claim when the gateway proves it stopped before contacting the provider', async () => {
    const controller = new AbortController();
    const adminAi = vi.fn().mockResolvedValueOnce({ kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p' }).mockResolvedValue({ jobId: 'job-1', status: 'running' });
    const gateway: AiGateway = {
      dispatch: vi.fn(async () => { controller.abort(new Error('closed')); throw new AiGatewayError('DISPATCH_NOT_STARTED', 'Closed before dispatch'); }),
      status: vi.fn(), cancel: vi.fn(),
    };
    await expect(pumpAiJob({ api: { adminAi }, gateway, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-a', signal: controller.signal })).rejects.toThrow('closed');
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({ kind: 'failed', providerErrorCode: 'DISPATCH_NOT_STARTED' }));
    expect(gateway.cancel).not.toHaveBeenCalled();
  });

  it('reports a known permission rejection as terminal instead of leaving an uncertain dispatch fence', async () => {
    const adminAi = vi.fn().mockResolvedValueOnce({ kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p' }).mockResolvedValue({ jobId: 'job-1', status: 'failed' });
    const gateway: AiGateway = { dispatch: vi.fn().mockRejectedValue(new AiGatewayError('AI_PERMISSION_DENIED', 'Permission denied')), status: vi.fn() };
    await expect(pumpAiJob({ api: { adminAi }, gateway, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a' })).rejects.toThrow('Permission denied');
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({ kind: 'failed', providerErrorCode: 'AI_PERMISSION_DENIED' }));
  });

  it.each([
    ['sandbox', 'AI_PERMISSION_DENIED'],
    ['native_chat', 'DISPATCH_NOT_STARTED'],
  ] as const)('persists %s on a terminal pre-dispatch %s failure and returns the recoverable job', async (provider, code) => {
    const recoverable = { jobId: 'job-1', status: 'running', calls: [{ callId: 'A1', status: 'failed', provider }] };
    const adminAi = vi.fn()
      .mockResolvedValueOnce({ kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p', moduleTarget: 'questions' })
      .mockResolvedValueOnce(recoverable)
      .mockResolvedValueOnce({ kind: 'awaiting_admin', job: recoverable });
    const gateway: AiGateway = {
      dispatch: vi.fn().mockRejectedValue(new AiGatewayError(code, 'Provider unavailable before dispatch')),
      status: vi.fn(),
    };

    await expect(pumpAiJob({
      api: { adminAi }, gateway, provider, jobId: 'job-1', workerId: 'tab-a',
    })).resolves.toEqual(recoverable);
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({
      kind: 'failed',
      provider,
      providerErrorCode: code,
    }));
  });

  it('releases a proven no-dispatch lesson call even when the job also has active questions', async () => {
    const released = { jobId: 'job-1', status: 'running' };
    const adminAi = vi.fn()
      .mockResolvedValueOnce({ kind: 'ai_call', callId: 'lesson-2', operationId: 'job-1:lesson-2', prompt: 'p', moduleTarget: 'lesson' })
      .mockResolvedValueOnce(released)
      .mockResolvedValueOnce({ kind: 'awaiting_admin', job: released });
    const gateway: AiGateway = {
      dispatch: vi.fn().mockRejectedValue(new AiGatewayError('DISPATCH_NOT_STARTED', 'Context upload failed')),
      status: vi.fn(),
    };

    await expect(pumpAiJob({
      api: { adminAi }, gateway, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-a',
    })).rejects.toThrow('Context upload failed');
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.not.objectContaining({ provider: 'native_chat' }));
  });

  it('returns awaiting_admin without dispatching or polling', async () => {
    const job = { jobId: 'job-1', status: 'running' };
    const adminAi = vi.fn().mockResolvedValue({ kind: 'awaiting_admin', job });
    const gateway: AiGateway = { dispatch: vi.fn(), status: vi.fn() };
    await expect(pumpAiJob({ api: { adminAi }, gateway, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a' })).resolves.toEqual(job);
    expect(gateway.dispatch).not.toHaveBeenCalled();
    expect(gateway.status).not.toHaveBeenCalled();
    expect(adminAi).toHaveBeenCalledTimes(1);
  });

  it('closes after recording without cancelling and reconnects to the same provider attempt', async () => {
    const controller = new AbortController();
    let recorded = false;
    let submitted = false;
    const adminAi = vi.fn(async (action: string) => {
      if (action === 'next_step') return submitted
        ? { kind: 'awaiting_admin', job: { jobId: 'job-1', status: 'running' } }
        : { kind: 'ai_call', callId: 'module-1', operationId: 'job-1:module-1', prompt: 'p', ...(recorded ? { attemptRef: 'native-chat:s:m', provider: 'native_chat' } : {}) };
      if (action === 'record_dispatch') { recorded = true; controller.abort(new Error('closed')); }
      if (action === 'submit_ai_output') submitted = true;
      return { jobId: 'job-1', status: 'running' };
    });
    const gateway: AiGateway = {
      dispatch: vi.fn().mockResolvedValue({ attemptRef: 'native-chat:s:m' }),
      status: vi.fn().mockResolvedValue({ state: 'completed', text: '{}' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    await expect(pumpAiJob({ api: { adminAi }, gateway, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-a', signal: controller.signal })).rejects.toThrow('closed');
    expect(gateway.cancel).not.toHaveBeenCalled();
    expect(gateway.status).not.toHaveBeenCalled();
    expect(adminAi.mock.calls.filter(([action]) => action === 'next_step')).toHaveLength(1);
    await pumpAiJob({ api: { adminAi }, gateway, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-new' });
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(gateway.status).toHaveBeenCalledWith('native-chat:s:m', undefined);
  });

  it('does not dispatch when closing during next_step or submit output after closing during status', async () => {
    for (const closeDuring of ['next_step', 'status']) {
      const controller = new AbortController();
      const adminAi = vi.fn(async () => {
        if (closeDuring === 'next_step') controller.abort(new Error('closed'));
        return { kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p', ...(closeDuring === 'status' ? { attemptRef: 'attempt-1' } : {}) };
      });
      const gateway: AiGateway = {
        dispatch: vi.fn(),
        status: vi.fn(async () => { controller.abort(new Error('closed')); return { state: 'completed', text: '{}' }; }),
        cancel: vi.fn(),
      };
      await expect(pumpAiJob({ api: { adminAi }, gateway, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a', signal: controller.signal })).rejects.toThrow('closed');
      expect(gateway.dispatch).not.toHaveBeenCalled();
      expect(gateway.cancel).not.toHaveBeenCalled();
      if (closeDuring === 'next_step') {
        expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({ providerErrorCode: 'DISPATCH_NOT_STARTED' }));
      } else expect(adminAi).toHaveBeenCalledTimes(1);
    }
  });

  it('reports PROJECT_BUSY distinctly and sleeps until persisted nextRetryAt', async () => {
    let now = Date.parse('2026-10-28T00:00:00.000Z');
    const waiting = { jobId: 'job-1', status: 'running', nextRetryAt: '2026-10-28T00:00:12.000Z' };
    const adminAi = vi.fn()
      .mockResolvedValueOnce({ kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p' })
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce({ kind: 'wait', job: waiting })
      .mockResolvedValueOnce({ kind: 'awaiting_admin', job: { jobId: 'job-1', status: 'running' } });
    const gateway: AiGateway = { dispatch: vi.fn().mockRejectedValue(new AiGatewayError('PROJECT_BUSY', 'Another request in this project is still running')), status: vi.fn() };
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    await pumpAiJob({ api: { adminAi }, gateway, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-a', nowMs: () => now, sleep });
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({ kind: 'failed', providerErrorCode: 'PROJECT_BUSY' }));
    expect(sleep).toHaveBeenCalledWith(12_000, undefined);
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });

  it('persists a definitive busy rejection received while closing without starting later work', async () => {
    const controller = new AbortController();
    const adminAi = vi.fn()
      .mockResolvedValueOnce({ kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p' })
      .mockResolvedValue({ jobId: 'job-1', status: 'running' });
    const gateway: AiGateway = {
      dispatch: vi.fn(async () => {
        controller.abort(new Error('closed'));
        throw new AiGatewayError('PROJECT_BUSY', 'Another request in this project is still running');
      }),
      status: vi.fn(), cancel: vi.fn(),
    };
    await expect(pumpAiJob({ api: { adminAi }, gateway, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-a', signal: controller.signal })).rejects.toThrow('closed');
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({ callId: 'A1', kind: 'failed', providerErrorCode: 'PROJECT_BUSY' }));
    expect(adminAi).toHaveBeenCalledTimes(2);
    expect(gateway.cancel).not.toHaveBeenCalled();
    expect(gateway.status).not.toHaveBeenCalled();
  });

  it('dispatches, records, polls, submits, and stops only when the server says done', async () => {
    const adminAi = vi.fn()
      .mockResolvedValueOnce({
        kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1',
        prompt: 'prompt', systemContext: 'context',
      })
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'completed' })
      .mockResolvedValueOnce({ kind: 'done', job: { jobId: 'job-1', status: 'completed' } });
    const gateway: AiGateway = {
      dispatch: vi.fn().mockResolvedValue({ attemptRef: 'attempt-1' }),
      status: vi.fn().mockResolvedValue({ state: 'completed', text: '{"ok":true}' }),
    };

    await expect(pumpAiJob({
      api: { adminAi },
      gateway,
      provider: 'sandbox',
      jobId: 'job-1',
      workerId: 'tab-a',
      sleep: vi.fn().mockResolvedValue(undefined),
    })).resolves.toMatchObject({ jobId: 'job-1', status: 'completed' });
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(adminAi).toHaveBeenNthCalledWith(2, 'record_dispatch', {
      jobId: 'job-1', workerId: 'tab-a', callId: 'A1', attemptRef: 'attempt-1', provider: 'sandbox',
    });
    expect(adminAi).toHaveBeenNthCalledWith(3, 'submit_ai_output', {
      jobId: 'job-1', workerId: 'tab-a', callId: 'A1', text: '{"ok":true}',
    });
  });

  it('resumes an existing attempt without dispatching again', async () => {
    const adminAi = vi.fn()
      .mockResolvedValueOnce({
        kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1',
        prompt: 'prompt', systemContext: 'context', attemptRef: 'attempt-existing',
      })
      .mockResolvedValueOnce({ status: 'completed' })
      .mockResolvedValueOnce({ kind: 'done', job: { jobId: 'job-1', status: 'completed' } });
    const gateway: AiGateway = {
      dispatch: vi.fn(),
      status: vi.fn().mockResolvedValue({ state: 'completed', text: '{"ok":true}' }),
    };

    await pumpAiJob({
      api: { adminAi }, gateway, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a',
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it('still records and stops an attempt whose dispatch finished after the user cancelled', async () => {
    const controller = new AbortController();
    const adminAi = vi.fn(async (action: string) => {
      if (action === 'next_step') return { kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p' };
      return { jobId: 'job-1', status: 'cancelled' };
    });
    const gateway: AiGateway = {
      dispatch: vi.fn(async () => {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        return { attemptRef: 'native-chat:s:late' };
      }),
      status: vi.fn().mockResolvedValueOnce({ state: 'running' }).mockResolvedValue({ state: 'cancelled' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    await expect(pumpAiJob({
      api: { adminAi }, gateway, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-a',
      signal: controller.signal, sleep: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(adminAi).toHaveBeenCalledWith('record_dispatch', expect.objectContaining({ attemptRef: 'native-chat:s:late' }));
    expect(gateway.cancel).toHaveBeenCalledWith('native-chat:s:late', undefined);
    expect(adminAi).toHaveBeenCalledWith('record_attempt_cleanup', expect.objectContaining({ attemptRef: 'native-chat:s:late', state: 'confirmed' }));
  });

  it('adopts a recorded attempt through its persisted provider instead of the default gateway', async () => {
    const adminAi = vi.fn()
      .mockResolvedValueOnce({
        kind: 'ai_call', callId: 'B-lessons', operationId: 'job-1:B-lessons', prompt: 'p',
        attemptRef: 'native-chat:s:m', provider: 'native_chat',
      })
      .mockResolvedValueOnce({ jobId: 'job-1', status: 'running' })
      .mockResolvedValueOnce({ kind: 'done', job: { jobId: 'job-1', status: 'completed' } });
    const sandbox: AiGateway = { dispatch: vi.fn(), status: vi.fn() };
    const native: AiGateway = {
      dispatch: vi.fn(),
      status: vi.fn().mockResolvedValue({ state: 'completed', text: '{}' }),
    };
    const gatewayFor = vi.fn((provider: string) => provider === 'native_chat' ? native : sandbox);

    await pumpAiJob({
      api: { adminAi }, gateway: sandbox, provider: 'sandbox', gatewayFor,
      jobId: 'job-1', workerId: 'tab-a', sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(gatewayFor).toHaveBeenCalledWith('native_chat');
    expect(native.status).toHaveBeenCalledWith('native-chat:s:m', undefined);
    expect(sandbox.status).not.toHaveBeenCalled();
    expect(sandbox.dispatch).not.toHaveBeenCalled();
    expect(native.dispatch).not.toHaveBeenCalled();
  });

  it('keeps the 15-minute deadline of an adopted attempt instead of restarting it after refresh', async () => {
    const startedAt = '2026-10-24T05:00:00.000Z';
    let now = Date.parse(startedAt) + 15 * 60_000 - 1_000;
    const adminAi = vi.fn(async (action: string) => {
      if (action === 'next_step') {
        return {
          kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p',
          attemptRef: 'attempt-1', provider: 'sandbox', startedAt,
        };
      }
      return { jobId: 'job-1', status: 'failed' };
    });
    const gateway: AiGateway = {
      dispatch: vi.fn(),
      status: vi.fn().mockResolvedValue({ state: 'running' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    await expect(pumpAiJob({
      api: { adminAi }, gateway, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-new',
      nowMs: () => now,
      sleep: vi.fn(async (milliseconds: number) => { now += milliseconds; }),
    })).rejects.toThrow('AI polling timed out.');
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({ kind: 'timeout' }));
    expect(gateway.status).toHaveBeenCalledTimes(2);
    expect(gateway.cancel).not.toHaveBeenCalled();
  });

  it('honors a shorter polling deadline for bounded Native question recovery', async () => {
    const startedAt = '2026-10-24T05:00:00.000Z';
    const now = Date.parse(startedAt) + 90_001;
    const adminAi = vi.fn(async (action: string) => {
      if (action === 'next_step') {
        return {
          kind: 'ai_call', callId: 'B-questions', operationId: 'job-1:B-questions', prompt: 'p',
          attemptRef: 'native-chat:s:m', provider: 'native_chat', startedAt,
        };
      }
      return { jobId: 'job-1', status: 'failed' };
    });
    const gateway: AiGateway = {
      dispatch: vi.fn(),
      status: vi.fn().mockResolvedValue({ state: 'running' }),
    };

    await expect(pumpAiJob({
      api: { adminAi }, gateway, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-new',
      maxPollMs: 90_000, nowMs: () => now, sleep: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('AI polling timed out.');
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({
      callId: 'B-questions', kind: 'timeout',
    }));
    expect(gateway.status).toHaveBeenCalledOnce();
  });

  it('submits a completion found by the final deadline check instead of cancelling it', async () => {
    const startedAt = '2026-10-24T05:00:00.000Z';
    const now = Date.parse(startedAt) + 15 * 60_000 + 1;
    const adminAi = vi.fn()
      .mockResolvedValueOnce({
        kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p',
        attemptRef: 'native-chat:s:m', provider: 'native_chat', startedAt,
      })
      .mockResolvedValueOnce({ jobId: 'job-1', status: 'running' })
      .mockResolvedValueOnce({ kind: 'done', job: { jobId: 'job-1', status: 'completed' } });
    const gateway: AiGateway = {
      dispatch: vi.fn(),
      status: vi.fn().mockResolvedValue({ state: 'completed', text: '{"modules":[]}' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    await expect(pumpAiJob({
      api: { adminAi }, gateway, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-a',
      nowMs: () => now, sleep: vi.fn().mockResolvedValue(undefined),
    })).resolves.toMatchObject({ status: 'completed' });
    expect(adminAi).toHaveBeenCalledWith('submit_ai_output', {
      jobId: 'job-1', workerId: 'tab-a', callId: 'A1', text: '{"modules":[]}',
    });
    expect(adminAi).not.toHaveBeenCalledWith('report_ai_failure', expect.anything());
    expect(gateway.cancel).not.toHaveBeenCalled();
  });

  it('refreshes the server lease while a sandbox attempt runs longer than the lease window', async () => {
    let now = 0;
    const activeStep = {
      kind: 'ai_call', callId: 'B-lessons', operationId: 'job-1:B-lessons',
      prompt: 'prompt', attemptRef: 'attempt-existing',
    };
    const adminAi = vi.fn()
      .mockResolvedValueOnce(activeStep)
      .mockResolvedValueOnce(activeStep)
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ kind: 'done', job: { jobId: 'job-1', status: 'completed' } });
    const gateway: AiGateway = {
      dispatch: vi.fn(),
      status: vi.fn()
        .mockResolvedValueOnce({ state: 'running' })
        .mockResolvedValueOnce({ state: 'completed', text: '{"ok":true}' }),
    };

    await pumpAiJob({
      api: { adminAi },
      gateway, provider: 'sandbox',
      jobId: 'job-1',
      workerId: 'tab-a',
      nowMs: () => now,
      sleep: vi.fn().mockImplementation(async () => { now += 45_000; }),
    });

    expect(adminAi).toHaveBeenNthCalledWith(2, 'next_step', {
      jobId: 'job-1',
      workerId: 'tab-a',
    });
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it('keeps polling when a lease heartbeat has a transient transport failure', async () => {
    let now = 0;
    const activeStep = {
      kind: 'ai_call', callId: 'B-questions', operationId: 'job-1:B-questions',
      prompt: 'prompt', attemptRef: 'attempt-existing',
    };
    const adminAi = vi.fn()
      .mockResolvedValueOnce(activeStep)
      .mockRejectedValueOnce(Object.assign(new Error('Bad gateway'), { status: 502 }))
      .mockResolvedValueOnce(activeStep)
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ kind: 'done', job: { jobId: 'job-1', status: 'completed' } });
    const gateway: AiGateway = {
      dispatch: vi.fn(),
      status: vi.fn()
        .mockResolvedValueOnce({ state: 'running' })
        .mockResolvedValueOnce({ state: 'completed', text: '{"ok":true}' }),
    };

    await expect(pumpAiJob({
      api: { adminAi },
      gateway, provider: 'sandbox',
      jobId: 'job-1',
      workerId: 'tab-a',
      nowMs: () => now,
      sleep: vi.fn().mockImplementation(async () => { now += 45_000; }),
    })).resolves.toMatchObject({ status: 'completed' });
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it('applies the polling timeout to each AI call instead of the whole multi-call job', async () => {
    let now = 0;
    let submitted = 0;
    const steps = [
      { kind: 'ai_call', callId: 'B-lessons', operationId: 'job-1:B-lessons', prompt: 'lessons' },
      { kind: 'ai_call', callId: 'B-questions', operationId: 'job-1:B-questions', prompt: 'questions' },
    ] as const;
    const recorded = new Set<string>();
    const adminAi = vi.fn().mockImplementation(async (action: string, args: Record<string, unknown>) => {
      if (action === 'next_step') {
        return submitted < steps.length
          ? { ...steps[submitted], ...(recorded.has(steps[submitted].callId) ? { attemptRef: steps[submitted].operationId } : {}) }
          : { kind: 'done', job: { jobId: 'job-1', status: 'completed' } };
      }
      if (action === 'record_dispatch') { recorded.add(String(args.callId)); return { jobId: 'job-1', status: 'running' }; }
      if (action === 'submit_ai_output') {
        submitted += 1;
        return { jobId: 'job-1', status: submitted === steps.length ? 'completed' : 'running' };
      }
      return { jobId: 'job-1', status: 'failed', errorCode: 'AI_TIMEOUT' };
    });
    const statusCalls = new Map<string, number>();
    const gateway: AiGateway = {
      dispatch: vi.fn().mockImplementation(async ({ operationId }) => ({
        attemptRef: operationId,
      })),
      status: vi.fn().mockImplementation(async (attemptRef: string) => {
        const count = statusCalls.get(attemptRef) ?? 0;
        statusCalls.set(attemptRef, count + 1);
        return count === 0
          ? { state: 'running' as const }
          : { state: 'completed' as const, text: '{"ok":true}' };
      }),
    };

    await expect(pumpAiJob({
      api: { adminAi },
      gateway, provider: 'sandbox',
      jobId: 'job-1',
      workerId: 'tab-a',
      nowMs: () => now,
      sleep: vi.fn().mockImplementation(async () => { now += 8 * 60_000; }),
    })).resolves.toMatchObject({ status: 'completed' });
    expect(gateway.dispatch).toHaveBeenCalledTimes(2);
    expect(adminAi).not.toHaveBeenCalledWith('report_ai_failure', expect.anything());
  });

  it('reports an unknown dispatch outcome and respects cancellation while polling', async () => {
    const onProgress = vi.fn();
    const failedJob = { jobId: 'job-1', status: 'failed', errorCode: 'AI_DISPATCH_UNKNOWN' };
    const dispatchApi = vi.fn()
      .mockResolvedValueOnce({
        kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'prompt',
      })
      .mockResolvedValueOnce(failedJob);
    const dispatchGateway: AiGateway = {
      dispatch: vi.fn().mockRejectedValue(new Error('network timeout')),
      status: vi.fn(),
    };
    await expect(pumpAiJob({
      api: { adminAi: dispatchApi },
      gateway: dispatchGateway,
      provider: 'sandbox',
      jobId: 'job-1',
      workerId: 'tab-a',
      sleep: vi.fn().mockResolvedValue(undefined),
      onProgress,
    })).rejects.toThrow('network timeout');
    expect(dispatchApi).toHaveBeenLastCalledWith('report_ai_failure', {
      jobId: 'job-1',
      workerId: 'tab-a',
      callId: 'A1',
      kind: 'dispatch_unknown',
    });
    expect(onProgress).toHaveBeenCalledWith(failedJob);

    const controller = new AbortController();
    const pollApi = vi.fn().mockResolvedValue({
      kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1',
      prompt: 'prompt', attemptRef: 'attempt-existing',
    });
    const pollGateway: AiGateway = {
      dispatch: vi.fn(),
      status: vi.fn().mockResolvedValue({ state: 'running' }),
    };
    const sleep = vi.fn().mockImplementation(async () => { controller.abort(new Error('closed')); });
    await expect(pumpAiJob({
      api: { adminAi: pollApi },
      gateway: pollGateway,
      provider: 'sandbox',
      jobId: 'job-1',
      workerId: 'tab-a',
      signal: controller.signal,
      sleep,
    })).rejects.toThrow('closed');
  });

  it('reports structured sandbox diagnostics for a failed provider attempt', async () => {
    const failedJob = {
      jobId: 'job-1',
      status: 'failed',
      errorCode: 'AI_FAILED',
      errorMessage: 'The model provider rejected the configured credentials.',
    };
    const adminAi = vi.fn()
      .mockResolvedValueOnce({
        kind: 'ai_call', callId: 'B-lessons', operationId: 'job-1:B-lessons',
        prompt: 'prompt', attemptRef: 'attempt-1', provider: 'sandbox',
      })
      .mockResolvedValueOnce(failedJob);
    const gateway: AiGateway = {
      dispatch: vi.fn(),
      status: vi.fn().mockResolvedValue({
        state: 'failed',
        error: 'The model provider rejected the configured credentials.',
        errorCode: 'MODEL_PROVIDER_CREDENTIALS_REJECTED',
        phase: 'model-call',
      }),
    };

    await expect(pumpAiJob({
      api: { adminAi }, gateway, provider: 'sandbox',
      jobId: 'job-1', workerId: 'tab-a', sleep: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('The model provider rejected the configured credentials.');
    expect(adminAi).toHaveBeenLastCalledWith('report_ai_failure', {
      jobId: 'job-1',
      workerId: 'tab-a',
      callId: 'B-lessons',
      kind: 'failed',
      message: 'The model provider rejected the configured credentials.',
      providerErrorCode: 'MODEL_PROVIDER_CREDENTIALS_REJECTED',
      providerPhase: 'model-call',
    });
  });
});

describe('reconciling a job after a code-less transport failure', () => {
  const job = (patch: Record<string, unknown>) => ({ jobId: 'job-1', status: 'running', calls: [], ...patch }) as never;

  it('returns a completed job with a result without polling', async () => {
    const getJob = vi.fn().mockResolvedValue(job({ status: 'completed', result: { templateId: 't', version: 1 } }));
    const sleep = vi.fn(async () => undefined);
    await expect(reconcileJobAfterTransportFailure({ getJob, sleep })).resolves.toMatchObject({ status: 'completed' });
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls every 3 s a completed job that has no result yet, until the result appears', async () => {
    let time = 0;
    const getJob = vi.fn()
      .mockResolvedValueOnce(job({ status: 'completed' }))
      .mockResolvedValueOnce(job({ status: 'completed' }))
      .mockResolvedValue(job({ status: 'completed', result: { templateId: 't', version: 1 } }));
    const sleep = vi.fn(async (ms: number) => { time += ms; });
    await expect(reconcileJobAfterTransportFailure({ getJob, sleep, nowMs: () => time })).resolves.toMatchObject({ result: { templateId: 't' } });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([3_000, 3_000]);
  });

  it('gives up after about 60 s without a result', async () => {
    let time = 0;
    const getJob = vi.fn().mockResolvedValue(job({ status: 'completed' }));
    const sleep = vi.fn(async (ms: number) => { time += ms; });
    await expect(reconcileJobAfterTransportFailure({ getJob, sleep, nowMs: () => time })).resolves.toBeUndefined();
    expect(time).toBeLessThanOrEqual(60_000);
    expect(getJob.mock.calls.length).toBeGreaterThan(10);
  });

  it('hands back a running job and nothing for a failed job or a failed get_job', async () => {
    await expect(reconcileJobAfterTransportFailure({ getJob: async () => job({}) })).resolves.toMatchObject({ status: 'running' });
    await expect(reconcileJobAfterTransportFailure({ getJob: async () => job({ status: 'failed' }) })).resolves.toBeUndefined();
    await expect(reconcileJobAfterTransportFailure({ getJob: async () => { throw new Error('tools/call timeout'); } })).resolves.toBeUndefined();
  });

  it('treats only code-less, non-abort errors as transport failures', () => {
    expect(isTransportFailure(new Error('tools/call timeout'))).toBe(true);
    expect(isTransportFailure(Object.assign(new Error('busy'), { code: 'PROJECT_BUSY' }))).toBe(false);
    expect(isTransportFailure(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});

describe('retrying a transient failure', () => {
  const timeout = () => new Error('tools/call timeout');
  const recordSleep = () => {
    const waits: number[] = [];
    return { waits, sleep: vi.fn(async (ms: number) => { waits.push(ms); }) };
  };

  it('waits 2 s and re-sends after a code-less failure, reporting the attempt', async () => {
    const { waits, sleep } = recordSleep();
    const run = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue('ok');
    const onRetry = vi.fn();
    await expect(withTransientRetry({ run, sleep, onRetry })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([2_000]);
    expect(onRetry).toHaveBeenCalledWith(1, 3);
  });

  it('reconciles before re-sending and never re-sends a change that already took effect', async () => {
    const { sleep } = recordSleep();
    const run = vi.fn().mockRejectedValue(timeout());
    const reconcile = vi.fn().mockResolvedValue('applied');
    await expect(withTransientRetry({ run, reconcile, sleep })).resolves.toBe('applied');
    expect(run).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('re-sends when the reconcile shows nothing changed', async () => {
    const { sleep } = recordSleep();
    const run = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue('sent');
    const reconcile = vi.fn().mockResolvedValue(undefined);
    await expect(withTransientRetry({ run, reconcile, sleep })).resolves.toBe('sent');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not re-send while the reconcile itself fails; it reconciles again after the next delay', async () => {
    const { waits, sleep } = recordSleep();
    const run = vi.fn().mockRejectedValue(timeout());
    const reconcile = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue('applied');
    await expect(withTransientRetry({ run, reconcile, sleep })).resolves.toBe('applied');
    expect(run).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([2_000, 5_000]);
  });

  it('gives up after 3 retries at 2 s, 5 s and 10 s with the last failure', async () => {
    const { waits, sleep } = recordSleep();
    const run = vi.fn().mockRejectedValue(timeout());
    await expect(withTransientRetry({ run, sleep })).rejects.toThrow('tools/call timeout');
    expect(run).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([...TRANSIENT_RETRY_DELAYS_MS]);
    expect(TRANSIENT_RETRY_DELAYS_MS).toEqual([2_000, 5_000, 10_000]);
  });

  it('never retries an error that carries a server code', async () => {
    const { sleep } = recordSleep();
    const coded = Object.assign(new Error('conflict'), { code: 'OPERATION_CONFLICT' });
    const run = vi.fn().mockRejectedValue(coded);
    await expect(withTransientRetry({ run, sleep })).rejects.toBe(coded);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops retrying once its run was superseded (pause, reset or close)', async () => {
    let active = true;
    const sleep = vi.fn(async () => { active = false; });
    const run = vi.fn().mockRejectedValue(timeout());
    await expect(withTransientRetry({ run, sleep, active: () => active })).rejects.toThrow('tools/call timeout');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('recognising a change that already took effect', () => {
  const m0 = { moduleLocalId: 'm0', title: 'Tổng quan', sourceSectionIds: ['s#1'], tombstoned: false };
  const base = {
    jobId: 'job-1', status: 'running', calls: [], stageOutputs: {}, sourceIds: ['s'],
    outline: { revision: 3, modules: [m0], flags: [], taskCoverage: [] },
    moduleRuns: [{ outline: { moduleLocalId: 'm0' }, lessonVersion: 2, questionVersion: 4 }],
  } as unknown as AiJobRecord;
  const withOutline = (revision: number, modules: readonly unknown[], patch: Record<string, unknown> = {}) =>
    ({ ...base, ...patch, outline: { ...base.outline!, revision, modules } }) as unknown as AiJobRecord;
  const outline = (action: string, args: Record<string, unknown>) => ({ kind: 'outline' as const, action, args: { expectedRevision: 3, ...args } });

  it('needs a revision past the one sent and a module with the new title for add_outline_module', () => {
    const add = outline('add_outline_module', { title: 'Mẹo sử dụng' });
    expect(jobChangeApplied(base, base, add)).toBe(false);
    expect(jobChangeApplied(base, withOutline(4, [m0]), add)).toBe(false);
    expect(jobChangeApplied(base, withOutline(4, [m0, { moduleLocalId: 'm1', title: 'Mẹo sử dụng' }]), add)).toBe(true);
    // The sent revision decides, not a stale client snapshot.
    expect(jobChangeApplied(withOutline(1, [m0]), withOutline(3, [m0, { moduleLocalId: 'm1', title: 'Mẹo sử dụng' }]), add)).toBe(false);
  });

  it('needs a new supplement request for that module and source for supplement_module_document', () => {
    const supplement = outline('supplement_module_document', { moduleLocalId: 'm0', sourceId: 'new' });
    expect(jobChangeApplied(base, base, supplement)).toBe(false);
    expect(jobChangeApplied(base, { ...base, stageOutputs: { 'supplement:1': { moduleLocalId: 'm1', sourceId: 'new' } } }, supplement)).toBe(false);
    expect(jobChangeApplied(base, { ...base, stageOutputs: { 'supplement:1': { moduleLocalId: 'm0', sourceId: 'new' } } }, supplement)).toBe(true);
  });

  it('needs the targeted module changed for update_outline, supplement_module_sources and set_coverage_override', () => {
    const renamed = withOutline(4, [{ ...m0, title: 'Mới' }]);
    expect(jobChangeApplied(base, withOutline(4, [m0]), outline('update_outline', { edits: [{ type: 'update', moduleLocalId: 'm0', patch: { title: 'Mới' } }] }))).toBe(false);
    expect(jobChangeApplied(base, renamed, outline('update_outline', { edits: [{ type: 'update', moduleLocalId: 'm0', patch: { title: 'Mới' } }] }))).toBe(true);
    expect(jobChangeApplied(base, withOutline(4, [{ ...m0, tombstoned: true }]), outline('update_outline', { edits: [{ type: 'delete', moduleLocalId: 'm0' }] }))).toBe(true);
    const pick = outline('supplement_module_sources', { moduleLocalId: 'm0', sourceIds: ['s'], sectionIds: ['s#2'] });
    expect(jobChangeApplied(base, withOutline(4, [m0]), pick)).toBe(false);
    expect(jobChangeApplied(base, withOutline(4, [{ ...m0, sourceSectionIds: ['s#1', 's#2'] }]), pick)).toBe(true);
    const override = outline('set_coverage_override', { moduleLocalId: 'm0', override: true });
    expect(jobChangeApplied(base, withOutline(3, [{ ...m0, coverageOverride: true }]), override)).toBe(false);
    expect(jobChangeApplied(base, withOutline(4, [{ ...m0, coverageOverride: true }]), override)).toBe(true);
    expect(jobChangeApplied(base, withOutline(9, [m0]), outline('unknown_action', {}))).toBe(false);
  });

  it('sees a module change from its lesson or question version', () => {
    const lesson = { kind: 'module' as const, moduleLocalId: 'm0', target: 'lesson' as const, expectedVersion: 2 };
    const questions = { kind: 'module' as const, moduleLocalId: 'm0', target: 'questions' as const, expectedVersion: 4 };
    expect(jobChangeApplied(base, base, lesson)).toBe(false);
    expect(jobChangeApplied(base, base, questions)).toBe(false);
    const bumped = { ...base, moduleRuns: [{ ...base.moduleRuns![0], lessonVersion: 3, questionVersion: 5 }] } as AiJobRecord;
    expect(jobChangeApplied(base, bumped, lesson)).toBe(true);
    expect(jobChangeApplied(base, bumped, questions)).toBe(true);
  });
});

describe('a job the server marked failed', () => {
  it('rejects with a server code, so it is never retried as a slow server', async () => {
    const failed = { jobId: 'job-1', status: 'failed', calls: [], errorCode: 'AI_TIMEOUT', errorMessage: 'Timed out.' };
    const adminAi = vi.fn().mockResolvedValue({ kind: 'failed', job: failed });
    const gateway: AiGateway = { dispatch: vi.fn(), status: vi.fn(), cancel: vi.fn() };
    const error = await pumpAiJob({ api: { adminAi }, gateway, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AI_TIMEOUT', message: 'Timed out.' });
    expect(isTransportFailure(error)).toBe(false);
    adminAi.mockResolvedValue({ kind: 'failed', job: { ...failed, errorCode: undefined } });
    await expect(pumpAiJob({ api: { adminAi }, gateway, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a' })).rejects.toMatchObject({ code: 'AI_JOB_FAILED' });
  });
});

describe('a pump the server keeps waiting', () => {
  const waiting = (updatedAt: string) => ({ jobId: 'job-1', status: 'running', calls: [], updatedAt });

  it('calls onWait on every wait and keeps polling until the server dispatches', async () => {
    let time = 0;
    const adminAi = vi.fn()
      .mockResolvedValueOnce({ kind: 'wait', job: waiting('t0') })
      .mockResolvedValueOnce({ kind: 'wait', job: waiting('t0') })
      .mockResolvedValueOnce({ kind: 'awaiting_admin', job: waiting('t1') });
    const onWait = vi.fn();
    await expect(pumpAiJob({
      api: { adminAi }, gateway: { dispatch: vi.fn(), status: vi.fn() }, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a',
      nowMs: () => time, sleep: async (ms) => { time += ms; }, onWait, maxIdleWaitMs: 180_000,
    })).resolves.toMatchObject({ updatedAt: 't1' });
    expect(onWait).toHaveBeenCalledTimes(2);
    expect(adminAi).toHaveBeenCalledTimes(3);
  });

  it('gives up with AI_PUMP_STALLED after maxIdleWaitMs of waits on an unchanged job', async () => {
    let time = 0;
    const adminAi = vi.fn().mockResolvedValue({ kind: 'wait', job: waiting('t0') });
    const result = pumpAiJob({
      api: { adminAi }, gateway: { dispatch: vi.fn(), status: vi.fn() }, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a',
      nowMs: () => time, sleep: async (ms) => { time += ms; }, maxIdleWaitMs: 180_000,
    });
    await expect(result).rejects.toBeInstanceOf(AiPumpStalledError);
    await expect(result).rejects.toMatchObject({ code: AI_PUMP_STALLED, job: { updatedAt: 't0' } });
    // 3 s apart: the 61st wait is the first one 180 s after the run of waits began.
    expect(adminAi).toHaveBeenCalledTimes(61);
  });

  it('restarts the bound whenever the waiting job changes, and waits forever without a bound', async () => {
    let time = 0;
    let reads = 0;
    const adminAi = vi.fn(async () => (++reads > 200
      ? { kind: 'done', job: waiting('end') }
      : { kind: 'wait', job: waiting('t' + String(Math.floor(reads / 50))) }));
    await expect(pumpAiJob({
      api: { adminAi }, gateway: { dispatch: vi.fn(), status: vi.fn() }, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a',
      nowMs: () => time, sleep: async (ms) => { time += ms; }, maxIdleWaitMs: 180_000,
    })).resolves.toMatchObject({ updatedAt: 'end' });
    reads = 0;
    const unchanged = vi.fn(async () => (++reads > 200 ? { kind: 'done', job: waiting('end') } : { kind: 'wait', job: waiting('t0') }));
    await expect(pumpAiJob({
      api: { adminAi: unchanged }, gateway: { dispatch: vi.fn(), status: vi.fn() }, provider: 'sandbox', jobId: 'job-1', workerId: 'tab-a',
      nowMs: () => time, sleep: async (ms) => { time += ms; },
    })).resolves.toMatchObject({ updatedAt: 'end' });
  });

  it('keeps a Native question recovery on Native through a PROJECT_BUSY successor, then hands the next lesson back unused', async () => {
    const running = (updatedAt: string) => ({ jobId: 'job-1', status: 'running', calls: [], updatedAt });
    const steps = [
      { kind: 'ai_call', callId: 'module-4', operationId: 'job-1:module-4', prompt: 'p', moduleTarget: 'questions', moduleLocalId: 'm1' },
      // The server queued a project_busy successor and waits until its nextRetryAt.
      { kind: 'wait', job: running('busy') },
      { kind: 'ai_call', callId: 'module-5', operationId: 'job-1:module-5', prompt: 'p', moduleTarget: 'questions', moduleLocalId: 'm1' },
      { kind: 'ai_call', callId: 'module-6', operationId: 'job-1:module-6', prompt: 'p', moduleTarget: 'lesson', moduleLocalId: 'm2' },
    ];
    const handedBack = running('released');
    const adminAi = vi.fn(async (action: string, args: Record<string, unknown>) => {
      if (action === 'next_step') return steps.shift();
      if (action === 'report_ai_failure' && args.providerErrorCode === 'DISPATCH_NOT_STARTED') return handedBack;
      return running(action + ':' + String(args.callId));
    });
    let attempts = 0;
    const native: AiGateway = {
      dispatch: vi.fn(async () => ({ attemptRef: 'native-chat:s:m' + String(++attempts) })),
      status: vi.fn(async (attemptRef: string) => attemptRef.endsWith('m1')
        ? { state: 'failed' as const, error: 'Another request in this project is still running', errorCode: 'PROJECT_BUSY' }
        : { state: 'completed' as const, text: '{}' }),
    };
    await expect(pumpAiJob({
      api: { adminAi }, gateway: native, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-a',
      questionRecoveryOf: { moduleLocalId: 'm1' }, questionPollMs: 90_000, sleep: async () => undefined,
    })).resolves.toBe(handedBack);
    // Both question attempts ran on Native inside the one recovery; the lesson was never dispatched.
    expect(native.dispatch).toHaveBeenCalledTimes(2);
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({ callId: 'module-4', kind: 'failed', providerErrorCode: 'PROJECT_BUSY' }));
    expect(adminAi).toHaveBeenCalledWith('record_dispatch', expect.objectContaining({ callId: 'module-5', provider: 'native_chat' }));
    expect(adminAi).toHaveBeenCalledWith('submit_ai_output', expect.objectContaining({ callId: 'module-5' }));
    expect(adminAi).toHaveBeenLastCalledWith('report_ai_failure', {
      jobId: 'job-1', workerId: 'tab-a', callId: 'module-6', kind: 'failed', providerErrorCode: 'DISPATCH_NOT_STARTED',
    });
    expect(adminAi.mock.calls.some(([action, args]) => action === 'record_dispatch' && (args as { callId?: string }).callId === 'module-6')).toBe(false);
  });

  it('applies the question deadline only to a Native questions call, never to a lesson in the same loop', async () => {
    const startedAt = '2026-10-24T05:00:00.000Z';
    const now = Date.parse(startedAt) + 120_000;
    const done = { jobId: 'job-1', status: 'completed', calls: [], updatedAt: 'done' };
    let steps = 0;
    const adminAi = vi.fn(async (action: string) => (action !== 'next_step' ? done
      : steps++ === 0
        ? { kind: 'ai_call', callId: 'module-5', operationId: 'job-1:module-5', prompt: 'p', attemptRef: 'native-chat:s:m', provider: 'native_chat', startedAt, moduleTarget: 'lesson', moduleLocalId: 'm2' }
        : { kind: 'done', job: done }));
    const status = vi.fn().mockResolvedValueOnce({ state: 'running' }).mockResolvedValue({ state: 'completed', text: '{}' });
    await expect(pumpAiJob({
      api: { adminAi }, gateway: { dispatch: vi.fn(), status }, provider: 'native_chat', jobId: 'job-1', workerId: 'tab-a',
      questionPollMs: 90_000, nowMs: () => now, sleep: async () => undefined,
    })).resolves.toBe(done);
    // 120 s into a lesson is far inside its 15-minute deadline: polled, never reported as a timeout.
    expect(adminAi).not.toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({ kind: 'timeout' }));
    expect(adminAi).toHaveBeenCalledWith('submit_ai_output', expect.objectContaining({ callId: 'module-5' }));
  });
});
