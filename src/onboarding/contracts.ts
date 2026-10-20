export type EmployeeType = 'normal' | 'advanced';
export type QuestionType = 'single_choice' | 'multiple_choice' | 'essay';
export type TemplateSource = 'system' | 'custom';
export type TemplateStatus = 'draft' | 'published' | 'archived';
export type AssignmentStatus =
  | 'assigned'
  | 'in_progress'
  | 'submitted'
  | 'awaiting_essay_feedback'
  | 'awaiting_evaluation'
  | 'passed'
  | 'failed'
  | 'retry';
export type AttemptStatus = 'draft' | 'submitted' | 'auto_scored' | 'reviewed';
export type FinalConclusion = 'passed' | 'failed' | 'retry';
export type ResourceKind = 'markdown' | 'file' | 'link' | 'video';

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
}

export interface OnboardingQuestion {
  readonly id: string;
  readonly type: QuestionType;
  readonly prompt: string;
  readonly required?: boolean;
  readonly options?: readonly QuestionOption[];
  /** Backend/Admin-only answer key. Never serialize this field to a Learner DTO. */
  readonly correctOptionIds?: readonly string[];
  readonly explanation?: string;
}

export interface LearnerQuestionDto {
  readonly id: string;
  readonly type: QuestionType;
  readonly prompt: string;
  readonly required: boolean;
  readonly options?: readonly QuestionOption[];
}

export type AdminQuestionDto = OnboardingQuestion;

export interface TemplateResource {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: ResourceKind;
  readonly required: boolean;
  readonly sourceUrl?: string;
  readonly fileId?: string;
}

export interface TemplateModule {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly order: number;
  readonly resources: readonly TemplateResource[];
  readonly questions: readonly OnboardingQuestion[];
}

export interface TemplateSnapshot {
  readonly id: string;
  readonly version: number;
  readonly source: TemplateSource;
  readonly status: TemplateStatus;
  readonly employeeType: EmployeeType;
  readonly title: string;
  readonly description: string;
  readonly passingScore?: number;
  readonly modules: readonly TemplateModule[];
}

export interface LearnerTemplateModuleDto extends Omit<TemplateModule, 'questions'> {
  readonly questions: readonly LearnerQuestionDto[];
}

export interface LearnerTemplateDto extends Omit<TemplateSnapshot, 'modules'> {
  readonly modules: readonly LearnerTemplateModuleDto[];
}

export type AdminTemplateDto = TemplateSnapshot;

export interface AssignmentRecord {
  readonly id: string;
  readonly roomId: string;
  readonly memberId: string;
  readonly employeeType: EmployeeType;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateSource: TemplateSource;
  readonly status: AssignmentStatus;
  readonly assignedBy: string;
  readonly assignedAt: string;
  readonly dueAt?: string;
  readonly activeAttemptId?: string;
  readonly attemptLimit?: number;
  readonly allowedAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AttemptRecord {
  readonly id: string;
  readonly roomId: string;
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

export interface AnswerRecord {
  readonly id: string;
  readonly roomId?: string;
  readonly attemptId?: string;
  readonly questionId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly essayText?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface EssayFeedbackRecord {
  readonly id: string;
  readonly roomId?: string;
  readonly attemptId?: string;
  readonly answerId: string;
  readonly comment: string;
  readonly reviewed: boolean;
  readonly reviewerId: string;
  readonly reviewedAt: string;
}

export interface EvaluationRecord {
  readonly id: string;
  readonly roomId: string;
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly completionLevel: string;
  readonly strengths: string;
  readonly improvements: string;
  readonly publicComment: string;
  readonly conclusion: FinalConclusion;
  readonly evaluatorId: string;
  readonly evaluatedAt: string;
  readonly operationId: string;
}

export interface ResourceProgressRecord {
  readonly resourceId: string;
  readonly openedAt?: string;
  readonly completedAt?: string;
}

export interface MultipleChoiceQuestionResult {
  readonly questionId: string;
  readonly correct: boolean;
}

export interface MultipleChoiceScore {
  readonly correctCount: number;
  readonly totalCount: number;
  readonly percentage: number;
  readonly results: readonly MultipleChoiceQuestionResult[];
}

export interface AdminAssignmentDto extends AssignmentRecord {
  readonly templateTitle?: string;
  readonly memberName?: string;
  readonly progressPercent?: number;
}

export interface LearnerAssignmentDto {
  readonly id: string;
  readonly employeeType: EmployeeType;
  readonly status: AssignmentStatus;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateTitle: string;
  readonly dueAt?: string;
  readonly progressPercent: number;
}

export interface LearnerAttemptResultDto {
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly status: AttemptStatus;
  readonly mcScore: MultipleChoiceScore | null;
  readonly answers: readonly AnswerRecord[];
  readonly essayFeedback: readonly EssayFeedbackRecord[];
  readonly evaluation?: Omit<EvaluationRecord, 'roomId' | 'operationId'>;
}
