import { describe, expect, it, vi } from 'vitest';

import type { AiJobRecord } from '../src/onboarding/contracts';
import type { AdminTemplateDetail } from '../src/onboarding/templates';
import {
  collectAiGeneratorResetTemplateRefs,
  loadAiGeneratorResetReviews,
  resetAiGeneratorServerState,
} from '../src/ui/onboarding/ai/ai-generator-reset';

function job(jobId: string, status: AiJobRecord['status']): AiJobRecord {
  return {
    id: 'row-' + jobId,
    roomId: 'room-1',
    jobId,
    kind: 'template',
    status,
    templateKind: 'normal',
    promptVersion: 'v1',
    calls: [],
    stageOutputs: {},
    operationId: 'operation-' + jobId,
    createdBy: 'admin-1',
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
  };
}

function review(id: string, version: number, status: AdminTemplateDetail['status']): AdminTemplateDetail {
  return {
    id,
    version,
    source: 'ai_generated',
    status,
    employeeType: 'normal',
    title: id,
    description: '',
    modules: [],
  };
}

describe('AI generator server reset', () => {
  it('cancels each live or retryable job once before deleting each draft once', async () => {
    const events: string[] = [];
    const running = job('running', 'running');
    const failed = job('failed', 'failed');
    const cancelled = job('cancelled', 'cancelled');
    const draft = review('draft-1', 3, 'draft');

    await resetAiGeneratorServerState({
      jobs: [running, running, failed, cancelled, job('completed', 'completed')],
      reviews: [draft, draft, review('published-1', 1, 'published'), review('archived-1', 1, 'archived')],
      cancelJob: async (value) => {
        events.push('cancel:' + value.jobId);
        return { unconfirmed: 0 };
      },
      deleteDraft: async (value) => {
        events.push(`delete:${value.id}:${value.version}`);
      },
    });

    expect(events).toEqual([
      'cancel:running',
      'cancel:failed',
      'cancel:cancelled',
      'delete:draft-1:3',
    ]);
  });

  it('does not delete drafts while a provider attempt remains unconfirmed', async () => {
    const deleteDraft = vi.fn(async () => undefined);

    await expect(resetAiGeneratorServerState({
      jobs: [job('running', 'running')],
      reviews: [review('draft-1', 1, 'draft')],
      cancelJob: async () => ({ unconfirmed: 1 }),
      deleteDraft,
    })).rejects.toThrow('chưa xác nhận dừng');

    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it('propagates a draft deletion failure and stops deleting later drafts', async () => {
    const failure = new Error('Roomfiles draft is locked');
    const deleted: string[] = [];

    await expect(resetAiGeneratorServerState({
      jobs: [],
      reviews: [review('draft-1', 1, 'draft'), review('draft-2', 1, 'draft')],
      cancelJob: async () => ({ unconfirmed: 0 }),
      deleteDraft: async (value) => {
        deleted.push(value.id);
        if (value.id === 'draft-1') throw failure;
      },
    })).rejects.toBe(failure);

    expect(deleted).toEqual(['draft-1']);
  });

  it('finds a draft from a completed job result even while its review is unloaded', () => {
    const staleDraft = review('draft-1', 2, 'draft');

    expect(collectAiGeneratorResetTemplateRefs(
      [{
        kind: 'normal',
        job: { ...job('completed-job', 'completed'), result: { templateId: staleDraft.id, version: staleDraft.version } },
        review: null,
        publicationTarget: { kind: 'normal', jobId: 'completed-job', templateId: staleDraft.id, version: staleDraft.version },
      }],
      [{ kind: 'normal', review: staleDraft, phase: 'failed', jsonExported: false }],
    )).toEqual([{ templateId: 'draft-1', version: 2 }]);
  });

  it('reloads authoritative statuses, skips missing targets, and never deletes a published version', async () => {
    const published = review('published-1', 1, 'published');
    const draft = review('draft-1', 1, 'draft');
    const missing = Object.assign(new Error('Template not found'), { code: 'TEMPLATE_NOT_FOUND' });
    const current = new Map([
      ['published-1:1', published],
      ['draft-1:1', draft],
    ]);
    const loaded = await loadAiGeneratorResetReviews({
      refs: [
        { templateId: 'published-1', version: 1 },
        { templateId: 'draft-1', version: 1 },
        { templateId: 'deleted-1', version: 1 },
        { templateId: 'draft-1', version: 1 },
      ],
      getReview: async (ref) => {
        const value = current.get(`${ref.templateId}:${ref.version}`);
        if (!value) throw missing;
        return value;
      },
      isMissing: (error) => error === missing,
    });
    const deleted: string[] = [];

    await resetAiGeneratorServerState({
      jobs: [],
      reviews: loaded,
      cancelJob: async () => ({ unconfirmed: 0 }),
      deleteDraft: async (value) => { deleted.push(value.id); },
    });

    expect(loaded.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'published-1', status: 'published' },
      { id: 'draft-1', status: 'draft' },
    ]);
    expect(deleted).toEqual(['draft-1']);
  });

  it('propagates review reload errors that are not missing-template idempotency', async () => {
    const failure = new Error('Review database unavailable');

    await expect(loadAiGeneratorResetReviews({
      refs: [{ templateId: 'draft-1', version: 1 }],
      getReview: async () => { throw failure; },
      isMissing: () => false,
    })).rejects.toBe(failure);
  });
});
