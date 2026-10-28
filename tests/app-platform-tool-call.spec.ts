import { AgentBotHubUnreachableError } from '@privos_ai/app-server';
import { describe, expect, it, vi } from 'vitest';

import { withSelectiveHubRetry } from '../src/app-platform-tool-call';

describe('selective App Platform Hub retry', () => {
  it('recovers a replay-safe call after two transient Hub reachability failures', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new AgentBotHubUnreachableError())
      .mockRejectedValueOnce(new AgentBotHubUnreachableError())
      .mockResolvedValueOnce('ok');
    const delays: number[] = [];

    const result = await withSelectiveHubRetry(operation, true, async (milliseconds) => {
      delays.push(milliseconds);
    });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([200, 400]);
  });

  it('never replays an operation that was not marked replay-safe', async () => {
    const unreachable = new AgentBotHubUnreachableError();
    const operation = vi.fn().mockRejectedValue(unreachable);
    const sleep = vi.fn(async () => undefined);

    await expect(withSelectiveHubRetry(operation, false, sleep)).rejects.toBe(unreachable);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry non-reachability failures for a replay-safe operation', async () => {
    const rejected = new Error('permission denied');
    const operation = vi.fn().mockRejectedValue(rejected);
    const sleep = vi.fn(async () => undefined);

    await expect(withSelectiveHubRetry(operation, true, sleep)).rejects.toBe(rejected);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops after three attempts when the Hub remains unreachable', async () => {
    const unreachable = new AgentBotHubUnreachableError();
    const operation = vi.fn().mockRejectedValue(unreachable);
    const delays: number[] = [];

    await expect(withSelectiveHubRetry(operation, true, async (milliseconds) => {
      delays.push(milliseconds);
    })).rejects.toBe(unreachable);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([200, 400]);
  });
});
