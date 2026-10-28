import { createHash } from 'node:crypto';

import type { OnboardingActor } from '../auth';
import type {
  AiCallRecord,
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
} from './inventory';
import { AI_GENERATION_LIMITS } from './limits';
import { sanitizeAiDiagnosticText } from './diagnostics';
import { materializeAiTemplate } from './materialize';
import { parseAiJsonObject } from './parse';
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
  | { readonly kind: 'done'; readonly job: AiJobRecord }
  | { readonly kind: 'failed'; readonly job: AiJobRecord };

export interface AiJobService {
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

interface AiJobDbData extends StoreRecord {
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
      { ...data, updatedAt: now() },
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
    return row.kind === 'inventory'
      ? processInventory(actor, row, call)
      : processTemplate(actor, row, call);
  }

  function leaseOwned(row: AiJobDbRecord, workerId: string): boolean {
    return row.pumpedBy === workerId
      && Boolean(row.pumpLeaseUntil)
      && Date.parse(row.pumpLeaseUntil as string) >= Date.parse(now());
  }

  async function refreshLease(
    actor: OnboardingActor,
    row: AiJobDbRecord,
    workerId: string,
  ): Promise<AiJobDbRecord> {
    const leaseUntil = new Date(Date.parse(now()) + AI_GENERATION_LIMITS.pumpLeaseMs).toISOString();
    return updateJob(actor, row, { pumpedBy: workerId, pumpLeaseUntil: leaseUntil });
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
        const prefix = input.templateKind === 'advanced' ? 'C' : 'B';
        const callId = prefix + '-lessons';
        data = {
          jobId,
          kind: 'template',
          status: 'running',
          templateKind: input.templateKind,
          ...(input.roleProfile ? { roleProfile: input.roleProfile } : {}),
          ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          sourceIds: inventoryJob.sourceIds,
          inventoryJobId: inventoryJob.jobId,
          promptVersion: PROMPT_VERSION,
          calls: [{
            callId,
            stage: input.templateKind === 'advanced' ? 'C' : 'B',
            operationId: jobId + ':' + callId,
            status: 'pending',
          }],
          stageOutputs: {
            __requestHash: requestHash,
            __inventory: inventoryJob.result,
            __repairMode: MODULE_REPAIR_MODE,
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
      let row = await requireOwnedJob(actor, input.jobId);
      if (row.status === 'completed' || row.status === 'cancelled') {
        return { kind: 'done', job: jobFrom(row, actor.roomId) };
      }
      if (row.status === 'failed') {
        return { kind: 'failed', job: jobFrom(row, actor.roomId) };
      }

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
      row = await refreshLease(actor, row, workerId);
      const call = row.calls.find((candidate) =>
        candidate.status === 'pending' || candidate.status === 'dispatched');
      if (!call) {
        throw new AiJobServiceError(
          'JOB_NOT_RUNNING',
          'The AI job has no pending server-owned step.',
        );
      }
      const request = await promptFor(actor, row, call);
      return {
        kind: 'ai_call',
        callId: call.callId,
        operationId: call.operationId,
        prompt: request.prompt,
        ...(request.systemContext ? { systemContext: request.systemContext } : {}),
        ...(call.attemptRef ? { attemptRef: call.attemptRef } : {}),
        ...(call.attemptRef && callProvider(call) ? { provider: callProvider(call) } : {}),
        ...(call.attemptRef && call.startedAt ? { startedAt: call.startedAt } : {}),
      };
    },

    async recordDispatch(actor, input) {
      requireAdmin(actor);
      const row = await requireOwnedJob(actor, input.jobId);
      if (row.status === 'cancelled') {
        // The dispatch raced a cancel: keep the reference so the live attempt can still be stopped.
        const late = row.calls.find((candidate) => candidate.callId === input.callId);
        const attemptRef = required(input.attemptRef, 'Attempt reference');
        if (!late || (late.attemptRef && late.attemptRef !== attemptRef)
          || !['pending', 'dispatched'].includes(late.status)) {
          throw new AiJobServiceError('JOB_CALL_MISMATCH', 'The AI call is not awaiting a dispatch.');
        }
        if (late.attemptRef) return jobFrom(row, actor.roomId);
        const timestamp = now();
        return jobFrom(await updateJob(actor, row, {
          calls: row.calls.map((candidate) => candidate.callId === late.callId ? {
            ...candidate,
            status: 'dispatched' as const,
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
      if (!leaseOwned(row, input.workerId)) {
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
      const calls = row.calls.map((candidate) => candidate.callId === current.callId ? {
        ...candidate,
        status: 'completed' as const,
        startedAt: candidate.startedAt ?? now(),
        finishedAt: now(),
      } : candidate);
      row = await updateJob(actor, row, {
        calls,
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
          'The failed call is not the current call.',
        );
      }
      const code = input.kind === 'dispatch_unknown'
        ? 'AI_DISPATCH_UNKNOWN'
        : input.kind === 'timeout' ? 'AI_TIMEOUT' : 'AI_FAILED';
      const message = sanitizeAiDiagnosticText(input.message) ?? code;
      const providerErrorCode = sanitizeAiDiagnosticText(input.providerErrorCode);
      const providerPhase = sanitizeAiDiagnosticText(input.providerPhase);
      const diagnosticError = sanitizeAiDiagnosticText(input.diagnosticError);
      const calls = row.calls.map((candidate) => candidate.callId === current.callId ? {
        ...candidate,
        status: 'failed' as const,
        errors: [message],
        ...(providerErrorCode ? { providerErrorCode } : {}),
        ...(providerPhase ? { providerPhase } : {}),
        ...(diagnosticError ? { diagnosticError } : {}),
        finishedAt: now(),
        // After a timeout the provider may still be running; prove it stopped before reuse.
        ...(input.kind === 'timeout' && candidate.attemptRef
          ? { cleanupState: 'pending' as const, cleanupUpdatedAt: now() }
          : {}),
      } : candidate);
      return jobFrom(await updateJob(actor, row, {
        calls,
        status: 'failed',
        errorCode: code,
        errorMessage: message,
        ...RELEASED_LEASE,
      }), actor.roomId);
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
      const calls = row.calls.map((call) => call.status === 'dispatched' && call.attemptRef
        ? { ...call, cleanupState: 'pending' as const, cleanupUpdatedAt: timestamp }
        : call);
      return jobFrom(await updateJob(actor, row, {
        calls,
        status: 'cancelled',
        ...RELEASED_LEASE,
      }), actor.roomId);
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
      if (call.cleanupState === 'confirmed') return jobFrom(row, actor.roomId);
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
      return jobFrom(await updateJob(actor, row, { calls }), actor.roomId);
    },
  };
}

export type { GeneratedTemplate };
