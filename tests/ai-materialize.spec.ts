import { describe, expect, it } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import { materializeAiTemplate } from '../src/onboarding/ai/materialize';
import { createTemplateService } from '../src/onboarding/templates';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';
import { aiSource, generatedTemplate, seedAiSource } from './helpers/ai-template-fixture';

const admin: OnboardingActor = { userId: 'admin-1', roomId: 'room-a', access: 'admin' };

describe('AI template materialization', () => {
  it('creates stable per-module IDs, balances answer positions, and is idempotent by job', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const templates = createTemplateService(store, {
      now: () => '2026-10-23T09:00:00.000Z',
    });
    const input = {
      jobId: 'job-template-1',
      promptVersion: '2026-10-23.1',
      templateKind: 'normal' as const,
      generated: generatedTemplate,
      sources: [aiSource],
      learningMode: 'sequential' as const,
      maxAttemptsPerModule: 3,
    };

    const first = await materializeAiTemplate(store, templates, admin, input);
    const replay = await materializeAiTemplate(store, templates, admin, input);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      source: 'ai_generated',
      status: 'draft',
      assessmentMode: 'per_module',
      content: { assessmentMode: 'per_module', learningMode: 'sequential', maxAttemptsPerModule: 3 },
    });
    expect(first.modules.every((module) => module.id.startsWith('ai-mod-'))).toBe(true);
    expect(first.content?.modules.flatMap((module) => module.blocks)
      .every((block) => block.id.startsWith('ai-block-'))).toBe(true);
    expect(first.flags?.[0]).toMatchObject({ status: 'open', severity: 'warning' });
    expect(first.content?.modules[0].blocks[0].pendingVerification).toBe(true);

    const correctPositions = first.modules.flatMap((module) => module.questions).map((question) =>
      question.options?.findIndex((option) => question.correctOptionIds?.includes(option.id)));
    expect(correctPositions.slice(0, 8)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(await store.count('room-a', 'onboarding_template_content')).toBe(1);
    expect(await store.count('room-a', 'onboarding_templates')).toBe(1);
  });

  it('keeps answer metadata out of learner snapshots while retaining lesson content', async () => {
    const store = new MemoryOnboardingStore();
    await seedAiSource(store);
    const templates = createTemplateService(store, {
      now: () => '2026-10-23T09:00:00.000Z',
    });
    const draft = await materializeAiTemplate(store, templates, admin, {
      jobId: 'job-template-safe', promptVersion: '2026-10-23.1', templateKind: 'normal',
      generated: generatedTemplate, sources: [aiSource],
    });
    await templates.publish(admin, draft.id, draft.version, draft.updatedAt);

    const learner = await templates.getLearnerSnapshot(
      { userId: 'member-1', roomId: 'room-a', access: 'learner' },
      draft.id,
      draft.version,
    );

    expect(learner.content?.modules).toHaveLength(4);
    expect(learner.content).not.toHaveProperty('questionMeta');
    expect(JSON.stringify(learner)).not.toContain('correctOptionIds');
  });
});
