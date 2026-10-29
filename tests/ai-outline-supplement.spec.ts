import { describe, expect, it } from 'vitest';

import { AI_GENERATION_LIMITS } from '../src/onboarding/ai/limits';
import { buildSupplementPrompt, buildSupplementRepairPrompt, validateSupplementOutput } from '../src/onboarding/ai/outline-supplement';
import { VIETNAMESE_OUTPUT_RULE } from '../src/onboarding/ai/prompts';

const modules = [
  { moduleLocalId: 'm1', order: 0, title: 'Tổng quan', description: 'Bức tranh chung.', objectives: ['Nắm quy trình'], sectionHeadings: ['Duyệt đơn'] },
  { moduleLocalId: 'm2', order: 1, title: 'Hỗ trợ khi gặp lỗi', description: '', objectives: [], gapNote: 'Tài liệu chưa nói về lỗi.', sectionHeadings: [] },
];

describe('supplement prompt', () => {
  it('sends only the new file sections in full in new_file mode', () => {
    const request = buildSupplementPrompt({
      mode: 'new_file', targetModuleLocalId: 'm2', modules,
      sections: [{ id: 'new#s1', headingPath: ['Xử lý lỗi'], text: 'Liên hệ bộ phận hỗ trợ khi đơn bị lỗi.' }],
    });
    expect(request.systemContext).toContain('new#s1');
    expect(request.systemContext).toContain('Liên hệ bộ phận hỗ trợ khi đơn bị lỗi.');
    expect(request.systemContext).toContain('Duyệt đơn');
    expect(request.systemContext).not.toContain('old#s1');
    expect(request.systemContext).toContain('m2');
    expect(request.prompt).toContain(VIETNAMESE_OUTPUT_RULE);
    expect(request.prompt).toContain('attachments');
    expect(request.prompt).toContain('coverageUpdates');
  });

  it('limits every catalog excerpt to 300 characters', () => {
    const request = buildSupplementPrompt({
      mode: 'catalog', targetModuleLocalId: 'm2', modules,
      sections: [
        { id: 'old#s1', headingPath: ['Duyệt đơn'], excerpt: 'x'.repeat(1_000) },
        { id: 'old#s2', headingPath: ['Báo cáo'], excerpt: 'y'.repeat(120) },
      ],
    });
    expect(request.systemContext).toContain('old#s1');
    expect(request.systemContext).toContain('x'.repeat(300));
    expect(request.systemContext).not.toContain('x'.repeat(301));
    expect(request.systemContext).toContain('y'.repeat(120));
  });

  it('stays within the prompt and context limits for a large catalog', () => {
    const sections = Array.from({ length: 200 }, (_, i) => ({ id: 'source-1#s' + String(i), headingPath: ['Mục ' + String(i)], excerpt: 'Nội dung '.repeat(40) }));
    const request = buildSupplementPrompt({ mode: 'catalog', targetModuleLocalId: 'm2', modules, sections });
    expect(Buffer.byteLength(request.prompt, 'utf8')).toBeLessThanOrEqual(AI_GENERATION_LIMITS.maxPromptChars);
    expect(Buffer.byteLength(request.systemContext, 'utf8')).toBeLessThanOrEqual(AI_GENERATION_LIMITS.maxSystemContextChars);
  });

  it('repairs with the parsed previous output and the errors', () => {
    const request = buildSupplementRepairPrompt({
      mode: 'catalog', targetModuleLocalId: 'm2', modules,
      sections: [{ id: 'old#s1', headingPath: ['Duyệt đơn'], excerpt: 'Bấm nút Gửi duyệt.' }],
      previous: { attachments: 'oops' }, errors: ['attachments must be an array.'],
    });
    expect(request.prompt).toContain('attachments must be an array.');
    expect(request.systemContext).toContain('previous_output');
  });
});

describe('supplement output validation', () => {
  const allowed = { allowedSectionIds: new Set(['new#s1', 'new#s2']), moduleIds: new Set(['m1', 'm2']) };

  it('drops ids outside the allowed sets and merges a module listed twice', () => {
    const result = validateSupplementOutput({
      attachments: [
        { moduleLocalId: 'm2', sectionIds: ['new#s1', 'old#s1'], reason: 'Nói về lỗi.' },
        { moduleLocalId: 'ghost', sectionIds: ['new#s2'], reason: 'x' },
        { moduleLocalId: 'm2', sectionIds: ['new#s2', 'new#s1'], reason: 'Thêm.' },
        { moduleLocalId: 'm1', sectionIds: ['bogus'], reason: 'x' },
      ],
      coverageUpdates: [
        { moduleLocalId: 'm2', coverage: 'sufficient', gapNote: '' },
        { moduleLocalId: 'ghost', coverage: 'sufficient', gapNote: '' },
        { moduleLocalId: 'm1', coverage: 'maybe', gapNote: '' },
      ],
    }, allowed);
    expect(result).toEqual({ ok: true, value: {
      attachments: [{ moduleLocalId: 'm2', sectionIds: ['new#s1', 'new#s2'], reason: 'Nói về lỗi.' }],
      coverageUpdates: [{ moduleLocalId: 'm2', coverage: 'sufficient', gapNote: '' }],
    } });
  });

  it('treats a missing coverageUpdates list as empty', () => {
    expect(validateSupplementOutput({ attachments: [] }, allowed)).toEqual({ ok: true, value: { attachments: [], coverageUpdates: [] } });
  });

  it('rejects output that is not an object or has no attachments array', () => {
    expect(validateSupplementOutput([], allowed).ok).toBe(false);
    expect(validateSupplementOutput({ attachments: 'x' }, allowed).ok).toBe(false);
    expect(validateSupplementOutput({ attachments: [], coverageUpdates: 'x' }, allowed).ok).toBe(false);
  });
});
