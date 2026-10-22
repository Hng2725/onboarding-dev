import { describe, expect, it, vi } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import {
  AssignmentServiceError,
  createAssignmentService,
} from '../src/onboarding/assignments';
import type { NotificationPort } from '../src/onboarding/notifications';
import { createTemplateService } from '../src/onboarding/templates';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };
const member: OnboardingActor = { userId: 'member-1', roomId: 'room-a', access: 'learner' };
const other: OnboardingActor = { userId: 'member-2', roomId: 'room-a', access: 'learner' };

function setup(notification?: NotificationPort) {
  let sequence = 0;
  const store = new MemoryOnboardingStore();
  const templates = createTemplateService(store, {
    id: () => `template-id-${++sequence}`,
    now: () => `2026-10-20T00:00:${String(++sequence).padStart(2, '0')}.000Z`,
  });
  const callPlatform = vi.fn().mockResolvedValue({
    members: [
      { userId: 'admin-1', username: 'admin' },
      { userId: 'member-1', username: 'lan' },
      { userId: 'member-2', username: 'minh' },
    ],
  });
  const notifications: NotificationPort = notification ?? {
    notify: vi.fn().mockResolvedValue({ delivered: true }),
  };
  const service = createAssignmentService(store, templates, {
    callPlatform,
    notifications,
    id: () => `assignment-id-${++sequence}`,
    now: () => '2026-10-20T00:00:00.000Z',
  });
  return { store, templates, callPlatform, notifications, service };
}

async function assignFoundation(service: ReturnType<typeof createAssignmentService>, overrides = {}) {
  return service.assign(admin, {
    memberId: 'member-1',
    employeeType: 'normal',
    templateId: 'privos-foundations',
    templateVersion: 1,
    dueAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  });
}

describe('onboarding assignment service', () => {
  it('assigns only current-room members and stores explicit classification/template identity', async () => {
    const { service, callPlatform } = setup();

    await expect(assignFoundation(service, { memberId: 'outsider' })).rejects.toMatchObject({
      code: 'MEMBER_NOT_FOUND',
    });
    const result = await assignFoundation(service);

    expect(result.assignment).toMatchObject({
      memberId: 'member-1',
      employeeType: 'normal',
      templateSource: 'system',
      templateId: 'privos-foundations',
      templateVersion: 1,
      status: 'assigned',
    });
    expect(callPlatform).toHaveBeenCalledWith('mcpapp.rooms.getMembers', { roomId: 'room-a' }, 'rooms:read', 'room-a');
  });

  it('returns an empty list for unassigned Learners and blocks guessed assignment IDs', async () => {
    const { service } = setup();

    await expect(service.listMine(member)).resolves.toEqual([]);
    await expect(service.getMine(member, 'guessed-id')).rejects.toMatchObject({ code: 'MEMBER_FORBIDDEN' });
  });

  it('projects learner list items with a useful title and progress without room-private fields', async () => {
    const { service } = setup();
    const { assignment } = await assignFoundation(service);

    const [item] = await service.listMine(member);

    expect(item).toMatchObject({
      id: assignment.id,
      templateTitle: 'Nền tảng sử dụng PrivOS',
      progressPercent: 0,
      assignedAt: assignment.assignedAt,
    });
    expect(item).not.toHaveProperty('roomId');
    expect(item).not.toHaveProperty('memberId');
    expect(item).not.toHaveProperty('assignedBy');
  });

  it('projects template title and material progress for the Admin assignment table', async () => {
    const { service } = setup();
    const { assignment } = await assignFoundation(service);
    const before = (await service.listAdmin(admin))[0];
    expect(before).toMatchObject({ templateTitle: 'Nền tảng sử dụng PrivOS', progressPercent: 0 });

    await service.markResourceOpened(member, assignment.id, 'foundations-resource-welcome');
    await service.markResourceCompleted(member, assignment.id, 'foundations-resource-welcome');

    expect((await service.listAdmin(admin))[0].progressPercent).toBeGreaterThan(0);
  });

  it('binds Learner selectors to the verified member identity', async () => {
    const { service } = setup();
    const { assignment } = await assignFoundation(service);

    await expect(service.getMine(member, assignment.id, 'member-1')).resolves.toMatchObject({
      assignment: { id: assignment.id },
    });
    await expect(service.getMine(member, assignment.id, 'member-2')).rejects.toMatchObject({
      code: 'MEMBER_FORBIDDEN',
    });
    await expect(service.getMine(other, assignment.id)).rejects.toMatchObject({ code: 'MEMBER_FORBIDDEN' });
  });

  it('requires an opened material before completion and keeps completion idempotent', async () => {
    const { service } = setup();
    const { assignment } = await assignFoundation(service);
    const resourceId = 'foundations-resource-welcome';

    await expect(service.markResourceCompleted(member, assignment.id, resourceId)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_OPENED',
    });
    await service.markResourceOpened(member, assignment.id, resourceId);
    const first = await service.markResourceCompleted(member, assignment.id, resourceId);
    const second = await service.markResourceCompleted(member, assignment.id, resourceId);

    expect(first.completedAt).toBeTruthy();
    expect(second).toEqual(first);
  });

  it('never lets optional resources block an otherwise-complete module', async () => {
    const { service, templates } = setup();
    const input = {
      title: 'Tài liệu tùy chọn', description: '', employeeType: 'normal' as const,
      modules: [{
        key: 'one', title: 'Một', description: '',
        resources: [
          { title: 'Bắt buộc', kind: 'link' as const, required: true, sourceUrl: 'https://docs.privos.ai/' },
          { title: 'Tùy chọn', kind: 'link' as const, required: false, sourceUrl: 'https://docs.privos.ai/' },
        ],
        questions: [{ type: 'essay' as const, prompt: 'Nêu hiểu biết', required: true }],
      }],
    };
    const draft = await templates.createDraft(admin, input);
    const published = await templates.publish(admin, draft.id, 1, draft.updatedAt);
    const { assignment } = await assignFoundation(service, {
      templateId: published.id, templateVersion: 1,
    });
    const detail = await service.getMine(member, assignment.id);
    const required = detail.template.modules[0].resources.find((item) => item.required)!;

    await service.markResourceOpened(member, assignment.id, required.id);
    await service.markResourceCompleted(member, assignment.id, required.id);

    expect((await service.getMine(member, assignment.id)).moduleUnlocks[detail.template.modules[0].id]).toBe(true);
  });

  it('pins the assigned published snapshot when a newer template version appears', async () => {
    const { service, templates } = setup();
    const draftInput = {
      title: 'Phiên bản gốc', description: '', employeeType: 'normal' as const,
      modules: [{
        key: 'one', title: 'Một', description: '',
        resources: [{ title: 'Đọc', kind: 'link' as const, required: true, sourceUrl: 'https://docs.privos.ai/' }],
        questions: [{ type: 'essay' as const, prompt: 'Trả lời', required: true }],
      }],
    };
    const draft = await templates.createDraft(admin, draftInput);
    const published = await templates.publish(admin, draft.id, 1, draft.updatedAt);
    const { assignment } = await assignFoundation(service, { templateId: draft.id, templateVersion: 1 });
    const next = await templates.updateDraft(admin, {
      templateId: draft.id, version: 1, expectedUpdatedAt: published.updatedAt,
      draft: { ...draftInput, title: 'Phiên bản mới' },
    });
    await templates.publish(admin, draft.id, 2, next.updatedAt);

    expect((await service.getMine(member, assignment.id)).template.title).toBe('Phiên bản gốc');
  });

  it('keeps a successful assignment when notification delivery fails', async () => {
    const notifications: NotificationPort = {
      notify: vi.fn().mockRejectedValue(new Error('push unavailable')),
    };
    const { service } = setup(notifications);

    const result = await assignFoundation(service);

    expect(result.assignment.id).toBeTruthy();
    expect(result.warning).toContain('push unavailable');
    expect(await service.listAdmin(admin)).toHaveLength(1);
  });

  it('sends explicit 48-hour reminders once per assignment per UTC day', async () => {
    const { service, notifications } = setup();
    await assignFoundation(service, { dueAt: '2026-10-21T12:00:00.000Z' });
    vi.mocked(notifications.notify).mockClear();

    const first = await service.sendDueReminders(admin, new Date('2026-10-20T00:00:00.000Z'));
    const second = await service.sendDueReminders(admin, new Date('2026-10-20T12:00:00.000Z'));

    expect(first).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(second).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('grants a new retry ordinal without removing prior attempts', async () => {
    const { service, store } = setup();
    const { assignment } = await assignFoundation(service);
    await store.create('room-a', 'onboarding_attempts', {
      assignmentId: assignment.id, memberId: 'member-1', ordinal: 1, status: 'reviewed',
    });

    const retried = await service.grantRetry(admin, assignment.id);
    const attempts = await store.query('room-a', 'onboarding_attempts', { filter: { assignmentId: assignment.id } });

    expect(retried).toMatchObject({ status: 'retry', allowedAttempts: 2 });
    expect(attempts.records).toHaveLength(1);
    expect(attempts.records[0]).toMatchObject({ ordinal: 1 });
  });

  it('uses typed assignment errors', () => {
    expect(new AssignmentServiceError('MEMBER_FORBIDDEN', 'denied')).toMatchObject({
      name: 'AssignmentServiceError', code: 'MEMBER_FORBIDDEN',
    });
  });
});
