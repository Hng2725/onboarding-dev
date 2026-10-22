import { describe, expect, it } from 'vitest';

import { INVALID_PARAMS, type VerifiedActor } from '@privos_ai/app-server';

import { requireAdmin, requireSelf, resolveOnboardingActor } from '../src/onboarding/auth';

function verified(
  claims: Readonly<Record<string, unknown>> = {},
  roomId: string | undefined | null = 'room-a',
): VerifiedActor {
  return {
    userId: 'user-1',
    username: 'lan.nguyen',
    roomId: roomId === null ? undefined : roomId,
    claims: Object.freeze(claims),
    provenance: 'user-token',
  };
}

describe('onboarding actor policy', () => {
  it.each([
    [{ room_roles: ['owner'] }, 'room owner'],
    [{ room_roles: ['moderator'] }, 'room moderator'],
    [{ workspace_roles: ['admin'] }, 'workspace admin'],
  ])('resolves %s as Admin', (claims) => {
    expect(resolveOnboardingActor(verified(claims))).toMatchObject({
      userId: 'user-1', roomId: 'room-a', access: 'admin',
    });
  });

  it.each([
    { room_roles: ['leader'] },
    { room_roles: ['member'] },
    { room_roles: [] },
    { room_roles: 'owner' },
    { room_roles: ['owner', 7] },
    { room_roles: ['unknown'], workspace_roles: ['guest'] },
  ])('fails closed to Learner for non-admin or malformed claims: %s', (claims) => {
    expect(resolveOnboardingActor(verified(claims)).access).toBe('learner');
  });

  it('rejects a missing verified identity', () => {
    expect(() => resolveOnboardingActor()).toThrowError(expect.objectContaining({
      code: INVALID_PARAMS, data: { code: 'IDENTITY_REQUIRED' },
    }));
  });

  it('rejects an identity that is not bound to a room', () => {
    expect(() => resolveOnboardingActor(verified({}, null))).toThrowError(expect.objectContaining({
      code: INVALID_PARAMS, data: { code: 'ROOM_UNBOUND' },
    }));
  });

  it.each([
    { room_roles: ['leader'] },
    { room_roles: ['member'] },
    {},
  ])('requires an explicit Admin role: %s', (claims) => {
    expect(() => requireAdmin(verified(claims))).toThrowError(expect.objectContaining({
      code: INVALID_PARAMS, data: { code: 'ADMIN_REQUIRED' },
    }));
  });

  it('allows only the verified member selector for Learner reads', () => {
    expect(requireSelf(verified(), undefined).userId).toBe('user-1');
    expect(requireSelf(verified(), 'user-1').userId).toBe('user-1');
    expect(() => requireSelf(verified(), 'user-2')).toThrowError(expect.objectContaining({
      code: INVALID_PARAMS, data: { code: 'MEMBER_FORBIDDEN' },
    }));
  });

  it('never lets a claim or requested room override the verified actor room', () => {
    const actor = verified({ roomId: 'room-b', room_roles: ['member'] });
    const resolveWithUntrustedExtraArgument = resolveOnboardingActor as (
      actor: VerifiedActor,
      requestedRoomId?: string,
    ) => ReturnType<typeof resolveOnboardingActor>;

    expect(resolveWithUntrustedExtraArgument(actor, 'room-c').roomId).toBe('room-a');
  });
});
