import { INVALID_PARAMS, type VerifiedActor } from '@privos_ai/app-server';

import { callAppPlatformTool } from '../app-platform-tool-call';
import { requireAdmin, requireSelf, resolveOnboardingActor, type OnboardingActor } from './auth';
import { createAssignmentService, type AssignmentService } from './assignments';
import { createAttemptService, type AttemptService, type DraftAnswerInput } from './attempts';
import {
  AI_PROVIDERS,
  type AiProvider,
  type AssignmentStatus,
  type EmployeeType,
  type FinalConclusion,
  type ModuleQuizAnswerInput,
} from './contracts';
import {
  createAiJobService,
  type AiJobService,
  type ReportAiFailureInput,
  type StartAiJobInput,
} from './ai/jobs';
import {
  createAiPublishGuard,
  createAiReviewService,
  type AiReviewOperation,
  type AiReviewService,
} from './ai/review';
import {
  createSourceService,
  type IngestSourceInput,
  type SourceFileMetadata,
  type SourceService,
} from './ai/sources';
import { createEmployeeService, type EmployeeService } from './employees';
import { createModuleLearningService, type ModuleLearningService } from './module-learning';
import { createNotificationPort } from './notifications';
import { createReviewService, type ReviewService } from './reviews';
import { ensureOnboardingSchema } from './schema';
import { createOnboardingStore } from './store';
import { createTemplateService, type TemplateDraftInput, type TemplateService } from './templates';

export const ONBOARDING_DASHBOARD_TOOL = 'onboarding_dashboard' as const;
export const DATA_TOOL_NAMES = [
  'onboarding_bootstrap',
  'onboarding_admin_templates',
  'onboarding_admin_ai',
  'onboarding_admin_assignments',
  'onboarding_learning',
  'onboarding_reviews',
] as const;

export type OnboardingDataToolName = typeof DATA_TOOL_NAMES[number];
export type OnboardingToolName = OnboardingDataToolName | typeof ONBOARDING_DASHBOARD_TOOL;

const ACTIONS: Readonly<Record<OnboardingDataToolName, readonly string[]>> = {
  onboarding_bootstrap: ['load'],
  onboarding_admin_templates: ['list', 'get', 'update', 'publish', 'archive', 'delete'],
  onboarding_admin_ai: [
    'list_sources', 'ingest_source', 'add_admin_note', 'delete_source', 'get_source_section',
    'start_job', 'list_jobs', 'get_job', 'next_step', 'record_dispatch', 'submit_ai_output',
    'report_ai_failure', 'retry_job', 'cancel_job', 'record_attempt_cleanup',
    'get_review', 'update_review', 'resolve_flag',
  ],
  onboarding_admin_assignments: [
    'list', 'get', 'list_members', 'list_employees', 'add_employee', 'assign', 'grant_retry',
    'grant_module_retry', 'question_stats', 'send_due_reminders',
  ],
  onboarding_learning: [
    'list', 'get', 'open_resource', 'complete_resource', 'start_attempt', 'save_draft', 'submit', 'get_result',
    'get_feedback', 'get_modules', 'open_module', 'complete_lesson', 'start_module_quiz',
    'submit_module_quiz', 'get_module_attempt',
  ],
  onboarding_reviews: ['list_essays', 'save_essay_feedback', 'list_evaluations', 'publish_evaluation'],
};

export interface RoomMemberDto {
  readonly userId: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly roles?: readonly string[];
}

export interface OnboardingServiceBundle {
  readonly prepare: (actor: OnboardingActor) => Promise<void>;
  readonly listRoomMembers: (actor: OnboardingActor) => Promise<readonly RoomMemberDto[]>;
  readonly employees: EmployeeService;
  readonly templates: TemplateService;
  readonly assignments: AssignmentService;
  readonly attempts: AttemptService;
  readonly reviews: ReviewService;
  readonly sources: SourceService;
  readonly aiJobs: AiJobService;
  readonly aiReview: AiReviewService;
  readonly moduleLearning: ModuleLearningService;
}

export type OnboardingServiceFactory = (actor: OnboardingActor) => OnboardingServiceBundle;
export type OnboardingToolHandler = (
  name: string,
  args: unknown,
  actor?: VerifiedActor,
) => Promise<Record<string, unknown>>;

function toolError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code: INVALID_PARAMS, data: { code } });
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; data?: unknown };
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : undefined;
    if (typeof data?.code === 'string') return record;
    if (typeof record.code === 'string') {
      const serviceCode = record.code;
      return Object.assign(record, { code: INVALID_PARAMS, data: { code: serviceCode } });
    }
    return Object.assign(new Error(record.message), {
      code: INVALID_PARAMS,
      data: { code: 'ONBOARDING_ERROR' },
      cause: error,
    });
  }
  return toolError('ONBOARDING_ERROR', 'Onboarding request failed.');
}

function asArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw toolError('ARGUMENT_INVALID', 'Tool arguments must be an object.');
  }
  return value as Record<string, unknown>;
}

function actionFor(name: OnboardingDataToolName, args: Record<string, unknown>): string {
  if (typeof args.action !== 'string' || !args.action.trim()) {
    throw toolError('ACTION_REQUIRED', `${name} requires an action.`);
  }
  const action = args.action.trim();
  if (!ACTIONS[name].includes(action)) {
    throw toolError('ACTION_INVALID', `Unsupported ${name} action: ${action}.`);
  }
  return action;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw toolError('ARGUMENT_REQUIRED', `${key} is required.`);
  }
  return value.trim();
}

function requiredProvider(args: Record<string, unknown>): AiProvider {
  const provider = requiredString(args, 'provider');
  if (!(AI_PROVIDERS as readonly string[]).includes(provider)) {
    throw toolError('ARGUMENT_INVALID', 'provider must be sandbox or native_chat.');
  }
  return provider as AiProvider;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw toolError('ARGUMENT_INVALID', `${key} must be a string.`);
  const normalized = value.trim();
  return normalized || undefined;
}

function requiredNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw toolError('ARGUMENT_REQUIRED', `${key} is required and must be a number.`);
  }
  return value;
}

function requiredObject<T extends object>(args: Record<string, unknown>, key: string): T {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw toolError('ARGUMENT_REQUIRED', `${key} is required and must be an object.`);
  }
  return value as T;
}

function requiredArray<T>(args: Record<string, unknown>, key: string): readonly T[] {
  const value = args[key];
  if (!Array.isArray(value)) throw toolError('ARGUMENT_REQUIRED', `${key} is required and must be an array.`);
  return value as readonly T[];
}

function dataToolName(name: string): OnboardingDataToolName {
  if (!(DATA_TOOL_NAMES as readonly string[]).includes(name)) {
    throw toolError('TOOL_NOT_FOUND', `Unknown onboarding tool: ${name || '<missing>'}.`);
  }
  return name as OnboardingDataToolName;
}

function statusCounts(statuses: readonly AssignmentStatus[]): { activeCount: number; completedCount: number } {
  const complete = new Set<AssignmentStatus>(['passed', 'failed']);
  return {
    activeCount: statuses.filter((status) => !complete.has(status)).length,
    completedCount: statuses.filter((status) => complete.has(status)).length,
  };
}

const ADMIN_MEMBER_ROLES = new Set(['owner', 'admin', 'moderator']);

function hasAdminMemberRole(roles: readonly string[] | undefined): boolean {
  return Boolean(roles?.some((role) => ADMIN_MEMBER_ROLES.has(role.trim().toLowerCase())));
}

async function resolveDirectoryAccess(
  actor: OnboardingActor,
  services: OnboardingServiceBundle,
): Promise<OnboardingActor> {
  if (actor.access === 'admin') return actor;
  const members = await services.listRoomMembers(actor);
  const membership = members.find((member) => member.userId === actor.userId);
  return hasAdminMemberRole(membership?.roles) ? { ...actor, access: 'admin' } : actor;
}

async function bootstrap(actor: OnboardingActor, services: OnboardingServiceBundle): Promise<Record<string, unknown>> {
  const isAdmin = actor.access === 'admin';
  const capabilities = {
    canManageTemplates: isAdmin,
    canAssignMembers: isAdmin,
    canReview: isAdmin,
    canLearn: true,
    canUploadFiles: isAdmin,
    canGenerateWithAi: isAdmin,
    notifications: 'best_effort',
  };
  if (isAdmin) {
    const [assignments, templates, essays, evaluations] = await Promise.all([
      services.assignments.listAdmin(actor),
      services.templates.list(actor),
      services.reviews.listEssayQueue(actor),
      services.reviews.listEvaluationQueue(actor),
    ]);
    return {
      role: actor.access,
      roomId: actor.roomId,
      identity: { userId: actor.userId, username: actor.username ?? actor.userId },
      capabilities,
      summary: {
        assignmentCount: assignments.length,
        templateCount: templates.length,
        pendingEssayCount: essays.filter((item) => !item.reviewed).length,
        pendingEvaluationCount: evaluations.length,
      },
    };
  }
  const assignments = await services.assignments.listMine(actor);
  return {
    role: actor.access,
    roomId: actor.roomId,
    identity: { userId: actor.userId, username: actor.username ?? actor.userId },
    capabilities,
    summary: { assignmentCount: assignments.length, ...statusCounts(assignments.map((item) => item.status)) },
  };
}

async function dispatchTemplates(
  action: string,
  args: Record<string, unknown>,
  actor: OnboardingActor,
  services: OnboardingServiceBundle,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'list': return { templates: await services.templates.list(actor) };
    case 'get': return { template: await services.templates.getAdminDetail(actor, requiredString(args, 'templateId'), requiredNumber(args, 'version')) };
    case 'create': return { template: await services.templates.createDraft(actor, requiredObject<TemplateDraftInput>(args, 'draft')) };
    case 'update': return {
      template: await services.templates.updateDraft(actor, {
        templateId: requiredString(args, 'templateId'),
        version: requiredNumber(args, 'version'),
        expectedUpdatedAt: requiredString(args, 'expectedUpdatedAt'),
        draft: requiredObject<TemplateDraftInput>(args, 'draft'),
      }),
    };
    case 'clone_system': return { template: await services.templates.cloneSystemTemplate(actor, requiredString(args, 'templateId'), requiredNumber(args, 'version')) };
    case 'publish': return {
      template: await services.templates.publish(
        actor,
        requiredString(args, 'templateId'),
        requiredNumber(args, 'version'),
        optionalString(args, 'expectedUpdatedAt'),
      ),
    };
    case 'archive': return { template: await services.templates.archive(actor, requiredString(args, 'templateId'), requiredNumber(args, 'version')) };
    case 'delete':
      await services.templates.deleteDraft(actor, requiredString(args, 'templateId'), requiredNumber(args, 'version'));
      return { deleted: true };
    default: throw toolError('ACTION_INVALID', `Unsupported template action: ${action}.`);
  }
}

async function dispatchAssignments(
  action: string,
  args: Record<string, unknown>,
  actor: OnboardingActor,
  services: OnboardingServiceBundle,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'list': {
      const [assignments, summary] = await Promise.all([
        services.assignments.listAdmin(actor),
        services.moduleLearning.dashboardSummary(actor),
      ]);
      return { assignments, summary };
    }
    case 'get': return { detail: await services.assignments.getAdminDetail(actor, requiredString(args, 'assignmentId')) };
    case 'list_members': return { members: await services.listRoomMembers(actor) };
    case 'list_employees': return { employees: await services.employees.list(actor) };
    case 'add_employee': return {
      employee: await services.employees.add(actor, {
        memberId: requiredString(args, 'memberId'),
        employeeType: requiredString(args, 'employeeType') as EmployeeType,
      }),
    };
    case 'assign': return {
      result: await services.assignments.assign(actor, {
        memberId: requiredString(args, 'memberId'),
        templateId: requiredString(args, 'templateId'),
        templateVersion: requiredNumber(args, 'templateVersion'),
        dueAt: optionalString(args, 'dueAt'),
      }),
    };
    case 'grant_retry': return { assignment: await services.assignments.grantRetry(actor, requiredString(args, 'assignmentId')) };
    case 'grant_module_retry': return {
      module: await services.moduleLearning.grantModuleRetry(
        actor,
        requiredString(args, 'assignmentId'),
        requiredString(args, 'moduleId'),
      ),
    };
    case 'question_stats': return {
      stats: await services.moduleLearning.questionStats(
        actor,
        requiredString(args, 'templateId'),
        requiredNumber(args, 'version'),
      ),
    };
    case 'send_due_reminders': {
      const at = optionalString(args, 'at');
      const date = at ? new Date(at) : new Date();
      if (!Number.isFinite(date.valueOf())) throw toolError('ARGUMENT_INVALID', 'at must be a valid ISO date.');
      return { summary: await services.assignments.sendDueReminders(actor, date) };
    }
    default: throw toolError('ACTION_INVALID', `Unsupported assignment action: ${action}.`);
  }
}

async function dispatchLearning(
  action: string,
  args: Record<string, unknown>,
  actor: OnboardingActor,
  services: OnboardingServiceBundle,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'list': return { assignments: await services.assignments.listMine(actor) };
    case 'get': return {
      detail: await services.assignments.getMine(actor, requiredString(args, 'assignmentId'), actor.userId),
    };
    case 'open_resource': return {
      progress: await services.assignments.markResourceOpened(
        actor, requiredString(args, 'assignmentId'), requiredString(args, 'resourceId'),
      ),
    };
    case 'complete_resource': return {
      progress: await services.assignments.markResourceCompleted(
        actor, requiredString(args, 'assignmentId'), requiredString(args, 'resourceId'),
      ),
    };
    case 'start_attempt': return {
      attempt: await services.attempts.getOrCreateDraft(actor, requiredString(args, 'assignmentId')),
    };
    case 'save_draft': return {
      attempt: await services.attempts.saveDraft(actor, {
        assignmentId: requiredString(args, 'assignmentId'),
        attemptId: requiredString(args, 'attemptId'),
        answers: requiredArray<DraftAnswerInput>(args, 'answers'),
      }),
    };
    case 'submit': return {
      result: await services.attempts.submit(actor, {
        assignmentId: requiredString(args, 'assignmentId'),
        operationId: requiredString(args, 'operationId'),
      }),
    };
    case 'get_result': return { result: await services.attempts.getLearnerResult(actor, requiredString(args, 'attemptId')) };
    case 'get_feedback': return {
      feedback: await services.reviews.getPublishedFeedback(actor, requiredString(args, 'assignmentId')),
    };
    case 'get_modules': return {
      modules: await services.moduleLearning.getModules(actor, requiredString(args, 'assignmentId')),
    };
    case 'open_module': return {
      module: await services.moduleLearning.openModule(
        actor, requiredString(args, 'assignmentId'), requiredString(args, 'moduleId'),
      ),
    };
    case 'complete_lesson': return {
      module: await services.moduleLearning.completeLesson(
        actor, requiredString(args, 'assignmentId'), requiredString(args, 'moduleId'),
      ),
    };
    case 'start_module_quiz': return {
      attempt: await services.moduleLearning.startModuleQuiz(
        actor, requiredString(args, 'assignmentId'), requiredString(args, 'moduleId'),
      ),
    };
    case 'submit_module_quiz': return {
      result: await services.moduleLearning.submitModuleQuiz(actor, {
        assignmentId: requiredString(args, 'assignmentId'),
        moduleId: requiredString(args, 'moduleId'),
        attemptId: requiredString(args, 'attemptId'),
        operationId: requiredString(args, 'operationId'),
        answers: requiredArray<ModuleQuizAnswerInput>(args, 'answers'),
      }),
    };
    case 'get_module_attempt': return {
      result: await services.moduleLearning.getModuleAttempt(actor, requiredString(args, 'attemptId')),
    };
    default: throw toolError('ACTION_INVALID', `Unsupported learning action: ${action}.`);
  }
}

async function dispatchAdminAi(
  action: string,
  args: Record<string, unknown>,
  actor: OnboardingActor,
  services: OnboardingServiceBundle,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'list_sources': return { sources: await services.sources.listSources(actor) };
    case 'ingest_source': return {
      source: await services.sources.ingestSource(actor, {
        operationId: requiredString(args, 'operationId'),
        fileName: requiredString(args, 'fileName'),
        mimeType: optionalString(args, 'mimeType'),
        base64: requiredString(args, 'base64'),
        fileId: optionalString(args, 'fileId'),
        systemName: requiredString(args, 'systemName'),
        softwareVersion: optionalString(args, 'softwareVersion'),
        effectiveDate: optionalString(args, 'effectiveDate'),
      } satisfies IngestSourceInput),
    };
    case 'add_admin_note': return {
      source: await services.sources.addAdminNote(actor, {
        operationId: requiredString(args, 'operationId'),
        title: requiredString(args, 'title'),
        text: requiredString(args, 'text'),
      }),
    };
    case 'delete_source':
      await services.sources.deleteSource(actor, requiredString(args, 'sourceId'));
      return { deleted: true };
    case 'get_source_section': return {
      ...(await services.sources.getSourceSection(
        actor, requiredString(args, 'sourceId'), requiredString(args, 'sectionId'),
      )),
    };
    case 'start_job': {
      const input = args.job === undefined
        ? {
          kind: requiredString(args, 'kind'),
          operationId: requiredString(args, 'operationId'),
          ...(args.kind === 'inventory'
            ? { sourceIds: requiredArray<string>(args, 'sourceIds') }
            : {
              inventoryJobId: requiredString(args, 'inventoryJobId'),
              templateKind: requiredString(args, 'templateKind'),
              ...(args.roleProfile === undefined ? {} : { roleProfile: requiredObject(args, 'roleProfile') }),
              ...(optionalString(args, 'title') ? { title: optionalString(args, 'title') } : {}),
            }),
        }
        : requiredObject<StartAiJobInput>(args, 'job');
      return { job: await services.aiJobs.startJob(actor, input as StartAiJobInput) };
    }
    case 'list_jobs': return { jobs: await services.aiJobs.listJobs(actor) };
    case 'get_job': return { job: await services.aiJobs.getJob(actor, requiredString(args, 'jobId')) };
    case 'next_step': return services.aiJobs.nextStep(actor, {
      jobId: requiredString(args, 'jobId'),
      workerId: requiredString(args, 'workerId'),
    }) as Promise<Record<string, unknown>>;
    case 'record_dispatch': return services.aiJobs.recordDispatch(actor, {
      jobId: requiredString(args, 'jobId'),
      workerId: requiredString(args, 'workerId'),
      callId: requiredString(args, 'callId'),
      attemptRef: requiredString(args, 'attemptRef'),
      provider: requiredProvider(args),
    }) as unknown as Promise<Record<string, unknown>>;
    case 'submit_ai_output': return services.aiJobs.submitAiOutput(actor, {
      jobId: requiredString(args, 'jobId'),
      workerId: requiredString(args, 'workerId'),
      callId: requiredString(args, 'callId'),
      text: requiredString(args, 'text'),
    }) as unknown as Promise<Record<string, unknown>>;
    case 'report_ai_failure': {
      const kind = optionalString(args, 'kind') ?? requiredString(args, 'reason');
      return services.aiJobs.reportAiFailure(actor, {
        jobId: requiredString(args, 'jobId'),
        workerId: requiredString(args, 'workerId'),
        callId: requiredString(args, 'callId'),
        kind,
        message: optionalString(args, 'message'),
        providerErrorCode: optionalString(args, 'providerErrorCode'),
        providerPhase: optionalString(args, 'providerPhase'),
        diagnosticError: optionalString(args, 'diagnosticError'),
      } as ReportAiFailureInput) as unknown as Promise<Record<string, unknown>>;
    }
    case 'retry_job': return {
      job: await services.aiJobs.retryJob(actor, requiredString(args, 'jobId')),
    };
    case 'cancel_job': return {
      job: await services.aiJobs.cancelJob(actor, requiredString(args, 'jobId')),
    };
    case 'record_attempt_cleanup': {
      const state = requiredString(args, 'state');
      if (state !== 'confirmed' && state !== 'unknown') {
        throw toolError('ARGUMENT_INVALID', 'state must be confirmed or unknown.');
      }
      return {
        job: await services.aiJobs.recordAttemptCleanup(actor, {
          jobId: requiredString(args, 'jobId'),
          callId: requiredString(args, 'callId'),
          attemptRef: requiredString(args, 'attemptRef'),
          state,
          ...(optionalString(args, 'message') ? { message: optionalString(args, 'message') } : {}),
        }),
      };
    }
    case 'get_review': return {
      review: await services.aiReview.getReview(
        actor, requiredString(args, 'templateId'), requiredNumber(args, 'version'),
      ),
    };
    case 'update_review': return {
      review: await services.aiReview.updateReview(actor, {
        templateId: requiredString(args, 'templateId'),
        version: requiredNumber(args, 'version'),
        expectedUpdatedAt: requiredString(args, 'expectedUpdatedAt'),
        ops: requiredArray<AiReviewOperation>(args, 'ops'),
      }),
    };
    case 'resolve_flag': return {
      review: await services.aiReview.resolveFlag(actor, {
        templateId: requiredString(args, 'templateId'),
        version: requiredNumber(args, 'version'),
        flagId: requiredString(args, 'flagId'),
        action: requiredString(args, 'resolutionAction') as 'choose_option' | 'add_note' | 'upload_doc' | 'remove' | 'accept',
        note: optionalString(args, 'note'),
        chosenEvidenceIndex: args.chosenEvidenceIndex === undefined
          ? undefined
          : requiredNumber(args, 'chosenEvidenceIndex'),
        expectedUpdatedAt: optionalString(args, 'expectedUpdatedAt'),
      }),
    };
    default: throw toolError('ACTION_INVALID', `Unsupported Admin AI action: `);
  }
}

async function dispatchReviews(
  action: string,
  args: Record<string, unknown>,
  actor: OnboardingActor,
  services: OnboardingServiceBundle,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'list_essays': return { items: await services.reviews.listEssayQueue(actor) };
    case 'save_essay_feedback': return {
      feedback: await services.reviews.saveEssayFeedback(actor, {
        attemptId: requiredString(args, 'attemptId'),
        answerId: requiredString(args, 'answerId'),
        comment: requiredString(args, 'comment'),
      }),
    };
    case 'list_evaluations': return { items: await services.reviews.listEvaluationQueue(actor) };
    case 'publish_evaluation': return {
      result: await services.reviews.publishEvaluation(actor, {
        attemptId: requiredString(args, 'attemptId'),
        operationId: requiredString(args, 'operationId'),
        completionLevel: requiredString(args, 'completionLevel'),
        strengths: requiredString(args, 'strengths'),
        improvements: requiredString(args, 'improvements'),
        publicComment: requiredString(args, 'publicComment'),
        conclusion: requiredString(args, 'conclusion') as FinalConclusion,
      }),
    };
    default: throw toolError('ACTION_INVALID', `Unsupported review action: ${action}.`);
  }
}

const schemaPreparation = new Map<string, Promise<void>>();

function prepareRoom(roomId: string): Promise<void> {
  const current = schemaPreparation.get(roomId);
  if (current) return current;
  const preparation = ensureOnboardingSchema(roomId).catch((error) => {
    schemaPreparation.delete(roomId);
    throw error;
  });
  schemaPreparation.set(roomId, preparation);
  return preparation;
}

function memberRoles(row: Record<string, unknown>): readonly string[] | undefined {
  for (const key of ['roles', 'userRoles', 'roomRoles']) {
    const value = row[key];
    if (Array.isArray(value) && value.every((role) => typeof role === 'string')) {
      return value as string[];
    }
  }
  return typeof row.role === 'string' && row.role.trim() ? [row.role] : undefined;
}

function memberFrom(value: unknown): RoomMemberDto | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const userId = [row.userId, row.id, row._id].find((candidate) => typeof candidate === 'string' && candidate.trim());
  if (typeof userId !== 'string') return undefined;
  const username = typeof row.username === 'string' ? row.username : undefined;
  const displayName = typeof row.displayName === 'string'
    ? row.displayName
    : typeof row.name === 'string' ? row.name : undefined;
  const roles = memberRoles(row);
  return { userId, username, displayName, roles };
}

export function sourceFileMetadataFrom(
  value: unknown,
  expectedFileId: string,
): SourceFileMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const outer = value as Record<string, unknown>;
  const file = outer.file && typeof outer.file === 'object' && !Array.isArray(outer.file)
    ? outer.file as Record<string, unknown>
    : outer;
  const fileId = [file.fileId, file.id, file._id]
    .find((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()));
  const fileName = [file.fileName, file.name, file.title]
    .find((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()));
  const mimeType = [file.mimeType, file.mimetype, file.type, file.file_type]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.includes('/'));
  const size = [file.size, file.fileSize, file.file_size, file.bytes]
    .find((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate));
  if (fileId !== expectedFileId || !fileName || size === undefined || size < 0) return null;
  return { fileId, fileName, ...(mimeType ? { mimeType } : {}), size };
}

function createDefaultServices(_actor: OnboardingActor): OnboardingServiceBundle {
  const store = createOnboardingStore();
  const templates = createTemplateService(store, { publishGuard: createAiPublishGuard(store) });
  const employees = createEmployeeService(store);
  const assignments = createAssignmentService(store, templates, { employees });
  const attempts = createAttemptService(store, assignments, templates);
  const reviews = createReviewService(store, assignments, attempts);
  const sources = createSourceService(store, {
    async readFileMetadata(roomId, fileId) {
      const result = await callAppPlatformTool(
        'mcpapp.files.get',
        { fileId },
        'files:read',
        roomId,
        { replaySafe: true },
      );
      return sourceFileMetadataFrom(result, fileId);
    },
  });
  const aiJobs = createAiJobService(store);
  const aiReview = createAiReviewService(store, templates);
  const moduleLearning = createModuleLearningService(
    store,
    assignments,
    createNotificationPort(_actor.roomId),
  );
  return {
    prepare: (actor) => prepareRoom(actor.roomId),
    async listRoomMembers(actor) {
      const result = await callAppPlatformTool(
        'mcpapp.rooms.getMembers',
        { roomId: actor.roomId },
        'rooms:read',
        actor.roomId,
        { replaySafe: true },
      );
      const rows = Array.isArray(result)
        ? result
        : result && typeof result === 'object' && Array.isArray((result as { members?: unknown }).members)
          ? (result as { members: unknown[] }).members
          : [];
      return rows.map(memberFrom).filter((member): member is RoomMemberDto => Boolean(member));
    },
    employees,
    templates,
    assignments,
    attempts,
    reviews,
    sources,
    aiJobs,
    aiReview,
    moduleLearning,
  };
}

export function isOnboardingTool(name: unknown): name is OnboardingToolName {
  return name === ONBOARDING_DASHBOARD_TOOL || (typeof name === 'string' && (DATA_TOOL_NAMES as readonly string[]).includes(name));
}

export function createOnboardingToolHandler(
  serviceFactory: OnboardingServiceFactory = createDefaultServices,
): OnboardingToolHandler {
  return async (name, rawArgs, verifiedActor) => {
    try {
      const args = asArgs(rawArgs);
      const toolName = dataToolName(name);
      const action = actionFor(toolName, args);

      if (
        toolName === 'onboarding_admin_templates'
        || toolName === 'onboarding_admin_ai'
        || toolName === 'onboarding_admin_assignments'
        || toolName === 'onboarding_reviews'
      ) {
        const claimedActor = resolveOnboardingActor(verifiedActor);
        const services = serviceFactory(claimedActor);
        const actor = await resolveDirectoryAccess(claimedActor, services);
        if (actor.access !== 'admin') requireAdmin(verifiedActor);
        await services.prepare(actor);
        if (toolName === 'onboarding_admin_templates') return await dispatchTemplates(action, args, actor, services);
        if (toolName === 'onboarding_admin_ai') return await dispatchAdminAi(action, args, actor, services);
        if (toolName === 'onboarding_admin_assignments') return await dispatchAssignments(action, args, actor, services);
        return await dispatchReviews(action, args, actor, services);
      }

      if (toolName === 'onboarding_learning') {
        const actor = requireSelf(verifiedActor, optionalString(args, 'memberId'));
        const services = serviceFactory(actor);
        await services.prepare(actor);
        return await dispatchLearning(action, args, actor, services);
      }

      const claimedActor = resolveOnboardingActor(verifiedActor);
      const services = serviceFactory(claimedActor);
      const actor = await resolveDirectoryAccess(claimedActor, services);
      await services.prepare(actor);
      return await bootstrap(actor, services);
    } catch (error) {
      throw normalizeError(error);
    }
  };
}

export const handleOnboardingTool = createOnboardingToolHandler();
