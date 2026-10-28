import type { McpApp } from '@privos_ai/app-react';
import { describe, expect, it, vi } from 'vitest';

import { createSandboxAiGateway } from '../src/ui/onboarding/ai/ai-gateway-sandbox';

function appWithRest(rest: McpApp['rest']): McpApp {
  return { rest } as McpApp;
}

describe('Sandbox AI gateway', () => {
  it('cancels a dispatched sandbox attempt in the bound room', async () => {
    const rest = vi.fn<McpApp['rest']>().mockResolvedValue({ status: 'cancelled' } as never);
    const gateway = createSandboxAiGateway(appWithRest(rest), 'room-a');

    await expect(gateway.cancel?.('attempt-1')).resolves.toBeUndefined();
    expect(rest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      path: 'agents.sandbox.attempt-cancel',
      body: { roomId: 'room-a', attemptId: 'attempt-1' },
    }));
  });

  it('dispatches one idempotent room-bound async generation and returns its attempt reference', async () => {
    const rest = vi.fn<McpApp['rest']>().mockResolvedValue({
      statusCode: 202,
      body: {
        attemptId: 'agent-attempt-1',
        taskId: 'task-1',
        source: 'room',
        adopted: false,
        replayed: false,
      },
    });
    const gateway = createSandboxAiGateway(appWithRest(rest), 'room-a');

    await expect(gateway.dispatch({
      operationId: 'job-1:inventory:1',
      prompt: 'Tạo inventory',
      systemContext: 'Chỉ dùng nguồn đã cung cấp.',
    })).resolves.toEqual({ attemptRef: 'agent-attempt-1' });
    expect(rest).toHaveBeenCalledWith({
      method: 'POST',
      path: 'agents.sandbox.generate-async',
      timeoutMs: 15_000,
      body: {
        roomId: 'room-a',
        operationId: 'job-1:inventory:1',
        prompt: 'Tạo inventory',
        systemContext: 'Chỉ dùng nguồn đã cung cấp.',
      },
    });
  });

  it('accepts the successful response shape returned by the live SDK bridge', async () => {
    const rest = vi.fn<McpApp['rest']>().mockResolvedValue({
      attemptId: 'sandbox-attempt-live',
      taskId: 'room-a',
      source: 'global',
      adopted: false,
      replayed: false,
      success: true,
    } as unknown as Awaited<ReturnType<McpApp['rest']>>);
    const gateway = createSandboxAiGateway(appWithRest(rest), 'room-a');

    await expect(gateway.dispatch({ operationId: 'op-live', prompt: 'probe' }))
      .resolves.toEqual({ attemptRef: 'sandbox-attempt-live' });
  });

  it.each([
    ['pending', 'pending'],
    ['running', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('normalizes %s attempt status without inventing fields', async (status, expected) => {
    const rest = vi.fn<McpApp['rest']>().mockResolvedValue({
      statusCode: 200,
      body: { status, text: status === 'completed' ? '{"ok":true}' : undefined, error: status === 'failed' ? 'model failed' : undefined },
    });
    const gateway = createSandboxAiGateway(appWithRest(rest), 'room-a');

    await expect(gateway.status('agent-attempt-1')).resolves.toEqual({
      state: expected,
      ...(status === 'completed' ? { text: '{"ok":true}' } : {}),
      ...(status === 'failed' ? { error: 'model failed' } : {}),
    });
    expect(rest).toHaveBeenCalledWith({
      method: 'GET',
      path: 'agents.sandbox.attempt-status',
      timeoutMs: 15_000,
      query: { roomId: 'room-a', attemptId: 'agent-attempt-1' },
    });
  });

  it('accepts an unwrapped live status response', async () => {
    const rest = vi.fn<McpApp['rest']>().mockResolvedValue({
      status: 'completed',
      text: '{"probe":"ok"}',
      success: true,
    } as unknown as Awaited<ReturnType<McpApp['rest']>>);
    const gateway = createSandboxAiGateway(appWithRest(rest), 'room-a');

    await expect(gateway.status('sandbox-attempt-live')).resolves.toEqual({
      state: 'completed',
      text: '{"probe":"ok"}',
    });
  });

  it('reads terminal cause and phase from attempt observation when a sandbox attempt fails', async () => {
    const rest = vi.fn<McpApp['rest']>()
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { status: 'failed' },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: {
          attemptId: 'agent-attempt-1',
          status: 'failed',
          phase: 'model-call',
          terminalCause: {
            code: 'MODEL_PROVIDER_CREDENTIALS_REJECTED',
            message: 'The model provider rejected the configured credentials.',
          },
          source: 'room',
        },
      });
    const gateway = createSandboxAiGateway(appWithRest(rest), 'room-a');

    await expect(gateway.status('agent-attempt-1')).resolves.toEqual({
      state: 'failed',
      error: 'The model provider rejected the configured credentials.',
      errorCode: 'MODEL_PROVIDER_CREDENTIALS_REJECTED',
      phase: 'model-call',
    });
    expect(rest).toHaveBeenNthCalledWith(2, {
      method: 'GET',
      path: 'agents.sandbox.attempt-observation',
      timeoutMs: 15_000,
      query: { roomId: 'room-a', attemptId: 'agent-attempt-1' },
    });
  });

  it('redacts provider credentials before returning a failure diagnostic', async () => {
    const rest = vi.fn<McpApp['rest']>()
      .mockResolvedValueOnce({ statusCode: 200, body: { status: 'failed' } })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: {
          status: 'failed',
          terminalCause: {
            code: 'AUTH_FAILED',
            message: 'Provider rejected api_key=sk-super-secret-key and Authorization: Bearer token-value.',
          },
        },
      });
    const gateway = createSandboxAiGateway(appWithRest(rest), 'room-a');

    await expect(gateway.status('agent-attempt-1')).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'AUTH_FAILED',
      error: 'Provider rejected api_key=[REDACTED] and Authorization: Bearer [REDACTED]',
    });
  });

  it('fails closed for denied or malformed Hub responses', async () => {
    const denied = createSandboxAiGateway(appWithRest(vi.fn<McpApp['rest']>().mockResolvedValue({
      statusCode: 403,
      body: { success: false, error: 'OPTIONAL_PERMISSION_NOT_GRANTED' },
    })), 'room-a');
    await expect(denied.dispatch({ operationId: 'op-1', prompt: 'x' })).rejects.toMatchObject({
      code: 'AI_PERMISSION_DENIED',
    });

    const malformed = createSandboxAiGateway(appWithRest(vi.fn<McpApp['rest']>().mockResolvedValue({
      statusCode: 202,
      body: { taskId: 'task-without-attempt' },
    })), 'room-a');
    await expect(malformed.dispatch({ operationId: 'op-2', prompt: 'x' })).rejects.toMatchObject({
      code: 'AI_RESPONSE_INVALID',
    });
  });
});
