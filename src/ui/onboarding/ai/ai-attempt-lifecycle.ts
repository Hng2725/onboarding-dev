import type { AiAttemptState, AiGateway } from './ai-gateway-sandbox';

export type AiTerminalState = Extract<AiAttemptState, 'cancelled' | 'completed' | 'failed'>;

export type AiCancellationOutcome =
  | { readonly state: 'confirmed'; readonly terminalState: AiTerminalState }
  | { readonly state: 'unknown'; readonly message: string };

export interface AiCancellationOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

export const CANCEL_CONFIRM_TIMEOUT_MS = 15_000;
export const CANCEL_CONFIRM_POLL_MS = 1_000;

const TERMINAL = new Set<AiAttemptState>(['cancelled', 'completed', 'failed']);

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { name?: unknown }).name === 'AbortError');
}

function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError(signal));
    }, { once: true });
  });
}

async function terminalState(
  gateway: AiGateway,
  attemptRef: string,
  signal?: AbortSignal,
): Promise<AiTerminalState | undefined> {
  if (signal?.aborted) throw abortError(signal);
  try {
    const status = await gateway.status(attemptRef, signal);
    return TERMINAL.has(status.state) ? status.state as AiTerminalState : undefined;
  } catch (error) {
    if (isAbortError(error)) throw error;
    // A transient status failure is not evidence either way; keep polling until the deadline.
    return undefined;
  }
}

/** Restore and automatic cleanup may observe an attempt, but never request cancellation. */
export async function observeAttemptTermination(
  gateway: AiGateway,
  attemptRef: string,
  signal?: AbortSignal,
): Promise<AiCancellationOutcome> {
  const state = await terminalState(gateway, attemptRef, signal);
  return state
    ? { state: 'confirmed', terminalState: state }
    : { state: 'unknown', message: 'Provider termination was not confirmed.' };
}

/**
 * Requests cancellation of a provider attempt and waits for evidence that it stopped.
 * Any terminal state is safe for a new attempt; without one the outcome is `unknown`.
 */
export async function cancelAndConfirmAttempt(
  gateway: AiGateway,
  attemptRef: string,
  options: AiCancellationOptions = {},
): Promise<AiCancellationOutcome> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const timeoutMs = options.timeoutMs ?? CANCEL_CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? CANCEL_CONFIRM_POLL_MS;
  const deadline = now() + timeoutMs;

  const initial = await terminalState(gateway, attemptRef, options.signal);
  if (initial) return { state: 'confirmed', terminalState: initial };

  try {
    await gateway.cancel?.(attemptRef, options.signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    // The request may still have reached the provider; the status poll below decides.
  }

  for (;;) {
    const state = await terminalState(gateway, attemptRef, options.signal);
    if (state) return { state: 'confirmed', terminalState: state };
    if (now() >= deadline) {
      return {
        state: 'unknown',
        message: 'PrivOS chưa xác nhận dừng tiến trình AI sau '
          + String(Math.round(timeoutMs / 1000)) + ' giây.',
      };
    }
    await wait(pollIntervalMs, options.signal);
  }
}
