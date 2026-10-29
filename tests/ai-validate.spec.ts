import { describe, expect, it } from 'vitest';

import {
  removeQuestionsBlockedByFlags,
  validateGeneratedTemplate,
} from '../src/onboarding/ai/validate';

const ref = { sectionId: 'source-1#s1', quote: 'Một đoạn trích nguồn đủ dài.' };

function moduleAt(frameKey: string, index: number, advanced = false) {
  const localId = 'm' + String(index);
  const conceptId = localId + '-b1';
  const blocks = [
    {
      localId: conceptId,
      kind: 'concept',
      body: 'Nội dung có căn cứ trong tài liệu.',
      sourceRefs: [ref],
    },
    ...(advanced ? [{
      localId: localId + '-b2',
      kind: 'scenario',
      body: 'Tình huống công việc có căn cứ.',
      sourceRefs: [ref],
    }] : []),
    {
      localId: localId + '-summary',
      kind: 'summary',
      body: 'Tóm tắt nội dung chính.',
      sourceRefs: [],
    },
  ];
  return {
    localId,
    frameKey,
    title: 'Module ' + String(index),
    description: 'Mô tả ngắn cho module.',
    estimatedMinutes: 8,
    objectives: ['Hiểu nội dung', 'Thực hiện đúng'],
    featureIds: ['feat-' + String(index)],
    blocks,
    questions: [1, 2, 3].map((questionIndex) => ({
      localId: localId + '-q' + String(questionIndex),
      level: questionIndex === 1 ? 'recall' : questionIndex === 2 ? 'procedure' : 'scenario',
      prompt: 'Câu hỏi số ' + String(questionIndex) + ' là gì?',
      options: [
        { id: 'a', label: 'Lựa chọn đúng' },
        { id: 'b', label: 'Lựa chọn nhiễu một' },
        { id: 'c', label: 'Lựa chọn nhiễu hai' },
        { id: 'd', label: 'Lựa chọn nhiễu ba' },
      ],
      correctOptionId: 'a',
      explanation: 'Đáp án đúng vì nội dung này đã được nêu rõ trong tài liệu.',
      blockIds: [conceptId],
      sourceRefs: [ref],
    })),
  };
}

function normalTemplate(): Record<string, unknown> {
  return {
    title: 'Lộ trình cơ bản',
    description: 'Dành cho nhân sự thông thường.',
    generationNotes: [],
    modules: [
      moduleAt('t1-overview', 1),
      moduleAt('t1-access', 2),
      moduleAt('t1-core', 3),
      moduleAt('t1-support', 4),
    ],
    flags: [],
  };
}

function advancedTemplate(): Record<string, unknown> {
  return {
    title: 'Lộ trình chuyên sâu',
    description: 'Dành cho chuyên viên bán hàng.',
    generationNotes: [],
    modules: [
      moduleAt('t2-role', 1, true),
      moduleAt('t2-permissions', 2, true),
      moduleAt('t2-task-1', 3, true),
      moduleAt('t2-task-2', 4, true),
      moduleAt('t2-control', 5, true),
    ],
    flags: [{
      type: 'missing',
      severity: 'blocking',
      message: 'Thiếu tính năng cho nhiệm vụ Đối soát.',
      questionForAdmin: 'Nhiệm vụ Đối soát thực hiện ở đâu?',
      location: {},
      evidence: [],
    }],
    taskCoverage: [
      {
        task: 'Tạo đơn hàng',
        featureIds: ['feat-3'],
        relevance: 'explicit',
        relevanceRationale: '',
        moduleLocalId: 'm3',
        flagIndex: null,
      },
      {
        task: 'Đối soát',
        featureIds: [],
        relevance: 'inferred',
        relevanceRationale: 'Chưa có tính năng tương ứng trong tài liệu.',
        moduleLocalId: null,
        flagIndex: 0,
      },
    ],
  };
}

describe('generated template validator', () => {
  it('accepts valid normal and advanced structures', () => {
    expect(validateGeneratedTemplate(normalTemplate(), { templateKind: 'normal' })).toMatchObject({
      ok: true,
    });
    expect(validateGeneratedTemplate(advancedTemplate(), {
      templateKind: 'advanced',
      roleProfile: {
        department: 'sales',
        jobTitle: 'Chuyên viên',
        responsibilities: ['Tạo đơn hàng', 'Đối soát'],
      },
    })).toMatchObject({ ok: true });
  });

  it.each([
    ['unknown root field', (draft: any) => { draft.secrets = ['TOKEN']; }, 'UNKNOWN_FIELD'],
    ['duplicate local ID', (draft: any) => { draft.modules[1].localId = 'm1'; }, 'DUPLICATE_ID'],
    ['invalid module count', (draft: any) => { draft.modules = draft.modules.slice(0, 3); }, 'MODULE_COUNT'],
    ['invalid frame order', (draft: any) => { [draft.modules[0], draft.modules[1]] = [draft.modules[1], draft.modules[0]]; }, 'FRAME_ORDER'],
    ['too few objectives', (draft: any) => { draft.modules[0].objectives = ['Một']; }, 'OBJECTIVE_COUNT'],
    ['summary not last', (draft: any) => { draft.modules[0].blocks.reverse(); }, 'SUMMARY_POSITION'],
    ['wrong option IDs', (draft: any) => { draft.modules[0].questions[0].options[3].id = 'e'; }, 'OPTION_IDS'],
    ['duplicate option labels', (draft: any) => { draft.modules[0].questions[0].options[1].label = 'Lựa chọn đúng'; }, 'OPTION_LABEL_DUPLICATE'],
    ['forbidden option', (draft: any) => { draft.modules[0].questions[0].options[1].label = 'Tất cả đáp án trên'; }, 'OPTION_FORBIDDEN'],
    ['bad explanation', (draft: any) => { draft.modules[0].questions[0].explanation = 'Quá ngắn'; }, 'EXPLANATION_LENGTH'],
    ['unknown block', (draft: any) => { draft.modules[0].questions[0].blockIds = ['missing']; }, 'QUESTION_BLOCK_UNKNOWN'],
  ])('rejects %s with a stable code', (_label, mutate, code) => {
    const draft = normalTemplate();
    mutate(draft);
    expect(validateGeneratedTemplate(draft, { templateKind: 'normal' })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  it('normalizes recurring flag and note shapes deterministically before validating', () => {
    const draft = normalTemplate();
    draft.generationNotes = 'Một ghi chú duy nhất.';
    draft.flags = [
      {
        id: 'inv-flag-1',
        featureId: 'feat-1',
        type: 'conflict',
        severity: 'warning',
        message: 'Hai tài liệu mâu thuẫn.',
        questionForAdmin: 'Tài liệu nào đúng?',
        evidence: [ref, { sectionId: 'source-1#s2', quote: 'Một đoạn trích khác đủ dài.' }],
      },
      {
        type: 'ambiguous',
        severity: 'blocking',
        message: 'Chưa rõ đối tượng.',
        questionForAdmin: 'Ai dùng tính năng này?',
        location: { frameKey: 't1-access', blockId: 'm2-b1', questionId: 'm2-q1' },
        evidence: [],
      },
      {
        type: 'missing',
        severity: 'warning',
        message: 'Thiếu mô tả.',
        questionForAdmin: 'Bổ sung ở đâu?',
        location: { moduleId: 'm3' },
        evidence: [],
      },
    ];

    const result = validateGeneratedTemplate(draft, { templateKind: 'normal' });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.generationNotes).toEqual(['Một ghi chú duy nhất.']);
    expect(result.value.flags).toEqual([
      expect.objectContaining({ type: 'conflict', severity: 'blocking', location: { featureId: 'feat-1' } }),
      expect.objectContaining({
        type: 'ambiguous',
        severity: 'warning',
        location: { moduleLocalId: 'm2', blockLocalId: 'm2-b1', questionLocalId: 'm2-q1' },
      }),
      expect.objectContaining({ type: 'missing', severity: 'warning', location: { moduleLocalId: 'm3' } }),
    ]);
  });

  it('accepts option text as the option label', () => {
    const draft = normalTemplate() as any;
    draft.modules[0].questions[0].options = draft.modules[0].questions[0].options
      .map((option: { id: string; label: string }) => ({ id: option.id, text: option.label }));

    const result = validateGeneratedTemplate(draft, { templateKind: 'normal' });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.modules[0].questions[0].options[0]).toEqual({ id: 'a', label: 'Lựa chọn đúng' });
  });

  it('reports every validation error so repair scope can cover all failing modules', () => {
    const draft = normalTemplate() as any;
    for (const module of draft.modules) {
      for (const question of module.questions) question.explanation = 'Ngắn';
      module.objectives = ['Một'];
    }
    for (const question of draft.modules[0].questions) question.options = [{}, {}, {}, {}];

    const result = validateGeneratedTemplate(draft, { templateKind: 'normal' });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(30);
    expect(result.errors.some((error) => error.path.startsWith('root.modules[3]'))).toBe(true);
  });

  it('still rejects flag content that normalization cannot repair', () => {
    const draft = normalTemplate();
    draft.flags = [{
      type: 'conflict',
      severity: 'blocking',
      message: 'Mâu thuẫn.',
      questionForAdmin: 'Đúng là gì?',
      location: {},
      evidence: [ref],
      secret: 'x',
    }];

    expect(validateGeneratedTemplate(draft, { templateKind: 'normal' })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'FLAG_EVIDENCE' }),
        expect.objectContaining({ code: 'UNKNOWN_FIELD' }),
      ]),
    });
  });

  it('requires advanced scenarios and exact responsibility coverage', () => {
    const draft: any = advancedTemplate();
    draft.modules[0].blocks = draft.modules[0].blocks.filter((block: any) => block.kind !== 'scenario');
    draft.taskCoverage[1].task = 'Nhiệm vụ khác';

    const result = validateGeneratedTemplate(draft, {
      templateKind: 'advanced',
      roleProfile: {
        department: 'sales',
        jobTitle: 'Chuyên viên',
        responsibilities: ['Tạo đơn hàng', 'Đối soát'],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'SCENARIO_REQUIRED' }),
        expect.objectContaining({ code: 'RESPONSIBILITY_COVERAGE' }),
      ]),
    });
  });

  it('removes questions that rely on a block with an open blocking flag', () => {
    const draft: any = normalTemplate();
    draft.flags.push({
      type: 'conflict',
      severity: 'blocking',
      message: 'Hai tài liệu mô tả khác nhau.',
      questionForAdmin: 'Phiên bản nào đúng?',
      location: { moduleLocalId: 'm1', blockLocalId: 'm1-b1' },
      evidence: [
        { sectionId: 'source-1#s2', quote: 'Tài liệu phiên bản một mô tả nút Gửi.' },
        { sectionId: 'source-2#s1', quote: 'Tài liệu phiên bản hai mô tả nút Trình.' },
      ],
    });
    const validated = validateGeneratedTemplate(draft, { templateKind: 'normal' });
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error('expected valid fixture');

    const safe = removeQuestionsBlockedByFlags(validated.value);
    expect(safe.removedQuestionIds).toEqual(['m1-q1', 'm1-q2', 'm1-q3']);
    expect(safe.template.modules[0].questions).toEqual([]);
  });
});

describe('parseFlags tolerance', () => {
  it('defaults a missing location without an error and records dropped flags in notes', async () => {
    const { parseFlags } = await import('../src/onboarding/ai/validate');
    const errors: never[] = [];
    const notes: string[] = [];
    const flags = parseFlags([
      { type: 'ambiguous', severity: 'warning', message: 'm', questionForAdmin: 'q', evidence: [] },
      { severity: 'warning', message: 'm', questionForAdmin: 'q', evidence: [] },
    ], errors, { defaultLocation: { moduleLocalId: 'm1' }, notes });
    expect(errors).toEqual([]);
    expect(flags).toHaveLength(1);
    expect(flags[0].location).toEqual({ moduleLocalId: 'm1' });
    expect(notes).toEqual(['Bỏ cờ không hợp lệ ở vị trí 1']);
  });
});
