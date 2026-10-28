import { describe, expect, it, vi } from 'vitest';
import type { VerifiedActor } from '@privos_ai/app-server';

import { handleMcpMessage } from '../src/mcp-message-handlers';

const TOOL_NAMES = [
  'onboarding_dashboard',
  'onboarding_bootstrap',
  'onboarding_admin_templates',
  'onboarding_admin_ai',
  'onboarding_admin_assignments',
  'onboarding_learning',
  'onboarding_reviews',
];

function callerIn(roomId: string): VerifiedActor {
  return {
    userId: 'member-1',
    username: 'learner.minh',
    roomId,
    claims: Object.freeze({ room_roles: ['member'] }),
    provenance: 'user-token',
  };
}

describe('JSON-RPC onboarding handlers', () => {
  it('initializes and exposes exactly the seven onboarding tools', async () => {
    const initialized = await handleMcpMessage('initialize', 1, {});
    expect(initialized.serverInfo).toMatchObject({
      name: 'ai.privos.mcp-app-onboarding-dev',
      title: 'PrivOS Onboarding MCP App (Dev)',
    });

    const listed = await handleMcpMessage('tools/list', 2, {});
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOL_NAMES);
    expect(listed.tools.find((tool: { name: string }) => tool.name === 'onboarding_dashboard')._meta.ui.resourceUri)
      .toBe('ui://ai.privos.mcp-app-onboarding-dev/form.html');
  });

  it('wraps every data-tool success as JSON text and forwards only the verified actor', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, assignments: [] });
    const actor = callerIn('room-a');

    const result = await handleMcpMessage(
      'tools/call',
      3,
      { name: 'onboarding_learning', arguments: { action: 'list', memberId: 'untrusted' } },
      actor,
      handler,
    );

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, assignments: [] }) }],
    });
    expect(handler).toHaveBeenCalledWith(
      'onboarding_learning',
      { action: 'list', memberId: 'untrusted' },
      actor,
    );
  });

  it('preserves machine-readable tool errors and rejects unknown tools', async () => {
    const coded = Object.assign(new Error('blocked'), {
      code: -32602,
      data: { code: 'ADMIN_REQUIRED' },
    });
    const handler = vi.fn().mockRejectedValue(coded);

    await expect(handleMcpMessage(
      'tools/call', 4, { name: 'onboarding_admin_templates', arguments: { action: 'list' } }, callerIn('room-a'), handler,
    )).rejects.toBe(coded);

    await expect(handleMcpMessage('tools/call', 5, { name: 'old_demo_tool', arguments: {} }))
      .rejects.toMatchObject({ data: { code: 'TOOL_NOT_FOUND' } });
  });
});
