import { validateAdminOutline } from './outline-validation';
import { createHash } from 'node:crypto';

import type { OnboardingActor } from '../auth';
import type {
  AiCallRecord,
  AiModuleDraftRun,
  AiPipelineVersion,
  OutlineEdit,
  TemplateOutline,
  AiJobRecord,
  AiProvider,
  EmployeeType,
  RoleProfile,
  SourceRecord,
  SourceSection,
} from '../contracts';
import type { OnboardingStore, StoreRecord } from '../store';
import { createTemplateService } from '../templates';
import { groundSourceRef, normalizeForMatch, type RawSourceRef } from './grounding';
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
import { buildTemplateOutline, applyTemplateOutlineEdits } from './outline';
import { buildFallbackLesson } from './fallback-lessons';
import { buildModuleLessonPrompt, buildModuleQuestionPrompt, validateModuleLessonOutput, validateModuleQuestionOutput, validApprovedLesson, type ModuleLessonPromptInput } from './module-draft';
import { createModuleRuns, reconcileModuleRuns, invalidateModule, updateLesson, approveLesson, updateQuestions, approveQuestions, retryModuleRun, lessonApproved, modulesComplete } from './module-lifecycle';
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
  type AiPromptRequest,
} from './prompts';
import {
  removeQuestionsBlockedByFlags,
  validateGeneratedTemplate,
  type GeneratedTemplate,
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
  }
  | { readonly kind: 'wait'; readonly job: AiJobRecord }
  | { readonly kind: 'awaiting_admin'; readonly job: AiJobRecord }
  | { readonly kind: 'done'; readonly job: AiJobRecord }
  | { readonly kind: 'failed'; readonly job: AiJobRecord };

export interface AiJobService {
  updateOutline(actor: OnboardingActor, input: OutlineVersionInput & { readonly edits: readonly OutlineEdit[] }): Promise<AiJobRecord>;
  approveOutline(actor: OnboardingActor, input: OutlineVersionInput): Promise<AiJobRecord>;
  updateModuleLesson(actor: OnboardingActor, input: ModuleVersionInput & { readonly module: GeneratedModule }): Promise<AiJobRecord>;
  approveModuleLesson(actor: OnboardingActor, input: ModuleVersionInput): Promise<AiJobRecord>;
  updateModuleQuestions(actor: OnboardingActor, input: ModuleVersionInput & { readonly questions: readonly GeneratedQuestion[] }): Promise<AiJobRecord>;
  approveModuleQuestions(actor: OnboardingActor, input: ModuleVersionInput): Promise<AiJobRecord>;
  retryModule(actor: OnboardingActor, input: ModuleInput & { readonly target: 'lesson' | 'questions'; readonly expectedVersion: number }): Promise<AiJobRecord>;
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
    const sections = sources.flatMap((source) => source.sections ?? []);
    const totalBytes = Buffer.byteLength(sections.map((section) => section.text).join('\n'), 'utf8');
    if (totalBytes > AI_GENERATION_LIMITS.maxJobTextBytes) {
      throw new AiJobServiceError('SOURCE_TOO_LARGE', 'Selected source text exceeds the job limit.');
    }
    const batches: string[][] = [];
    let current: string[] = [];
    let currentSize = 0;
    for (const section of sections) {
      const estimatedSize = section.text.length + section.id.length + 500;
      if (
        current.length > 0
        && currentSize + estimatedSize > AI_GENERATION_LIMITS.maxSystemContextChars - 1_000
      ) {
        batches.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(section.id);
      currentSize += estimatedSize;
    }
    if (current.length > 0) batches.push(current);
    if (batches.length === 0) {
      throw new AiJobServiceError('SOURCE_NOT_FOUND', 'Selected sources contain no extracted sections.');
    }
    return batches;
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

  function batchSources(
    sources: readonly SourceRecord[],
    sectionIds: readonly string[],
  ): readonly SourceRecord[] {
    const selected = new Set(sectionIds);
    return sources.map((source) => ({
      ...source,
      sections: source.sections?.filter((section) => selected.has(section.id)) ?? [],
    })).filter((source) => (source.sections?.length ?? 0) > 0);
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
      const run = moduleForCall(job, call);
      const input = (await moduleContext(actor, job, run)).input;
      const base = call.moduleTarget === 'questions'
        ? buildModuleQuestionPrompt({ ...input, lesson: run.lessonDraft!, lessonVersion: run.lessonVersion, lessonProvenance: run.lessonProvenance })
        : buildModuleLessonPrompt(input);
      if (!call.repairOf) return base;
      const invalid = job.calls.find((item) => item.callId === call.repairOf);
      return buildRepairPrompt(rawOutput(job.stageOutputs, call.repairOf) ?? '', invalid?.errors ?? ['Invalid module output'], base.systemContext, base.prompt);
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
    if (row.kind === 'template' && row.pipelineVersion === 'module_v2') return processModuleOutput(actor, row, call);
    return row.kind === 'inventory'
      ? processInventory(actor, row, call)
      : processTemplate(actor, row, call);
  }

  function leaseOwned(row: AiJobDbRecord, workerId: string): boolean {
    return row.pumpedBy === workerId
      && Boolean(row.pumpLeaseUntil)
      && Date.parse(row.pumpLeaseUntil as string) >= Date.parse(now());
  }

  async function releaseCallLease(actor: OnboardingActor, row: AiJobDbRecord, call: AiCallRecord): Promise<void> {
    const holderId = call.leaseHolderId ?? row.pumpedBy;
    if (holderId) await releaseRoomAiLease(store, actor, { jobId: row.jobId, callId: call.callId, holderId, now: now() });
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
    return { kind: 'ai_call', callId: call.callId, operationId: call.operationId, ...request, ...(call.attemptRef ? { attemptRef: call.attemptRef, provider: callProvider(call), startedAt: call.startedAt } : {}) };
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
    const usable = ids.length > 0 && ids.every((id) => id.trim()) && new Set(ids).size === ids.length && matches.every((items) => items.length === 1 && items[0].section.text.trim().length >= AI_GENERATION_LIMITS.minQuoteChars && /[\p{L}\p{N}]/u.test(normalizeForMatch(items[0].section.text)));
    const sections = usable ? matches.map((items) => items[0].section) : [];
    const inventory = row.stageOutputs.__inventory as FeatureInventory;
    return { input: { module: run.outline, sections, features: inventory.features, responsibilities: row.roleProfile?.responsibilities ?? [], templateKind: row.templateKind ?? 'normal' }, fingerprint: stableHash(matches), usable };
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
  async function saveRun(actor: OnboardingActor, row: AiJobDbRecord, run: AiModuleDraftRun, audit?: StoreRecord): Promise<AiJobRecord> {
    const history = (row.stageOutputs.__moduleAudit ?? []) as readonly StoreRecord[];
    const calls = obsoleteCalls(row, new Set([run.outline.moduleLocalId]));
    return jobFrom(await updateJob(actor, row, { moduleRuns: replaceRun(row, run), calls, status: 'running', result: null,
      ...(audit ? { stageOutputs: { ...row.stageOutputs, __moduleAudit: [...history, { ...audit, moduleLocalId: run.outline.moduleLocalId, outlineRevision: run.outlineRevision, sourceFingerprint: run.sourceFingerprint, approvedBy: actor.userId, approvedAt: now() }] } } : {}), ...leaseAfterChanges(calls) }), actor.roomId);
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
        next = { ...updateQuestions(run, run.questionVersion, validated.value.questions), questionFlags: validated.value.flags };
      }
    } catch (error) {
      errors = validationMessages(error);
      next = call.moduleTarget === 'lesson' ? await fallbackRun(actor, row, run) : { ...run, questionState: 'failed' };
    }
    const calls = row.calls.map((item): AiCallRecord => item.callId === call.callId ? { ...item, status: errors.length ? 'invalid' : 'completed', ...(errors.length ? { errors } : {}) } : item);
    if (errors.length && (run.schemaRepairs ?? 0) < 1) {
      next = { ...clearRunWait(run), schemaRepairs: (run.schemaRepairs ?? 0) + 1 };
      calls.push(retryCall(row, call, 'schema'));
    }
    return updateJob(actor, row, { moduleRuns: replaceRun(row, clearRunWait(next)), calls, stageOutputs: { ...row.stageOutputs, ['processed:' + call.callId]: true }, ...CLEARED_WAIT, ...RELEASED_LEASE });
  }
  async function nextModuleStep(actor: OnboardingActor, initial: AiJobDbRecord, workerId: string): Promise<AiJobNextStep> {
    let row = await syncModuleSources(actor, initial);
    if (row.outlineApprovedRevision !== row.outline!.revision) return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
    const completed = row.calls.find((call) => call.status === 'completed' && rawOutput(row.stageOutputs, call.callId) !== undefined && row.stageOutputs['processed:' + call.callId] !== true);
    if (completed) row = await processCompleted(actor, row, completed);
    const waiting = await providerWaitStep(actor, row);
    if (waiting) return waiting;
    if (row.pumpLeaseUntil && Date.parse(row.pumpLeaseUntil) >= Date.parse(now()) && row.pumpedBy !== workerId) return { kind: 'wait', job: jobFrom(row, actor.roomId) };
    let call = row.calls.find((item) => item.status === 'pending' || item.status === 'dispatched');
    const reviewRequired = row.moduleRuns!.some((run) => !run.outline.tombstoned
      && (['review_ready', 'fallback_review', 'manual_required', 'failed'].includes(run.lessonState)
        || ['review_ready', 'failed'].includes(run.questionState)));
    if (reviewRequired && !call?.attemptRef && !call?.dispatchClaimedAt) return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
    if (!call) {
      for (const run of row.moduleRuns!.filter((item) => !item.outline.tombstoned).sort((a, b) => a.outline.order - b.outline.order)) {
        const target = ['queued', 'stale'].includes(run.lessonState) ? 'lesson' : lessonApproved(run) && run.questionState === 'queued' ? 'questions' : undefined;
        if (!target) continue;
        const context = await moduleContext(actor, row, run);
        if (!context.usable) {
          if (target === 'questions' && run.lessonProvenance === 'manual' && run.outline.sourceSectionIds.length === 0) return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
          row = await updateJob(actor, row, { moduleRuns: replaceRun(row, await fallbackRun(actor, row, run)) });
          return { kind: 'awaiting_admin', job: jobFrom(row, actor.roomId) };
        }
        const callId = 'module-' + String(row.calls.length + 1);
        call = { callId, stage: row.templateKind === 'advanced' ? 'C' : 'B', status: 'pending', operationId: row.jobId + ':' + callId, moduleLocalId: run.outline.moduleLocalId, moduleTarget: target, moduleVersion: target === 'lesson' ? run.lessonVersion : run.questionVersion, lessonVersion: run.lessonVersion, outlineRevision: row.outline!.revision };
        const next: AiModuleDraftRun = target === 'lesson' ? { ...run, lessonState: 'drafting', lessonAttempts: (run.lessonAttempts ?? 0) + 1 } : { ...run, questionState: 'drafting', questionAttempts: (run.questionAttempts ?? 0) + 1 };
        row = await updateJob(actor, row, { calls: [...row.calls, call], moduleRuns: replaceRun(row, next) });
        break;
      }
    }
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
          pipelineVersion: 'module_v2', outline, moduleRuns: createModuleRuns(outline),
          jobId,
          kind: 'template',
          status: 'running',
          templateKind: input.templateKind,
          ...(input.roleProfile ? { roleProfile: { responsibilities: input.roleProfile.responsibilities } } : {}),
          ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          sourceIds: inventoryJob.sourceIds,
          inventoryJobId: inventoryJob.jobId,
          promptVersion: PROMPT_VERSION,
          calls: [],
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
      assertOutlineRevision(row, input.expectedRevision);
      if (!Array.isArray(input.edits) || input.edits.some((edit) => !edit || !['add', 'delete', 'reorder', 'update'].includes(edit.type))) throw new AiJobServiceError('OPERATION_CONFLICT', 'Outline edit type is invalid.');
      const outline = applyTemplateOutlineEdits(row.outline!, input.edits, (frame) => 'outline-' + stableHash([row.jobId, row.outline!.revision + 1, frame]));
      validateOutline(row, outline);
      const runs = reconcileModuleRuns(row.moduleRuns!, outline).map((run): AiModuleDraftRun => ({ ...run, ...(run.lessonState === 'drafting' ? { lessonState: 'queued' } : {}), ...(run.questionState === 'drafting' ? { questionState: 'queued' } : {}) }));
      return jobFrom(await updateJob(actor, row, { outline, outlineApprovedRevision: 0, moduleRuns: runs, calls: obsoleteCalls(row, new Set(row.moduleRuns!.map((run) => run.outline.moduleLocalId))), status: 'running', result: null, ...RELEASED_LEASE, ...CLEARED_WAIT }), actor.roomId);
    },
    async approveOutline(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      assertOutlineRevision(row, input.expectedRevision);
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
      return saveRun(actor, row, next, { target: 'lesson', version: next.lessonVersion, module: next.lessonDraft, provenance: next.lessonProvenance, flags: next.lessonFlags ?? [] });
    },
    async updateModuleQuestions(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      const run = requireRun(row, input.moduleLocalId);
      const next = updateQuestions(run, input.expectedVersion, input.questions);
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
      return saveRun(actor, row, next, { target: 'questions', version: next.questionVersion, lessonVersion: next.lessonVersion, questions: next.questionDraft, flags: next.questionFlags ?? [] });
    },
    async retryModule(actor, input) {
      const row = await requireModuleJob(actor, input.jobId);
      if (input.target !== 'lesson' && input.target !== 'questions') throw new AiJobServiceError('OPERATION_CONFLICT', 'Retry target is invalid.');
      const run = requireRun(row, input.moduleLocalId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== (input.target === 'lesson' ? run.lessonVersion : run.questionVersion)) throw new AiJobServiceError('OPERATION_CONFLICT', 'Module version conflict.');
      return saveRun(actor, row, retryModuleRun(run, input.target));
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
      try {
        let row = await requireOwnedJob(actor, input.jobId);
        if (row.pipelineVersion === 'module_v2' && row.kind === 'template' && !['cancelled', 'failed'].includes(row.status)) return await nextModuleStep(actor, row, workerId);
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
      }
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
      if (row.pipelineVersion === 'module_v2' && row.kind === 'template') moduleForCall(row, current);
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
      if (input.providerErrorCode === 'DISPATCH_NOT_STARTED') {
        const call = row.calls.find((item) => item.callId === input.callId);
        if (!call || call.leaseHolderId !== input.workerId) throw new AiJobServiceError('JOB_LEASE_LOST', 'The dispatch claim belongs to another holder.');
        if (call.attemptRef || call.dispatchUnknown) throw new AiJobServiceError('JOB_CALL_MISMATCH', 'A started or uncertain attempt cannot be abandoned.');
        await assertRoomLease(actor, row, call.callId, input.workerId);
        const calls = row.calls.map((item) => {
          if (item.callId !== call.callId) return item;
          const { dispatchClaimedAt: _claim, leaseHolderId: _holder, cleanupState: _cleanup, cleanupUpdatedAt: _cleanupAt, ...rest } = item;
          return rest;
        });
        const updated = await updateJob(actor, row, { calls, ...RELEASED_LEASE });
        await releaseCallLease(actor, row, call);
        return jobFrom(updated, actor.roomId);
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
      if (row.pipelineVersion === 'module_v2' && row.kind === 'template') {
        const run = moduleForCall(row, current);
        const transient = !isBusy && input.kind === 'failed' && (run.transientRetries ?? 0) < 1
          && /(?:TRANSIENT|UNAVAILABLE|OVERLOADED|RATE_LIMIT|SERVER_ERROR)/.test(providerErrorCode ?? '');
        const next = canWait ? { ...run, providerWaitStartedAt: waitStartedAt, nextRetryAt }
          : transient ? { ...clearRunWait(run), transientRetries: (run.transientRetries ?? 0) + 1, nextRetryAt: new Date(Date.parse(now()) + PROVIDER_RETRY_MS).toISOString() }
            : current.moduleTarget === 'lesson' ? await fallbackRun(actor, row, run) : { ...clearRunWait(run), questionState: 'failed' as const };
        const updated = await updateJob(actor, row, {
          calls: canWait || transient ? [...calls, retryCall(row, current, canWait ? 'project_busy' : 'transient')] : calls,
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
      if (row.status === 'cancelled') return jobFrom(row, actor.roomId);
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
