export type EmployeeType = 'normal' | 'advanced';
export type QuestionType = 'single_choice' | 'multiple_choice' | 'essay';
export type TemplateSource = 'system' | 'custom' | 'ai_generated';
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
export type AssessmentMode = 'final_exam' | 'per_module';
export type QuestionLevel = 'recall' | 'procedure' | 'scenario';
export type Department =
  | 'it'
  | 'marketing'
  | 'hr'
  | 'sales'
  | 'finance'
  | 'operations'
  | 'other';

export interface SourceRef {
  readonly kind: 'document' | 'admin_note';
  readonly sourceId: string;
  readonly sectionId: string;
  readonly page?: number;
  readonly quote: string;
  readonly verifiedBy?: string;
  readonly verifiedAt?: string;
}

export interface LessonBlock {
  readonly id: string;
  readonly kind: 'concept' | 'steps' | 'scenario' | 'tip' | 'warning' | 'summary';
  readonly title?: string;
  readonly body: string;
  readonly steps?: readonly {
    readonly order: number;
    readonly text: string;
  }[];
  readonly sourceRefs: readonly SourceRef[];
  readonly pendingVerification: boolean;
}

export interface ModuleContent {
  readonly moduleLocalId?: string;
  readonly lessonProvenance?: 'ai' | 'fallback' | 'manual';
  readonly approvedLessonVersion?: number;
  readonly approvedQuestionVersion?: number;
  readonly questionLessonVersion?: number;
  readonly featureIds?: readonly string[];
  readonly sourceSectionIds?: readonly string[];
  readonly responsibilityIndexes?: readonly number[];
  readonly moduleId: string;
  readonly frameKey: string;
  readonly objectives: readonly string[];
  readonly estimatedMinutes: number;
  readonly blocks: readonly LessonBlock[];
}

export interface QuestionMeta {
  readonly questionId: string;
  readonly level: QuestionLevel;
  readonly sourceRefs: readonly SourceRef[];
  readonly blockIds: readonly string[];
}

export interface TemplateContentSnapshot {
  readonly publication?: {
    readonly pdfs: Readonly<Record<string, TemplateResource>>;
    readonly jsonFileId?: string;
  };
  readonly moduleApproval?: {
    readonly pipelineVersion: 'module_v2';
    readonly outlineRevision: number;
    readonly fingerprint: string;
    readonly materializedFingerprint: string;
    readonly taskCoverage: readonly import('./ai/validate').GeneratedTaskCoverage[];
  };
  readonly assessmentMode: 'per_module';
  readonly learningMode: 'sequential' | 'free';
  readonly maxAttemptsPerModule: number | null;
  readonly modules: readonly ModuleContent[];
  readonly questionMeta: readonly QuestionMeta[];
}

export interface AiTemplateAssessmentSettings {
  readonly passingScore: number;
  readonly maxAttemptsPerModule: number | null;
  readonly learningMode: 'sequential' | 'free';
}

export interface AiPublicationTarget {
  readonly kind: EmployeeType;
  readonly templateId: string;
  readonly version: number;
  readonly jobId?: string;
  readonly materializedFingerprint?: string;
  readonly settings?: AiTemplateAssessmentSettings;
}

export interface AiPublicationBatch {
  readonly batchId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly targets: readonly AiPublicationTarget[];
}

export interface RoleProfile {
  readonly department?: Department;
  readonly departmentLabel?: string;
  readonly jobTitle?: string;
  readonly responsibilities: readonly string[];
  readonly systemRole?: string;
  readonly seniority?: 'junior' | 'mid' | 'senior' | 'manager';
}

export type FlagType =
  | 'missing'
  | 'conflict'
  | 'ambiguous'
  | 'outdated'
  | 'unsupported'
  | 'audience_unclear'
  | 'low_quality_source'
  | 'generation_error';

export interface VerificationFlag {
  readonly id: string;
  readonly type: FlagType;
  readonly severity: 'blocking' | 'warning';
  readonly message: string;
  readonly questionForAdmin: string;
  readonly location: {
    readonly moduleId?: string;
    readonly blockId?: string;
    readonly questionId?: string;
    readonly featureId?: string;
  };
  readonly evidence: readonly SourceRef[];
  readonly status: 'open' | 'resolved' | 'dismissed';
  readonly resolution?: {
    readonly action: 'choose_option' | 'add_note' | 'upload_doc' | 'remove' | 'accept';
    readonly note?: string;
    readonly by: string;
    readonly at: string;
  };
}

export interface SourceSection {
  readonly id: string;
  readonly headingPath: readonly string[];
  readonly page?: number;
  readonly text: string;
}

export interface SourceRecord {
  readonly id: string;
  readonly roomId: string;
  readonly sourceId: string;
  readonly kind: 'document' | 'admin_note';
  readonly fileId?: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly checksum: string;
  readonly systemName: string;
  readonly softwareVersion?: string;
  readonly effectiveDate?: string;
  readonly status: 'ready' | 'failed';
  readonly errorCode?: string;
  readonly sections?: readonly SourceSection[];
  readonly textLength?: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export type AiProvider = 'sandbox' | 'native_chat';

export const AI_PROVIDERS: readonly AiProvider[] = ['sandbox', 'native_chat'];

export type AiAttemptCleanupState = 'pending' | 'confirmed' | 'unknown';

export interface AiCallRecord {
  readonly dispatchClaimedAt?: string;
  readonly dispatchUnknown?: boolean;
  readonly retryKind?: 'transient' | 'schema' | 'project_busy';
  readonly leaseHolderId?: string;
  readonly moduleLocalId?: string;
  readonly moduleTarget?: 'lesson' | 'questions';
  readonly moduleVersion?: number;
  readonly lessonVersion?: number;
  readonly outlineRevision?: number;
  readonly callId: string;
  readonly stage: 'A' | 'B' | 'C' | 'D' | 'P' | 'S';
  /** Outline planner calls only: the whole-outline plan or a per-source supplement. */
  readonly planTarget?: 'plan' | 'supplement';
  /** Supplement (S) calls only: the new source to read; absent for a catalog call (added module). */
  readonly supplementSourceId?: string;
  /** Supplement (S) calls only: the module that lacks material. Never `moduleLocalId`, which marks module calls. */
  readonly supplementModuleLocalId?: string;
  /** Supplement (S) calls only: the 1-based batch number, matching `-b<k>` in the call ID. */
  readonly supplementBatch?: number;
  readonly repairOf?: string;
  readonly operationId: string;
  readonly status: 'pending' | 'dispatched' | 'completed' | 'invalid' | 'failed';
  readonly attemptRef?: string;
  readonly provider?: AiProvider;
  readonly promptChars?: number;
  readonly systemContextChars?: number;
  readonly cleanupState?: AiAttemptCleanupState;
  readonly cleanupMessage?: string;
  readonly cleanupUpdatedAt?: string;
  readonly errors?: readonly string[];
  readonly providerErrorCode?: string;
  readonly providerPhase?: string;
  readonly diagnosticError?: string;
  readonly rawExcerpt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface AiJobRecord {
  readonly nextRetryAt?: string;
  readonly providerWaitStartedAt?: string;
  readonly providerWaitAttempts?: number;
  readonly pipelineVersion?: AiPipelineVersion;
  readonly outline?: TemplateOutline;
  readonly outlineApprovedRevision?: number;
  readonly moduleRuns?: readonly AiModuleDraftRun[];
  /** Computed, never persisted: an outline planner (P) or supplement (S) call is pending or dispatched. */
  readonly planPending: boolean;
  readonly id: string;
  readonly roomId: string;
  readonly jobId: string;
  readonly kind: 'inventory' | 'template';
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly templateKind?: EmployeeType;
  readonly roleProfile?: RoleProfile;
  readonly title?: string;
  readonly sourceIds?: readonly string[];
  readonly inventoryJobId?: string;
  readonly promptVersion: string;
  readonly calls: readonly AiCallRecord[];
  readonly stageOutputs: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
  readonly pumpLeaseUntil?: string;
  readonly pumpedBy?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly operationId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoomAiLease {
  readonly leaseKey: 'generation';
  readonly jobId: string;
  readonly callId: string;
  readonly holderId: string;
  readonly expiresAt: string;
}

export interface TemplateContentRecord {
  readonly id: string;
  readonly roomId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly content: TemplateContentSnapshot;
  readonly flags: readonly VerificationFlag[];
  readonly roleProfile?: RoleProfile;
  readonly sourceIds?: readonly string[];
  readonly jobId: string;
  readonly promptVersion?: string;
  readonly generationNotes?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModuleProgressRecord {
  readonly id: string;
  readonly roomId: string;
  readonly assignmentId: string;
  readonly memberId: string;
  readonly moduleId: string;
  readonly openedAt?: string;
  readonly lessonCompletedAt?: string;
  readonly passedAt?: string;
  readonly attemptCount: number;
  readonly bestScore?: number;
  readonly extraAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModuleAttemptAnswer {
  readonly questionId: string;
  readonly selectedOptionId: string;
  readonly correct: boolean;
}

export interface ModuleAttemptRecord {
  readonly id: string;
  readonly roomId: string;
  readonly assignmentId: string;
  readonly memberId: string;
  readonly moduleId: string;
  readonly ordinal: number;
  readonly status: 'started' | 'submitted';
  readonly questionOrder?: readonly string[];
  readonly optionOrder?: Readonly<Record<string, readonly string[]>>;
  readonly answers?: readonly ModuleAttemptAnswer[];
  readonly correctCount?: number;
  readonly totalCount?: number;
  readonly score?: number;
  readonly passed?: boolean;
  readonly operationId?: string;
  readonly startedAt?: string;
  readonly submittedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ModuleLearningStatus =
  | 'locked'
  | 'available'
  | 'learning'
  | 'quiz_ready'
  | 'quiz_failed'
  | 'passed'
  | 'needs_support';

export interface ModuleStateDto {
  readonly moduleId: string;
  readonly title: string;
  readonly order: number;
  readonly status: ModuleLearningStatus;
  readonly bestScore?: number;
  readonly attemptsUsed: number;
  readonly attemptsAllowed: number | null;
}

export interface ModuleQuizQuestionDto {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
}

export interface ModuleQuizStartDto {
  readonly attemptId: string;
  readonly moduleId: string;
  readonly ordinal: number;
  readonly questions: readonly ModuleQuizQuestionDto[];
}

export interface ModuleQuizAnswerInput {
  readonly questionId: string;
  readonly selectedOptionId: string;
}

export interface ModuleQuizResultItemDto {
  readonly questionId: string;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  readonly selectedOptionId: string;
  readonly correctOptionId: string;
  readonly correct: boolean;
  readonly explanation: string;
  readonly sourceRefs: readonly SourceRef[];
  readonly blockIds: readonly string[];
}

export interface ModuleQuizResultDto {
  readonly attemptId: string;
  readonly moduleId: string;
  readonly ordinal: number;
  readonly score: number;
  readonly passed: boolean;
  readonly passingScore: number;
  readonly correctCount: number;
  readonly totalCount: number;
  readonly attemptsUsed: number;
  readonly attemptsAllowed: number | null;
  readonly items: readonly ModuleQuizResultItemDto[];
}

export interface ModuleQuestionStatDto {
  readonly questionId: string;
  readonly correctCount: number;
  readonly attemptCount: number;
  readonly correctPercent: number;
}

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
  readonly assessmentMode?: AssessmentMode;
  readonly modules: readonly TemplateModule[];
  readonly content?: TemplateContentSnapshot;
}

export interface LearnerTemplateModuleDto extends Omit<TemplateModule, 'questions'> {
  readonly questions: readonly LearnerQuestionDto[];
}

export interface LearnerTemplateDto extends Omit<TemplateSnapshot, 'modules' | 'content'> {
  readonly modules: readonly LearnerTemplateModuleDto[];
  readonly content?: Omit<TemplateContentSnapshot, 'questionMeta'>;
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

export interface EmployeeRecord {
  readonly id: string;
  readonly roomId: string;
  readonly memberId: string;
  readonly employeeType: EmployeeType;
  readonly addedBy: string;
  readonly addedAt: string;
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
  readonly assignedAt: string;
  readonly dueAt?: string;
  readonly activeAttemptId?: string;
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

export interface TemplateOutlineModule {
  readonly moduleLocalId: string;
  readonly frameKey: string;
  readonly order: number;
  readonly title: string;
  readonly description: string;
  readonly estimatedMinutes: number;
  readonly objectives: readonly string[];
  readonly featureIds: readonly string[];
  readonly sourceSectionIds: readonly string[];
  readonly responsibilityIndexes: readonly number[];
  readonly tombstoned?: boolean;
  /** Missing on outlines persisted before coverage existed; treated as not insufficient. */
  readonly coverage?: 'sufficient' | 'insufficient';
  readonly gapNote?: string;
  readonly coverageOverride?: boolean;
}

export interface TemplateOutline {
  readonly revision: number;
  readonly modules: readonly TemplateOutlineModule[];
  readonly taskCoverage: readonly import('./ai/validate').GeneratedTaskCoverage[];
  readonly flags: readonly import('./ai/validate').GeneratedFlag[];
}

export type OutlineEdit =
  | { readonly type: 'update'; readonly moduleLocalId: string; readonly patch: Partial<Pick<TemplateOutlineModule, 'title' | 'description' | 'estimatedMinutes' | 'objectives' | 'featureIds' | 'sourceSectionIds' | 'responsibilityIndexes' | 'coverageOverride' | 'gapNote' | 'coverage'>> }
  | { readonly type: 'reorder'; readonly moduleLocalId: string; readonly order: number }
  | { readonly type: 'delete'; readonly moduleLocalId: string }
  | { readonly type: 'add'; readonly module: Omit<TemplateOutlineModule, 'moduleLocalId' | 'tombstoned'> };

export type AiPipelineVersion = 'legacy' | 'module_v2';
export type LessonState = 'queued' | 'drafting' | 'validating' | 'review_ready' | 'fallback_review' | 'approved' | 'stale' | 'failed' | 'manual_required';
export type QuestionState = 'blocked' | 'queued' | 'drafting' | 'review_ready' | 'approved' | 'stale' | 'failed';
export interface AiModuleDraftRun {
  readonly outline: TemplateOutlineModule;
  readonly outlineRevision: number;
  readonly sourceFingerprint?: string;
  readonly lessonState: LessonState;
  readonly lessonVersion: number;
  readonly approvedLessonVersion?: number;
  readonly lessonDraft?: import('./ai/validate').GeneratedModule;
  readonly lessonProvenance?: 'ai' | 'fallback' | 'manual';
  readonly lessonFlags?: readonly import('./ai/validate').GeneratedFlag[];
  readonly questionState: QuestionState;
  readonly questionVersion: number;
  readonly approvedQuestionVersion?: number;
  readonly questionLessonVersion?: number;
  readonly questionDraft?: readonly import('./ai/validate').GeneratedQuestion[];
  readonly questionProvenance?: 'ai' | 'fallback' | 'manual';
  readonly questionFlags?: readonly import('./ai/validate').GeneratedFlag[];
  readonly nextRetryAt?: string;
  readonly providerWaitStartedAt?: string;
  readonly lessonAttempts?: number;
  readonly questionAttempts?: number;
  readonly schemaRepairs?: number;
  readonly transientRetries?: number;
}
