import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  RedoOutlined,
  RobotOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePrivosApp, usePrivosContext, type McpApp } from '@privos_ai/app-react';

import type {
  AiCallRecord,
  AiJobRecord,
  AiPublicationBatch,
  AiProvider,
  EmployeeType,
  TemplateResource,
  VerificationFlag,
} from '../../../onboarding/contracts';
import type { SourceSummary } from '../../../onboarding/ai/sources';
import type { AiReviewOperation } from '../../../onboarding/ai/review';
import type { AdminTemplateDetail } from '../../../onboarding/templates';
import { AI_GENERATION_LIMITS } from '../../../onboarding/ai/limits';
import { resolveHostCapability, type OnboardingApi } from '../api';
import { ConfirmDialog, InlineNotice, type InlineNoticeMessage } from '../components';
import {
  ensureOnboardingRoomfiles,
  ensureTemplateRoomfilesFolder,
  normalizeUploadedRoomFile,
  templateJsonArtifact,
} from '../roomfiles';
import { cancelAndConfirmAttempt, observeAttemptTermination, type AiCancellationOutcome } from './ai-attempt-lifecycle';
import { createSandboxAiGateway, type AiGateway } from './ai-gateway-sandbox';
import {
  createNativeChatAiGateway,
  isNativeChatAttempt,
} from './ai-gateway-native-chat';
import { actionableProviderFailure, errorCode, vietnameseErrorMessage } from './ai-labels';
import {
  AI_PUMP_STALLED,
  failedJobError,
  isTransportFailure,
  jobChangeApplied,
  pumpAiJob,
  reconcileJobAfterTransportFailure,
  withTransientRetry,
  type JobChange,
} from './ai-pump';
import { pumpWithInventoryRecovery } from './inventory-recovery';
import {
  choosePumpProvider,
  pumpWithQuestionRecovery,
  shouldBoundNativeQuestionPoll,
} from './question-recovery';
import { AiReview } from './ai-review';
import { AiStepSources } from './ai-step-sources';
import {
  collectAiGeneratorResetTemplateRefs,
  loadAiGeneratorResetReviews,
  resetAiGeneratorServerState,
} from './ai-generator-reset';
import { AiCoverageSkeleton, AiStepCoverage, type ModuleSourceCatalog } from './ai-step-coverage';
import { outlineReadiness } from '../../../onboarding/ai/outline-coverage';
import { AiStepGenerating } from './ai-step-generating';
import { AiStepReview } from './ai-step-review';
import type { GeneratedModule, GeneratedQuestion } from '../../../onboarding/ai/validate';
import {
  AiPublishBatchError,
  aiPublishTargetKey,
  publishAiTemplateBatch,
  restoreAiPublishTarget,
  type AiPublishBatchDependencies,
  type AiPublishTarget,
} from './ai-publish-batch';
import { createLessonPdfArtifact } from './lesson-pdf';
import {
  AiTemplateGenerationError,
  aiReviewReadiness,
  generateValidatedTemplateRuns,
  mergeTemplateRunJobs,
  selectResumableTemplateRuns,
  templateJobRequest,
  templateKindsForSelection,
  validateTemplateRequest,
  type AiTemplateRun,
  type AiTemplateSettings,
  type TemplateSelection,
} from './ai-template-batch';
import {
  AiMilestoneProgress,
  inventoryMilestones,
  templateMilestones,
} from './ai-job-milestones';
import { resolveUploadSystemName, SourcePanel, validateSourceFile } from './source-panel';
import type { FlagResolutionAction } from './flag-panel';

class ModuleReviewPending extends Error {}

const QUESTION_RECOVERY_NATIVE_TIMEOUT_MS = 90_000;

/** A generation run stops after this many consecutive pump passes that changed nothing. */
const MAX_IDLE_GENERATION_PASSES = 2;

/** The server may answer `wait` this long with an unchanged job before AI tạo nội dung shows it stalled. */
export const GENERATION_STALL_MS = 180_000;
/** While the server waits on an attempt whose cleanup is unproven, it is observed again this often. */
export const CLEANUP_RECHECK_MS = 15_000;
/** Status while the room AI is fenced by an earlier attempt that may still run. */
export const WAITING_FOR_CLEANUP_TEXT = 'Đang chờ lượt AI trước dừng hẳn…';
/** Leads the restore error, so the Admin knows which request failed. */
export const RESTORE_FAILED_PREFIX = 'Không mở lại được phiên tạo template. ';
/** Status while the server waits for the room AI for any other reason (busy provider, another tab). */
export const WAITING_FOR_AI_TEXT = 'Đang chờ lượt AI…';

export const OUTLINE_RECHECK_NOTICE = 'Lộ trình cần kiểm tra lại trước khi tạo tiếp.';
export const AUTOPILOT_MISSING_NOTICE = 'Chưa bật được chế độ AI tự động cho job này.';
/** Shown once a new session saved its template: it waits in the library until it is published. */
export const AI_DRAFT_SAVED_NOTICE = 'Đã lưu template vào thư viện ở trạng thái Bản nháp. Mở template để xuất bản khi sẵn sàng.';

/** How a generator session ended: a new template saved as a draft, or an opened draft published. */
export type AiGeneratorOutcome = 'draft' | 'published';

/** Footer status while a code-less failure is retried automatically. */
export function transientRetryText(attempt: number, total: number): string {
  return 'Máy chủ phản hồi chậm, đang thử lại… (' + String(attempt) + '/' + String(total) + ')';
}
const CATALOG_LOAD_FAILED = 'Không tải được danh sách tài liệu.';

/** Changes whenever a pump pass moved the job; an unchanged fingerprint means it stalled. */
function generationFingerprint(job: AiJobRecord): string {
  return JSON.stringify([
    job.status,
    job.outlineApprovedRevision,
    job.calls.length,
    (job.moduleRuns ?? []).map((run) => [run.lessonState, run.lessonVersion, run.questionState, run.questionVersion]),
  ]);
}

/** The Vietnamese text of a job that ended in `failed`, from its recorded code and message. */
function failedJobMessage(job: Pick<AiJobRecord, 'errorCode' | 'errorMessage'>): string {
  return vietnameseErrorMessage(Object.assign(new Error(job.errorMessage ?? ''), job.errorCode ? { code: job.errorCode } : {}));
}

export const AI_GENERATOR_STEPS = ['Nguồn & loại', 'Kiểm tra độ phủ', 'AI tạo nội dung', 'Xem lại & xuất bản'] as const;

export type AiGeneratorStep = 0 | 1 | 2 | 3;

/** The step a restored session opens on. */
export function aiGeneratorStepFor(state: {
  readonly hasTemplateJob: boolean;
  readonly outlineApproved: boolean;
  readonly jobCompleted: boolean;
  readonly hasReview: boolean;
}): AiGeneratorStep {
  if (state.hasReview) return 3;
  if (state.outlineApproved || state.jobCompleted) return 2;
  if (state.hasTemplateJob) return 1;
  return 0;
}

function outlineApprovedFor(job: AiJobRecord | null | undefined): boolean {
  return job?.pipelineVersion === 'module_v2'
    && Boolean(job.outline)
    && job.outlineApprovedRevision === job.outline?.revision;
}

function sameSourceIds(left: readonly string[] | undefined, right: ReadonlySet<string>): boolean {
  return Boolean(left) && left!.length === right.size && left!.every((sourceId) => right.has(sourceId));
}

const PUBLISHING_PHASES: ReadonlySet<AiPublishTarget['phase']> = new Set(['preparing_files', 'prepared', 'publishing', 'exporting']);

/** The planned step a call belongs to: retries (`-retryN`) and repairs (`-rN`) share it. */
function plannedStep(callId: string): string {
  return callId.replace(/-(?:retry|r)\d+$/, '');
}

export function aiJobProgress(job: {
  readonly calls: readonly { readonly callId: string; readonly status: string; readonly stage: string }[];
}): { completed: number; total: number; percent: number } {
  const steps = new Map<string, boolean>();
  for (const call of job.calls) {
    const step = plannedStep(call.callId);
    steps.set(step, (steps.get(step) ?? false) || call.status === 'completed');
  }
  const total = steps.size;
  const completed = [...steps.values()].filter(Boolean).length;
  return { completed, total, percent: total === 0 ? 0 : Math.round(completed / total * 100) };
}

export function aiCallDisplayLabel(
  call: { readonly callId: string; readonly moduleTarget?: 'lesson' | 'questions' },
  calls: readonly { readonly callId: string }[],
): string {
  const step = plannedStep(call.callId);
  const batch = /^([AD])(\d+)$/.exec(step);
  let label: string;
  if (batch) {
    const total = new Set(calls.map((candidate) => plannedStep(candidate.callId))
      .filter((candidate) => new RegExp('^' + batch[1] + '\\d+$').test(candidate))).size;
    label = (batch[1] === 'A' ? 'Phân tích tài liệu' : 'Kiểm chứng nội dung')
      + ' (lô ' + batch[2] + '/' + String(Math.max(total, Number(batch[2]))) + ')';
  } else if (/^plan-/.test(step)) label = 'Lập lộ trình';
  else if (/^supplement-/.test(step)) label = 'Đọc tài liệu bổ sung';
  else if (/-lessons$/.test(step)) label = 'Tạo bài học';
  else if (/-questions$/.test(step)) label = 'Tạo câu hỏi';
  else if (/^module-\d+$/.test(step)) {
    label = call.moduleTarget === 'lesson' ? 'Tạo bài học'
      : call.moduleTarget === 'questions' ? 'Tạo câu hỏi'
        : 'Tạo nội dung module';
  } else label = step;
  const repair = /-r(\d+)$/.exec(call.callId);
  if (repair) return label + ' (tự sửa lần ' + repair[1] + '/' + String(AI_GENERATION_LIMITS.maxRepairAttempts) + ')';
  const retry = /-retry(\d+)$/.exec(call.callId);
  return retry ? label + ' (thử lại lần ' + retry[1] + ')' : label;
}

const PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = {
  sandbox: 'Sandbox',
  native_chat: 'Native AI Chat',
};

export function aiCallRuntimeText(
  call: Pick<AiCallRecord, 'status' | 'provider' | 'attemptRef' | 'startedAt'>,
  nowMs: number,
): string | null {
  if (call.status !== 'dispatched' || !call.startedAt) return null;
  const provider = attemptProvider(call);
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(call.startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  const elapsed = minutes > 0
    ? String(minutes) + ' phút' + (seconds % 60 ? ' ' + String(seconds % 60) + ' giây' : '')
    : String(seconds) + ' giây';
  return (provider ? PROVIDER_LABELS[provider] + ' · ' : '') + elapsed;
}

export function aiJobCurrentCall<T extends {
  readonly callId: string;
  readonly status: string;
}>(job: {
  readonly status: string;
  readonly calls: readonly T[];
}): T | undefined {
  if (job.status === 'failed') {
    return [...job.calls].reverse().find(
      (call) => call.status === 'invalid' || call.status === 'failed',
    );
  }
  if (job.status !== 'running') return undefined;
  return job.calls.find((call) => call.status === 'dispatched')
    ?? job.calls.find((call) => call.status === 'pending');
}

export function aiJobErrorText(job: {
  readonly status: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly calls: readonly { readonly status: string; readonly errors?: readonly string[] }[];
}): string | null {
  if (job.status !== 'failed') return null;
  const providerMessage = job.errorMessage ?? '';
  const actionableMessage = actionableProviderFailure(providerMessage);
  if (actionableMessage) return actionableMessage;
  if (/rejected this agent's credentials|model provider key/i.test(providerMessage)) {
    return 'PrivOS từ chối khóa nhà cung cấp model của agent AI. Admin workspace cần kiểm tra '
      + 'khóa nhà cung cấp model trong cài đặt agent, sau đó bấm Thử lại.';
  }
  if (/agent stopped unexpectedly/i.test(providerMessage)) {
    return 'Agent AI của PrivOS dừng đột ngột trước khi hoàn tất. Bấm Thử lại; nếu lặp lại, '
      + 'Admin workspace cần kiểm tra cấu hình agent.';
  }
  if (job.errorMessage === 'AI_FAILED') {
    return 'Nhà cung cấp AI tạm thời không hoàn tất yêu cầu. Bấm Thử lại để dùng cổng AI dự phòng nếu đã được cấp quyền.';
  }
  if (job.errorMessage?.trim()) return job.errorMessage.trim();
  const failedCall = [...job.calls].reverse().find(
    (call) => call.status === 'invalid' || call.status === 'failed',
  );
  const details = failedCall?.errors?.filter((message) => message.trim()).slice(0, 3);
  return details?.length ? details.join(' | ') : job.errorCode ?? 'AI job failed.';
}

export function aiJobStatusText(job: {
  readonly status: string;
  readonly calls: readonly { readonly callId: string; readonly status: string }[];
}): string {
  if (job.status === 'cancelled') return 'Đã hủy';
  const current = aiJobCurrentCall(job);
  if (job.status === 'failed') {
    return 'Không hoàn tất' + (current ? ': ' + aiCallDisplayLabel(current, job.calls) : '');
  }
  if (current) return 'Đang xử lý: ' + aiCallDisplayLabel(current, job.calls);
  return 'Đã hoàn tất';
}

export function aiJobPrefersNative(job: {
  readonly status: string;
  readonly errorCode?: string;
  readonly calls: readonly { readonly attemptRef?: string }[];
} | null | undefined): boolean {
  if (!job) return false;
  if (job.status !== 'running' && job.status !== 'failed') return false;
  return (job.status === 'failed' && job.errorCode === 'AI_FAILED')
    || job.calls.some((call) =>
      typeof call.attemptRef === 'string' && isNativeChatAttempt(call.attemptRef));
}

export function templateJobActionText(
  status: AiJobRecord['status'] | undefined,
): 'Tạo lộ trình' | 'Tiếp tục tạo' | 'Thử lại' {
  if (status === 'running') return 'Tiếp tục tạo';
  if (status === 'failed') return 'Thử lại';
  return 'Tạo lộ trình';
}

export function selectResumableAiJobs(input: {
  readonly jobs: readonly AiJobRecord[];
  readonly inventoryJobId?: string | null;
  readonly templateJobId?: string | null;
  /** When known, only this admin's jobs are resumed: another admin's attempt is not adoptable. */
  readonly userId?: string;
}): { inventory?: AiJobRecord; template?: AiJobRecord } {
  const available = input.jobs.filter((job) => job.status !== 'cancelled'
    && (!input.userId || job.createdBy === input.userId));
  const newestWithStatus = (kind: AiJobRecord['kind'], status: AiJobRecord['status']) => available
    .filter((job) => job.kind === kind && job.status === status)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const newestRecoverable = (kind: AiJobRecord['kind']) =>
    newestWithStatus(kind, 'running') ?? newestWithStatus(kind, 'failed');
  const byId = (jobId: string | null | undefined, kind: AiJobRecord['kind']) =>
    available.find((job) => job.jobId === jobId && job.kind === kind);

  const template = byId(input.templateJobId, 'template') ?? newestRecoverable('template');
  const inventory = byId(input.inventoryJobId, 'inventory')
    ?? byId(template?.inventoryJobId, 'inventory')
    ?? newestRecoverable('inventory');
  return { inventory, template };
}

export function readAiResumeKey(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeAiResumeKey(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // PrivOS embeds apps in a sandboxed iframe where Web Storage can be unavailable.
  }
}

export function clearAiResumeKeys(keys: readonly string[]): void {
  try {
    const storage = globalThis.sessionStorage;
    for (const key of keys) storage?.removeItem(key);
  } catch {
    // Server-side job discovery remains the source of truth when storage is unavailable.
  }
}

function aiGeneratorResumeKeys(roomId: string, userId: string): readonly string[] {
  return [
    'onboarding:ai:inventory:' + roomId,
    'onboarding:ai:template:' + roomId,
    'onboarding:ai:template:' + roomId + ':normal',
    'onboarding:ai:template:' + roomId + ':advanced',
    'onboarding:ai:publish:' + roomId + ':' + userId,
    'onboarding:ai:selection:' + roomId,
    'onboarding:ai:responsibilities:' + roomId,
    'onboarding:ai:module:' + roomId,
  ];
}

export function canPublishAiReview(flags: readonly VerificationFlag[]): {
  allowed: boolean;
  blockingCount: number;
} {
  return aiReviewReadiness({ flags } as Pick<AdminTemplateDetail, 'flags'>);
}

export function generationErrorMessage(error: unknown): string {
  return vietnameseErrorMessage(error);
}

/** A module change the server rejected; an invalid manual edit is the Admin's to fix, not AI's. */
export function moduleChangeErrorMessage(
  action: 'update_module_lesson' | 'update_module_questions' | 'retry_module',
  error: unknown,
): string {
  if (errorCode(error) === 'AI_OUTPUT_INVALID') {
    if (action === 'update_module_lesson') {
      return 'Bài học chưa lưu được: mỗi nội dung cần có dẫn chứng khớp với tài liệu nguồn. Hãy kiểm tra lại rồi lưu.';
    }
    if (action === 'update_module_questions') {
      return 'Câu hỏi chưa lưu được: mỗi câu cần có dẫn chứng khớp với tài liệu nguồn và bài học. Hãy kiểm tra lại rồi lưu.';
    }
  }
  return vietnameseErrorMessage(error);
}

export type ConfirmAttempt = (call: AiCallRecord) => Promise<AiCancellationOutcome>;

function attemptProvider(call: Pick<AiCallRecord, 'provider' | 'attemptRef'>): AiProvider | undefined {
  if (call.provider) return call.provider;
  if (!call.attemptRef) return undefined;
  return isNativeChatAttempt(call.attemptRef) ? 'native_chat' : 'sandbox';
}

async function reportCleanup(
  api: Pick<OnboardingApi, 'adminAi'>,
  jobId: string,
  call: AiCallRecord,
  outcome: AiCancellationOutcome,
): Promise<AiJobRecord> {
  return (await api.adminAi<{ job: AiJobRecord }>('record_attempt_cleanup', {
    jobId,
    callId: call.callId,
    attemptRef: call.attemptRef,
    state: outcome.state,
    ...(outcome.state === 'unknown' ? { message: outcome.message } : {}),
  })).job;
}

/**
 * Stops local polling, cancels the server job, then asks the provider to stop each live
 * attempt and records whether PrivOS confirmed it. The server job is cancelled either way.
 */
export async function cancelRunningAiJob(
  api: Pick<OnboardingApi, 'adminAi'>,
  jobId: string,
  abort: () => void,
  confirmAttempt?: ConfirmAttempt,
  onServerCancelled?: (job: AiJobRecord) => void,
): Promise<{ readonly job: AiJobRecord; readonly unconfirmed: number }> {
  abort();
  let job = (await api.adminAi<{ job: AiJobRecord }>('cancel_job', { jobId })).job;
  let unconfirmed = (job.calls ?? []).filter((call) => !call.attemptRef && call.cleanupState !== 'confirmed'
    && (call.dispatchUnknown || call.cleanupState === 'pending' || call.cleanupState === 'unknown'
      || (call.status === 'pending' && call.dispatchClaimedAt))).length;
  if (!confirmAttempt) return { job, unconfirmed };
  const live = (job.calls ?? []).filter((call) => call.attemptRef && call.cleanupState !== 'confirmed'
    && (call.status === 'dispatched' || call.cleanupState === 'pending' || call.cleanupState === 'unknown'));
  if (live.length > 0) onServerCancelled?.(job);
  for (const call of live) {
    let outcome: AiCancellationOutcome;
    try {
      outcome = await confirmAttempt(call);
    } catch {
      outcome = { state: 'unknown', message: 'Không kiểm tra được trạng thái tiến trình AI.' };
    }
    if (outcome.state === 'unknown') unconfirmed += 1;
    job = await reportCleanup(api, jobId, call, outcome);
  }
  return { job, unconfirmed };
}

export interface AttemptCleanupEntry {
  readonly jobId: string;
  readonly call: AiCallRecord;
}

/** The current user's attempts that may still run: cancelled live calls and timed-out calls not proven stopped. */
export function attemptsNeedingCleanup(
  jobs: readonly Pick<AiJobRecord, 'jobId' | 'status' | 'calls' | 'createdBy'>[],
  userId: string | undefined,
): readonly AttemptCleanupEntry[] {
  return jobs
    .filter((job) => Boolean(userId) && job.createdBy === userId)
    .flatMap((job) => job.calls
      .filter((call) => typeof call.attemptRef === 'string'
        && call.cleanupState !== 'confirmed'
        && (call.cleanupState === 'pending' || call.cleanupState === 'unknown'
          || (job.status === 'cancelled' && call.status === 'dispatched')))
      .map((call) => ({ jobId: job.jobId, call })));
}

/** A Native attempt that may still run blocks new Native dispatches in the same room. */
export function selectBlockingNativeCleanup(
  jobs: readonly Pick<AiJobRecord, 'jobId' | 'status' | 'calls' | 'createdBy'>[],
  userId: string | undefined,
): AttemptCleanupEntry | undefined {
  return attemptsNeedingCleanup(jobs, userId)
    .find((entry) => attemptProvider(entry.call) === 'native_chat');
}

/** Re-checks every unproven attempt; returns the jobs the server updated. */
export async function reconcileAttemptCleanups(
  api: Pick<OnboardingApi, 'adminAi'>,
  jobs: readonly AiJobRecord[],
  userId: string | undefined,
  confirmAttempt: ConfirmAttempt,
  signal?: AbortSignal,
): Promise<readonly AiJobRecord[]> {
  const updated = new Map<string, AiJobRecord>();
  for (const entry of attemptsNeedingCleanup(jobs, userId)) {
    if (signal?.aborted) break;
    try {
      const outcome = await confirmAttempt(entry.call);
      updated.set(entry.jobId, await reportCleanup(api, entry.jobId, entry.call, outcome));
    } catch (error) {
      if (isAbortError(error)) break;
      // Leave the attempt as it is; the next check retries it.
    }
  }
  return [...updated.values()];
}

export const NATIVE_CLEANUP_BLOCKED = 'Không thể retry bằng Native cho đến khi tiến trình trước đã dừng.';

/** Esc inside a field or a nested panel that handles Esc itself must not close the modal. */
function escapeBelongsToTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return typeof element?.closest === 'function'
    && Boolean(element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-esc-scope]'));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

function readFile(file: Blob): Promise<{ dataUrl: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const separator = dataUrl.indexOf(',');
      if (separator < 0) reject(new Error('Không thể mã hóa tài liệu.'));
      else resolve({ dataUrl, base64: dataUrl.slice(separator + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error('Không thể đọc tài liệu.'));
    reader.readAsDataURL(file);
  });
}

export type AiPublishFileStage =
  | 'preparing_folder'
  | 'creating_pdf'
  | 'uploading_pdf'
  | 'updating_review'
  | 'publishing'
  | 'exporting_json';

export interface AiPublishFileProgress {
  readonly kind: EmployeeType;
  readonly templateTitle: string;
  readonly stage: AiPublishFileStage;
  readonly moduleIndex?: number;
  readonly moduleCount?: number;
  readonly moduleTitle?: string;
  readonly error?: string;
}

interface AiPublishApi {
  adminAi<T>(action: string, args?: Record<string, unknown>): Promise<T>;
  adminTemplates<T>(action: string, args?: Record<string, unknown>): Promise<T>;
}

export interface CreateAiPublishDependenciesInput {
  readonly app: Pick<McpApp, 'rest' | 'uploadFile'>;
  readonly api: AiPublishApi;
  readonly roomId: string;
  readonly settingsByKind?: Partial<Record<EmployeeType, AiTemplateSettings>>;
  readonly onProgress?: (progress: AiPublishFileProgress) => void;
  readonly ensureTemplateFolder?: typeof ensureTemplateRoomfilesFolder;
  readonly createLessonPdf?: typeof createLessonPdfArtifact;
  readonly encodeBlob?: typeof readFile;
}

export function lessonPdfResourceId(moduleId: string): string {
  return `ai-lesson-pdf-${moduleId}`;
}

const TEMPLATE_UPDATE_FAILED = 'Không thể cập nhật template.';
/** vietnameseErrorMessage's text for an English error without a code. */
const GENERIC_AI_ERROR = 'Không thể hoàn tất yêu cầu AI.';

/** What a lesson PDF is rendered from; uploads of a failed Lưu template stay valid while it holds. */
function lessonPdfKey(review: AdminTemplateDetail): string {
  return JSON.stringify([review.id, review.version, review.title,
    review.modules.map(({ resources: _resources, ...module }) => module), review.content?.modules]);
}

function contextualPublishError(
  review: AdminTemplateDetail,
  error: unknown,
  moduleTitle?: string,
  fallback = 'Không thể hoàn tất thao tác Roomfiles.',
): Error {
  // Never the raw server or SDK text: the Vietnamese message, after the template and module it
  // concerns; an English error without a code says which step did not finish.
  const message = vietnameseErrorMessage(error);
  const detail = message === GENERIC_AI_ERROR ? fallback : message;
  return new Error(`${review.title}${moduleTitle ? ` · ${moduleTitle}` : ''}: ${detail}`);
}

export function createAiPublishDependencies(
  input: CreateAiPublishDependenciesInput,
): AiPublishBatchDependencies {
  const ensureFolder = input.ensureTemplateFolder ?? ensureTemplateRoomfilesFolder;
  const createPdf = input.createLessonPdf ?? createLessonPdfArtifact;
  const encode = input.encodeBlob ?? readFile;
  const folderPromises = new Map<string, ReturnType<typeof ensureFolder>>();
  const folderFor = (review: AdminTemplateDetail) => {
    const key = `${review.id}:${review.version}:${review.title}`;
    const existing = folderPromises.get(key);
    if (existing) return existing;
    const pending = ensureFolder(input.app, input.roomId, review.title).catch((error) => {
      folderPromises.delete(key);
      throw error;
    });
    folderPromises.set(key, pending);
    return pending;
  };
  const report = (
    review: AdminTemplateDetail,
    stage: AiPublishFileStage,
    details: Omit<AiPublishFileProgress, 'kind' | 'templateTitle' | 'stage'> = {},
  ) => input.onProgress?.({
    kind: review.employeeType,
    templateTitle: review.title,
    stage,
    ...details,
  });

  return {
    async beginBatch(targets) {
      const { batch } = await input.api.adminAi<{ batch: AiPublicationBatch }>('begin_publication', {
        batchId: targets[0]?.batchId,
        targets: targets.map((target) => ({ kind: target.kind, templateId: target.review.id, version: target.review.version,
          settings: input.settingsByKind?.[target.kind] })),
      });
      return Promise.all(batch.targets.map(async (target) => {
        const { review } = await input.api.adminAi<{ review: AdminTemplateDetail }>('get_review', {
          templateId: target.templateId, version: target.version,
        });
        return restoreAiPublishTarget(review, batch.batchId);
      }));
    },
    async prepareResources(target, checkpoint) {
      let review = target.review;
      try {
        review = (await input.api.adminAi<{ review: AdminTemplateDetail }>('get_review', { templateId: target.review.id, version: target.review.version })).review;
        if (aiPublishTargetKey(review) !== aiPublishTargetKey(target.review)) throw new Error('Template đã thay đổi. Hãy kiểm tra bản nháp mới.');
        const settings = input.settingsByKind?.[target.kind];
        if (settings && (settings.passingScore !== review.passingScore
          || settings.learningMode !== review.content?.learningMode
          || settings.maxAttemptsPerModule !== review.content?.maxAttemptsPerModule)) {
          review = (await input.api.adminAi<{ review: AdminTemplateDetail }>('update_review', {
            templateId: review.id, version: review.version, expectedUpdatedAt: review.updatedAt,
            ops: [{ kind: 'set_settings', ...settings }],
          })).review;
        }
      } catch (error) {
        const contextual = contextualPublishError(review, error, undefined, TEMPLATE_UPDATE_FAILED);
        report(review, 'updating_review', { error: contextual.message });
        throw contextual;
      }
      if (review.status === 'published') return review;
      const uploadedResources: Record<string, TemplateResource> = {
        ...(aiPublishTargetKey(review) === aiPublishTargetKey(target.review) ? target.uploadedResources : {}),
        ...(review.content?.publication?.pdfs ?? {}),
      };
      report(review, 'preparing_folder');
      let folder: Awaited<ReturnType<typeof ensureFolder>>;
      try {
        folder = await folderFor(review);
      } catch (error) {
        const contextual = contextualPublishError(review, error);
        report(review, 'preparing_folder', { error: contextual.message });
        throw contextual;
      }

      const resourceOperations: AiReviewOperation[] = [];
      for (let index = 0; index < review.modules.length; index += 1) {
        const module = review.modules[index];
        const progress = {
          moduleIndex: index,
          moduleCount: review.modules.length,
          moduleTitle: module.title,
        };
        let activeStage: AiPublishFileStage = 'creating_pdf';
        try {
          const existing = uploadedResources[module.id] ?? module.resources.find((resource) => resource.id === lessonPdfResourceId(module.id) && resource.fileId);
          let resource = existing;
          if (!resource) {
          report(review, activeStage, progress);
          const artifact = await createPdf(review, module.id, index);
          const encoded = await encode(artifact.blob);
          activeStage = 'uploading_pdf';
          report(review, activeStage, progress);
          const uploadResult = await input.app.uploadFile({
            channelId: input.roomId,
            folderId: folder.templateFolderId,
            fileName: artifact.fileName,
            base64Data: encoded.dataUrl,
            mimeType: artifact.mimeType,
            duplicateAction: 'replace',
          });
          const uploaded = normalizeUploadedRoomFile(uploadResult, {
            fileName: artifact.fileName,
            mimeType: artifact.mimeType,
            size: artifact.blob.size,
          });
          resource = {
              id: lessonPdfResourceId(module.id),
              title: `Tài liệu: ${module.title}`,
              description: 'Tài liệu bài học PDF.',
              kind: 'file',
              required: true,
              fileId: uploaded.fileId,
            };
          uploadedResources[module.id] = resource;
          checkpoint?.({ ...uploadedResources });
          }
          if (!review.content?.publication?.pdfs[module.id]) {
            review = (await input.api.adminAi<{ review: AdminTemplateDetail }>('update_review', {
              templateId: review.id, version: review.version, expectedUpdatedAt: review.updatedAt,
              ops: [{ kind: 'checkpoint_publication', moduleId: module.id, resource }],
            })).review;
          }
          resourceOperations.push({ kind: 'upsert_generated_resource', moduleId: module.id, resource });
        } catch (error) {
          const contextual = contextualPublishError(review, error, module.title,
            activeStage === 'creating_pdf' ? 'Không tạo được PDF bài học.' : undefined);
          report(review, activeStage, { ...progress, error: contextual.message });
          throw contextual;
        }
      }

      const operations: AiReviewOperation[] = [
        ...resourceOperations,
      ];
      report(review, 'updating_review');
      try {
        const result = await input.api.adminAi<{ review: AdminTemplateDetail }>('update_review', {
          templateId: review.id,
          version: review.version,
          expectedUpdatedAt: review.updatedAt,
          ops: operations,
        });
        return result.review;
      } catch (error) {
        const contextual = contextualPublishError(review, error, undefined, TEMPLATE_UPDATE_FAILED);
        report(review, 'updating_review', { error: contextual.message });
        throw contextual;
      }
    },

    async publish(review) {
      if (review.status === 'published') return review;
      report(review, 'publishing');
      try {
        return (await input.api.adminTemplates<{ template: AdminTemplateDetail }>('publish', {
          templateId: review.id,
          version: review.version,
          expectedUpdatedAt: review.updatedAt,
        })).template;
      } catch (error) {
        const contextual = contextualPublishError(review, error, undefined, TEMPLATE_UPDATE_FAILED);
        report(review, 'publishing', { error: contextual.message });
        throw contextual;
      }
    },

    async exportJson(published) {
      if (published.content?.publication?.jsonFileId) return;
      report(published, 'exporting_json');
      try {
        const folder = await folderFor(published);
        const artifact = templateJsonArtifact(published);
        const encoded = await encode(new Blob([artifact.content], { type: artifact.mimeType }));
        const upload = await input.app.uploadFile({
          channelId: input.roomId,
          folderId: folder.templateFolderId,
          fileName: artifact.fileName,
          base64Data: encoded.dataUrl,
          mimeType: artifact.mimeType,
          duplicateAction: 'replace',
        });
        const uploaded = normalizeUploadedRoomFile(upload, { fileName: artifact.fileName, mimeType: artifact.mimeType });
        await input.api.adminAi('update_review', {
          templateId: published.id, version: published.version, expectedUpdatedAt: published.updatedAt,
          ops: [{ kind: 'checkpoint_publication', jsonFileId: uploaded.fileId }],
        });
      } catch (error) {
        const contextual = contextualPublishError(published, error);
        report(published, 'exporting_json', { error: contextual.message });
        throw contextual;
      }
    },
  };
}
export function finishSuccessfulAiPublish(
  targets: readonly AiPublishTarget[],
  callbacks: {
    readonly clearResume: () => void;
    readonly resetSession: () => void;
    readonly onComplete: () => void;
    readonly onClose: () => void;
  },
): boolean {
  if (targets.length === 0 || targets.some((target) => target.phase !== 'completed' || !target.preparedReview
    || target.publishedTemplate?.status !== 'published' || !target.jsonExported
    || aiPublishTargetKey(target.review) !== aiPublishTargetKey(target.preparedReview)
    || aiPublishTargetKey(target.review) !== aiPublishTargetKey(target.publishedTemplate))) return false;
  callbacks.clearResume();
  callbacks.resetSession();
  callbacks.onComplete();
  callbacks.onClose();
  return true;
}
const AI_PUBLISH_PHASE_LABELS: Readonly<Record<AiPublishTarget['phase'], string>> = {
  idle: 'Chờ xuất bản',
  preparing_files: 'Đang tạo tài liệu PDF',
  prepared: 'Đã chuẩn bị tài liệu',
  publishing: 'Đang xuất bản',
  exporting: 'Đang lưu JSON',
  completed: 'Đã hoàn tất',
  failed: 'Cần thử lại',
};

export function aiPublishProgressText(progress: AiPublishFileProgress): string {
  const modulePrefix = progress.moduleTitle
    ? `Module ${(progress.moduleIndex ?? 0) + 1}/${progress.moduleCount ?? 1}: ${progress.moduleTitle} · `
    : '';
  const action: Readonly<Record<AiPublishFileStage, string>> = {
    preparing_folder: 'Chuẩn bị thư mục Roomfiles',
    creating_pdf: 'Tạo PDF bài học',
    uploading_pdf: 'Tải PDF lên Roomfiles',
    updating_review: 'Gắn tài liệu vào template',
    publishing: 'Xuất bản template',
    exporting_json: 'Lưu file JSON',
  };
  return `${progress.templateTitle} · ${modulePrefix}${action[progress.stage]}`;
}
export function AiGeneratorPage({
  api,
  canGenerateWithAi,
  initialTemplate,
  onClose,
  onComplete,
}: {
  api: OnboardingApi;
  canGenerateWithAi: boolean;
  initialTemplate?: { readonly id: string; readonly version: number };
  onClose: () => void;
  onComplete: (outcome: AiGeneratorOutcome) => void;
}) {
  const app = usePrivosApp();
  const context = usePrivosContext();
  const { roomId } = context;
  const aiChatReadCapability = resolveHostCapability(context.effectiveScopes, 'sandbox:ai-chat');
  const aiChatWriteCapability = resolveHostCapability(context.effectiveScopes, 'sandbox:ai-chat:write');
  const nativeFallbackAvailable = aiChatReadCapability.resolved
    && aiChatReadCapability.granted
    && aiChatWriteCapability.resolved
    && aiChatWriteCapability.granted;
  const [step, setStep] = useState<AiGeneratorStep>(initialTemplate ? 3 : 0);
  const [sources, setSources] = useState<readonly SourceSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [systemName, setSystemName] = useState('');
  const [softwareVersion, setSoftwareVersion] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [inventoryJob, setInventoryJob] = useState<AiJobRecord | null>(null);
  const [templateRuns, setTemplateRuns] = useState<readonly AiTemplateRun[]>([]);
  const [templateSelection, setTemplateSelection] = useState<TemplateSelection>(null);
  const [templateTitle, setTemplateTitle] = useState('');
  const [responsibilities, setResponsibilities] = useState('');
  const [publishTargets, setPublishTargets] = useState<readonly AiPublishTarget[]>([]);
  const [publishProgress, setPublishProgress] = useState<AiPublishFileProgress | null>(null);
  const [activeReviewIndex, setActiveReviewIndex] = useState(0);
  /** The operation in flight; busy labels and the close confirmation depend on which one it is. */
  const [operation, setOperation] = useState<'upload' | 'analyze' | 'approve' | 'save' | 'publish' | 'saveDraft' | null>(null);
  const busy = operation !== null;
  const [editingOutline, setEditingOutline] = useState(false);
  const [outlineFocusModuleId, setOutlineFocusModuleId] = useState<string | null>(null);
  /** `list_module_sources` of one job; null until it has loaded (or failed) for the current job. */
  const [moduleSourceCatalog, setModuleSourceCatalog] = useState<{ readonly jobId: string; readonly sources: ModuleSourceCatalog | null } | null>(null);
  /** Bumped by the catalog's Thử lại to load it again. */
  const [catalogReload, setCatalogReload] = useState(0);
  const [selectedTemplateKind, setSelectedTemplateKind] = useState<EmployeeType | null>(null);
  const [notice, setNotice] = useState<InlineNoticeMessage | null>(null);
  /**
   * AI tạo nội dung: an unrecoverable failure (Vietnamese) and whether the pump stopped short.
   * `fromPrepare` marks a failed retry/upgrade call, whose own error beats a stored job error.
   */
  const [generationError, setGenerationError] = useState<{ readonly message: string; readonly fromPrepare: boolean } | null>(null);
  const [stalled, setStalled] = useState(false);
  const [pausing, setPausing] = useState(false);
  /** Lưu template failed; the primary offers Thử lại lưu until it succeeds or the draft changes. */
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);
  /** Lesson PDFs a failed Lưu template already uploaded, for the draft they were rendered from. */
  const draftSaveResourcesRef = useRef<{ readonly key: string; readonly resources: Readonly<Record<string, TemplateResource>> } | null>(null);
  /** Set while a code-less failure is being retried automatically; the footer says so. */
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  /** Xem lại & xuất bản: a module edit or rewrite is being pumped through the job. */
  const [moduleUpdating, setModuleUpdating] = useState(false);
  const [roomJobs, setRoomJobs] = useState<readonly AiJobRecord[]>([]);
  /** Read by a pump that started several renders ago; always the latest room jobs. */
  const roomJobsRef = useRef<readonly AiJobRecord[]>([]);
  roomJobsRef.current = roomJobs;
  /** Set while the server answers `wait`: why AI tạo nội dung is not dispatching right now. */
  const [waitStatus, setWaitStatus] = useState<string | null>(null);
  /** When the open modal last observed the unproven attempts the server is waiting on. */
  const cleanupCheckAtRef = useRef<number | null>(null);
  const [checkingCleanup, setCheckingCleanup] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  /** Bumped by the restore error's Thử lại to run the restore again. */
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  /** The restore failed even after its automatic retries; shown with Thử lại until it succeeds. */
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [sourcePanelEpoch, setSourcePanelEpoch] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const inventoryRecoveryAbortRef = useRef<AbortController | null>(null);
  const cleanupAbortRef = useRef<AbortController | null>(null);
  /** Aborted by a pause, reset or close: a pending automatic retry stops waiting. */
  const retryAbortRef = useRef(new AbortController());
  /** Template jobs dropped by a kind change; the next analyse cancels the ones still running. */
  const supersededJobsRef = useRef<AiJobRecord[]>([]);
  /** Bumped by each generation run and by a pause, so a superseded run stops without settling. */
  const generationRunRef = useRef(0);
  /** The job whose generation already resumed by itself on this mount. */
  const autoPumpedJobRef = useRef<string | null>(null);
  /** Jobs upgraded with `enable_autopilot` on this mount; the upgrade happens once. */
  const autopilotEnabledRef = useRef<Set<string>>(new Set());
  const appRef = useRef(app);
  appRef.current = app;
  const { userId } = context;
  const checkpointTargets = useCallback((targets: readonly AiPublishTarget[]) => {
    setPublishTargets(targets);
    if (roomId) writeAiResumeKey('onboarding:ai:publish:' + roomId + ':' + userId, JSON.stringify(targets));
  }, [roomId, userId]);
  const activeTemplateRun = templateRuns.find((run) => run.kind === selectedTemplateKind) ?? templateRuns.find((run) => !run.review) ?? templateRuns[0];
  const templateJob = activeTemplateRun?.job ?? null;
  const activeReviewRun = templateRuns[activeReviewIndex];
  const review = activeReviewRun?.review ?? null;
  const activeSettings: AiTemplateSettings = activeReviewRun?.settings ?? {
    passingScore: review?.passingScore ?? 70,
    maxAttemptsPerModule: review?.content?.maxAttemptsPerModule === undefined ? 2 : review.content.maxAttemptsPerModule,
    learningMode: review?.content?.learningMode ?? 'sequential',
  };
  const { passingScore, maxAttemptsPerModule, learningMode } = activeSettings;
  const setTemplateJob = useCallback((job: AiJobRecord) => {
    const kind = job.templateKind;
    if (!kind) return;
    setTemplateRuns((current) => {
      const existing = current.find((run) => run.kind === kind);
      const next = existing
        ? current.map((run) => run.kind === kind ? { ...run, job, ...(job.pipelineVersion === 'module_v2' && !job.result ? { review: null } : {}) } : run)
        : [...current, { kind, job, review: null }];
      return [...next].sort((left, right) => left.kind === right.kind ? 0 : left.kind === 'normal' ? -1 : 1);
    });
  }, []);
  const setReview = useCallback((nextReview: AdminTemplateDetail) => {
    setPublishTargets([]);
    setPublishProgress(null);
    setDraftSaveFailed(false);
    setTemplateRuns((current) => {
      const kind = nextReview.employeeType;
      const existing = current.find((run) => run.kind === kind);
      const settings = existing?.settings ?? {
        passingScore: nextReview.passingScore ?? 70,
        maxAttemptsPerModule: nextReview.content?.maxAttemptsPerModule === undefined ? 2 : nextReview.content.maxAttemptsPerModule,
        learningMode: nextReview.content?.learningMode ?? 'sequential',
      };
      const next = existing
        ? current.map((run) => run.kind === kind ? { ...run, review: nextReview, settings } : run)
        : [...current, { kind, job: null, review: nextReview, settings }];
      return [...next].sort((left, right) => left.kind === right.kind ? 0 : left.kind === 'normal' ? -1 : 1);
    });
  }, []);
  const updateActiveSettings = useCallback((patch: Partial<AiTemplateSettings>) => {
    setPublishTargets([]);
    setPublishProgress(null);
    setTemplateRuns((current) => current.map((run, index) => index === activeReviewIndex
      ? {
          ...run,
          settings: {
            passingScore: run.settings?.passingScore ?? run.review?.passingScore ?? 70,
            maxAttemptsPerModule: run.settings
              ? run.settings.maxAttemptsPerModule
              : run.review?.content?.maxAttemptsPerModule === undefined ? 2 : run.review.content.maxAttemptsPerModule,
            learningMode: run.settings?.learningMode ?? run.review?.content?.learningMode ?? 'sequential',
            ...patch,
          },
        }
      : run));
  }, [activeReviewIndex]);
  const nativeCleanupBlock = useMemo(
    () => selectBlockingNativeCleanup(roomJobs, userId),
    [roomJobs, userId],
  );

  const gatewayFor = useCallback((provider: AiProvider): AiGateway => {
    if (!roomId) throw new Error('Không xác định được room để chạy AI.');
    return provider === 'native_chat'
      ? createNativeChatAiGateway(appRef.current, roomId)
      : createSandboxAiGateway(appRef.current, roomId);
  }, [roomId]);

  const confirmAttempt = useCallback((call: AiCallRecord, signal?: AbortSignal, intent: 'observe' | 'cancel' = 'observe') => {
    const provider = attemptProvider(call);
    if (!provider || !call.attemptRef) {
      return Promise.resolve<AiCancellationOutcome>({
        state: 'unknown',
        message: 'Không xác định được nhà cung cấp của tiến trình AI.',
      });
    }
    return intent === 'cancel'
      ? cancelAndConfirmAttempt(gatewayFor(provider), call.attemptRef, signal ? { signal } : {})
      : observeAttemptTermination(gatewayFor(provider), call.attemptRef, signal);
  }, [gatewayFor]);

  const mergeJobs = useCallback((updates: readonly AiJobRecord[]) => {
    if (updates.length === 0) return;
    const byId = new Map(updates.map((job) => [job.jobId, job]));
    setRoomJobs((current) => current.map((job) => byId.get(job.jobId) ?? job));
  }, []);

  const reconcileCleanups = useCallback(async (jobs: readonly AiJobRecord[]) => {
    cleanupAbortRef.current?.abort();
    const controller = new AbortController();
    cleanupAbortRef.current = controller;
    setCheckingCleanup(true);
    try {
      mergeJobs(await reconcileAttemptCleanups(
        api, jobs, userId, (call) => confirmAttempt(call, controller.signal), controller.signal,
      ));
    } finally {
      if (cleanupAbortRef.current === controller) setCheckingCleanup(false);
    }
  }, [api, confirmAttempt, mergeJobs, userId]);

  const loadSources = useCallback(async () => {
    const result = await api.adminAi<{ sources: readonly SourceSummary[] }>('list_sources');
    setSources(result.sources);
    // Sources already carry the system name they were uploaded with; reuse it as the default.
    setSystemName((current) => current || result.sources.find((source) => source.systemName.trim())?.systemName || '');
    setSelectedIds((current) => current.size > 0
      ? new Set([...current].filter((sourceId) => result.sources.some((source) => source.sourceId === sourceId)))
      : new Set(result.sources.map((source) => source.sourceId)));
    return result.sources;
  }, [api]);

  /**
   * Publication batches still worth reopening. A target whose template is archived or gone is
   * dropped; a batch whose targets are all dropped or published with their JSON is finished.
   * A published target still missing its JSON keeps the batch, so only that export is finished.
   */
  const unfinishedPublicationBatches = useCallback(async (batches: readonly AiPublicationBatch[]) => {
    const unfinished: AiPublicationBatch[] = [];
    /** templateId@version → the review just loaded, so restoring does not load it again. */
    const reviews = new Map<string, AdminTemplateDetail>();
    for (const batch of batches) {
      const states = await Promise.all(batch.targets.map(async (target) => {
        try {
          const { review: current } = await api.adminAi<{ review: AdminTemplateDetail }>('get_review', {
            templateId: target.templateId, version: target.version,
          });
          reviews.set(target.templateId + '@' + String(target.version), current);
          if (current.status === 'archived') return 'gone';
          return current.status === 'published' && current.content?.publication?.jsonFileId ? 'done' : 'pending';
        } catch (caught) {
          // Only a template that no longer exists ends its target; anything else is checked again on restore.
          return errorCode(caught) === 'TEMPLATE_NOT_FOUND' ? 'gone' : 'pending';
        }
      }));
      if (!states.includes('pending')) continue;
      unfinished.push({ ...batch, targets: batch.targets.filter((_target, index) => states[index] !== 'gone') });
    }
    return { batches: unfinished, reviews };
  }, [api]);

  const loadReview = useCallback(async (
    templateId: string,
    version: number,
    advanceToReview = true,
  ) => {
    const result = await api.adminAi<{ review: AdminTemplateDetail }>('get_review', { templateId, version });
    setReview(result.review);
    if (advanceToReview) {
      setActiveReviewIndex(0);
      setStep(3);
    }
    return result.review;
  }, [api, setReview]);

  // The coverage step needs to know which sections can ground a module; reload when the outline or sources change.
  const catalogJobId = templateJob?.pipelineVersion === 'module_v2' && templateJob.outline
    && (step === 1 || editingOutline || templateJob.outlineApprovedRevision !== templateJob.outline.revision)
    ? templateJob.jobId
    : null;
  useEffect(() => {
    let active = true;
    if (catalogJobId) {
      void api.adminAi<{ sources: ModuleSourceCatalog }>('list_module_sources', { jobId: catalogJobId })
        .then((result) => { if (active) setModuleSourceCatalog({ jobId: catalogJobId, sources: result.sources }); })
        // A failed load is not an empty catalog: coverage stays unknown until it loads.
        .catch(() => { if (active) setModuleSourceCatalog({ jobId: catalogJobId, sources: null }); });
    }
    return () => { active = false; };
  }, [api, catalogJobId, templateJob?.outline?.revision, templateJob?.sourceIds?.length, sources, catalogReload]);

  useEffect(() => {
    let active = true;
    const retryController = new AbortController();
    setRestoring(true);
    setRestoreError(null);
    /** A code-less failure (e.g. the host's tool-call timeout) is retried after 2 s, 5 s and 10 s. */
    const retry = <T,>(run: () => Promise<T>): Promise<T> => withTransientRetry({
      run,
      active: () => active,
      signal: retryController.signal,
      onRetry: (attempt, total) => { if (active) setRetryStatus(transientRetryText(attempt, total)); },
    }).finally(() => { if (active) setRetryStatus(null); });
    void (async () => {
      try {
        const loadedSources = await retry(loadSources);
        if (initialTemplate) {
          const loaded = await retry(() => loadReview(initialTemplate.id, initialTemplate.version));
          setTemplateSelection(loaded.employeeType);
          // A module-approved AI draft is edited through its own job, like a fresh one.
          if (loaded.jobId && loaded.content?.moduleApproval && loaded.status === 'draft') {
            try {
              const job = (await retry(() => api.adminAi<{ job: AiJobRecord }>('get_job', { jobId: loaded.jobId! }))).job;
              const output = job.result as { templateId?: unknown; version?: unknown } | null | undefined;
              // Only the job whose current result is this very draft: its drafts are what the Admin sees.
              if (active && job.pipelineVersion === 'module_v2' && job.moduleRuns?.length && job.createdBy === userId
                && job.status === 'completed' && output?.templateId === loaded.id && output.version === loaded.version) {
                setTemplateRuns((current) => current.map((run) => run.kind === loaded.employeeType ? { ...run, job } : run));
              }
            } catch {
              // Without its job the draft still opens read-only in the legacy review.
            }
          }
          return;
        }
        const result = await retry(() => api.adminAi<{ jobs: readonly AiJobRecord[]; publicationBatches?: readonly AiPublicationBatch[] }>('list_jobs'));
        if (!active) return;
        setRoomJobs(result.jobs);
        const inventoryId = roomId ? readAiResumeKey('onboarding:ai:inventory:' + roomId) : null;
        const legacyTemplateId = roomId ? readAiResumeKey('onboarding:ai:template:' + roomId) : null;
        // One-time migration: older sessions stored one key per kind plus a selection key.
        const resumeJobIds = roomId ? [
          legacyTemplateId,
          readAiResumeKey('onboarding:ai:template:' + roomId + ':normal'),
          readAiResumeKey('onboarding:ai:template:' + roomId + ':advanced'),
        ] : [];
        const { inventory } = selectResumableAiJobs({
          jobs: result.jobs,
          inventoryJobId: inventoryId,
          templateJobId: legacyTemplateId,
          userId,
        });
        // Prefetching the batches' reviews is optional: without it every listed batch stays open.
        const publications = await unfinishedPublicationBatches(result.publicationBatches ?? [])
          .catch(() => ({ batches: result.publicationBatches ?? [], reviews: new Map<string, AdminTemplateDetail>() }));
        if (!active) return;
        let restoredRuns = selectResumableTemplateRuns({
          jobs: result.jobs,
          publicationBatches: publications.batches,
          resumeJobIds,
          userId,
        });
        // An older module job without the autopilot flag is upgraded once, so nothing waits for manual approval.
        for (const run of restoredRuns) {
          const job = run.job;
          if (!job || job.pipelineVersion !== 'module_v2' || job.autoApprove === true || job.status !== 'running'
            || !job.outline || autopilotEnabledRef.current.has(job.jobId)) continue;
          autopilotEnabledRef.current.add(job.jobId);
          try {
            // Optional: without it the banner offers the upgrade, so it never holds up the restore.
            const upgraded = (await api.adminAi<{ job: AiJobRecord }>('enable_autopilot', { jobId: job.jobId })).job;
            restoredRuns = restoredRuns.map((entry) => entry.job?.jobId === upgraded.jobId ? { ...entry, job: upgraded } : entry);
          } catch (caught) {
            if (active) setNotice({ message: generationErrorMessage(caught), tone: 'error' });
          }
          if (!active) return;
        }
        const restoredInventoryId = restoredRuns.find((run) => run.job?.inventoryJobId)?.job?.inventoryJobId;
        const restoredInventory = result.jobs.find((job) => job.kind === 'inventory' && job.jobId === restoredInventoryId);
        setInventoryJob(inventory ?? restoredInventory ?? null);
        setTemplateRuns(restoredRuns);
        if (roomId) {
          clearAiResumeKeys([
            'onboarding:ai:template:' + roomId + ':normal',
            'onboarding:ai:template:' + roomId + ':advanced',
            'onboarding:ai:selection:' + roomId,
          ]);
        }
        if (restoredRuns.length > 0) {
          setTemplateSelection(restoredRuns[0].kind);
          const advancedProfile = restoredRuns.find((run) => run.kind === 'advanced')?.job?.roleProfile;
          if (advancedProfile) {
            setResponsibilities(advancedProfile.responsibilities.join('\n'));
          } else if (roomId) setResponsibilities(readAiResumeKey('onboarding:ai:responsibilities:' + roomId) ?? '');
          const restoredJob = restoredRuns[0].job;
          if (roomId && restoredJob) writeAiResumeKey('onboarding:ai:template:' + roomId, restoredJob.jobId);
          for (const run of restoredRuns) {
            const output = run.publicationTarget ?? (run.job?.status === 'completed' && run.job.result && typeof run.job.result === 'object'
              ? run.job.result as { templateId?: unknown; version?: unknown }
              : undefined);
            if (output && typeof output.templateId === 'string' && typeof output.version === 'number') {
              const prefetched = publications.reviews.get(output.templateId + '@' + String(output.version));
              if (prefetched) setReview(prefetched);
              const { templateId, version } = output;
              // A review that does not load leaves its job on AI tạo nội dung, whose Thử lại loads it again.
              const loaded = prefetched ?? await retry(() => loadReview(templateId, version, false)).catch(() => null);
              if (!active) return;
              if (loaded) restoredRuns = restoredRuns.map((entry) => entry.kind === run.kind ? { ...entry, review: loaded } : entry);
            }
          }
          setTemplateRuns(restoredRuns);
          const run = restoredRuns[0];
          if (run.review) setActiveReviewIndex(0);
          else setSelectedTemplateKind(run.kind);
          setStep(aiGeneratorStepFor({
            hasTemplateJob: Boolean(run.job),
            outlineApproved: outlineApprovedFor(run.job),
            jobCompleted: run.job?.status === 'completed',
            hasReview: Boolean(run.review),
          }));
          if (restoredRuns.every((entry) => entry.review) && restoredRuns.some((entry) => entry.publicationBatchId || entry.review?.content?.publication || entry.review?.status === 'published')) {
            const targets = restoredRuns.map((entry) => restoreAiPublishTarget(entry.review!, entry.publicationBatchId));
            checkpointTargets(targets);
          }
        }
        // Keep the analysed selection so "Phân tích tài liệu" can reuse the restored inventory.
        const restoredSelection = (inventory ?? restoredInventory)?.sourceIds
          ?.filter((sourceId) => loadedSources.some((source) => source.sourceId === sourceId));
        if (restoredSelection?.length) setSelectedIds(new Set(restoredSelection));
        // Provider cleanup runs after the job is on screen; it must never delay opening the modal,
        // and a failed check is retried by the next one (open modal, Kiểm tra lại, or reopen).
        if (active) void reconcileCleanups(result.jobs).catch(() => undefined);
      } catch (caught) {
        // Not a toast that fades on Nguồn & loại: the error stays with a Thử lại that restores again.
        if (active && !isAbortError(caught)) setRestoreError(RESTORE_FAILED_PREFIX + generationErrorMessage(caught));
      } finally {
        if (active) setRestoring(false);
      }
    })();
    return () => {
      active = false;
      retryController.abort();
    };
  }, [api, checkpointTargets, initialTemplate, loadReview, loadSources, reconcileCleanups, restoreAttempt, roomId, setReview, unfinishedPublicationBatches, userId]);

  useEffect(() => () => {
    abortRef.current?.abort();
    inventoryRecoveryAbortRef.current?.abort();
    cleanupAbortRef.current?.abort();
    // Closing supersedes every run: nothing is retried after the modal is gone.
    generationRunRef.current += 1;
    retryAbortRef.current.abort();
  }, []);

  function cancelTransientRetries() {
    retryAbortRef.current.abort();
    retryAbortRef.current = new AbortController();
    setRetryStatus(null);
  }

  /** Retries a code-less failure after 2 s, 5 s and 10 s while `active`; the footer says so meanwhile. */
  function retryTransient<T>(
    run: () => Promise<T>,
    options: { readonly reconcile?: () => Promise<T | undefined>; readonly active?: () => boolean } = {},
  ): Promise<T> {
    return withTransientRetry({
      run,
      ...options,
      signal: retryAbortRef.current.signal,
      onRetry: (attempt, total) => setRetryStatus(transientRetryText(attempt, total)),
    }).finally(() => setRetryStatus(null));
  }

  async function readJob(jobId: string): Promise<AiJobRecord> {
    return (await api.adminAi<{ job: AiJobRecord }>('get_job', { jobId })).job;
  }

  /**
   * Sends a change to a job. After a code-less failure get_job decides first: a change that
   * already took effect counts as done and is never sent twice.
   */
  function sendJobChange(
    before: AiJobRecord,
    action: string,
    args: Record<string, unknown>,
    active?: () => boolean,
    module?: Omit<Extract<JobChange, { kind: 'module' }>, 'kind'>,
  ): Promise<AiJobRecord> {
    const change: JobChange = module ? { kind: 'module', ...module } : { kind: 'outline', action, args };
    return retryTransient(
      async () => (await api.adminAi<{ job: AiJobRecord }>(action, { jobId: before.jobId, ...args })).job,
      {
        active,
        reconcile: async () => {
          const job = await readJob(before.jobId);
          return jobChangeApplied(before, job, change) ? job : undefined;
        },
      },
    );
  }

  async function refreshCleanups() {
    const result = await api.adminAi<{ jobs: readonly AiJobRecord[] }>('list_jobs');
    setRoomJobs(result.jobs);
    await reconcileCleanups(result.jobs);
  }

  async function recheckCleanup() {
    setNotice(null);
    try {
      await refreshCleanups();
    } catch (caught) {
      if (!isAbortError(caught)) setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    }
  }

  function resetLocalSession(
    nextSources: readonly SourceSummary[],
    sessionJobIds: ReadonlySet<string> = new Set(),
  ) {
    abortRef.current?.abort();
    inventoryRecoveryAbortRef.current?.abort();
    cleanupAbortRef.current?.abort();
    abortRef.current = null;
    inventoryRecoveryAbortRef.current = null;
    cleanupAbortRef.current = null;
    supersededJobsRef.current = [];
    setStep(0);
    setSources(nextSources);
    setSelectedIds(new Set(nextSources.map((source) => source.sourceId)));
    setSystemName(nextSources.find((source) => source.systemName.trim())?.systemName ?? '');
    setSoftwareVersion('');
    setEffectiveDate('');
    setInventoryJob(null);
    setTemplateRuns([]);
    setTemplateSelection(null);
    setTemplateTitle('');
    setResponsibilities('');
    setPublishTargets([]);
    setPublishProgress(null);
    setDraftSaveFailed(false);
    draftSaveResourcesRef.current = null;
    setActiveReviewIndex(0);
    setOperation(null);
    setEditingOutline(false);
    setOutlineFocusModuleId(null);
    setModuleSourceCatalog(null);
    setSelectedTemplateKind(null);
    setNotice(null);
    generationRunRef.current += 1;
    cancelTransientRetries();
    autoPumpedJobRef.current = null;
    setGenerationError(null);
    setStalled(false);
    setWaitStatus(null);
    cleanupCheckAtRef.current = null;
    setRestoreError(null);
    setPausing(false);
    setRoomJobs((current) => current.filter((job) => !sessionJobIds.has(job.jobId)));
    setCheckingCleanup(false);
    setCancelling(false);
    setResetConfirmOpen(false);
    setSourcePanelEpoch((current) => current + 1);
  }

  async function resetGeneratorSession() {
    if (!roomId || resetting || restoring) return;
    setResetting(true);
    setNotice(null);
    const jobs = [inventoryJob, ...templateRuns.map((run) => run.job)]
      .filter((job): job is AiJobRecord => Boolean(job));
    const refs = collectAiGeneratorResetTemplateRefs(templateRuns, publishTargets);
    const sessionJobIds = new Set(jobs.map((job) => job.jobId));
    try {
      const reviews = await loadAiGeneratorResetReviews({
        refs,
        getReview: async (ref) => (await api.adminAi<{ review: AdminTemplateDetail }>('get_review', {
          templateId: ref.templateId,
          version: ref.version,
        })).review,
        isMissing: (error) => errorCode(error) === 'TEMPLATE_NOT_FOUND',
      });
      await resetAiGeneratorServerState({
        jobs,
        reviews,
        cancelJob: async (job) => {
          const result = await cancelRunningAiJob(
            api,
            job.jobId,
            () => {
              abortRef.current?.abort();
              inventoryRecoveryAbortRef.current?.abort();
            },
            (call) => confirmAttempt(call, undefined, 'cancel'),
          );
          return { unconfirmed: result.unconfirmed };
        },
        deleteDraft: async (draft) => {
          await api.adminTemplates('delete', { templateId: draft.id, version: draft.version });
        },
      });
      const nextSources = await loadSources();
      clearAiResumeKeys(aiGeneratorResumeKeys(roomId, userId));
      resetLocalSession(nextSources, sessionJobIds);
      setNotice({ message: 'Đã xóa dữ liệu tạo template. Nguồn đã thêm vẫn được giữ nguyên.', tone: 'success' });
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setResetting(false);
    }
  }

  /** Puts a job the server returned on screen and in the room's job list. */
  function recordJob(next: AiJobRecord) {
    if (next.kind === 'inventory') setInventoryJob(next);
    else setTemplateJob(next);
    setRoomJobs((current) => current.some((candidate) => candidate.jobId === next.jobId)
      ? current.map((candidate) => candidate.jobId === next.jobId ? next : candidate)
      : [next, ...current]);
  }

  /** The room jobs as they are now, with `job` in its latest state. */
  function currentRoomJobs(job: AiJobRecord): readonly AiJobRecord[] {
    return [job, ...roomJobsRef.current.filter((candidate) => candidate.jobId !== job.jobId)];
  }

  /**
   * The server answered `wait`. When an earlier attempt's cleanup is unproven the room AI stays
   * fenced until it is observed stopped, so observe it again (as a reopen would) every
   * CLEANUP_RECHECK_MS; never cancel it. Best effort: a failed check is simply retried later.
   */
  async function observeWhileWaiting(job: AiJobRecord, signal: AbortSignal): Promise<void> {
    const jobs = currentRoomJobs(job);
    const unproven = attemptsNeedingCleanup(jobs, userId);
    setWaitStatus(unproven.length > 0 ? WAITING_FOR_CLEANUP_TEXT : WAITING_FOR_AI_TEXT);
    if (unproven.length === 0) return;
    const now = Date.now();
    if (cleanupCheckAtRef.current !== null && now - cleanupCheckAtRef.current < CLEANUP_RECHECK_MS) return;
    cleanupCheckAtRef.current = now;
    try {
      const updated = await reconcileAttemptCleanups(api, jobs, userId, (call) => confirmAttempt(call, signal), signal);
      // A pause, reset or close took over meanwhile: a late result must not overwrite its state.
      if (signal.aborted) return;
      mergeJobs(updated);
      const own = updated.find((candidate) => candidate.jobId === job.jobId);
      if (own) recordJob(own);
    } catch (caught) {
      if (isAbortError(caught)) throw caught;
    }
  }

  /**
   * Pumps a job until the server needs the Admin or is done. `bounded` (AI tạo nội dung and the
   * coverage reads) gives up with AI_PUMP_STALLED after GENERATION_STALL_MS of unchanged waits.
   */
  async function pump(job: AiJobRecord, preferNative = false, bounded = false): Promise<AiJobRecord> {
    if (!roomId) throw new Error('Không xác định được room để chạy AI.');
    // Read now, not from the render that started this run: a pump outlives many renders.
    const nativeBlocked = () => Boolean(selectBlockingNativeCleanup(roomJobsRef.current, userId));
    return pumpWithQuestionRecovery({
      initialJob: job,
      initialPreferNative: preferNative,
      nativeAvailable: nativeFallbackAvailable && !nativeBlocked(),
      pumpOnce: async (current, usePreferredNative, recoveringModuleLocalId) => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const provider: AiProvider = choosePumpProvider({
          job: current,
          explicitlyPreferred: usePreferredNative,
          persistedPreference: aiJobPrefersNative(current),
          nativeAvailable: nativeFallbackAvailable,
          nativeBlocked: nativeBlocked(),
        });
        const useNative = provider === 'native_chat';
        const boundedQuestionRecovery = shouldBoundNativeQuestionPoll(
          current,
          useNative,
          usePreferredNative,
        );
        return pumpAiJob({
          api,
          gateway: gatewayFor(provider),
          provider,
          gatewayFor,
          jobId: current.jobId,
          workerId: 'onboarding-ai-' + crypto.randomUUID(),
          signal: controller.signal,
          onProgress: (next) => { setWaitStatus(null); recordJob(next); },
          onWait: (waiting) => observeWhileWaiting(waiting, controller.signal),
          ...(bounded ? { maxIdleWaitMs: GENERATION_STALL_MS } : {}),
          // Only a Native questions call gets the 90 s bound, never a lesson pumped by the same loop.
          ...(boundedQuestionRecovery ? { questionPollMs: QUESTION_RECOVERY_NATIVE_TIMEOUT_MS } : {}),
          // The Native retry covers that module's questions (busy/transient successors included);
          // the next lesson goes back to the normal provider and deadline.
          ...(useNative && usePreferredNative && recoveringModuleLocalId
            && current.kind === 'template' && current.pipelineVersion === 'module_v2'
            ? { questionRecoveryOf: { moduleLocalId: recoveringModuleLocalId } } : {}),
        });
      },
      runAction: async (action, args) => {
        const result = await api.adminAi<{ job: AiJobRecord }>(action, {
          jobId: job.jobId,
          ...args,
        });
        recordJob(result.job);
        return result;
      },
    });
  }

  /**
   * One pump pass. A code-less failure (e.g. the host's 30 s tool-call timeout) says nothing about
   * the job: it is read back first, and pumped again later while `active` if that fails too.
   */
  function pumpReconciled(job: AiJobRecord, active: () => boolean): Promise<{ readonly job: AiJobRecord; readonly reconciled: boolean }> {
    return retryTransient(async () => {
      try {
        return { job: await pump(job, false, true), reconciled: false };
      } catch (caught) {
        if (!isTransportFailure(caught) || !active()) throw caught;
        let seen: AiJobRecord | undefined;
        const reconciled = await reconcileJobAfterTransportFailure({
          getJob: async () => (seen = await readJob(job.jobId)),
          signal: retryAbortRef.current.signal,
        });
        if (!reconciled) {
          // The server ended the job: that is its answer, not a slow server, so it is not retried.
          if (seen && (seen.status === 'failed' || seen.status === 'cancelled')) {
            recordJob(seen);
            throw failedJobError(seen);
          }
          throw caught;
        }
        recordJob(reconciled);
        return { job: reconciled, reconciled: true };
      }
    }, { active });
  }

  /** Checks a file before upload; returns the system name to ingest it under, or null after showing why not. */
  function prepareUpload(file: File): string | null {
    const validation = validateSourceFile(file);
    if (validation) {
      setNotice({ message: validation, tone: 'error' });
      return null;
    }
    const uploadSystemName = resolveUploadSystemName(systemName, file.name);
    if (!systemName.trim()) setSystemName(uploadSystemName);
    if (!uploadSystemName) {
      setNotice({ message: 'Nhập tên hệ thống trước khi tải tài liệu.', tone: 'error' });
      return null;
    }
    if (!roomId) {
      setNotice({ message: 'Không xác định được room để tải tài liệu.', tone: 'error' });
      return null;
    }
    return uploadSystemName;
  }

  /** Uploads a file to Roomfiles and ingests it as a source; resolves with the new source ID. */
  async function uploadAndIngest(file: File, uploadSystemName: string): Promise<string> {
    if (!roomId) throw new Error('Không xác định được room để tải tài liệu.');
    const encoded = await readFile(file);
    const folders = await ensureOnboardingRoomfiles(app, roomId);
    const uploadResult = await app.uploadFile({
      channelId: roomId,
      folderId: folders.documentsId,
      fileName: file.name,
      base64Data: encoded.dataUrl,
      mimeType: file.type || undefined,
      duplicateAction: 'keep_both',
    });
    const uploaded = normalizeUploadedRoomFile(uploadResult, {
      fileName: file.name,
      mimeType: file.type || undefined,
      size: file.size,
    });
    const result = await api.adminAi<{ source: SourceSummary }>('ingest_source', {
      operationId: crypto.randomUUID(),
      fileName: uploaded.fileName,
      mimeType: uploaded.mimeType,
      base64: encoded.base64,
      systemName: uploadSystemName,
      softwareVersion: softwareVersion.trim() || undefined,
      effectiveDate: effectiveDate || undefined,
      fileId: uploaded.fileId,
    });
    return result.source.sourceId;
  }

  async function uploadSource(file: File) {
    const uploadSystemName = prepareUpload(file);
    if (!uploadSystemName) return;
    setOperation('upload');
    setNotice(null);
    try {
      await uploadAndIngest(file, uploadSystemName);
      await loadSources();
      setNotice({ message: 'Đã thêm tài liệu nguồn.', tone: 'success' });
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setOperation(null);
    }
  }

  async function addNote(title: string, text: string) {
    setOperation('save');
    setNotice(null);
    try {
      await api.adminAi('add_admin_note', {
        operationId: crypto.randomUUID(),
        title,
        text,
      });
      await loadSources();
      setNotice({ message: 'Đã thêm ghi chú Admin.', tone: 'success' });
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setOperation(null);
    }
  }

  async function deleteSource(sourceId: string) {
    setOperation('save');
    try {
      await api.adminAi('delete_source', { sourceId });
      await loadSources();
      setNotice({ message: 'Đã xóa tài liệu nguồn.', tone: 'success' });
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setOperation(null);
    }
  }

  /** Runs (or reuses) the inventory for the current selection; resolves with the completed job. */
  async function runInventory(): Promise<AiJobRecord> {
    const completed = [inventoryJob, ...[...roomJobs].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))]
      .find((job) => job?.kind === 'inventory' && job.status === 'completed' && job.createdBy === userId
        && sameSourceIds(job.sourceIds, selectedIds));
    if (completed) {
      setInventoryJob(completed);
      if (roomId) writeAiResumeKey('onboarding:ai:inventory:' + roomId, completed.jobId);
      return completed;
    }
    inventoryRecoveryAbortRef.current?.abort();
    const recoveryController = new AbortController();
    inventoryRecoveryAbortRef.current = recoveryController;
    try {
      const reusable = inventoryJob && sameSourceIds(inventoryJob.sourceIds, selectedIds) ? inventoryJob : null;
      const preferNative = aiJobPrefersNative(reusable);
      let job = reusable?.status === 'running'
        ? reusable
        : reusable?.status === 'failed'
          ? (await api.adminAi<{ job: AiJobRecord }>('retry_job', { jobId: reusable.jobId })).job
          : (await api.adminAi<{ job: AiJobRecord }>('start_job', {
            kind: 'inventory',
            sourceIds: [...selectedIds],
            operationId: crypto.randomUUID(),
          })).job;
      setInventoryJob(job);
      if (roomId) writeAiResumeKey('onboarding:ai:inventory:' + roomId, job.jobId);
      job = await pumpWithInventoryRecovery({
        initialJob: job,
        initialPreferNative: preferNative,
        nativeAvailable: nativeFallbackAvailable && !nativeCleanupBlock,
        signal: recoveryController.signal,
        pumpOnce: pump,
        reloadJob: async (jobId) => (await api.adminAi<{ job: AiJobRecord }>('get_job', { jobId })).job,
        retryJob: async (jobId) => (await api.adminAi<{ job: AiJobRecord }>('retry_job', { jobId })).job,
      });
      setInventoryJob(job);
      return job;
    } finally {
      if (inventoryRecoveryAbortRef.current === recoveryController) {
        inventoryRecoveryAbortRef.current = null;
      }
    }
  }

  /** Step 1 primary: analyse the selected sources, then let the AI plan the chosen template kind. */
  async function analyzeAndPlan() {
    if (!templateSelection) return;
    const kind = templateSelection;
    setStep(1);
    setOperation('analyze');
    setNotice(null);
    try {
      let existing = templateRuns.find((run) => run.kind === kind);
      const stale: AiJobRecord[] = supersededJobsRef.current.splice(0);
      const staleJob = existing?.job;
      const plannedFrom = staleJob?.inventoryJobId
        ? [inventoryJob, ...roomJobs].find((job) => job?.jobId === staleJob.inventoryJobId)
        : undefined;
      if (staleJob && plannedFrom && !sameSourceIds(plannedFrom.sourceIds, selectedIds)) {
        // The run was planned from another selection: it must not drive step 2 while the new inventory runs.
        existing = undefined;
        setTemplateRuns([{ kind, job: null, review: null }]);
        setSelectedTemplateKind(null);
        stale.push(staleJob);
      }
      if (stale.length > 0 && roomId) clearAiResumeKeys(['onboarding:ai:template:' + roomId]);
      for (const job of stale) {
        if (job.status !== 'running') continue;
        try {
          const cancelled = await cancelRunningAiJob(api, job.jobId, () => abortRef.current?.abort(),
            (call) => confirmAttempt(call, undefined, 'cancel'));
          setRoomJobs((current) => current.map((candidate) => candidate.jobId === cancelled.job.jobId ? cancelled.job : candidate));
        } catch {
          // Best effort: the old job no longer belongs to this session either way.
        }
      }
      const inventory = await runInventory();
      if (inventory.status !== 'completed') throw new Error('Chưa phân tích xong tài liệu nguồn.');
      await generateTemplate(inventory, kind, existing);
    } catch (caught) {
      if (!isAbortError(caught)) setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      // A timed-out or late-cancelled attempt may still run; reconcile it in the background.
      void refreshCleanups().catch(() => undefined);
    } finally {
      setOperation(null);
    }
  }

  function chooseTemplateSelection(selection: Exclude<TemplateSelection, null>) {
    // A job planned for another kind no longer belongs to this session; the next analyse cancels it.
    for (const run of templateRuns) {
      if (run.kind !== selection && run.job && !supersededJobsRef.current.some((job) => job.jobId === run.job!.jobId)) {
        supersededJobsRef.current.push(run.job);
      }
    }
    setSelectedTemplateKind(null);
    setTemplateSelection(selection);
    setActiveReviewIndex(0);
    setTemplateRuns((current) => templateKindsForSelection(selection).map((kind) =>
      current.find((run) => run.kind === kind) ?? { kind, job: null, review: null }));
  }

  async function resumeModuleJob() {
    if (!templateJob) return;
    setOperation('analyze'); setNotice(null);
    try { const job = await pump(templateJob); setTemplateJob(job); await openCompletedModuleReview(job); }
    catch (caught) { if (!isAbortError(caught)) setNotice({ message: generationErrorMessage(caught), tone: 'error' }); }
    finally { setOperation(null); }
  }

  async function openCompletedModuleReview(job: AiJobRecord) {
    const output = job.result as { templateId?: unknown; version?: unknown } | undefined;
    if (job.status !== 'completed' || !output || typeof output.templateId !== 'string' || typeof output.version !== 'number') return;
    const { templateId, version } = output;
    await retryTransient(() => loadReview(templateId, version, false));
    setActiveReviewIndex(Math.max(0, templateRuns.findIndex((run) => run.kind === job.templateKind)));
    setStep(3);
  }

  /**
   * Xem lại & xuất bản: change one module through the job (edit lesson, edit questions or AI
   * rewrite), then pump on this step until autopilot re-approves and re-materializes the draft.
   * A rejected change keeps the editor open and explains why; nothing navigates away.
   */
  async function updateModuleThroughJob(
    action: 'update_module_lesson' | 'update_module_questions' | 'retry_module',
    args: Record<string, unknown>,
  ) {
    const current = templateJob;
    if (!current) return;
    const run = generationRunRef.current;
    const active = () => generationRunRef.current === run;
    setModuleUpdating(true);
    setOperation('save');
    setNotice(null);
    setGenerationError(null);
    setStalled(false);
    let changed: AiJobRecord;
    try {
      // An older job approves nothing by itself; the change would wait forever without autopilot.
      if (current.autoApprove !== true) {
        recordJob(await retryTransient(
          async () => (await api.adminAi<{ job: AiJobRecord }>('enable_autopilot', { jobId: current.jobId })).job,
          { active, reconcile: async () => { const job = await readJob(current.jobId); return job.autoApprove === true ? job : undefined; } },
        ));
      }
      const target = action === 'update_module_questions' || (action === 'retry_module' && args.target === 'questions')
        ? 'questions' : 'lesson';
      changed = await sendJobChange(current, action, args, active, {
        moduleLocalId: String(args.moduleLocalId), target, expectedVersion: Number(args.expectedVersion),
      });
    } catch (caught) {
      // A pause or close that superseded the retries owns the screen; it shows nothing here.
      if (!isAbortError(caught) && active()) setNotice({ message: moduleChangeErrorMessage(action, caught), tone: 'error' });
      setOperation(null);
      setModuleUpdating(false);
      return;
    }
    setOperation(null);
    try {
      await runGeneration(async () => changed);
    } finally {
      setModuleUpdating(false);
    }
  }

  function saveModuleLesson(moduleLocalId: string, lesson: GeneratedModule, expectedVersion: number) {
    void updateModuleThroughJob('update_module_lesson', { moduleLocalId, expectedVersion, module: lesson });
  }

  function saveModuleQuestions(moduleLocalId: string, questions: readonly GeneratedQuestion[], expectedVersion: number) {
    void updateModuleThroughJob('update_module_questions', { moduleLocalId, expectedVersion, questions });
  }

  function rewriteModuleLesson(moduleLocalId: string, expectedVersion: number) {
    void updateModuleThroughJob('retry_module', { moduleLocalId, target: 'lesson', expectedVersion });
  }

  /**
   * Footer "← Về độ phủ": a running job is paused first (that stops the pump); a completed one
   * cannot be paused and needs no pause, so it simply opens Kiểm tra độ phủ.
   */
  function backToCoverage() {
    if (templateJob?.status === 'running' && outlineApprovedFor(templateJob)) void pauseAndEditOutline();
    else backToOutline();
  }

  async function moduleAction(action: string, args: Record<string, unknown>): Promise<boolean> {
    if (!templateJob) return false;
    const run = generationRunRef.current;
    const active = () => generationRunRef.current === run;
    setOperation('save'); setNotice(null);
    try {
      const job = await sendJobChange(templateJob, action, args, active);
      setTemplateJob(job);
      return true;
    } catch (caught) {
      if (!isAbortError(caught) && active()) setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      return false;
    }
    finally { setOperation(null); }
  }

  /**
   * AI tạo nội dung: optionally prepares the job (retry), then pumps the autopilot until it is
   * done, needs the outline checked again, or stops without progress. A pass is repeated only
   * after progress, e.g. once question recovery handed the server a fallback to approve.
   */
  async function runGeneration(prepare?: () => Promise<AiJobRecord>): Promise<void> {
    let latest = templateJob;
    if (!latest) return;
    cancelTransientRetries();
    const run = generationRunRef.current + 1;
    generationRunRef.current = run;
    const active = () => generationRunRef.current === run;
    // This job is being pumped now; reopening the step must not start a second chain for it.
    autoPumpedJobRef.current = latest.jobId;
    // A new run observes unproven attempts at once rather than after the previous run's interval.
    cleanupCheckAtRef.current = null;
    setOperation('analyze');
    setNotice(null);
    setGenerationError(null);
    setStalled(false);
    let preparing = Boolean(prepare);
    try {
      if (prepare) {
        latest = await prepare();
        recordJob(latest);
      }
      preparing = false;
      // Progressing jobs keep going however many recoveries they need; only idle passes end the run.
      let seen = generationFingerprint(latest);
      let idlePasses = 0;
      while (active()) {
        // The banner shows only once the job could not be read back and three retries failed.
        const pass = await pumpReconciled(latest, active);
        latest = pass.job;
        const { reconciled } = pass;
        if (latest.status !== 'running' || !outlineApprovedFor(latest)) break;
        const next = generationFingerprint(latest);
        if (reconciled) {
          // Still running after a transport failure: pump again, but it counts as an idle pass.
          seen = next;
          if (++idlePasses >= MAX_IDLE_GENERATION_PASSES) break;
        } else if (next !== seen) {
          seen = next;
          idlePasses = 0;
        } else if (++idlePasses >= MAX_IDLE_GENERATION_PASSES) break;
      }
      // A pause or reset took over while the last call returned: it owns the screen now.
      if (generationRunRef.current !== run) return;
      recordJob(latest);
      if (latest.status === 'completed') {
        await openCompletedModuleReview(latest);
      } else if (latest.status === 'running' && !outlineApprovedFor(latest)) {
        // Autopilot paused itself (a source was lost or a module has none): back to coverage.
        setOutlineFocusModuleId(null);
        setEditingOutline(true);
        setStep(1);
        setNotice({ message: OUTLINE_RECHECK_NOTICE, tone: 'error' });
      } else if (latest.status === 'running') {
        setStalled(true);
      }
    } catch (caught) {
      if (generationRunRef.current === run && errorCode(caught) === AI_PUMP_STALLED) {
        // The server kept waiting without progress: say so with Thử lại instead of polling forever.
        const waited = (caught as { job?: AiJobRecord }).job;
        if (waited) recordJob(waited);
        setStalled(true);
      } else if (generationRunRef.current === run && !isAbortError(caught)) {
        setGenerationError({ message: generationErrorMessage(caught), fromPrepare: preparing });
      }
    } finally {
      if (generationRunRef.current === run) setWaitStatus(null);
      setOperation((current) => current === 'analyze' ? null : current);
    }
  }

  /** Inline Thử lại of a module autopilot could not finish. */
  function retryStuckModule(moduleLocalId: string, target: 'lesson' | 'questions', expectedVersion: number) {
    const current = templateJob;
    if (!current) return;
    void runGeneration(async () => (await api.adminAi<{ job: AiJobRecord }>('retry_module', {
      jobId: current.jobId, moduleLocalId, target, expectedVersion,
    })).job);
  }

  /**
   * Banner Thử lại: a failed job is retried first, a job still without autopilot is upgraded
   * first; otherwise the pump simply resumes.
   */
  function retryGeneration() {
    const current = templateJob;
    if (!current) return;
    void runGeneration(current.status === 'failed'
      ? async () => (await api.adminAi<{ job: AiJobRecord }>('retry_job', { jobId: current.jobId })).job
      : current.pipelineVersion === 'module_v2' && current.autoApprove !== true
        ? async () => (await api.adminAi<{ job: AiJobRecord }>('enable_autopilot', { jobId: current.jobId })).job
        : undefined);
  }

  /** Asks the provider to stop each call the pause left possibly live, and records the outcome. */
  async function confirmPausedAttempts(job: AiJobRecord) {
    // Observing while waiting turns an unproven attempt into 'unknown'; both still need the cancel.
    for (const call of job.calls.filter((item) => item.attemptRef && (item.cleanupState === 'pending' || item.cleanupState === 'unknown'))) {
      try {
        const outcome = await confirmAttempt(call, undefined, 'cancel');
        recordJob(await reportCleanup(api, job.jobId, call, outcome));
      } catch {
        // The background cleanup check retries it; resuming waits on the server until then.
      }
    }
  }

  /** Footer "Tạm dừng & sửa lộ trình": stop the pump, pause autopilot on the server, edit the outline. */
  async function pauseAndEditOutline() {
    const current = templateJob;
    if (!current) return;
    generationRunRef.current += 1;
    abortRef.current?.abort();
    cancelTransientRetries();
    setWaitStatus(null);
    setPausing(true);
    setNotice(null);
    setGenerationError(null);
    setStalled(false);
    try {
      const job = (await api.adminAi<{ job: AiJobRecord }>('pause_autopilot', { jobId: current.jobId })).job;
      recordJob(job);
      backToOutline();
      void confirmPausedAttempts(job);
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      setStalled(true);
    } finally {
      setPausing(false);
    }
  }

  /**
   * Runs a coverage action that may queue planner (S) calls, then pumps them so AI reads the new
   * material right away. The outline stays on screen; the module AI reads shows its own status.
   */
  async function coverageAction(action: string, args: Record<string, unknown>, before?: () => Promise<Record<string, unknown>>) {
    const current = templateJob;
    if (!current?.outline) return;
    const run = generationRunRef.current;
    const active = () => generationRunRef.current === run;
    setNotice(null);
    try {
      const extra = before ? await before() : {};
      setOperation('analyze');
      let job = await sendJobChange(current, action, { expectedRevision: current.outline.revision, ...args, ...extra }, active);
      setTemplateJob(job);
      // AI reads the new material right away; a pass that changed nothing (or only re-read the job
      // after a timeout) counts as idle, and two idle passes end the loop.
      const fingerprint = (value: AiJobRecord) => JSON.stringify([value.status, value.planPending, value.outline?.revision,
        value.calls.map((call) => [call.callId, call.status])]);
      let seen = fingerprint(job);
      let idlePasses = 0;
      while (job.planPending && job.status === 'running' && active()) {
        const pass = await pumpReconciled(job, active);
        job = pass.job;
        setTemplateJob(job);
        const next = fingerprint(job);
        if (pass.reconciled || next === seen) {
          if (++idlePasses >= MAX_IDLE_GENERATION_PASSES) break;
        } else idlePasses = 0;
        seen = next;
      }
    } catch (caught) {
      // A reset or close that superseded the retries owns the screen; it shows nothing here.
      if (!isAbortError(caught) && active()) setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setOperation(null);
    }
  }

  function supplementFromFile(moduleLocalId: string, file: File) {
    const uploadSystemName = prepareUpload(file);
    if (!uploadSystemName) return;
    setOperation('upload');
    void coverageAction('supplement_module_document', { moduleLocalId }, async () => {
      const sourceId = await uploadAndIngest(file, uploadSystemName);
      await loadSources();
      return { sourceId };
    });
  }

  /**
   * Footer "Tạo template": approve the outline, and only once the server confirms the approved
   * revision move to AI tạo nội dung and let autopilot write the modules.
   */
  async function approveOutlineAndStart(): Promise<void> {
    const current = templateJob;
    if (!current?.outline) return;
    setOperation('approve');
    setNotice(null);
    let approved: AiJobRecord;
    try {
      approved = (await api.adminAi<{ job: AiJobRecord }>('approve_outline', {
        jobId: current.jobId, expectedRevision: current.outline.revision,
      })).job;
      setTemplateJob(approved);
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      setOperation(null);
      return;
    }
    if (!approved.outline || approved.outlineApprovedRevision !== approved.outline.revision) {
      setNotice({ message: 'Lộ trình vừa thay đổi nên chưa thể bắt đầu. Hãy kiểm tra lại rồi bấm Tạo template.', tone: 'error' });
      setOperation(null);
      return;
    }
    setEditingOutline(false);
    setOutlineFocusModuleId(null);
    setStep(2);
    await runGeneration(async () => approved);
  }

  async function generateTemplate(inventory: AiJobRecord, kind: EmployeeType, existing: AiTemplateRun | undefined) {
    // A job planned from another inventory belongs to an older selection; start a fresh one.
    const runs: readonly AiTemplateRun[] = [existing?.job && existing.job.inventoryJobId !== inventory.jobId
      ? { kind, job: null, review: null }
      : existing ?? { kind, job: null, review: null }];
    setTemplateRuns(runs);
    try {
      const result = await generateValidatedTemplateRuns({
        selection: kind,
        responsibilities,
        runs,
        generateOne: async (current) => {
          let job = current.job?.status === 'running'
            ? current.job
            : current.job?.status === 'failed'
              ? (await api.adminAi<{ job: AiJobRecord }>('retry_job', { jobId: current.job.jobId })).job
              : (await api.adminAi<{ job: AiJobRecord }>('start_job', templateJobRequest({
                  selection: kind,
                  kind: current.kind,
                  inventoryJobId: inventory.jobId,
                  baseTitle: templateTitle,
                  responsibilities,
                  operationId: crypto.randomUUID(),
                }))).job;
          setTemplateJob(job);
          if (roomId) {
            writeAiResumeKey('onboarding:ai:template:' + roomId, job.jobId);
          }
          job = await pump(job);
          setTemplateJob(job);
          if (job.pipelineVersion === 'module_v2' && (job.status !== 'completed' || !job.result)) throw new ModuleReviewPending();
          const output = job.result as { templateId?: unknown; version?: unknown } | undefined;
          if (!output || typeof output.templateId !== 'string' || typeof output.version !== 'number') {
            throw new Error('Job AI hoàn tất nhưng chưa trả về template.');
          }
          const currentReview = await loadReview(output.templateId, output.version, false);
          return {
            kind: current.kind,
            job,
            review: currentReview,
            settings: current.settings ?? {
              passingScore: currentReview.passingScore ?? 70,
              maxAttemptsPerModule: currentReview.content?.maxAttemptsPerModule === undefined ? 2 : currentReview.content.maxAttemptsPerModule,
              learningMode: currentReview.content?.learningMode ?? 'sequential',
            },
          };
        },
        onUpdate: setTemplateRuns,
      });
      if (Object.keys(result.errors).length > 0) {
        const message = result.errors.selection ?? result.errors.responsibilities;
        setNotice({ message: message ?? 'Kiểm tra lại thông tin tạo lộ trình.', tone: 'error' });
        setStep(0);
        return;
      }
      setTemplateRuns(result.runs);
      setActiveReviewIndex(0);
      setStep(3);
    } catch (caught) {
      if (caught instanceof AiTemplateGenerationError) {
        setTemplateRuns((current) => mergeTemplateRunJobs(caught.runs, current));
        if (caught.originalError instanceof ModuleReviewPending) {
          if (outlineApprovedFor(caught.runs[0]?.job)) setStep(2);
          return;
        }
        throw caught.originalError;
      }
      throw caught;
    }
  }

  async function cancelJob(
    jobId: string,
    update: (job: AiJobRecord) => void,
  ) {
    setNotice(null);
    setCancelling(true);
    try {
      const result = await cancelRunningAiJob(
        api,
        jobId,
        () => {
          abortRef.current?.abort();
          inventoryRecoveryAbortRef.current?.abort();
        },
        (call) => confirmAttempt(call, undefined, 'cancel'),
        update,
      );
      update(result.job);
      setRoomJobs((current) => current.some((job) => job.jobId === result.job.jobId)
        ? current.map((job) => job.jobId === result.job.jobId ? result.job : job)
        : [result.job, ...current]);
      setNotice(result.unconfirmed > 0
        ? {
            message: 'Đã hủy job. PrivOS chưa xác nhận dừng tiến trình AI nền; '
              + 'chưa thể chạy lại bằng Native cho đến khi tiến trình trước đã dừng.',
            tone: 'error',
          }
        : { message: 'Đã hủy job AI và PrivOS đã xác nhận dừng tiến trình nền.', tone: 'success' });
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setCancelling(false);
      setOperation(null);
    }
  }

  async function updateReview(ops: readonly AiReviewOperation[]) {
    if (!review) return;
    setOperation('save');
    try {
      const result = await api.adminAi<{ review: AdminTemplateDetail }>('update_review', {
        templateId: review.id,
        version: review.version,
        expectedUpdatedAt: review.updatedAt,
        ops,
      });
      setReview(result.review);
      setNotice({ message: 'Đã lưu chỉnh sửa.', tone: 'success' });
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setOperation(null);
    }
  }

  async function resolveFlag(
    flag: VerificationFlag,
    action: FlagResolutionAction,
    note?: string,
    chosenEvidenceIndex?: number,
  ) {
    if (!review) return;
    setOperation('save');
    try {
      const result = await api.adminAi<{ review: AdminTemplateDetail }>('resolve_flag', {
        templateId: review.id,
        version: review.version,
        flagId: flag.id,
        resolutionAction: action,
        expectedUpdatedAt: review.updatedAt,
        note,
        chosenEvidenceIndex,
      });
      setReview(result.review);
      setNotice({ message: 'Đã cập nhật cờ kiểm chứng.', tone: 'success' });
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setOperation(null);
    }
  }

  /** Publishes the one template of this session: exactly one publication target. */
  async function publish() {
    const run = activeReviewRun;
    const runReview = run?.review;
    if (!run || !runReview) return;
    const { blockingCount } = aiReviewReadiness(runReview);
    if (blockingCount > 0) {
      setNotice({ message: 'Còn ' + blockingCount + ' cờ bắt buộc cần xử lý.', tone: 'error' });
      return;
    }
    if (!roomId) {
      setNotice({ message: 'Không xác định được room để lưu template.', tone: 'error' });
      return;
    }

    setOperation('publish');
    setNotice(null);
    try {
      // A checkpoint of this very draft resumes where it stopped; anything else starts fresh.
      const resumed = publishTargets.find((target) => target.kind === run.kind
        && aiPublishTargetKey(target.review) === aiPublishTargetKey(runReview));
      const target: AiPublishTarget = resumed ?? { kind: run.kind, review: runReview, jsonExported: false, phase: 'idle' };
      const settings: AiTemplateSettings = run.settings ?? {
        passingScore: runReview.passingScore ?? 70,
        maxAttemptsPerModule: runReview.content?.maxAttemptsPerModule === undefined ? 2 : runReview.content.maxAttemptsPerModule,
        learningMode: runReview.content?.learningMode ?? 'sequential',
      };
      const dependencies = createAiPublishDependencies({
        app,
        api,
        roomId,
        settingsByKind: { [run.kind]: settings } as Partial<Record<EmployeeType, AiTemplateSettings>>,
        onProgress: setPublishProgress,
      });
      const completed = await publishAiTemplateBatch(
        [target],
        dependencies,
        checkpointTargets,
      );
      checkpointTargets(completed);
      setPublishProgress(null);
      setNotice({ message: 'Đã xuất bản và lưu template vào Roomfiles.', tone: 'success' });
      if (!finishSuccessfulAiPublish(completed, {
        clearResume: () => clearAiResumeKeys(aiGeneratorResumeKeys(roomId, userId)),
        resetSession: () => resetLocalSession(sources),
        onComplete: () => onComplete('published'),
        onClose,
      })) {
        throw new Error('Chưa thể đóng vì còn template chưa xuất bản xong.');
      }
    } catch (caught) {
      if (caught instanceof AiPublishBatchError) {
        checkpointTargets(caught.targets);
        setNotice({ message: caught.message + ' Bấm Thử lại để tiếp tục từ bước chưa hoàn tất.', tone: 'error' });
      } else {
        setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      }
    } finally {
      setOperation(null);
    }
  }
  /**
   * Lưu template (a new session): the publish pipeline's file preparation only — folder, lesson
   * PDFs in Roomfiles, attached resources and settings — without publishing or exporting JSON.
   * Open blocking flags do not stop it; they only block publishing the draft later.
   */
  async function saveDraft() {
    const run = activeReviewRun;
    const runReview = run?.review;
    if (!run || !runReview) return;
    if (!roomId) {
      setNotice({ message: 'Không xác định được room để lưu template.', tone: 'error' });
      return;
    }
    setOperation('saveDraft');
    setNotice(null);
    setDraftSaveFailed(false);
    try {
      const settings: AiTemplateSettings = run.settings ?? {
        passingScore: runReview.passingScore ?? 70,
        maxAttemptsPerModule: runReview.content?.maxAttemptsPerModule === undefined ? 2 : runReview.content.maxAttemptsPerModule,
        learningMode: runReview.content?.learningMode ?? 'sequential',
      };
      const dependencies = createAiPublishDependencies({
        app,
        api,
        roomId,
        settingsByKind: { [run.kind]: settings } as Partial<Record<EmployeeType, AiTemplateSettings>>,
        onProgress: setPublishProgress,
      });
      // Each attempt starts from the server's draft: an earlier attempt may already have saved the settings.
      const current = (await api.adminAi<{ review: AdminTemplateDetail }>('get_review', {
        templateId: runReview.id, version: runReview.version,
      })).review;
      // PDFs a failed attempt uploaded for this very lesson content are reused, never uploaded twice.
      const key = lessonPdfKey(current);
      const uploaded = draftSaveResourcesRef.current?.key === key ? draftSaveResourcesRef.current.resources : undefined;
      await dependencies.prepareResources(
        { kind: run.kind, review: current, jsonExported: false, phase: 'idle', ...(uploaded ? { uploadedResources: uploaded } : {}) },
        (resources) => { draftSaveResourcesRef.current = { key, resources }; },
      );
      setPublishProgress(null);
      setNotice({ message: AI_DRAFT_SAVED_NOTICE, tone: 'success' });
      clearAiResumeKeys(aiGeneratorResumeKeys(roomId, userId));
      resetLocalSession(sources);
      onComplete('draft');
      onClose();
    } catch (caught) {
      setDraftSaveFailed(true);
      setNotice({ message: generationErrorMessage(caught) + ' Bấm Thử lại lưu để tiếp tục.', tone: 'error' });
    } finally {
      setOperation(null);
    }
  }
  const publishReadiness = aiReviewReadiness(activeReviewRun?.review);
  const requestErrors = useMemo(() => validateTemplateRequest({
    selection: templateSelection,
    responsibilities,
  }), [responsibilities, templateSelection]);
  const requestHasErrors = Object.keys(requestErrors).length > 0;
  const outlineApproved = outlineApprovedFor(templateJob);
  const publishing = publishTargets.some((target) => PUBLISHING_PHASES.has(target.phase));
  /** True while closing the modal would interrupt AI work; closing then asks first. */
  const aiWorking = operation === 'analyze' || operation === 'approve' || operation === 'publish' || operation === 'saveDraft' || operation === 'upload'
    || (inventoryJob?.status === 'running' && inventoryRecoveryAbortRef.current !== null)
    || Boolean(templateJob?.planPending)
    || (templateJob?.autoApprove === true && templateJob.status === 'running' && outlineApproved)
    || pausing
    || publishing;

  function requestClose() {
    if (aiWorking) setCloseConfirmOpen(true);
    else onClose();
  }

  const escapeRef = useRef<() => void>(() => undefined);
  escapeRef.current = () => {
    if (closeConfirmOpen) setCloseConfirmOpen(false);
    else if (resetConfirmOpen) { if (!resetting) setResetConfirmOpen(false); }
    else requestClose();
  };
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || escapeBelongsToTarget(event.target)) return;
      escapeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Reopen-resume: an approved, running module job continues by itself once AI tạo nội dung is open.
  const autoResumeJobId = canGenerateWithAi && !restoring && !resetting && !pausing && operation === null && step === 2
    && templateJob?.pipelineVersion === 'module_v2' && templateJob.status === 'running' && outlineApproved
    // A job that was never upgraded would stop at every draft; it waits for the banner's Thử lại.
    && templateJob.autoApprove === true
    ? templateJob.jobId
    : null;
  const runGenerationRef = useRef(runGeneration);
  runGenerationRef.current = runGeneration;
  useEffect(() => {
    if (!autoResumeJobId || autoPumpedJobRef.current === autoResumeJobId) return;
    autoPumpedJobRef.current = autoResumeJobId;
    void runGenerationRef.current();
  }, [autoResumeJobId]);

  const sourcesHint = !templateSelection
    ? 'Chọn loại template'
    : selectedIds.size === 0
      ? 'Chọn ít nhất 1 tài liệu'
      : !systemName.trim()
        ? 'Nhập tên hệ thống'
        : requestErrors.responsibilities
          ? 'Nhập 2–8 nhiệm vụ chính'
          : null;
  const canAnalyze = !busy && !restoring && !resetting && !sourcesHint && !requestHasErrors;
  // A running inventory always belongs to the current selection, so it wins over any planned run.
  const inventoryRunning = inventoryJob?.status === 'running';
  const progressJob = inventoryRunning ? inventoryJob : templateJob ?? inventoryJob;
  const planning = Boolean(templateJob) && !inventoryRunning;
  // The coverage screen owns a module job from its first plan (skeleton) until approval; failures stay on the progress card.
  const coverageJob = templateJob?.pipelineVersion === 'module_v2' && !inventoryRunning
    && templateJob.status !== 'failed' && templateJob.status !== 'cancelled'
    && (templateJob.outline || templateJob.planPending)
    ? templateJob
    : null;
  const showOutline = Boolean(coverageJob);
  const coverageCatalog = moduleSourceCatalog && moduleSourceCatalog.jobId === coverageJob?.jobId ? moduleSourceCatalog.sources : null;
  const catalogFailed = Boolean(moduleSourceCatalog && moduleSourceCatalog.jobId === coverageJob?.jobId && !moduleSourceCatalog.sources);
  const usableSectionIds = useMemo(() => new Set((coverageCatalog ?? []).flatMap((source) => source.sections
    .filter((section) => section.usable).map((section) => section.id))), [coverageCatalog]);
  const sourceNames = useMemo(() => new Map(sources.map((source) => [source.sourceId, source.fileName] as const)), [sources]);
  const coverageReadiness = coverageJob?.outline && !coverageJob.planPending && coverageCatalog
    ? outlineReadiness(coverageJob.outline, usableSectionIds, {
        templateKind: coverageJob.templateKind ?? 'normal',
        responsibilities: coverageJob.roleProfile?.responsibilities ?? [],
      })
    : null;
  const readingSupplement = Boolean(coverageJob?.calls.some((call) => call.stage === 'S' && (call.status === 'pending' || call.status === 'dispatched')));
  const progressFailed = progressJob?.status === 'failed';
  const cleanupStatus = cancelling
    ? <p className="ai-cleanup-status" role="status"><LoadingOutlined spin /> Đang chờ PrivOS xác nhận hủy tiến trình AI nền</p>
    : nativeFallbackAvailable && nativeCleanupBlock
      ? (
        <div className="ai-cleanup-status blocked" role="alert">
          <span>{NATIVE_CLEANUP_BLOCKED}{nativeCleanupBlock.call.cleanupMessage ? ' ' + nativeCleanupBlock.call.cleanupMessage : ''}</span>
          <button className="button button-secondary" type="button" disabled={checkingCleanup} onClick={() => void recheckCleanup()}>
            {checkingCleanup ? <><LoadingOutlined spin /> Đang kiểm tra…</> : <><RedoOutlined /> Kiểm tra lại trạng thái</>}
          </button>
        </div>
      )
      : null;

  function backToOutline() {
    setOutlineFocusModuleId(null);
    setEditingOutline(true);
    setStep(1);
  }

  const generationReviewLoaded = Boolean(activeTemplateRun?.review);
  const generationRunning = templateJob?.status === 'running' && outlineApproved;
  const autopilotMissing = templateJob?.pipelineVersion === 'module_v2' && generationRunning && templateJob.autoApprove !== true;
  /**
   * A failed retry/upgrade call shows its own error; a failed job explains itself, also when it
   * was restored that way; a job without autopilot is never pumped until the Admin retries.
   */
  const generationBanner = generationError?.fromPrepare
    ? generationError.message
    : templateJob?.status === 'failed'
      ? failedJobMessage(templateJob)
      : generationError?.message ?? (autopilotMissing ? AUTOPILOT_MISSING_NOTICE : null);
  /** Never silently stalled: a completed job whose review did not load can be pumped again. */
  const generationStalled = stalled
    || (templateJob?.status === 'completed' && !generationReviewLoaded && !busy && !restoring);
  /** Step 4 edits a module through its job; a legacy or job-less draft keeps the old review. */
  const reviewJob = activeReviewRun?.job?.pipelineVersion === 'module_v2' && activeReviewRun.job.moduleRuns?.length
    ? activeReviewRun.job
    : null;
  const reviewUpdating = moduleUpdating || (step === 3 && operation === 'analyze');
  const publishTarget = activeReviewRun ? publishTargets.find((target) => target.kind === activeReviewRun.kind) : undefined;
  /**
   * A new session ends with Lưu template (a draft in the library); a draft opened from the library
   * is published. A publication an earlier session already started keeps publishing.
   */
  const saveAsDraft = !initialTemplate && !activeReviewRun?.publicationBatchId && review?.status !== 'published';

  let hint: string | null = null;
  let primary: { readonly label: string; readonly icon?: ReactNode; readonly working?: boolean; readonly disabled: boolean; readonly onClick: () => void } | null = null;
  const analyzing = operation === 'analyze';
  if (step === 0) {
    hint = sourcesHint;
    primary = { label: analyzing ? 'Đang phân tích…' : 'Phân tích tài liệu', working: analyzing, disabled: !canAnalyze, onClick: () => void analyzeAndPlan() };
  } else if (step === 1) {
    if (coverageJob?.planPending && !busy) {
      // Restored while AI was still planning: nothing runs the planner until the Admin continues.
      hint = 'AI chưa lập xong lộ trình';
      primary = { label: 'Tiếp tục', disabled: restoring || resetting, onClick: () => void resumeModuleJob() };
    } else if (coverageJob) {
      const approving = operation === 'approve';
      hint = coverageJob.planPending
        ? readingSupplement ? 'AI đang đọc tài liệu bổ sung…' : 'AI đang lập lộ trình…'
        : !coverageCatalog
          ? catalogFailed ? null : 'Đang kiểm tra độ phủ…'
          : coverageReadiness?.ready ? null : coverageReadiness?.reasons[0] ?? null;
      primary = {
        label: approving ? 'Đang bắt đầu…' : 'Tạo template',
        working: approving,
        disabled: busy || restoring || resetting || coverageJob.planPending || !coverageCatalog || !coverageReadiness?.ready,
        onClick: () => void approveOutlineAndStart(),
      };
    } else {
      primary = {
        label: analyzing ? 'AI đang xử lý…' : progressFailed ? 'Thử lại' : 'Tiếp tục',
        working: analyzing,
        disabled: busy || restoring || resetting || !templateSelection || requestHasErrors,
        onClick: () => void analyzeAndPlan(),
      };
    }
  } else if (step === 2) {
    primary = {
      label: 'Xem lại template',
      disabled: busy || pausing || templateJob?.status !== 'completed' || !generationReviewLoaded,
      onClick: () => { setActiveReviewIndex(0); setStep(3); },
    };
  } else if (templateRuns.length > 0 && saveAsDraft) {
    // Saving a draft is allowed with open blocking flags: they only block publishing it.
    if (publishReadiness.blockingCount > 0) hint = `Còn ${publishReadiness.blockingCount} cờ bắt buộc — cần xử lý trước khi xuất bản`;
    else if (!activeReviewRun?.review && !reviewUpdating) hint = 'Template chưa cập nhật xong';
    primary = {
      working: operation === 'saveDraft',
      icon: <SaveOutlined aria-hidden="true" />,
      label: operation === 'saveDraft' ? 'Đang lưu…' : draftSaveFailed ? 'Thử lại lưu' : 'Lưu template',
      disabled: busy || reviewUpdating || pausing || !activeReviewRun?.review,
      onClick: () => void saveDraft(),
    };
  } else if (templateRuns.length > 0) {
    if (publishReadiness.blockingCount > 0) hint = `Còn ${publishReadiness.blockingCount} cờ bắt buộc`;
    else if (!activeReviewRun?.review && !reviewUpdating) hint = 'Template chưa cập nhật xong';
    primary = {
      working: operation === 'publish',
      label: operation === 'publish'
        ? 'Đang xuất bản…'
        : publishTargets.some((target) => target.phase === 'failed') ? 'Thử lại xuất bản' : 'Xuất bản template',
      disabled: busy || reviewUpdating || pausing || !publishReadiness.allowed,
      onClick: () => void publish(),
    };
  }
  // An automatic retry keeps the step in its working state and only says so in the footer.
  if (retryStatus) hint = retryStatus;
  // The whole job can be cancelled while it reads or plans; a supplement read is not worth losing the outline for.
  const progressCancellable = step === 1 && progressJob?.status === 'running'
    && (!showOutline || (Boolean(coverageJob?.planPending) && !readingSupplement));

  return (
    <div
      className="dialog-backdrop ai-generator-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}
    >
      <section className="ai-generator-panel" role="dialog" aria-modal="true" aria-labelledby="ai-generator-title">
        <header className="ai-generator-header">
          <h2 id="ai-generator-title">Tạo template bằng AI</h2>
          <ol className="ai-stepper" aria-label="Các bước">
            {AI_GENERATOR_STEPS.map((label, index) => (
              <li
                key={label}
                className={'ai-stepper-step' + (index === step ? ' active' : index < step ? ' done' : '')}
                aria-current={index === step ? 'step' : undefined}
              >
                <span className="ai-stepper-dot" aria-hidden="true">{index < step ? <CheckOutlined /> : index + 1}</span>
                <span className="ai-stepper-label">{label}</span>
              </li>
            ))}
          </ol>
          <button className="icon-button ai-generator-close" type="button" aria-label="Đóng" onClick={requestClose}><CloseOutlined /></button>
        </header>
        <InlineNotice notice={notice} className="ai-generator-notice" onDismiss={() => setNotice(null)} />
        <div className="ai-generator-body">
          {restoreError && (
            <div className="ai-generating-banner error ai-restore-error" role="alert">
              <span>{restoreError}</span>
              <button className="button button-secondary button-sm" type="button" disabled={restoring} onClick={() => { setRestoreError(null); setRestoreAttempt((current) => current + 1); }}>
                <RedoOutlined aria-hidden="true" /> Thử lại
              </button>
            </div>
          )}
          {!canGenerateWithAi && (
            <div className="ai-permission-blocked"><RobotOutlined /><h3>Chưa có quyền tạo nội dung AI</h3><p>Admin cần cấp quyền “Run sandbox agent” cho app trong Customize access. Các template hiện có vẫn dùng được.</p></div>
          )}
          {canGenerateWithAi && step === 0 && (
            <AiStepSources
              kind={templateSelection}
              onKind={chooseTemplateSelection}
              templateTitle={templateTitle}
              onTemplateTitle={setTemplateTitle}
              systemName={systemName}
              onSystemName={setSystemName}
              softwareVersion={softwareVersion}
              effectiveDate={effectiveDate}
              onMeta={(patch) => {
                if (patch.softwareVersion !== undefined) setSoftwareVersion(patch.softwareVersion);
                if (patch.effectiveDate !== undefined) setEffectiveDate(patch.effectiveDate);
              }}
              responsibilities={responsibilities}
              onResponsibilities={(value) => { setResponsibilities(value); if (roomId) writeAiResumeKey('onboarding:ai:responsibilities:' + roomId, value); }}
              errors={requestErrors}
              sourcePanel={(
                <SourcePanel
                  key={sourcePanelEpoch}
                  sources={sources}
                  selectedIds={selectedIds}
                  busy={busy}
                  onToggle={(sourceId) => setSelectedIds((current) => {
                    const next = new Set(current);
                    if (next.has(sourceId)) next.delete(sourceId);
                    else next.add(sourceId);
                    return next;
                  })}
                  onUpload={(file) => void uploadSource(file)}
                  onDelete={(sourceId) => void deleteSource(sourceId)}
                  onAddNote={(title, text) => void addNote(title, text)}
                />
              )}
            />
          )}
          {canGenerateWithAi && step === 1 && (
            <div className="ai-step-coverage">
              {coverageJob ? (
                coverageJob.outline && !coverageJob.planPending && !coverageCatalog
                  ? (
                    <>
                      {catalogFailed && (
                        <div className="ai-coverage-load-error" role="alert">
                          <span>{CATALOG_LOAD_FAILED}</span>
                          <button className="button button-secondary button-sm" type="button"
                            onClick={() => { setModuleSourceCatalog(null); setCatalogReload((count) => count + 1); }}><RedoOutlined aria-hidden="true" /> Thử lại</button>
                        </div>
                      )}
                      <AiCoverageSkeleton label="Đang kiểm tra độ phủ…" />
                    </>
                  )
                  : (
                    <AiStepCoverage
                      key={coverageJob.jobId}
                      job={coverageJob}
                      usableSectionIds={usableSectionIds}
                      sourceCatalog={coverageCatalog ?? []}
                      sourceNames={sourceNames}
                      busy={busy || restoring || resetting}
                      initialPickerModuleId={outlineFocusModuleId}
                      onEdit={(edits) => void moduleAction('update_outline', { expectedRevision: coverageJob.outline!.revision, edits })}
                      onUploadFor={supplementFromFile}
                      onPickSections={(moduleLocalId, sourceIds, sectionIds) => void moduleAction('supplement_module_sources', {
                        expectedRevision: coverageJob.outline!.revision, moduleLocalId, sourceIds, sectionIds,
                      })}
                      onOverride={(moduleLocalId) => void moduleAction('set_coverage_override', {
                        expectedRevision: coverageJob.outline!.revision, moduleLocalId, override: true,
                      })}
                      onRetrySupplement={(moduleLocalId, sourceId) => void coverageAction('supplement_module_document', { moduleLocalId, sourceId })}
                      onAddModule={(title, description) => void coverageAction('add_outline_module', { title, description })}
                    />
                  )
              ) : (
                <section className="ai-workspace-card ai-workspace-progress-card">
                  <h3>{planning
                    ? progressFailed ? 'AI chưa lập xong lộ trình' : 'AI đang lập lộ trình…'
                    : progressFailed ? 'AI chưa đọc xong tài liệu' : 'AI đang đọc tài liệu…'}</h3>
                  <AiMilestoneProgress
                    label={planning ? 'Lập lộ trình' : 'Phân tích tài liệu'}
                    job={progressJob}
                    milestones={planning ? templateMilestones(templateJob) : inventoryMilestones(inventoryJob, selectedIds.size)}
                  />
                </section>
              )}
              {cleanupStatus}
            </div>
          )}
          {canGenerateWithAi && step === 2 && templateJob?.pipelineVersion === 'module_v2' && (
            <AiStepGenerating
              job={templateJob}
              waitStatus={generationStalled || generationBanner ? null : waitStatus}
              stalled={generationStalled}
              error={generationBanner}
              busy={busy || pausing || restoring || resetting}
              onRetryModule={retryStuckModule}
              onRetry={retryGeneration}
            />
          )}
          {canGenerateWithAi && step === 3 && (
            <div className="ai-step-review">
              {publishProgress ? (
                <div className={'ai-publish-live-progress' + (publishProgress.error ? ' failed' : '')} role={publishProgress.error ? 'alert' : 'status'}>
                  {busy && !publishProgress.error ? <LoadingOutlined spin /> : publishProgress.error ? <CloseOutlined /> : <CheckOutlined />}
                  <div>
                    <strong>{publishProgress.error ? 'Bước hiện tại chưa hoàn tất' : saveAsDraft ? 'Đang chuẩn bị và lưu bản nháp' : 'Đang chuẩn bị và xuất bản'}</strong>
                    <span>{aiPublishProgressText(publishProgress)}</span>
                    {publishProgress.error && <small>{publishProgress.error}</small>}
                  </div>
                </div>
              ) : publishTarget && publishTarget.phase !== 'idle' ? (
                // A publication restored from its checkpoint says where it stands.
                <div className={'ai-publish-live-progress' + (publishTarget.phase === 'failed' ? ' failed' : '')} role={publishTarget.phase === 'failed' ? 'alert' : 'status'}>
                  {publishTarget.phase === 'failed' ? <CloseOutlined /> : <CheckOutlined />}
                  <div>
                    <strong>{AI_PUBLISH_PHASE_LABELS[publishTarget.phase]}</strong>
                    {publishTarget.error && <small>{publishTarget.error}</small>}
                  </div>
                </div>
              ) : null}
              {initialTemplate && restoring ? (
                // A draft opened from the library is still looking up its job: neither the module
                // review nor the legacy one is known to be right yet.
                <div className="ai-review-opening" role="status" aria-busy="true">
                  <LoadingOutlined spin aria-hidden="true" />
                  <span>Đang mở bản nháp…</span>
                </div>
              ) : reviewJob ? (
                <AiStepReview
                  job={reviewJob}
                  review={review}
                  updating={reviewUpdating}
                  busy={busy || pausing || restoring || resetting}
                  settings={activeSettings}
                  onSettings={updateActiveSettings}
                  onSaveLesson={saveModuleLesson}
                  onSaveQuestions={saveModuleQuestions}
                  onRewrite={rewriteModuleLesson}
                  onResolveFlag={(flag, action, note, index) => void resolveFlag(flag, action, note, index)}
                  sourceNames={sourceNames}
                  stalled={generationStalled}
                  error={generationBanner}
                  onRetry={retryGeneration}
                  onRetryModule={retryStuckModule}
                />
              ) : review && activeReviewRun && (
                // A draft without a module job (an older template) keeps the legacy review.
                <div className="ai-review-stage">
                  <AiReview
                    api={api}
                    review={review}
                    busy={busy}
                    onUpdated={(ops) => void updateReview(ops)}
                    onResolve={(flag, action, note, index) => void resolveFlag(flag, action, note, index)}
                  />
                  <section className="ai-review-settings-bar" aria-label="Thiết lập template đang rà soát">
                    <label className="form-field"><span>Ngưỡng đạt</span><input type="number" min={50} max={100} value={passingScore} onChange={(event) => updateActiveSettings({ passingScore: Number(event.target.value) })} /></label>
                    <label className="form-field"><span>Số lượt mỗi module</span><input type="number" min={1} max={10} value={maxAttemptsPerModule ?? ''} placeholder="Không giới hạn" onChange={(event) => updateActiveSettings({ maxAttemptsPerModule: event.target.value ? Number(event.target.value) : null })} /></label>
                    <label className="form-field"><span>Chế độ học</span><select value={learningMode} onChange={(event) => updateActiveSettings({ learningMode: event.target.value as 'sequential' | 'free' })}><option value="sequential">Tuần tự</option><option value="free">Tự do</option></select></label>
                  </section>
                </div>
              )}
            </div>
          )}
        </div>
        {canGenerateWithAi && (
          <footer className="ai-generator-footer">
            <div className="ai-generator-footer-start">
              {/* Reset lives on step 0 only; later steps go back first. */}
              {!initialTemplate && step === 0 && (
                <button className="button button-danger-ghost" type="button" disabled={busy || resetting || restoring} onClick={() => setResetConfirmOpen(true)}>
                  <DeleteOutlined aria-hidden="true" /> Xóa phiên
                </button>
              )}
              {!initialTemplate && step === 2 && generationRunning && (
                // Works while AI runs: it stops the pump; a pause, not a cancel.
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={pausing || resetting || restoring}
                  onClick={() => void pauseAndEditOutline()}
                ><PauseCircleOutlined aria-hidden="true" /> Tạm dừng & sửa lộ trình</button>
              )}
              {!initialTemplate && (step === 1 || (step === 2 && !generationRunning)) && (
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={busy || resetting}
                  onClick={() => { if (step === 2) backToOutline(); else setStep(0); }}
                >← Quay lại</button>
              )}
              {!initialTemplate && step === 3 && templateJob && (
                // Like the step-3 pause, it stays usable while a module update runs: it stops that pump.
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={pausing || resetting || restoring || operation === 'publish' || operation === 'saveDraft' || operation === 'save' || publishing}
                  onClick={backToCoverage}
                >← Về độ phủ</button>
              )}
              {progressCancellable && progressJob && (
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={cancelling}
                  onClick={() => void cancelJob(progressJob.jobId, progressJob.kind === 'inventory' ? setInventoryJob : setTemplateJob)}
                >Hủy job</button>
              )}
            </div>
            <div className="ai-generator-footer-end">
              {hint && <span className="ai-generator-hint" role={retryStatus ? 'status' : undefined}>{hint}</span>}
              {primary && (
                <button className="button button-primary" type="button" disabled={primary.disabled} onClick={primary.onClick}>
                  {primary.working ? <LoadingOutlined spin aria-hidden="true" /> : primary.icon}{primary.label}
                </button>
              )}
            </div>
          </footer>
        )}
        {!initialTemplate && (
          <ConfirmDialog
            open={resetConfirmOpen}
            danger
            title="Xóa dữ liệu tạo template?"
            description="Tiến trình AI, lộ trình, bài học, câu hỏi và các bản nháp chưa xuất bản của phiên này sẽ bị xóa. Nguồn đã thêm vẫn được giữ nguyên."
            confirmLabel="Xóa dữ liệu"
            busy={resetting}
            busyLabel="Đang xóa…"
            onCancel={() => { if (!resetting) setResetConfirmOpen(false); }}
            onConfirm={() => void resetGeneratorSession()}
          />
        )}
        <ConfirmDialog
          open={closeConfirmOpen}
          title="Đóng cửa sổ?"
          description="AI đang tạo nội dung. Nếu đóng, AI sẽ tạm dừng và tiếp tục khi bạn mở lại."
          confirmLabel="Đóng và tạm dừng"
          cancelLabel="Tiếp tục ở lại"
          onCancel={() => setCloseConfirmOpen(false)}
          onConfirm={() => { setCloseConfirmOpen(false); onClose(); }}
        />
      </section>
    </div>
  );
}
