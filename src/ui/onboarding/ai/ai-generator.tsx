import {
  CheckOutlined,
  CloseOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  RobotOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { InlineNotice, type InlineNoticeMessage } from '../components';
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
import { pumpAiJob } from './ai-pump';
import {
  pumpWithQuestionRecovery,
  shouldBoundNativeQuestionPoll,
  shouldUseNativeForPump,
} from './question-recovery';
import { AiReview } from './ai-review';
import { AiOutlineReview, type ModuleSourceCatalog } from './ai-outline-review';
import { AiModuleWorkspace } from './ai-module-workspace';
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
  moveReviewIndex,
  reviewAdvanceState,
  selectResumableTemplateRuns,
  templateJobRequest,
  templateKindsForSelection,
  validateTemplateRequest,
  type AiTemplateRun,
  type AiTemplateSettings,
  type TemplateRequestErrors,
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

export const AI_GENERATOR_STEPS = [
  'Tài liệu nguồn',
  'Phân tích',
  'Tạo lộ trình',
  'Rà soát',
  'Xuất bản',
] as const;

export function aiGeneratorStepFor(state: {
  readonly sourceCount: number;
  readonly inventoryStatus?: AiJobRecord['status'];
  readonly templateStatus?: AiJobRecord['status'];
  readonly outlineApproved?: boolean;
  readonly reviewReady?: boolean;
}): number {
  if (state.reviewReady) return 4;
  if (state.outlineApproved) return 3;
  if (state.templateStatus === 'completed') return 3;
  if (state.inventoryStatus === 'completed') return 2;
  if (state.sourceCount > 0) return 1;
  return 0;
}

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
  call: { readonly callId: string },
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
  } else if (/-lessons$/.test(step)) label = 'Tạo bài học';
  else if (/-questions$/.test(step)) label = 'Tạo câu hỏi';
  else label = step;
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

function actionableProviderFailure(message: string): string | null {
  if (/worker[_ ]failed|worker exited with code/i.test(message)) {
    const exitCode = /worker exited with code\s+(-?\d+)/i.exec(message)?.[1];
    const diagnostic = exitCode ? `worker_failed, exit code ${exitCode}` : 'worker_failed';
    return `Worker Sandbox của PrivOS đã dừng (${diagnostic}). Đây là lỗi hạ tầng `
      + 'Sandbox, không phải lỗi dữ liệu template. Admin workspace cần repair/restart Sandbox '
      + 'hoặc cấp quyền Native AI Chat, sau đó bấm Thử lại.';
  }
  if (/rejected (?:this agent's|the configured) credentials|model provider key/i.test(message)) {
    return 'PrivOS từ chối khóa nhà cung cấp model của agent AI. Admin workspace cần kiểm tra '
      + 'khóa nhà cung cấp model trong cài đặt agent, sau đó bấm Thử lại.';
  }
  if (/agent stopped unexpectedly/i.test(message)) {
    return 'Agent AI của PrivOS dừng đột ngột trước khi hoàn tất. Bấm Thử lại; nếu lặp lại, '
      + 'Admin workspace cần kiểm tra cấu hình agent.';
  }
  return null;
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

export function canPublishAiReview(flags: readonly VerificationFlag[]): {
  allowed: boolean;
  blockingCount: number;
} {
  return aiReviewReadiness({ flags } as Pick<AdminTemplateDetail, 'flags'>);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    const code = (record.data as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function generationErrorMessage(error: unknown): string {
  const providerMessage = error instanceof Error ? actionableProviderFailure(error.message) : null;
  if (providerMessage) return providerMessage;
  const code = errorCode(error);
  const messages: Record<string, string> = {
    SOURCE_TOO_LARGE: 'Tài liệu vượt quá giới hạn 2 MB.',
    SOURCE_TYPE_UNSUPPORTED: 'Định dạng tài liệu chưa được hỗ trợ.',
    SOURCE_NO_TEXT: 'Không tìm thấy lớp chữ trong tài liệu; phiên bản này chưa hỗ trợ OCR.',
    SOURCE_DUPLICATE: 'Tài liệu này đã có trong danh sách nguồn.',
    ROLE_PROFILE_INVALID: 'Hồ sơ vai trò cần từ 2 đến 8 nhiệm vụ duy nhất.',
    AI_DISPATCH_UNKNOWN: 'Không xác định được trạng thái lần gọi AI. Hãy bấm Thử lại để tạo một lần gọi an toàn mới.',
    AI_TIMEOUT: 'AI xử lý quá thời gian. Hãy thử lại job.',
    AI_OUTPUT_INVALID: 'AI chưa tạo được cấu trúc hợp lệ sau các lần tự sửa.',
    TEMPLATE_FLAGS_BLOCKING: 'Cần xử lý hết cờ bắt buộc trước khi xuất bản.',
    REVIEW_CONFLICT: 'Template vừa được cập nhật ở nơi khác. Hãy tải lại bản mới nhất.',
    JOB_OWNER_REQUIRED: 'Job AI này do Admin khác tạo; chỉ người tạo mới tiếp tục hoặc hủy được.',
  };
  if (code && messages[code]) return messages[code];
  return error instanceof Error && error.message ? error.message : 'Không thể hoàn tất yêu cầu AI.';
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

function contextualPublishError(
  review: AdminTemplateDetail,
  error: unknown,
  moduleTitle?: string,
): Error {
  const detail = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Không thể hoàn tất thao tác Roomfiles.';
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
      let review = (await input.api.adminAi<{ review: AdminTemplateDetail }>('get_review', { templateId: target.review.id, version: target.review.version })).review;
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
          const contextual = contextualPublishError(review, error, module.title);
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
        const contextual = contextualPublishError(review, error);
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
        const contextual = contextualPublishError(review, error);
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
    readonly onComplete: () => void;
    readonly onClose: () => void;
  },
): boolean {
  if (targets.length === 0 || targets.some((target) => target.phase !== 'completed' || !target.preparedReview
    || target.publishedTemplate?.status !== 'published' || !target.jsonExported
    || aiPublishTargetKey(target.review) !== aiPublishTargetKey(target.preparedReview)
    || aiPublishTargetKey(target.review) !== aiPublishTargetKey(target.publishedTemplate))) return false;
  callbacks.clearResume();
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
export function AiTemplateSelection({
  selection,
  templateTitle,
  responsibilities,
  responsibilityCount,
  errors,
  onSelect,
  onTemplateTitleChange,
  onResponsibilitiesChange,
}: {
  readonly selection: TemplateSelection;
  readonly templateTitle: string;
  readonly responsibilities: string;
  readonly responsibilityCount: number;
  readonly errors: TemplateRequestErrors;
  readonly onSelect: (selection: Exclude<TemplateSelection, null>) => void;
  readonly onTemplateTitleChange: (value: string) => void;
  readonly onResponsibilitiesChange: (value: string) => void;
}) {
  const advanced = selection === 'advanced' || selection === 'both';
  return (
    <section className="ai-request-fields" aria-labelledby="ai-template-selection-title">
      <span className="section-kicker">LOẠI LỘ TRÌNH</span>
      <h3 id="ai-template-selection-title">Chọn đối tượng onboarding *</h3>
      <div
        className="ai-template-kind"
        role="radiogroup"
        aria-describedby={errors.selection ? 'ai-template-selection-error' : undefined}
      >
        <button
          className={selection === 'normal' ? 'active' : ''}
          type="button"
          role="radio"
          aria-checked={selection === 'normal'}
          onClick={() => onSelect('normal')}
        >
          <strong>Template 1</strong>
          <span>Kiến thức chung cho nhân sự thông thường</span>
        </button>
        <button
          className={selection === 'advanced' ? 'active' : ''}
          type="button"
          role="radio"
          aria-checked={selection === 'advanced'}
          onClick={() => onSelect('advanced')}
        >
          <strong>Template 2</strong>
          <span>Chuyên sâu theo vai trò và nhiệm vụ</span>
        </button>
        <button
          className={selection === 'both' ? 'active' : ''}
          type="button"
          role="radio"
          aria-checked={selection === 'both'}
          onClick={() => onSelect('both')}
        >
          <strong>Cả hai</strong>
          <span>Tạo Template 1 trước, sau đó Template 2</span>
        </button>
      </div>
      {errors.selection && (
        <p className="ai-field-error" id="ai-template-selection-error" role="alert">
          {errors.selection}
        </p>
      )}
      <label className="form-field">
        <span>Tên template (không bắt buộc)</span>
        <input
          value={templateTitle}
          onChange={(event) => onTemplateTitleChange(event.target.value)}
          placeholder="AI sẽ tự đặt nếu để trống"
        />
      </label>
      {advanced && (
        <div className="ai-role-form">
          <label className="form-field form-wide">
            <span>Nhiệm vụ chính * (2–8 dòng)</span>
            <textarea
              rows={6}
              value={responsibilities}
              aria-invalid={Boolean(errors.responsibilities)}
              aria-describedby={errors.responsibilities ? 'ai-responsibilities-error' : 'ai-responsibilities-count'}
              onChange={(event) => onResponsibilitiesChange(event.target.value)}
              placeholder={'Mỗi nhiệm vụ một dòng\nVí dụ: Tạo và gửi báo giá'}
            />
            <small id="ai-responsibilities-count">{responsibilityCount}/8 nhiệm vụ hợp lệ</small>
            {errors.responsibilities && (
              <small className="ai-field-error" id="ai-responsibilities-error">
                {errors.responsibilities}
              </small>
            )}
          </label>
        </div>
      )}
    </section>
  );
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
  onComplete: () => void;
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
  const [step, setStep] = useState(initialTemplate ? 3 : 0);
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
  const [busy, setBusy] = useState(false);
  const [editingOutline, setEditingOutline] = useState(false);
  const [outlineFocusModuleId, setOutlineFocusModuleId] = useState<string | null>(null);
  const [moduleSourceCatalog, setModuleSourceCatalog] = useState<ModuleSourceCatalog>([]);
  const [selectedTemplateKind, setSelectedTemplateKind] = useState<EmployeeType | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState(() => roomId ? readAiResumeKey('onboarding:ai:module:' + roomId) ?? '' : '');
  const [notice, setNotice] = useState<InlineNoticeMessage | null>(null);
  const [roomJobs, setRoomJobs] = useState<readonly AiJobRecord[]>([]);
  const [checkingCleanup, setCheckingCleanup] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const cleanupAbortRef = useRef<AbortController | null>(null);
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
  const activateTemplateRun = useCallback((run: AiTemplateRun, index: number) => {
    setSelectedTemplateKind(run.kind);
    setOutlineFocusModuleId(null);
    setEditingOutline(false);
    if (run.review) {
      setActiveReviewIndex(index);
      setStep(3);
      return;
    }
    const outlineApproved = run.job?.pipelineVersion === 'module_v2'
      && Boolean(run.job.outline)
      && run.job.outlineApprovedRevision === run.job.outline?.revision;
    setStep(outlineApproved || run.job?.status === 'completed' ? 3 : 2);
  }, []);
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
    setSelectedIds((current) => current.size > 0
      ? new Set([...current].filter((sourceId) => result.sources.some((source) => source.sourceId === sourceId)))
      : new Set(result.sources.map((source) => source.sourceId)));
    return result.sources;
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

  useEffect(() => {
    let active = true;
    if (templateJob?.pipelineVersion === 'module_v2' && (editingOutline || templateJob.outlineApprovedRevision !== templateJob.outline?.revision)) {
      void api.adminAi<{ sources: ModuleSourceCatalog }>('list_module_sources', { jobId: templateJob.jobId }).then((result) => { if (active) setModuleSourceCatalog(result.sources); }).catch(() => { if (active) setModuleSourceCatalog([]); });
    }
    return () => { active = false; };
  }, [api, templateJob?.jobId, templateJob?.pipelineVersion, templateJob?.outlineApprovedRevision, templateJob?.outline?.revision, editingOutline, sources]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await loadSources();
        if (initialTemplate) {
          const loaded = await loadReview(initialTemplate.id, initialTemplate.version);
          setTemplateSelection(loaded.employeeType);
          return;
        }
        const result = await api.adminAi<{ jobs: readonly AiJobRecord[]; publicationBatches?: readonly AiPublicationBatch[] }>('list_jobs');
        if (!active) return;
        setRoomJobs(result.jobs);
        const inventoryId = roomId ? readAiResumeKey('onboarding:ai:inventory:' + roomId) : null;
        const legacyTemplateId = roomId ? readAiResumeKey('onboarding:ai:template:' + roomId) : null;
        const resumeJobIds = roomId ? {
          normal: readAiResumeKey('onboarding:ai:template:' + roomId + ':normal'),
          advanced: readAiResumeKey('onboarding:ai:template:' + roomId + ':advanced'),
        } : {};
        const { inventory } = selectResumableAiJobs({
          jobs: result.jobs,
          inventoryJobId: inventoryId,
          templateJobId: legacyTemplateId,
          userId,
        });
        let restoredRuns = selectResumableTemplateRuns({
          jobs: result.jobs,
          publicationBatches: result.publicationBatches,
          resumeJobIds,
          legacyTemplateJobId: legacyTemplateId,
          userId,
        });
        if (restoredRuns.length === 1 && roomId && readAiResumeKey('onboarding:ai:selection:' + roomId) === 'both') {
          restoredRuns = (['normal', 'advanced'] as const).map((kind) => restoredRuns.find((run) => run.kind === kind) ?? { kind, job: null, review: null });
        }
        const restoredInventoryId = restoredRuns.find((run) => run.job?.inventoryJobId)?.job?.inventoryJobId;
        const restoredInventory = result.jobs.find((job) => job.kind === 'inventory' && job.jobId === restoredInventoryId);
        setInventoryJob(inventory ?? restoredInventory ?? null);
        setTemplateRuns(restoredRuns);
        if (restoredRuns.length > 0) {
          setTemplateSelection(restoredRuns.length > 1 ? 'both' : restoredRuns[0].kind);
          const advancedProfile = restoredRuns.find((run) => run.kind === 'advanced')?.job?.roleProfile;
          if (advancedProfile) {
            setResponsibilities(advancedProfile.responsibilities.join('\n'));
          } else if (roomId) setResponsibilities(readAiResumeKey('onboarding:ai:responsibilities:' + roomId) ?? '');
          if (roomId) {
            for (const run of restoredRuns) {
              if (run.job) writeAiResumeKey('onboarding:ai:template:' + roomId + ':' + run.kind, run.job.jobId);
            }
            if (legacyTemplateId) clearAiResumeKeys(['onboarding:ai:template:' + roomId]);
          }
          for (const run of restoredRuns) {
            const output = run.publicationTarget ?? (run.job?.status === 'completed' && run.job.result && typeof run.job.result === 'object'
              ? run.job.result as { templateId?: unknown; version?: unknown }
              : undefined);
            if (output && typeof output.templateId === 'string' && typeof output.version === 'number') {
              const loaded = await loadReview(output.templateId, output.version, false);
              restoredRuns = restoredRuns.map((entry) => entry.kind === run.kind ? { ...entry, review: loaded } : entry);
            }
          }
          setTemplateRuns(restoredRuns);
          const firstReview = restoredRuns.findIndex((run) => run.review);
          if (firstReview >= 0) { setActiveReviewIndex(firstReview); setStep(3); }
          else {
            const draftReviewIndex = restoredRuns.findIndex((run) => run.job?.pipelineVersion === 'module_v2'
              && Boolean(run.job.outline)
              && run.job.outlineApprovedRevision === run.job.outline?.revision);
            if (draftReviewIndex >= 0) {
              setSelectedTemplateKind(restoredRuns[draftReviewIndex].kind);
              setStep(3);
            } else setStep(2);
          }
          if (restoredRuns.every((run) => run.review) && restoredRuns.some((run) => run.publicationBatchId || run.review?.content?.publication || run.review?.status === 'published')) {
            const targets = restoredRuns.map((run) => restoreAiPublishTarget(run.review!, run.publicationBatchId));
            checkpointTargets(targets); setStep(4);
          }
        } else if (inventory?.status === 'completed') setStep(2);
        else if (inventory) setStep(1);
        // Provider cleanup runs after the job is on screen; it must never delay opening the modal.
        if (active) void reconcileCleanups(result.jobs);
      } catch (caught) {
        if (active) setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      }
    })();
    return () => {
      active = false;
    };
  }, [api, checkpointTargets, initialTemplate, loadReview, loadSources, reconcileCleanups, roomId, userId]);

  useEffect(() => () => {
    abortRef.current?.abort();
    cleanupAbortRef.current?.abort();
  }, []);

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

  async function pump(job: AiJobRecord, preferNative = false): Promise<AiJobRecord> {
    if (!roomId) throw new Error('Không xác định được room để chạy AI.');
    const recordProgress = (next: AiJobRecord) => {
      if (next.kind === 'inventory') setInventoryJob(next);
      else setTemplateJob(next);
      setRoomJobs((current) => current.some((candidate) => candidate.jobId === next.jobId)
        ? current.map((candidate) => candidate.jobId === next.jobId ? next : candidate)
        : [next, ...current]);
    };
    return pumpWithQuestionRecovery({
      initialJob: job,
      initialPreferNative: preferNative,
      nativeAvailable: nativeFallbackAvailable && !nativeCleanupBlock,
      pumpOnce: async (current, usePreferredNative) => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const useNative = nativeFallbackAvailable && shouldUseNativeForPump(
          current,
          usePreferredNative,
          aiJobPrefersNative(current),
        );
        const boundedQuestionRecovery = shouldBoundNativeQuestionPoll(
          current,
          useNative,
          usePreferredNative,
        );
        if (useNative && nativeCleanupBlock) throw new Error(NATIVE_CLEANUP_BLOCKED);
        const provider: AiProvider = useNative ? 'native_chat' : 'sandbox';
        return pumpAiJob({
          api,
          gateway: gatewayFor(provider),
          provider,
          gatewayFor,
          jobId: current.jobId,
          workerId: 'onboarding-ai-' + crypto.randomUUID(),
          signal: controller.signal,
          onProgress: recordProgress,
          ...(boundedQuestionRecovery ? { maxPollMs: QUESTION_RECOVERY_NATIVE_TIMEOUT_MS } : {}),
        });
      },
      runAction: async (action, args) => {
        const result = await api.adminAi<{ job: AiJobRecord }>(action, {
          jobId: job.jobId,
          ...args,
        });
        recordProgress(result.job);
        return result;
      },
    });
  }

  async function uploadSource(file: File) {
    const validation = validateSourceFile(file);
    if (validation) {
      setNotice({ message: validation, tone: 'error' });
      return;
    }
    const uploadSystemName = resolveUploadSystemName(systemName, file.name);
    if (!systemName.trim()) setSystemName(uploadSystemName);
    if (!uploadSystemName) {
      setNotice({ message: 'Nhập tên hệ thống trước khi tải tài liệu.', tone: 'error' });
      return;
    }
    if (!roomId) {
      setNotice({ message: 'Không xác định được room để tải tài liệu.', tone: 'error' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
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
      await api.adminAi('ingest_source', {
        operationId: crypto.randomUUID(),
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        base64: encoded.base64,
        systemName: uploadSystemName,
        softwareVersion: softwareVersion.trim() || undefined,
        effectiveDate: effectiveDate || undefined,
        fileId: uploaded.fileId,
      });
      await loadSources();
      setNotice({ message: 'Đã thêm tài liệu nguồn.', tone: 'success' });
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function addNote(title: string, text: string) {
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function deleteSource(sourceId: string) {
    setBusy(true);
    try {
      await api.adminAi('delete_source', { sourceId });
      await loadSources();
      setNotice({ message: 'Đã xóa tài liệu nguồn.', tone: 'success' });
    } catch (caught) {
      setNotice({ message: generationErrorMessage(caught), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function analyze() {
    setBusy(true);
    setNotice(null);
    try {
      const preferNative = aiJobPrefersNative(inventoryJob);
      let job = inventoryJob?.status === 'running'
        ? inventoryJob
        : inventoryJob?.status === 'failed'
          ? (await api.adminAi<{ job: AiJobRecord }>('retry_job', { jobId: inventoryJob.jobId })).job
        : (await api.adminAi<{ job: AiJobRecord }>('start_job', {
          kind: 'inventory',
          sourceIds: [...selectedIds],
          operationId: crypto.randomUUID(),
        })).job;
      setInventoryJob(job);
      if (roomId) writeAiResumeKey('onboarding:ai:inventory:' + roomId, job.jobId);
      job = await pump(job, preferNative);
      setInventoryJob(job);
      setStep(2);
      setNotice({ message: 'Đã phân tích xong tài liệu nguồn.', tone: 'success' });
    } catch (caught) {
      if (!isAbortError(caught)) {
        setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      }
      // A timed-out or late-cancelled attempt may still run; reconcile it in the background.
      void refreshCleanups().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function chooseTemplateSelection(selection: Exclude<TemplateSelection, null>) {
    setSelectedTemplateKind(null);
    setTemplateSelection(selection);
    if (roomId) writeAiResumeKey('onboarding:ai:selection:' + roomId, selection);
    setActiveReviewIndex(0);
    setTemplateRuns((current) => templateKindsForSelection(selection).map((kind) =>
      current.find((run) => run.kind === kind) ?? { kind, job: null, review: null }));
  }

  async function resumeModuleJob() {
    if (!templateJob) return;
    setBusy(true); setNotice(null);
    try { const job = await pump(templateJob, aiJobPrefersNative(templateJob)); setTemplateJob(job); await openCompletedModuleReview(job); }
    catch (caught) { if (!isAbortError(caught)) setNotice({ message: generationErrorMessage(caught), tone: 'error' }); }
    finally { setBusy(false); }
  }

  async function openCompletedModuleReview(job: AiJobRecord) {
    const output = job.result as { templateId?: unknown; version?: unknown } | undefined;
    if (job.status !== 'completed' || !output || typeof output.templateId !== 'string' || typeof output.version !== 'number') return;
    await loadReview(output.templateId, output.version, false);
    setActiveReviewIndex(Math.max(0, templateRuns.findIndex((run) => run.kind === job.templateKind)));
    setStep(3);
  }

  async function editApprovedModules() {
    if (!review) return;
    setBusy(true); setNotice(null);
    try {
      const job = activeReviewRun.job ?? (await api.adminAi<{ job: AiJobRecord }>('get_job', { jobId: review.jobId })).job;
      setTemplateRuns((current) => current.map((run) => run.kind === activeReviewRun.kind
        ? { ...run, job, review: null }
        : run));
      setSelectedTemplateKind(activeReviewRun.kind);
      setOutlineFocusModuleId(null);
      setStep(3);
    } catch (caught) { setNotice({ message: generationErrorMessage(caught), tone: 'error' }); }
    finally { setBusy(false); }
  }

  async function moduleAction(action: string, args: Record<string, unknown>, resume = false): Promise<boolean> {
    if (!templateJob) return false;
    setBusy(true); setNotice(null);
    try {
      let job = (await api.adminAi<{ job: AiJobRecord }>(action, { jobId: templateJob.jobId, ...args })).job;
      setTemplateJob(job);
      if (resume) {
        job = await pump(job); setTemplateJob(job);
        await openCompletedModuleReview(job);
      }
      return true;
    } catch (caught) {
      if (!isAbortError(caught)) setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      return false;
    }
    finally { setBusy(false); }
  }

  async function approveOutlineAndStartDrafting(): Promise<void> {
    if (!templateJob?.outline) return;
    setEditingOutline(false);
    setOutlineFocusModuleId(null);
    setStep(3);
    const approved = await moduleAction('approve_outline', { expectedRevision: templateJob.outline.revision }, true);
    if (!approved) setStep(2);
  }

  async function generateTemplate() {
    if (!inventoryJob || inventoryJob.status !== 'completed') return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await generateValidatedTemplateRuns({
        selection: templateSelection,
        responsibilities,
        runs: templateRuns,
        generateOne: async (current) => {
          const preferNative = aiJobPrefersNative(current.job);
          let job = current.job?.status === 'running'
            ? current.job
            : current.job?.status === 'failed'
              ? (await api.adminAi<{ job: AiJobRecord }>('retry_job', { jobId: current.job.jobId })).job
              : (await api.adminAi<{ job: AiJobRecord }>('start_job', templateJobRequest({
                  selection: templateSelection,
                  kind: current.kind,
                  inventoryJobId: inventoryJob.jobId,
                  baseTitle: templateTitle,
                  responsibilities,
                  operationId: crypto.randomUUID(),
                }))).job;
          setTemplateJob(job);
          if (roomId) {
            writeAiResumeKey('onboarding:ai:template:' + roomId + ':' + current.kind, job.jobId);
          }
          job = await pump(job, preferNative);
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
        return;
      }
      setTemplateRuns(result.runs);
      setActiveReviewIndex(Math.max(0, result.runs.findIndex((run) => run.review && !templateRuns.find((prior) => prior.kind === run.kind)?.review)));
      setStep(3);
      setNotice({
        message: result.runs.length === 2
          ? 'AI đã tạo hai bản nháp theo thứ tự Template 1 rồi Template 2.'
          : 'AI đã tạo bản nháp để Admin rà soát.',
        tone: 'success',
      });
    } catch (caught) {
      if (caught instanceof AiTemplateGenerationError && caught.originalError instanceof ModuleReviewPending) { setTemplateRuns((current) => mergeTemplateRunJobs(caught.runs, current)); return; }
      if (caught instanceof AiTemplateGenerationError) {
        setTemplateRuns((current) => mergeTemplateRunJobs(caught.runs, current));
      }
      if (!isAbortError(caught)) {
        setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      }
      // A timed-out or late-cancelled attempt may still run; reconcile it in the background.
      void refreshCleanups().catch(() => undefined);
    } finally {
      setBusy(false);
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
        () => abortRef.current?.abort(),
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
      setBusy(false);
    }
  }

  async function updateReview(ops: readonly AiReviewOperation[]) {
    if (!review) return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function resolveFlag(
    flag: VerificationFlag,
    action: FlagResolutionAction,
    note?: string,
    chosenEvidenceIndex?: number,
  ) {
    if (!review) return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function publish() {
    const reviewedRuns = templateRuns.filter(
      (run): run is AiTemplateRun & { readonly review: AdminTemplateDetail } => Boolean(run.review),
    );
    if (reviewedRuns.length !== templateRuns.length || reviewedRuns.length === 0) return;
    const blockingCount = reviewedRuns.reduce(
      (sum, run) => sum + aiReviewReadiness(run.review).blockingCount,
      0,
    );
    if (blockingCount > 0) {
      setNotice({ message: 'Còn ' + blockingCount + ' cờ bắt buộc cần xử lý.', tone: 'error' });
      return;
    }
    if (!roomId) {
      setNotice({ message: 'Không xác định được room để lưu template.', tone: 'error' });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const targets = publishTargets.length > 0
        ? publishTargets
        : reviewedRuns.map((run): AiPublishTarget => ({
            kind: run.kind,
            review: run.review,
            jsonExported: false,
            phase: 'idle',
          }));
      const settingsByKind = Object.fromEntries(reviewedRuns.map((run) => [
        run.kind,
        run.settings ?? {
          passingScore: run.review.passingScore ?? 70,
          maxAttemptsPerModule: run.review.content?.maxAttemptsPerModule === undefined ? 2 : run.review.content.maxAttemptsPerModule,
          learningMode: run.review.content?.learningMode ?? 'sequential',
        },
      ])) as Partial<Record<EmployeeType, AiTemplateSettings>>;
      const dependencies = createAiPublishDependencies({
        app,
        api,
        roomId,
        settingsByKind,
        onProgress: setPublishProgress,
      });
      const completed = await publishAiTemplateBatch(
        targets,
        dependencies,
        checkpointTargets,
      );
      checkpointTargets(completed);
      setPublishProgress(null);
      setNotice({
        message: completed.length > 1
          ? 'Đã xuất bản và lưu cả hai template vào Roomfiles.'
          : 'Đã xuất bản và lưu template vào Roomfiles.',
        tone: 'success',
      });
      if (!finishSuccessfulAiPublish(completed, {
        clearResume: () => clearAiResumeKeys([
          'onboarding:ai:inventory:' + roomId,
          'onboarding:ai:template:' + roomId,
          'onboarding:ai:template:' + roomId + ':normal',
          'onboarding:ai:template:' + roomId + ':advanced',
          'onboarding:ai:publish:' + roomId + ':' + userId,
          'onboarding:ai:selection:' + roomId,
        ]),
        onComplete,
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
      setBusy(false);
    }
  }
  const reviewNavigation = useMemo(
    () => reviewAdvanceState(templateRuns, activeReviewIndex),
    [activeReviewIndex, templateRuns],
  );
  const publishReadiness = useMemo(() => {
    const blockingCount = templateRuns.reduce(
      (sum, run) => sum + aiReviewReadiness(run.review).blockingCount,
      0,
    );
    return {
      allowed: templateRuns.length > 0
        && templateRuns.every((run) => Boolean(run.review))
        && blockingCount === 0,
      blockingCount,
    };
  }, [templateRuns]);
  const roleResponsibilities = responsibilities.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  const requestErrors = useMemo(() => validateTemplateRequest({
    selection: templateSelection,
    responsibilities,
  }), [responsibilities, templateSelection]);
  const requestHasErrors = Object.keys(requestErrors).length > 0;
  const activeTemplateIndex = activeTemplateRun
    ? templateRuns.findIndex((run) => run.kind === activeTemplateRun.kind)
    : -1;
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

  return (
    <section className="ai-generator-panel" role="dialog" aria-modal="true" aria-labelledby="ai-generator-title">
      <header className="ai-generator-header">
        <div><span className="section-kicker"><RobotOutlined /> AI ONBOARDING</span><h2 id="ai-generator-title">{initialTemplate ? 'Rà soát template AI' : 'Tạo template từ tài liệu'}</h2><p>AI dựng lộ trình có dẫn chứng; Admin rà soát và quyết định xuất bản.</p></div>
        <button className="icon-button" type="button" aria-label="Đóng" onClick={onClose}><CloseOutlined /></button>
      </header>
      <ol className="ai-generator-steps">{AI_GENERATOR_STEPS.map((label, index) => (
        <li className={index === step ? 'active' : index < step ? 'done' : ''} key={label}>
          <span>{index < step ? <CheckOutlined /> : index + 1}</span><small>{label}</small>
        </li>
      ))}</ol>
      <InlineNotice notice={notice} className="ai-generator-notice" onDismiss={() => setNotice(null)} />
      <div className="ai-generator-body">
        {!canGenerateWithAi && (
          <div className="ai-permission-blocked"><RobotOutlined /><h3>Chưa có quyền tạo nội dung AI</h3><p>Admin cần cấp quyền “Run sandbox agent” cho app trong Customize access. Các template hiện có vẫn dùng được.</p></div>
        )}
        {canGenerateWithAi && step === 0 && (
          <>
            <div className="ai-source-metadata">
              <label className="form-field"><span>Tên hệ thống *</span><input value={systemName} onChange={(event) => setSystemName(event.target.value)} placeholder="Ví dụ: PrivOS" /></label>
              <label className="form-field"><span>Phiên bản</span><input value={softwareVersion} onChange={(event) => setSoftwareVersion(event.target.value)} placeholder="Ví dụ: 2.4" /></label>
              <label className="form-field"><span>Ngày hiệu lực</span><input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></label>
            </div>
            <SourcePanel
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
          </>
        )}
        {canGenerateWithAi && step === 1 && (
          <div className="ai-workspace">
            <section className="ai-workspace-card ai-workspace-input-card">
              <span className="section-kicker">NGUỒN ĐẦU VÀO</span>
              <h3>Phân tích {selectedIds.size} nguồn tài liệu</h3>
              <p>AI lập kho tính năng, thuật ngữ và đánh dấu các điểm cần Admin xác minh.</p>
              <ul className="ai-workspace-source-list">
                {sources.filter((source) => selectedIds.has(source.sourceId)).map((source) => (
                  <li key={source.sourceId}><CheckOutlined /><span>{source.fileName}</span></li>
                ))}
              </ul>
              <div className="ai-output-summary">
                <strong>Kết quả dự kiến</strong>
                <span>Kho kiến thức hợp nhất</span>
                <span>Các mâu thuẫn cần rà soát</span>
              </div>
            </section>
            <section className="ai-workspace-card ai-workspace-progress-card">
              <span className="section-kicker">TIẾN TRÌNH AI</span>
              <AiMilestoneProgress
                label="Phân tích tài liệu"
                job={inventoryJob}
                milestones={inventoryMilestones(inventoryJob, selectedIds.size)}
              />
            </section>
            <div className="ai-workspace-actions">
              <p className="ai-keep-open">Có thể đóng modal; lần mở sau app tiếp tục từ job đã lưu.</p>
              <div className="ai-workspace-buttons">
                <button className="button button-primary" type="button" disabled={busy || selectedIds.size === 0} onClick={() => void analyze()}>
                  {busy ? <><LoadingOutlined spin /> Đang phân tích…</> : inventoryJob?.status === 'failed' ? <><RedoOutlined /> Thử lại</> : inventoryJob?.status === 'running' ? <><PlayCircleOutlined /> Tiếp tục phân tích</> : <><PlayCircleOutlined /> Phân tích tài liệu</>}
                </button>
                {inventoryJob?.status === 'running' && <button className="button button-secondary" type="button" disabled={cancelling} onClick={() => void cancelJob(inventoryJob.jobId, setInventoryJob)}>Hủy job</button>}
              </div>
              {cleanupStatus}
            </div>
          </div>
        )}
        {canGenerateWithAi && step === 2 && (
          <div className="ai-workspace">
            {templateJob?.pipelineVersion === 'module_v2' && templateJob.outline ? (
              <section className="ai-workspace-card ai-module-stage">
                {templateRuns.length > 1 && <nav className="ai-module-actions" aria-label="Chọn template">{templateRuns.map((run, index) => <button type="button" key={run.kind} aria-pressed={run.kind === activeTemplateRun?.kind} onClick={() => activateTemplateRun(run, index)}>{run.job?.status === 'completed' ? 'Xem' : 'Tiếp tục'} Template {index + 1}</button>)}</nav>}
                <AiOutlineReview key={templateJob.jobId} outline={templateJob.outline} templateKind={templateJob.templateKind ?? 'normal'} responsibilities={templateJob.roleProfile?.responsibilities ?? []} busy={busy} initialModuleId={outlineFocusModuleId ?? selectedModuleId} initialPanel={outlineFocusModuleId ? 'source' : 'closed'} sourceCatalog={moduleSourceCatalog} onSupplement={(moduleLocalId, sourceIds, sectionIds) => void moduleAction('supplement_module_sources', { expectedRevision: templateJob.outline!.revision, moduleLocalId, sourceIds, sectionIds })} onEdit={(edits) => void moduleAction('update_outline', { expectedRevision: templateJob.outline!.revision, edits })} onApprove={() => void approveOutlineAndStartDrafting()} />
              </section>
            ) : <section className="ai-workspace-card ai-workspace-input-card">
              {templateRuns.length > 1 && <nav className="ai-module-actions" aria-label="Chọn template">{templateRuns.map((run, index) => <button type="button" key={run.kind} aria-pressed={run.kind === activeTemplateRun?.kind} onClick={() => activateTemplateRun(run, index)}>{run.job?.status === 'completed' ? 'Xem' : 'Tiếp tục'} Template {index + 1}</button>)}</nav>}
              <AiTemplateSelection
                selection={templateSelection}
                templateTitle={templateTitle}
                responsibilities={responsibilities}
                responsibilityCount={roleResponsibilities.length}
                errors={requestErrors}
                onSelect={chooseTemplateSelection}
                onTemplateTitleChange={setTemplateTitle}
                onResponsibilitiesChange={(value) => { setResponsibilities(value); if (roomId) writeAiResumeKey('onboarding:ai:responsibilities:' + roomId, value); }}
              />
              <div className="ai-output-summary">
                <strong>Kết quả dự kiến</strong>
                <span>{templateSelection === 'both' ? '2 template độc lập' : '1 template'}</span>
                <span>Tài liệu học và câu hỏi theo từng module</span>
              </div>
            </section>}
            <section className="ai-workspace-card ai-workspace-progress-card">
              <span className="section-kicker">TIẾN TRÌNH AI</span>
              {templateRuns.length > 1 && (
                <div className="ai-run-sequence" aria-label="Thứ tự tạo template">
                  {templateRuns.map((run, index) => (
                    <span className={run.review ? 'done' : index === activeTemplateIndex ? 'active' : ''} key={run.kind}>
                      Template {index + 1} · {run.kind === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}
                    </span>
                  ))}
                </div>
              )}
              <AiMilestoneProgress
                label={activeTemplateRun
                  ? `Template ${activeTemplateIndex + 1}/${templateRuns.length} · ${activeTemplateRun.kind === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}`
                  : 'Chọn loại lộ trình để bắt đầu'}
                job={templateJob}
                milestones={templateMilestones(templateJob)}
              />
            </section>
            <div className="ai-workspace-actions">
              <p className="ai-keep-open">{templateJob?.pipelineVersion === 'module_v2' ? 'Tiến trình được lưu theo từng module.' : 'Job được lưu riêng theo từng loại; retry chỉ tiếp tục template chưa hoàn tất.'}</p>
              <div className="ai-workspace-buttons">
                <button className="button button-primary" type="button" disabled={busy || requestHasErrors || (templateJob?.pipelineVersion === 'module_v2' && (templateJob.status === 'running' || templateJob.status === 'completed'))} onClick={() => void generateTemplate()}>
                  {busy
                    ? <><LoadingOutlined spin /> AI đang tạo nội dung…</>
                    : <>{templateJob?.status === 'failed' ? <RedoOutlined /> : templateJob?.status === 'running' ? <PlayCircleOutlined /> : <RobotOutlined />} {templateJobActionText(templateJob?.status)}</>}
                </button>
                {templateJob?.status === 'running' && <button className="button button-secondary" type="button" disabled={cancelling} onClick={() => void cancelJob(templateJob.jobId, setTemplateJob)}>Hủy job</button>}
              </div>
              {cleanupStatus}
            </div>
          </div>
        )}
        {canGenerateWithAi && step === 3 && (
          review && activeReviewRun ? (
            <div className="ai-review-stage">
              {review.content?.moduleApproval && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void editApprovedModules()}>Chỉnh sửa module</button>}
              <AiReview
                api={api}
                review={review}
                busy={busy}
                sequence={{
                  index: activeReviewIndex,
                  total: templateRuns.length,
                  kind: activeReviewRun.kind,
                }}
                onUpdated={(ops) => void updateReview(ops)}
                onResolve={(flag, action, note, index) => void resolveFlag(flag, action, note, index)}
              />
              <section className="ai-review-settings-bar" aria-label="Thiết lập template đang rà soát">
                <label className="form-field"><span>Ngưỡng đạt</span><input type="number" min={50} max={100} value={passingScore} onChange={(event) => updateActiveSettings({ passingScore: Number(event.target.value) })} /></label>
                <label className="form-field"><span>Số lượt mỗi module</span><input type="number" min={1} max={10} value={maxAttemptsPerModule ?? ''} placeholder="Không giới hạn" onChange={(event) => updateActiveSettings({ maxAttemptsPerModule: event.target.value ? Number(event.target.value) : null })} /></label>
                <label className="form-field"><span>Chế độ học</span><select value={learningMode} onChange={(event) => updateActiveSettings({ learningMode: event.target.value as 'sequential' | 'free' })}><option value="sequential">Tuần tự</option><option value="free">Tự do</option></select></label>
              </section>
            </div>
          ) : templateJob?.pipelineVersion === 'module_v2' && templateJob.outlineApprovedRevision === templateJob.outline?.revision ? (
            <div className="ai-workspace ai-module-review-stage">
              <section className="ai-workspace-card ai-workspace-progress-card">
                <span className="section-kicker">TIẾN TRÌNH AI</span>
                {templateRuns.length > 1 && (
                  <nav className="ai-run-sequence" aria-label="Chọn template">
                    {templateRuns.map((run, index) => (
                      <button
                        type="button"
                        className={run.review ? 'done' : index === activeTemplateIndex ? 'active' : ''}
                        aria-pressed={run.kind === activeTemplateRun?.kind}
                        key={run.kind}
                        onClick={() => activateTemplateRun(run, index)}
                      >{run.job ? 'Xem' : 'Tiếp tục'} Template {index + 1}</button>
                    ))}
                  </nav>
                )}
                <AiMilestoneProgress
                  label={`Template ${activeTemplateIndex + 1}/${templateRuns.length} · ${activeTemplateRun?.kind === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}`}
                  job={templateJob}
                  milestones={templateMilestones(templateJob)}
                />
              </section>
              <section className="ai-workspace-card ai-module-stage">
                <div className="ai-module-stage-heading">
                  <button type="button" onClick={() => { setOutlineFocusModuleId(null); setEditingOutline(true); setStep(2); }}>Chỉnh sửa lộ trình</button>
                  {templateJob.status === 'running' && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void resumeModuleJob()}>Tiếp tục xử lý</button>}
                  {templateJob.status === 'completed' && <button type="button" disabled={busy} onClick={() => void resumeModuleJob()}>Rà soát bản nháp</button>}
                </div>
                <AiModuleWorkspace
                  runs={templateJob.moduleRuns ?? []}
                  calls={templateJob.calls}
                  history={templateJob.stageOutputs.__moduleAudit}
                  selectedId={selectedModuleId}
                  busy={busy}
                  onSelect={(id) => { setSelectedModuleId(id); if (roomId) writeAiResumeKey('onboarding:ai:module:' + roomId, id); }}
                  onAction={(action, args) => moduleAction(action, args, action === 'approve_module_lesson' || action === 'approve_module_questions' || action === 'retry_module')}
                  onSources={() => { setOutlineFocusModuleId(selectedModuleId || templateJob.moduleRuns?.[0]?.outline.moduleLocalId || null); setEditingOutline(true); setStep(2); }}
                />
              </section>
            </div>
          ) : null
        )}
        {canGenerateWithAi && step === 4 && templateRuns.length > 0 && (
          <div className="ai-publish-summary ai-publish-batch-summary">
            <div className={publishReadiness.allowed ? 'ai-publish-status ready' : 'ai-publish-status blocked'}>
              {publishReadiness.allowed ? <CheckOutlined /> : <RobotOutlined />}
              <div>
                <h3>{publishReadiness.allowed ? 'Các template sẵn sàng xuất bản' : 'Chưa thể xuất bản'}</h3>
                <p>{publishReadiness.allowed
                  ? `Đã rà soát đủ ${templateRuns.length} template và không còn cờ bắt buộc.`
                  : `Còn ${publishReadiness.blockingCount} cờ bắt buộc cần xử lý.`}</p>
              </div>
            </div>
            {publishProgress && (
              <div className={'ai-publish-live-progress' + (publishProgress.error ? ' failed' : '')} role={publishProgress.error ? 'alert' : 'status'}>
                {busy && !publishProgress.error ? <LoadingOutlined spin /> : publishProgress.error ? <CloseOutlined /> : <CheckOutlined />}
                <div>
                  <strong>{publishProgress.error ? 'Bước hiện tại chưa hoàn tất' : 'Đang chuẩn bị và xuất bản'}</strong>
                  <span>{aiPublishProgressText(publishProgress)}</span>
                  {publishProgress.error && <small>{publishProgress.error}</small>}
                </div>
              </div>
            )}
            <div className="ai-publish-targets">
              {templateRuns.map((run, index) => {
                if (!run.review) return null;
                const runReadiness = aiReviewReadiness(run.review);
                const publishTarget = publishTargets.find((target) => target.kind === run.kind);
                const settings = run.settings ?? {
                  passingScore: run.review.passingScore ?? 70,
                  maxAttemptsPerModule: run.review.content?.maxAttemptsPerModule === undefined ? 2 : run.review.content.maxAttemptsPerModule,
                  learningMode: run.review.content?.learningMode ?? 'sequential',
                };
                const questionCount = run.review.modules.reduce(
                  (sum, module) => sum + module.questions.length,
                  0,
                );
                const lessonBlockCount = run.review.content?.modules.reduce(
                  (sum, module) => sum + module.blocks.length,
                  0,
                ) ?? 0;
                return (
                  <article className="ai-publish-target" key={run.kind}>
                    <header>
                      <span className="ai-sequence-badge">Template {index + 1}/{templateRuns.length}</span>
                      <strong>{run.review.title}</strong>
                      <small>{run.kind === 'advanced' ? 'Nhân sự chuyên sâu' : 'Nhân sự thông thường'}</small>
                    </header>
                    <dl>
                      <div><dt>Module</dt><dd>{run.review.modules.length}</dd></div>
                      <div><dt>Tài liệu học</dt><dd>{lessonBlockCount} khối</dd></div>
                      <div><dt>Câu hỏi</dt><dd>{questionCount}</dd></div>
                      <div><dt>Ngưỡng đạt</dt><dd>{settings.passingScore}%</dd></div>
                      <div><dt>Số lượt</dt><dd>{settings.maxAttemptsPerModule ?? 'Không giới hạn'}</dd></div>
                      <div><dt>Chế độ</dt><dd>{settings.learningMode === 'free' ? 'Tự do' : 'Tuần tự'}</dd></div>
                    </dl>
                    <span className={publishTarget?.phase === 'failed' || !runReadiness.allowed
                      ? 'ai-target-blocked'
                      : 'ai-target-ready'}>
                      {publishTarget
                        ? AI_PUBLISH_PHASE_LABELS[publishTarget.phase]
                        : runReadiness.allowed ? 'Sẵn sàng' : `${runReadiness.blockingCount} cờ bắt buộc`}
                    </span>
                    {publishTarget?.error && <small className="ai-publish-target-error" role="alert">{publishTarget.error}</small>}
                  </article>
                );
              })}
            </div>
            <button
              className="button button-primary"
              type="button"
              disabled={busy || !publishReadiness.allowed}
              onClick={() => void publish()}
            >
              <RocketOutlined /> {busy
                ? 'Đang chuẩn bị và xuất bản…'
                : publishTargets.some((target) => target.phase === 'failed')
                  ? 'Thử lại xuất bản'
                  : templateRuns.length > 1 ? 'Xuất bản cả hai' : 'Xuất bản template'}
            </button>
          </div>
        )}
      </div>
      {canGenerateWithAi && (
        <footer className="ai-generator-footer">
          <button
            className="button button-secondary"
            type="button"
            disabled={busy || step === 0 || publishTargets.some((target) => Boolean(target.publishedTemplate))
              || (Boolean(initialTemplate) && step !== 3) || (step === 3 && Boolean(review) && !reviewNavigation.canBack)}
            onClick={() => {
              if (step === 3 && reviewNavigation.canBack) {
                setActiveReviewIndex(moveReviewIndex(templateRuns, activeReviewIndex, 'back').index);
              } else if (step === 3 && !review) {
                setOutlineFocusModuleId(null);
                setEditingOutline(true);
                setStep(2);
              } else if (step === 4) {
                setActiveReviewIndex(Math.max(0, templateRuns.length - 1));
                setStep(3);
              } else {
                setStep((value) => Math.max(0, value - 1));
              }
            }}
          >{step === 3 && reviewNavigation.canBack ? 'Template trước' : 'Quay lại'}</button>
          <div>
            {step === 0 && <button className="button button-primary" type="button" disabled={selectedIds.size === 0} onClick={() => setStep(1)}>Tiếp tục</button>}
            {step === 1 && inventoryJob?.status === 'completed' && <button className="button button-primary" type="button" onClick={() => setStep(2)}>Chọn loại lộ trình</button>}
            {step === 3 && review && (
              <>
                {!reviewNavigation.canNext && reviewNavigation.blockingCount > 0 && (
                  <span className="ai-review-blocking-note">Còn {reviewNavigation.blockingCount} cờ bắt buộc</span>
                )}
                <button
                  className="button button-primary"
                  type="button"
                  disabled={busy || !reviewNavigation.canNext}
                  onClick={() => {
                    if (reviewNavigation.atPublishSummary) setStep(4);
                    else {
                      const nextIndex = moveReviewIndex(templateRuns, activeReviewIndex, 'next').index;
                      setActiveReviewIndex(nextIndex);
                      if (!templateRuns[nextIndex].review) { setSelectedTemplateKind(templateRuns[nextIndex].kind); setStep(2); }
                    }
                  }}
                >{reviewNavigation.atPublishSummary ? 'Kiểm tra xuất bản' : `Tiếp: Template ${activeReviewIndex + 2}`}</button>
              </>
            )}
            {step === 4 && !publishReadiness.allowed && (
              <button className="button button-secondary" type="button" onClick={() => {
                const blockedIndex = templateRuns.findIndex((run) => !aiReviewReadiness(run.review).allowed);
                setActiveReviewIndex(blockedIndex >= 0 ? blockedIndex : 0);
                setStep(3);
              }}>Xử lý cờ bắt buộc</button>
            )}
          </div>
        </footer>
      )}
    </section>
  );
}
