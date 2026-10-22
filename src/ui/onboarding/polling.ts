import { useCallback, useEffect, useRef } from 'react';

export const DEFAULT_POLL_INTERVAL_MS = 2_000;

export type PollReason = 'initial' | 'interval' | 'resume' | 'manual';

export interface PollingVisibility {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface PollingOptions {
  readonly intervalMs?: number;
  readonly visibility?: PollingVisibility;
}

export interface PollingController {
  refresh(): Promise<void>;
  stop(): void;
}

function browserVisibility(): PollingVisibility | undefined {
  if (typeof document === 'undefined') return undefined;
  return {
    isHidden: () => document.hidden,
    subscribe(listener) {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

export function startPolling(
  task: (reason: PollReason) => Promise<void>,
  options: PollingOptions = {},
): PollingController {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const visibility = options.visibility ?? browserVisibility();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    clearTimer();
    if (stopped || visibility?.isHidden()) return;
    timer = setTimeout(() => { void execute('interval'); }, intervalMs);
  };

  const execute = (reason: PollReason): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (visibility?.isHidden() && reason === 'interval') {
      clearTimer();
      return Promise.resolve();
    }
    if (inFlight) return inFlight;

    clearTimer();
    inFlight = Promise.resolve()
      .then(() => task(reason))
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
        schedule();
      });
    return inFlight;
  };

  const unsubscribe = visibility?.subscribe(() => {
    if (visibility.isHidden()) {
      clearTimer();
      return;
    }
    void execute('resume');
  });

  void execute('initial');

  return {
    refresh: () => execute('manual'),
    stop() {
      stopped = true;
      clearTimer();
      unsubscribe?.();
    },
  };
}

export function usePolling(
  task: (reason: PollReason) => Promise<void>,
  options: PollingOptions = {},
): () => Promise<void> {
  const taskRef = useRef(task);
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  taskRef.current = task;

  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const visibility = options.visibility;
  useEffect(() => {
    const controller = startPolling((reason) => taskRef.current(reason), { intervalMs, visibility });
    refreshRef.current = controller.refresh;
    return controller.stop;
  }, [intervalMs, visibility]);

  return useCallback(() => refreshRef.current(), []);
}
