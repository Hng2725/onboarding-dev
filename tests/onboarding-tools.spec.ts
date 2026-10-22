import { describe, expect, it, vi } from 'vitest';
import type { VerifiedActor } from '@privos_ai/app-server';

import {
  DATA_TOOL_NAMES,
  createOnboardingToolHandler,
  type OnboardingServiceBundle,
} from '../src/onboarding/tools';

function verified(
  claims: Readonly<Record<string, unknown>> = { room_roles: ['member'] },
  userId = 'member-1',
): VerifiedActor {
  return {
    userId,
    username: userId === 'admin-1' ? 'admin.lan' : 'learner.minh',
    roomId: 'room-a',
    claims: Object.freeze(claims),
    provenance: 'user-token',
  };
}

function services(): OnboardingServiceBundle {
  return {
    prepare: vi.fn().mockResolvedValue(undefined),
    listRoomMembers: vi.fn().mockResolvedValue([{ userId: 'member-1', username: 'learner.minh' }]),
    employees: {
      list: vi.fn().mockResolvedValue([{ id: 'employee-1', memberId: 'member-1', employeeType: 'normal' }]),
      getByMemberId: vi.fn(),
      add: vi.fn().mockResolvedValue({ id: 'employee-2', memberId: 'member-2', employeeType: 'advanced' }),
    },
    templates: {
      list: vi.fn().mockResolvedValue([{ id: 'privos-foundations', version: 1 }]),
      getAdminDetail: vi.fn(), getLearnerSnapshot: vi.fn(), createDraft: vi.fn(), updateDraft: vi.fn(),
      cloneSystemTemplate: vi.fn(), publish: vi.fn(), archive: vi.fn(), deleteDraft: vi.fn(),
    },
    assignments: {
      listAdmin: vi.fn().mockResolvedValue([{ id: 'assignment-1', status: 'awaiting_evaluation' }]),
      getAdminDetail: vi.fn(),
      listMine: vi.fn().mockResolvedValue([{ id: 'assignment-1', status: 'in_progress' }]),
      getMine: vi.fn(), assign: vi.fn(), markResourceOpened: vi.fn(), markResourceCompleted: vi.fn(),
      grantRetry: vi.fn(), sendDueReminders: vi.fn(),
    },
    attempts: {
      getOrCreateDraft: vi.fn(), saveDraft: vi.fn(), submit: vi.fn(), getLearnerResult: vi.fn(),
    },
    reviews: {
      listEssayQueue: vi.fn().mockResolvedValue([{ answerId: 'answer-1', reviewed: false }]),
      saveEssayFeedback: vi.fn(),
      listEvaluationQueue: vi.fn().mockResolvedValue([{ attemptId: 'attempt-1' }]),
      publishEvaluation: vi.fn(), getPublishedFeedback: vi.fn(),
    },
  };
}

describe('onboarding tool dispatcher', () => {
  it('rejects missing and unknown actions for every data tool before touching services', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified();

    for (const name of DATA_TOOL_NAMES) {
      await expect(handle(name, {}, actor)).rejects.toMatchObject({ data: { code: 'ACTION_REQUIRED' } });
      await expect(handle(name, { action: 'not-real' }, actor)).rejects.toMatchObject({ data: { code: 'ACTION_INVALID' } });
    }

    expect(bundle.prepare).not.toHaveBeenCalled();
    expect(bundle.assignments.listMine).not.toHaveBeenCalled();
    expect(bundle.templates.list).not.toHaveBeenCalled();
  });

  it('returns verified identity, room, capabilities, and an Admin summary from bootstrap', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const result = await handle(
      'onboarding_bootstrap',
      { action: 'load' },
      verified({ room_roles: ['owner'] }, 'admin-1'),
    );

    expect(result).toMatchObject({
      role: 'admin',
      roomId: 'room-a',
      identity: { userId: 'admin-1', username: 'admin.lan' },
      capabilities: { canManageTemplates: true, canAssignMembers: true, canReview: true, canLearn: true },
      summary: { assignmentCount: 1, pendingEssayCount: 1, pendingEvaluationCount: 1 },
    });
    expect(bundle.prepare).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-a', access: 'admin' }));
  });

  it('uses authoritative room membership roles when the signed actor has no role claims', async () => {
    const bundle = services();
    vi.mocked(bundle.listRoomMembers).mockResolvedValue([
      { userId: 'admin-1', username: 'admin.lan', roles: ['owner'] },
      { userId: 'member-1', username: 'learner.minh', roles: ['leader'] },
    ]);
    const handle = createOnboardingToolHandler(() => bundle);
    const actorWithoutRoleClaims = verified({ sub: 'admin-1', rid: 'room-a' }, 'admin-1');

    await expect(handle('onboarding_bootstrap', { action: 'load' }, actorWithoutRoleClaims))
      .resolves.toMatchObject({ role: 'admin', capabilities: { canManageTemplates: true } });
    await expect(handle('onboarding_admin_templates', { action: 'list' }, actorWithoutRoleClaims))
      .resolves.toMatchObject({ templates: [{ id: 'privos-foundations', version: 1 }] });

    expect(bundle.listRoomMembers).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1', roomId: 'room-a', access: 'learner',
    }));
    expect(bundle.prepare).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1', roomId: 'room-a', access: 'admin',
    }));
  });

  it('returns only the verified Learner summary for members and leaders', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const result = await handle(
      'onboarding_bootstrap',
      { action: 'load' },
      verified({ room_roles: ['leader'] }),
    );

    expect(result).toMatchObject({
      role: 'learner',
      roomId: 'room-a',
      capabilities: { canManageTemplates: false, canAssignMembers: false, canReview: false, canLearn: true },
      summary: { assignmentCount: 1, activeCount: 1, completedCount: 0 },
    });
    expect(bundle.assignments.listMine).toHaveBeenCalledWith(expect.objectContaining({ userId: 'member-1' }));
    expect(bundle.assignments.listAdmin).not.toHaveBeenCalled();
  });

  it('rejects member and leader Admin calls before any service/store call', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);

    await expect(handle('onboarding_admin_templates', { action: 'list' }, verified()))
      .rejects.toMatchObject({ data: { code: 'ADMIN_REQUIRED' } });
    await expect(handle('onboarding_admin_assignments', { action: 'list' }, verified({ room_roles: ['leader'] })))
      .rejects.toMatchObject({ data: { code: 'ADMIN_REQUIRED' } });

    expect(bundle.prepare).not.toHaveBeenCalled();
    expect(bundle.templates.list).not.toHaveBeenCalled();
    expect(bundle.assignments.listAdmin).not.toHaveBeenCalled();
  });

  it('dispatches employee list and add actions with the verified Admin actor', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);
    const actor = verified({ room_roles: ['owner'] }, 'admin-1');

    await expect(handle('onboarding_admin_assignments', { action: 'list_employees' }, actor))
      .resolves.toMatchObject({ employees: [{ memberId: 'member-1' }] });
    await expect(handle('onboarding_admin_assignments', {
      action: 'add_employee', memberId: 'member-2', employeeType: 'advanced',
    }, actor)).resolves.toMatchObject({ employee: { memberId: 'member-2', employeeType: 'advanced' } });

    expect(bundle.employees.list).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', access: 'admin' }));
    expect(bundle.employees.add).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1', access: 'admin' }),
      { memberId: 'member-2', employeeType: 'advanced' },
    );
  });

  it('rejects Learners before employee Admin actions reach the service', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);

    await expect(handle('onboarding_admin_assignments', {
      action: 'add_employee', memberId: 'member-2', employeeType: 'advanced',
    }, verified())).rejects.toMatchObject({ data: { code: 'ADMIN_REQUIRED' } });
    expect(bundle.employees.add).not.toHaveBeenCalled();
  });

  it('binds Learner selectors to the verified member before service dispatch', async () => {
    const bundle = services();
    const handle = createOnboardingToolHandler(() => bundle);

    await expect(handle('onboarding_learning', { action: 'list', memberId: 'member-2' }, verified()))
      .rejects.toMatchObject({ data: { code: 'MEMBER_FORBIDDEN' } });
    expect(bundle.prepare).not.toHaveBeenCalled();
    expect(bundle.assignments.listMine).not.toHaveBeenCalled();

    await handle('onboarding_learning', { action: 'list', memberId: 'member-1' }, verified());
    expect(bundle.assignments.listMine).toHaveBeenCalledWith(expect.objectContaining({ userId: 'member-1' }));
  });

  it('preserves service error codes as machine-readable MCP error data', async () => {
    const bundle = services();
    vi.mocked(bundle.attempts.submit).mockRejectedValue(Object.assign(new Error('operation reused'), {
      code: 'OPERATION_CONFLICT',
    }));
    const handle = createOnboardingToolHandler(() => bundle);

    await expect(handle('onboarding_learning', {
      action: 'submit', assignmentId: 'assignment-1', operationId: 'op-1',
    }, verified())).rejects.toMatchObject({
      message: 'operation reused',
      data: { code: 'OPERATION_CONFLICT' },
    });
  });
});
