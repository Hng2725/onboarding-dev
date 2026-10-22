import { INVALID_PARAMS, type VerifiedActor } from '@privos_ai/app-server';

import { requireVerifiedActor, resolveCallerRoom } from '../caller-room';

export interface OnboardingActor {
  readonly userId: string;
  readonly username?: string;
  readonly roomId: string;
  readonly access: 'admin' | 'learner';
}

// `basic:information` supplies the approved installation and room context.
// `rooms:roles:read` authorizes the Hub to attach these signed role claims.
// `rooms:read` is consumed by AssignmentService for current-room member validation.

function denied(message: string, code: string): Error {
  return Object.assign(new Error(message), { code: INVALID_PARAMS, data: { code } });
}

function rolesFrom(claims: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const candidate = claims[key];
  if (!Array.isArray(candidate) || !candidate.every((value) => typeof value === 'string')) return [];
  return candidate.map((role) => role.trim().toLowerCase()).filter(Boolean);
}

export function resolveOnboardingActor(actor?: VerifiedActor): OnboardingActor {
  const verified = requireVerifiedActor(actor);
  const roomId = resolveCallerRoom(verified);
  const roomRoles = rolesFrom(verified.claims, 'room_roles');
  const workspaceRoles = rolesFrom(verified.claims, 'workspace_roles');
  const access = roomRoles.some((role) => role === 'owner' || role === 'moderator')
    || workspaceRoles.includes('admin')
    ? 'admin'
    : 'learner';

  return {
    userId: verified.userId,
    username: verified.username,
    roomId,
    access,
  };
}

export function requireAdmin(actor?: VerifiedActor): OnboardingActor {
  const resolved = resolveOnboardingActor(actor);
  if (resolved.access !== 'admin') {
    throw denied('Request denied: room owner, moderator, or workspace admin access is required.', 'ADMIN_REQUIRED');
  }
  return resolved;
}

export function requireSelf(actor: VerifiedActor | undefined, requestedMemberId?: string): OnboardingActor {
  const resolved = resolveOnboardingActor(actor);
  const requested = requestedMemberId?.trim();
  if (requested && requested !== resolved.userId) {
    throw denied('Request denied: learners may access only their own onboarding records.', 'MEMBER_FORBIDDEN');
  }
  return resolved;
}
