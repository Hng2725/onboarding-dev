import { createHash } from 'node:crypto';

import type { OnboardingActor } from './auth';
import type { AssignmentService } from './assignments';
import type {
  AnswerRecord,
  AssignmentStatus,
  AttemptRecord,
  AttemptStatus,
  LearnerAttemptResultDto,
  MultipleChoiceScore,
  OnboardingQuestion,
  TemplateSnapshot,
} from './contracts';
import type { OnboardingStore, StoreRecord } from './store';
import type { TemplateService } from './templates';
import { nextAssignmentStatus, scoreMultipleChoice } from './workflow';

export interface DraftAnswerInput {
  readonly questionId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly essayText?: string;
}

export interface SaveAttemptDraftInput {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly answers: readonly DraftAnswerInput[];
}

export interface SubmitAttemptInput {
  readonly assignmentId: string;
  readonly operationId: string;
}

export interface AttemptService {
  getOrCreateDraft(actor: OnboardingActor, assignmentId: string): Promise<AttemptRecord>;
  saveDraft(actor: OnboardingActor, input: SaveAttemptDraftInput): Promise<AttemptRecord>;
  submit(actor: OnboardingActor, input: SubmitAttemptInput): Promise<LearnerAttemptResultDto>;
  getLearnerResult(actor: OnboardingActor, attemptId: string): Promise<LearnerAttemptResultDto>;
}

type AttemptErrorCode =
  | 'EXERCISE_LOCKED'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_NOT_DRAFT'
  | 'ATTEMPT_LIMIT'
  | 'REQUIRED_ANSWER_MISSING'
  | 'ANSWER_INVALID'
  | 'OPERATION_CONFLICT'
  | 'MEMBER_FORBIDDEN';

export class AttemptServiceError extends Error {
  readonly code: AttemptErrorCode;

  constructor(code: AttemptErrorCode, message: string) {
    super(message);
    this.name = 'AttemptServiceError';
    this.code = code;
  }
}

interface AssignmentDbRecord extends StoreRecord {
  readonly id: string;
  readonly memberId: string;
  readonly templateSnapshot: TemplateSnapshot;
  readonly status: AssignmentStatus;
  readonly allowedAttempts: number;
}

interface AttemptDbRecord extends StoreRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly memberId: string;
  readonly ordinal: number;
  readonly status: AttemptStatus;
  readonly operationId?: string;
  readonly submissionHash?: string;
  readonly mcScore?: MultipleChoiceScore | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt?: string;
}

interface AnswerDbRecord extends StoreRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly questionId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly essayText?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt?: string;
}

export interface AttemptServiceOptions {
  readonly now?: () => string;
}

function questionsOf(snapshot: TemplateSnapshot): readonly OnboardingQuestion[] {
  return snapshot.modules.flatMap((module) => module.questions);
}

function attemptFrom(row: AttemptDbRecord, roomId: string): AttemptRecord {
  return {
    id: row.id,
    roomId,
    assignmentId: row.assignmentId,
    memberId: row.memberId,
    ordinal: row.ordinal,
    status: row.status,
    operationId: row.operationId,
    submissionHash: row.submissionHash,
    mcScore: row.mcScore,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
  };
}

function answerFrom(row: AnswerDbRecord): AnswerRecord {
  return {
    id: row.id,
    attemptId: row.attemptId,
    questionId: row.questionId,
    selectedOptionIds: row.selectedOptionIds,
    essayText: row.essayText,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateAnswers(
  questions: readonly OnboardingQuestion[],
  answers: readonly DraftAnswerInput[],
  requireComplete: boolean,
): void {
  const questionMap = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = questionMap.get(answer.questionId);
    if (!question || seen.has(answer.questionId)) {
      throw new AttemptServiceError('ANSWER_INVALID', 'An answer references an unknown or duplicate question.');
    }
    seen.add(answer.questionId);
    if (question.type === 'essay') {
      if (answer.selectedOptionIds?.length || (requireComplete && question.required !== false && !answer.essayText?.trim())) {
        throw new AttemptServiceError('ANSWER_INVALID', 'Essay answers require non-empty text and no option selection.');
      }
      continue;
    }
    const selected = answer.selectedOptionIds ?? [];
    const optionIds = new Set((question.options ?? []).map((option) => option.id));
    const selectionValid = !answer.essayText?.trim() && (
      (!requireComplete && selected.length === 0)
      || (selected.length > 0
        && selected.every((optionId) => optionIds.has(optionId))
        && new Set(selected).size === selected.length
        && (question.type !== 'single_choice' || selected.length === 1))
    );
    if (!selectionValid) {
      throw new AttemptServiceError('ANSWER_INVALID', 'Choice answers must select valid options for their question type.');
    }
  }
  if (requireComplete) {
    const missing = questions.some((question) => question.required !== false && !seen.has(question.id));
    if (missing) throw new AttemptServiceError('REQUIRED_ANSWER_MISSING', 'Every required question must be answered.');
  }
}

function submissionHash(answers: readonly AnswerRecord[]): string {
  const normalized = answers
    .map((answer) => ({
      questionId: answer.questionId,
      selectedOptionIds: [...(answer.selectedOptionIds ?? [])].sort(),
      essayText: answer.essayText?.trim() ?? '',
    }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function createAttemptService(
  store: OnboardingStore,
  assignments: AssignmentService,
  _templates: TemplateService,
  options: AttemptServiceOptions = {},
): AttemptService {
  const now = options.now ?? (() => new Date().toISOString());

  async function rawAssignment(actor: OnboardingActor, assignmentId: string): Promise<AssignmentDbRecord> {
    await assignments.getMine(actor, assignmentId);
    const row = await store.get<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', assignmentId);
    if (!row || row.memberId !== actor.userId) {
      throw new AttemptServiceError('MEMBER_FORBIDDEN', 'Assignment does not belong to this learner.');
    }
    return row;
  }

  async function draftFor(actor: OnboardingActor, assignmentId: string): Promise<AttemptDbRecord | undefined> {
    const result = await store.query<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', {
      filter: { assignmentId, memberId: actor.userId, status: 'draft' }, limit: 2,
    });
    return result.records[0];
  }

  async function answersFor(roomId: string, attemptId: string): Promise<readonly AnswerDbRecord[]> {
    const result = await store.query<AnswerDbRecord>(roomId, 'onboarding_answers', {
      filter: { attemptId }, limit: 1000,
    });
    return result.records;
  }

  async function requireDraft(actor: OnboardingActor, assignmentId: string, attemptId: string): Promise<AttemptDbRecord> {
    const row = await store.get<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', attemptId);
    if (!row || row.assignmentId !== assignmentId || row.memberId !== actor.userId) {
      throw new AttemptServiceError('ATTEMPT_NOT_FOUND', 'Draft attempt was not found.');
    }
    if (row.status !== 'draft') throw new AttemptServiceError('ATTEMPT_NOT_DRAFT', 'Submitted attempts cannot be edited.');
    return row;
  }

  async function resultFor(actor: OnboardingActor, row: AttemptDbRecord): Promise<LearnerAttemptResultDto> {
    if (row.memberId !== actor.userId) {
      throw new AttemptServiceError('MEMBER_FORBIDDEN', 'Attempt does not belong to this learner.');
    }
    const answers = await answersFor(actor.roomId, row.id);
    return {
      attemptId: row.id,
      assignmentId: row.assignmentId,
      status: row.status,
      mcScore: row.mcScore ?? null,
      answers: answers.map(answerFrom),
      essayFeedback: [],
    };
  }

  return {
    async getOrCreateDraft(actor, assignmentId) {
      const detail = await assignments.getMine(actor, assignmentId);
      if (!Object.values(detail.moduleUnlocks).every(Boolean)) {
        throw new AttemptServiceError('EXERCISE_LOCKED', 'Complete every required resource before starting the exercise.');
      }
      const existing = await draftFor(actor, assignmentId);
      if (existing) return attemptFrom(existing, actor.roomId);
      const assignment = await rawAssignment(actor, assignmentId);
      const attempts = await store.query<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', {
        filter: { assignmentId, memberId: actor.userId }, limit: 1000,
      });
      if (attempts.records.length >= assignment.allowedAttempts) {
        throw new AttemptServiceError('ATTEMPT_LIMIT', 'No attempt remains until an Admin grants a retry.');
      }
      const timestamp = now();
      const row = await store.create<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', {
        assignmentId,
        memberId: actor.userId,
        ordinal: attempts.records.length + 1,
        status: 'draft',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await store.update(actor.roomId, 'onboarding_assignments', assignmentId, {
        activeAttemptId: row.id,
        status: assignment.status === 'assigned' || assignment.status === 'retry' ? 'in_progress' : assignment.status,
        updatedAt: timestamp,
      });
      return attemptFrom(row, actor.roomId);
    },

    async saveDraft(actor, input) {
      const assignment = await rawAssignment(actor, input.assignmentId);
      const attempt = await requireDraft(actor, input.assignmentId, input.attemptId);
      const questions = questionsOf(assignment.templateSnapshot);
      validateAnswers(questions, input.answers, false);
      const existing = await answersFor(actor.roomId, attempt.id);
      const existingByQuestion = new Map(existing.map((answer) => [answer.questionId, answer]));
      const timestamp = now();
      const supplied = new Set(input.answers.map((answer) => answer.questionId));
      for (const answer of input.answers) {
        const current = existingByQuestion.get(answer.questionId);
        const data = {
          selectedOptionIds: answer.selectedOptionIds,
          essayText: answer.essayText?.trim(),
          updatedAt: timestamp,
        };
        if (current) await store.update(actor.roomId, 'onboarding_answers', current.id, data);
        else await store.create(actor.roomId, 'onboarding_answers', {
          attemptId: attempt.id,
          questionId: answer.questionId,
          ...data,
          createdAt: timestamp,
        });
      }
      for (const stale of existing.filter((answer) => !supplied.has(answer.questionId))) {
        await store.softDelete(actor.roomId, 'onboarding_answers', stale.id);
      }
      const updated = await store.update<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', attempt.id, {
        updatedAt: timestamp,
      });
      return attemptFrom(updated, actor.roomId);
    },

    async submit(actor, input) {
      const assignment = await rawAssignment(actor, input.assignmentId);
      const prior = await store.query<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', {
        filter: { operationId: input.operationId }, limit: 2,
      });
      const draft = await draftFor(actor, input.assignmentId);
      if (prior.records[0]) {
        if (prior.records[0].assignmentId !== input.assignmentId || prior.records[0].memberId !== actor.userId) {
          throw new AttemptServiceError('OPERATION_CONFLICT', 'This operation ID belongs to another assignment.');
        }
        if (!draft) return resultFor(actor, prior.records[0]);
        const currentHash = submissionHash((await answersFor(actor.roomId, draft.id)).map(answerFrom));
        if (currentHash !== prior.records[0].submissionHash) {
          throw new AttemptServiceError('OPERATION_CONFLICT', 'This operation ID was already used for different answers.');
        }
        return resultFor(actor, prior.records[0]);
      }
      if (!draft) throw new AttemptServiceError('ATTEMPT_NOT_FOUND', 'No draft attempt is ready to submit.');
      const answers = (await answersFor(actor.roomId, draft.id)).map(answerFrom);
      const questions = questionsOf(assignment.templateSnapshot);
      validateAnswers(questions, answers, true);
      const hash = submissionHash(answers);
      const mcScore = scoreMultipleChoice(questions, answers);
      const hasEssays = questions.some((question) => question.type === 'essay');
      const timestamp = now();
      const updatedAttempt = await store.update<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', draft.id, {
        status: mcScore ? 'auto_scored' : 'submitted',
        operationId: input.operationId,
        submissionHash: hash,
        mcScore,
        submittedAt: timestamp,
        updatedAt: timestamp,
      }, { operationId: input.operationId });
      for (const answer of await answersFor(actor.roomId, draft.id)) {
        await store.update(actor.roomId, 'onboarding_answers', answer.id, { submittedAt: timestamp, updatedAt: timestamp });
      }
      await store.update(actor.roomId, 'onboarding_assignments', assignment.id, {
        status: nextAssignmentStatus({
          currentStatus: assignment.status,
          submitted: true,
          hasEssays,
          essayFeedbackComplete: !hasEssays,
        }),
        activeAttemptId: draft.id,
        updatedAt: timestamp,
      });
      await store.create(actor.roomId, 'onboarding_audit_events', {
        actorId: actor.userId,
        action: 'attempt.submitted',
        targetType: 'attempt',
        targetId: draft.id,
        operationId: input.operationId,
        metadata: { assignmentId: assignment.id, mcScore },
        occurredAt: timestamp,
      });
      return resultFor(actor, updatedAttempt);
    },

    async getLearnerResult(actor, attemptId) {
      const row = await store.get<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', attemptId);
      if (!row || row.memberId !== actor.userId) {
        throw new AttemptServiceError('MEMBER_FORBIDDEN', 'Attempt does not belong to this learner.');
      }
      return resultFor(actor, row);
    },
  };
}
