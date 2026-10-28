import { AI_GENERATION_LIMITS } from '../../../onboarding/ai/limits';
import type { AiJobRecord, AiProvider } from '../../../onboarding/contracts';
import type { AiGateway } from './ai-gateway-sandbox';

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
}

type PumpStep =
  | AiCallStep
  | { readonly kind: 'wait'; readonly job: AiJobRecord }
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
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    }, { once: true });
  });
}

function retryAfter(error: unknown, fallback: number): number {
  if (!error || typeof error !== 'object') return fallback;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function pumpAiJob(options: PumpAiJobOptions): Promise<AiJobRecord> {
  const sleep = options.sleep ?? defaultSleep;
  const nowMs = options.nowMs ?? Date.now;
  const startedAt = nowMs();
  const leaseRefreshMs = Math.max(
    AI_GENERATION_LIMITS.pollIntervalMs,
    Math.floor(AI_GENERATION_LIMITS.pumpLeaseMs / 2),
  );
  let leaseRefreshedAt = startedAt;

  for (;;) {
    throwIfAborted(options.signal);
    const step = await options.api.adminAi<PumpStep>('next_step', {
      jobId: options.jobId,
      workerId: options.workerId,
    });
    if (step.kind === 'done') {
      options.onProgress?.(step.job);
      return step.job;
    }
    if (step.kind === 'failed') {
      options.onProgress?.(step.job);
      throw new Error(step.job.errorMessage ?? step.job.errorCode ?? 'AI job failed.');
    }
    if (step.kind === 'wait') {
      options.onProgress?.(step.job);
      await sleep(AI_GENERATION_LIMITS.pollIntervalMs, options.signal);
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
        // A cancel already owns the job's outcome; do not race it with a failure report.
        if (options.signal?.aborted) throw abortReason(options.signal);
        const job = await options.api.adminAi<AiJobRecord>('report_ai_failure', {
          jobId: options.jobId,
          workerId: options.workerId,
          callId: step.callId,
          kind: 'dispatch_unknown',
        });
        options.onProgress?.(job);
        throw error;
      }
      const dispatchedRef = attemptRef;
      let job: AiJobRecord;
      try {
        // Recorded even after a cancel, so the server can track the live attempt for cleanup.
        job = await options.api.adminAi<AiJobRecord>('record_dispatch', {
          jobId: options.jobId,
          workerId: options.workerId,
          callId: step.callId,
          attemptRef: dispatchedRef,
          provider: options.provider,
        });
      } catch (error) {
        await gateway.cancel?.(dispatchedRef).catch(() => undefined);
        throw error;
      }
      options.onProgress?.(job);
      if (options.signal?.aborted) {
        await gateway.cancel?.(dispatchedRef).catch(() => undefined);
        throw abortReason(options.signal);
      }
    }

    // An adopted attempt keeps the deadline that started when it was first dispatched.
    const recordedStart = step.attemptRef && step.startedAt ? Date.parse(step.startedAt) : Number.NaN;
    const attemptStartedAt = Number.isFinite(recordedStart) ? Math.min(recordedStart, nowMs()) : nowMs();
    let transientFailures = 0;
    for (;;) {
      throwIfAborted(options.signal);
      if (nowMs() - attemptStartedAt > AI_GENERATION_LIMITS.maxPollMs) {
        // The provider may finish on the same boundary tick as our deadline.
        // Observe once more before cancellation so a valid terminal result is not lost.
        const finalStatus = await gateway.status(attemptRef, options.signal).catch(() => undefined);
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
        // Best effort: a provider run left alive would block the next Native retry.
        await gateway.cancel?.(attemptRef).catch(() => undefined);
        const job = await options.api.adminAi<AiJobRecord>('report_ai_failure', {
          jobId: options.jobId,
          workerId: options.workerId,
          callId: step.callId,
          kind: 'timeout',
        });
        options.onProgress?.(job);
        throw new Error('AI polling timed out.');
      }
      if (nowMs() - leaseRefreshedAt >= leaseRefreshMs) {
        let leaseStep: PumpStep;
        try {
          leaseStep = await options.api.adminAi<PumpStep>('next_step', {
            jobId: options.jobId,
            workerId: options.workerId,
          });
          transientFailures = 0;
        } catch (error) {
          transientFailures += 1;
          const backoff = Math.min(
            12_000,
            AI_GENERATION_LIMITS.pollIntervalMs * (2 ** transientFailures),
          );
          await sleep(retryAfter(error, backoff), options.signal);
          continue;
        }
        if (leaseStep.kind === 'done') {
          options.onProgress?.(leaseStep.job);
          return leaseStep.job;
        }
        if (leaseStep.kind === 'failed') {
          options.onProgress?.(leaseStep.job);
          throw new Error(leaseStep.job.errorMessage ?? leaseStep.job.errorCode ?? 'AI job failed.');
        }
        if (leaseStep.kind === 'wait') {
          options.onProgress?.(leaseStep.job);
          await sleep(AI_GENERATION_LIMITS.pollIntervalMs, options.signal);
          continue;
        }
        if (
          leaseStep.callId !== step.callId
          || (leaseStep.attemptRef && leaseStep.attemptRef !== attemptRef)
        ) {
          throw new Error('AI job step changed while polling.');
        }
        leaseRefreshedAt = nowMs();
      }
      let status;
      try {
        status = await gateway.status(attemptRef, options.signal);
        transientFailures = 0;
      } catch (error) {
        transientFailures += 1;
        const backoff = Math.min(
          12_000,
          AI_GENERATION_LIMITS.pollIntervalMs * (2 ** transientFailures),
        );
        await sleep(retryAfter(error, backoff), options.signal);
        continue;
      }
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
