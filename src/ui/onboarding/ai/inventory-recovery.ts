import type { AiCallRecord, AiJobRecord } from '../../../onboarding/contracts';

function isNativeCall(call: AiCallRecord): boolean {
  return call.provider === 'native_chat' || call.attemptRef?.startsWith('native-chat:') === true;
}

function isSandboxCall(call: AiCallRecord): boolean {
  return call.provider === 'sandbox'
    || (Boolean(call.attemptRef) && !isNativeCall(call));
}

function isWorkerCrash(call: AiCallRecord, job: AiJobRecord): boolean {
  if (call.providerErrorCode) return /^worker_failed$/iu.test(call.providerErrorCode);
  return [...(call.errors ?? []), job.errorMessage ?? ''].some((message) =>
    /worker[_ ]failed|worker exited with code\s+-?\d+/iu.test(message));
}

export function isInventoryNativeFallbackCandidate(job: AiJobRecord): boolean {
  if (job.kind !== 'inventory' || job.status !== 'failed') return false;
  if (job.calls.some(isNativeCall)) return false;
  const failed = [...job.calls].reverse().find((call) => call.status === 'failed');
  return Boolean(failed && isSandboxCall(failed) && isWorkerCrash(failed, job));
}

export interface InventoryRecoveryOptions {
  readonly initialJob: AiJobRecord;
  readonly initialPreferNative: boolean;
  readonly nativeAvailable: boolean;
  readonly pumpOnce: (job: AiJobRecord, preferNative: boolean) => Promise<AiJobRecord>;
  readonly reloadJob: (jobId: string) => Promise<AiJobRecord>;
  readonly retryJob: (jobId: string) => Promise<AiJobRecord>;
}

export async function pumpWithInventoryRecovery(
  options: InventoryRecoveryOptions,
): Promise<AiJobRecord> {
  try {
    return await options.pumpOnce(options.initialJob, options.initialPreferNative);
  } catch (error) {
    if (!options.nativeAvailable || options.initialPreferNative) throw error;
    const failed = await options.reloadJob(options.initialJob.jobId);
    if (!isInventoryNativeFallbackCandidate(failed)) throw error;
    const retry = await options.retryJob(failed.jobId);
    return options.pumpOnce(retry, true);
  }
}
