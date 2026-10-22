import { callAppPlatformTool, type AppPlatformToolCaller } from '../app-platform-tool-call';
import type { OnboardingActor } from './auth';
import type {
  AdminAssignmentDto,
  AssignmentRecord,
  EmployeeType,
  LearnerAssignmentDto,
  ResourceProgressRecord,
  TemplateSnapshot,
} from './contracts';
import { createNotificationPort, type NotificationPort } from './notifications';
import type { OnboardingStore, StoreRecord } from './store';
import type { AdminTemplateDetail, TemplateService } from './templates';
import { canUnlockExercise } from './workflow';

export interface AssignMemberInput {
  readonly memberId: string;
  readonly employeeType: EmployeeType;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly dueAt?: string;
}

export interface AssignmentCommandResult {
  readonly assignment: AssignmentRecord;
  readonly warning?: string;
}

export interface MaterialProgressRecord extends ResourceProgressRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly moduleId: string;
  readonly memberId: string;
}

export interface AssignmentDetail {
  readonly assignment: AssignmentRecord;
  readonly template: TemplateSnapshot;
  readonly progress: readonly MaterialProgressRecord[];
  readonly moduleUnlocks: Readonly<Record<string, boolean>>;
}

export interface ReminderSummary {
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface AssignmentService {
  listAdmin(actor: OnboardingActor): Promise<readonly AdminAssignmentDto[]>;
  getAdminDetail(actor: OnboardingActor, assignmentId: string): Promise<AssignmentDetail>;
  listMine(actor: OnboardingActor): Promise<readonly LearnerAssignmentDto[]>;
  getMine(actor: OnboardingActor, assignmentId: string, requestedMemberId?: string): Promise<AssignmentDetail>;
  assign(actor: OnboardingActor, input: AssignMemberInput): Promise<AssignmentCommandResult>;
  markResourceOpened(actor: OnboardingActor, assignmentId: string, resourceId: string): Promise<MaterialProgressRecord>;
  markResourceCompleted(actor: OnboardingActor, assignmentId: string, resourceId: string): Promise<MaterialProgressRecord>;
  grantRetry(actor: OnboardingActor, assignmentId: string): Promise<AssignmentRecord>;
  sendDueReminders(actor: OnboardingActor, at: Date): Promise<ReminderSummary>;
}

type AssignmentErrorCode =
  | 'ADMIN_REQUIRED'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_FORBIDDEN'
  | 'ASSIGNMENT_NOT_FOUND'
  | 'TEMPLATE_MISMATCH'
  | 'TEMPLATE_NOT_PUBLISHED'
  | 'RESOURCE_NOT_FOUND'
  | 'RESOURCE_NOT_OPENED';

export class AssignmentServiceError extends Error {
  readonly code: AssignmentErrorCode;

  constructor(code: AssignmentErrorCode, message: string) {
    super(message);
    this.name = 'AssignmentServiceError';
    this.code = code;
  }
}

interface AssignmentDbRecord extends StoreRecord {
  readonly id: string;
  readonly memberId: string;
  readonly employeeType: EmployeeType;
  readonly templateSource: 'system' | 'custom';
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateSnapshot: TemplateSnapshot;
  readonly dueAt?: string;
  readonly status: AssignmentRecord['status'];
  readonly attemptLimit?: number;
  readonly allowedAttempts: number;
  readonly activeAttemptId?: string;
  readonly assignedBy: string;
  readonly assignedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProgressDbRecord extends StoreRecord, MaterialProgressRecord {
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AttemptDbRecord extends StoreRecord {
  readonly assignmentId: string;
  readonly ordinal: number;
}

interface AuditDbRecord extends StoreRecord {
  readonly operationId?: string;
}

export interface AssignmentServiceOptions {
  readonly callPlatform?: AppPlatformToolCaller;
  readonly notifications?: NotificationPort;
  readonly id?: () => string;
  readonly now?: () => string;
}

function requireAdmin(actor: OnboardingActor): void {
  if (actor.access !== 'admin') {
    throw new AssignmentServiceError('ADMIN_REQUIRED', 'Admin access is required.');
  }
}

function snapshotOf(detail: AdminTemplateDetail): TemplateSnapshot {
  return {
    id: detail.id,
    version: detail.version,
    source: detail.source,
    status: detail.status,
    employeeType: detail.employeeType,
    title: detail.title,
    description: detail.description,
    passingScore: detail.passingScore,
    modules: detail.modules,
  };
}

function learnerSafeSnapshot(snapshot: TemplateSnapshot): TemplateSnapshot {
  return {
    ...snapshot,
    modules: snapshot.modules.map((module) => ({
      ...module,
      questions: module.questions.map((question) => {
        const { correctOptionIds: _answerKey, explanation: _explanation, ...safe } = question;
        return safe;
      }),
    })),
  };
}

function assignmentFrom(row: AssignmentDbRecord, roomId: string): AssignmentRecord {
  return {
    id: row.id,
    roomId,
    memberId: row.memberId,
    employeeType: row.employeeType,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    templateSource: row.templateSource,
    status: row.status,
    assignedBy: row.assignedBy,
    assignedAt: row.assignedAt,
    dueAt: row.dueAt,
    activeAttemptId: row.activeAttemptId,
    attemptLimit: row.attemptLimit,
    allowedAttempts: row.allowedAttempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function progressFrom(row: ProgressDbRecord): MaterialProgressRecord {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    moduleId: row.moduleId,
    resourceId: row.resourceId,
    memberId: row.memberId,
    openedAt: row.openedAt,
    completedAt: row.completedAt,
  };
}

function warningFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAssignmentService(
  store: OnboardingStore,
  templates: TemplateService,
  options: AssignmentServiceOptions = {},
): AssignmentService {
  const caller = options.callPlatform ?? callAppPlatformTool;
  const now = options.now ?? (() => new Date().toISOString());

  function notificationsFor(roomId: string): NotificationPort {
    return options.notifications ?? createNotificationPort(roomId, caller);
  }

  async function audit(
    actor: OnboardingActor,
    action: string,
    targetType: string,
    targetId: string,
    metadata: StoreRecord = {},
    operationId?: string,
  ): Promise<void> {
    await store.create(actor.roomId, 'onboarding_audit_events', {
      actorId: actor.userId,
      action,
      targetType,
      targetId,
      metadata,
      operationId,
      occurredAt: now(),
    });
  }

  async function assignmentRow(roomId: string, assignmentId: string): Promise<AssignmentDbRecord | undefined> {
    return (await store.get<AssignmentDbRecord>(roomId, 'onboarding_assignments', assignmentId)) ?? undefined;
  }

  async function requireAdminRow(actor: OnboardingActor, assignmentId: string): Promise<AssignmentDbRecord> {
    requireAdmin(actor);
    const row = await assignmentRow(actor.roomId, assignmentId);
    if (!row) throw new AssignmentServiceError('ASSIGNMENT_NOT_FOUND', 'Assignment was not found.');
    return row;
  }

  async function requireLearnerRow(
    actor: OnboardingActor,
    assignmentId: string,
    requestedMemberId?: string,
  ): Promise<AssignmentDbRecord> {
    if (requestedMemberId?.trim() && requestedMemberId.trim() !== actor.userId) {
      throw new AssignmentServiceError('MEMBER_FORBIDDEN', 'Learners may access only their own onboarding.');
    }
    const row = await assignmentRow(actor.roomId, assignmentId);
    if (!row || row.memberId !== actor.userId) {
      throw new AssignmentServiceError('MEMBER_FORBIDDEN', 'Learners may access only their own onboarding.');
    }
    return row;
  }

  async function detail(
    roomId: string,
    row: AssignmentDbRecord,
    learnerSafe = false,
  ): Promise<AssignmentDetail> {
    const progress = await store.query<ProgressDbRecord>(roomId, 'onboarding_material_progress', {
      filter: { assignmentId: row.id }, limit: 1000,
    });
    const materialProgress = progress.records.map(progressFrom);
    const moduleUnlocks = Object.fromEntries(row.templateSnapshot.modules.map((module) => [
      module.id,
      canUnlockExercise(module.resources, materialProgress),
    ]));
    return {
      assignment: assignmentFrom(row, roomId),
      template: learnerSafe ? learnerSafeSnapshot(row.templateSnapshot) : row.templateSnapshot,
      progress: materialProgress,
      moduleUnlocks,
    };
  }

  async function resourceContext(row: AssignmentDbRecord, resourceId: string) {
    for (const module of row.templateSnapshot.modules) {
      const resource = module.resources.find((item) => item.id === resourceId);
      if (resource) return { module, resource };
    }
    throw new AssignmentServiceError('RESOURCE_NOT_FOUND', 'Resource is not part of this assignment.');
  }

  async function currentProgress(
    roomId: string,
    assignmentId: string,
    resourceId: string,
  ): Promise<ProgressDbRecord | undefined> {
    const found = await store.query<ProgressDbRecord>(roomId, 'onboarding_material_progress', {
      filter: { assignmentId, resourceId }, limit: 2,
    });
    return found.records[0];
  }

  async function progressPercent(row: AssignmentDbRecord, roomId: string): Promise<number> {
    const requiredResources = row.templateSnapshot.modules.flatMap((module) => module.resources)
      .filter((resource) => resource.required);
    const progressRows = await store.query<ProgressDbRecord>(roomId, 'onboarding_material_progress', {
      filter: { assignmentId: row.id }, limit: 1000,
    });
    const completedResourceIds = new Set(progressRows.records.filter((item) => item.completedAt).map((item) => item.resourceId));
    const completedMaterials = requiredResources.filter((resource) => completedResourceIds.has(resource.id)).length;
    const submitted = ['submitted', 'awaiting_essay_feedback', 'awaiting_evaluation', 'passed', 'failed'].includes(row.status);
    const evaluated = row.status === 'passed' || row.status === 'failed';
    return Math.round((completedMaterials + Number(submitted) + Number(evaluated))
      / (requiredResources.length + 2) * 100);
  }

  return {
    async listAdmin(actor) {
      requireAdmin(actor);
      const rows = await store.query<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', {
        orderBy: [{ field: 'assignedAt', direction: 'desc' }], limit: 1000,
      });
      return Promise.all(rows.records.map(async (row): Promise<AdminAssignmentDto> => ({
        ...assignmentFrom(row, actor.roomId),
        templateTitle: row.templateSnapshot.title,
        progressPercent: await progressPercent(row, actor.roomId),
      })));
    },

    async getAdminDetail(actor, assignmentId) {
      return detail(actor.roomId, await requireAdminRow(actor, assignmentId));
    },

    async listMine(actor) {
      const rows = await store.query<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', {
        filter: { memberId: actor.userId }, orderBy: [{ field: 'assignedAt', direction: 'desc' }], limit: 1000,
      });
      return Promise.all(rows.records.map(async (row): Promise<LearnerAssignmentDto> => {
        return {
          id: row.id,
          employeeType: row.employeeType,
          status: row.status,
          templateId: row.templateId,
          templateVersion: row.templateVersion,
          templateTitle: row.templateSnapshot.title,
          assignedAt: row.assignedAt,
          dueAt: row.dueAt,
          activeAttemptId: row.activeAttemptId,
          progressPercent: await progressPercent(row, actor.roomId),
        };
      }));
    },

    async getMine(actor, assignmentId, requestedMemberId) {
      return detail(actor.roomId, await requireLearnerRow(actor, assignmentId, requestedMemberId), true);
    },

    async assign(actor, input) {
      requireAdmin(actor);
      const memberId = input.memberId.trim();
      const rawMembers = await caller('mcpapp.rooms.getMembers', { roomId: actor.roomId }, 'rooms:read', actor.roomId);
      const members = rawMembers && typeof rawMembers === 'object'
        && Array.isArray((rawMembers as { members?: unknown }).members)
        ? (rawMembers as { members: Array<{ userId?: unknown }> }).members
        : [];
      if (!members.some((item) => item && item.userId === memberId)) {
        throw new AssignmentServiceError('MEMBER_NOT_FOUND', 'The selected user is not a current member of this room.');
      }
      const template = await templates.getAdminDetail(actor, input.templateId, input.templateVersion);
      if (template.status !== 'published') {
        throw new AssignmentServiceError('TEMPLATE_NOT_PUBLISHED', 'Only published template versions can be assigned.');
      }
      if (template.employeeType !== input.employeeType) {
        throw new AssignmentServiceError('TEMPLATE_MISMATCH', 'Template and employee classifications must match.');
      }
      const timestamp = now();
      const row = await store.create<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', {
        memberId,
        employeeType: input.employeeType,
        templateSource: template.source,
        templateId: template.id,
        templateVersion: template.version,
        templateSnapshot: snapshotOf(template),
        dueAt: input.dueAt,
        status: 'assigned',
        attemptLimit: template.maxAttempts,
        allowedAttempts: 1,
        assignedBy: actor.userId,
        assignedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await audit(actor, 'assignment.created', 'assignment', row.id, {
        memberId, employeeType: input.employeeType, templateId: template.id, templateVersion: template.version,
      });

      let warning: string | undefined;
      try {
        const result = await notificationsFor(actor.roomId).notify(
          memberId,
          'Bạn có chương trình onboarding mới',
          `Bạn đã được gán chương trình “${template.title}”.`,
        );
        if (!result.delivered) warning = result.warning ?? 'Không thể gửi thông báo.';
      } catch (error) {
        warning = warningFrom(error);
      }
      return { assignment: assignmentFrom(row, actor.roomId), ...(warning ? { warning } : {}) };
    },

    async markResourceOpened(actor, assignmentId, resourceId) {
      const row = await requireLearnerRow(actor, assignmentId);
      const { module } = await resourceContext(row, resourceId);
      const existing = await currentProgress(actor.roomId, assignmentId, resourceId);
      if (existing?.openedAt) return progressFrom(existing);
      const timestamp = now();
      const progress = existing
        ? await store.update<ProgressDbRecord>(actor.roomId, 'onboarding_material_progress', existing.id, {
          openedAt: timestamp, updatedAt: timestamp,
        })
        : await store.create<ProgressDbRecord>(actor.roomId, 'onboarding_material_progress', {
          assignmentId,
          moduleId: module.id,
          resourceId,
          memberId: actor.userId,
          openedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      if (row.status === 'assigned' || row.status === 'retry') {
        await store.update(actor.roomId, 'onboarding_assignments', row.id, {
          status: 'in_progress', updatedAt: timestamp,
        });
      }
      await audit(actor, 'material.opened', 'resource', resourceId, { assignmentId });
      return progressFrom(progress);
    },

    async markResourceCompleted(actor, assignmentId, resourceId) {
      const row = await requireLearnerRow(actor, assignmentId);
      await resourceContext(row, resourceId);
      const existing = await currentProgress(actor.roomId, assignmentId, resourceId);
      if (!existing?.openedAt) {
        throw new AssignmentServiceError('RESOURCE_NOT_OPENED', 'Open the resource before marking it complete.');
      }
      if (existing.completedAt) return progressFrom(existing);
      const timestamp = now();
      const progress = await store.update<ProgressDbRecord>(actor.roomId, 'onboarding_material_progress', existing.id, {
        completedAt: timestamp, updatedAt: timestamp,
      });
      await audit(actor, 'material.completed', 'resource', resourceId, { assignmentId });
      return progressFrom(progress);
    },

    async grantRetry(actor, assignmentId) {
      const row = await requireAdminRow(actor, assignmentId);
      const attempts = await store.query<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', {
        filter: { assignmentId }, limit: 1000,
      });
      const nextOrdinal = Math.max(0, ...attempts.records.map((attempt) => attempt.ordinal)) + 1;
      const allowedAttempts = Math.max(row.allowedAttempts + 1, nextOrdinal);
      const updated = await store.update<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', row.id, {
        status: 'retry', allowedAttempts, activeAttemptId: undefined, updatedAt: now(),
      });
      await audit(actor, 'assignment.retry_granted', 'assignment', assignmentId, { allowedAttempts, nextOrdinal });
      return assignmentFrom(updated, actor.roomId);
    },

    async sendDueReminders(actor, at) {
      requireAdmin(actor);
      const rows = await store.query<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', { limit: 1000 });
      const start = at.getTime();
      const end = start + 48 * 60 * 60 * 1000;
      const day = at.toISOString().slice(0, 10);
      const summary = { sent: 0, skipped: 0, failed: 0 };
      for (const row of rows.records) {
        const due = row.dueAt ? Date.parse(row.dueAt) : Number.NaN;
        if (!['assigned', 'in_progress', 'retry'].includes(row.status) || !Number.isFinite(due) || due < start || due > end) {
          continue;
        }
        const operationId = `due-reminder:${row.id}:${day}`;
        const prior = await store.query<AuditDbRecord>(actor.roomId, 'onboarding_audit_events', {
          filter: { operationId }, limit: 1,
        });
        if (prior.records.length > 0) {
          summary.skipped += 1;
          continue;
        }
        let delivered = false;
        let warning: string | undefined;
        try {
          const result = await notificationsFor(actor.roomId).notify(
            row.memberId,
            'Nhắc hạn onboarding',
            `Chương trình “${row.templateSnapshot.title}” sắp đến hạn.`,
          );
          delivered = result.delivered;
          warning = result.warning;
        } catch (error) {
          warning = warningFrom(error);
        }
        if (delivered) summary.sent += 1;
        else summary.failed += 1;
        await audit(actor, 'assignment.due_reminder', 'assignment', row.id, { delivered, warning }, operationId);
      }
      return summary;
    },
  };
}
