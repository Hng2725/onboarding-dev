import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedActor } from '@privos_ai/app-server';

const callAppPlatformTool = vi.hoisted(() => vi.fn());
vi.mock('../src/app-platform-tool-call', () => ({ callAppPlatformTool }));

import { handleMcpMessage } from '../src/mcp-message-handlers';
import { relayMcpHandler } from '../src/relay-transport';

const TOOLS = [
  ['hr_app_db_store', { action: 'query' }],
  ['hr_app_object_store', { action: 'head', digest: `sha256:${'a'.repeat(64)}` }],
  ['hr_bulk_export', { records: [{ id: 1 }] }],
] as const;

function actorIn(roomId: string | undefined): VerifiedActor {
  return { userId: 'user-1', roomId, claims: Object.freeze({}), provenance: 'user-token' };
}

function call(name: string, args: Record<string, unknown>, actor?: VerifiedActor) {
  return handleMcpMessage('tools/call', 1, { name, arguments: args }, actor);
}

describe('bot-credential tools are bound to the verified caller room', () => {
  beforeEach(() => {
    callAppPlatformTool.mockReset();
    callAppPlatformTool.mockResolvedValue({ ok: true });
    process.env.PRIVOS_APP_LICENSE = '{"tier":"pro","state":"active"}';
  });

  afterEach(() => {
    delete process.env.PRIVOS_APP_LICENSE;
  });

  it.each(TOOLS)('%s refuses a call with no verified actor', async (name, args) => {
    await expect(call(name, args)).rejects.toMatchObject({ data: { code: 'IDENTITY_REQUIRED' } });
    expect(callAppPlatformTool).not.toHaveBeenCalled();
  });

  it.each([
    ['hr_app_db_store', { action: 'query', roomId: 'room-b' }],
    ['hr_app_object_store', { action: 'head', roomId: 'room-b', digest: `sha256:${'a'.repeat(64)}` }],
  ])('%s rejects a roomId that differs from the actor room', async (name, args) => {
    await expect(call(name, args, actorIn('room-a'))).rejects.toMatchObject({ data: { code: 'ROOM_FORBIDDEN' } });
    expect(callAppPlatformTool).not.toHaveBeenCalled();
  });

  it('rejects the call when the actor carries no room', async () => {
    await expect(call('hr_app_db_store', { action: 'query' }, actorIn(undefined))).rejects.toMatchObject({
      data: { code: 'ROOM_UNBOUND' },
    });
    expect(callAppPlatformTool).not.toHaveBeenCalled();
  });

  it('uses the actor room when roomId is absent or blank', async () => {
    await call('hr_app_db_store', { action: 'query' }, actorIn('room-a'));
    await call('hr_app_db_store', { action: 'query', roomId: '  ' }, actorIn('room-a'));
    expect(callAppPlatformTool.mock.calls.map((c) => c[3])).toEqual(['room-a', 'room-a']);
  });

  it('accepts a roomId equal to the actor room, for both tools', async () => {
    await call('hr_app_db_store', { action: 'query', roomId: 'room-a' }, actorIn('room-a'));
    await call(
      'hr_app_object_store',
      { action: 'head', roomId: ' room-a ', digest: `sha256:${'a'.repeat(64)}` },
      actorIn('room-a'),
    );
    expect(callAppPlatformTool.mock.calls.map((c) => c[3])).toEqual(['room-a', 'room-a']);
  });

  it('runs hr_bulk_export for a verified actor', async () => {
    const result = await call('hr_bulk_export', { records: [{ id: 1 }] }, actorIn('room-a'));
    expect(JSON.parse(result.content[0].text).exported).toBe(1);
  });

  it('relay adapter drops an actor whose identity is not verified', async () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'hr_app_db_store', arguments: { action: 'query', roomId: 'room-a' } },
    };
    const context = { transport: 'relay' as const, identityState: 'invalid' as const, sessionScope: 's', actor: actorIn('room-a') };
    await expect(relayMcpHandler(request, context)).rejects.toMatchObject({ data: { code: 'IDENTITY_REQUIRED' } });
    expect(callAppPlatformTool).not.toHaveBeenCalled();
  });
});
