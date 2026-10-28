import { describe, expect, it } from 'vitest';

import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';

describe('AI in-memory store parity', () => {
  it('isolates new collection rows by room', async () => {
    const store = new MemoryOnboardingStore();
    await store.create('room-a', 'onboarding_sources', { sourceId: 'source-1', checksum: 'a' });
    await store.create('room-b', 'onboarding_sources', { sourceId: 'source-1', checksum: 'b' });

    await expect(store.query('room-a', 'onboarding_sources')).resolves.toMatchObject({
      records: [{ sourceId: 'source-1', checksum: 'a' }],
    });
    await expect(store.query('room-b', 'onboarding_sources')).resolves.toMatchObject({
      records: [{ sourceId: 'source-1', checksum: 'b' }],
    });
  });

  it('enforces required unique indexes but permits repeated absent optional operation IDs', async () => {
    const store = new MemoryOnboardingStore();
    await store.create('room-a', 'onboarding_sources', { sourceId: 'source-1', checksum: 'same' });
    await expect(store.create('room-a', 'onboarding_sources', {
      sourceId: 'source-1', checksum: 'other',
    })).rejects.toThrow('unique');

    await store.create('room-a', 'onboarding_module_attempts', {
      assignmentId: 'assignment-1', moduleId: 'module-1', ordinal: 1,
    });
    await store.create('room-a', 'onboarding_module_attempts', {
      assignmentId: 'assignment-1', moduleId: 'module-1', ordinal: 2,
    });
    await expect(store.count('room-a', 'onboarding_module_attempts')).resolves.toBe(2);
  });
});
