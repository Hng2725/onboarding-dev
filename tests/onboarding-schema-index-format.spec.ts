import { describe, expect, it } from 'vitest';

import { ONBOARDING_COLLECTIONS } from '../src/onboarding/schema';

describe('PrivOS App Database index payloads', () => {
  it('sends Mongo-compatible field direction maps instead of string arrays', () => {
    for (const definition of ONBOARDING_COLLECTIONS) {
      for (const index of definition.indexes) {
        expect(Array.isArray(index.fields), `${definition.collection}.${index.name}`).toBe(false);
        expect(Object.keys(index.fields).length, `${definition.collection}.${index.name}`).toBeGreaterThan(0);
        expect(Object.values(index.fields).every((direction) => direction === 1 || direction === -1)).toBe(true);
      }
    }

    const templateIndex = ONBOARDING_COLLECTIONS[0].indexes[0];
    expect(templateIndex).toMatchObject({
      fields: { templateId: 1, version: 1 },
      unique: true,
    });
  });
});
