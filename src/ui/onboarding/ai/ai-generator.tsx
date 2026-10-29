import {
  CheckOutlined,
  CloseOutlined,
  LoadingOutlined,
  RedoOutlined,
  RobotOutlined,
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
import { pumpAiJob } from './ai-pump';
import { pumpWithInventoryRecovery } from './inventory-recovery';
import {
  pumpWithQuestionRecovery,
  shouldBoundNativeQuestionPoll,
  shouldUseNativeForPump,
} from './question-recovery';
import { AiReview } from './ai-review';
import { AiStepSources } from './ai-step-sources';
import {
  collectAiGeneratorResetTemplateRefs,
  loadAiGeneratorResetReviews,
  resetAiGeneratorServerState,
} from './ai-generator-reset';
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
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [sourcePanelEpoch, setSourcePanelEpoch] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const inventoryRecoveryAbortRef = useRef<AbortController | null>(null);
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
    setRestoring(true);
    void (async () => {
      try {
        const loadedSources = await loadSources();
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
        let restoredRuns = selectResumableTemplateRuns({
          jobs: result.jobs,
          publicationBatches: result.publicationBatches,
          resumeJobIds,
          userId,
        });
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
              const loaded = await loadReview(output.templateId, output.version, false);
              restoredRuns = restoredRuns.map((entry) => entry.kind === run.kind ? { ...entry, review: loaded } : entry);
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
        // Provider cleanup runs after the job is on screen; it must never delay opening the modal.
        if (active) void reconcileCleanups(result.jobs);
      } catch (caught) {
        if (active) setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      } finally {
        if (active) setRestoring(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [api, checkpointTargets, initialTemplate, loadReview, loadSources, reconcileCleanups, roomId, userId]);

  useEffect(() => () => {
    abortRef.current?.abort();
    inventoryRecoveryAbortRef.current?.abort();
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
    setActiveReviewIndex(0);
    setBusy(false);
    setEditingOutline(false);
    setOutlineFocusModuleId(null);
    setModuleSourceCatalog([]);
    setSelectedTemplateKind(null);
    setSelectedModuleId('');
    setNotice(null);
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
    setStep(1);
    setBusy(true);
    setNotice(null);
    try {
      const inventory = await runInventory();
      if (inventory.status !== 'completed') throw new Error('Chưa phân tích xong tài liệu nguồn.');
      await generateTemplate(inventory, templateSelection);
    } catch (caught) {
      if (!isAbortError(caught)) setNotice({ message: generationErrorMessage(caught), tone: 'error' });
      // A timed-out or late-cancelled attempt may still run; reconcile it in the background.
      void refreshCleanups().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function chooseTemplateSelection(selection: Exclude<TemplateSelection, null>) {
    setSelectedTemplateKind(null);
    setTemplateSelection(selection);
    setActiveReviewIndex(0);
    setTemplateRuns((current) => templateKindsForSelection(selection).map((kind) =>
      current.find((run) => run.kind === kind) ?? { kind, job: null, review: null }));
  }

  async function resumeModuleJob() {
    if (!templateJob) return;
    setBusy(true); setNotice(null);
    try { const job = await pump(templateJob); setTemplateJob(job); await openCompletedModuleReview(job); }
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
      setStep(2);
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
    setStep(2);
    const approved = await moduleAction('approve_outline', { expectedRevision: templateJob.outline.revision }, true);
    if (!approved) setStep(1);
  }

  async function generateTemplate(inventory: AiJobRecord, kind: EmployeeType) {
    const existing = templateRuns.find((run) => run.kind === kind);
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
        clearResume: () => clearAiResumeKeys(aiGeneratorResumeKeys(roomId, userId)),
        resetSession: () => resetLocalSession(sources),
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
  const requestErrors = useMemo(() => validateTemplateRequest({
    selection: templateSelection,
    responsibilities,
  }), [responsibilities, templateSelection]);
  const requestHasErrors = Object.keys(requestErrors).length > 0;
  const outlineApproved = outlineApprovedFor(templateJob);
  const outlineReady = templateJob?.pipelineVersion === 'module_v2' && Boolean(templateJob.outline) && !templateJob.planPending;
  const publishing = publishTargets.some((target) => PUBLISHING_PHASES.has(target.phase));
  /** True while closing the modal would interrupt AI work; closing then asks first. */
  const aiWorking = busy
    || (inventoryJob?.status === 'running' && inventoryRecoveryAbortRef.current !== null)
    || Boolean(templateJob?.planPending)
    || (templateJob?.autoApprove === true && templateJob.status === 'running' && outlineApproved)
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
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') escapeRef.current(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
  const progressJob = templateJob ?? inventoryJob;
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

  let hint: string | null = null;
  let primary: { readonly label: string; readonly disabled: boolean; readonly onClick: () => void } | null = null;
  if (step === 0) {
    hint = sourcesHint;
    primary = { label: busy ? 'Đang phân tích…' : 'Phân tích tài liệu', disabled: !canAnalyze, onClick: () => void analyzeAndPlan() };
  } else if (step === 1) {
    if (outlineReady) hint = 'Duyệt lộ trình để AI viết nội dung';
    else {
      primary = {
        label: busy ? 'AI đang xử lý…' : progressFailed ? 'Thử lại' : 'Tiếp tục',
        disabled: busy || restoring || resetting || !templateSelection || requestHasErrors,
        onClick: () => void analyzeAndPlan(),
      };
    }
  } else if (step === 2) {
    primary = templateJob?.status === 'running' && !busy
      ? { label: 'Tiếp tục xử lý', disabled: false, onClick: () => void resumeModuleJob() }
      : { label: busy ? 'AI đang tạo nội dung…' : 'Xem lại template', disabled: busy || templateJob?.status !== 'completed', onClick: () => void resumeModuleJob() };
  } else if (templateRuns.length > 0) {
    if (publishReadiness.blockingCount > 0) hint = `Còn ${publishReadiness.blockingCount} cờ bắt buộc`;
    primary = {
      label: busy
        ? 'Đang xuất bản…'
        : publishTargets.some((target) => target.phase === 'failed') ? 'Thử lại xuất bản' : 'Xuất bản template',
      disabled: busy || !publishReadiness.allowed,
      onClick: () => void publish(),
    };
  }
  const progressCancellable = step === 1 && !outlineReady && progressJob?.status === 'running';

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
              {outlineReady && templateJob?.outline ? (
                <section className="ai-workspace-card ai-module-stage">
                  <AiOutlineReview key={templateJob.jobId} outline={templateJob.outline} templateKind={templateJob.templateKind ?? 'normal'} responsibilities={templateJob.roleProfile?.responsibilities ?? []} busy={busy} initialModuleId={outlineFocusModuleId ?? selectedModuleId} initialPanel={outlineFocusModuleId ? 'source' : 'closed'} sourceCatalog={moduleSourceCatalog} onSupplement={(moduleLocalId, sourceIds, sectionIds) => void moduleAction('supplement_module_sources', { expectedRevision: templateJob.outline!.revision, moduleLocalId, sourceIds, sectionIds })} onEdit={(edits) => void moduleAction('update_outline', { expectedRevision: templateJob.outline!.revision, edits })} onApprove={() => void approveOutlineAndStartDrafting()} />
                </section>
              ) : (
                <section className="ai-workspace-card ai-workspace-progress-card">
                  <h3>{templateJob
                    ? progressFailed ? 'AI chưa lập xong lộ trình' : 'AI đang lập lộ trình…'
                    : progressFailed ? 'AI chưa đọc xong tài liệu' : 'AI đang đọc tài liệu…'}</h3>
                  <AiMilestoneProgress
                    label={templateJob ? 'Lập lộ trình' : 'Phân tích tài liệu'}
                    job={progressJob}
                    milestones={templateJob ? templateMilestones(templateJob) : inventoryMilestones(inventoryJob, selectedIds.size)}
                  />
                </section>
              )}
              {cleanupStatus}
            </div>
          )}
          {canGenerateWithAi && step === 2 && templateJob?.pipelineVersion === 'module_v2' && (
            <div className="ai-workspace ai-module-review-stage">
              <section className="ai-workspace-card ai-workspace-progress-card">
                <AiMilestoneProgress
                  label="AI tạo nội dung"
                  job={templateJob}
                  milestones={templateMilestones(templateJob)}
                />
              </section>
              <section className="ai-workspace-card ai-module-stage">
                <div className="ai-module-stage-heading">
                  <button type="button" onClick={backToOutline}>Chỉnh sửa lộ trình</button>
                </div>
                <AiModuleWorkspace
                  runs={templateJob.moduleRuns ?? []}
                  calls={templateJob.calls}
                  history={templateJob.stageOutputs.__moduleAudit}
                  selectedId={selectedModuleId}
                  busy={busy}
                  onSelect={(id) => { setSelectedModuleId(id); if (roomId) writeAiResumeKey('onboarding:ai:module:' + roomId, id); }}
                  onAction={(action, args) => moduleAction(action, args, action === 'approve_module_lesson' || action === 'approve_module_questions' || action === 'retry_module')}
                  onSources={() => { setOutlineFocusModuleId(selectedModuleId || templateJob.moduleRuns?.[0]?.outline.moduleLocalId || null); setEditingOutline(true); setStep(1); }}
                />
              </section>
            </div>
          )}
          {canGenerateWithAi && step === 3 && (
            <div className="ai-step-review">
              {review && activeReviewRun && (
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
              )}
              {templateRuns.length > 0 && templateRuns.every((run) => run.review) && (
                <div className="ai-publish-summary ai-publish-batch-summary">
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
                            <small>{run.kind === 'advanced' ? 'Nâng cao' : 'Thông thường'}</small>
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
                </div>
              )}
            </div>
          )}
        </div>
        {canGenerateWithAi && (
          <footer className="ai-generator-footer">
            <div className="ai-generator-footer-start">
              {!initialTemplate && (
                <button className="button button-ghost" type="button" disabled={busy || resetting || restoring} onClick={() => setResetConfirmOpen(true)}>
                  Xóa phiên
                </button>
              )}
              {!initialTemplate && (step === 1 || step === 2) && (
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={busy || resetting}
                  onClick={() => { if (step === 2) backToOutline(); else setStep(0); }}
                >Quay lại</button>
              )}
              {progressCancellable && progressJob && (
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={cancelling}
                  onClick={() => void cancelJob(progressJob.jobId, templateJob ? setTemplateJob : setInventoryJob)}
                >Hủy job</button>
              )}
            </div>
            <div className="ai-generator-footer-end">
              {hint && <span className="ai-generator-hint">{hint}</span>}
              {primary && (
                <button className="button button-primary" type="button" disabled={primary.disabled} onClick={primary.onClick}>
                  {busy && <LoadingOutlined spin />}{primary.label}
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
