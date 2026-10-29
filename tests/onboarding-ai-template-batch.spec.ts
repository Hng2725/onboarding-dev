import { describe, expect, it } from 'vitest';

import {
  AiTemplateGenerationError,
  aiReviewReadiness,
  generateTemplateRuns,
  generateValidatedTemplateRuns,
  mergeTemplateRunJobs,
  reviewAdvanceState,
  selectResumableTemplateRuns,
  templateJobRequest,
  templateKindsForSelection,
  templateTitleForKind,
  validateTemplateRequest,
  type AiTemplateRun,
} from '../src/ui/onboarding/ai/ai-template-batch';

function run(kind: AiTemplateRun['kind'], review: AiTemplateRun['review'] = null): AiTemplateRun {
  return { kind, job: null, review };
}

function completedRun(kind: AiTemplateRun['kind'], title: string): AiTemplateRun {
  return run(kind, { id: `${kind}-template`, title } as AiTemplateRun['review']);
}

describe('AI template batch selection', () => {
  it('requires an explicit template selection', () => {
    expect(templateKindsForSelection(null)).toEqual([]);
    expect(validateTemplateRequest({
      selection: null,
      responsibilities: '',
    })).toEqual({ selection: 'Chọn ít nhất một loại lộ trình.' });
  });

  it.each([
    ['normal', ['normal']],
    ['advanced', ['advanced']],
  ] as const)('maps %s to a single template run', (selection, expected) => {
    expect(templateKindsForSelection(selection)).toEqual(expected);
  });

  it('does not require role fields for a normal template', () => {
    expect(validateTemplateRequest({
      selection: 'normal',
      responsibilities: '\n  \n',
    })).toEqual({});
  });

  it.each(['advanced'] as const)(
    'requires two to eight unique responsibilities for %s',
    (selection) => {
      const missing = validateTemplateRequest({
        selection,
        responsibilities: '\n',
      });
      expect(missing.responsibilities).toBe('Nhập từ 2 đến 8 nhiệm vụ chính, mỗi nhiệm vụ một dòng.');

      expect(validateTemplateRequest({
        selection,
        responsibilities: 'Một nhiệm vụ',
      }).responsibilities).toBe('Nhập từ 2 đến 8 nhiệm vụ chính, mỗi nhiệm vụ một dòng.');

      expect(validateTemplateRequest({
        selection,
        responsibilities: Array.from({ length: 9 }, (_, index) => `Nhiệm vụ ${index + 1}`).join('\n'),
      }).responsibilities).toBe('Nhập từ 2 đến 8 nhiệm vụ chính, mỗi nhiệm vụ một dòng.');

      expect(validateTemplateRequest({
        selection,
        responsibilities: '  Nhiệm vụ một  \n\nNhiệm vụ hai',
      })).toEqual({});

      expect(validateTemplateRequest({
        selection,
        responsibilities: Array.from({ length: 8 }, (_, index) => `Nhiệm vụ ${index + 1}`).join('\n'),
      })).toEqual({});
    },
  );

  it('rejects duplicate responsibilities', () => {
    expect(validateTemplateRequest({ selection: 'advanced', responsibilities: 'A\n A ' }).responsibilities).toBeDefined();
    expect(validateTemplateRequest({ selection: 'advanced', responsibilities: 'A\nB' })).toEqual({});
  });
  it('uses the trimmed base title unchanged', () => {
    expect(templateTitleForKind('   ')).toBeUndefined();
    expect(templateTitleForKind('  Hội nhập Khối Vận hành  ')).toBe('Hội nhập Khối Vận hành');
  });
});

describe('AI template batch coordinator', () => {
  it('does not regenerate a run whose review has a blocking flag', async () => {
    const calls: string[] = [];
    const blocked = completedRun('normal', 'blocked');
    await generateTemplateRuns([{ ...blocked, review: { ...blocked.review!, flags: [{ id: 'block', type: 'missing', severity: 'blocking', status: 'open', message: 'Missing', questionForAdmin: 'Resolve?', location: {}, evidence: [] }] } }], async (current) => { calls.push(current.kind); return current; });
    expect(calls).toEqual([]);
  });
  it('stops after a module template is materialized until an explicit next action', async () => {
    const calls: string[] = [];
    const result = await generateTemplateRuns([run('advanced')], async (current) => {
      calls.push(current.kind);
      return { ...completedRun(current.kind, 'Approved'), job: { ...resumableJob(current.kind, 'module-job', 'completed'), pipelineVersion: 'module_v2' } };
    });
    expect(calls).toEqual(['advanced']);
    expect(result).toHaveLength(1);
  });

  it('does not treat a missing review as publish ready', () => {
    expect(aiReviewReadiness(null).allowed).toBe(false);
  });
  it('generates a single run and reports its completed snapshot', async () => {
    const updates: string[][] = [];
    const result = await generateTemplateRuns(
      [run('advanced')],
      async (current) => completedRun(current.kind, current.kind),
      (current) => updates.push(current.map((item) => item.review?.title ?? 'pending')),
    );
    expect(updates).toEqual([['advanced']]);
    expect(result.map((item) => item.review?.title)).toEqual(['advanced']);
  });

  it('skips a run that already has a review', async () => {
    const calls: string[] = [];
    const result = await generateTemplateRuns(
      [completedRun('normal', 'ready')],
      async (current) => { calls.push(current.kind); return completedRun(current.kind, 'new'); },
    );
    expect(calls).toEqual([]);
    expect(result.map((item) => item.review?.title)).toEqual(['ready']);
  });

  it('retains the run and wraps the error when generation fails, then resumes it', async () => {
    let retained: readonly AiTemplateRun[] | undefined;
    try {
      await generateTemplateRuns([run('advanced')], async () => { throw new Error('advanced failed'); });
    } catch (error) {
      expect(error).toBeInstanceOf(AiTemplateGenerationError);
      retained = (error as AiTemplateGenerationError).runs;
    }
    expect(retained?.map((item) => item.review?.title ?? null)).toEqual([null]);

    const retryCalls: string[] = [];
    const resumed = await generateTemplateRuns(retained ?? [], async (current) => {
      retryCalls.push(current.kind);
      return completedRun(current.kind, 'advanced ready');
    });
    expect(retryCalls).toEqual(['advanced']);
    expect(resumed.map((item) => item.review?.title)).toEqual(['advanced ready']);
  });
});

function resumableJob(
  kind: AiTemplateRun['kind'],
  jobId: string,
  status: 'running' | 'completed' | 'failed' = 'running',
  createdBy = 'admin-1',
) {
  return {
    id: `row-${jobId}`,
    roomId: 'room-1',
    jobId,
    kind: 'template' as const,
    status,
    templateKind: kind,
    promptVersion: 'v1',
    calls: [],
    stageOutputs: {},
    result: status === 'completed' ? { templateId: `${kind}-template`, version: 1 } : undefined,
    operationId: `operation-${jobId}`,
    createdBy,
    createdAt: '2026-10-26T09:00:00.000Z',
    updatedAt: '2026-10-26T09:00:00.000Z',
  };
}

describe('AI template batch failure retention', () => {
  it('keeps the live failed job when the coordinator snapshot predates its start', () => {
    const failedAdvanced = resumableJob('advanced', 'advanced-failed', 'failed');
    const merged = mergeTemplateRunJobs([run('advanced')], [{ ...run('advanced'), job: failedAdvanced }]);
    expect(merged[0].job).toBe(failedAdvanced);
  });
});
describe('AI template batch resume and request building', () => {
  it('recovers only the newest target of a persisted incomplete batch when local resume IDs are blank', () => {
    const normal = resumableJob('normal', 'normal-job', 'completed');
    const advanced = resumableJob('advanced', 'advanced-job', 'completed');
    const targets = [normal, advanced].map((job) => ({ kind: job.templateKind, jobId: job.jobId,
      templateId: job.result!.templateId, version: 2, settings: { passingScore: 85, maxAttemptsPerModule: 4, learningMode: 'free' as const } }));
    const runs = selectResumableTemplateRuns({ jobs: [normal, advanced, resumableJob('normal', 'unrelated')], resumeJobIds: [], userId: 'admin-1',
      publicationBatches: [{ batchId: 'batch-1', createdBy: 'admin-1', createdAt: normal.createdAt, targets }] });
    expect(runs).toHaveLength(1);
    expect(runs[0].publicationBatchId).toBe('batch-1');
    expect(runs[0].settings).toEqual(runs[0].publicationTarget?.settings);
  });
  it('returns only the newest owned run when jobs of both kinds exist', () => {
    const normal = { ...resumableJob('normal', 'normal-job', 'completed'), createdAt: '2026-10-26T09:00:00.000Z' };
    const advanced = { ...resumableJob('advanced', 'advanced-job'), createdAt: '2026-10-27T09:00:00.000Z' };
    const otherAdmin = { ...resumableJob('normal', 'other-job', 'running', 'admin-2'), createdAt: '2026-10-28T09:00:00.000Z' };

    const runs = selectResumableTemplateRuns({
      jobs: [advanced, otherAdmin, normal],
      resumeJobIds: ['normal-job', 'advanced-job'],
      userId: 'admin-1',
    });

    expect(runs.map((item) => [item.kind, item.job?.jobId, item.job?.status])).toEqual([
      ['advanced', 'advanced-job', 'running'],
    ]);
  });

  it('restores a saved resume ID under its recorded kind', () => {
    const advanced = resumableJob('advanced', 'legacy-job', 'failed');
    expect(selectResumableTemplateRuns({
      jobs: [advanced],
      resumeJobIds: ['legacy-job'],
      userId: 'admin-1',
    }).map((item) => [item.kind, item.job?.jobId])).toEqual([
      ['advanced', 'legacy-job'],
    ]);
  });

  it('returns nothing when no job is resumable', () => {
    expect(selectResumableTemplateRuns({ jobs: [], resumeJobIds: [null], userId: 'admin-1' })).toEqual([]);
  });

  it('builds normal and advanced requests', () => {
    const common = {
      inventoryJobId: 'inventory-1',
      responsibilities: ' Kiểm soát đơn hàng \n\n Đào tạo quy trình ',
    };

    expect(templateJobRequest({
      ...common,
      selection: 'normal',
      kind: 'normal',
      baseTitle: '  Hội nhập vận hành ',
      operationId: 'operation-normal',
    })).toEqual({
      kind: 'template',
      inventoryJobId: 'inventory-1',
      templateKind: 'normal',
      title: 'Hội nhập vận hành',
      operationId: 'operation-normal',
    });

    expect(templateJobRequest({
      ...common,
      selection: 'advanced',
      kind: 'advanced',
      baseTitle: 'Hội nhập vận hành',
      operationId: 'operation-advanced',
    })).toEqual({
      kind: 'template',
      inventoryJobId: 'inventory-1',
      templateKind: 'advanced',
      roleProfile: {
        responsibilities: ['Kiểm soát đơn hàng', 'Đào tạo quy trình'],
      },
      title: 'Hội nhập vận hành',
      operationId: 'operation-advanced',
    });

  });

  it('builds a responsibilities-only advanced profile', () => {
    expect(templateJobRequest({ selection: 'advanced', kind: 'advanced', inventoryJobId: 'inventory-1', baseTitle: '', responsibilities: 'A\nB', operationId: 'op-1' }).roleProfile).toEqual({ responsibilities: ['A', 'B'] });
  });
  it.each([
    { selection: null, responsibilities: '' },
    { selection: 'advanced' as const, responsibilities: 'Một nhiệm vụ' },
  ])('does not reach job generation for invalid input %#', async (input) => {
    let calls = 0;
    const result = await generateValidatedTemplateRuns({
      ...input,
      runs: [run('normal')],
      generateOne: async (current) => {
        calls += 1;
        return current;
      },
    });

    expect(calls).toBe(0);
    expect(Object.keys(result.errors).length).toBeGreaterThan(0);
  });
});
function reviewRun(
  kind: AiTemplateRun['kind'],
  flagStatus: 'open' | 'resolved' = 'resolved',
): AiTemplateRun {
  const review = {
    id: `${kind}-review`,
    employeeType: kind,
    flags: [{
      id: `${kind}-flag`,
      severity: 'blocking',
      status: flagStatus,
    }],
  } as unknown as NonNullable<AiTemplateRun['review']>;
  return {
    kind,
    job: null,
    review,
    settings: {
      passingScore: kind === 'normal' ? 70 : 80,
      maxAttemptsPerModule: 2,
      learningMode: 'sequential',
    },
  };
}

describe('AI template review sequence', () => {
  it('blocks Next on open mandatory flags', () => {
    const runs = [reviewRun('normal', 'open')];
    expect(aiReviewReadiness(runs[0].review)).toEqual({ allowed: false, blockingCount: 1 });
    expect(reviewAdvanceState(runs)).toEqual({ canBack: false, canNext: false, atPublishSummary: true, blockingCount: 1 });
  });

  it('enables Next after blocking flags resolve and goes straight to the publish summary', () => {
    expect(reviewAdvanceState([reviewRun('advanced')])).toEqual({
      canBack: false,
      canNext: true,
      atPublishSummary: true,
      blockingCount: 0,
    });
  });

  it('has no publish summary without a run', () => {
    expect(reviewAdvanceState([]).atPublishSummary).toBe(false);
  });
});
