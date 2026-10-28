import { describe, expect, it, vi } from 'vitest';

import type { AdminTemplateDetail } from '../src/onboarding/templates';
import {
  AiPublishBatchError,
  publishAiTemplateBatch,
  type AiPublishBatchDependencies,
  type AiPublishTarget,
} from '../src/ui/onboarding/ai/ai-publish-batch';

function review(kind: 'normal' | 'advanced'): AdminTemplateDetail {
  return {
    id: `template-${kind}`,
    version: 1,
    source: 'ai_generated',
    status: 'draft',
    employeeType: kind,
    title: kind === 'normal' ? 'Template 1' : 'Template 2',
    description: 'AI draft',
    modules: [],
    locked: false,
    maxAttempts: 2,
    flags: [],
    updatedAt: `${kind}-draft`,
  };
}

function targets(): readonly AiPublishTarget[] {
  return [
    { kind: 'advanced', review: review('advanced'), jsonExported: false, phase: 'idle' },
    { kind: 'normal', review: review('normal'), jsonExported: false, phase: 'idle' },
  ];
}

function dependencies(log: string[]): AiPublishBatchDependencies {
  return {
    prepareResources: vi.fn(async (target) => {
      log.push(`prepare:${target.kind}`);
      return { ...target.review, updatedAt: `${target.kind}-prepared` };
    }),
    publish: vi.fn(async (prepared) => {
      log.push(`publish:${prepared.employeeType}:${prepared.updatedAt}`);
      return { ...prepared, status: 'published', updatedAt: `${prepared.employeeType}-published` };
    }),
    exportJson: vi.fn(async (published) => {
      log.push(`export:${published.employeeType}:${published.status}:${published.updatedAt}`);
    }),
  };
}

describe('AI template batch publishing', () => {
  it('rechecks refreshed server targets before beginning artifact work', async () => {
    const log: string[] = [];
    const deps = dependencies(log);
    deps.beginBatch = async (selected) => selected.map((target) => target.kind !== 'advanced' ? target : {
      ...target, review: { ...target.review, flags: [{ id: 'new-block', type: 'missing', severity: 'blocking', status: 'open',
        message: 'Changed', questionForAdmin: 'Confirm?', location: {}, evidence: [] }] },
    });
    await expect(publishAiTemplateBatch(targets(), deps)).rejects.toBeInstanceOf(AiPublishBatchError);
    expect(log).toEqual([]);
  });
  it('discards completion from a different review version before publishing a revision', async () => {
    const oldReview = { ...review('normal'), status: 'published' as const };
    const changedReview = { ...review('normal'), version: 2 };
    const log: string[] = [];
    const result = await publishAiTemplateBatch([{ kind: 'normal', review: changedReview,
      preparedReview: oldReview, publishedTemplate: oldReview, jsonExported: true, phase: 'completed' }], dependencies(log));
    expect(log).toEqual(['prepare:normal', 'publish:normal:normal-prepared', 'export:normal:published:normal-published']);
    expect(result[0].publishedTemplate?.version).toBe(2);
  });

  it('discards completion from changed legacy lesson content in the same draft version', async () => {
    const oldReview = review('normal');
    const changedReview = { ...oldReview, modules: [{ id: 'm1', key: 'core', title: 'New lesson', description: '', order: 1, resources: [], questions: [] }] };
    const log: string[] = [];
    await publishAiTemplateBatch([{ kind: 'normal', review: changedReview,
      preparedReview: oldReview, publishedTemplate: { ...oldReview, status: 'published' }, jsonExported: true, phase: 'completed' }], dependencies(log));
    expect(log[0]).toBe('prepare:normal');
    expect(log).toHaveLength(3);
  });
  it('checks every target before side effects and rejects the whole batch if one is blocked', async () => {
    const log: string[] = [];
    const deps = dependencies(log);
    const blocked = targets().map((target) => target.kind === 'advanced'
      ? {
          ...target,
          review: {
            ...target.review,
            flags: [{
              id: 'flag-1', type: 'missing' as const, severity: 'blocking' as const,
              message: 'Missing', questionForAdmin: 'Add it?', location: {}, evidence: [],
              status: 'open' as const,
            }],
          },
        }
      : target);

    await expect(publishAiTemplateBatch(blocked, deps)).rejects.toBeInstanceOf(AiPublishBatchError);
    expect(log).toEqual([]);
    expect(deps.prepareResources).not.toHaveBeenCalled();
  });

  it('finishes normal artifacts and publication before starting advanced', async () => {
    const log: string[] = [];
    const deps = dependencies(log);
    const updates: (readonly AiPublishTarget[])[] = [];

    const result = await publishAiTemplateBatch(targets(), deps, (current) => {
      updates.push(current);
    });

    expect(log).toEqual([
      'prepare:normal',
      'publish:normal:normal-prepared',
      'export:normal:published:normal-published',
      'prepare:advanced',
      'publish:advanced:advanced-prepared',
      'export:advanced:published:advanced-published',
    ]);
    expect(result.map((target) => target.kind)).toEqual(['normal', 'advanced']);
    expect(result.every((target) => target.phase === 'completed' && target.jsonExported)).toBe(true);
    expect(result.every((target) => target.publishedTemplate?.status === 'published')).toBe(true);
    expect(updates.at(-1)?.every((target) => target.phase === 'completed')).toBe(true);
  });

  it('retains normal publication when advanced upload fails and resumes only missing work after serialization', async () => {
    const log: string[] = [];
    let failAdvanced = true;
    const deps = dependencies(log);
    deps.prepareResources = vi.fn(async (target) => {
      log.push(`prepare:${target.kind}`);
      if (target.kind === 'advanced' && failAdvanced) throw new Error('PDF advanced failed');
      return { ...target.review, updatedAt: `${target.kind}-prepared` };
    });

    let snapshots: readonly AiPublishTarget[] = [];
    try {
      await publishAiTemplateBatch(targets(), deps);
    } catch (error) {
      expect(error).toBeInstanceOf(AiPublishBatchError);
      snapshots = (error as AiPublishBatchError).targets;
    }
    expect(log).toEqual(['prepare:normal', 'publish:normal:normal-prepared', 'export:normal:published:normal-published', 'prepare:advanced']);
    expect(snapshots.find((target) => target.kind === 'normal')?.phase).toBe('completed');
    expect(snapshots.find((target) => target.kind === 'advanced')).toMatchObject({
      phase: 'failed', error: 'PDF advanced failed',
    });

    failAdvanced = false;
    log.length = 0;
    const retried = await publishAiTemplateBatch(JSON.parse(JSON.stringify(snapshots)), deps);
    expect(log).toEqual([
      'prepare:advanced',
      'publish:advanced:advanced-prepared',
      'export:advanced:published:advanced-published',
    ]);
    expect(retried.every((target) => target.phase === 'completed')).toBe(true);
  });

  it('retains completed normal work when advanced publish fails and retries only advanced', async () => {
    const log: string[] = [];
    let failAdvanced = true;
    const deps = dependencies(log);
    deps.publish = vi.fn(async (prepared) => {
      log.push(`publish:${prepared.employeeType}:${prepared.updatedAt}`);
      if (prepared.employeeType === 'advanced' && failAdvanced) throw new Error('Publish advanced failed');
      return { ...prepared, status: 'published', updatedAt: `${prepared.employeeType}-published` };
    });

    let snapshots: readonly AiPublishTarget[] = [];
    try {
      await publishAiTemplateBatch(targets(), deps);
    } catch (error) {
      snapshots = (error as AiPublishBatchError).targets;
    }
    expect(snapshots.find((target) => target.kind === 'normal')).toMatchObject({
      phase: 'completed', jsonExported: true,
    });
    expect(snapshots.find((target) => target.kind === 'advanced')).toMatchObject({ phase: 'failed' });

    failAdvanced = false;
    log.length = 0;
    await publishAiTemplateBatch(snapshots, deps);
    expect(log).toEqual([
      'publish:advanced:advanced-prepared',
      'export:advanced:published:advanced-published',
    ]);
  });

  it('retains an already published advanced template when export fails and retries only JSON', async () => {
    const log: string[] = [];
    let failAdvancedExport = true;
    const deps = dependencies(log);
    deps.exportJson = vi.fn(async (published) => {
      log.push(`export:${published.employeeType}:${published.status}:${published.updatedAt}`);
      if (published.employeeType === 'advanced' && failAdvancedExport) {
        throw new Error('Export advanced failed');
      }
    });

    let snapshots: readonly AiPublishTarget[] = [];
    try {
      await publishAiTemplateBatch(targets(), deps);
    } catch (error) {
      snapshots = (error as AiPublishBatchError).targets;
    }
    expect(snapshots.find((target) => target.kind === 'normal')).toMatchObject({
      phase: 'completed', jsonExported: true,
    });
    expect(snapshots.find((target) => target.kind === 'advanced')).toMatchObject({
      phase: 'failed', jsonExported: false,
      publishedTemplate: { status: 'published' },
    });

    failAdvancedExport = false;
    log.length = 0;
    await publishAiTemplateBatch(snapshots, deps);
    expect(log).toEqual(['export:advanced:published:advanced-published']);
  });
});
