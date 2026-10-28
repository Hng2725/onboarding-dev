import { describe, expect, it, vi } from 'vitest';

import type { AiAttemptStatus, AiGateway } from '../src/ui/onboarding/ai/ai-gateway-sandbox';
import { cancelAndConfirmAttempt } from '../src/ui/onboarding/ai/ai-attempt-lifecycle';

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    wait: vi.fn(async (milliseconds: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason;
      now += milliseconds;
    }),
  };
}

function gatewayWith(
  statuses: readonly (AiAttemptStatus | Error)[],
  cancel: AiGateway['cancel'] = vi.fn().mockResolvedValue(undefined),
): AiGateway {
  let index = 0;
  return {
    dispatch: vi.fn(),
    cancel,
    status: vi.fn(async () => {
      const next = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    }),
  };
}

describe('AI attempt cancellation lifecycle', () => {
  it('confirms an attempt that already finished without posting a cancel', async () => {
    const clock = fakeClock();
    const gateway = gatewayWith([{ state: 'completed', text: '{}' }]);

    await expect(cancelAndConfirmAttempt(gateway, 'attempt-1', clock))
      .resolves.toEqual({ state: 'confirmed', terminalState: 'completed' });
    expect(gateway.cancel).not.toHaveBeenCalled();
  });

  it('posts a cancel and confirms the cancelled terminal state', async () => {
    const clock = fakeClock();
    const gateway = gatewayWith([{ state: 'running' }, { state: 'cancelled' }]);

    await expect(cancelAndConfirmAttempt(gateway, 'attempt-1', clock))
      .resolves.toEqual({ state: 'confirmed', terminalState: 'cancelled' });
    expect(gateway.cancel).toHaveBeenCalledTimes(1);
  });

  it('still confirms when the cancel request times out but the provider reports cancelled', async () => {
    const clock = fakeClock();
    const gateway = gatewayWith(
      [{ state: 'running' }, { state: 'cancelled' }],
      vi.fn().mockRejectedValue(new Error('Request timed out')),
    );

    await expect(cancelAndConfirmAttempt(gateway, 'attempt-1', clock))
      .resolves.toEqual({ state: 'confirmed', terminalState: 'cancelled' });
  });

  it('reports unknown when the cancel fails and the attempt keeps running for 15 seconds', async () => {
    const clock = fakeClock();
    const gateway = gatewayWith(
      [{ state: 'running' }],
      vi.fn().mockRejectedValue(new Error('bridge offline')),
    );

    const outcome = await cancelAndConfirmAttempt(gateway, 'attempt-1', clock);

    expect(outcome).toMatchObject({ state: 'unknown', message: expect.any(String) });
    expect(clock.now()).toBeGreaterThanOrEqual(15_000);
    expect(clock.now()).toBeLessThan(17_000);
    expect(JSON.stringify(outcome)).not.toContain('bridge offline');
  });

  it('keeps polling through transient status errors', async () => {
    const clock = fakeClock();
    const gateway = gatewayWith([{ state: 'running' }, new Error('503'), { state: 'failed' }]);

    await expect(cancelAndConfirmAttempt(gateway, 'attempt-1', clock))
      .resolves.toEqual({ state: 'confirmed', terminalState: 'failed' });
  });

  it('stops polling immediately with AbortError when aborted', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const gateway = gatewayWith([{ state: 'running' }]);
    clock.wait.mockImplementation(async () => {
      controller.abort(new DOMException('closed', 'AbortError'));
      throw controller.signal.reason;
    });

    await expect(cancelAndConfirmAttempt(gateway, 'attempt-1', {
      ...clock,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(gateway.status).toHaveBeenCalledTimes(2);
  });
});
