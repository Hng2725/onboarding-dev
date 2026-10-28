import type { McpApp } from '@privos_ai/app-react';
import { describe, expect, it, vi } from 'vitest';

import { createNativeChatAiGateway } from '../src/ui/onboarding/ai/ai-gateway-native-chat';

function appWith(input: {
  readonly rest: McpApp['rest'];
  readonly uploadFile?: McpApp['uploadFile'];
}): McpApp {
  return {
    rest: input.rest,
    uploadFile: input.uploadFile ?? vi.fn(),
  } as unknown as McpApp;
}

describe('Native AI Chat gateway', () => {
  it.each(['Storage unavailable', '403 permission denied'])('proves dispatch did not start when context upload fails: %s', async (message) => {
    const rest = vi.fn<McpApp['rest']>();
    const uploadFile = vi.fn<McpApp['uploadFile']>().mockRejectedValue(new Error(message));
    const gateway = createNativeChatAiGateway(appWith({ rest, uploadFile }), 'room-a');
    await expect(gateway.dispatch({ operationId: 'op', prompt: 'p' })).rejects.toMatchObject({ code: 'DISPATCH_NOT_STARTED' });
    expect(rest).not.toHaveBeenCalled();
  });

  it('does not send a provider request when the modal closes during context upload', async () => {
    const controller = new AbortController();
    const rest = vi.fn<McpApp['rest']>();
    const uploadFile = vi.fn<McpApp['uploadFile']>().mockImplementation(async () => { controller.abort(new Error('closed')); return {} as never; });
    const gateway = createNativeChatAiGateway(appWith({ rest, uploadFile }), 'room-a');
    await expect(gateway.dispatch({ operationId: 'op', prompt: 'p', signal: controller.signal })).rejects.toMatchObject({ code: 'DISPATCH_NOT_STARTED' });
    expect(rest).not.toHaveBeenCalled();
  });

  it('preserves the exact created message reference when generation acknowledgement is lost', async () => {
    const rest = vi.fn<McpApp['rest']>()
      .mockResolvedValueOnce({ sessionId: 'session-known', aiMessage: { _id: 'message-known' } } as never)
      .mockRejectedValueOnce(new Error('startGeneration response timed out'));
    const gateway = createNativeChatAiGateway(appWith({ rest }), 'room-a');
    await expect(gateway.dispatch({ operationId: 'op', prompt: 'p' })).resolves.toEqual({ attemptRef: 'native-chat:session-known:message-known' });
    expect(rest).toHaveBeenCalledTimes(2);
  });

  it.each(['response', 'rejection', 'terminal'] as const)('classifies project busy from %s without inventing an external attempt', async (source) => {
    const message = 'Another request in this project is still running';
    const rest = vi.fn<McpApp['rest']>();
    if (source === 'response') rest.mockResolvedValue({ statusCode: 409, body: { error: message } } as never);
    else if (source === 'rejection') rest.mockRejectedValue(new Error(message));
    else rest.mockResolvedValue({ messages: [{ _id: 'message-1', status: 'failed', content: message }] } as never);
    const gateway = createNativeChatAiGateway(appWith({ rest }), 'room-a');
    if (source === 'terminal') {
      await expect(gateway.status('native-chat:session-1:message-1')).resolves.toMatchObject({ state: 'failed', errorCode: 'PROJECT_BUSY' });
    } else {
      await expect(gateway.dispatch({ operationId: 'op', prompt: 'p' })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    }
    expect(rest).toHaveBeenCalledTimes(1);
  });

  it('cancels the in-flight assistant message from its persisted attempt reference', async () => {
    const rest = vi.fn<McpApp['rest']>().mockResolvedValue({ cancelled: true } as never);
    const gateway = createNativeChatAiGateway(appWith({ rest }), 'room-a');

    await expect(gateway.cancel?.('native-chat:session-1:message-1')).resolves.toBeUndefined();
    expect(rest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      path: 'ai-messages.cancel',
      body: { messageId: 'message-1' },
    }));
  });

  it('uploads bounded context, sends a room chat message, and starts generation', async () => {
    const rest = vi.fn<McpApp['rest']>()
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        aiMessage: { _id: 'message-1' },
      } as never)
      .mockResolvedValueOnce({ started: true } as never);
    const uploadFile = vi.fn<McpApp['uploadFile']>().mockResolvedValue({
      file: { _id: 'file-1' },
    } as never);
    const gateway = createNativeChatAiGateway(appWith({ rest, uploadFile }), 'room-a');

    const result = await gateway.dispatch({
      operationId: 'job-1:D1-retry1:native',
      prompt: 'Return JSON only.',
      systemContext: '{"claim":"grounded data"}',
    });

    expect(result.attemptRef).toBe('native-chat:session-1:message-1');
    expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'room-a',
      fileName: expect.stringMatching(/^onboarding-ai-/),
      mimeType: 'text/markdown',
      duplicateAction: 'replace',
    }));
    expect(rest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'POST',
      path: 'ai-messages.send',
      body: expect.objectContaining({
        roomId: 'room-a',
        entityType: 'room-chat',
        content: expect.stringContaining('@Files:room-a/onboarding-ai-'),
      }),
    }));
    expect(rest).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'POST',
      path: 'ai-messages.startGeneration',
      body: { messageId: 'message-1' },
    }));
  });

  it('recovers session identity from the persisted attempt reference and reads completion', async () => {
    const rest = vi.fn<McpApp['rest']>().mockResolvedValue({
      messages: [{
        _id: 'message-1',
        sessionId: 'session-1',
        roomId: 'room-a',
        type: 'ai',
        status: 'completed',
        content: '{"ok":true}',
      }],
      total: 1,
      offset: 0,
    } as never);
    const gateway = createNativeChatAiGateway(appWith({ rest }), 'room-a');

    await expect(gateway.status('native-chat:session-1:message-1')).resolves.toEqual({
      state: 'completed',
      text: '{"ok":true}',
    });
    expect(rest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: 'ai-messages.list',
      query: expect.objectContaining({
        roomId: 'room-a',
        sessionId: 'session-1',
      }),
    }));
  });

  it('recovers a completed Sandbox attempt before Native AI Chat propagates its final message', async () => {
    const rest = vi.fn<McpApp['rest']>()
      .mockResolvedValueOnce({
        messages: [{
          _id: 'message-1',
          sessionId: 'session-1',
          roomId: 'room-a',
          type: 'ai',
          status: 'sending',
          content: '',
          privosSandboxAttemptId: 'agent-attempt-1',
        }],
      } as never)
      .mockResolvedValueOnce({
        success: true,
        status: 'completed',
        text: '{"modules":[]}',
      } as never);
    const gateway = createNativeChatAiGateway(appWith({ rest }), 'room-a');

    await expect(gateway.status('native-chat:session-1:message-1')).resolves.toEqual({
      state: 'completed',
      text: '{"modules":[]}',
    });
    expect(rest).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'GET',
      path: 'agents.sandbox.attempt-status',
      query: {
        roomId: 'room-a',
        attemptId: 'agent-attempt-1',
      },
    }));
  });

  it('keeps the Native AI Chat state when the underlying Sandbox attempt cannot be observed', async () => {
    const rest = vi.fn<McpApp['rest']>()
      .mockResolvedValueOnce({
        messages: [{
          _id: 'message-1',
          sessionId: 'session-1',
          roomId: 'room-a',
          type: 'ai',
          status: 'sending',
          privosSandboxAttemptId: 'agent-attempt-1',
        }],
      } as never)
      .mockRejectedValueOnce(new Error('App is not permitted to call agents.sandbox.attempt-status'));
    const gateway = createNativeChatAiGateway(appWith({ rest }), 'room-a');

    await expect(gateway.status('native-chat:session-1:message-1')).resolves.toEqual({
      state: 'pending',
    });
  });

  it('fails closed for malformed attempt references and mismatched messages', async () => {
    const gateway = createNativeChatAiGateway(appWith({
      rest: vi.fn<McpApp['rest']>().mockResolvedValue({
        messages: [{
          _id: 'message-1',
          sessionId: 'session-1',
          roomId: 'another-room',
          type: 'ai',
          status: 'completed',
          content: '{"ok":true}',
        }],
      } as never),
    }), 'room-a');

    await expect(gateway.status('not-native')).rejects.toMatchObject({
      code: 'AI_RESPONSE_INVALID',
    });
    await expect(gateway.status('native-chat:session-1:message-1')).rejects.toMatchObject({
      code: 'AI_RESPONSE_INVALID',
    });
  });

  it('reports a completed message without content as terminal so cleanup can be confirmed', async () => {
    const gateway = createNativeChatAiGateway(appWith({
      rest: vi.fn<McpApp['rest']>().mockResolvedValue({
        messages: [{ _id: 'message-1', sessionId: 'session-1', roomId: 'room-a', type: 'ai', status: 'completed', content: '' }],
      } as never),
    }), 'room-a');

    await expect(gateway.status('native-chat:session-1:message-1')).resolves.toEqual({ state: 'completed' });
  });
});
