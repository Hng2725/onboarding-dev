import { describe, expect, it } from 'vitest';

import {
  AiTemplateGenerationError,
  aiReviewReadiness,
  generateTemplateRuns,
  generateValidatedTemplateRuns,
  mergeTemplateRunJobs,
  moveReviewIndex,
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
    ['both', ['normal', 'advanced']],
  ] as const)('maps %s to its ordered template runs', (selection, expected) => {
    expect(templateKindsForSelection(selection)).toEqual(expected);
  });

  it('does not require role fields for a normal template', () => {
    expect(validateTemplateRequest({
      selection: 'normal',
      responsibilities: '\n  \n',
    })).toEqual({});
  });

  it.each(['advanced', 'both'] as const)(
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
  it('derives distinct titles only when both templates are selected', () => {
    expect(templateTitleForKind('   ', 'normal', 'normal')).toBeUndefined();
    expect(templateTitleForKind('  Hội nhập Khối Vận hành  ', 'normal', 'normal'))
      .toBe('Hội nhập Khối Vận hành');
    expect(templateTitleForKind('Hội nhập Khối Vận hành', 'advanced', 'advanced'))
      .toBe('Hội nhập Khối Vận hành');
    expect(templateTitleForKind('Hội nhập Khối Vận hành', 'both', 'normal'))
      .toBe('Hội nhập Khối Vận hành – Template 1');
    expect(templateTitleForKind('Hội nhập Khối Vận hành', 'both', 'advanced'))
      .toBe('Hội nhập Khối Vận hành – Template 2');
  });
});

describe('AI template batch coordinator', () => {
  it('awaits normal before advanced and reports each completed snapshot', async () => {
    const calls: string[] = [];
    const updates: string[][] = [];
    let releaseNormal: (() => void) | undefined;
    const normalGate = new Promise<void>((resolve) => {
      releaseNormal = resolve;
    });

    const pending = generateTemplateRuns(
      [run('normal'), run('advanced')],
      async (current) => {
        calls.push(current.kind);
        if (current.kind === 'normal') await normalGate;
        return completedRun(current.kind, current.kind);
      },
      (current) => updates.push(current.map((item) => item.review?.title ?? 'pending')),
    );

    await Promise.resolve();
    expect(calls).toEqual(['normal']);
    releaseNormal?.();

    const result = await pending;
    expect(calls).toEqual(['normal', 'advanced']);
    expect(updates).toEqual([
      ['normal', 'pending'],
      ['normal', 'advanced'],
    ]);
    expect(result.map((item) => item.review?.title)).toEqual(['normal', 'advanced']);
  });

  it('skips a run that already has a review', async () => {
    const calls: string[] = [];
    const result = await generateTemplateRuns(
      [completedRun('normal', 'ready'), run('advanced')],
      async (current) => {
        calls.push(current.kind);
        return completedRun(current.kind, 'new');
      },
    );

    expect(calls).toEqual(['advanced']);
    expect(result.map((item) => item.review?.title)).toEqual(['ready', 'new']);
  });

  it('retains the completed normal review when advanced fails and resumes only advanced', async () => {
    const firstCalls: string[] = [];
    let retained: readonly AiTemplateRun[] | undefined;

    try {
      await generateTemplateRuns([run('normal'), run('advanced')], async (current) => {
        firstCalls.push(current.kind);
        if (current.kind === 'advanced') throw new Error('advanced failed');
        return completedRun('normal', 'normal ready');
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AiTemplateGenerationError);
      retained = (error as AiTemplateGenerationError).runs;
    }

    expect(firstCalls).toEqual(['normal', 'advanced']);
    expect(retained?.map((item) => item.review?.title ?? null)).toEqual(['normal ready', null]);

    const retryCalls: string[] = [];
    const resumed = await generateTemplateRuns(retained ?? [], async (current) => {
      retryCalls.push(current.kind);
      return completedRun(current.kind, 'advanced ready');
    });

    expect(retryCalls).toEqual(['advanced']);
    expect(resumed.map((item) => item.review?.title)).toEqual(['normal ready', 'advanced ready']);
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
  it('keeps the live failed Template 2 job when the coordinator snapshot predates its start', () => {
    const failedAdvanced = resumableJob('advanced', 'advanced-failed', 'failed');
    const merged = mergeTemplateRunJobs(
      [completedRun('normal', 'normal ready'), run('advanced')],
      [completedRun('normal', 'normal ready'), { ...run('advanced'), job: failedAdvanced }],
    );

    expect(merged[0].review?.title).toBe('normal ready');
    expect(merged[1].job).toBe(failedAdvanced);
  });
});
describe('AI template batch resume and request building', () => {
  it('restores owned normal and advanced resume IDs in template order', () => {
    const normal = resumableJob('normal', 'normal-job', 'completed');
    const advanced = resumableJob('advanced', 'advanced-job');
    const otherAdmin = resumableJob('normal', 'other-job', 'running', 'admin-2');

    const runs = selectResumableTemplateRuns({
      jobs: [advanced, otherAdmin, normal],
      resumeJobIds: { normal: 'normal-job', advanced: 'advanced-job' },
      userId: 'admin-1',
    });

    expect(runs.map((item) => [item.kind, item.job?.jobId, item.job?.status])).toEqual([
      ['normal', 'normal-job', 'completed'],
      ['advanced', 'advanced-job', 'running'],
    ]);
  });

  it('restores a legacy template resume ID under its recorded kind', () => {
    const advanced = resumableJob('advanced', 'legacy-job', 'failed');
    expect(selectResumableTemplateRuns({
      jobs: [advanced],
      resumeJobIds: {},
      legacyTemplateJobId: 'legacy-job',
      userId: 'admin-1',
    }).map((item) => [item.kind, item.job?.jobId])).toEqual([
      ['advanced', 'legacy-job'],
    ]);
  });

  it('preserves a completed normal run while advanced is resumable', () => {
    const runs = selectResumableTemplateRuns({
      jobs: [
        resumableJob('advanced', 'advanced-running'),
        resumableJob('normal', 'normal-completed', 'completed'),
      ],
      resumeJobIds: { normal: 'normal-completed', advanced: 'advanced-running' },
      userId: 'admin-1',
    });

    expect(runs[0]).toMatchObject({ kind: 'normal', job: { status: 'completed' } });
    expect(runs[1]).toMatchObject({ kind: 'advanced', job: { status: 'running' } });
  });

  it('builds normal and advanced requests with distinct titles for both', () => {
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

    expect(templateJobRequest({
      ...common,
      selection: 'both',
      kind: 'normal',
      baseTitle: 'Hội nhập vận hành',
      operationId: 'operation-both-normal',
    }).title).toBe('Hội nhập vận hành – Template 1');
    expect(templateJobRequest({
      ...common,
      selection: 'both',
      kind: 'advanced',
      baseTitle: 'Hội nhập vận hành',
      operationId: 'operation-both-advanced',
    }).title).toBe('Hội nhập vận hành – Template 2');
  });

  it('builds a responsibilities-only advanced profile', () => {
    expect(templateJobRequest({ selection: 'advanced', kind: 'advanced', inventoryJobId: 'inventory-1', baseTitle: '', responsibilities: 'A\nB', operationId: 'op-1' }).roleProfile).toEqual({ responsibilities: ['A', 'B'] });
  });
  it.each([
    { selection: null, responsibilities: '' },
    { selection: 'advanced' as const, responsibilities: 'Một nhiệm vụ' },
    { selection: 'both' as const, responsibilities: '' },
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
  it('starts both-template review at Template 1 and blocks Next on open mandatory flags', () => {
    const runs = [reviewRun('normal', 'open'), reviewRun('advanced')];
    expect(runs[0].kind).toBe('normal');
    expect(aiReviewReadiness(runs[0].review)).toEqual({ allowed: false, blockingCount: 1 });
    expect(reviewAdvanceState(runs, 0)).toEqual({
      canBack: false,
      canNext: false,
      atPublishSummary: false,
      blockingCount: 1,
    });
  });

  it('enables Next after blocking flags resolve and points the last template to publish summary', () => {
    const runs = [reviewRun('normal'), reviewRun('advanced')];
    expect(reviewAdvanceState(runs, 0)).toEqual({
      canBack: false,
      canNext: true,
      atPublishSummary: false,
      blockingCount: 0,
    });
    expect(reviewAdvanceState(runs, 1)).toEqual({
      canBack: true,
      canNext: true,
      atPublishSummary: true,
      blockingCount: 0,
    });
  });

  it('moves Back without replacing either review or settings object', () => {
    const runs = [reviewRun('normal'), reviewRun('advanced')];
    const moved = moveReviewIndex(runs, 1, 'back');
    expect(moved.index).toBe(0);
    expect(moved.runs).toBe(runs);
    expect(moved.runs[0].review).toBe(runs[0].review);
    expect(moved.runs[0].settings).toBe(runs[0].settings);
    expect(moved.runs[1].review).toBe(runs[1].review);
    expect(moved.runs[1].settings).toBe(runs[1].settings);
  });

  it('keeps a single template on the direct review-to-publish path', () => {
    expect(reviewAdvanceState([reviewRun('advanced')], 0)).toEqual({
      canBack: false,
      canNext: true,
      atPublishSummary: true,
      blockingCount: 0,
    });
  });
});