import { describe, expect, it } from 'vitest';
import type { ApplicationMcpRequest, ToolCallContext, VerifiedActor } from '@privos_ai/app-server';

import { relayMcpHandler } from '../src/relay-transport';

function actorProbeRequest(id = 1): ApplicationMcpRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'onboarding_learning', arguments: { action: 'list', memberId: 'probe-other-user' } },
  };
}

function baseContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    transport: 'relay',
    identityState: 'missing',
    sessionScope: 'test-scope',
    ...overrides,
  };
}

describe('relayMcpHandler actor wiring', () => {
  it('forwards a verified relay actor to onboarding authorization', async () => {
    const actor: VerifiedActor = Object.freeze({
      userId: 'user-1',
      username: 'techcomthanh',
      roomId: 'room-1',
      claims: Object.freeze({ sub: 'user-1', rid: 'room-1' }),
      provenance: 'user-token',
    });
    const context = baseContext({ identityState: 'verified', actor, roomId: 'room-1' });

    await expect(relayMcpHandler(actorProbeRequest(), context))
      .rejects.toMatchObject({ data: { code: 'MEMBER_FORBIDDEN' } });
  });

  it('rejects onboarding when no token was presented', async () => {
    await expect(relayMcpHandler(actorProbeRequest(), baseContext({ identityState: 'missing' })))
      .rejects.toMatchObject({ data: { code: 'IDENTITY_REQUIRED' } });
  });

  it('rejects onboarding when token verification failed', async () => {
    await expect(relayMcpHandler(actorProbeRequest(), baseContext({ identityState: 'invalid' })))
      .rejects.toMatchObject({ data: { code: 'IDENTITY_REQUIRED' } });
  });

  it('never falls back to plain unverified _meta.privosUser fields', async () => {
    const request: ApplicationMcpRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'onboarding_learning',
        arguments: { action: 'list', memberId: 'attacker-claimed-id' },
        _meta: { privosUser: { userId: 'attacker-claimed-id', username: 'root', userToken: 'not-a-real-jwt' } },
      },
    };

    const error = await relayMcpHandler(request, baseContext({ identityState: 'invalid' })).catch((caught) => caught);
    expect(error).toMatchObject({ data: { code: 'IDENTITY_REQUIRED' } });
    expect(JSON.stringify(error)).not.toContain('attacker-claimed-id');
    expect(JSON.stringify(error)).not.toContain('root');
  });
});
