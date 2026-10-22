import { describe, expect, it, vi } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import {
  EmployeeServiceError,
  createEmployeeService,
} from '../src/onboarding/employees';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };
const learner: OnboardingActor = { userId: 'member-1', roomId: 'room-a', access: 'learner' };
const directory = {
  members: [
    { userId: 'admin-1', username: 'admin' },
    { userId: 'member-1', username: 'lan' },
    { _id: 'member-2', username: 'minh' },
  ],
};

function setup(memberResult: unknown = directory, store = new MemoryOnboardingStore()) {
  const callPlatform = vi.fn().mockResolvedValue(memberResult);
  const service = createEmployeeService(store, {
    callPlatform,
    now: () => '2026-10-22T08:00:00.000Z',
  });
  return { callPlatform, service, store };
}

describe('onboarding employee service', () => {
  it('adds one current-room member with an immutable classification', async () => {
    const { callPlatform, service } = setup();

    const employee = await service.add(admin, { memberId: ' member-1 ', employeeType: 'advanced' });

    expect(employee).toMatchObject({
      roomId: 'room-a', memberId: 'member-1', employeeType: 'advanced', addedBy: 'admin-1',
      addedAt: '2026-10-22T08:00:00.000Z',
    });
    expect(await service.list(admin)).toEqual([employee]);
    expect(callPlatform).toHaveBeenCalledWith(
      'mcpapp.rooms.getMembers', { roomId: 'room-a' }, 'rooms:read', 'room-a',
    );
  });

  it('rejects outsiders, non-admin callers, and duplicate members with typed errors', async () => {
    const { service } = setup();

    await expect(service.add(learner, { memberId: 'member-1', employeeType: 'normal' }))
      .rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    await expect(service.add(admin, { memberId: 'outsider', employeeType: 'normal' }))
      .rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    await expect(service.add(admin, { memberId: 'member-1', employeeType: 'unsupported' as 'normal' }))
      .rejects.toMatchObject({ code: 'EMPLOYEE_TYPE_INVALID' });

    await service.add(admin, { memberId: 'member-1', employeeType: 'normal' });
    await expect(service.add(admin, { memberId: 'member-1', employeeType: 'advanced' }))
      .rejects.toMatchObject({ code: 'EMPLOYEE_ALREADY_EXISTS' });
  });

  it('maps an E11000 create race to EMPLOYEE_ALREADY_EXISTS', async () => {
    const store = new MemoryOnboardingStore();
    const originalCreate = store.create.bind(store);
    vi.spyOn(store, 'create').mockImplementation(async (roomId, collection, data, operationId) => {
      if (collection === 'onboarding_employees') {
        throw new Error('E11000 duplicate key error collection: onboarding_employees index: memberId_1');
      }
      return originalCreate(roomId, collection, data, operationId);
    });
    const { service } = setup(directory, store);

    const result = service.add(admin, { memberId: 'member-1', employeeType: 'normal' });

    await expect(result).rejects.toMatchObject({ code: 'EMPLOYEE_ALREADY_EXISTS' });
    await expect(result).rejects.not.toThrow(/E11000/);
  });

  it('reconciles legacy assignments once and uses the newest assignment classification', async () => {
    const { service, store } = setup();
    await store.create('room-a', 'onboarding_assignments', {
      memberId: 'member-1', employeeType: 'normal', assignedBy: 'admin-old',
      assignedAt: '2026-10-20T08:00:00.000Z', templateId: 'basic', templateVersion: 1,
    });
    await store.create('room-a', 'onboarding_assignments', {
      memberId: 'member-1', employeeType: 'advanced', assignedBy: 'admin-new',
      assignedAt: '2026-10-21T08:00:00.000Z', templateId: 'advanced', templateVersion: 1,
    });
    await store.create('room-a', 'onboarding_assignments', {
      memberId: 'member-2', employeeType: 'normal', assignedBy: 'admin-old',
      assignedAt: '2026-10-19T08:00:00.000Z', templateId: 'basic', templateVersion: 1,
    });
    const before = await store.query('room-a', 'onboarding_assignments', { limit: 1000 });

    const first = await service.list(admin);
    const second = await service.list(admin);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first.find((item) => item.memberId === 'member-1')).toMatchObject({
      employeeType: 'advanced', addedBy: 'admin-new', addedAt: '2026-10-21T08:00:00.000Z',
    });
    expect((await store.query('room-a', 'onboarding_employees', { limit: 1000 })).records).toHaveLength(2);
    expect(await store.query('room-a', 'onboarding_assignments', { limit: 1000 })).toEqual(before);
  });

  it('lists employee profiles across every store page', async () => {
    const store = new MemoryOnboardingStore(1);
    const { service } = setup(directory, store);
    for (const [memberId, employeeType] of [['member-1', 'normal'], ['member-2', 'advanced']] as const) {
      await store.create('room-a', 'onboarding_employees', {
        memberId,
        employeeType,
        addedBy: 'admin-1',
        addedAt: `2026-10-22T08:00:0${memberId === 'member-1' ? '1' : '2'}.000Z`,
        createdAt: '2026-10-22T08:00:00.000Z',
        updatedAt: '2026-10-22T08:00:00.000Z',
      });
    }

    await expect(service.list(admin)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: 'member-1' }),
      expect.objectContaining({ memberId: 'member-2' }),
    ]));
  });

  it('reconciles legacy assignments across every store page', async () => {
    const store = new MemoryOnboardingStore(1);
    const { service } = setup(directory, store);
    await store.create('room-a', 'onboarding_assignments', {
      memberId: 'member-1', employeeType: 'normal', assignedBy: 'admin-1',
      assignedAt: '2026-10-20T08:00:00.000Z', templateId: 'basic', templateVersion: 1,
    });
    await store.create('room-a', 'onboarding_assignments', {
      memberId: 'member-2', employeeType: 'advanced', assignedBy: 'admin-1',
      assignedAt: '2026-10-21T08:00:00.000Z', templateId: 'advanced', templateVersion: 1,
    });

    await expect(service.list(admin)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: 'member-1' }),
      expect.objectContaining({ memberId: 'member-2' }),
    ]));
  });

  it('keeps a reconciled profile when the legacy member is no longer in the room directory', async () => {
    const { service, store } = setup({ members: [{ userId: 'admin-1' }] });
    await store.create('room-a', 'onboarding_assignments', {
      memberId: 'departed-member', employeeType: 'normal', assignedBy: 'admin-1',
      assignedAt: '2026-10-20T08:00:00.000Z', templateId: 'basic', templateVersion: 1,
    });

    await expect(service.list(admin)).resolves.toEqual([
      expect.objectContaining({ memberId: 'departed-member', employeeType: 'normal' }),
    ]);
    await expect(service.getByMemberId(admin, 'departed-member')).resolves.toMatchObject({
      memberId: 'departed-member', employeeType: 'normal',
    });
  });

  it('uses typed employee errors', () => {
    expect(new EmployeeServiceError('EMPLOYEE_NOT_FOUND', 'missing')).toMatchObject({
      name: 'EmployeeServiceError', code: 'EMPLOYEE_NOT_FOUND',
    });
  });
});
