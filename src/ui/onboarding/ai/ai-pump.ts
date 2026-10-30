import { AI_GENERATION_LIMITS } from '../../../onboarding/ai/limits';
import type { AiJobRecord, AiProvider } from '../../../onboarding/contracts';
import type { AiGateway } from './ai-gateway-sandbox';
import { cancelAndConfirmAttempt } from './ai-attempt-lifecycle';

export interface AiPumpApi {
  adminAi<T = unknown>(action: string, args: Record<string, unknown>): Promise<T>;
}

interface AiCallStep {
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

type PumpStep =
  | AiCallStep
  | { readonly kind: 'wait'; readonly job: AiJobRecord }
  | { readonly kind: 'awaiting_admin'; readonly job: AiJobRecord }
  | { readonly kind: 'done'; readonly job: AiJobRecord }
  | { readonly kind: 'failed'; readonly job: AiJobRecord };

export interface PumpAiJobOptions {
  readonly api: AiPumpApi;
  /** Gateway and provider used for calls that have not been dispatched yet. */
  readonly gateway: AiGateway;
  readonly provider: AiProvider;
  /** Resolves the gateway of an attempt the server already recorded, so a refresh adopts it. */
  readonly gatewayFor?: (provider: AiProvider) => AiGateway;
  readonly jobId: string;
  readonly workerId: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (job: AiJobRecord) => void;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly nowMs?: () => number;
  readonly maxPollMs?: number;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function retryAfter(error: unknown, fallback: number): number {
  if (!error || typeof error !== 'object') return fallback;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How often, and for how long, a job that completed without its result yet is re-read. */
export const RECONCILE_POLL_MS = 3_000;
export const RECONCILE_MAX_MS = 60_000;

/**
 * A rejection without a server code (e.g. the host's `tools/call timeout`) says nothing about
 * the job: the server may still have finished the step.
 */
export function isTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { name?: unknown; code?: unknown; data?: unknown };
  if (record.name === 'AbortError') return false;
  if (typeof record.code === 'string') return false;
  const data = record.data && typeof record.data === 'object' ? record.data as { code?: unknown } : undefined;
  return typeof data?.code !== 'string';
}

export interface ReconcileJobOptions {
  readonly getJob: () => Promise<AiJobRecord>;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly nowMs?: () => number;
  readonly signal?: AbortSignal;
}

/**
 * Re-reads the job after a transport failure instead of pumping it again. Returns a completed
 * job with its result, or a running job to keep pumping; undefined when the job failed, the
 * read failed, or a completed job still had no result after RECONCILE_MAX_MS.
 */
export async function reconcileJobAfterTransportFailure(options: ReconcileJobOptions): Promise<AiJobRecord | undefined> {
  const sleep = options.sleep ?? defaultSleep;
  const nowMs = options.nowMs ?? Date.now;
  const startedAt = nowMs();
  for (;;) {
    let job: AiJobRecord;
    try {
      job = await options.getJob();
    } catch {
      return undefined;
    }
    if (job.status === 'running') return job;
    if (job.status !== 'completed') return undefined;
    if (job.result !== undefined && job.result !== null) return job;
    if (nowMs() - startedAt + RECONCILE_POLL_MS > RECONCILE_MAX_MS) return undefined;
    try {
      await sleep(RECONCILE_POLL_MS, options.signal);
    } catch {
      return undefined;
    }
  }
}

export async function pumpAiJob(options: PumpAiJobOptions): Promise<AiJobRecord> {
  const sleep = options.sleep ?? defaultSleep;
  const nowMs = options.nowMs ?? Date.now;
  const maxPollMs = options.maxPollMs ?? AI_GENERATION_LIMITS.maxPollMs;
  const startedAt = nowMs();
  const leaseRefreshMs = Math.max(
    AI_GENERATION_LIMITS.pollIntervalMs,
    Math.floor(AI_GENERATION_LIMITS.pumpLeaseMs / 2),
  );
  let leaseRefreshedAt = startedAt;
  const waitMs = (job: AiJobRecord) => {
    const retryAt = job.nextRetryAt ?? job.moduleRuns?.find((run) => run.nextRetryAt)?.nextRetryAt;
    return retryAt && Date.parse(retryAt) > nowMs() ? Date.parse(retryAt) - nowMs() : AI_GENERATION_LIMITS.pollIntervalMs;
  };
  const releaseUnusedGrant = async (step: PumpStep) => {
    if (step.kind !== 'ai_call' || step.attemptRef) return;
    // No gateway call occurred: this is positive evidence the reservation can be released.
    await options.api.adminAi('report_ai_failure', {
      jobId: options.jobId, workerId: options.workerId, callId: step.callId,
      kind: 'failed', providerErrorCode: 'DISPATCH_NOT_STARTED',
    });
  };

  work: for (;;) {
    throwIfAborted(options.signal);
    const step = await options.api.adminAi<PumpStep>('next_step', {
      jobId: options.jobId,
      workerId: options.workerId,
    });
    if (options.signal?.aborted) await releaseUnusedGrant(step).catch(() => undefined);
    throwIfAborted(options.signal);
    if (step.kind === 'done' || step.kind === 'awaiting_admin') {
      options.onProgress?.(step.job);
      return step.job;
    }
    if (step.kind === 'failed') {
      options.onProgress?.(step.job);
      throw new Error(step.job.errorMessage ?? step.job.errorCode ?? 'AI job failed.');
    }
    if (step.kind === 'wait') {
      options.onProgress?.(step.job);
      await sleep(waitMs(step.job), options.signal);
      continue;
    }

    let attemptRef = step.attemptRef;
    const gateway = attemptRef && step.provider && options.gatewayFor
      ? options.gatewayFor(step.provider)
      : options.gateway;
    if (!attemptRef) {
      try {
        const dispatched = await gateway.dispatch({
          operationId: step.operationId,
          prompt: step.prompt,
          ...(step.systemContext === undefined ? {} : { systemContext: step.systemContext }),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        attemptRef = dispatched.attemptRef;
      } catch (error) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        const notStarted = code === 'DISPATCH_NOT_STARTED';
        const known = notStarted || code === 'PROJECT_BUSY' || code === 'AI_PERMISSION_DENIED';
        const recoverPreDispatchFailure = step.moduleTarget === 'questions';
        const releaseBeforeDispatch = notStarted
          && (Boolean(options.signal?.aborted) || !recoverPreDispatchFailure);
        // Unknown dispatches remain fenced on close. Positive non-dispatch evidence
        // can safely release the claim even when the signal is already aborted.
        if (options.signal?.aborted && !known) throw abortReason(options.signal);
        const job = await options.api.adminAi<AiJobRecord>('report_ai_failure', {
          jobId: options.jobId,
          workerId: options.workerId,
          callId: step.callId,
          kind: known ? 'failed' : 'dispatch_unknown',
          ...(known && !releaseBeforeDispatch ? { provider: options.provider } : {}),
          ...(known ? { providerErrorCode: code, message: error instanceof Error ? error.message : String(code) } : {}),
        });
        options.onProgress?.(job);
        throwIfAborted(options.signal);
        if (known && (!notStarted || recoverPreDispatchFailure) && job.status === 'running') continue work;
        throw error;
      }
      const dispatchedRef = attemptRef;
      // Persist even when the modal closes during dispatch. Closing never cancels the provider.
      const job = await options.api.adminAi<AiJobRecord>('record_dispatch', {
        jobId: options.jobId,
        workerId: options.workerId,
        callId: step.callId,
        attemptRef: dispatchedRef,
        provider: options.provider,
      });
      options.onProgress?.(job);
      if (job.status === 'cancelled') {
        // The persisted cancel, unlike an AbortSignal, proves explicit user intent.
        const outcome = await cancelAndConfirmAttempt(gateway, dispatchedRef);
        const cleaned = await options.api.adminAi<AiJobRecord>('record_attempt_cleanup', {
          jobId: options.jobId, callId: step.callId, attemptRef: dispatchedRef,
          state: outcome.state, ...(outcome.state === 'unknown' ? { message: outcome.message } : {}),
        });
        options.onProgress?.(cleaned);
        throwIfAborted(options.signal);
        return cleaned;
      }
      throwIfAborted(options.signal);
    }

    // An adopted attempt keeps the deadline that started when it was first dispatched.
    const recordedStart = step.attemptRef && step.startedAt ? Date.parse(step.startedAt) : Number.NaN;
    const attemptStartedAt = Number.isFinite(recordedStart) ? Math.min(recordedStart, nowMs()) : nowMs();
    let transientFailures = 0;
    for (;;) {
      throwIfAborted(options.signal);
      if (nowMs() - leaseRefreshedAt >= leaseRefreshMs) {
        let leaseStep: PumpStep;
        try {
          leaseStep = await options.api.adminAi<PumpStep>('next_step', {
            jobId: options.jobId,
            workerId: options.workerId,
          });
          transientFailures = 0;
        } catch (error) {
          throwIfAborted(options.signal);
          transientFailures += 1;
          const backoff = Math.min(
            12_000,
            AI_GENERATION_LIMITS.pollIntervalMs * (2 ** transientFailures),
          );
          await sleep(retryAfter(error, backoff), options.signal);
          continue;
        }
        if (options.signal?.aborted) await releaseUnusedGrant(leaseStep).catch(() => undefined);
        throwIfAborted(options.signal);
        if (leaseStep.kind === 'done' || leaseStep.kind === 'awaiting_admin') {
          options.onProgress?.(leaseStep.job);
          return leaseStep.job;
        }
        if (leaseStep.kind === 'failed') {
          options.onProgress?.(leaseStep.job);
          throw new Error(leaseStep.job.errorMessage ?? leaseStep.job.errorCode ?? 'AI job failed.');
        }
        if (leaseStep.kind === 'wait') {
          options.onProgress?.(leaseStep.job);
          await sleep(waitMs(leaseStep.job), options.signal);
          continue work;
        }
        if (
          leaseStep.callId !== step.callId
          || leaseStep.attemptRef !== attemptRef
        ) {
          await releaseUnusedGrant(leaseStep);
          throw new Error('AI job step changed while polling.');
        }
        leaseRefreshedAt = nowMs();
      }
      if (nowMs() - attemptStartedAt > maxPollMs) {
        // Refresh first after a suspended tab resumes, then observe the final boundary tick.
        // A valid terminal result must not be replaced by a local timeout.
        const finalStatus = await gateway.status(attemptRef, options.signal).catch(() => undefined);
        throwIfAborted(options.signal);
        if (finalStatus?.state === 'completed' && typeof finalStatus.text === 'string') {
          const job = await options.api.adminAi<AiJobRecord>('submit_ai_output', {
            jobId: options.jobId,
            workerId: options.workerId,
            callId: step.callId,
            text: finalStatus.text,
          });
          options.onProgress?.(job);
          break;
        }
        const terminal = finalStatus && ['completed', 'failed', 'cancelled'].includes(finalStatus.state);
        const job = await options.api.adminAi<AiJobRecord>('report_ai_failure', {
          jobId: options.jobId,
          workerId: options.workerId,
          callId: step.callId,
          kind: terminal ? 'failed' : 'timeout',
          ...(finalStatus?.error ? { message: finalStatus.error } : {}),
          ...(finalStatus?.errorCode ? { providerErrorCode: finalStatus.errorCode } : {}),
        });
        options.onProgress?.(job);
        // A timed-out provider may still run. Leave its lease fenced until explicit cleanup.
        if (job.status === 'running') return job;
        throw new Error('AI polling timed out.');
      }
      let status;
      try {
        status = await gateway.status(attemptRef, options.signal);
        transientFailures = 0;
      } catch (error) {
        throwIfAborted(options.signal);
        transientFailures += 1;
        const backoff = Math.min(
          12_000,
          AI_GENERATION_LIMITS.pollIntervalMs * (2 ** transientFailures),
        );
        await sleep(retryAfter(error, backoff), options.signal);
        continue;
      }
      throwIfAborted(options.signal);
      if (status.state === 'pending' || status.state === 'running') {
        await sleep(AI_GENERATION_LIMITS.pollIntervalMs, options.signal);
        continue;
      }
      if (status.state === 'failed' || status.state === 'cancelled') {
        const job = await options.api.adminAi<AiJobRecord>('report_ai_failure', {
          jobId: options.jobId,
          workerId: options.workerId,
          callId: step.callId,
          kind: 'failed',
          ...(status.error ? { message: status.error } : {}),
          ...(status.errorCode ? { providerErrorCode: status.errorCode } : {}),
          ...(status.phase ? { providerPhase: status.phase } : {}),
          ...(status.diagnosticError ? { diagnosticError: status.diagnosticError } : {}),
        });
        options.onProgress?.(job);
        if (job.status === 'running') continue work;
        throw new Error(status.error ?? 'AI attempt failed.');
      }
      if (typeof status.text !== 'string') {
        const job = await options.api.adminAi<AiJobRecord>('report_ai_failure', {
          jobId: options.jobId,
          workerId: options.workerId,
          callId: step.callId,
          kind: 'failed',
          message: 'AI completed without text output.',
        });
        options.onProgress?.(job);
        if (job.status === 'running') continue work;
        throw new Error('AI completed without text output.');
      }
      const job = await options.api.adminAi<AiJobRecord>('submit_ai_output', {
        jobId: options.jobId,
        workerId: options.workerId,
        callId: step.callId,
        text: status.text,
      });
      options.onProgress?.(job);
      break;
    }
  }
}
