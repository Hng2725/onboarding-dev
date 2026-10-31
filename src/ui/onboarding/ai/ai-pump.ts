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
  readonly moduleLocalId?: string;
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
  /**
   * Called on every `wait` step, before the pump sleeps. The server waits while the room AI is
   * fenced (e.g. an attempt whose cleanup is unproven), so the caller re-checks that here.
   */
  readonly onWait?: (job: AiJobRecord) => void | Promise<void>;
  /**
   * How long the server may answer `wait` with an unchanged job before the pump gives up with
   * AI_PUMP_STALLED. Unset: it waits for as long as the server does.
   */
  readonly maxIdleWaitMs?: number;
  /**
   * Deadline of a Native module-questions call (the bounded question recovery). Every other call
   * keeps `maxPollMs`, so the bound never leaks onto a lesson pumped by the same loop.
   */
  readonly questionPollMs?: number;
  /**
   * A Native question recovery for one module: the pump keeps going while the server hands it
   * that module's questions (including a busy or transient successor), and returns as soon as it
   * hands anything else, which then goes back to the normal provider and deadline.
   */
  readonly questionRecoveryOf?: { readonly moduleLocalId: string };
}

export const AI_PUMP_STALLED = 'AI_PUMP_STALLED';

/** The server kept answering `wait` without the job changing for `maxIdleWaitMs`. */
export class AiPumpStalledError extends Error {
  readonly code = AI_PUMP_STALLED;
  constructor(readonly job: AiJobRecord) {
    super('The AI job made no progress while waiting.');
    this.name = 'AiPumpStalledError';
  }
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

/** Waits before each automatic retry of a code-less failure; after the last one the error shows. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

export interface TransientRetryOptions<T> {
  /** Sends the call. A mutating call is only re-sent after `reconcile` found it had no effect. */
  readonly run: () => Promise<T>;
  /**
   * Re-reads the server after a code-less failure: the result when the earlier call already took
   * effect, undefined to send it again. While it fails itself the call is never re-sent.
   */
  readonly reconcile?: () => Promise<T | undefined>;
  /** False once the run that started the call was superseded (pause, reset, close): stop retrying. */
  readonly active?: () => boolean;
  /** Called before waiting for retry `attempt` of `total`. */
  readonly onRetry?: (attempt: number, total: number) => void;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

/**
 * Retries a call whose failure carried no server code (e.g. the host's `tools/call timeout`)
 * after 2 s, 5 s and 10 s. A coded server error is thrown at once; so is the last failure.
 */
export async function withTransientRetry<T>(options: TransientRetryOptions<T>): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const active = options.active ?? (() => true);
  let lastError: unknown;
  let unsettled = false;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      if (attempt > TRANSIENT_RETRY_DELAYS_MS.length || !active()) throw lastError;
      options.onRetry?.(attempt, TRANSIENT_RETRY_DELAYS_MS.length);
      await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt - 1], options.signal);
      if (!active()) throw lastError;
    }
    try {
      if (unsettled && options.reconcile) {
        const settled = await options.reconcile();
        if (settled !== undefined) return settled;
      }
      unsettled = false;
      return await options.run();
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      lastError = error;
      unsettled = true;
    }
  }
}

/** A job the server marked failed: its own code, so it is never mistaken for a slow server. */
export function failedJobError(job: Pick<AiJobRecord, 'errorCode' | 'errorMessage' | 'status'>): Error {
  return Object.assign(new Error(job.errorMessage ?? job.errorCode ?? 'AI job ' + job.status + '.'), {
    code: job.errorCode ?? (job.status === 'cancelled' ? 'AI_JOB_CANCELLED' : 'AI_JOB_FAILED'),
  });
}

/** The change a timed-out call sent: a module draft version, or an outline action with its arguments. */
export type JobChange =
  | { readonly kind: 'module'; readonly moduleLocalId: string; readonly target: 'lesson' | 'questions'; readonly expectedVersion: number }
  | { readonly kind: 'outline'; readonly action: string; readonly args: Readonly<Record<string, unknown>> };

function supplementRequests(job: AiJobRecord, moduleLocalId: unknown, sourceId: unknown): number {
  return Object.entries(job.stageOutputs ?? {}).filter(([key, value]) => /^supplement:\d+$/.test(key)
    && Boolean(value) && typeof value === 'object'
    && (value as { moduleLocalId?: unknown }).moduleLocalId === moduleLocalId
    && (value as { sourceId?: unknown }).sourceId === sourceId).length;
}

/**
 * Whether a re-read job shows that a change sent before a transport failure already took effect.
 * Only the action's own effect counts, measured against what was sent: a module version past the
 * one sent, or an outline revision past the one sent together with the change the action makes.
 * Anything else is not reported as applied; re-sending then surfaces the server's own conflict.
 */
export function jobChangeApplied(before: AiJobRecord, after: AiJobRecord, change: JobChange): boolean {
  if (change.kind === 'module') {
    const run = after.moduleRuns?.find((item) => item.outline.moduleLocalId === change.moduleLocalId);
    const version = change.target === 'lesson' ? run?.lessonVersion : run?.questionVersion;
    return typeof version === 'number' && version > change.expectedVersion;
  }
  const { action, args } = change;
  const expected = Number(args.expectedRevision);
  const advanced = Number.isFinite(expected) && (after.outline?.revision ?? 0) > expected;
  const moduleIn = (job: AiJobRecord, id: unknown) => job.outline?.modules.find((item) => item.moduleLocalId === id);
  switch (action) {
    case 'add_outline_module':
      return advanced && Boolean(after.outline?.modules.some((item) => !item.tombstoned && item.title === args.title));
    case 'supplement_module_document':
      // Queuing a supplement read leaves the outline revision as it is; the new request is the effect.
      return supplementRequests(after, args.moduleLocalId, args.sourceId) > supplementRequests(before, args.moduleLocalId, args.sourceId);
    case 'supplement_module_sources': {
      const module = moduleIn(after, args.moduleLocalId);
      const sections = Array.isArray(args.sectionIds) ? args.sectionIds : [];
      return advanced && Boolean(module) && sections.length > 0 && sections.every((id) => module!.sourceSectionIds.includes(String(id)));
    }
    case 'set_coverage_override':
      return advanced && moduleIn(after, args.moduleLocalId)?.coverageOverride === args.override;
    case 'update_outline': {
      const edits = Array.isArray(args.edits) ? args.edits as readonly { readonly moduleLocalId?: unknown }[] : [];
      const ids = edits.map((edit) => edit.moduleLocalId).filter((id) => typeof id === 'string');
      return advanced && ids.length > 0
        && ids.some((id) => JSON.stringify(moduleIn(before, id)) !== JSON.stringify(moduleIn(after, id)));
    }
    default:
      return false;
  }
}

export async function pumpAiJob(options: PumpAiJobOptions): Promise<AiJobRecord> {
  const sleep = options.sleep ?? defaultSleep;
  const nowMs = options.nowMs ?? (() => Date.now());
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
  /** The latest job the server returned, handed back when a question recovery ends. */
  let lastJob: AiJobRecord | undefined;
  const progress = (job: AiJobRecord) => {
    lastJob = job;
    options.onProgress?.(job);
  };
  /** The job a run of `wait` steps started from, and when; any other step or job change resets it. */
  let idleSince: { readonly mark: string; readonly at: number } | undefined;
  const waitStep = async (job: AiJobRecord) => {
    progress(job);
    const mark = String(job.updatedAt) + '|' + String(Array.isArray(job.calls) ? job.calls.length : 0);
    if (idleSince?.mark !== mark) idleSince = { mark, at: nowMs() };
    if (options.maxIdleWaitMs !== undefined && nowMs() - idleSince.at >= options.maxIdleWaitMs) {
      throw new AiPumpStalledError(job);
    }
    await options.onWait?.(job);
    throwIfAborted(options.signal);
    await sleep(waitMs(job), options.signal);
  };
  const releaseUnusedGrant = async (step: PumpStep): Promise<AiJobRecord | undefined> => {
    if (step.kind !== 'ai_call' || step.attemptRef) return undefined;
    // No gateway call occurred: this is positive evidence the reservation can be released.
    return options.api.adminAi<AiJobRecord>('report_ai_failure', {
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
      progress(step.job);
      return step.job;
    }
    if (step.kind === 'failed') {
      progress(step.job);
      throw failedJobError(step.job);
    }
    if (step.kind === 'wait') {
      await waitStep(step.job);
      continue;
    }
    idleSince = undefined;
    const recovery = options.questionRecoveryOf;
    if (recovery && (step.moduleTarget !== 'questions' || step.moduleLocalId !== recovery.moduleLocalId)) {
      // The recovered questions are settled: give the claim back unused, so the next pass sends
      // this call with the normal provider and deadline.
      const released = await releaseUnusedGrant(step);
      if (released) progress(released);
      return released ?? lastJob
        ?? (await options.api.adminAi<{ job: AiJobRecord }>('get_job', { jobId: options.jobId })).job;
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
        progress(job);
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
      progress(job);
      if (job.status === 'cancelled') {
        // The persisted cancel, unlike an AbortSignal, proves explicit user intent.
        const outcome = await cancelAndConfirmAttempt(gateway, dispatchedRef);
        const cleaned = await options.api.adminAi<AiJobRecord>('record_attempt_cleanup', {
          jobId: options.jobId, callId: step.callId, attemptRef: dispatchedRef,
          state: outcome.state, ...(outcome.state === 'unknown' ? { message: outcome.message } : {}),
        });
        progress(cleaned);
        throwIfAborted(options.signal);
        return cleaned;
      }
      throwIfAborted(options.signal);
    }

    // An adopted attempt keeps the deadline that started when it was first dispatched.
    const recordedStart = step.attemptRef && step.startedAt ? Date.parse(step.startedAt) : Number.NaN;
    const attemptStartedAt = Number.isFinite(recordedStart) ? Math.min(recordedStart, nowMs()) : nowMs();
    const callProvider = step.attemptRef && step.provider ? step.provider : options.provider;
    const pollLimit = options.questionPollMs !== undefined && step.moduleTarget === 'questions' && callProvider === 'native_chat'
      ? options.questionPollMs
      : maxPollMs;
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
          progress(leaseStep.job);
          return leaseStep.job;
        }
        if (leaseStep.kind === 'failed') {
          progress(leaseStep.job);
          throw failedJobError(leaseStep.job);
        }
        if (leaseStep.kind === 'wait') {
          await waitStep(leaseStep.job);
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
      if (nowMs() - attemptStartedAt > pollLimit) {
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
          progress(job);
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
        progress(job);
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
        progress(job);
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
        progress(job);
        if (job.status === 'running') continue work;
        throw new Error('AI completed without text output.');
      }
      const job = await options.api.adminAi<AiJobRecord>('submit_ai_output', {
        jobId: options.jobId,
        workerId: options.workerId,
        callId: step.callId,
        text: status.text,
      });
      progress(job);
      break;
    }
  }
}
