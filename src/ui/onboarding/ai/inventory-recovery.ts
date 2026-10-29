import type { AiCallRecord, AiJobRecord } from '../../../onboarding/contracts';

function isNativeCall(call: AiCallRecord): boolean {
  return call.provider === 'native_chat' || call.attemptRef?.startsWith('native-chat:') === true;
}

function isSandboxCall(call: AiCallRecord): boolean {
  return call.provider === 'sandbox'
    || (Boolean(call.attemptRef) && !isNativeCall(call));
}

export function isSandboxWorkerCrash(
  call: AiCallRecord,
  jobErrorMessage?: string,
): boolean {
  if (!isSandboxCall(call) || call.status !== 'failed') return false;
  if (call.providerErrorCode) return /^worker_failed$/iu.test(call.providerErrorCode);
  return [...(call.errors ?? []), jobErrorMessage ?? ''].some((message) =>
    /worker[_ ]failed|worker exited with code\s+-?\d+/iu.test(message));
}

export function isInventoryNativeFallbackCandidate(job: AiJobRecord): boolean {
  if (job.kind !== 'inventory' || job.status !== 'failed') return false;
  if (job.errorCode && job.errorCode !== 'AI_FAILED') return false;
  if (job.calls.some(isNativeCall)) return false;
  const terminal = [...job.calls].reverse().find((call) =>
    call.status === 'failed' || call.status === 'invalid');
  return Boolean(
    terminal?.status === 'failed'
    && isSandboxWorkerCrash(terminal, job.errorMessage),
  );
}

export interface InventoryRecoveryOptions {
  readonly initialJob: AiJobRecord;
  readonly initialPreferNative: boolean;
  readonly nativeAvailable: boolean;
  readonly signal?: AbortSignal;
  readonly pumpOnce: (job: AiJobRecord, preferNative: boolean) => Promise<AiJobRecord>;
  readonly reloadJob: (jobId: string) => Promise<AiJobRecord>;
  readonly retryJob: (jobId: string) => Promise<AiJobRecord>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export async function pumpWithInventoryRecovery(
  options: InventoryRecoveryOptions,
): Promise<AiJobRecord> {
  throwIfAborted(options.signal);
  try {
    return await options.pumpOnce(options.initialJob, options.initialPreferNative);
  } catch (error) {
    throwIfAborted(options.signal);
    if (!options.nativeAvailable || options.initialPreferNative) throw error;
    const failed = await options.reloadJob(options.initialJob.jobId);
    throwIfAborted(options.signal);
    if (!isInventoryNativeFallbackCandidate(failed)) throw error;
    const retry = await options.retryJob(failed.jobId);
    throwIfAborted(options.signal);
    return options.pumpOnce(retry, true);
  }
}
