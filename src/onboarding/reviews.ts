import type { OnboardingActor } from './auth';
import type { AssignmentService } from './assignments';
import type { AttemptService } from './attempts';
import type {
  AnswerRecord,
  EssayFeedbackRecord,
  EvaluationRecord,
  FinalConclusion,
  OnboardingQuestion,
  TemplateSnapshot,
} from './contracts';
import { createNotificationPort, type NotificationPort } from './notifications';
import type { OnboardingStore, StoreRecord } from './store';
import { canEvaluateAttempt } from './workflow';

export interface EssayQueueItem {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly answerId: string;
  readonly questionId: string;
  readonly prompt: string;
  readonly answer: string;
  readonly reviewed: boolean;
  readonly comment?: string;
}

export interface EvaluationQueueItem {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly memberId: string;
  readonly templateTitle: string;
}

export interface SaveEssayFeedbackInput {
  readonly attemptId: string;
  readonly answerId: string;
  readonly comment: string;
}

export interface PublishEvaluationInput {
  readonly attemptId: string;
  readonly operationId: string;
  readonly completionLevel: string;
  readonly strengths: string;
  readonly improvements: string;
  readonly publicComment: string;
  readonly conclusion: FinalConclusion;
}

export interface PublishEvaluationResult {
  readonly evaluation: EvaluationRecord;
  readonly warning?: string;
}

export interface PublishedReviewDto {
  readonly attemptId?: string;
  readonly essayFeedback: readonly EssayFeedbackRecord[];
  readonly evaluation?: Omit<EvaluationRecord, 'roomId' | 'operationId'>;
}

export interface ReviewService {
  listEssayQueue(actor: OnboardingActor): Promise<readonly EssayQueueItem[]>;
  saveEssayFeedback(actor: OnboardingActor, input: SaveEssayFeedbackInput): Promise<EssayFeedbackRecord>;
  listEvaluationQueue(actor: OnboardingActor): Promise<readonly EvaluationQueueItem[]>;
  publishEvaluation(actor: OnboardingActor, input: PublishEvaluationInput): Promise<PublishEvaluationResult>;
  getPublishedFeedback(actor: OnboardingActor, assignmentId: string): Promise<PublishedReviewDto>;
}

type ReviewErrorCode =
  | 'ADMIN_REQUIRED'
  | 'ATTEMPT_NOT_FOUND'
  | 'ANSWER_NOT_ESSAY'
  | 'EVALUATION_INVALID'
  | 'ESSAY_FEEDBACK_REQUIRED'
  | 'EVALUATION_EXISTS'
  | 'OPERATION_CONFLICT';

export class ReviewServiceError extends Error {
  readonly code: ReviewErrorCode;

  constructor(code: ReviewErrorCode, message: string) {
    super(message);
    this.name = 'ReviewServiceError';
    this.code = code;
  }
}

interface AssignmentDbRecord extends StoreRecord {
  readonly id: string;
  readonly memberId: string;
  readonly templateSnapshot: TemplateSnapshot;
  readonly status: string;
  readonly allowedAttempts: number;
}

interface AttemptDbRecord extends StoreRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly memberId: string;
  readonly status: string;
  readonly submittedAt?: string;
}

interface AnswerDbRecord extends StoreRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly questionId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly essayText?: string;
}

interface FeedbackDbRecord extends StoreRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly answerId: string;
  readonly comment: string;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
}

interface EvaluationDbRecord extends StoreRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly completionLevel: string;
  readonly strengths: string;
  readonly improvements: string;
  readonly comment: string;
  readonly conclusion: FinalConclusion;
  readonly evaluatedBy: string;
  readonly evaluatedAt: string;
  readonly operationId: string;
}

export interface ReviewServiceOptions {
  readonly notifications?: NotificationPort;
  readonly now?: () => string;
}

function requireAdmin(actor: OnboardingActor): void {
  if (actor.access !== 'admin') throw new ReviewServiceError('ADMIN_REQUIRED', 'Admin access is required.');
}

function questions(snapshot: TemplateSnapshot): readonly OnboardingQuestion[] {
  return snapshot.modules.flatMap((module) => module.questions);
}

function answer(row: AnswerDbRecord): AnswerRecord {
  return {
    id: row.id,
    attemptId: row.attemptId,
    questionId: row.questionId,
    selectedOptionIds: row.selectedOptionIds,
    essayText: row.essayText,
  };
}

function feedback(row: FeedbackDbRecord): EssayFeedbackRecord {
  return {
    id: row.id,
    attemptId: row.attemptId,
    answerId: row.answerId,
    comment: row.comment,
    reviewed: true,
    reviewerId: row.reviewedBy,
    reviewedAt: row.reviewedAt,
  };
}

function evaluation(row: EvaluationDbRecord, roomId: string): EvaluationRecord {
  return {
    id: row.id,
    roomId,
    assignmentId: row.assignmentId,
    attemptId: row.attemptId,
    completionLevel: row.completionLevel,
    strengths: row.strengths,
    improvements: row.improvements,
    publicComment: row.comment,
    conclusion: row.conclusion,
    evaluatorId: row.evaluatedBy,
    evaluatedAt: row.evaluatedAt,
    operationId: row.operationId,
  };
}

function publishedEvaluation(row: EvaluationDbRecord, roomId: string): Omit<EvaluationRecord, 'roomId' | 'operationId'> {
  const { roomId: _roomId, operationId: _operationId, ...safe } = evaluation(row, roomId);
  return safe;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ReviewServiceError('EVALUATION_INVALID', `${label} is required.`);
  return normalized;
}

export function createReviewService(
  store: OnboardingStore,
  assignments: AssignmentService,
  _attempts: AttemptService,
  options: ReviewServiceOptions = {},
): ReviewService {
  const now = options.now ?? (() => new Date().toISOString());

  async function attemptAndAssignment(roomId: string, attemptId: string) {
    const attempt = await store.get<AttemptDbRecord>(roomId, 'onboarding_attempts', attemptId);
    if (!attempt || !attempt.submittedAt) {
      throw new ReviewServiceError('ATTEMPT_NOT_FOUND', 'Submitted attempt was not found.');
    }
    const assignment = await store.get<AssignmentDbRecord>(roomId, 'onboarding_assignments', attempt.assignmentId);
    if (!assignment) throw new ReviewServiceError('ATTEMPT_NOT_FOUND', 'Assignment was not found.');
    return { attempt, assignment };
  }

  async function answerRows(roomId: string, attemptId: string) {
    return (await store.query<AnswerDbRecord>(roomId, 'onboarding_answers', {
      filter: { attemptId }, limit: 1000,
    })).records;
  }

  async function feedbackRows(roomId: string, attemptId: string) {
    return (await store.query<FeedbackDbRecord>(roomId, 'onboarding_essay_feedback', {
      filter: { attemptId }, limit: 1000,
    })).records;
  }

  async function allEssaysReviewed(roomId: string, attemptId: string): Promise<boolean> {
    const { assignment } = await attemptAndAssignment(roomId, attemptId);
    return canEvaluateAttempt(
      questions(assignment.templateSnapshot),
      (await answerRows(roomId, attemptId)).map(answer),
      (await feedbackRows(roomId, attemptId)).map(feedback),
    );
  }

  return {
    async listEssayQueue(actor) {
      requireAdmin(actor);
      const attempts = await store.query<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', { limit: 1000 });
      const queue: EssayQueueItem[] = [];
      for (const attempt of attempts.records.filter((item) => item.submittedAt)) {
        const assignment = await store.get<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', attempt.assignmentId);
        if (!assignment) continue;
        const prompts = new Map(questions(assignment.templateSnapshot)
          .filter((question) => question.type === 'essay')
          .map((question) => [question.id, question.prompt]));
        const feedbackByAnswer = new Map((await feedbackRows(actor.roomId, attempt.id))
          .map((row) => [row.answerId, row]));
        for (const row of await answerRows(actor.roomId, attempt.id)) {
          const prompt = prompts.get(row.questionId);
          if (!prompt) continue;
          const reviewed = feedbackByAnswer.get(row.id);
          queue.push({
            assignmentId: assignment.id,
            attemptId: attempt.id,
            answerId: row.id,
            questionId: row.questionId,
            prompt,
            answer: row.essayText ?? '',
            reviewed: Boolean(reviewed),
            comment: reviewed?.comment,
          });
        }
      }
      return queue;
    },

    async saveEssayFeedback(actor, input) {
      requireAdmin(actor);
      const { assignment } = await attemptAndAssignment(actor.roomId, input.attemptId);
      const answers = await answerRows(actor.roomId, input.attemptId);
      const target = answers.find((row) => row.id === input.answerId);
      const essayIds = new Set(questions(assignment.templateSnapshot)
        .filter((question) => question.type === 'essay')
        .map((question) => question.id));
      if (!target || !essayIds.has(target.questionId)) {
        throw new ReviewServiceError('ANSWER_NOT_ESSAY', 'Feedback can be attached only to an essay answer.');
      }
      const comment = input.comment.trim();
      if (!comment) throw new ReviewServiceError('ANSWER_NOT_ESSAY', 'Essay feedback comment is required.');
      const existing = (await feedbackRows(actor.roomId, input.attemptId)).find((row) => row.answerId === input.answerId);
      const timestamp = now();
      const row = existing
        ? await store.update<FeedbackDbRecord>(actor.roomId, 'onboarding_essay_feedback', existing.id, {
          comment, reviewedBy: actor.userId, reviewedAt: timestamp, updatedAt: timestamp,
        })
        : await store.create<FeedbackDbRecord>(actor.roomId, 'onboarding_essay_feedback', {
          attemptId: input.attemptId,
          answerId: input.answerId,
          comment,
          reviewedBy: actor.userId,
          reviewedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      await store.create(actor.roomId, 'onboarding_audit_events', {
        actorId: actor.userId,
        action: 'essay.feedback_saved',
        targetType: 'answer',
        targetId: input.answerId,
        metadata: { attemptId: input.attemptId },
        occurredAt: timestamp,
      });
      if (await allEssaysReviewed(actor.roomId, input.attemptId)) {
        await store.update(actor.roomId, 'onboarding_assignments', assignment.id, {
          status: 'awaiting_evaluation', updatedAt: timestamp,
        });
      }
      return feedback(row);
    },

    async listEvaluationQueue(actor) {
      requireAdmin(actor);
      const assignmentsRows = await store.query<AssignmentDbRecord>(actor.roomId, 'onboarding_assignments', {
        filter: { status: 'awaiting_evaluation' }, limit: 1000,
      });
      const queue: EvaluationQueueItem[] = [];
      for (const assignment of assignmentsRows.records) {
        const attempts = await store.query<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', {
          filter: { assignmentId: assignment.id }, orderBy: [{ field: 'ordinal', direction: 'desc' }], limit: 1,
        });
        const attempt = attempts.records[0];
        if (attempt?.submittedAt) queue.push({
          assignmentId: assignment.id,
          attemptId: attempt.id,
          memberId: assignment.memberId,
          templateTitle: assignment.templateSnapshot.title,
        });
      }
      return queue;
    },

    async publishEvaluation(actor, input) {
      requireAdmin(actor);
      if (!['passed', 'failed', 'retry'].includes(input.conclusion)) {
        throw new ReviewServiceError('EVALUATION_INVALID', 'Conclusion must be passed, failed, or retry.');
      }
      const content = {
        completionLevel: requiredText(input.completionLevel, 'Completion level'),
        strengths: requiredText(input.strengths, 'Strengths'),
        improvements: requiredText(input.improvements, 'Improvements'),
        comment: requiredText(input.publicComment, 'Public comment'),
      };
      const priorOperation = await store.query<EvaluationDbRecord>(actor.roomId, 'onboarding_evaluations', {
        filter: { operationId: input.operationId }, limit: 2,
      });
      if (priorOperation.records[0]) {
        if (priorOperation.records[0].attemptId !== input.attemptId) {
          throw new ReviewServiceError('OPERATION_CONFLICT', 'Evaluation operation ID belongs to another attempt.');
        }
        return { evaluation: evaluation(priorOperation.records[0], actor.roomId) };
      }
      const { attempt, assignment } = await attemptAndAssignment(actor.roomId, input.attemptId);
      const existing = await store.query<EvaluationDbRecord>(actor.roomId, 'onboarding_evaluations', {
        filter: { attemptId: input.attemptId }, limit: 2,
      });
      if (existing.records.length) {
        throw new ReviewServiceError('EVALUATION_EXISTS', 'This attempt already has an overall evaluation.');
      }
      if (!await allEssaysReviewed(actor.roomId, input.attemptId)) {
        throw new ReviewServiceError('ESSAY_FEEDBACK_REQUIRED', 'Every essay needs feedback before overall evaluation.');
      }
      const timestamp = now();
      const row = await store.create<EvaluationDbRecord>(actor.roomId, 'onboarding_evaluations', {
        assignmentId: assignment.id,
        attemptId: attempt.id,
        ...content,
        conclusion: input.conclusion,
        evaluatedBy: actor.userId,
        evaluatedAt: timestamp,
        operationId: input.operationId,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, input.operationId);
      await store.update(actor.roomId, 'onboarding_attempts', attempt.id, {
        status: 'reviewed', updatedAt: timestamp,
      });
      const retry = input.conclusion === 'retry';
      await store.update(actor.roomId, 'onboarding_assignments', assignment.id, {
        status: retry ? 'in_progress' : input.conclusion,
        ...(retry ? { allowedAttempts: assignment.allowedAttempts + 1, activeAttemptId: undefined } : {}),
        updatedAt: timestamp,
      });
      await store.create(actor.roomId, 'onboarding_audit_events', {
        actorId: actor.userId,
        action: 'evaluation.published',
        targetType: 'attempt',
        targetId: attempt.id,
        operationId: input.operationId,
        metadata: { conclusion: input.conclusion, assignmentId: assignment.id },
        occurredAt: timestamp,
      });

      let warning: string | undefined;
      try {
        const notification = await (options.notifications ?? createNotificationPort(actor.roomId)).notify(
          assignment.memberId,
          retry ? 'Onboarding cần làm lại' : 'Đã có kết quả onboarding',
          retry ? 'Admin đã mở một lượt làm bài mới cho bạn.' : `Kết luận: ${input.conclusion}.`,
        );
        if (!notification.delivered) warning = notification.warning ?? 'Không thể gửi thông báo kết quả.';
      } catch (error) {
        warning = error instanceof Error ? error.message : String(error);
      }
      return { evaluation: evaluation(row, actor.roomId), ...(warning ? { warning } : {}) };
    },

    async getPublishedFeedback(actor, assignmentId) {
      await assignments.getMine(actor, assignmentId);
      const attempts = await store.query<AttemptDbRecord>(actor.roomId, 'onboarding_attempts', {
        filter: { assignmentId, memberId: actor.userId }, orderBy: [{ field: 'ordinal', direction: 'desc' }], limit: 1000,
      });
      for (const attempt of attempts.records) {
        const evaluations = await store.query<EvaluationDbRecord>(actor.roomId, 'onboarding_evaluations', {
          filter: { attemptId: attempt.id }, limit: 1,
        });
        const published = evaluations.records[0];
        if (!published) continue;
        return {
          attemptId: attempt.id,
          essayFeedback: (await feedbackRows(actor.roomId, attempt.id)).map(feedback),
          evaluation: publishedEvaluation(published, actor.roomId),
        };
      }
      return { essayFeedback: [] };
    },
  };
}
