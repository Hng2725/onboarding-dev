import { describe, expect, it, vi } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { OnboardingApi } from '../src/ui/onboarding/api';

function toolResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

describe('OnboardingApi', () => {
  it('joins the installation bot to the current room before bootstrapping room data', async () => {
    const callServerTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'mcpapp.bot.joinCurrentRoom') {
        return toolResult({ joined: true, membershipStatus: 'member' });
      }
      return toolResult({
        role: 'learner',
        roomId: 'room-1',
        identity: { userId: 'user-1', username: 'learner' },
        capabilities: {
          canManageTemplates: false,
          canAssignMembers: false,
          canReview: false,
          canLearn: true,
          canUploadFiles: false,
          canGenerateWithAi: false,
          notifications: 'best_effort',
        },
        summary: { assignmentCount: 0, activeCount: 0, completedCount: 0 },
      });
    });
    const app = { callServerTool } as unknown as McpApp;

    const result = await new OnboardingApi(app).bootstrap();

    expect(result.role).toBe('learner');
    expect(callServerTool.mock.calls.map(([request]) => request)).toEqual([
      { name: 'mcpapp.bot.joinCurrentRoom', arguments: {} },
      { name: 'onboarding_bootstrap', arguments: { action: 'load' } },
    ]);
  });
});
