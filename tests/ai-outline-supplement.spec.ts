import { describe, expect, it } from 'vitest';

import { AI_GENERATION_LIMITS } from '../src/onboarding/ai/limits';
import { buildSupplementPrompt, buildSupplementRepairPrompt, SUPPLEMENT_OUTLINE_RESERVE_BYTES, validateSupplementOutput } from '../src/onboarding/ai/outline-supplement';
import { batchSources, planBatches } from '../src/onboarding/ai/source-batches';
import type { SourceRecord } from '../src/onboarding/contracts';
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

describe('supplement batches of a Vietnamese source', () => {
  it('sizes batches by UTF-8 bytes so every built S prompt passes bounded()', () => {
    const paragraph = 'Nhân viên mới cần đọc kỹ quy định bảo mật & "dữ liệu nội bộ" trước khi truy cập hệ thống. ';
    const text = paragraph.repeat(Math.ceil(2_000 / paragraph.length)).slice(0, 2_000);
    const sections = Array.from({ length: 60 }, (_, index) => ({
      id: 'so-tay#s' + String(index + 1), headingPath: ['Sổ tay', 'Mục ' + String(index + 1) + ' – Quy định chung'], text,
    }));
    expect(sections.reduce((total, section) => total + section.text.length, 0)).toBeGreaterThanOrEqual(120_000);
    const source = {
      id: 'row', roomId: 'room', sourceId: 'so-tay', kind: 'document', fileName: 'so-tay.pdf', checksum: 'c', systemName: 'PrivOS',
      status: 'ready', sections, textLength: 120_000, createdBy: 'admin', createdAt: 'now', updatedAt: 'now',
    } as unknown as SourceRecord;
    const modules = Array.from({ length: 8 }, (_, index) => ({
      moduleLocalId: 'm' + String(index), order: index, title: 'Bài ' + String(index + 1) + ': Quy trình làm việc đầu tiên',
      description: 'Giới thiệu quy trình, công cụ và đầu mối hỗ trợ dành cho nhân viên mới trong tuần đầu.',
      objectives: ['Nắm được quy trình', 'Biết đầu mối hỗ trợ', 'Áp dụng vào công việc'],
      sectionHeadings: Array.from({ length: 5 }, (_unused, heading) => 'Sổ tay > Mục ' + String(heading + 1) + ' – Quy định chung'),
    }));
    const batches = planBatches([source], { reserveBytes: SUPPLEMENT_OUTLINE_RESERVE_BYTES });
    expect(batches.length).toBeGreaterThan(1);
    batches.forEach((batch, index) => {
      expect(() => buildSupplementPrompt({
        mode: 'new_file', targetModuleLocalId: 'm0', modules,
        sections: batchSources([source], batch).flatMap((item) => item.sections ?? []),
        batch: { index: index + 1, total: batches.length },
      })).not.toThrow();
    });
  });
});
