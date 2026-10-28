import { randomInt as secureRandomInt } from 'node:crypto';

import type { OnboardingActor } from './auth';
import type { AssignmentService } from './assignments';
import type {
  AssignmentStatus,
  ModuleAttemptAnswer,
  ModuleLearningStatus,
  ModuleProgressRecord,
  ModuleQuestionStatDto,
  ModuleQuizAnswerInput,
  ModuleQuizResultDto,
  ModuleQuizStartDto,
  ModuleStateDto,
  TemplateContentSnapshot,
  TemplateSnapshot,
} from './contracts';
import type { NotificationPort } from './notifications';
import type { OnboardingStore, StoreRecord } from './store';

export type ModuleLearningErrorCode =
  | 'ADMIN_REQUIRED'
  | 'MEMBER_FORBIDDEN'
  | 'ASSIGNMENT_NOT_FOUND'
  | 'MODULE_NOT_FOUND'
  | 'MODULE_LOCKED'
  | 'LESSON_NOT_COMPLETED'
  | 'MODULE_ALREADY_PASSED'
  | 'MODULE_ATTEMPT_LIMIT'
  | 'MODULE_ATTEMPT_NOT_FOUND'
  | 'ANSWER_INVALID'
  | 'OPERATION_CONFLICT'
  | 'ASSESSMENT_MODE_MISMATCH';

export class ModuleLearningError extends Error {
  readonly code: ModuleLearningErrorCode;

  constructor(code: ModuleLearningErrorCode, message: string) {
    super(message);
    this.name = 'ModuleLearningError';
    this.code = code;
  }
}

export interface SubmitModuleQuizInput {
  readonly assignmentId: string;
  readonly moduleId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly answers: readonly ModuleQuizAnswerInput[];
}

export interface ModuleLearningService {
  dashboardSummary(actor: OnboardingActor): Promise<{
    readonly needsSupportModules: number;
    readonly openFlags: number;
  }>;
  getModules(actor: OnboardingActor, assignmentId: string): Promise<readonly ModuleStateDto[]>;
  openModule(actor: OnboardingActor, assignmentId: string, moduleId: string): Promise<ModuleStateDto>;
  completeLesson(actor: OnboardingActor, assignmentId: string, moduleId: string): Promise<ModuleStateDto>;
  startModuleQuiz(
    actor: OnboardingActor,
    assignmentId: string,
    moduleId: string,
  ): Promise<ModuleQuizStartDto>;
  submitModuleQuiz(actor: OnboardingActor, input: SubmitModuleQuizInput): Promise<ModuleQuizResultDto>;
  getModuleAttempt(actor: OnboardingActor, attemptId: string): Promise<ModuleQuizResultDto>;
  grantModuleRetry(
    actor: OnboardingActor,
    assignmentId: string,
    moduleId: string,
  ): Promise<ModuleStateDto>;
  questionStats(
    actor: OnboardingActor,
    templateId: string,
    version: number,
  ): Promise<readonly ModuleQuestionStatDto[]>;
}

export interface ModuleLearningServiceOptions {
  readonly now?: () => string;
  readonly randomInt?: (maxExclusive: number) => number;
}

interface AssignmentDbRecord extends StoreRecord {
  readonly id: string;
  readonly memberId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateSnapshot: TemplateSnapshot;
  readonly status: AssignmentStatus;
  readonly assignedBy: string;
  readonly updatedAt: string;
}

interface ProgressDbRecord extends StoreRecord, ModuleProgressRecord {}

interface ModuleAttemptDbRecord extends StoreRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly memberId: string;
  readonly moduleId: string;
  readonly ordinal: number;
  readonly status: 'started' | 'submitted';
  readonly questionOrder: readonly string[];
  readonly optionOrder: Readonly<Record<string, readonly string[]>>;
  readonly answers?: readonly ModuleAttemptAnswer[];
  readonly correctCount?: number;
  readonly totalCount?: number;
  readonly score?: number;
  readonly passed?: boolean;
  readonly operationId?: string;
  readonly startedAt: string;
  readonly submittedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TemplateContentDbRecord extends StoreRecord {
  readonly flags?: readonly { readonly status?: string }[];
}

function attemptsAllowed(
  content: TemplateContentSnapshot,
  progress: Pick<ModuleProgressRecord, 'extraAttempts'> | undefined,
): number | null {
  return content.maxAttemptsPerModule === null
    ? null
    : content.maxAttemptsPerModule + (progress?.extraAttempts ?? 0);
}

export function deriveModuleStates(
  snapshot: TemplateSnapshot,
  progressRows: readonly ModuleProgressRecord[],
): readonly ModuleStateDto[] {
  const content = snapshot.content;
  if (!content || content.assessmentMode !== 'per_module') return [];
  const progress = new Map(progressRows.map((row) => [row.moduleId, row]));
  return snapshot.modules.map((module, index) => {
    const current = progress.get(module.id);
    const previous = index === 0 ? undefined : progress.get(snapshot.modules[index - 1].id);
    const allowed = attemptsAllowed(content, current);
    let status: ModuleLearningStatus;
    if (current?.passedAt) status = 'passed';
    else if (content.learningMode === 'sequential' && index > 0 && !previous?.passedAt) status = 'locked';
    else if (allowed !== null && (current?.attemptCount ?? 0) >= allowed) status = 'needs_support';
    else if ((current?.attemptCount ?? 0) > 0) status = 'quiz_failed';
    else if (current?.lessonCompletedAt) status = 'quiz_ready';
    else if (current?.openedAt) status = 'learning';
    else status = 'available';
    return {
      moduleId: module.id,
      title: module.title,
      order: module.order,
      status,
      ...(current?.bestScore === undefined ? {} : { bestScore: current.bestScore }),
      attemptsUsed: current?.attemptCount ?? 0,
      attemptsAllowed: allowed,
    };
  });
}

function shuffle<T>(items: readonly T[], randomInt: (maxExclusive: number) => number): readonly T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapWith = randomInt(index + 1);
    if (!Number.isInteger(swapWith) || swapWith < 0 || swapWith > index) {
      throw new ModuleLearningError('ANSWER_INVALID', 'Random order generator returned an invalid index.');
    }
    [shuffled[index], shuffled[swapWith]] = [shuffled[swapWith], shuffled[index]];
  }
  return shuffled;
}

export function createModuleLearningService(
  store: OnboardingStore,
  assignments: AssignmentService,
  notifications: NotificationPort,
  options: ModuleLearningServiceOptions = {},
): ModuleLearningService {
  const now = options.now ?? (() => new Date().toISOString());
  const randomInt = options.randomInt ?? secureRandomInt;

  async function learnerAssignment(
    actor: OnboardingActor,
    assignmentId: string,
  ): Promise<AssignmentDbRecord> {
    try {
      await assignments.getMine(actor, assignmentId);
    } catch {
      throw new ModuleLearningError('MEMBER_FORBIDDEN', 'Assignment does not belong to this learner.');
    }
    const row = await store.get<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', assignmentId);
    if (!row || row.memberId !== actor.userId) {
      throw new ModuleLearningError('MEMBER_FORBIDDEN', 'Assignment does not belong to this learner.');
    }
    return row;
  }

  async function adminAssignment(
    actor: OnboardingActor,
    assignmentId: string,
  ): Promise<AssignmentDbRecord> {
    if (actor.access !== 'admin') {
      throw new ModuleLearningError('ADMIN_REQUIRED', 'Admin access is required.');
    }
    try {
      await assignments.getAdminDetail(actor, assignmentId);
    } catch {
      throw new ModuleLearningError('ASSIGNMENT_NOT_FOUND', 'Assignment was not found.');
    }
    const row = await store.get<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', assignmentId);
    if (!row) throw new ModuleLearningError('ASSIGNMENT_NOT_FOUND', 'Assignment was not found.');
    return row;
  }

  function contentOf(row: AssignmentDbRecord): TemplateContentSnapshot {
    const content = row.templateSnapshot.content;
    if (!content || content.assessmentMode !== 'per_module') {
      throw new ModuleLearningError(
        'ASSESSMENT_MODE_MISMATCH',
        'This assignment uses the legacy final assessment.',
      );
    }
    return content;
  }

  async function progressRows(
    roomId: string,
    assignmentId: string,
  ): Promise<readonly ProgressDbRecord[]> {
    return (await store.query<ProgressDbRecord>(roomId, 'onboarding_module_progress', {
      filter: { assignmentId },
      limit: 1000,
    })).records;
  }

  async function moduleContext(
    actor: OnboardingActor,
    assignmentId: string,
    moduleId: string,
  ) {
    const assignment = await learnerAssignment(actor, assignmentId);
    const content = contentOf(assignment);
    const module = assignment.templateSnapshot.modules.find((item) => item.id === moduleId);
    const moduleContent = content.modules.find((item) => item.moduleId === moduleId);
    if (!module || !moduleContent) {
      throw new ModuleLearningError('MODULE_NOT_FOUND', 'Module was not found in this assignment.');
    }
    const rows = await progressRows(actor.roomId, assignmentId);
    const state = deriveModuleStates(assignment.templateSnapshot, rows)
      .find((item) => item.moduleId === moduleId);
    if (!state) throw new ModuleLearningError('MODULE_NOT_FOUND', 'Module state was not found.');
    return {
      assignment,
      content,
      module,
      moduleContent,
      progress: rows.find((item) => item.moduleId === moduleId),
      progressRows: rows,
      state,
    };
  }

  async function ensureProgress(
    actor: OnboardingActor,
    assignment: AssignmentDbRecord,
    moduleId: string,
  ): Promise<ProgressDbRecord> {
    const rows = await store.query<ProgressDbRecord>(actor.roomId, 'onboarding_module_progress', {
      filter: { assignmentId: assignment.id, moduleId },
      limit: 1,
    });
    if (rows.records[0]) return rows.records[0];
    const timestamp = now();
    return store.create<ProgressDbRecord>(actor.roomId, 'onboarding_module_progress', {
      assignmentId: assignment.id,
      memberId: actor.userId,
      moduleId,
      attemptCount: 0,
      extraAttempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  function safeAttempt(
    attempt: ModuleAttemptDbRecord,
    snapshot: TemplateSnapshot,
  ): ModuleQuizStartDto {
    const module = snapshot.modules.find((item) => item.id === attempt.moduleId);
    if (!module) throw new ModuleLearningError('MODULE_NOT_FOUND', 'Attempt module was not found.');
    const questions = new Map(module.questions.map((question) => [question.id, question]));
    return {
      attemptId: attempt.id,
      moduleId: attempt.moduleId,
      ordinal: attempt.ordinal,
      questions: attempt.questionOrder.map((questionId) => {
        const question = questions.get(questionId);
        if (!question) throw new ModuleLearningError('ANSWER_INVALID', 'Attempt question is missing.');
        const optionsById = new Map((question.options ?? []).map((option) => [option.id, option]));
        return {
          id: question.id,
          prompt: question.prompt,
          options: (attempt.optionOrder[question.id] ?? []).map((optionId) => {
            const option = optionsById.get(optionId);
            if (!option) throw new ModuleLearningError('ANSWER_INVALID', 'Attempt option is missing.');
            return option;
          }),
        };
      }),
    };
  }

  async function resultFor(
    actor: OnboardingActor,
    attempt: ModuleAttemptDbRecord,
    assignment?: AssignmentDbRecord,
  ): Promise<ModuleQuizResultDto> {
    if (attempt.memberId !== actor.userId || attempt.status !== 'submitted') {
      throw new ModuleLearningError('MODULE_ATTEMPT_NOT_FOUND', 'Submitted module attempt was not found.');
    }
    const row = assignment ?? await learnerAssignment(actor, attempt.assignmentId);
    const content = contentOf(row);
    const module = row.templateSnapshot.modules.find((item) => item.id === attempt.moduleId);
    if (!module) throw new ModuleLearningError('MODULE_NOT_FOUND', 'Attempt module was not found.');
    const questions = new Map(module.questions.map((question) => [question.id, question]));
    const metadata = new Map(content.questionMeta.map((item) => [item.questionId, item]));
    const answers = new Map((attempt.answers ?? []).map((answer) => [answer.questionId, answer]));
    const progress = (await progressRows(actor.roomId, row.id))
      .find((item) => item.moduleId === attempt.moduleId);
    const allowed = attemptsAllowed(content, progress);
    return {
      attemptId: attempt.id,
      moduleId: attempt.moduleId,
      ordinal: attempt.ordinal,
      score: attempt.score ?? 0,
      passed: attempt.passed ?? false,
      passingScore: row.templateSnapshot.passingScore ?? 70,
      correctCount: attempt.correctCount ?? 0,
      totalCount: attempt.totalCount ?? attempt.questionOrder.length,
      attemptsUsed: progress?.attemptCount ?? attempt.ordinal,
      attemptsAllowed: allowed,
      items: attempt.questionOrder.map((questionId) => {
        const question = questions.get(questionId);
        const meta = metadata.get(questionId);
        const answer = answers.get(questionId);
        if (!question || !meta || !answer || !question.correctOptionIds?.[0]) {
          throw new ModuleLearningError('ANSWER_INVALID', 'Submitted attempt details are incomplete.');
        }
        const optionsById = new Map((question.options ?? []).map((option) => [option.id, option]));
        return {
          questionId,
          prompt: question.prompt,
          options: (attempt.optionOrder[questionId] ?? []).map((optionId) => {
            const option = optionsById.get(optionId);
            if (!option) throw new ModuleLearningError('ANSWER_INVALID', 'Submitted option is missing.');
            return option;
          }),
          selectedOptionId: answer.selectedOptionId,
          correctOptionId: question.correctOptionIds[0],
          correct: answer.correct,
          explanation: question.explanation ?? '',
          sourceRefs: meta.sourceRefs,
          blockIds: meta.blockIds,
        };
      }),
    };
  }

  async function writeAudit(
    actor: OnboardingActor,
    action: string,
    targetId: string,
    metadata: StoreRecord,
    operationId: string,
  ): Promise<void> {
    await store.create(actor.roomId, 'onboarding_audit_events', {
      actorId: actor.userId,
      action,
      targetType: 'assignment',
      targetId,
      metadata,
      operationId,
      occurredAt: now(),
    }, operationId);
  }

  return {
    async dashboardSummary(actor) {
      if (actor.access !== 'admin') {
        throw new ModuleLearningError('ADMIN_REQUIRED', 'Admin access is required.');
      }
      const [assignments, progress, templateContent] = await Promise.all([
        store.query<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', { limit: 1000 }),
        store.query<ProgressDbRecord>(actor.roomId, 'onboarding_module_progress', { limit: 1000 }),
        store.query<TemplateContentDbRecord>(actor.roomId, 'onboarding_template_content', { limit: 1000 }),
      ]);
      const progressByAssignment = new Map<string, ProgressDbRecord[]>();
      for (const row of progress.records) {
        const current = progressByAssignment.get(row.assignmentId) ?? [];
        current.push(row);
        progressByAssignment.set(row.assignmentId, current);
      }
      const needsSupportModules = assignments.records.reduce((total, assignment) =>
        total + deriveModuleStates(
          assignment.templateSnapshot,
          progressByAssignment.get(assignment.id) ?? [],
        ).filter((module) => module.status === 'needs_support').length, 0);
      const openFlags = templateContent.records.reduce((total, row) =>
        total + (row.flags ?? []).filter((flag) => flag.status === 'open').length, 0);
      return { needsSupportModules, openFlags };
    },

    async getModules(actor, assignmentId) {
      const assignment = await learnerAssignment(actor, assignmentId);
      contentOf(assignment);
      return deriveModuleStates(
        assignment.templateSnapshot,
        await progressRows(actor.roomId, assignmentId),
      );
    },

    async openModule(actor, assignmentId, moduleId) {
      const context = await moduleContext(actor, assignmentId, moduleId);
      if (context.state.status === 'locked') {
        throw new ModuleLearningError('MODULE_LOCKED', 'Complete the previous module first.');
      }
      let progress = context.progress ?? await ensureProgress(actor, context.assignment, moduleId);
      if (!progress.openedAt) {
        const timestamp = now();
        progress = await store.update<ProgressDbRecord>(
          actor.roomId,
          'onboarding_module_progress',
          progress.id,
          { openedAt: timestamp, updatedAt: timestamp },
        );
        if (context.assignment.status === 'assigned' || context.assignment.status === 'retry') {
          await store.update(actor.roomId, 'onboarding_assignments', context.assignment.id, {
            status: 'in_progress',
            updatedAt: timestamp,
          });
        }
      }
      return deriveModuleStates(
        context.assignment.templateSnapshot,
        context.progressRows.filter((row) => row.moduleId !== moduleId).concat(progress),
      ).find((state) => state.moduleId === moduleId)!;
    },

    async completeLesson(actor, assignmentId, moduleId) {
      const context = await moduleContext(actor, assignmentId, moduleId);
      if (context.state.status === 'locked') {
        throw new ModuleLearningError('MODULE_LOCKED', 'Complete the previous module first.');
      }
      if (!context.progress?.openedAt) {
        throw new ModuleLearningError('LESSON_NOT_COMPLETED', 'Open the lesson before completing it.');
      }
      let progress = context.progress;
      if (!progress.lessonCompletedAt) {
        const timestamp = now();
        progress = await store.update<ProgressDbRecord>(
          actor.roomId,
          'onboarding_module_progress',
          progress.id,
          { lessonCompletedAt: timestamp, updatedAt: timestamp },
        );
      }
      return deriveModuleStates(
        context.assignment.templateSnapshot,
        context.progressRows.filter((row) => row.moduleId !== moduleId).concat(progress),
      ).find((state) => state.moduleId === moduleId)!;
    },

    async startModuleQuiz(actor, assignmentId, moduleId) {
      const context = await moduleContext(actor, assignmentId, moduleId);
      if (context.state.status === 'locked') {
        throw new ModuleLearningError('MODULE_LOCKED', 'Complete the previous module first.');
      }
      if (context.state.status === 'passed') {
        throw new ModuleLearningError('MODULE_ALREADY_PASSED', 'This module has already been passed.');
      }
      const existing = await store.query<ModuleAttemptDbRecord>(
        actor.roomId,
        'onboarding_module_attempts',
        { filter: { assignmentId, moduleId, memberId: actor.userId, status: 'started' }, limit: 1 },
      );
      if (existing.records[0]) return safeAttempt(existing.records[0], context.assignment.templateSnapshot);
      if (!context.progress?.lessonCompletedAt) {
        throw new ModuleLearningError('LESSON_NOT_COMPLETED', 'Complete the lesson before starting its quiz.');
      }
      if (context.state.status === 'needs_support') {
        throw new ModuleLearningError('MODULE_ATTEMPT_LIMIT', 'No module attempt remains.');
      }
      const questions = context.module.questions;
      if (questions.length === 0) {
        throw new ModuleLearningError('ANSWER_INVALID', 'This module has no quiz questions.');
      }
      const questionOrder = shuffle(questions.map((question) => question.id), randomInt);
      const optionOrder = Object.fromEntries(questions.map((question) => [
        question.id,
        shuffle((question.options ?? []).map((option) => option.id), randomInt),
      ]));
      const timestamp = now();
      const attempt = await store.create<ModuleAttemptDbRecord>(
        actor.roomId,
        'onboarding_module_attempts',
        {
          assignmentId,
          memberId: actor.userId,
          moduleId,
          ordinal: context.state.attemptsUsed + 1,
          status: 'started',
          questionOrder,
          optionOrder,
          startedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      );
      return safeAttempt(attempt, context.assignment.templateSnapshot);
    },

    async submitModuleQuiz(actor, input) {
      const operationId = input.operationId.trim();
      if (!operationId) throw new ModuleLearningError('OPERATION_CONFLICT', 'Operation ID is required.');
      const prior = await store.query<ModuleAttemptDbRecord>(
        actor.roomId,
        'onboarding_module_attempts',
        { filter: { operationId }, limit: 2 },
      );
      if (prior.records[0]) {
        if (
          prior.records[0].id !== input.attemptId
          || prior.records[0].assignmentId !== input.assignmentId
          || prior.records[0].memberId !== actor.userId
        ) {
          throw new ModuleLearningError(
            'OPERATION_CONFLICT',
            'This operation ID belongs to another module attempt.',
          );
        }
        return resultFor(actor, prior.records[0]);
      }
      const context = await moduleContext(actor, input.assignmentId, input.moduleId);
      const attempt = await store.get<ModuleAttemptDbRecord>(
        actor.roomId,
        'onboarding_module_attempts',
        input.attemptId,
      );
      if (
        !attempt
        || attempt.status !== 'started'
        || attempt.assignmentId !== input.assignmentId
        || attempt.moduleId !== input.moduleId
        || attempt.memberId !== actor.userId
      ) {
        throw new ModuleLearningError('MODULE_ATTEMPT_NOT_FOUND', 'Started module attempt was not found.');
      }
      const questions = new Map(context.module.questions.map((question) => [question.id, question]));
      const answerIds = input.answers.map((answer) => answer.questionId);
      if (
        input.answers.length !== attempt.questionOrder.length
        || new Set(answerIds).size !== answerIds.length
        || attempt.questionOrder.some((questionId) => !answerIds.includes(questionId))
      ) {
        throw new ModuleLearningError('ANSWER_INVALID', 'Answer every module question exactly once.');
      }
      const answers: ModuleAttemptAnswer[] = input.answers.map((answer) => {
        const question = questions.get(answer.questionId);
        const valid = question?.options?.some((option) => option.id === answer.selectedOptionId);
        const correctOptionId = question?.correctOptionIds?.[0];
        if (!question || !valid || !correctOptionId) {
          throw new ModuleLearningError('ANSWER_INVALID', 'A submitted answer is invalid.');
        }
        return {
          questionId: answer.questionId,
          selectedOptionId: answer.selectedOptionId,
          correct: answer.selectedOptionId === correctOptionId,
        };
      });
      const correctCount = answers.filter((answer) => answer.correct).length;
      const totalCount = answers.length;
      const score = Math.round(correctCount / totalCount * 100);
      const passingScore = context.assignment.templateSnapshot.passingScore ?? 70;
      const passed = score >= passingScore;
      const timestamp = now();
      const updatedAttempt = await store.update<ModuleAttemptDbRecord>(
        actor.roomId,
        'onboarding_module_attempts',
        attempt.id,
        {
          status: 'submitted',
          answers,
          correctCount,
          totalCount,
          score,
          passed,
          operationId,
          submittedAt: timestamp,
          updatedAt: timestamp,
        },
        { operationId },
      );
      const baseProgress = context.progress
        ?? await ensureProgress(actor, context.assignment, input.moduleId);
      const updatedProgress = await store.update<ProgressDbRecord>(
        actor.roomId,
        'onboarding_module_progress',
        baseProgress.id,
        {
          attemptCount: baseProgress.attemptCount + 1,
          bestScore: Math.max(baseProgress.bestScore ?? 0, score),
          ...(passed ? { passedAt: timestamp } : {}),
          updatedAt: timestamp,
        },
      );
      const latestProgress = (await progressRows(actor.roomId, context.assignment.id))
        .filter((row) => row.moduleId !== input.moduleId)
        .concat(updatedProgress);
      const allPassed = context.assignment.templateSnapshot.modules.every((module) =>
        latestProgress.some((progress) => progress.moduleId === module.id && progress.passedAt));
      await store.update(actor.roomId, 'onboarding_assignments', context.assignment.id, {
        status: allPassed ? 'passed' : 'in_progress',
        updatedAt: timestamp,
      });
      await writeAudit(
        actor,
        allPassed ? 'assignment.completed' : 'module_quiz.submitted',
        context.assignment.id,
        { moduleId: input.moduleId, attemptId: attempt.id, score, passed },
        operationId,
      );
      try {
        if (allPassed) {
          await notifications.notify(
            actor.userId,
            'Hoàn thành onboarding',
            'Bạn đã hoàn thành toàn bộ lộ trình onboarding.',
          );
        } else {
          const allowed = attemptsAllowed(context.content, updatedProgress);
          if (!passed && allowed !== null && updatedProgress.attemptCount >= allowed) {
            await notifications.notify(
              context.assignment.assignedBy,
              'Nhân sự cần hỗ trợ onboarding',
              'Một nhân sự đã dùng hết lượt làm bài của module.',
            );
          }
        }
      } catch {
        // Notification delivery is best effort and must not roll back a scored attempt.
      }
      return resultFor(actor, updatedAttempt, {
        ...context.assignment,
        status: allPassed ? 'passed' : 'in_progress',
      });
    },

    async getModuleAttempt(actor, attemptId) {
      const attempt = await store.get<ModuleAttemptDbRecord>(
        actor.roomId,
        'onboarding_module_attempts',
        attemptId,
      );
      if (!attempt) {
        throw new ModuleLearningError('MODULE_ATTEMPT_NOT_FOUND', 'Submitted module attempt was not found.');
      }
      return resultFor(actor, attempt);
    },

    async grantModuleRetry(actor, assignmentId, moduleId) {
      const assignment = await adminAssignment(actor, assignmentId);
      contentOf(assignment);
      if (!assignment.templateSnapshot.modules.some((module) => module.id === moduleId)) {
        throw new ModuleLearningError('MODULE_NOT_FOUND', 'Module was not found in this assignment.');
      }
      const rows = await progressRows(actor.roomId, assignmentId);
      let progress = rows.find((item) => item.moduleId === moduleId);
      const timestamp = now();
      if (progress) {
        progress = await store.update<ProgressDbRecord>(
          actor.roomId,
          'onboarding_module_progress',
          progress.id,
          { extraAttempts: progress.extraAttempts + 1, updatedAt: timestamp },
        );
      } else {
        progress = await store.create<ProgressDbRecord>(
          actor.roomId,
          'onboarding_module_progress',
          {
            assignmentId,
            memberId: assignment.memberId,
            moduleId,
            attemptCount: 0,
            extraAttempts: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        );
      }
      await writeAudit(
        actor,
        'module.retry_granted',
        assignmentId,
        { moduleId, extraAttempts: progress.extraAttempts },
        'module-retry:' + assignmentId + ':' + moduleId + ':' + timestamp,
      );
      const states = deriveModuleStates(
        assignment.templateSnapshot,
        rows.filter((row) => row.moduleId !== moduleId).concat(progress),
      );
      const state = states.find((item) => item.moduleId === moduleId);
      if (!state) {
        throw new ModuleLearningError('MODULE_NOT_FOUND', 'Module state was not found.');
      }
      return state;
    },

    async questionStats(actor, templateId, version) {
      if (actor.access !== 'admin') {
        throw new ModuleLearningError('ADMIN_REQUIRED', 'Admin access is required.');
      }
      const assignmentsForTemplate = await store.query<AssignmentDbRecord>(
        actor.roomId,
        'onboarding_assignments',
        { filter: { templateId, templateVersion: version }, limit: 1000 },
      );
      const assignmentIds = new Set(assignmentsForTemplate.records.map((row) => row.id));
      const attempts: ModuleAttemptDbRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.query<ModuleAttemptDbRecord>(
          actor.roomId,
          'onboarding_module_attempts',
          { filter: { status: 'submitted' }, limit: 1000, ...(cursor ? { cursor } : {}) },
        );
        attempts.push(...page.records.filter((attempt) => assignmentIds.has(attempt.assignmentId)));
        cursor = page.nextCursor;
      } while (cursor);
      const counts = new Map<string, { correct: number; total: number }>();
      attempts.flatMap((attempt) => attempt.answers ?? []).forEach((answer) => {
        const current = counts.get(answer.questionId) ?? { correct: 0, total: 0 };
        counts.set(answer.questionId, {
          correct: current.correct + Number(answer.correct),
          total: current.total + 1,
        });
      });
      return [...counts.entries()].map(([questionId, count]) => ({
        questionId,
        correctCount: count.correct,
        attemptCount: count.total,
        correctPercent: Math.round(count.correct / count.total * 100),
      })).sort((left, right) => left.questionId.localeCompare(right.questionId));
    },
  };
}
