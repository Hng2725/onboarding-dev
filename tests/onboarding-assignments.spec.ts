import { describe, expect, it, vi } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import {
  AssignmentServiceError,
  createAssignmentService,
} from '../src/onboarding/assignments';
import { createEmployeeService } from '../src/onboarding/employees';
import type { NotificationPort } from '../src/onboarding/notifications';
import type { StoreQueryOptions, StoreRecord } from '../src/onboarding/store';
import { createTemplateService } from '../src/onboarding/templates';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };
const member: OnboardingActor = { userId: 'member-1', roomId: 'room-a', access: 'learner' };
const other: OnboardingActor = { userId: 'member-2', roomId: 'room-a', access: 'learner' };
const defaultMemberResult = {
  members: [
    { userId: 'admin-1', username: 'admin' },
    { userId: 'member-1', username: 'lan' },
    { userId: 'member-2', username: 'minh' },
  ],
};

class ConcurrentAssignmentStore extends MemoryOnboardingStore {
  readonly assignmentOperationIds: Array<string | undefined> = [];
  private exactReads = 0;
  private releaseFirstRead: (() => void) | undefined;
  private readonly createsByOperation = new Map<string, Promise<StoreRecord>>();

  override async query<T extends StoreRecord>(
    roomId: string,
    collection: string,
    options: StoreQueryOptions = {},
  ): Promise<{ records: readonly T[]; nextCursor?: string }> {
    if (
      collection === 'onboarding_assignments'
      && options.filter?.memberId
      && options.filter?.templateId
      && options.filter?.templateVersion
      && this.exactReads < 2
    ) {
      this.exactReads += 1;
      if (this.exactReads === 1) {
        await new Promise<void>((resolve) => { this.releaseFirstRead = resolve; });
      } else {
        this.releaseFirstRead?.();
      }
      return { records: [] };
    }
    return super.query<T>(roomId, collection, options);
  }

  override async create<T extends StoreRecord>(
    roomId: string,
    collection: string,
    data: StoreRecord,
    operationId?: string,
  ): Promise<T> {
    if (collection === 'onboarding_assignments') this.assignmentOperationIds.push(operationId);
    if (!operationId) return super.create<T>(roomId, collection, data, operationId);
    const operationKey = `${collection}:${operationId}`;
    const existing = this.createsByOperation.get(operationKey);
    if (existing) return existing as Promise<T>;
    const creation = super.create<StoreRecord>(roomId, collection, data, operationId);
    this.createsByOperation.set(operationKey, creation);
    return creation as Promise<T>;
  }
}

function setup(
  notification?: NotificationPort,
  memberResult: unknown = defaultMemberResult,
  store = new MemoryOnboardingStore(),
) {
  let sequence = 0;
  const templates = createTemplateService(store, {
    id: () => `template-id-${++sequence}`,
    now: () => `2026-10-20T00:00:${String(++sequence).padStart(2, '0')}.000Z`,
  });
  const callPlatform = vi.fn().mockResolvedValue(memberResult);
  const employees = createEmployeeService(store, {
    callPlatform,
    now: () => '2026-10-20T00:00:00.000Z',
  });
  const notifications: NotificationPort = notification ?? {
    notify: vi.fn().mockResolvedValue({ delivered: true }),
  };
  const service = createAssignmentService(store, templates, {
    callPlatform,
    employees,
    notifications,
    id: () => `assignment-id-${++sequence}`,
    now: () => '2026-10-20T00:00:00.000Z',
  });
  return { store, templates, employees, callPlatform, notifications, service: Object.assign(service, { employees }) };
}

async function assignFoundation(service: ReturnType<typeof setup>['service'], overrides: Record<string, unknown> = {}) {
  const memberId = typeof overrides.memberId === 'string' ? overrides.memberId : 'member-1';
  try {
    await service.employees.getByMemberId(admin, memberId);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EMPLOYEE_NOT_FOUND')) throw error;
    await service.employees.add(admin, { memberId, employeeType: 'normal' });
  }
  return service.assign(admin, {
    memberId,
    templateId: 'privos-foundations',
    templateVersion: 1,
    dueAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  });
}

describe('onboarding assignment service', () => {
  it('rejects assignment for a member without an employee profile', async () => {
    const { service } = setup();

    await expect(service.assign(admin, {
      memberId: 'member-1', templateId: 'privos-foundations', templateVersion: 1,
    })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' });
  });

  it('derives employee classification and rejects a mismatched template', async () => {
    const { employees, service } = setup();
    await employees.add(admin, { memberId: 'member-1', employeeType: 'advanced' });

    await expect(service.assign(admin, {
      memberId: 'member-1', templateId: 'privos-foundations', templateVersion: 1,
    })).rejects.toMatchObject({ code: 'TEMPLATE_MISMATCH' });
    await expect(service.assign(admin, {
      memberId: 'member-1', templateId: 'privos-advanced', templateVersion: 1,
    })).resolves.toMatchObject({ assignment: { employeeType: 'advanced', templateId: 'privos-advanced' } });
  });

  it('assigns multiple distinct templates to one employee', async () => {
    const context = setup();
    await assignFoundation(context.service);
    const draft = await context.templates.createDraft(admin, {
      title: 'Quy trình nội bộ', description: '', employeeType: 'normal',
      modules: [{
        key: 'process', title: 'Quy trình', description: '',
        resources: [{ title: 'Đọc', kind: 'link', required: true, sourceUrl: 'https://docs.privos.ai/' }],
        questions: [{ type: 'essay', prompt: 'Tóm tắt quy trình', required: true }],
      }],
    });
    await context.templates.publish(admin, draft.id, 1, draft.updatedAt);

    await expect(context.service.assign(admin, {
      memberId: 'member-1', templateId: draft.id, templateVersion: 1,
    })).resolves.toMatchObject({ assignment: { memberId: 'member-1', templateId: draft.id } });
    await expect(context.service.listAdmin(admin)).resolves.toHaveLength(2);
  });

  it('blocks an exact template version duplicate but allows a newer version', async () => {
    const context = setup();
    await context.employees.add(admin, { memberId: 'member-1', employeeType: 'normal' });
    const input = {
      title: 'Chính sách', description: '', employeeType: 'normal' as const,
      modules: [{
        key: 'policy', title: 'Chính sách', description: '',
        resources: [{ title: 'Đọc', kind: 'link' as const, required: true, sourceUrl: 'https://docs.privos.ai/' }],
        questions: [{ type: 'essay' as const, prompt: 'Tóm tắt', required: true }],
      }],
    };
    const draft = await context.templates.createDraft(admin, input);
    const published = await context.templates.publish(admin, draft.id, 1, draft.updatedAt);
    await context.service.assign(admin, { memberId: 'member-1', templateId: draft.id, templateVersion: 1 });

    await expect(context.service.assign(admin, {
      memberId: 'member-1', templateId: draft.id, templateVersion: 1,
    })).rejects.toMatchObject({ code: 'ASSIGNMENT_ALREADY_EXISTS' });

    const next = await context.templates.updateDraft(admin, {
      templateId: draft.id, version: 1, expectedUpdatedAt: published.updatedAt,
      draft: { ...input, title: 'Chính sách cập nhật' },
    });
    await context.templates.publish(admin, draft.id, 2, next.updatedAt);
    await expect(context.service.assign(admin, {
      memberId: 'member-1', templateId: draft.id, templateVersion: 2,
    })).resolves.toMatchObject({ assignment: { templateId: draft.id, templateVersion: 2 } });
  });

  it('uses one idempotent assignment operation when concurrent requests pass the duplicate precheck', async () => {
    const store = new ConcurrentAssignmentStore();
    const notifications: NotificationPort = {
      notify: vi.fn().mockResolvedValue({ delivered: true }),
    };
    const context = setup(notifications, defaultMemberResult, store);
    await context.employees.add(admin, { memberId: 'member-1', employeeType: 'normal' });
    const input = { memberId: 'member-1', templateId: 'privos-foundations', templateVersion: 1 };

    const [first, second] = await Promise.all([
      context.service.assign(admin, input),
      context.service.assign(admin, input),
    ]);

    expect(first.assignment.id).toBe(second.assignment.id);
    expect((await store.query('room-a', 'onboarding_assignments', { limit: 10 })).records).toHaveLength(1);
    expect(store.assignmentOperationIds).toEqual([
      'assignment:member-1:privos-foundations:1',
      'assignment:member-1:privos-foundations:1',
    ]);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const audits = await store.query('room-a', 'onboarding_audit_events', { limit: 10 });
    expect(audits.records).toHaveLength(1);
    expect(audits.records[0]).toMatchObject({
      action: 'assignment.created',
      operationId: 'audit:assignment:member-1:privos-foundations:1',
    });
  });

  it('keeps a departed employee profile for history but blocks a new assignment', async () => {
    const context = setup();
    await context.employees.add(admin, { memberId: 'member-1', employeeType: 'normal' });
    context.callPlatform.mockResolvedValue({ members: [{ userId: 'admin-1' }] });

    await expect(context.service.assign(admin, {
      memberId: 'member-1', templateId: 'privos-foundations', templateVersion: 1,
    })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
  });

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

  it('assigns a room member identified by the platform _id field', async () => {
    const { service } = setup(undefined, {
      members: [{ _id: 'member-1', username: 'lan' }],
    });

    await expect(assignFoundation(service)).resolves.toMatchObject({
      assignment: { memberId: 'member-1' },
    });
  });

  it('assigns a room member when the platform returns a top-level member array', async () => {
    const { service } = setup(undefined, [{ id: 'member-1', username: 'lan' }]);

    await expect(assignFoundation(service)).resolves.toMatchObject({
      assignment: { memberId: 'member-1' },
    });
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

  it('writes a unique operation ID for every assignment audit event', async () => {
    const { service, store } = setup();

    await assignFoundation(service);
    await assignFoundation(service, { memberId: 'member-2' });

    const audits = await store.query('room-a', 'onboarding_audit_events');
    const operationIds = audits.records.map((record) => record.operationId);
    expect(operationIds).toHaveLength(2);
    expect(operationIds.every((operationId) => typeof operationId === 'string' && operationId.length > 0)).toBe(true);
    expect(new Set(operationIds).size).toBe(2);
  });

  it('keeps a created assignment successful when its audit write fails', async () => {
    const store = new MemoryOnboardingStore();
    const originalCreate = store.create.bind(store);
    vi.spyOn(store, 'create').mockImplementation(async (roomId, collection, data, operationId) => {
      if (collection === 'onboarding_audit_events') throw new Error('audit unavailable');
      return originalCreate(roomId, collection, data, operationId);
    });
    const { service } = setup(undefined, defaultMemberResult, store);

    const result = await assignFoundation(service);

    expect(result.assignment.id).toBeTruthy();
    expect(result.warning).toContain('audit unavailable');
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
