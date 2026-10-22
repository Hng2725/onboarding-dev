import { afterEach, describe, expect, it, vi } from 'vitest';

import * as pollingModule from '../src/ui/onboarding/polling';

interface VisibilityHarness {
  hidden: boolean;
  notify(): void;
  source: {
    isHidden(): boolean;
    subscribe(listener: () => void): () => void;
  };
}

function visibilityHarness(): VisibilityHarness {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    get hidden() { return hidden; },
    set hidden(value: boolean) { hidden = value; },
    notify() { listeners.forEach((listener) => listener()); },
    source: {
      isHidden: () => hidden,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('shared onboarding polling', () => {
  it('loads immediately and schedules the next refresh two seconds after completion', async () => {
    vi.useFakeTimers();
    const startPolling = (pollingModule as unknown as {
      startPolling?: (task: (reason: string) => Promise<void>, options?: { intervalMs?: number }) => { stop(): void };
    }).startPolling;
    const reasons: string[] = [];

    expect(startPolling).toBeTypeOf('function');
    const controller = startPolling!(async (reason) => { reasons.push(reason); });
    await vi.runAllTicks();
    expect(reasons).toEqual(['initial']);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(reasons).toEqual(['initial']);
    await vi.advanceTimersByTimeAsync(1);
    expect(reasons).toEqual(['initial', 'interval']);
    controller.stop();
  });

  it('never overlaps requests and restarts the delay after the current request finishes', async () => {
    vi.useFakeTimers();
    const startPolling = (pollingModule as unknown as {
      startPolling?: (task: () => Promise<void>, options?: { intervalMs?: number }) => { refresh(): Promise<void>; stop(): void };
    }).startPolling;
    let release: (() => void) | undefined;
    let calls = 0;

    expect(startPolling).toBeTypeOf('function');
    const controller = startPolling!(async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await vi.runAllTicks();
    const duplicate = controller.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);

    release?.();
    await duplicate;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    controller.stop();
  });

  it('pauses while hidden and refreshes immediately when visible again', async () => {
    vi.useFakeTimers();
    const startPolling = (pollingModule as unknown as {
      startPolling?: (
        task: (reason: string) => Promise<void>,
        options: { intervalMs?: number; visibility?: VisibilityHarness['source'] },
      ) => { stop(): void };
    }).startPolling;
    const visibility = visibilityHarness();
    const reasons: string[] = [];

    expect(startPolling).toBeTypeOf('function');
    const controller = startPolling!(async (reason) => { reasons.push(reason); }, { visibility: visibility.source });
    await vi.runAllTicks();
    visibility.hidden = true;
    visibility.notify();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reasons).toEqual(['initial']);

    visibility.hidden = false;
    visibility.notify();
    await vi.runAllTicks();
    expect(reasons).toEqual(['initial', 'resume']);
    controller.stop();
  });
});
