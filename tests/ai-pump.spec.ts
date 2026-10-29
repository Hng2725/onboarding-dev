import { describe, expect, it, vi } from 'vitest';

import { AiGatewayError, type AiGateway } from '../src/ui/onboarding/ai/ai-gateway-sandbox';
import { pumpAiJob } from '../src/ui/onboarding/ai/ai-pump';

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
      .mockResolvedValueOnce({ kind: 'ai_call', callId: 'A1', operationId: 'job-1:A1', prompt: 'p' })
      .mockResolvedValueOnce(recoverable)
      .mockResolvedValueOnce({ kind: 'awaiting_admin', job: recoverable });
    const gateway: AiGateway = {
      dispatch: vi.fn().mockRejectedValue(new AiGatewayError(code, 'Provider unavailable before dispatch')),
      status: vi.fn(),
    };

    await expect(pumpAiJob({
      api: { adminAi }, gateway, provider, jobId: 'job-1', workerId: 'tab-a',
      ...(code === 'DISPATCH_NOT_STARTED' ? { recoverPreDispatchFailure: true } : {}),
    })).resolves.toEqual(recoverable);
    expect(adminAi).toHaveBeenCalledWith('report_ai_failure', expect.objectContaining({
      kind: 'failed',
      provider,
      providerErrorCode: code,
    }));
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
