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
