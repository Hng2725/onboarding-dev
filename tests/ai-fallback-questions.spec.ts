import { describe, expect, it } from 'vitest';

import { buildFallbackQuestions } from '../src/onboarding/ai/fallback-questions';
import type { GeneratedBlock, GeneratedModule } from '../src/onboarding/ai/validate';

const groundedBlocks: readonly GeneratedBlock[] = [
  {
    localId: 'block-account',
    kind: 'concept',
    title: 'Tài khoản',
    body: 'Nhân viên phải đổi mật khẩu tạm trong ngày đầu tiên.',
    sourceRefs: [{ sectionId: 'section-1', quote: 'Nhân viên phải đổi mật khẩu tạm trong ngày đầu tiên.' }],
  },
  {
    localId: 'block-mfa',
    kind: 'steps',
    title: 'Bảo mật',
    body: 'Bật xác thực đa yếu tố trước khi sử dụng hệ thống.',
    steps: [{ order: 1, text: 'Bật xác thực đa yếu tố trước khi sử dụng hệ thống.' }],
    sourceRefs: [{ sectionId: 'section-1', quote: 'Bật xác thực đa yếu tố trước khi sử dụng hệ thống.' }],
  },
  {
    localId: 'block-support',
    kind: 'warning',
    title: 'Hỗ trợ',
    body: 'Mở yêu cầu tại cổng Service Desk nếu không đăng nhập được.',
    sourceRefs: [{ sectionId: 'section-2', quote: 'Mở yêu cầu tại cổng Service Desk nếu không đăng nhập được.' }],
  },
];

function lesson(blocks: readonly GeneratedBlock[] = groundedBlocks): GeneratedModule {
  return {
    localId: 'module-access',
    frameKey: 't1-access',
    title: 'Tài khoản và quyền truy cập',
    description: 'Thiết lập truy cập an toàn.',
    estimatedMinutes: 10,
    objectives: ['Thiết lập tài khoản an toàn'],
    featureIds: ['access'],
    blocks,
    questions: [],
  };
}

describe('grounded fallback questions', () => {
  it('builds exactly three deterministic recognition questions from grounded lesson blocks', () => {
    const first = buildFallbackQuestions({ lesson: lesson() });
    const second = buildFallbackQuestions({ lesson: lesson() });

    expect(first).toEqual(second);
    expect(first.kind).toBe('draft');
    if (first.kind !== 'draft') throw new Error('Expected fallback draft');
    expect(first.provenance).toBe('fallback');
    expect(first.questions).toHaveLength(3);
    expect(new Set(first.questions.map((question) => question.localId))).toHaveLength(3);
    expect(new Set(first.questions.map((question) => question.prompt))).toHaveLength(3);
    for (const question of first.questions) {
      expect(question.options.map((option) => option.id)).toEqual(['a', 'b', 'c', 'd']);
      expect(question.correctOptionId).toBe('a');
      expect(question.explanation.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('uses three distinct prompts when one grounded block has fewer than three statements', () => {
    const onlyBlock = groundedBlocks[0];
    const result = buildFallbackQuestions({ lesson: lesson([onlyBlock]) });

    expect(result.kind).toBe('draft');
    if (result.kind !== 'draft') throw new Error('Expected fallback draft');
    expect(result.questions).toHaveLength(3);
    expect(new Set(result.questions.map((question) => question.prompt))).toHaveLength(3);
    expect(result.questions.every((question) => question.blockIds.length === 1 && question.blockIds[0] === onlyBlock.localId)).toBe(true);
  });

  it('copies only block-local ids and source references', () => {
    const summary: GeneratedBlock = {
      localId: 'summary', kind: 'summary', body: 'Tóm tắt',
      sourceRefs: [{ sectionId: 'summary-source', quote: 'Nguồn chỉ dành cho phần tóm tắt.' }],
    };
    const result = buildFallbackQuestions({ lesson: lesson([...groundedBlocks, summary]) });

    expect(result.kind).toBe('draft');
    if (result.kind !== 'draft') throw new Error('Expected fallback draft');
    for (const question of result.questions) {
      expect(question.blockIds).toHaveLength(1);
      const owner = groundedBlocks.find((block) => block.localId === question.blockIds[0]);
      expect(owner).toBeDefined();
      expect(question.sourceRefs).toEqual(owner!.sourceRefs);
      expect(question.sourceRefs.some((ref) => ref.sectionId === 'summary-source')).toBe(false);
    }
  });

  it('returns manual_required when no non-summary block has a source reference', () => {
    const result = buildFallbackQuestions({
      lesson: lesson([
        { localId: 'content', kind: 'concept', body: 'Nội dung do Admin tự soạn.', sourceRefs: [] },
        { localId: 'summary', kind: 'summary', body: 'Tóm tắt', sourceRefs: [{ sectionId: 's1', quote: 'Dẫn chứng chỉ ở summary.' }] },
      ]),
    });

    expect(result).toEqual({ kind: 'manual_required', reason: 'NO_GROUNDED_LESSON_BLOCK' });
  });
});
