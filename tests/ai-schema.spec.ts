import { describe, expect, it } from 'vitest';

import { ONBOARDING_COLLECTIONS } from '../src/onboarding/schema';

const AI_COLLECTIONS = [
  'onboarding_sources',
  'onboarding_ai_jobs',
  'onboarding_template_content',
  'onboarding_module_progress',
  'onboarding_module_attempts',
] as const;

describe('AI onboarding collections', () => {
  it('keeps batch identity and retirement fields optional for existing publications', () => {
    const fields = ONBOARDING_COLLECTIONS.find((definition) => definition.collection === 'onboarding_ai_publications')!.fields;
    for (const name of ['requestFingerprint', 'retiredAt', 'retirementReason', 'supersededBy']) {
      expect(fields.find((field) => field.name === name)).toBeDefined();
      expect(fields.find((field) => field.name === name)?.required).not.toBe(true);
    }
  });
  it('persists optional module lifecycle fields without migrating legacy rows', () => {
    const fields = ONBOARDING_COLLECTIONS.find((d) => d.collection === 'onboarding_ai_jobs')!.fields;
    for (const name of ['pipelineVersion', 'outline', 'outlineApprovedRevision', 'moduleRuns']) {
      expect(fields.find((f) => f.name === name)).toBeDefined();
      expect(fields.find((f) => f.name === name)?.required).not.toBe(true);
    }
  });
  it('defines all five room-scoped collections and their stable identity indexes', () => {
    const byName = new Map(ONBOARDING_COLLECTIONS.map((definition) => [definition.collection, definition]));

    for (const name of AI_COLLECTIONS) {
      expect(byName.get(name), name).toMatchObject({ collection: name, scope: 'room' });
    }
    expect(byName.get('onboarding_sources')?.indexes).toContainEqual(expect.objectContaining({
      name: 'sources_source_id_unique',
      fields: { sourceId: 1 },
      unique: true,
    }));
    expect(byName.get('onboarding_template_content')?.indexes).toContainEqual(expect.objectContaining({
      name: 'template_content_unique',
      fields: { templateId: 1, templateVersion: 1 },
      unique: true,
    }));
    expect(byName.get('onboarding_module_progress')?.indexes).toContainEqual(expect.objectContaining({
      name: 'module_progress_unique',
      fields: { assignmentId: 1, moduleId: 1 },
      unique: true,
    }));
    expect(byName.get('onboarding_module_attempts')?.indexes).toContainEqual(expect.objectContaining({
      name: 'module_attempts_ordinal_unique',
      fields: { assignmentId: 1, moduleId: 1, ordinal: 1 },
      unique: true,
    }));
  });

  it('never makes an optional operationId unique', () => {
    for (const definition of ONBOARDING_COLLECTIONS) {
      const operation = definition.fields.find((field) => field.name === 'operationId');
      if (!operation || operation.required) continue;
      expect(
        definition.indexes.filter((candidate) => candidate.unique)
          .some((candidate) => Object.keys(candidate.fields).includes('operationId')),
        definition.collection,
      ).toBe(false);
    }
  });
});
