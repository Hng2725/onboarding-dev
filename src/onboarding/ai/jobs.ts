import { validateAdminOutline } from './outline-validation';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import type { OnboardingActor } from '../auth';
import type {
  AiCallRecord,
  AiModuleDraftRun,
  AiPipelineVersion,
  OutlineEdit,
  TemplateOutline,
  TemplateOutlineModule,
  AiJobRecord,
  AiProvider,
  EmployeeType,
  RoleProfile,
  SourceRecord,
  SourceSection,
} from '../contracts';
import type { OnboardingStore, StoreRecord } from '../store';
import { createTemplateService } from '../templates';
import { groundSourceRef, type RawSourceRef } from './grounding';
import {
  mergeInventoryChunks,
  validateInventoryChunk,
  validateRoleProfile,
  type InventoryChunk,
  type FeatureInventory,
} from './inventory';
import { AI_GENERATION_LIMITS } from './limits';
import { sanitizeAiDiagnosticText } from './diagnostics';
import { materializeAiTemplate, materializeModuleTemplate } from './materialize';
import { buildTemplateOutline, applyTemplateOutlineEdits, GAP_NOTE } from './outline';
import { moduleHasUsableSources, outlineReadiness, usableSectionIds } from './outline-coverage';
import { buildOutlinePlanPrompt, buildOutlinePlanRepairPrompt, validateOutlinePlanOutput, type OutlinePlanValidationInput } from './outline-plan';
import { buildSupplementPrompt, buildSupplementRepairPrompt, SUPPLEMENT_EXCERPT_CHARS, validateSupplementOutput, type SupplementCoverageUpdate, type SupplementOutput, type SupplementPromptInput } from './outline-supplement';
import { batchSources, planBatches as planSourceBatches, SourceBatchError } from './source-batches';
import { buildFallbackLesson } from './fallback-lessons';
import { buildFallbackQuestions } from './fallback-questions';
import { buildModuleLessonPrompt, buildModuleLessonRepairPrompt, buildModuleQuestionRepairPrompt, buildModuleQuestionPrompt, validateModuleLessonOutput, validateModuleQuestionOutput, validApprovedLesson, type ModuleLessonPromptInput } from './module-draft';
import { createModuleRuns, reconcileModuleRuns, invalidateModule, updateLesson, approveLesson, updateQuestions, approveQuestions, retryModuleRun, lessonApproved, modulesComplete, moduleRunComplete, ModuleLifecycleError } from './module-lifecycle';
import { parseAiJsonObject } from './parse';
import { acquireRoomAiLease, refreshRoomAiLease, releaseRoomAiLease, isAiLeaseConflict, aiCallMayBeLive } from './room-ai-lease';
import {
  PROMPT_VERSION,
  buildInventoryPrompt,
  buildModuleRepairPrompt,
  buildRepairPrompt,
  buildTemplateLessonsPrompt,
  buildTemplateQuestionsPrompt,
  buildTemplateRepairBase,
  buildVerificationPrompt,
  PromptError,
  type AiPromptRequest,
} from './prompts';
import {
  ADVANCED_FRAMES,
  NORMAL_FRAMES,
  removeQuestionsBlockedByFlags,
  validateGeneratedTemplate,
  type GeneratedTemplate,
  type GeneratedFlag,
  type GeneratedModule,
  type GeneratedQuestion,
  type GeneratedTemplateValidation,
  type ValidationError,
} from './validate';

export interface VerificationClaim {
  readonly id: string;
  readonly kind: 'block' | 'question';
  readonly moduleLocalId: string;
  readonly blockLocalId?: string;
  readonly questionLocalId?: string;
  readonly text: string;
  readonly quotes: readonly RawSourceRef[];
}

export interface VerificationVerdict {
  readonly id: string;
  readonly verdict: 'supported' | 'partial' | 'unsupported';
  readonly reason: string;
}

function verificationSentences(body: string): readonly string[] {
  return (body.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function buildVerificationClaims(
  template: GeneratedTemplate,
): readonly VerificationClaim[] {
  return template.modules.flatMap((module) => {
    const blockClaims = module.blocks.flatMap((block): readonly VerificationClaim[] => {
      if (block.kind === 'summary') return [];
      if (block.kind === 'steps') {
        return (block.steps ?? []).map((step, index) => ({
          id: 'block:' + block.localId + ':step:' + step.order + ':' + (index + 1),
          kind: 'block',
          moduleLocalId: module.localId,
          blockLocalId: block.localId,
          text: step.text.trim(),
          quotes: block.sourceRefs,
        }));
      }
      return verificationSentences(block.body).map((sentence, index) => ({
        id: 'block:' + block.localId + ':sentence:' + (index + 1),
        kind: 'block',
        moduleLocalId: module.localId,
        blockLocalId: block.localId,
        text: sentence,
        quotes: block.sourceRefs,
      }));
    });
    const questionClaims = module.questions.map((question): VerificationClaim => ({
      id: 'question:' + question.localId,
      kind: 'question',
      moduleLocalId: module.localId,
      questionLocalId: question.localId,
      text: [
        question.prompt,
        question.options.find((option) => option.id === question.correctOptionId)?.label ?? '',
        question.explanation,
      ].filter(Boolean).join('\n'),
      quotes: question.sourceRefs,
    }));
    return [...blockClaims, ...questionClaims];
  });
}

function claimBatches(claims: readonly VerificationClaim[]): readonly (readonly VerificationClaim[])[] {
  const batches: VerificationClaim[][] = [];
  for (let index = 0; index < claims.length; index += AI_GENERATION_LIMITS.maxClaimsPerVerificationCall) {
    batches.push(claims.slice(index, index + AI_GENERATION_LIMITS.maxClaimsPerVerificationCall));
  }
  return batches;
}

function verificationBatchIndex(
  outputs: Readonly<Record<string, unknown>>,
  callId: string,
): number {
  const mapping = outputs.__verificationCallBatchIndexes;
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    const candidate = (mapping as Record<string, unknown>)[callId];
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  const parsed = Number(callId.slice(1)) - 1;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseVerificationVerdicts(
  value: unknown,
  claims: readonly VerificationClaim[],
): readonly VerificationVerdict[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Verification output must be an object.');
  }
  const raw = (value as Record<string, unknown>).verdicts;
  if (!Array.isArray(raw)) throw new Error('Verification verdicts must be an array.');
  const expectedIds = new Set(claims.map((claim) => claim.id));
  const seen = new Map<string, VerificationVerdict>();
  raw.forEach((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Every verification verdict must be an object.');
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || !expectedIds.has(row.id) || seen.has(row.id)) {
      throw new Error('Verification verdict IDs must match the requested claims exactly.');
    }
    if (!['supported', 'partial', 'unsupported'].includes(String(row.verdict))) {
      throw new Error('Verification verdict is invalid.');
    }
    if (typeof row.reason !== 'string' || !row.reason.trim()) {
      throw new Error('Verification verdict reason is required.');
    }
    seen.set(row.id, {
      id: row.id,
      verdict: row.verdict as VerificationVerdict['verdict'],
      reason: row.reason.trim(),
    });
  });
  return claims.map((claim) => seen.get(claim.id) ?? {
    id: claim.id,
    verdict: 'partial',
    reason: 'AI did not return a verdict for this claim.',
  });
}

function applyVerificationVerdicts(
  template: GeneratedTemplate,
  claims: readonly VerificationClaim[],
  verdicts: readonly VerificationVerdict[],
): { readonly template: GeneratedTemplate; readonly generationNotes: readonly string[] } {
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const unsupportedBlocks = new Set<string>();
  const unsupportedQuestions = new Set<string>();
  const generationNotes = [...template.generationNotes];
  const verificationFlags = [];
  for (const claim of claims) {
    const verdict = byId.get(claim.id);
    if (!verdict) continue;
    if (verdict.verdict === 'unsupported') {
      if (claim.blockLocalId) unsupportedBlocks.add(claim.blockLocalId);
      if (claim.questionLocalId) unsupportedQuestions.add(claim.questionLocalId);
      generationNotes.push('Removed unsupported claim ' + claim.id + ': ' + verdict.reason);
    } else if (verdict.verdict === 'partial') {
      verificationFlags.push({
        type: 'ambiguous' as const,
        severity: 'warning' as const,
        message: verdict.reason,
        questionForAdmin: 'Nội dung này chỉ được tài liệu hỗ trợ một phần. Admin vui lòng xác minh.',
        location: {
          moduleLocalId: claim.moduleLocalId,
          ...(claim.blockLocalId ? { blockLocalId: claim.blockLocalId } : {}),
          ...(claim.questionLocalId ? { questionLocalId: claim.questionLocalId } : {}),
        },
        evidence: claim.quotes,
      });
    }
  }
  let modules = template.modules.map((module) => {
    const blocks = module.blocks.filter((block) => !unsupportedBlocks.has(block.localId));
    const questions = module.questions.filter((question) =>
      !unsupportedQuestions.has(question.localId)
      && !question.blockIds.some((blockId) => unsupportedBlocks.has(blockId)));
    return { ...module, blocks, questions };
  });
  const generationFlags = modules
    .filter((module) => module.questions.length < AI_GENERATION_LIMITS.questionRange.min)
    .map((module) => ({
      type: 'generation_error' as const,
      severity: 'blocking' as const,
      message: 'Module còn dưới ' + AI_GENERATION_LIMITS.questionRange.min + ' câu hỏi sau kiểm chứng.',
      questionForAdmin: 'Bổ sung hoặc sửa câu hỏi có căn cứ trước khi xuất bản.',
      location: { moduleLocalId: module.localId },
      evidence: [] as readonly RawSourceRef[],
    }));
  modules = modules.map((module) => ({ ...module }));
  return {
    template: {
      ...template,
      modules,
      generationNotes,
      flags: [...template.flags, ...verificationFlags, ...generationFlags],
    },
    generationNotes,
  };
}

export type AiJobServiceErrorCode =
  | 'ADMIN_REQUIRED'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_RUNNING'
  | 'JOB_CALL_MISMATCH'
  | 'JOB_LEASE_LOST'
  | 'JOB_OWNER_REQUIRED'
  | 'INVENTORY_REQUIRED'
  | 'INVENTORY_TOO_LARGE'
  | 'ROLE_PROFILE_INVALID'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_TOO_LARGE'
  | 'AI_OUTPUT_INVALID'
  | 'AI_FAILED'
  | 'AI_TIMEOUT'
  | 'AI_DISPATCH_UNKNOWN'
  | 'COVERAGE_INCOMPLETE'
  | 'OPERATION_CONFLICT';

export class AiJobServiceError extends Error {
  readonly code: AiJobServiceErrorCode;

  constructor(code: AiJobServiceErrorCode, message: string) {
    super(message);
    this.name = 'AiJobServiceError';
    this.code = code;
  }
}

export interface StartInventoryJobInput {
  readonly kind: 'inventory';
  readonly sourceIds: readonly string[];
  readonly operationId: string;
}

export interface StartTemplateJobInput {
  readonly kind: 'template';
  readonly inventoryJobId: string;
  readonly templateKind: EmployeeType;
  readonly roleProfile?: RoleProfile;
  readonly title?: string;
  readonly operationId: string;
}

export type StartAiJobInput = StartInventoryJobInput | StartTemplateJobInput;

export interface JobWorkerInput {
  readonly jobId: string;
  readonly workerId: string;
}

export interface RecordDispatchInput extends JobWorkerInput {
  readonly callId: string;
  readonly attemptRef: string;
  readonly provider: AiProvider;
}

export interface SubmitAiOutputInput extends JobWorkerInput {
  readonly callId: string;
  readonly text: string;
}

export interface ReportAiFailureInput extends JobWorkerInput {
  readonly callId: string;
  readonly kind: 'dispatch_unknown' | 'failed' | 'timeout';
  readonly provider?: AiProvider;
  readonly message?: string;
  readonly providerErrorCode?: string;
  readonly providerPhase?: string;
  readonly diagnosticError?: string;
}

export interface RecordAttemptCleanupInput {
  readonly jobId: string;
  readonly callId: string;
  readonly attemptRef: string;
  readonly state: 'confirmed' | 'unknown';
  readonly message?: string;
}

const MAX_CLEANUP_MESSAGE_CHARS = 500;

// Store updates travel as JSON, where undefined fields are dropped instead of cleared.
// These values are what the readers below already treat as "no lease" and "no error".
const RELEASED_LEASE = { pumpLeaseUntil: new Date(0).toISOString(), pumpedBy: '' } as const;
const CLEARED_ERROR = { errorCode: '', errorMessage: '' } as const;
const CLEARED_WAIT = { nextRetryAt: new Date(0).toISOString(), providerWaitStartedAt: new Date(0).toISOString(), providerWaitAttempts: 0 } as const;
const MAX_PROVIDER_WAIT_MS = 120_000;
const PROVIDER_RETRY_MS = 3_000;
const TRANSIENT_PROVIDER_ERROR = /(?:TRANSIENT|UNAVAILABLE|OVERLOADED|RATE_LIMIT|SERVER_ERROR)/;
const PLAN_PENDING_MESSAGE = 'AI đang lập lộ trình, vui lòng chờ.';
const SUPPLEMENT_FAILED_NOTE = 'AI chưa đọc được tài liệu bổ sung. Hãy thử lại hoặc chọn đoạn thủ công.';
const CATALOG_FAILED_NOTE = 'AI chưa tìm được đoạn phù hợp. Hãy tải tài liệu bổ sung hoặc chọn đoạn thủ công.';
const SUPPLEMENT_CALL = /^supplement-(\d+)-b(\d+)/;
const AUTOPILOT_APPROVER = 'autopilot';
const PAUSED_ERROR = 'Tạm dừng bởi Admin.';
const FALLBACK_LESSON_WARNING = 'Bài học được dựng trực tiếp từ tài liệu nguồn, nên rà soát cách diễn đạt.';

/** Added once to a fallback lesson that autopilot approves, so the Admin rereads its wording. */
function fallbackLessonFlag(moduleLocalId: string): GeneratedFlag {
  return { type: 'low_quality_source', severity: 'warning', message: FALLBACK_LESSON_WARNING, questionForAdmin: 'Kiểm tra và chỉnh câu chữ nếu cần.', location: { moduleLocalId }, evidence: [] };
}

/**
 * Outline planner (P) and supplement (S) calls carry no module, so they must never reach a
 * module-run lookup. They share dispatch, retry and settle-before-the-admin-gate handling.
 */
function isPlanCall(call: AiCallRecord): boolean {
  return call.stage === 'P' || call.stage === 'S';
}

/** A planner (P) or supplement (S) call is still pending or dispatched. */
function planPending(calls: readonly AiCallRecord[]): boolean {
  return calls.some((call) => isPlanCall(call) && (call.status === 'pending' || call.status === 'dispatched'));
}

/** The supplement request number `n` of an S call `supplement-<n>-b<k>[-rN|-retryN]`. */
function supplementRequest(call: AiCallRecord): number | undefined {
  const match = call.stage === 'S' ? SUPPLEMENT_CALL.exec(call.callId) : null;
  return match ? Number(match[1]) : undefined;
}

/** Persisted per request under `supplement:<n>`. New-file requests carry the source and its batches. */
interface SupplementRequest {
  readonly moduleLocalId: string;
  readonly sourceId?: string;
  readonly batches?: readonly (readonly string[])[];
}

export type AiJobNextStep =
  | {
    readonly kind: 'ai_call';
    readonly callId: string;
    readonly operationId: string;
    readonly prompt: string;
    readonly systemContext?: string;
    readonly attemptRef?: string;
    readonly provider?: AiProvider;
    readonly startedAt?: string;
    readonly moduleTarget?: 'lesson' | 'questions';
  }
  | { readonly kind: 'wait'; readonly job: AiJobRecord }
  | { readonly kind: 'awaiting_admin'; readonly job: AiJobRecord }
  | { readonly kind: 'done'; readonly job: AiJobRecord }
  | { readonly kind: 'failed'; readonly job: AiJobRecord };

export interface AiJobService {
  updateOutline(actor: OnboardingActor, input: OutlineVersionInput & { readonly edits: readonly OutlineEdit[] }): Promise<AiJobRecord>;
  approveOutline(actor: OnboardingActor, input: OutlineVersionInput): Promise<AiJobRecord>;
  /** Ready room sources with each section's headings and whether it can ground a module (`usableSectionIds`). */
  listModuleSources(actor: OnboardingActor, jobId: string): Promise<readonly { sourceId: string; fileName: string; sections: readonly { id: string; headingPath: readonly string[]; usable: boolean }[] }[]>;
  supplementModuleSources(actor: OnboardingActor, input: OutlineVersionInput & ModuleInput & { readonly sourceIds: readonly string[]; readonly sectionIds: readonly string[] }): Promise<AiJobRecord>;
  /** Adds one new ready room source and lets AI read only that file (S calls) to fill the module. */
  supplementModuleDocument(actor: OnboardingActor, input: OutlineVersionInput & ModuleInput & { readonly sourceId: string }): Promise<AiJobRecord>;
  /** Appends a module on the next unused frame and lets AI pick sections from the job's catalog. */
  addOutlineModule(actor: OnboardingActor, input: OutlineVersionInput & { readonly title: string; readonly description: string }): Promise<AiJobRecord>;
  setCoverageOverride(actor: OnboardingActor, input: OutlineVersionInput & ModuleInput & { readonly override: boolean }): Promise<AiJobRecord>;
  updateModuleLesson(actor: OnboardingActor, input: ModuleVersionInput & { readonly module: GeneratedModule }): Promise<AiJobRecord>;
  approveModuleLesson(actor: OnboardingActor, input: ModuleVersionInput): Promise<AiJobRecord>;
  useSourceFallback(actor: OnboardingActor, input: ModuleVersionInput): Promise<AiJobRecord>;
  useQuestionFallback(actor: OnboardingActor, input: ModuleVersionInput): Promise<AiJobRecord>;
  updateModuleQuestions(actor: OnboardingActor, input: ModuleVersionInput & { readonly questions: readonly GeneratedQuestion[] }): Promise<AiJobRecord>;
  approveModuleQuestions(actor: OnboardingActor, input: ModuleVersionInput): Promise<AiJobRecord>;
  retryModule(actor: OnboardingActor, input: ModuleInput & { readonly target: 'lesson' | 'questions'; readonly expectedVersion: number }): Promise<AiJobRecord>;
  /** Stops autopilot: the outline returns to review, live module calls are stopped, approved runs are kept. */
  pauseAutopilot(actor: OnboardingActor, input: { readonly jobId: string }): Promise<AiJobRecord>;
  /** Switches an owned module_v2 template job, including one started before autopilot, to autopilot. */
  enableAutopilot(actor: OnboardingActor, input: { readonly jobId: string }): Promise<AiJobRecord>;
  startJob(actor: OnboardingActor, input: StartAiJobInput): Promise<AiJobRecord>;
  listJobs(actor: OnboardingActor): Promise<readonly AiJobRecord[]>;
  getJob(actor: OnboardingActor, jobId: string): Promise<AiJobRecord>;
  nextStep(actor: OnboardingActor, input: JobWorkerInput): Promise<AiJobNextStep>;
  recordDispatch(actor: OnboardingActor, input: RecordDispatchInput): Promise<AiJobRecord>;
  submitAiOutput(actor: OnboardingActor, input: SubmitAiOutputInput): Promise<AiJobRecord>;
  reportAiFailure(actor: OnboardingActor, input: ReportAiFailureInput): Promise<AiJobRecord>;
  retryJob(actor: OnboardingActor, jobId: string): Promise<AiJobRecord>;
  cancelJob(actor: OnboardingActor, jobId: string): Promise<AiJobRecord>;
  recordAttemptCleanup(
    actor: OnboardingActor,
    input: RecordAttemptCleanupInput,
  ): Promise<AiJobRecord>;
}

export interface OutlineVersionInput { readonly jobId: string; readonly expectedRevision: number; }
export interface ModuleInput { readonly jobId: string; readonly moduleLocalId: string; }
export interface ModuleVersionInput extends ModuleInput { readonly expectedVersion: number; }

interface AiJobDbData extends StoreRecord {
  readonly nextRetryAt?: string;
  readonly providerWaitStartedAt?: string;
  readonly providerWaitAttempts?: number;
  readonly pipelineVersion?: AiPipelineVersion;
  readonly outline?: TemplateOutline;
  readonly outlineApprovedRevision?: number;
  readonly moduleRuns?: readonly AiModuleDraftRun[];
  readonly autoApprove?: boolean;
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

interface AiJobDbRecord extends AiJobDbData {
  readonly id: string;
}

interface SourceDbRecord extends StoreRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: 'document' | 'admin_note';
  readonly fileId?: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly checksum: string;
  readonly systemName: string;
  readonly status: 'ready' | 'failed';
  readonly sections?: readonly SourceSection[];
  readonly textLength?: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export interface AiJobServiceOptions {
  readonly now?: () => string;
}

function requireAdmin(actor: OnboardingActor): void {
  if (actor.access !== 'admin') {
    throw new AiJobServiceError('ADMIN_REQUIRED', 'Admin access is required.');
  }
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AiJobServiceError('OPERATION_CONFLICT', label + ' is required.');
  return trimmed;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function jobIdFor(roomId: string, operationId: string): string {
  return 'job-' + createHash('sha256')
    .update(roomId)
    .update('\u0000')
    .update(operationId)
    .digest('hex')
    .slice(0, 24);
}

function sourceFrom(row: SourceDbRecord, roomId: string): SourceRecord {
  return {
    id: row.id,
    roomId,
    sourceId: row.sourceId,
    kind: row.kind,
    ...(row.fileId ? { fileId: row.fileId } : {}),
    fileName: row.fileName,
    ...(row.mimeType ? { mimeType: row.mimeType } : {}),
    checksum: row.checksum,
    systemName: row.systemName,
    status: row.status,
    ...(row.sections ? { sections: row.sections } : {}),
    ...(row.textLength === undefined ? {} : { textLength: row.textLength }),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
  };
}

function jobFrom(row: AiJobDbRecord, roomId: string): AiJobRecord {
  return {
    ...(row.nextRetryAt && Date.parse(row.nextRetryAt) > 0 ? { nextRetryAt: row.nextRetryAt } : {}),
    ...(row.providerWaitStartedAt && Date.parse(row.providerWaitStartedAt) > 0 ? { providerWaitStartedAt: row.providerWaitStartedAt } : {}),
    ...(row.providerWaitAttempts ? { providerWaitAttempts: row.providerWaitAttempts } : {}),
    ...(row.pipelineVersion ? { pipelineVersion: row.pipelineVersion } : {}),
    ...(row.outline ? { outline: row.outline } : {}),
    ...(row.outlineApprovedRevision === undefined ? {} : { outlineApprovedRevision: row.outlineApprovedRevision }),
    ...(row.moduleRuns ? { moduleRuns: row.moduleRuns } : {}),
    ...(row.autoApprove === undefined ? {} : { autoApprove: row.autoApprove }),
    planPending: row.status === 'running' && planPending(row.calls),
    id: row.id,
    roomId,
    jobId: row.jobId,
    kind: row.kind,
    status: row.status,
    ...(row.templateKind ? { templateKind: row.templateKind } : {}),
    ...(row.roleProfile ? { roleProfile: row.roleProfile } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.sourceIds ? { sourceIds: row.sourceIds } : {}),
    ...(row.inventoryJobId ? { inventoryJobId: row.inventoryJobId } : {}),
    promptVersion: row.promptVersion,
    calls: row.calls,
    stageOutputs: row.stageOutputs,
    ...(row.result === undefined ? {} : { result: row.result }),
    ...(row.pumpLeaseUntil && row.pumpedBy ? { pumpLeaseUntil: row.pumpLeaseUntil } : {}),
    ...(row.pumpedBy ? { pumpedBy: row.pumpedBy } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    operationId: row.operationId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isDuplicateError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return record.code === 11000 || [record.message, record.error, String(error)]
    .some((value) => typeof value === 'string' && /E11000|duplicate key|unique index/i.test(value));
}

/** Persisted provider, or the attempt-reference prefix for calls recorded before providers were stored. */
export function callProvider(
  call: Pick<AiCallRecord, 'provider' | 'attemptRef'>,
): AiProvider | undefined {
  if (call.provider) return call.provider;
  if (!call.attemptRef) return undefined;
  return call.attemptRef.startsWith('native-chat:') ? 'native_chat' : 'sandbox';
}

function rawOutput(outputs: Readonly<Record<string, unknown>>, callId: string): string | undefined {
  const value = outputs['raw:' + callId];
  return typeof value === 'string' ? value : undefined;
}

function validationMessages(error: unknown): readonly string[] {
  if (error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)) {
    return error.errors.slice(0, 30).map((item) => {
      if (!item || typeof item !== 'object') return String(item);
      const row = item as Record<string, unknown>;
      return [row.path, row.code, row.message].filter((part) => typeof part === 'string').join(': ');
    });
  }
  return [error instanceof Error ? error.message : String(error)];
}

function groundedRefs(
  refs: readonly RawSourceRef[],
  sources: readonly SourceRecord[],
): readonly RawSourceRef[] {
  return refs.filter((ref) => groundSourceRef(ref, sources).ok);
}

function groundInventory(
  chunk: InventoryChunk,
  sources: readonly SourceRecord[],
): InventoryChunk {
  return {
    systemSummary: {
      ...chunk.systemSummary,
      sourceRefs: groundedRefs(chunk.systemSummary.sourceRefs, sources),
    },
    glossary: chunk.glossary
      .map((item) => ({ ...item, sourceRefs: groundedRefs(item.sourceRefs, sources) }))
      .filter((item) => item.sourceRefs.length > 0),
    features: chunk.features
      .map((feature) => ({
        ...feature,
        steps: feature.steps
          .map((step) => ({ ...step, sourceRefs: groundedRefs(step.sourceRefs, sources) }))
          .filter((step) => step.sourceRefs.length > 0),
        sourceRefs: groundedRefs(feature.sourceRefs, sources),
      }))
      .filter((feature) => feature.sourceRefs.length > 0),
    flags: chunk.flags.map((item) => ({
      ...item,
      evidence: groundedRefs(item.evidence, sources),
    })),
  };
}

/**
 * Jobs created with this marker validate lessons on their own and repair only the modules
 * that failed. Jobs created earlier keep the whole-template repair path.
 */
const MODULE_REPAIR_MODE = 'module';

interface RepairScope {
  /** Modules to repair, or null when an error is not confined to modules. */
  readonly moduleLocalIds: readonly string[] | null;
  readonly errors: readonly string[];
}

function moduleRecords(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const modules = (value as Record<string, unknown>).modules;
  return Array.isArray(modules)
    ? modules.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function repairScopeFor(errors: readonly ValidationError[], container: unknown): RepairScope {
  const modules = moduleRecords(container);
  const ids = new Set<string>();
  let confined = errors.length > 0;
  const messages = errors.map((error) => {
    const match = /^root\.modules\[(\d+)\]/.exec(error.path);
    const localId = match ? modules[Number(match[1])]?.localId : undefined;
    if (typeof localId !== 'string' || !localId) {
      confined = false;
      return error.path + ': ' + error.code + ': ' + error.message;
    }
    ids.add(localId);
    return error.path.replace(/^root\.modules\[\d+\]/, 'module ' + localId)
      + ': ' + error.code + ': ' + error.message;
  });
  return { moduleLocalIds: confined ? [...ids] : null, errors: messages };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function flagList(value: unknown): readonly unknown[] {
  const flags = asRecord(value).flags;
  return Array.isArray(flags) ? flags : [];
}

function flagModule(flag: unknown): string | undefined {
  const moduleLocalId = asRecord(asRecord(flag).location).moduleLocalId;
  return typeof moduleLocalId === 'string' ? moduleLocalId : undefined;
}

/**
 * Merges a scoped repair back by localId. The repaired modules' flags replace their previous
 * flags (the model saw and re-emits them). `order` lists every module the stage must cover,
 * so a module the model previously left out can still be filled in.
 */
function replaceModules(
  target: unknown,
  repaired: unknown,
  moduleLocalIds: readonly string[],
  order: unknown = target,
): Record<string, unknown> {
  const base = asRecord(target);
  const baseById = new Map(moduleRecords(base).map((module) => [String(module.localId), module]));
  const replacements = new Map(moduleRecords(repaired)
    .filter((module) => moduleLocalIds.includes(String(module.localId)))
    .map((module) => [String(module.localId), module]));
  const ids = moduleRecords(order).map((module) => String(module.localId));
  for (const id of baseById.keys()) if (!ids.includes(id)) ids.push(id);
  const keptFlags = flagList(base).filter((flag) => {
    const moduleLocalId = flagModule(flag);
    return !moduleLocalId || !moduleLocalIds.includes(moduleLocalId);
  });
  const flags = [...keptFlags, ...flagList(repaired)];
  return {
    ...base,
    modules: ids
      .map((id) => replacements.get(id) ?? baseById.get(id))
      .filter((module): module is Record<string, unknown> => Boolean(module)),
    ...(Array.isArray(base.flags) || flags.length > 0 ? { flags } : {}),
  };
}

function pickModules(
  value: unknown,
  moduleLocalIds: readonly string[],
): { modules: unknown[]; flags: unknown[] } {
  return {
    modules: moduleRecords(value).filter((module) => moduleLocalIds.includes(String(module.localId))),
    flags: flagList(value).filter((flag) => {
      const moduleLocalId = flagModule(flag);
      return Boolean(moduleLocalId) && moduleLocalIds.includes(moduleLocalId as string);
    }),
  };
}

function mergeLessonsAndQuestions(
  lessons: Record<string, unknown>,
  questions: Record<string, unknown>,
): Record<string, unknown> {
  if (
    Array.isArray(questions.modules)
    && questions.modules.every((module) =>
      module && typeof module === 'object' && Array.isArray((module as Record<string, unknown>).blocks))
  ) return questions;
  const questionModules = Array.isArray(questions.modules) ? questions.modules : [];
  const byModule = new Map<string, unknown>();
  questionModules.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const row = entry as Record<string, unknown>;
    if (typeof row.localId === 'string') byModule.set(row.localId, row.questions);
  });
  const lessonModules = Array.isArray(lessons.modules) ? lessons.modules : [];
  return {
    ...lessons,
    modules: lessonModules.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const row = entry as Record<string, unknown>;
      return { ...row, questions: typeof row.localId === 'string' ? byModule.get(row.localId) ?? [] : [] };
    }),
    flags: [
      ...(Array.isArray(lessons.flags) ? lessons.flags : []),
      ...(Array.isArray(questions.flags) ? questions.flags : []),
    ],
  };
}

export function createAiJobService(
  store: OnboardingStore,
  options: AiJobServiceOptions = {},
): AiJobService {
  const now = options.now ?? (() => new Date().toISOString());
  const templates = createTemplateService(store, { now });
  const stepSourceCache = new AsyncLocalStorage<Map<string, Promise<SourceRecord | undefined>>>();

  /**
   * A completed module job whose draft still exists and whose sources are unchanged needs no
   * sync, approval or materialization: next_step answers done at once.
   */
  async function completedModuleTemplateCurrent(actor: OnboardingActor, row: AiJobDbRecord): Promise<boolean> {
    const result = row.result as { templateId?: unknown; version?: unknown } | null | undefined;
    if (row.status !== 'completed' || !row.outline || !row.moduleRuns || row.outlineApprovedRevision !== row.outline.revision
      || !result || typeof result.templateId !== 'string' || typeof result.version !== 'number') return false;
    const records = await store.query<StoreRecord>(actor.roomId, 'onboarding_templates', {
      filter: { templateId: result.templateId, version: result.version },
      limit: 1,
    });
    if (records.records.length === 0) return false;
    for (const run of row.moduleRuns) {
      if (run.outline.tombstoned) continue;
      // A changed source reopens the job through the normal path (syncModuleSources).
      if ((await moduleContext(actor, row, run)).fingerprint !== run.sourceFingerprint) return false;
    }
    return true;
  }

  async function findJob(roomId: string, jobId: string): Promise<AiJobDbRecord | undefined> {
    const result = await store.query<AiJobDbRecord>(roomId, 'onboarding_ai_jobs', {
      filter: { jobId },
      limit: 1,
    });
    return result.records[0];
  }

  async function requireJob(actor: OnboardingActor, rawJobId: string): Promise<AiJobDbRecord> {
    const jobId = required(rawJobId, 'Job ID');
    const row = await findJob(actor.roomId, jobId);
    if (!row) throw new AiJobServiceError('JOB_NOT_FOUND', 'The AI job was not found.');
    return row;
  }

  /** Native attempts belong to the creating user's session, so only that admin controls the job. */
  async function requireOwnedJob(actor: OnboardingActor, rawJobId: string): Promise<AiJobDbRecord> {
    const row = await requireJob(actor, rawJobId);
    if (row.createdBy !== actor.userId) {
      throw new AiJobServiceError(
        'JOB_OWNER_REQUIRED',
        'Only the admin who started this AI job can control it.',
      );
    }
    return row;
  }

  async function sourceById(roomId: string, sourceId: string): Promise<SourceRecord | undefined> {
    // Within one next_step every module check reads the same job sources: load each once.
    const cache = stepSourceCache.getStore();
    if (!cache) return readSource(roomId, sourceId);
    const key = roomId + '\u0000' + sourceId;
    let pending = cache.get(key);
    if (!pending) {
      pending = readSource(roomId, sourceId);
      cache.set(key, pending);
    }
    return pending;
  }

  async function readSource(roomId: string, sourceId: string): Promise<SourceRecord | undefined> {
    const result = await store.query<SourceDbRecord>(roomId, 'onboarding_sources', {
      filter: { sourceId },
      limit: 1,
    });
    return result.records[0] ? sourceFrom(result.records[0], roomId) : undefined;
  }

  async function loadSources(
    roomId: string,
    sourceIds: readonly string[],
  ): Promise<readonly SourceRecord[]> {
    const sources = await Promise.all(sourceIds.map((sourceId) => sourceById(roomId, sourceId)));
    if (sources.some((source) => !source || source.status !== 'ready' || source.deletedAt)) {
      throw new AiJobServiceError('SOURCE_NOT_FOUND', 'Every selected source must be ready and active.');
    }
    return sources as SourceRecord[];
  }

  function planBatches(sources: readonly SourceRecord[]): readonly (readonly string[])[] {
    try {
      return planSourceBatches(sources);
    } catch (error) {
      if (error instanceof SourceBatchError) throw new AiJobServiceError(error.code, error.message);
      throw error;
    }
  }

  async function updateJob(
    actor: OnboardingActor,
    row: AiJobDbRecord,
    data: StoreRecord,
  ): Promise<AiJobDbRecord> {
    return store.update<AiJobDbRecord>(
      actor.roomId,
      'onboarding_ai_jobs',
      row.id,
      { ...data, updatedAt: new Date(Math.max(Date.parse(now()), Date.parse(row.updatedAt) + 1)).toISOString() },
      { expectedUpdatedAt: row.updatedAt },
    );
  }

  function rootCall(call: AiCallRecord): string {
    return call.repairOf ?? call.callId.replace(/-retry\d+$/, '');
  }

  async function promptFor(
    actor: OnboardingActor,
    job: AiJobDbRecord,
    call: AiCallRecord,
  ): Promise<AiPromptRequest> {
    if (job.kind === 'template' && job.pipelineVersion === 'module_v2') {
      if (isPlanCall(call)) return planPrompt(actor, job, call);
      const run = moduleForCall(job, call);
      const input = (await moduleContext(actor, job, run)).input;
      const questionInput = { ...input, lesson: run.lessonDraft!, lessonVersion: run.lessonVersion, lessonProvenance: run.lessonProvenance };
      if (!call.repairOf) return call.moduleTarget === 'questions' ? buildModuleQuestionPrompt(questionInput) : buildModuleLessonPrompt(input);
      const invalid = job.calls.find((item) => item.callId === call.repairOf);
      let previous: unknown = {};
      try { previous = parseAiJsonObject(rawOutput(job.stageOutputs, call.repairOf) ?? ''); } catch { /* Do not forward malformed untrusted text. */ }
      const errors = invalid?.errors ?? ['Invalid module output'];
      return call.moduleTarget === 'questions'
        ? buildModuleQuestionRepairPrompt({ ...questionInput, previous, errors })
        : buildModuleLessonRepairPrompt({ ...input, previous, errors });
    }
    if (job.kind === 'inventory') {
      const sources = await loadSources(actor.roomId, job.sourceIds ?? []);
      const plan = job.stageOutputs.__plan as {
        batches?: readonly (readonly string[])[];
      } | undefined;
      const root = rootCall(call);
      const index = verificationBatchIndex(job.stageOutputs, root);
      const scoped = batchSources(sources, plan?.batches?.[index] ?? []);
      const base = buildInventoryPrompt({
        sources: scoped,
        batchIndex: index + 1,
        totalBatches: plan?.batches?.length ?? 1,
      });
      if (call.callId === root || call.callId.includes('-retry')) return base;
      const previous = job.calls
        .filter((candidate) => rootCall(candidate) === root && candidate.status === 'invalid')
        .slice(-1)[0];
      return buildRepairPrompt(
        previous ? rawOutput(job.stageOutputs, previous.callId) ?? '' : '',
        previous?.errors ?? ['Invalid inventory output'],
        base.systemContext,
        base.prompt,
      );
    }

    if (call.stage === 'D') {
      const batches = job.stageOutputs.__verificationBatches as
        | readonly (readonly VerificationClaim[])[]
        | undefined;
      const root = rootCall(call);
      const index = verificationBatchIndex(job.stageOutputs, root);
      const claims = batches?.[index];
      if (!claims) {
        throw new AiJobServiceError('JOB_CALL_MISMATCH', 'Verification claim batch is missing.');
      }
      const base = buildVerificationPrompt(claims.map((claim) => ({
        id: claim.id,
        claim: claim.text,
        quotes: claim.quotes.map((reference) => reference.quote),
      })));
      if (call.callId === root || call.callId.includes('-retry')) return base;
      const previous = job.calls
        .filter((candidate) => rootCall(candidate) === root && candidate.status === 'invalid')
        .slice(-1)[0];
      return buildRepairPrompt(
        previous ? rawOutput(job.stageOutputs, previous.callId) ?? '' : '',
        previous?.errors ?? ['Invalid verification output'],
        base.systemContext,
        base.prompt,
      );
    }

    const inventory = job.stageOutputs.__inventory;
    const prefix = job.templateKind === 'advanced' ? 'C' : 'B';
    const root = rootCall(call);
    const base = root === prefix + '-questions'
      ? buildTemplateQuestionsPrompt({
        templateKind: job.templateKind ?? 'normal',
        inventory,
        lessons: job.stageOutputs.__lessons,
        ...(job.roleProfile ? { roleProfile: job.roleProfile } : {}),
      })
      : buildTemplateLessonsPrompt({
        templateKind: job.templateKind ?? 'normal',
        inventory,
        ...(job.roleProfile ? { roleProfile: job.roleProfile } : {}),
      });
    if (call.callId === root) return base;
    if (job.stageOutputs.__repairMode === MODULE_REPAIR_MODE) {
      const stage = root === prefix + '-questions' ? 'questions' : 'lessons';
      const scope = job.stageOutputs['repairScope:' + root] as RepairScope | null | undefined;
      // A retry regenerates the stage unless the failure was confined to modules.
      if (call.callId.includes('-retry') && !scope?.moduleLocalIds?.length) return base;
      const stageOutput = stage === 'lessons' ? job.stageOutputs.__lessons : job.stageOutputs.__questions;
      if (scope?.moduleLocalIds?.length) {
        return buildModuleRepairPrompt({
          templateKind: job.templateKind ?? 'normal',
          inventory,
          ...(job.roleProfile ? { roleProfile: job.roleProfile } : {}),
          stage,
          moduleLocalIds: scope.moduleLocalIds,
          previous: pickModules(stageOutput, scope.moduleLocalIds),
          errors: scope.errors,
          ...(stage === 'questions'
            ? { lessons: pickModules(job.stageOutputs.__lessons, scope.moduleLocalIds) }
            : {}),
        });
      }
      const previousCall = job.calls
        .filter((candidate) => rootCall(candidate) === root && candidate.status === 'invalid')
        .slice(-1)[0];
      return buildRepairPrompt(
        scope
          ? JSON.stringify(stageOutput)
          : previousCall ? rawOutput(job.stageOutputs, previousCall.callId) ?? '' : '',
        scope?.errors ?? previousCall?.errors ?? ['Invalid ' + stage + ' output'],
        base.systemContext,
        base.prompt,
      );
    }
    if (root === prefix + '-questions' && job.stageOutputs.__candidate !== undefined) {
      const repairBase = buildTemplateRepairBase({
        templateKind: job.templateKind ?? 'normal',
        inventory,
        ...(job.roleProfile ? { roleProfile: job.roleProfile } : {}),
      });
      return buildRepairPrompt(
        JSON.stringify(job.stageOutputs.__candidate),
        Array.isArray(job.stageOutputs.__candidateErrors)
          ? job.stageOutputs.__candidateErrors as string[]
          : ['Invalid template output'],
        repairBase.systemContext,
        repairBase.prompt,
      );
    }
    if (call.callId.includes('-retry')) return base;
    const previous = job.calls
      .filter((candidate) => rootCall(candidate) === root && candidate.status === 'invalid')
      .slice(-1)[0];
    return buildRepairPrompt(
      previous ? rawOutput(job.stageOutputs, previous.callId) ?? '' : '',
      previous?.errors
        ?? (Array.isArray(job.stageOutputs.__candidateErrors)
          ? job.stageOutputs.__candidateErrors as string[]
          : ['Invalid template output']),
      base.systemContext,
      base.prompt,
    );
  }

  async function failInvalid(
    actor: OnboardingActor,
    row: AiJobDbRecord,
    call: AiCallRecord,
    messages: readonly string[],
    extraOutputs: Readonly<Record<string, unknown>> = {},
  ): Promise<AiJobDbRecord> {
    const root = rootCall(call);
    const repairs = row.calls.filter((candidate) =>
      candidate.repairOf === root && /-r\d+$/.test(candidate.callId));
    // A manual retry starts a fresh repair budget; numbering stays unique across the job.
    const lastRetry = row.calls.reduce((last, candidate, index) =>
      candidate.callId.startsWith(root + '-retry') ? index : last, -1);
    const budgetUsed = row.calls.filter((candidate, index) => index > lastRetry
      && candidate.repairOf === root && /-r\d+$/.test(candidate.callId)).length;
    const invalidCalls = row.calls.map((candidate) => candidate.callId === call.callId ? {
      ...candidate,
      status: 'invalid' as const,
      errors: messages.slice(0, 30),
      rawExcerpt: (rawOutput(row.stageOutputs, call.callId) ?? '').slice(0, 50 * 1024),
    } : candidate);
    if (budgetUsed >= AI_GENERATION_LIMITS.maxRepairAttempts) {
      return updateJob(actor, row, {
        calls: invalidCalls,
        status: 'failed',
        errorCode: 'AI_OUTPUT_INVALID',
        errorMessage: messages.slice(0, 3).join(' | '),
        stageOutputs: { ...row.stageOutputs, ...extraOutputs },
        ...RELEASED_LEASE,
      });
    }
    const repairNumber = repairs.length + 1;
    const repairId = root + '-r' + String(repairNumber);
    const repair: AiCallRecord = {
      callId: repairId,
      stage: call.stage,
      repairOf: root,
      operationId: row.jobId + ':' + repairId,
      status: 'pending',
    };
    return updateJob(actor, row, {
      calls: [...invalidCalls, repair],
      stageOutputs: {
        ...row.stageOutputs,
        ...extraOutputs,
        ['processed:' + call.callId]: true,
      },
    });
  }

  async function processInventory(
    actor: OnboardingActor,
    row: AiJobDbRecord,
    call: AiCallRecord,
  ): Promise<AiJobDbRecord> {
    try {
      const parsed = parseAiJsonObject(rawOutput(row.stageOutputs, call.callId) ?? '', {
        allowLeadingNarration: callProvider(call) === 'native_chat',
      });
      const validated = validateInventoryChunk(parsed);
      if (!validated.ok) {
        return failInvalid(actor, row, call, validated.errors.map((error) =>
          error.path + ': ' + error.code + ': ' + error.message));
      }
      const sources = await loadSources(actor.roomId, row.sourceIds ?? []);
      const plan = row.stageOutputs.__plan as {
        batches?: readonly (readonly string[])[];
      } | undefined;
      const root = rootCall(call);
      const index = Math.max(0, Number(root.slice(1)) - 1);
      const grounded = groundInventory(
        validated.value,
        batchSources(sources, plan?.batches?.[index] ?? []),
      );
      const stageOutputs = {
        ...row.stageOutputs,
        ['result:' + root]: grounded,
        ['processed:' + call.callId]: true,
      };
      const roots = row.calls.filter((candidate) => /^A\d+$/.test(candidate.callId));
      const complete = roots.every((candidate) =>
        candidate.callId === root || stageOutputs['result:' + candidate.callId] !== undefined);
      if (!complete) return updateJob(actor, row, { stageOutputs });
      const chunks = roots.map((candidate) =>
        stageOutputs['result:' + candidate.callId] as InventoryChunk);
      return updateJob(actor, row, {
        stageOutputs,
        result: mergeInventoryChunks(chunks),
        status: 'completed',
        ...RELEASED_LEASE,
      });
    } catch (error) {
      return failInvalid(actor, row, call, validationMessages(error));
    }
  }

  async function processTemplate(
    actor: OnboardingActor,
    row: AiJobDbRecord,
    call: AiCallRecord,
  ): Promise<AiJobDbRecord> {
    const prefix = row.templateKind === 'advanced' ? 'C' : 'B';
    try {
      const parsed = parseAiJsonObject(rawOutput(row.stageOutputs, call.callId) ?? '', {
        allowLeadingNarration: callProvider(call) === 'native_chat',
      });
      if (call.stage === 'D') {
        const batches = row.stageOutputs.__verificationBatches as
          | readonly (readonly VerificationClaim[])[]
          | undefined;
        const root = rootCall(call);
        const index = verificationBatchIndex(row.stageOutputs, root);
        const batch = batches?.[index];
        if (!batch) throw new Error('Verification claim batch is missing.');
        const verdicts = parseVerificationVerdicts(parsed, batch);
        const stageOutputs = {
          ...row.stageOutputs,
          ['result:' + root]: verdicts,
          ['processed:' + call.callId]: true,
        };
        const roots = row.calls.filter((candidate) => /^D\d+$/.test(candidate.callId));
        const complete = roots.every((candidate) =>
          candidate.callId === root || stageOutputs['result:' + candidate.callId] !== undefined);
        if (!complete) return updateJob(actor, row, { stageOutputs });

        const candidate = row.stageOutputs.__candidate as GeneratedTemplate | undefined;
        if (!candidate || !batches) throw new Error('Verified template candidate is missing.');
        const claims = batches.flat();
        const allVerdicts = roots.flatMap((candidateCall) =>
          stageOutputs['result:' + candidateCall.callId] as readonly VerificationVerdict[]);
        const applied = applyVerificationVerdicts(candidate, claims, allVerdicts);
        const sources = await loadSources(actor.roomId, row.sourceIds ?? []);
        const validationNotes = Array.isArray(row.stageOutputs.__generationNotes)
          ? row.stageOutputs.__generationNotes as string[]
          : [];
        const generationNotes = [...validationNotes, ...applied.generationNotes];
        const materialized = await materializeAiTemplate(store, templates, actor, {
          jobId: row.jobId,
          promptVersion: row.promptVersion,
          templateKind: row.templateKind ?? 'normal',
          generated: {
            ...applied.template,
            ...(row.title ? { title: row.title } : {}),
          },
          sources,
          ...(row.roleProfile ? { roleProfile: row.roleProfile } : {}),
          generationNotes,
        });
        return updateJob(actor, row, {
          stageOutputs: {
            ...stageOutputs,
            __candidate: applied.template,
            __generationNotes: generationNotes,
          },
          result: { templateId: materialized.id, version: materialized.version },
          status: 'completed',
          ...RELEASED_LEASE,
        });
      }
      if (row.stageOutputs.__repairMode === MODULE_REPAIR_MODE) {
        return await processTemplateStage(actor, row, call, parsed);
      }
      if (call.callId === prefix + '-lessons') {
        const questionsId = prefix + '-questions';
        const questionsCall: AiCallRecord = {
          callId: questionsId,
          stage: call.stage,
          operationId: row.jobId + ':' + questionsId,
          status: 'pending',
        };
        return updateJob(actor, row, {
          calls: [...row.calls, questionsCall],
          stageOutputs: {
            ...row.stageOutputs,
            __lessons: parsed,
            ['processed:' + call.callId]: true,
          },
        });
      }
      const candidate = rootCall(call) === prefix + '-questions'
        ? mergeLessonsAndQuestions(
          row.stageOutputs.__lessons as Record<string, unknown>,
          parsed,
        )
        : parsed;
      const validated = validateGeneratedTemplate(candidate, {
        templateKind: row.templateKind ?? 'normal',
        ...(row.roleProfile ? { roleProfile: row.roleProfile } : {}),
      });
      if (!validated.ok) {
        const messages = validated.errors.map((error) =>
          error.path + ': ' + error.code + ': ' + error.message);
        const withCandidate = await updateJob(actor, row, {
          stageOutputs: {
            ...row.stageOutputs,
            __candidate: candidate,
            __candidateErrors: messages,
          },
        });
        return failInvalid(actor, withCandidate, call, messages);
      }
      return await scheduleVerification(actor, row, call, validated);
    } catch (error) {
      return failInvalid(actor, row, call, validationMessages(error), row.stageOutputs.__repairMode === MODULE_REPAIR_MODE
        ? { ['repairScope:' + rootCall(call)]: null }
        : {});
    }
  }

  async function scheduleVerification(
    actor: OnboardingActor,
    row: AiJobDbRecord,
    call: AiCallRecord,
    validated: Extract<GeneratedTemplateValidation, { ok: true }>,
    extraOutputs: Readonly<Record<string, unknown>> = {},
  ): Promise<AiJobDbRecord> {
    const safe = removeQuestionsBlockedByFlags(validated.value);
    const batches = claimBatches(buildVerificationClaims(safe.template));
    if (batches.length === 0) throw new Error('Template has no claims to verify.');
    const verificationCalls = batches.map<AiCallRecord>((_batch, index) => {
      const callId = 'D' + String(index + 1);
      return {
        callId,
        stage: 'D',
        operationId: row.jobId + ':' + callId,
        status: 'pending',
      };
    });
    return updateJob(actor, row, {
      calls: [...row.calls, ...verificationCalls],
      stageOutputs: {
        ...row.stageOutputs,
        ...extraOutputs,
        __candidate: safe.template,
        __verificationBatches: batches,
        __generationNotes: validated.generationNotes,
        ['processed:' + call.callId]: true,
      },
    });
  }

  /**
   * Module-mode lessons/questions: each stage is validated on its own and a repair returns
   * only the modules named in its scope, which are merged back by localId.
   */
  async function processTemplateStage(
    actor: OnboardingActor,
    row: AiJobDbRecord,
    call: AiCallRecord,
    parsed: Record<string, unknown>,
  ): Promise<AiJobDbRecord> {
    const prefix = row.templateKind === 'advanced' ? 'C' : 'B';
    const root = rootCall(call);
    const scopeKey = 'repairScope:' + root;
    const scope = /-(?:r|retry)\d+$/.test(call.callId)
      ? row.stageOutputs[scopeKey] as RepairScope | null | undefined
      : undefined;
    const options = {
      templateKind: row.templateKind ?? 'normal',
      ...(row.roleProfile ? { roleProfile: row.roleProfile } : {}),
    };

    if (root === prefix + '-lessons') {
      const lessons = scope?.moduleLocalIds?.length
        ? replaceModules(row.stageOutputs.__lessons, parsed, scope.moduleLocalIds)
        : parsed;
      const validated = validateGeneratedTemplate(lessons, { ...options, lessonsOnly: true });
      if (!validated.ok) {
        const next = repairScopeFor(validated.errors, lessons);
        return failInvalid(actor, row, call, next.errors, { __lessons: lessons, [scopeKey]: next });
      }
      const questionsId = prefix + '-questions';
      const questionsCall: AiCallRecord = {
        callId: questionsId,
        stage: call.stage,
        operationId: row.jobId + ':' + questionsId,
        status: 'pending',
      };
      return updateJob(actor, row, {
        calls: row.calls.some((candidate) => candidate.callId === questionsId)
          ? row.calls
          : [...row.calls, questionsCall],
        stageOutputs: {
          ...row.stageOutputs,
          __lessons: lessons,
          [scopeKey]: null,
          ['processed:' + call.callId]: true,
        },
      });
    }

    const questions = scope?.moduleLocalIds?.length
      ? replaceModules(row.stageOutputs.__questions, parsed, scope.moduleLocalIds, row.stageOutputs.__lessons)
      : parsed;
    const candidate = mergeLessonsAndQuestions(
      row.stageOutputs.__lessons as Record<string, unknown>,
      questions,
    );
    const validated = validateGeneratedTemplate(candidate, options);
    if (!validated.ok) {
      const next = repairScopeFor(validated.errors, candidate);
      return failInvalid(actor, row, call, next.errors, {
        __questions: questions,
        __candidate: candidate,
        __candidateErrors: next.errors,
        [scopeKey]: next,
      });
    }
    return scheduleVerification(actor, row, call, validated, {
      __questions: questions,
      [scopeKey]: null,
    });
  }

  async function processCompleted(
    actor: OnboardingActor,
    row: AiJobDbRecord,
    call: AiCallRecord,
  ): Promise<AiJobDbRecord> {
    // Retrying persisted terminal evidence also retries a release whose response was lost.
    await releaseCallLease(actor, row, call);
    if (row.kind === 'template' && row.pipelineVersion === 'module_v2') return isPlanCall(call) ? processPlanOutput(actor, row, call) : processModuleOutput(actor, row, call);
    return row.kind === 'inventory'
      ? processInventory(actor, row, call)
      : processTemplate(actor, row, call);
  }

  function leaseOwned(row: AiJobDbRecord, workerId: string): boolean {
    return row.pumpedBy === workerId
      && Boolean(row.pumpLeaseUntil)
      && Date.parse(row.pumpLeaseUntil as string) >= Date.parse(now());
  }

  async function releaseCallLease(actor: OnboardingActor, row: AiJobDbRecord, call: AiCallRecord): Promise<boolean> {
    const holderId = call.leaseHolderId ?? row.pumpedBy;
    return holderId ? releaseRoomAiLease(store, actor, { jobId: row.jobId, callId: call.callId, holderId, now: now() }) : true;
  }

  async function assertRoomLease(actor: OnboardingActor, row: AiJobDbRecord, callId: string, holderId: string): Promise<void> {
    await refreshRoomAiLease(store, actor, { jobId: row.jobId, callId, holderId, now: now() });
  }

  async function callStep(actor: OnboardingActor, row: AiJobDbRecord, call: AiCallRecord, workerId: string, request: AiPromptRequest): Promise<AiJobNextStep> {
    // Returning a pending call is itself a durable dispatch claim. A lost response is
    // uncertain, so even the same tab must not receive a second dispatch permission.
    if (!call.attemptRef && call.dispatchClaimedAt) return { kind: 'wait', job: jobFrom(row, actor.roomId) };
    const lease = await acquireRoomAiLease(store, actor, { jobId: row.jobId, callId: call.callId, holderId: workerId, reserveDispatch: !call.attemptRef, now: now() });
    if (!lease.acquired) return { kind: 'wait', job: jobFrom(row, actor.roomId) };
    const calls = row.calls.map((item) => item.callId === call.callId ? { ...item, leaseHolderId: workerId, ...(!item.attemptRef ? { dispatchClaimedAt: now() } : {}) } : item);
    let moduleRuns = row.moduleRuns;
    if (call.moduleLocalId && call.retryKind && !call.leaseHolderId) {
      const run = moduleForCall(row, call);
      const next = call.moduleTarget === 'lesson' ? { ...run, lessonAttempts: (run.lessonAttempts ?? 0) + 1 } : { ...run, questionAttempts: (run.questionAttempts ?? 0) + 1 };
      moduleRuns = replaceRun(row, next);
    }
    try {
      row = await updateJob(actor, row, { calls, ...(moduleRuns ? { moduleRuns } : {}), pumpedBy: workerId, pumpLeaseUntil: lease.lease.expiresAt });
    } catch (error) {
      // An optimistic rejection proves this request never persisted or granted the
      // new claim. Unknown transport outcomes retain the reservation conservatively.
      if (!call.attemptRef && isAiLeaseConflict(error)) {
        await releaseRoomAiLease(store, actor, { jobId: row.jobId, callId: call.callId, holderId: workerId, now: now() });
      }
      throw error;
    }
    return {
      kind: 'ai_call',
      callId: call.callId,
      operationId: call.operationId,
      ...request,
      ...(call.moduleTarget ? { moduleTarget: call.moduleTarget } : {}),
      ...(call.attemptRef ? { attemptRef: call.attemptRef, provider: callProvider(call), startedAt: call.startedAt } : {}),
    };
  }

  function retryCall(row: AiJobDbRecord, call: AiCallRecord, kind: NonNullable<AiCallRecord['retryKind']>): AiCallRecord {
    const root = rootCall(call);
    const callId = call.moduleLocalId ? 'module-' + String(row.calls.length + 1) : root + '-retry' + String(row.calls.filter((item) => item.callId.startsWith(root + '-retry')).length + 1);
    return {
      callId, operationId: row.jobId + ':' + callId, stage: call.stage, status: 'pending', retryKind: kind,
      ...(call.moduleLocalId ? { moduleLocalId: call.moduleLocalId, moduleTarget: call.moduleTarget, moduleVersion: call.moduleVersion, lessonVersion: call.lessonVersion, outlineRevision: call.outlineRevision,
        ...(kind === 'schema' ? { repairOf: call.callId } : call.repairOf ? { repairOf: call.repairOf } : {}),
      } : { repairOf: root }),
    };
  }

  /** Keep a lesson successor ahead of a deferred question without moving live claims. */
  function enqueueModuleSuccessor(calls: readonly AiCallRecord[], successor: AiCallRecord): AiCallRecord[] {
    const deferred = successor.moduleTarget === 'lesson' ? calls.findIndex((call) => call.moduleTarget === 'questions' && call.status === 'pending' && !call.dispatchClaimedAt && !call.attemptRef) : -1;
    return deferred < 0 ? [...calls, successor] : [...calls.slice(0, deferred), successor, ...calls.slice(deferred)];
  }

  function clearRunWait(run: AiModuleDraftRun): AiModuleDraftRun {
    const { nextRetryAt: _retry, providerWaitStartedAt: _wait, ...rest } = run;
    return rest;
  }

  async function providerWaitStep(actor: OnboardingActor, row: AiJobDbRecord): Promise<AiJobNextStep | undefined> {
    const current = row.calls.find((call) => call.status === 'pending' || call.status === 'dispatched');
    // Waiting applies to a pending retry, never to polling an already-recorded attempt.
    if (!current || current.attemptRef || current.dispatchClaimedAt) return undefined;
    if (row.providerWaitStartedAt && Date.parse(row.providerWaitStartedAt) > 0
      && Date.parse(now()) - Date.parse(row.providerWaitStartedAt) >= MAX_PROVIDER_WAIT_MS) {
      const calls = row.calls.map((call) => call.callId === current.callId ? { ...call, status: 'failed' as const, errors: ['PROJECT_BUSY'], finishedAt: now() } : call);
      if (row.pipelineVersion === 'module_v2' && row.kind === 'template' && isPlanCall(current)) {
        // Planner work is optional: a project that stays busy keeps the deterministic outline
        // (P) or skips the supplement batch (S).
        let updated = await updateJob(actor, row, { calls, ...planGiveUp(row, current), ...CLEARED_WAIT, ...RELEASED_LEASE });
        await releaseCallLease(actor, row, current);
        if (current.stage === 'S') updated = await settleSupplements(actor, updated);
        // Later supplement batches still run; the pump polls again for them.
        return { kind: planPending(updated.calls) ? 'wait' : 'awaiting_admin', job: jobFrom(updated, actor.roomId) };
      }
      if (row.pipelineVersion === 'module_v2' && row.kind === 'template') {
        const run = moduleForCall(row, current);
        const next = current.moduleTarget === 'lesson' ? await fallbackRun(actor, row, run) : { ...clearRunWait(run), questionState: 'failed' as const };
        const updated = await updateJob(actor, row, { calls, moduleRuns: replaceRun(row, next), ...CLEARED_WAIT, ...RELEASED_LEASE });
        await releaseCallLease(actor, row, current);
        return { kind: 'awaiting_admin', job: jobFrom(updated, actor.roomId) };
      }
      const updated = await updateJob(actor, row, { calls, status: 'failed', errorCode: 'PROJECT_BUSY', errorMessage: 'The provider project remained busy.', ...CLEARED_WAIT, ...RELEASED_LEASE });
      await releaseCallLease(actor, row, current);
      return { kind: 'failed', job: jobFrom(updated, actor.roomId) };
    }
    if (row.nextRetryAt && Date.parse(row.nextRetryAt) > Date.parse(now())) return { kind: 'wait', job: jobFrom(row, actor.roomId) };
    return undefined;
  }

  function replaceRun(row: AiJobDbRecord, run: AiModuleDraftRun): readonly AiModuleDraftRun[] {
    return row.moduleRuns!.map((item) => item.outline.moduleLocalId === run.outline.moduleLocalId ? run : item);
  }
  function moduleForCall(row: AiJobDbRecord, call: AiCallRecord): AiModuleDraftRun {
    const run = row.moduleRuns?.find((item) => item.outline.moduleLocalId === call.moduleLocalId && !item.outline.tombstoned);
    if (!run || !row.outline || row.outlineApprovedRevision !== row.outline.revision || call.outlineRevision !== row.outline.revision || call.moduleVersion !== (call.moduleTarget === 'lesson' ? run.lessonVersion : run.questionVersion) || (call.moduleTarget === 'questions' && (!lessonApproved(run) || call.lessonVersion !== run.lessonVersion))) {
      throw new AiJobServiceError('JOB_CALL_MISMATCH', 'The module call no longer matches the approved revision.');
    }
    return run;
  }
  async function moduleContext(actor: OnboardingActor, row: AiJobDbRecord, run: AiModuleDraftRun): Promise<{ input: ModuleLessonPromptInput; fingerprint: string; usable: boolean }> {
    const sources = await Promise.all((row.sourceIds ?? []).map((id) => sourceById(actor.roomId, id)));
    const records = sources.filter((s): s is SourceRecord => !!s && s.status === 'ready' && !s.deletedAt);
    const ids = run.outline.sourceSectionIds;
    const matches = ids.map((id) => records.flatMap((source) => (source.sections ?? []).filter((s) => s.id === id).map((section) => ({ section, checksum: source.checksum, sourceId: source.sourceId }))));
    const usable = moduleHasUsableSources(run.outline, usableSectionIds(records)) && new Set(ids).size === ids.length;
    const sections = usable ? matches.map((items) => items[0].section) : [];
    const inventory = row.stageOutputs.__inventory as FeatureInventory;
    const relatedModules = (row.moduleRuns ?? []).filter((item) => !item.outline.tombstoned && item.outline.moduleLocalId !== run.outline.moduleLocalId).map((item) => item.outline).sort((a, b) => a.order - b.order).map((outline) => ({ order: outline.order, title: outline.title }));
    return { input: { module: run.outline, sections, features: inventory.features, responsibilities: row.roleProfile?.responsibilities ?? [], templateKind: row.templateKind ?? 'normal', relatedModules }, fingerprint: stableHash(matches), usable };
  }
  function obsoleteCalls(row: AiJobDbRecord, ids: ReadonlySet<string>): readonly AiCallRecord[] {
    return row.calls.map((call) => call.moduleLocalId && ids.has(call.moduleLocalId) && (['pending', 'dispatched'].includes(call.status) || (call.status === 'completed' && row.stageOutputs['processed:' + call.callId] !== true))
      ? { ...call, status: 'failed', errors: ['Module revision superseded.'], ...(aiCallMayBeLive(call) ? { cleanupState: 'pending', cleanupUpdatedAt: now() } as const : {}) }
      : call);
  }
  function leaseAfterChanges(calls: readonly AiCallRecord[]): StoreRecord {
    return calls.some((call) => call.status === 'pending' || call.status === 'dispatched') ? {} : { ...RELEASED_LEASE, ...CLEARED_WAIT };
  }
  async function syncModuleSources(actor: OnboardingActor, row: AiJobDbRecord): Promise<AiJobDbRecord> {
    const changed = new Set<string>();
    const runs = await Promise.all(row.moduleRuns!.map(async (run) => {
      if (run.outline.tombstoned) return run;
      const { fingerprint } = await moduleContext(actor, row, run);
      if (run.sourceFingerprint === fingerprint) return run;
      if (run.sourceFingerprint !== undefined) changed.add(run.outline.moduleLocalId);
      return { ...(run.sourceFingerprint === undefined ? run : invalidateModule(run)), sourceFingerprint: fingerprint };
    }));
    if (JSON.stringify(runs) === JSON.stringify(row.moduleRuns)) return row;
    const calls = obsoleteCalls(row, changed);
    return updateJob(actor, row, { moduleRuns: runs, ...(changed.size ? { calls, status: 'running', result: null, ...leaseAfterChanges(calls) } : {}) });
  }
  async function requireModuleJob(actor: OnboardingActor, jobId: string): Promise<AiJobDbRecord> {
    requireAdmin(actor);
    const row = await requireOwnedJob(actor, jobId);
    if (row.pipelineVersion !== 'module_v2' || row.kind !== 'template' || !row.outline || !row.moduleRuns || row.status === 'cancelled' || row.status === 'failed') throw new AiJobServiceError('JOB_NOT_RUNNING', 'A current module job is required.');
    return syncModuleSources(actor, row);
  }
  function requireRun(row: AiJobDbRecord, moduleLocalId: string): AiModuleDraftRun {
    const run = row.moduleRuns!.find((r) => r.outline.moduleLocalId === moduleLocalId && !r.outline.tombstoned);
    if (!run) throw new AiJobServiceError('OPERATION_CONFLICT', 'Active module not found.');
    if (row.outlineApprovedRevision !== row.outline!.revision) throw new AiJobServiceError('OPERATION_CONFLICT', 'Approve the current outline first.');
    return run;
  }
  /** One `__moduleAudit` entry; `approvedBy` is the Admin's user ID or `autopilot`. */
  function moduleAuditEntry(run: AiModuleDraftRun, audit: StoreRecord, approvedBy: string): StoreRecord {
    return { ...audit, moduleLocalId: run.outline.moduleLocalId, outlineRevision: run.outlineRevision, sourceFingerprint: run.sourceFingerprint, approvedBy, approvedAt: now() };
  }
  function lessonAudit(run: AiModuleDraftRun): StoreRecord {
    return { target: 'lesson', version: run.lessonVersion, module: run.lessonDraft, provenance: run.lessonProvenance, flags: run.lessonFlags ?? [] };
  }
  function questionAudit(run: AiModuleDraftRun): StoreRecord {
    return { target: 'questions', version: run.questionVersion, lessonVersion: run.lessonVersion, questions: run.questionDraft, provenance: run.questionProvenance, flags: run.questionFlags ?? [] };
  }
  async function saveRun(actor: OnboardingActor, row: AiJobDbRecord, run: AiModuleDraftRun, audit?: StoreRecord): Promise<AiJobRecord> {
    const history = (row.stageOutputs.__moduleAudit ?? []) as readonly StoreRecord[];
    const calls = obsoleteCalls(row, new Set([run.outline.moduleLocalId]));
    return jobFrom(await updateJob(actor, row, { moduleRuns: replaceRun(row, run), calls, status: 'running', result: null,
      ...(audit ? { stageOutputs: { ...row.stageOutputs, __moduleAudit: [...history, moduleAuditEntry(run, audit, actor.userId)] } } : {}), ...leaseAfterChanges(calls) }), actor.roomId);
  }
  /**
   * The planner may still replace the outline, so neither edits nor approval may race it. A
   * completed planner output that was not yet processed (its processing write failed) still
   * counts: the next step would apply it over the admin's change.
   */
  function assertPlanSettled(row: AiJobDbRecord): void {
    // A settled supplement request whose result was not yet applied counts the same way.
    if (unprocessedPlanCall(row) || planPending(row.calls) || settledSupplements(row).length > 0) throw new AiJobServiceError('OPERATION_CONFLICT', PLAN_PENDING_MESSAGE);
  }
  function unprocessedPlanCall(row: AiJobDbRecord): AiCallRecord | undefined {
    return row.calls.find((call) => isPlanCall(call) && call.status === 'completed'
      && rawOutput(row.stageOutputs, call.callId) !== undefined && row.stageOutputs['processed:' + call.callId] !== true);
  }
  /** Supplement requests whose calls have all settled but whose merged result is not yet applied. */
  function settledSupplements(row: AiJobDbRecord): readonly number[] {
    const requests = [...new Set(row.calls.map(supplementRequest).filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
    return requests.filter((n) => row.stageOutputs['applied:supplement-' + String(n)] !== true
      && row.calls.every((call) => supplementRequest(call) !== n || !(call.status === 'pending' || call.status === 'dispatched'
        || (call.status === 'completed' && rawOutput(row.stageOutputs, call.callId) !== undefined && row.stageOutputs['processed:' + call.callId] !== true))));
  }
  function requeueDrafting(run: AiModuleDraftRun): AiModuleDraftRun {
    return { ...run, ...(run.lessonState === 'drafting' ? { lessonState: 'queued' } : {}), ...(run.questionState === 'drafting' ? { questionState: 'queued' } : {}) };
  }
  /** Shared checks for Admin outline-coverage actions: current revision, planner settled, no live call. */
  async function requireOutlineEdit(actor: OnboardingActor, input: OutlineVersionInput): Promise<AiJobDbRecord> {
    const row = await requireModuleJob(actor, input.jobId);
    assertPlanSettled(row);
    assertOutlineRevision(row, input.expectedRevision);
    if (row.calls.some(aiCallMayBeLive)) throw new AiJobServiceError('OPERATION_CONFLICT', 'An AI call is still active.');
    return row;
  }
  function requireActiveModule(row: AiJobDbRecord, moduleLocalId: string): TemplateOutlineModule {
    const module = row.outline!.modules.find((item) => !item.tombstoned && item.moduleLocalId === moduleLocalId);
    if (!module) throw new AiJobServiceError('OPERATION_CONFLICT', 'Active module not found.');
    return module;
  }
  /** A request's root calls (one per batch it ran), in batch order. */
  function supplementRoots(row: AiJobDbRecord, requestNumber: number): readonly AiCallRecord[] {
    return row.calls.filter((call) => supplementRequest(call) === requestNumber && call.callId === rootCall(call))
      .sort((a, b) => (a.supplementBatch ?? 0) - (b.supplementBatch ?? 0));
  }
  /**
   * Batch numbers skipped by the most recent new-file request for this source, so "Thử lại" can
   * re-run just those. Empty when the source was never supplemented or its last request read every batch.
   */
  function skippedSupplementBatches(row: AiJobDbRecord, sourceId: string): readonly number[] {
    const latest = Math.max(0, ...row.calls.map(supplementRequest).filter((n): n is number => n !== undefined
      && (row.stageOutputs['supplement:' + String(n)] as SupplementRequest | undefined)?.sourceId === sourceId));
    if (!latest) return [];
    return supplementRoots(row, latest).filter((call) => row.stageOutputs['result:' + call.callId] === undefined).map((call) => call.supplementBatch ?? 1);
  }
  function nextSupplementNumber(row: AiJobDbRecord): number {
    return Math.max(0, ...row.calls.map(supplementRequest).filter((n): n is number => n !== undefined)) + 1;
  }
  function supplementCall(row: AiJobDbRecord, request: number, batch: number, moduleLocalId: string, sourceId?: string): AiCallRecord {
    const callId = 'supplement-' + String(request) + '-b' + String(batch);
    return {
      callId, stage: 'S', planTarget: 'supplement', status: 'pending', operationId: row.jobId + ':' + callId,
      supplementModuleLocalId: moduleLocalId, supplementBatch: batch, ...(sourceId ? { supplementSourceId: sourceId } : {}),
    };
  }
  /**
   * The section picker's write path, shared by every coverage action and by applied supplement
   * results: one outline revision, invalidated changed modules, superseded module calls and a
   * reset outline approval.
   */
  async function applyOutlineEdits(actor: OnboardingActor, row: AiJobDbRecord, input: {
    readonly edits: readonly OutlineEdit[];
    readonly sourceIds?: readonly string[];
    readonly newId?: (frameKey: string) => string;
    readonly extraCalls?: readonly AiCallRecord[];
    readonly stageOutputs?: Readonly<Record<string, unknown>>;
  }): Promise<AiJobDbRecord> {
    let outline: TemplateOutline;
    try {
      outline = applyTemplateOutlineEdits(row.outline!, input.edits, input.newId ?? (() => 'unused'));
    } catch {
      throw new AiJobServiceError('OPERATION_CONFLICT', 'Outline edits are invalid.');
    }
    validateOutline(row, outline);
    const runs = reconcileModuleRuns(row.moduleRuns!, outline).map(requeueDrafting);
    const calls = [...obsoleteCalls(row, new Set(row.moduleRuns!.map((item) => item.outline.moduleLocalId))), ...(input.extraCalls ?? [])];
    return updateJob(actor, row, {
      ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}), outline, outlineApprovedRevision: 0, moduleRuns: runs, calls, status: 'running', result: null,
      ...(input.stageOutputs ? { stageOutputs: input.stageOutputs } : {}), ...leaseAfterChanges(calls),
    });
  }
  function assertOutlineRevision(row: AiJobDbRecord, revision: number): void {
    if (row.outline!.revision !== revision || !Number.isSafeInteger(revision)) throw new AiJobServiceError('OPERATION_CONFLICT', 'Outline revision conflict.');
  }
  function validateOutline(row: AiJobDbRecord, outline: TemplateOutline): void {
    const errors = validateAdminOutline(outline, { templateKind: row.templateKind ?? 'normal', responsibilities: row.roleProfile?.responsibilities ?? [] });
    if (errors.length) throw new AiJobServiceError('OPERATION_CONFLICT', errors.map((error) => error.message).join(' '));
  }
  async function fallbackRun(actor: OnboardingActor, row: AiJobDbRecord, run: AiModuleDraftRun): Promise<AiModuleDraftRun> {
    const context = await moduleContext(actor, row, run);
    const fallback = buildFallbackLesson({ outline: run.outline, sections: context.usable ? context.input.sections : [] });
    return fallback.kind === 'draft'
      ? updateLesson(run, run.lessonVersion, fallback.module, 'fallback')
      : { ...invalidateModule(run), lessonState: 'manual_required', questionState: 'blocked', lessonDraft: undefined, lessonProvenance: undefined };
  }
  async function processModuleOutput(actor: OnboardingActor, row: AiJobDbRecord, call: AiCallRecord): Promise<AiJobDbRecord> {
    const run = moduleForCall(row, call);
    const context = await moduleContext(actor, row, run);
    if (context.fingerprint !== run.sourceFingerprint) return syncModuleSources(actor, row);
    let next: AiModuleDraftRun;
    let errors: readonly string[] = [];
    try {
      const raw = parseAiJsonObject(rawOutput(row.stageOutputs, call.callId) ?? '');
      if (call.moduleTarget === 'lesson') {
        const validated = validateModuleLessonOutput(raw, context.input);
        if (!validated.ok) throw validated;
        next = { ...updateLesson(run, run.lessonVersion, validated.value.module, 'ai'), lessonFlags: validated.value.flags };
      } else {
        const validated = validateModuleQuestionOutput(raw, { ...context.input, lesson: run.lessonDraft!, lessonVersion: run.lessonVersion, lessonProvenance: run.lessonProvenance });
        if (!validated.ok) throw validated;
        next = { ...updateQuestions(run, run.questionVersion, validated.value.questions, 'ai'), questionFlags: validated.value.flags };
      }
    } catch (error) {
      errors = validationMessages(error);
      next = call.moduleTarget === 'lesson' ? await fallbackRun(actor, row, run) : { ...run, questionState: 'failed' };
    }
    let calls = row.calls.map((item): AiCallRecord => item.callId === call.callId ? { ...item, status: errors.length ? 'invalid' : 'completed', ...(errors.length ? { errors } : {}) } : item);
    if (errors.length && (run.schemaRepairs ?? 0) < 1) {
      next = { ...clearRunWait(run), schemaRepairs: (run.schemaRepairs ?? 0) + 1 };
      calls = enqueueModuleSuccessor(calls, retryCall(row, call, 'schema'));
    }
    return updateJob(actor, row, { moduleRuns: replaceRun(row, clearRunWait(next)), calls, stageOutputs: { ...row.stageOutputs, ['processed:' + call.callId]: true }, ...CLEARED_WAIT, ...RELEASED_LEASE });
  }
  async function liveJobSources(actor: OnboardingActor, row: AiJobDbRecord): Promise<readonly SourceRecord[]> {
    const sources = await Promise.all((row.sourceIds ?? []).map((id) => sourceById(actor.roomId, id)));
    return sources.filter((s): s is SourceRecord => !!s && s.status === 'ready' && !s.deletedAt);
  }
  function planRange(row: AiJobDbRecord): { readonly min: number; readonly max: number } {
    return row.templateKind === 'advanced' ? AI_GENERATION_LIMITS.advancedModuleRange : AI_GENERATION_LIMITS.normalModuleRange;
  }
  async function planInput(actor: OnboardingActor, row: AiJobDbRecord): Promise<OutlinePlanValidationInput> {
    const inventory = row.stageOutputs.__inventory as FeatureInventory;
    return {
      jobId: row.jobId, templateKind: row.templateKind ?? 'normal', previous: row.outline!,
      usable: usableSectionIds(await liveJobSources(actor, row)),
      featureIds: new Set(inventory.features.map((feature) => feature.featureId)),
      responsibilities: row.roleProfile?.responsibilities ?? [],
    };
  }
  /** The last invalid output of the same planner root, parsed; malformed text is never forwarded. */
  function previousPlanOutput(row: AiJobDbRecord, call: AiCallRecord): { readonly previous: unknown; readonly errors?: readonly string[] } {
    const invalid = row.calls.filter((item) => isPlanCall(item) && rootCall(item) === rootCall(call) && item.status === 'invalid').slice(-1)[0] as AiCallRecord | undefined;
    let previous: unknown = {};
    try { previous = invalid ? parseAiJsonObject(rawOutput(row.stageOutputs, invalid.callId) ?? '', { allowLeadingNarration: callProvider(invalid) === 'native_chat' }) : {}; } catch { /* Do not forward malformed untrusted text. */ }
    return { previous, ...(invalid?.errors ? { errors: invalid.errors } : {}) };
  }
  async function planPrompt(actor: OnboardingActor, row: AiJobDbRecord, call: AiCallRecord): Promise<AiPromptRequest> {
    if (call.stage === 'S') return supplementPrompt(actor, row, call);
    const records = await liveJobSources(actor, row);
    const usable = usableSectionIds(records);
    const sections = records.flatMap((source) => (source.sections ?? []).filter((section) => usable.has(section.id))
      .map((section) => ({ id: section.id, sourceId: source.sourceId, fileName: source.fileName, headingPath: section.headingPath, chars: section.text.length })));
    const input = { templateKind: row.templateKind ?? 'normal', inventory: row.stageOutputs.__inventory as FeatureInventory, sections, responsibilities: row.roleProfile?.responsibilities ?? [], range: planRange(row) } as const;
    if (!call.repairOf) return buildOutlinePlanPrompt(input);
    const { previous, errors } = previousPlanOutput(row, call);
    return buildOutlinePlanRepairPrompt({ ...input, previous, errors: errors ?? ['Invalid outline plan output'] });
  }
  /**
   * What one S call may see and return. New-file calls see only their batch of the new source
   * (full text); catalog calls see id, heading and a 300-character excerpt of the job's sections.
   */
  async function supplementCallContext(actor: OnboardingActor, row: AiJobDbRecord, call: AiCallRecord): Promise<{
    readonly input: SupplementPromptInput; readonly allowedSectionIds: ReadonlySet<string>; readonly moduleIds: ReadonlySet<string>;
  }> {
    const records = await liveJobSources(actor, row);
    const usable = usableSectionIds(records);
    const headings = new Map(records.flatMap((source) => (source.sections ?? []).map((section) => [section.id, section.headingPath.join(' > ')] as const)));
    const active = row.outline!.modules.filter((module) => !module.tombstoned).sort((a, b) => a.order - b.order);
    const modules = active.map((module) => ({
      moduleLocalId: module.moduleLocalId, order: module.order, title: module.title, description: module.description, objectives: module.objectives,
      ...(module.coverage === 'insufficient' && module.gapNote ? { gapNote: module.gapNote } : {}),
      sectionHeadings: module.sourceSectionIds.map((id) => headings.get(id)).filter((heading): heading is string => Boolean(heading)),
    }));
    const moduleIds = new Set(active.map((module) => module.moduleLocalId));
    const targetModuleLocalId = call.supplementModuleLocalId ?? '';
    if (call.supplementSourceId) {
      const request = row.stageOutputs['supplement:' + String(supplementRequest(call))] as SupplementRequest | undefined;
      const source = records.find((item) => item.sourceId === call.supplementSourceId);
      const batch = request?.batches?.[(call.supplementBatch ?? 1) - 1];
      if (!source || !batch) throw new AiJobServiceError('SOURCE_NOT_FOUND', 'The supplement source is no longer available.');
      const sections = batchSources([source], batch).flatMap((item) => item.sections ?? []).filter((section) => usable.has(section.id));
      return {
        input: { mode: 'new_file', targetModuleLocalId, modules, sections, batch: { index: call.supplementBatch ?? 1, total: request!.batches!.length } },
        allowedSectionIds: new Set(sections.map((section) => section.id)), moduleIds,
      };
    }
    const sections = records.flatMap((source) => (source.sections ?? []).filter((section) => usable.has(section.id))
      .map((section) => ({ id: section.id, headingPath: section.headingPath, excerpt: section.text.slice(0, SUPPLEMENT_EXCERPT_CHARS) })));
    return { input: { mode: 'catalog', targetModuleLocalId, modules, sections }, allowedSectionIds: new Set(sections.map((section) => section.id)), moduleIds };
  }
  async function supplementPrompt(actor: OnboardingActor, row: AiJobDbRecord, call: AiCallRecord): Promise<AiPromptRequest> {
    const { input } = await supplementCallContext(actor, row, call);
    if (!call.repairOf) return buildSupplementPrompt(input);
    const { previous, errors } = previousPlanOutput(row, call);
    return buildSupplementRepairPrompt({ ...input, previous, errors: errors ?? ['Invalid supplement output'] });
  }
  /** Planner retries mirror `retryCall`: one schema repair (`-r1`) and one transient retry (`-retryN`) per planner call. */
  function planRetryCall(row: AiJobDbRecord, call: AiCallRecord, kind: NonNullable<AiCallRecord['retryKind']>): AiCallRecord {
    const root = rootCall(call);
    const callId = kind === 'schema'
      ? root + '-r' + String(row.calls.filter((item) => item.repairOf === root && /-r\d+$/.test(item.callId)).length + 1)
      : root + '-retry' + String(row.calls.filter((item) => item.callId.startsWith(root + '-retry')).length + 1);
    return {
      callId, operationId: row.jobId + ':' + callId, stage: call.stage, status: 'pending', retryKind: kind,
      ...(call.planTarget ? { planTarget: call.planTarget } : {}),
      ...(call.supplementSourceId ? { supplementSourceId: call.supplementSourceId } : {}),
      ...(call.supplementModuleLocalId ? { supplementModuleLocalId: call.supplementModuleLocalId } : {}),
      ...(call.supplementBatch !== undefined ? { supplementBatch: call.supplementBatch } : {}),
      ...(kind === 'schema' ? { repairOf: root } : call.repairOf ? { repairOf: call.repairOf } : {}),
    };
  }
  /** A retry runs right after its failed call, ahead of later supplement batches. */
  function enqueuePlanRetry(calls: readonly AiCallRecord[], retry: AiCallRecord): AiCallRecord[] {
    const next = calls.findIndex((item) => item.status === 'pending' && !item.dispatchClaimedAt && !item.attemptRef);
    return next < 0 ? [...calls, retry] : [...calls.slice(0, next), retry, ...calls.slice(next)];
  }
  /** Each planner root call gets its own budget of one retry per kind. */
  function planRetryUsed(row: AiJobDbRecord, call: AiCallRecord, kind: NonNullable<AiCallRecord['retryKind']>): boolean {
    const root = rootCall(call);
    return row.calls.some((item) => isPlanCall(item) && rootCall(item) === root && item.retryKind === kind);
  }
  /** Out of retries: the plan keeps the deterministic outline; a supplement batch is skipped (applied on settle). */
  function planGiveUp(row: AiJobDbRecord, call: AiCallRecord): StoreRecord {
    return call.stage === 'P' ? { stageOutputs: { ...row.stageOutputs, __planFallback: true } } : {};
  }
  async function processSupplementOutput(actor: OnboardingActor, row: AiJobDbRecord, call: AiCallRecord): Promise<AiJobDbRecord> {
    const text = rawOutput(row.stageOutputs, call.callId) ?? '';
    let errors: readonly string[] = ['Outline is missing.'];
    let value: SupplementOutput | undefined;
    if (row.outline && row.moduleRuns) {
      try {
        const context = await supplementCallContext(actor, row, call);
        const result = validateSupplementOutput(parseAiJsonObject(text, { allowLeadingNarration: callProvider(call) === 'native_chat' }), context);
        if (result.ok) value = result.value;
        else errors = result.errors;
      } catch (error) {
        errors = validationMessages(error);
      }
    }
    const stageOutputs = { ...row.stageOutputs, ['processed:' + call.callId]: true, ...(value ? { ['result:' + rootCall(call)]: value } : {}) };
    if (value) return settleSupplements(actor, await updateJob(actor, row, { stageOutputs, ...CLEARED_WAIT, ...RELEASED_LEASE }));
    const calls = row.calls.map((item): AiCallRecord => item.callId === call.callId ? { ...item, status: 'invalid', errors: errors.slice(0, 30), rawExcerpt: text.slice(0, 50 * 1024) } : item);
    if (!planRetryUsed(row, call, 'schema')) return updateJob(actor, row, { calls: enqueuePlanRetry(calls, planRetryCall(row, call, 'schema')), stageOutputs, ...CLEARED_WAIT, ...RELEASED_LEASE });
    return settleSupplements(actor, await updateJob(actor, row, { calls, stageOutputs, ...CLEARED_WAIT, ...RELEASED_LEASE }));
  }
  async function settleSupplements(actor: OnboardingActor, initial: AiJobDbRecord): Promise<AiJobDbRecord> {
    let row = initial;
    for (const request of settledSupplements(row)) row = await applySupplement(actor, row, request);
    return row;
  }
  /**
   * Merges a settled request's batch results: the union of attachments, and per module the
   * coverage update of the last batch that mentions it. The server then downgrades any module
   * without usable sources. A skipped batch leaves the target insufficient with a retry note.
   */
  async function applySupplement(actor: OnboardingActor, row: AiJobDbRecord, requestNumber: number): Promise<AiJobDbRecord> {
    const request = row.stageOutputs['supplement:' + String(requestNumber)] as SupplementRequest | undefined;
    const stageOutputs = { ...row.stageOutputs, ['applied:supplement-' + String(requestNumber)]: true };
    const settledOnly = { stageOutputs, ...CLEARED_WAIT, ...RELEASED_LEASE };
    if (!row.outline || !row.moduleRuns || !request) return updateJob(actor, row, settledOnly);
    const roots = supplementRoots(row, requestNumber);
    const results = roots.map((call) => row.stageOutputs['result:' + call.callId] as SupplementOutput | undefined);
    const skipped = results.some((result) => !result);
    const failureNote = request.sourceId ? SUPPLEMENT_FAILED_NOTE : CATALOG_FAILED_NOTE;
    const usable = usableSectionIds(await liveJobSources(actor, row));
    const attached = new Map<string, string[]>();
    const updates = new Map<string, SupplementCoverageUpdate>();
    for (const result of results) {
      for (const attachment of result?.attachments ?? []) {
        const ids = attachment.sectionIds.filter((id) => usable.has(id));
        if (ids.length) attached.set(attachment.moduleLocalId, [...new Set([...(attached.get(attachment.moduleLocalId) ?? []), ...ids])]);
      }
      for (const update of result?.coverageUpdates ?? []) updates.set(update.moduleLocalId, update);
    }
    // The call saw other modules only as titles and headings, so it may change only the target
    // and modules it attached sections to; anything else in coverageUpdates is ignored.
    const touched = new Set([request.moduleLocalId, ...attached.keys()]);
    const edits = row.outline.modules.filter((module) => !module.tombstoned && touched.has(module.moduleLocalId)).map((module): OutlineEdit => {
      const extra = attached.get(module.moduleLocalId) ?? [];
      const sourceSectionIds = extra.length ? [...new Set([...module.sourceSectionIds.filter((id) => usable.has(id)), ...extra])] : module.sourceSectionIds;
      const update = updates.get(module.moduleLocalId);
      if (module.moduleLocalId !== request.moduleLocalId) {
        // A non-target module only gains sections: it may be upgraded to sufficient by them, never
        // downgraded, and its gapNote is never rewritten.
        const upgrade = update?.coverage === 'sufficient' && moduleHasUsableSources({ ...module, sourceSectionIds }, usable);
        return { type: 'update', moduleLocalId: module.moduleLocalId, patch: { sourceSectionIds, ...(upgrade ? { coverage: 'sufficient' as const } : {}) } };
      }
      let coverage = update?.coverage ?? module.coverage;
      let gapNote = update ? update.gapNote : module.gapNote;
      if (!moduleHasUsableSources({ ...module, sourceSectionIds }, usable)) coverage = 'insufficient';
      if (skipped) { coverage = 'insufficient'; gapNote = failureNote; }
      if (coverage === 'insufficient' && !gapNote) gapNote = GAP_NOTE;
      return { type: 'update', moduleLocalId: module.moduleLocalId, patch: { sourceSectionIds, ...(coverage ? { coverage } : {}), ...(gapNote !== undefined ? { gapNote } : {}) } };
    });
    const failedNote: OutlineEdit = { type: 'update', moduleLocalId: request.moduleLocalId, patch: { coverage: 'insufficient', gapNote: failureNote } };
    // A result the outline cannot take still settles: first the target's retry note, then nothing.
    for (const attempt of [edits, [failedNote]]) {
      try {
        return await applyOutlineEdits(actor, row, { edits: attempt, stageOutputs });
      } catch (error) {
        if (!(error instanceof AiJobServiceError)) throw error;
      }
    }
    return updateJob(actor, row, settledOnly);
  }
  async function processPlanOutput(actor: OnboardingActor, row: AiJobDbRecord, call: AiCallRecord): Promise<AiJobDbRecord> {
    if (call.stage === 'S') return processSupplementOutput(actor, row, call);
    const text = rawOutput(row.stageOutputs, call.callId) ?? '';
    let errors: readonly string[] = ['Outline is missing.'];
    let outline: TemplateOutline | undefined;
    if (row.outline && row.moduleRuns) {
      try {
        const result = validateOutlinePlanOutput(parseAiJsonObject(text, { allowLeadingNarration: callProvider(call) === 'native_chat' }), await planInput(actor, row));
        if (result.ok) outline = result.value;
        else errors = result.errors;
      } catch (error) {
        errors = validationMessages(error);
      }
    }
    const stageOutputs = { ...row.stageOutputs, ['processed:' + call.callId]: true };
    if (outline) return updateJob(actor, row, { outline, moduleRuns: reconcileModuleRuns(row.moduleRuns!, outline), stageOutputs, ...CLEARED_WAIT, ...RELEASED_LEASE });
    const calls = row.calls.map((item): AiCallRecord => item.callId === call.callId ? { ...item, status: 'invalid', errors: errors.slice(0, 30), rawExcerpt: text.slice(0, 50 * 1024) } : item);
    if (!planRetryUsed(row, call, 'schema')) return updateJob(actor, row, { calls: [...calls, planRetryCall(row, call, 'schema')], stageOutputs, ...CLEARED_WAIT, ...RELEASED_LEASE });
    return updateJob(actor, row, { calls, stageOutputs: { ...stageOutputs, __planFallback: true }, ...CLEARED_WAIT, ...RELEASED_LEASE });
  }
  /**
   * Settles planner work (the outline plan P and supplement S calls) before any admin gate:
   * processes a completed planner call, applies settled supplement requests, then dispatches
   * the next pending planner call in order. Returns a step only while planner work remains.
   */
  async function nextPlanStep(actor: OnboardingActor, initial: AiJobDbRecord, workerId: string): Promise<{ readonly row: AiJobDbRecord; readonly step?: AiJobNextStep }> {
    let row = initial;
    const completed = unprocessedPlanCall(row);
    if (completed) row = await processCompleted(actor, row, completed);
    // Normally applied while processing; this retries an apply whose write was lost.
    if (settledSupplements(row).length) row = await settleSupplements(actor, row);
    const call = row.calls.find((item) => isPlanCall(item) && (item.status === 'pending' || item.status === 'dispatched'));
    if (!call) return { row };
    const waiting = await providerWaitStep(actor, row);
    if (waiting) return { row, step: waiting };
    if (row.pumpLeaseUntil && Date.parse(row.pumpLeaseUntil) >= Date.parse(now()) && row.pumpedBy !== workerId) return { row, step: { kind: 'wait', job: jobFrom(row, actor.roomId) } };
    let request: AiPromptRequest;
    try { request = await promptFor(actor, row, call); }
    catch (error) {
      // Only an unbuildable planner prompt (too large, or invalid job input) gives up: the plan
      // keeps the deterministic outline, a supplement batch is skipped. Store and transport
      // failures are rethrown so the call can be retried.
      if (!(error instanceof PromptError) && !(error instanceof AiJobServiceError)) throw error;
      row = await updateJob(actor, row, {
        calls: row.calls.map((item): AiCallRecord => item.callId === call.callId ? { ...item, status: 'failed', errors: validationMessages(error), finishedAt: now(), ...(aiCallMayBeLive(item) ? { cleanupState: 'pending', cleanupUpdatedAt: now() } as const : {}) } : item),
        ...planGiveUp(row, call), ...CLEARED_WAIT, ...RELEASED_LEASE,
      });
      if (!aiCallMayBeLive(call)) await releaseCallLease(actor, row, call);
      // Later supplement batches still run; with none left this settles and returns the row.
      return nextPlanStep(actor, row, workerId);
    }
    return { row, step: await callStep(actor, row, call, workerId, request) };
  }
  async function nextModuleStep(actor: OnboardingActor, initial: AiJobDbRecord, workerId: string): Promise<AiJobNextStep> {
    let row = await syncModuleSources(actor, initial);
    const planned = await nextPlanStep(actor, row, workerId);
    if (planned.step) return planned.step;
    row = planned.row;
    if (row.outlineApprovedRevision !== row.outline!.revision) return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
    const completed = row.calls.find((call) => call.status === 'completed' && rawOutput(row.stageOutputs, call.callId) !== undefined && row.stageOutputs['processed:' + call.callId] !== true);
    if (completed) row = await processCompleted(actor, row, completed);
    if (row.autoApprove === true) return autopilotModuleStep(actor, row, workerId);
    // A pending, unclaimed question may have been queued while the room was
    // busy. Preserve it while approvals are renewed; never disturb a claim or
    // recorded attempt whose dispatch may already be live.
    const activeRuns = row.moduleRuns!.filter((run) => !run.outline.tombstoned);
    const queuedQuestion = row.calls.find((item) => item.status === 'pending' && item.moduleTarget === 'questions' && !item.attemptRef && !item.dispatchClaimedAt);
    const lessonsApproved = activeRuns.every(lessonApproved);
    const lessonWorkRemains = activeRuns.some((run) => ['queued', 'stale'].includes(run.lessonState));
    const otherActiveCall = row.calls.some((item) => item.callId !== queuedQuestion?.callId && (item.status === 'pending' || item.status === 'dispatched'));
    const deferredKey = queuedQuestion ? 'deferred-question:' + queuedQuestion.callId : '';
    if (queuedQuestion && !lessonsApproved && !otherActiveCall) {
      if (!lessonWorkRemains || row.stageOutputs[deferredKey] !== true) {
        if (lessonWorkRemains) row = await updateJob(actor, row, { stageOutputs: { ...row.stageOutputs, [deferredKey]: true } });
        return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
      }
    }
    const waiting = await providerWaitStep(actor, row);
    if (waiting) return waiting;
    if (row.pumpLeaseUntil && Date.parse(row.pumpLeaseUntil) >= Date.parse(now()) && row.pumpedBy !== workerId) return { kind: 'wait', job: jobFrom(row, actor.roomId) };
    let call = row.calls.find((item) => (item.status === 'pending' || item.status === 'dispatched') && !(queuedQuestion && !lessonsApproved && item.callId === queuedQuestion.callId));
    if (!call) {
      const active = row.moduleRuns!.filter((item) => !item.outline.tombstoned).sort((a, b) => a.outline.order - b.outline.order);
      const lessonWork = active.filter((run) => ['queued', 'stale'].includes(run.lessonState));
      const allLessonsApproved = active.every(lessonApproved);
      const questionReview = active.some((run) => ['review_ready', 'failed'].includes(run.questionState));
      const candidates = lessonWork.length ? lessonWork : allLessonsApproved && !questionReview ? active.filter((run) => run.questionState === 'queued') : [];
      for (const run of candidates) {
        const target = lessonWork.length ? 'lesson' : 'questions';
        const context = await moduleContext(actor, row, run);
        if (!context.usable) {
          if (target === 'questions' && run.lessonProvenance === 'manual' && run.outline.sourceSectionIds.length === 0) return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
          row = await updateJob(actor, row, { moduleRuns: replaceRun(row, await fallbackRun(actor, row, run)) });
          continue;
        }
        call = newModuleCall(row, run, target);
        const queuedIndex = queuedQuestion && !lessonsApproved ? row.calls.findIndex((item) => item.callId === queuedQuestion.callId) : -1;
        const calls = queuedIndex < 0 ? [...row.calls, call] : [...row.calls.slice(0, queuedIndex), call, ...row.calls.slice(queuedIndex)];
        row = await updateJob(actor, row, { calls, moduleRuns: replaceRun(row, draftingRun(run, target)) });
        break;
      }
    }
    return dispatchModuleCall(actor, row, workerId, call);
  }
  function newModuleCall(row: AiJobDbRecord, run: AiModuleDraftRun, target: 'lesson' | 'questions'): AiCallRecord {
    const callId = 'module-' + String(row.calls.length + 1);
    return { callId, stage: row.templateKind === 'advanced' ? 'C' : 'B', status: 'pending', operationId: row.jobId + ':' + callId, moduleLocalId: run.outline.moduleLocalId, moduleTarget: target, moduleVersion: target === 'lesson' ? run.lessonVersion : run.questionVersion, lessonVersion: run.lessonVersion, outlineRevision: row.outline!.revision };
  }
  function draftingRun(run: AiModuleDraftRun, target: 'lesson' | 'questions'): AiModuleDraftRun {
    return target === 'lesson' ? { ...run, lessonState: 'drafting', lessonAttempts: (run.lessonAttempts ?? 0) + 1 } : { ...run, questionState: 'drafting', questionAttempts: (run.questionAttempts ?? 0) + 1 };
  }
  /**
   * Autopilot approves every ready draft with the same checks as the Admin's approve actions.
   * Only `review_ready`/`fallback_review` lessons and `review_ready` questions qualify, so an
   * approved run is never approved (or audited) twice.
   */
  async function autoApproveRuns(actor: OnboardingActor, row: AiJobDbRecord): Promise<AiJobDbRecord> {
    const audits: StoreRecord[] = [];
    const runs: AiModuleDraftRun[] = [];
    for (const run of row.moduleRuns!) {
      let next = run;
      const lessonReady = !run.outline.tombstoned && !!run.lessonDraft && (run.lessonState === 'review_ready' || run.lessonState === 'fallback_review');
      const questionsReady = !run.outline.tombstoned && lessonApproved(run) && run.questionState === 'review_ready' && run.questionLessonVersion === run.lessonVersion;
      if (lessonReady || questionsReady) {
        const { input } = await moduleContext(actor, row, run);
        try {
          if (lessonReady && validApprovedLesson(run.lessonDraft!, input, run.lessonProvenance!)) {
            next = approveLesson(run, run.lessonVersion);
            const flags = next.lessonFlags ?? [];
            if (next.lessonProvenance === 'fallback' && !flags.some((flag) => flag.message === FALLBACK_LESSON_WARNING)) next = { ...next, lessonFlags: [...flags, fallbackLessonFlag(run.outline.moduleLocalId)] };
            audits.push(moduleAuditEntry(next, lessonAudit(next), AUTOPILOT_APPROVER));
          } else if (questionsReady) {
            const approved = approveQuestions(run, run.questionVersion);
            const validation = validateModuleQuestionOutput({ questions: approved.questionDraft, flags: approved.questionFlags ?? [] }, { ...input, lesson: run.lessonDraft!, lessonVersion: run.lessonVersion, lessonProvenance: run.lessonProvenance }, true);
            if (validation.ok) {
              next = approved;
              audits.push(moduleAuditEntry(next, questionAudit(next), AUTOPILOT_APPROVER));
            }
          }
        } catch (error) {
          // A draft that is not approvable stays for the Admin, exactly as the manual action would refuse it.
          if (!(error instanceof ModuleLifecycleError)) throw error;
        }
      }
      runs.push(next);
    }
    if (!audits.length) return row;
    const history = (row.stageOutputs.__moduleAudit ?? []) as readonly StoreRecord[];
    return updateJob(actor, row, { moduleRuns: runs, stageOutputs: { ...row.stageOutputs, __moduleAudit: [...history, ...audits] } });
  }
  /** An unfinished active module that cannot be grounded: `manual_required`, or a source was deleted. */
  async function autopilotLacksSources(actor: OnboardingActor, row: AiJobDbRecord): Promise<boolean> {
    for (const run of row.moduleRuns!) {
      if (run.outline.tombstoned || moduleRunComplete(run)) continue;
      if (run.lessonState === 'manual_required' || !(await moduleContext(actor, row, run)).usable) return true;
    }
    return false;
  }
  /**
   * Autopilot order: one call at a time, module by module in `order`; a module's questions are
   * queued as soon as its own lesson is approved. Failed questions are left for the client's
   * recovery (Native retry, then `use_question_fallback`), whose draft is approved on the next pass.
   */
  async function autopilotModuleStep(actor: OnboardingActor, initial: AiJobDbRecord, workerId: string): Promise<AiJobNextStep> {
    let row = await autoApproveRuns(actor, initial);
    const waiting = await providerWaitStep(actor, row);
    // A provider that stayed busy leaves a fallback lesson or failed questions; keep going.
    if (waiting?.kind === 'awaiting_admin') return nextModuleStep(actor, await requireOwnedJob(actor, row.jobId), workerId);
    if (waiting) return waiting;
    if (row.pumpLeaseUntil && Date.parse(row.pumpLeaseUntil) >= Date.parse(now()) && row.pumpedBy !== workerId) return { kind: 'wait', job: jobFrom(row, actor.roomId) };
    let call = row.calls.find((item) => item.status === 'pending' || item.status === 'dispatched');
    if (!call) {
      const active = row.moduleRuns!.filter((item) => !item.outline.tombstoned).sort((a, b) => a.outline.order - b.outline.order);
      if (active.some((run) => run.questionState === 'failed')) return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
      if (await autopilotLacksSources(actor, row)) {
        // Never draft a fallback from nothing: the Admin supplements or removes the module first.
        row = await updateJob(actor, row, { outlineApprovedRevision: 0, ...leaseAfterChanges(row.calls) });
        return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
      }
      for (const run of active) {
        const target = ['queued', 'stale'].includes(run.lessonState) ? 'lesson'
          : lessonApproved(run) && ['queued', 'stale'].includes(run.questionState) ? 'questions' : undefined;
        if (!target) continue;
        call = newModuleCall(row, run, target);
        row = await updateJob(actor, row, { calls: [...row.calls, call], moduleRuns: replaceRun(row, draftingRun(run, target)) });
        break;
      }
    }
    return dispatchModuleCall(actor, row, workerId, call);
  }
  /** With a call: build its prompt and dispatch it. Without one: materialize when complete, else await the Admin. */
  async function dispatchModuleCall(actor: OnboardingActor, initial: AiJobDbRecord, workerId: string, call: AiCallRecord | undefined): Promise<AiJobNextStep> {
    let row = initial;
    if (!call) {
      if (modulesComplete(row.moduleRuns!)) {
        if (row.status !== 'completed') row = await updateJob(actor, row, { status: 'completed', ...RELEASED_LEASE });
        const materialized = await materializeModuleTemplate(store, templates, actor, row.jobId);
        const result = { templateId: materialized.id, version: materialized.version };
        if (JSON.stringify(row.result) !== JSON.stringify(result)) row = await updateJob(actor, row, { result });
        return { kind: 'done', job: jobFrom(row, actor.roomId) };
      }
      return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
    }
    let request: AiPromptRequest;
    try { request = await promptFor(actor, row, call); }
    catch (error) {
      const run = moduleForCall(row, call);
      row = await updateJob(actor, row, { calls: row.calls.map((item) => item.callId === call!.callId ? { ...item, status: 'failed', errors: validationMessages(error) } : item), moduleRuns: replaceRun(row, call.moduleTarget === 'lesson' ? await fallbackRun(actor, row, run) : { ...run, questionState: 'failed' }), ...RELEASED_LEASE });
      return nextModuleStep(actor, row, workerId);
    }
    return callStep(actor, row, call, workerId, request);
  }

  return {
    async startJob(actor, input) {
      requireAdmin(actor);
      const operationId = required(input.operationId, 'Operation ID');
      const jobId = jobIdFor(actor.roomId, operationId);
      const requestHash = stableHash(input);
      const replay = await findJob(actor.roomId, jobId);
      if (replay) {
        if (replay.stageOutputs.__requestHash !== requestHash) {
          throw new AiJobServiceError(
            'OPERATION_CONFLICT',
            'The operation ID is already bound to another AI job request.',
          );
        }
        return jobFrom(replay, actor.roomId);
      }

      let data: AiJobDbData;
      const timestamp = now();
      if (input.kind === 'inventory') {
        const sourceIds = [
          ...new Set(input.sourceIds.map((sourceId) => required(sourceId, 'Source ID'))),
        ];
        if (sourceIds.length === 0 || sourceIds.length > AI_GENERATION_LIMITS.maxSourcesPerRoom) {
          throw new AiJobServiceError('SOURCE_NOT_FOUND', 'Select one to ten ready sources.');
        }
        const sources = await loadSources(actor.roomId, sourceIds);
        const batches = planBatches(sources);
        const calls = batches.map<AiCallRecord>((_batch, index) => {
          const callId = 'A' + String(index + 1);
          return {
            callId,
            stage: 'A',
            operationId: jobId + ':' + callId,
            status: 'pending',
          };
        });
        data = {
          pipelineVersion: 'module_v2',
          jobId,
          kind: 'inventory',
          status: 'running',
          sourceIds,
          promptVersion: PROMPT_VERSION,
          calls,
          stageOutputs: { __requestHash: requestHash, __plan: { batches } },
          operationId,
          createdBy: actor.userId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      } else {
        const inventoryJob = await requireJob(actor, input.inventoryJobId);
        if (
          inventoryJob.kind !== 'inventory'
          || inventoryJob.status !== 'completed'
          || !inventoryJob.result
        ) {
          throw new AiJobServiceError(
            'INVENTORY_REQUIRED',
            'A completed inventory job is required.',
          );
        }
        if (JSON.stringify(inventoryJob.result).length > AI_GENERATION_LIMITS.maxInventoryJsonChars) {
          throw new AiJobServiceError('INVENTORY_TOO_LARGE', 'Feature inventory is too large.');
        }
        if (
          input.templateKind === 'advanced'
          && (!input.roleProfile || validateRoleProfile(input.roleProfile).length > 0)
        ) {
          throw new AiJobServiceError('ROLE_PROFILE_INVALID', 'Advanced role profile is invalid.');
        }
        const outline = buildTemplateOutline({ jobId, templateKind: input.templateKind, inventory: inventoryJob.result as FeatureInventory, responsibilities: input.roleProfile?.responsibilities ?? [] });
        data = {
          pipelineVersion: 'module_v2', outline, moduleRuns: createModuleRuns(outline), autoApprove: true,
          jobId,
          kind: 'template',
          status: 'running',
          templateKind: input.templateKind,
          ...(input.roleProfile ? { roleProfile: { responsibilities: input.roleProfile.responsibilities } } : {}),
          ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          sourceIds: inventoryJob.sourceIds,
          inventoryJobId: inventoryJob.jobId,
          promptVersion: PROMPT_VERSION,
          // The deterministic outline is revision 1; the AI plan call may replace it before review.
          calls: [{ callId: 'plan-1', stage: 'P', planTarget: 'plan', status: 'pending', operationId: jobId + ':plan-1' }],
          stageOutputs: {
            __requestHash: requestHash,
            __inventory: inventoryJob.result,
          },
          operationId,
          createdBy: actor.userId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      }

      try {
        const row = await store.create<AiJobDbRecord>(
          actor.roomId,
          'onboarding_ai_jobs',
          data,
          operationId,
        );
        return jobFrom(row, actor.roomId);
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
        const raced = await findJob(actor.roomId, jobId);
        if (raced && raced.stageOutputs.__requestHash === requestHash) {
          return jobFrom(raced, actor.roomId);
        }
        throw new AiJobServiceError(
          'OPERATION_CONFLICT',
          'The AI job request conflicts with an existing job.',
        );
      }
    },

    async updateOutline(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      assertPlanSettled(row);
      assertOutlineRevision(row, input.expectedRevision);
      if (!Array.isArray(input.edits) || input.edits.some((edit) => !edit || !['add', 'delete', 'reorder', 'update'].includes(edit.type))) throw new AiJobServiceError('OPERATION_CONFLICT', 'Outline edit type is invalid.');
      let outline: TemplateOutline;
      try {
        outline = applyTemplateOutlineEdits(row.outline!, input.edits, (frame) => 'outline-' + stableHash([row.jobId, row.outline!.revision + 1, frame]));
      } catch {
        throw new AiJobServiceError('OPERATION_CONFLICT', 'Outline edits are invalid.');
      }
      validateOutline(row, outline);
      const runs = reconcileModuleRuns(row.moduleRuns!, outline).map((run): AiModuleDraftRun => ({ ...run, ...(run.lessonState === 'drafting' ? { lessonState: 'queued' } : {}), ...(run.questionState === 'drafting' ? { questionState: 'queued' } : {}) }));
      return jobFrom(await updateJob(actor, row, { outline, outlineApprovedRevision: 0, moduleRuns: runs, calls: obsoleteCalls(row, new Set(row.moduleRuns!.map((run) => run.outline.moduleLocalId))), status: 'running', result: null, ...RELEASED_LEASE, ...CLEARED_WAIT }), actor.roomId);
    },
    async listModuleSources(actor, jobId) {
      await requireModuleJob(actor, jobId);
      const all: SourceRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.query<SourceDbRecord>(actor.roomId, 'onboarding_sources', { limit: 100, ...(cursor ? { cursor } : {}) });
        all.push(...page.records.map((record) => sourceFrom(record, actor.roomId)).filter((source) => source.status === 'ready' && !source.deletedAt));
        cursor = page.nextCursor;
      } while (cursor);
      const usable = usableSectionIds(all);
      return all.map((source) => ({ sourceId: source.sourceId, fileName: source.fileName, sections: (source.sections ?? []).filter((section) => section.text.trim()).map(({ id, headingPath }) => ({ id, headingPath, usable: usable.has(id) })) }));
    },
    async supplementModuleSources(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      assertPlanSettled(row);
      assertOutlineRevision(row, input.expectedRevision);
      const run = row.moduleRuns!.find((item) => !item.outline.tombstoned && item.outline.moduleLocalId === input.moduleLocalId);
      if (!run || row.calls.some(aiCallMayBeLive)) throw new AiJobServiceError('OPERATION_CONFLICT', 'Module is unavailable or an AI call is still active.');
      if (!Array.isArray(input.sourceIds) || !input.sourceIds.length || new Set(input.sourceIds).size !== input.sourceIds.length || !Array.isArray(input.sectionIds) || !input.sectionIds.length || new Set(input.sectionIds).size !== input.sectionIds.length) throw new AiJobServiceError('OPERATION_CONFLICT', 'Select unique sources and sections.');
      const sources = await loadSources(actor.roomId, input.sourceIds);
      const sections = sources.flatMap((source) => source.sections ?? []);
      if (input.sectionIds.some((id) => typeof id !== 'string' || sections.filter((section) => section.id === id && section.text.trim()).length !== 1)) throw new AiJobServiceError('SOURCE_NOT_FOUND', 'Selected sections must belong to selected room sources.');
      const sourceIds = [...new Set([...(row.sourceIds ?? []), ...input.sourceIds])];
      if (sourceIds.length > AI_GENERATION_LIMITS.maxSourcesPerRoom) throw new AiJobServiceError('SOURCE_NOT_FOUND', 'Too many selected sources.');
      const authorized = await Promise.all(sourceIds.map((id) => sourceById(actor.roomId, id)));
      const usableSections = authorized.filter((source): source is SourceRecord => !!source && source.status === 'ready' && !source.deletedAt).flatMap((source) => source.sections ?? []);
      const retained = run.outline.sourceSectionIds.filter((id) => usableSections.filter((section) => section.id === id && section.text.trim()).length === 1);
      // The Admin picked these sections, so the module counts as sufficient and its gap note is stale.
      return jobFrom(await applyOutlineEdits(actor, row, {
        sourceIds,
        edits: [{ type: 'update', moduleLocalId: input.moduleLocalId, patch: { sourceSectionIds: [...new Set([...retained, ...input.sectionIds])], coverage: 'sufficient', gapNote: '' } }],
      }), actor.roomId);
    },
    async supplementModuleDocument(actor, input) {
      const row = await requireOutlineEdit(actor, input);
      const module = requireActiveModule(row, input.moduleLocalId);
      const sourceId = required(typeof input.sourceId === 'string' ? input.sourceId : '', 'Source ID');
      // A source already in the job may only be re-read to retry the batches its last request skipped.
      const known = (row.sourceIds ?? []).includes(sourceId);
      const retryBatches = known ? skippedSupplementBatches(row, sourceId) : [];
      if (known && !retryBatches.length) throw new AiJobServiceError('OPERATION_CONFLICT', 'Tài liệu này đã có trong lộ trình. Hãy dùng "Chọn đoạn từ tài liệu đã có".');
      const sourceIds = known ? row.sourceIds! : [...(row.sourceIds ?? []), sourceId];
      if (sourceIds.length > AI_GENERATION_LIMITS.maxSourcesPerRoom) throw new AiJobServiceError('SOURCE_NOT_FOUND', 'Too many selected sources.');
      // Room-scoped lookup: a source from another room, or one not ready, is not found.
      const [source] = await loadSources(actor.roomId, [sourceId]);
      const batches = planBatches([source]);
      const request = nextSupplementNumber(row);
      // Batch numbers stay those of the file, so a retried batch reads the same sections.
      const batchNumbers = known ? retryBatches.filter((batch) => batch <= batches.length) : batches.map((_batch, index) => index + 1);
      if (!batchNumbers.length) throw new AiJobServiceError('OPERATION_CONFLICT', 'Tài liệu này đã có trong lộ trình. Hãy dùng "Chọn đoạn từ tài liệu đã có".');
      const supplementCalls = batchNumbers.map((batch) => supplementCall(row, request, batch, module.moduleLocalId, sourceId));
      // Queued module work is superseded so the S calls are the job's current calls.
      const calls = [...obsoleteCalls(row, new Set(row.moduleRuns!.map((item) => item.outline.moduleLocalId))), ...supplementCalls];
      const supplement: SupplementRequest = { moduleLocalId: module.moduleLocalId, sourceId, batches };
      return jobFrom(await updateJob(actor, row, {
        sourceIds, calls, moduleRuns: row.moduleRuns!.map(requeueDrafting), outlineApprovedRevision: 0, status: 'running', result: null,
        stageOutputs: { ...row.stageOutputs, ['supplement:' + String(request)]: supplement },
      }), actor.roomId);
    },
    async addOutlineModule(actor, input) {
      const row = await requireOutlineEdit(actor, input);
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      if (!title || title.length > 80 || description.length > 500) throw new AiJobServiceError('OPERATION_CONFLICT', 'Tên module cần từ 1 đến 80 ký tự, mô tả tối đa 500 ký tự.');
      const active = row.outline!.modules.filter((module) => !module.tombstoned);
      const frames: readonly string[] = row.templateKind === 'advanced' ? ADVANCED_FRAMES : NORMAL_FRAMES;
      const frameKey = frames.find((frame) => !active.some((module) => module.frameKey === frame));
      if (active.length >= planRange(row).max || !frameKey) throw new AiJobServiceError('OPERATION_CONFLICT', 'Lộ trình đã có số module tối đa.');
      const newId = (frame: string) => 'outline-' + stableHash([row.jobId, row.outline!.revision + 1, frame]);
      const moduleLocalId = newId(frameKey);
      const request = nextSupplementNumber(row);
      // With no usable section in the job there is nothing for AI to pick.
      const hasCatalog = usableSectionIds(await liveJobSources(actor, row)).size > 0;
      const supplement: SupplementRequest = { moduleLocalId };
      return jobFrom(await applyOutlineEdits(actor, row, {
        newId,
        edits: [{ type: 'add', module: { order: active.length, frameKey, title, description, estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [], coverage: 'insufficient', gapNote: GAP_NOTE } }],
        ...(hasCatalog ? { extraCalls: [supplementCall(row, request, 1, moduleLocalId)], stageOutputs: { ...row.stageOutputs, ['supplement:' + String(request)]: supplement } } : {}),
      }), actor.roomId);
    },
    async setCoverageOverride(actor, input) {
      const row = await requireOutlineEdit(actor, input);
      const module = requireActiveModule(row, input.moduleLocalId);
      if (typeof input.override !== 'boolean') throw new AiJobServiceError('OPERATION_CONFLICT', 'override must be a boolean.');
      if (input.override && !moduleHasUsableSources(module, usableSectionIds(await liveJobSources(actor, row)))) {
        throw new AiJobServiceError('COVERAGE_INCOMPLETE', 'Module chưa có đoạn tài liệu dùng được.');
      }
      return jobFrom(await applyOutlineEdits(actor, row, {
        edits: [{ type: 'update', moduleLocalId: module.moduleLocalId, patch: { coverageOverride: input.override } }],
      }), actor.roomId);
    },
    async approveOutline(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      assertPlanSettled(row);
      assertOutlineRevision(row, input.expectedRevision);
      // Autopilot writes every module without stopping, so each one must be groundable up front.
      if (row.autoApprove === true && !outlineReadiness(row.outline!, usableSectionIds(await liveJobSources(actor, row)), { templateKind: row.templateKind ?? 'normal', responsibilities: row.roleProfile?.responsibilities ?? [] }).ready) {
        throw new AiJobServiceError('COVERAGE_INCOMPLETE', 'Còn module chưa đủ tài liệu.');
      }
      validateOutline(row, row.outline!);
      const history = (row.stageOutputs.__outlineAudit ?? []) as readonly unknown[];
      return jobFrom(await updateJob(actor, row, { outlineApprovedRevision: input.expectedRevision, stageOutputs: { ...row.stageOutputs, __outlineAudit: [...history, { outline: row.outline, approvedBy: actor.userId, approvedAt: now() }] } }), actor.roomId);
    },
    async updateModuleLesson(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      const run = requireRun(row, input.moduleLocalId);
      const context = await moduleContext(actor, row, run);
      if (!validApprovedLesson(input.module, context.input, 'manual')) throw new AiJobServiceError('AI_OUTPUT_INVALID', 'Manual lesson is invalid or ungrounded.');
      return saveRun(actor, row, updateLesson(run, input.expectedVersion, input.module, 'manual'));
    },
    async approveModuleLesson(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      const run = requireRun(row, input.moduleLocalId);
      const next = approveLesson(run, input.expectedVersion);
      if (!validApprovedLesson(next.lessonDraft!, (await moduleContext(actor, row, run)).input, next.lessonProvenance!)) throw new AiJobServiceError('AI_OUTPUT_INVALID', 'Lesson is invalid or ungrounded.');
      return saveRun(actor, row, next, lessonAudit(next));
    },
    async useSourceFallback(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      const run = requireRun(row, input.moduleLocalId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== run.lessonVersion || !['review_ready', 'approved', 'fallback_review', 'failed', 'manual_required', 'queued', 'stale'].includes(run.lessonState) || run.questionState === 'drafting') throw new AiJobServiceError('OPERATION_CONFLICT', 'Lesson version conflict or an active call prevents fallback.');
      return saveRun(actor, row, await fallbackRun(actor, row, run));
    },
    async useQuestionFallback(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      const run = requireRun(row, input.moduleLocalId);
      if (!lessonApproved(run) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== run.questionVersion || run.questionState === 'drafting') {
        throw new AiJobServiceError('OPERATION_CONFLICT', 'Question version conflict or an active call prevents fallback.');
      }
      const fallback = buildFallbackQuestions({ lesson: run.lessonDraft! });
      if (fallback.kind !== 'draft') throw new AiJobServiceError('AI_OUTPUT_INVALID', 'Grounded lesson content is required for question fallback.');
      const validation = validateModuleQuestionOutput({ questions: fallback.questions, flags: [] }, {
        ...(await moduleContext(actor, row, run)).input,
        lesson: run.lessonDraft!, lessonVersion: run.lessonVersion, lessonProvenance: run.lessonProvenance,
      });
      if (!validation.ok) throw new AiJobServiceError('AI_OUTPUT_INVALID', 'Fallback questions are invalid or ungrounded.');
      return saveRun(actor, row, updateQuestions(run, input.expectedVersion, validation.value.questions, 'fallback'));
    },
    async updateModuleQuestions(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      const run = requireRun(row, input.moduleLocalId);
      const next = updateQuestions(run, input.expectedVersion, input.questions, 'manual');
      const validation = validateModuleQuestionOutput({ questions: input.questions, flags: [] }, { ...(await moduleContext(actor, row, run)).input, lesson: run.lessonDraft!, lessonVersion: run.lessonVersion, lessonProvenance: run.lessonProvenance }, true);
      if (!validation.ok) throw new AiJobServiceError('AI_OUTPUT_INVALID', 'Questions are invalid or ungrounded.');
      return saveRun(actor, row, next);
    },
    async approveModuleQuestions(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      const run = requireRun(row, input.moduleLocalId);
      const next = approveQuestions(run, input.expectedVersion);
      const validation = validateModuleQuestionOutput({ questions: next.questionDraft, flags: next.questionFlags ?? [] }, { ...(await moduleContext(actor, row, run)).input, lesson: run.lessonDraft!, lessonVersion: run.lessonVersion, lessonProvenance: run.lessonProvenance }, true);
      if (!validation.ok) throw new AiJobServiceError('AI_OUTPUT_INVALID', 'Questions are invalid or ungrounded.');
      return saveRun(actor, row, next, questionAudit(next));
    },
    async retryModule(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      if (input.target !== 'lesson' && input.target !== 'questions') throw new AiJobServiceError('OPERATION_CONFLICT', 'Retry target is invalid.');
      const run = requireRun(row, input.moduleLocalId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== (input.target === 'lesson' ? run.lessonVersion : run.questionVersion)) throw new AiJobServiceError('OPERATION_CONFLICT', 'Module version conflict.');
      return saveRun(actor, row, retryModuleRun(run, input.target));
    },
    async pauseAutopilot(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      if (row.status !== 'running') throw new AiJobServiceError('JOB_NOT_RUNNING', 'Chỉ tạm dừng được job đang chạy.');
      if (!row.outlineApprovedRevision) return jobFrom(row, actor.roomId);
      const timestamp = now();
      // Like obsoleteCalls: a call that may be live keeps its room lease until cleanup is proven.
      // A completed output not yet processed is kept and applied after the outline is re-approved.
      const calls = row.calls.map((call): AiCallRecord => call.moduleLocalId && (call.status === 'pending' || call.status === 'dispatched')
        ? { ...call, status: 'failed', errors: [PAUSED_ERROR], ...(aiCallMayBeLive(call) ? { cleanupState: 'pending', cleanupUpdatedAt: timestamp } as const : {}) }
        : call);
      const updated = await updateJob(actor, row, { outlineApprovedRevision: 0, calls, moduleRuns: row.moduleRuns!.map(requeueDrafting), ...RELEASED_LEASE, ...CLEARED_WAIT });
      for (const call of calls) if (!aiCallMayBeLive(call)) await releaseCallLease(actor, row, call);
      return jobFrom(updated, actor.roomId);
    },
    async enableAutopilot(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      if (row.autoApprove === true) return jobFrom(row, actor.roomId);
      return jobFrom(await updateJob(actor, row, { autoApprove: true }), actor.roomId);
    },

    async getJob(actor, jobId) {
      requireAdmin(actor);
      return jobFrom(await requireJob(actor, jobId), actor.roomId);
    },

    async listJobs(actor) {
      requireAdmin(actor);
      const jobs: AiJobRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.query<AiJobDbRecord>(actor.roomId, 'onboarding_ai_jobs', {
          orderBy: [{ field: 'createdAt', direction: 'desc' }],
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        jobs.push(...page.records.map((row) => jobFrom(row, actor.roomId)));
        cursor = page.nextCursor;
      } while (cursor);
      return jobs;
    },

    async nextStep(actor, input) {
      requireAdmin(actor);
      const workerId = required(input.workerId, 'Worker ID');
      return stepSourceCache.run(new Map(), async () => { try {
        let row = await requireOwnedJob(actor, input.jobId);
        if (row.pipelineVersion === 'module_v2' && row.kind === 'template' && !['cancelled', 'failed'].includes(row.status)) {
          if (await completedModuleTemplateCurrent(actor, row)) return { kind: 'done', job: jobFrom(row, actor.roomId) };
          return await nextModuleStep(actor, row, workerId);
        }
        if (row.status === 'completed' || row.status === 'cancelled') {
          return { kind: 'done', job: jobFrom(row, actor.roomId) };
        }
        if (row.status === 'failed') {
          return { kind: 'failed', job: jobFrom(row, actor.roomId) };
        }
        const waiting = await providerWaitStep(actor, row);
        if (waiting) return waiting;

        const completed = [...row.calls].reverse().find((call) =>
          call.status === 'completed'
          && rawOutput(row.stageOutputs, call.callId) !== undefined
          && row.stageOutputs['processed:' + call.callId] !== true);
        if (completed) row = await processCompleted(actor, row, completed);
        if (row.status === 'completed') {
          return { kind: 'done', job: jobFrom(row, actor.roomId) };
        }
        if (row.status === 'failed') {
          return { kind: 'failed', job: jobFrom(row, actor.roomId) };
        }

        const activeLease = row.pumpLeaseUntil
          && Date.parse(row.pumpLeaseUntil) >= Date.parse(now());
        if (activeLease && row.pumpedBy !== workerId) {
          return { kind: 'wait', job: jobFrom(row, actor.roomId) };
        }
        const call = row.calls.find((candidate) =>
          candidate.status === 'pending' || candidate.status === 'dispatched');
        if (!call) {
          throw new AiJobServiceError('JOB_NOT_RUNNING', 'The AI job has no pending server-owned step.');
        }
        const request = await promptFor(actor, row, call);
        return await callStep(actor, row, call, workerId, request);
      } catch (error) {
        if (!isAiLeaseConflict(error)) throw error;
        return { kind: 'wait', job: jobFrom(await requireOwnedJob(actor, input.jobId), actor.roomId) };
      } });
    },

    async recordDispatch(actor, input) {
      requireAdmin(actor);
      const row = await requireOwnedJob(actor, input.jobId);
      const recordedCall = row.calls.find((candidate) => candidate.callId === input.callId);
      if (row.status === 'cancelled' || recordedCall?.dispatchUnknown || (recordedCall?.status === 'failed' && recordedCall.cleanupState === 'pending')) {
        // The dispatch raced a cancel: keep the reference so the live attempt can still be stopped.
        const late = row.calls.find((candidate) => candidate.callId === input.callId);
        const attemptRef = required(input.attemptRef, 'Attempt reference');
        if (!late || (late.attemptRef && late.attemptRef !== attemptRef)
          || (!['pending', 'dispatched'].includes(late.status) && !late.dispatchUnknown && late.cleanupState !== 'pending')) {
          throw new AiJobServiceError('JOB_CALL_MISMATCH', 'The AI call is not awaiting a dispatch.');
        }
        if (late.leaseHolderId !== input.workerId) throw new AiJobServiceError('JOB_LEASE_LOST', 'The dispatch claim belongs to another holder.');
        await assertRoomLease(actor, row, late.callId, input.workerId);
        if (late.attemptRef) return jobFrom(row, actor.roomId);
        const timestamp = now();
        return jobFrom(await updateJob(actor, row, {
          calls: row.calls.map((candidate) => candidate.callId === late.callId ? {
            ...candidate,
            status: row.status === 'cancelled' ? 'dispatched' as const : 'failed' as const,
            attemptRef,
            provider: input.provider,
            startedAt: candidate.startedAt ?? timestamp,
            cleanupState: 'pending' as const,
            cleanupUpdatedAt: timestamp,
          } : candidate),
        }), actor.roomId);
      }
      if (row.status !== 'running') {
        throw new AiJobServiceError('JOB_NOT_RUNNING', 'The AI job is not running.');
      }
      if (!(recordedCall?.leaseHolderId === input.workerId && recordedCall.dispatchClaimedAt) && !leaseOwned(row, input.workerId)) {
        throw new AiJobServiceError(
          'JOB_LEASE_LOST',
          'This browser tab no longer owns the AI job lease.',
        );
      }
      const call = row.calls.find((candidate) => candidate.callId === input.callId);
      const current = row.calls.find((candidate) =>
        candidate.status === 'pending' || candidate.status === 'dispatched');
      if (
        !call
        || current?.callId !== call.callId
        || !['pending', 'dispatched'].includes(call.status)
      ) {
        throw new AiJobServiceError(
          'JOB_CALL_MISMATCH',
          'The AI call is not the current pending step.',
        );
      }
      const attemptRef = required(input.attemptRef, 'Attempt reference');
      if (call.attemptRef && call.attemptRef !== attemptRef) {
        throw new AiJobServiceError(
          'JOB_CALL_MISMATCH',
          'The AI call already has a different attempt.',
        );
      }
      if (call.provider && call.provider !== input.provider) {
        throw new AiJobServiceError(
          'JOB_CALL_MISMATCH',
          'The AI call already belongs to a different provider.',
        );
      }
      await assertRoomLease(actor, row, call.callId, input.workerId);
      // Sizes come from the server-owned prompt; the browser never reports them.
      const request = await promptFor(actor, row, call);
      const calls = row.calls.map((candidate) => candidate.callId === call.callId ? {
        ...candidate,
        status: 'dispatched' as const,
        attemptRef,
        provider: input.provider,
        promptChars: request.prompt.length,
        systemContextChars: request.systemContext.length,
        startedAt: candidate.startedAt ?? now(),
      } : candidate);
      return jobFrom(await updateJob(actor, row, { calls }), actor.roomId);
    },

    async submitAiOutput(actor, input) {
      requireAdmin(actor);
      let row = await requireOwnedJob(actor, input.jobId);
      if (row.status !== 'running') {
        throw new AiJobServiceError('JOB_NOT_RUNNING', 'The AI job is not running.');
      }
      if (!leaseOwned(row, input.workerId)) {
        throw new AiJobServiceError(
          'JOB_LEASE_LOST',
          'This browser tab no longer owns the AI job lease.',
        );
      }
      const current = row.calls.find((candidate) =>
        candidate.status === 'pending' || candidate.status === 'dispatched');
      if (!current || current.callId !== input.callId) {
        throw new AiJobServiceError(
          'JOB_CALL_MISMATCH',
          'The AI output does not match the pending call.',
        );
      }
      await assertRoomLease(actor, row, current.callId, input.workerId);
      const calls = row.calls.map((candidate) => candidate.callId === current.callId ? {
        ...candidate,
        status: 'completed' as const,
        ...(candidate.attemptRef ? { cleanupState: 'confirmed' as const, cleanupUpdatedAt: now() } : {}),
        startedAt: candidate.startedAt ?? now(),
        finishedAt: now(),
      } : candidate);
      if (row.pipelineVersion === 'module_v2' && row.kind === 'template' && !isPlanCall(current)) moduleForCall(row, current);
      row = await updateJob(actor, row, {
        calls,
        ...CLEARED_WAIT,
        stageOutputs: {
          ...row.stageOutputs,
          ['raw:' + current.callId]: input.text,
        },
      });
      row = await processCompleted(
        actor,
        row,
        row.calls.find((candidate) => candidate.callId === current.callId) as AiCallRecord,
      );
      return jobFrom(row, actor.roomId);
    },

    async reportAiFailure(actor, input) {
      requireAdmin(actor);
      const row = await requireOwnedJob(actor, input.jobId);
      if (input.providerErrorCode === 'DISPATCH_NOT_STARTED' && !input.provider) {
        const call = row.calls.find((item) => item.callId === input.callId);
        if (!call || call.leaseHolderId !== input.workerId || !call.dispatchClaimedAt) throw new AiJobServiceError('JOB_LEASE_LOST', 'The dispatch claim belongs to another holder.');
        if (call.attemptRef || call.dispatchUnknown) throw new AiJobServiceError('JOB_CALL_MISMATCH', 'A started or uncertain attempt cannot be abandoned.');
        const alreadyRecorded = call.providerErrorCode === 'DISPATCH_NOT_STARTED' && call.cleanupState === 'confirmed';
        if (!alreadyRecorded) await assertRoomLease(actor, row, call.callId, input.workerId);
        const evidenced = alreadyRecorded ? row : await updateJob(actor, row, {
          calls: row.calls.map((item) => item.callId === call.callId ? { ...item, providerErrorCode: 'DISPATCH_NOT_STARTED', cleanupState: 'confirmed' as const, cleanupUpdatedAt: now() } : item),
          ...RELEASED_LEASE,
        });
        if (!await releaseCallLease(actor, evidenced, call)) throw new AiJobServiceError('OPERATION_CONFLICT', 'Room lease release conflicted; retry reconciliation.');
        const calls = evidenced.calls.map((item) => {
          if (item.callId !== call.callId) return item;
          const { dispatchClaimedAt: _claim, leaseHolderId: _holder, cleanupState: _cleanup, cleanupUpdatedAt: _cleanupAt, providerErrorCode: _code, ...rest } = item;
          return rest;
        });
        return jobFrom(await updateJob(actor, evidenced, { calls }), actor.roomId);
      }
      if (row.status !== 'running') {
        throw new AiJobServiceError('JOB_NOT_RUNNING', 'The AI job is not running.');
      }
      const current = row.calls.find((candidate) =>
        candidate.status === 'pending' || candidate.status === 'dispatched');
      if (!current || current.callId !== input.callId) {
        throw new AiJobServiceError(
          'JOB_CALL_MISMATCH',
          'The failed call is not the current call.',
        );
      }
      if (input.provider && current.provider && current.provider !== input.provider) {
        throw new AiJobServiceError(
          'JOB_CALL_MISMATCH',
          'The failed AI call already belongs to a different provider.',
        );
      }
      // A delayed definitive rejection still belongs to this unresolved claim.
      // Clock expiry alone cannot discard that evidence or authorize another reporter.
      const matchingBusyClaim = input.kind === 'failed' && input.providerErrorCode === 'PROJECT_BUSY'
        && current.leaseHolderId === input.workerId && Boolean(current.dispatchClaimedAt);
      if (!matchingBusyClaim && !leaseOwned(row, input.workerId)) {
        throw new AiJobServiceError('JOB_LEASE_LOST', 'This browser tab no longer owns the AI job lease.');
      }
      const code = input.kind === 'dispatch_unknown'
        ? 'AI_DISPATCH_UNKNOWN'
        : input.kind === 'timeout' ? 'AI_TIMEOUT' : 'AI_FAILED';
      const message = sanitizeAiDiagnosticText(input.message) ?? code;
      const providerErrorCode = sanitizeAiDiagnosticText(input.providerErrorCode);
      const providerPhase = sanitizeAiDiagnosticText(input.providerPhase);
      const diagnosticError = sanitizeAiDiagnosticText(input.diagnosticError);
      await assertRoomLease(actor, row, current.callId, input.workerId);
      const calls = row.calls.map((candidate) => candidate.callId === current.callId ? {
        ...candidate,
        status: 'failed' as const,
        ...(input.provider ? { provider: input.provider } : {}),
        errors: [message],
        ...(providerErrorCode ? { providerErrorCode } : {}),
        ...(providerPhase ? { providerPhase } : {}),
        ...(diagnosticError ? { diagnosticError } : {}),
        finishedAt: now(),
        // After a timeout the provider may still be running; prove it stopped before reuse.
        ...(input.kind === 'dispatch_unknown' ? { dispatchUnknown: true, cleanupState: 'pending' as const, cleanupUpdatedAt: now() }
          : input.kind === 'timeout' && candidate.attemptRef ? { cleanupState: 'pending' as const, cleanupUpdatedAt: now() }
            : candidate.attemptRef ? { cleanupState: 'confirmed' as const, cleanupUpdatedAt: now() } : {}),
      } : candidate);
      const isBusy = providerErrorCode === 'PROJECT_BUSY';
      const waitStartedAt = row.providerWaitStartedAt && Date.parse(row.providerWaitStartedAt) > 0 ? row.providerWaitStartedAt : now();
      const canWait = isBusy && Date.parse(now()) - Date.parse(waitStartedAt) < MAX_PROVIDER_WAIT_MS;
      const busyCount = (row.providerWaitAttempts ?? 0) + 1;
      const nextRetryAt = new Date(Math.min(Date.parse(waitStartedAt) + MAX_PROVIDER_WAIT_MS, Date.parse(now()) + Math.min(30_000, PROVIDER_RETRY_MS * (2 ** Math.min(busyCount - 1, 4))))).toISOString();
      if (row.pipelineVersion === 'module_v2' && row.kind === 'template' && isPlanCall(current)) {
        const transient = !isBusy && input.kind === 'failed' && !planRetryUsed(row, current, 'transient') && TRANSIENT_PROVIDER_ERROR.test(providerErrorCode ?? '');
        const retry = canWait ? planRetryCall(row, current, 'project_busy') : transient ? planRetryCall(row, current, 'transient') : undefined;
        let updated = await updateJob(actor, row, {
          calls: retry ? enqueuePlanRetry(calls, retry) : calls, ...RELEASED_LEASE,
          ...(canWait ? { providerWaitStartedAt: waitStartedAt, nextRetryAt, providerWaitAttempts: busyCount } : { ...CLEARED_WAIT, ...(transient ? { nextRetryAt: new Date(Date.parse(now()) + PROVIDER_RETRY_MS).toISOString() } : {}) }),
          // Out of retries: keep the deterministic outline (P) or skip the supplement batch (S).
          ...(retry ? {} : planGiveUp(row, current)),
        });
        if (!aiCallMayBeLive(calls.find((call) => call.callId === current.callId)!)) await releaseCallLease(actor, row, current);
        if (!retry && current.stage === 'S') updated = await settleSupplements(actor, updated);
        return jobFrom(updated, actor.roomId);
      }
      if (row.pipelineVersion === 'module_v2' && row.kind === 'template') {
        const run = moduleForCall(row, current);
        const transient = !isBusy && input.kind === 'failed' && (run.transientRetries ?? 0) < 1
          && TRANSIENT_PROVIDER_ERROR.test(providerErrorCode ?? '');
        const next = canWait ? { ...run, providerWaitStartedAt: waitStartedAt, nextRetryAt }
          : transient ? { ...clearRunWait(run), transientRetries: (run.transientRetries ?? 0) + 1, nextRetryAt: new Date(Date.parse(now()) + PROVIDER_RETRY_MS).toISOString() }
            : current.moduleTarget === 'lesson' ? await fallbackRun(actor, row, run) : { ...clearRunWait(run), questionState: 'failed' as const };
        const updated = await updateJob(actor, row, {
          calls: canWait || transient ? enqueueModuleSuccessor(calls, retryCall(row, current, canWait ? 'project_busy' : 'transient')) : calls,
          moduleRuns: replaceRun(row, next), ...RELEASED_LEASE,
          ...(canWait ? { providerWaitStartedAt: waitStartedAt, nextRetryAt, providerWaitAttempts: busyCount } : { ...CLEARED_WAIT, ...(transient ? { nextRetryAt: next.nextRetryAt } : {}) }),
        });
        if (!aiCallMayBeLive(calls.find((call) => call.callId === current.callId)!)) await releaseCallLease(actor, row, current);
        return jobFrom(updated, actor.roomId);
      }
      const updated = await updateJob(actor, row, {
        calls: canWait ? [...calls, retryCall(row, current, 'project_busy')] : calls,
        status: canWait ? 'running' : 'failed',
        errorCode: code,
        errorMessage: message,
        ...RELEASED_LEASE,
        ...(canWait ? { providerWaitStartedAt: waitStartedAt, nextRetryAt, providerWaitAttempts: busyCount } : CLEARED_WAIT),
      });
      if (!aiCallMayBeLive(calls.find((call) => call.callId === current.callId)!)) await releaseCallLease(actor, row, current);
      return jobFrom(updated, actor.roomId);
    },

    async retryJob(actor, jobId) {
      requireAdmin(actor);
      const row = await requireOwnedJob(actor, jobId);
      if (row.status !== 'failed') {
        throw new AiJobServiceError('JOB_NOT_RUNNING', 'Only failed jobs can be retried.');
      }
      const failed = [...row.calls].reverse().find((call) =>
        call.status === 'failed' || call.status === 'invalid');
      if (!failed) {
        throw new AiJobServiceError(
          'JOB_CALL_MISMATCH',
          'No failed AI call is available to retry.',
        );
      }
      if (failed.stage === 'D') {
        const batches = row.stageOutputs.__verificationBatches as
          | readonly (readonly VerificationClaim[])[]
          | undefined;
        const replanned = batches ? claimBatches(batches.flat()) : [];
        if (batches && replanned.length > batches.length) {
          const usedNumbers = row.calls
            .map((call) => /^D(\d+)$/.exec(call.callId)?.[1])
            .filter((value): value is string => Boolean(value))
            .map(Number);
          const firstNumber = Math.max(0, ...usedNumbers) + 1;
          const indexes: Record<string, number> = {};
          const calls = replanned.map<AiCallRecord>((_batch, index) => {
            const callId = 'D' + String(firstNumber + index);
            indexes[callId] = index;
            return {
              callId,
              stage: 'D',
              operationId: row.jobId + ':' + callId,
              status: 'pending',
            };
          });
          return jobFrom(await updateJob(actor, row, {
            calls: [...row.calls.filter((call) => call.stage !== 'D'), ...calls],
            stageOutputs: {
              ...row.stageOutputs,
              __verificationBatches: replanned,
              __verificationCallBatchIndexes: indexes,
              __verificationAttemptHistory: row.calls.filter((call) => call.stage === 'D'),
            },
            status: 'running',
            ...CLEARED_ERROR,
            ...RELEASED_LEASE,
          }), actor.roomId);
        }
      }
      const root = rootCall(failed);
      const retryCount = row.calls.filter((call) =>
        call.callId.startsWith(root + '-retry')).length + 1;
      const callId = root + '-retry' + String(retryCount);
      const retry: AiCallRecord = {
        callId,
        stage: failed.stage,
        repairOf: root,
        operationId: row.jobId + ':' + callId,
        status: 'pending',
      };
      const calls = [...row.calls];
      const nextPendingIndex = calls.findIndex((call) =>
        call.status === 'pending' || call.status === 'dispatched');
      calls.splice(nextPendingIndex < 0 ? calls.length : nextPendingIndex, 0, retry);
      return jobFrom(await updateJob(actor, row, {
        calls,
        status: 'running',
        ...CLEARED_ERROR,
      }), actor.roomId);
    },

    async cancelJob(actor, jobId) {
      requireAdmin(actor);
      const row = await requireOwnedJob(actor, jobId);
      if (row.status === 'completed') {
        throw new AiJobServiceError(
          'JOB_NOT_RUNNING',
          'A completed AI job cannot be cancelled.',
        );
      }
      if (row.status === 'cancelled') {
        for (const call of row.calls) if (!aiCallMayBeLive(call)) await releaseCallLease(actor, row, call);
        return jobFrom(row, actor.roomId);
      }
      const timestamp = now();
      // A cancelled server job says nothing about the provider; each live attempt awaits proof.
      const calls = row.calls.map((call) => aiCallMayBeLive(call)
        ? { ...call, cleanupState: 'pending' as const, cleanupUpdatedAt: timestamp }
        : call);
      const updated = await updateJob(actor, row, {
        calls,
        status: 'cancelled',
        ...RELEASED_LEASE,
        ...CLEARED_WAIT,
      });
      for (const call of calls) if (!aiCallMayBeLive(call)) await releaseCallLease(actor, row, call);
      return jobFrom(updated, actor.roomId);
    },

    async recordAttemptCleanup(actor, input) {
      requireAdmin(actor);
      const row = await requireOwnedJob(actor, input.jobId);
      const call = row.calls.find((candidate) => candidate.callId === input.callId);
      if (!call || !call.attemptRef || call.attemptRef !== input.attemptRef) {
        throw new AiJobServiceError(
          'JOB_CALL_MISMATCH',
          'The cleanup report does not match the recorded AI attempt.',
        );
      }
      // Confirmed is terminal evidence; a later or repeated report cannot weaken it.
      if (call.cleanupState === 'confirmed') {
        await releaseCallLease(actor, row, call);
        return jobFrom(row, actor.roomId);
      }
      const message = input.state === 'unknown'
        ? (input.message?.trim() || 'Provider termination was not confirmed.')
          .slice(0, MAX_CLEANUP_MESSAGE_CHARS)
        : undefined;
      if (call.cleanupState === input.state && call.cleanupMessage === message) {
        return jobFrom(row, actor.roomId);
      }
      const calls = row.calls.map((candidate) => {
        if (candidate.callId !== call.callId) return candidate;
        const { cleanupMessage: _previous, ...rest } = candidate;
        return {
          ...rest,
          cleanupState: input.state,
          ...(message ? { cleanupMessage: message } : {}),
          cleanupUpdatedAt: now(),
        };
      });
      const updated = await updateJob(actor, row, { calls });
      if (input.state === 'confirmed') await releaseCallLease(actor, row, call);
      return jobFrom(updated, actor.roomId);
    },
  };
}

export type { GeneratedTemplate };
