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

describe('OnboardingApi timeouts', () => {
  const longActions = [
    'next_step', 'submit_ai_output', 'approve_outline', 'update_module_lesson', 'update_module_questions',
    'retry_module', 'use_question_fallback', 'supplement_module_document', 'supplement_module_sources',
    'add_outline_module', 'list_module_sources', 'get_review', 'update_review',
  ];

  it('gives long-running AI actions a 120 s tool-call timeout', async () => {
    const callServerTool = vi.fn(async (_request: unknown) => toolResult({ ok: true }));
    const api = new OnboardingApi({ callServerTool } as unknown as McpApp);
    for (const action of longActions) await api.adminAi(action, { jobId: 'job-1' });
    expect(callServerTool.mock.calls.map(([request]) => request)).toEqual(longActions.map((action) => ({
      name: 'onboarding_admin_ai', arguments: { jobId: 'job-1', action }, timeoutMs: 120_000,
    })));
  });

  it('keeps the SDK default timeout for quick AI actions', async () => {
    const callServerTool = vi.fn(async (_request: unknown) => toolResult({ ok: true }));
    const api = new OnboardingApi({ callServerTool } as unknown as McpApp);
    await api.adminAi('get_job', { jobId: 'job-1' });
    expect(callServerTool.mock.calls[0]).toEqual([{ name: 'onboarding_admin_ai', arguments: { jobId: 'job-1', action: 'get_job' } }]);
  });
});
