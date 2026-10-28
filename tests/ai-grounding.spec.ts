import { describe, expect, it } from 'vitest';

import type { SourceRecord } from '../src/onboarding/contracts';
import {
  groundSourceRef,
  normalizeForMatch,
  unsupportedEmphasizedTerms,
} from '../src/onboarding/ai/grounding';
import { buildFallbackLesson } from '../src/onboarding/ai/fallback-lessons';

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'row-1',
    roomId: 'room-a',
    sourceId: 'source-1',
    kind: 'document',
    fileName: 'guide.md',
    checksum: 'checksum',
    systemName: 'PrivOS',
    status: 'ready',
    sections: [{
      id: 'source-1#s1',
      headingPath: ['Quy trình'],
      page: 7,
      text: 'Để tạo đơn hàng, chọn menu “Bán hàng”  rồi bấm nút **Gửi duyệt**.',
    }],
    textLength: 72,
    createdBy: 'admin-1',
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    ...overrides,
  };
}

describe('AI source grounding', () => {
  it('grounds fallback quotes against the exact selected source section', () => {
    const record = source();
    const section = record.sections![0];
    const result = buildFallbackLesson({
      outline: { moduleLocalId: 'm1', frameKey: 'core', order: 1, title: 'Guide', description: '', estimatedMinutes: 5, objectives: [], featureIds: [], sourceSectionIds: [section.id], responsibilityIndexes: [] },
      sections: [section],
    });
    expect(result.kind).toBe('draft');
    if (result.kind !== 'draft') return;
    for (const block of result.module.blocks.filter((item) => item.kind !== 'summary')) {
      expect(block.sourceRefs).toHaveLength(1);
      expect(groundSourceRef(block.sourceRefs[0], [record]).ok).toBe(true);
    }
  });
  it('normalizes Vietnamese case, curly quotes, markdown emphasis, and whitespace', () => {
    expect(normalizeForMatch('  “GỬI   **Duyệt**”  ')).toBe('"gửi duyệt"');
  });

  it('grounds an exact normalized quote and fills trusted source metadata', () => {
    expect(groundSourceRef({
      sectionId: 'source-1#s1',
      quote: 'chọn menu "Bán hàng" rồi bấm nút Gửi duyệt',
    }, [source()])).toEqual({
      ok: true,
      ref: {
        kind: 'document',
        sourceId: 'source-1',
        sectionId: 'source-1#s1',
        page: 7,
        quote: 'chọn menu "Bán hàng" rồi bấm nút Gửi duyệt',
      },
    });
  });

  it.each([
    [{ sectionId: 'missing#s1', quote: 'một đoạn trích đủ dài' }, 'SOURCE_REF_SECTION_UNKNOWN'],
    [{ sectionId: 'source-1#s1', quote: 'ngắn' }, 'SOURCE_REF_QUOTE_LENGTH'],
    [{ sectionId: 'source-1#s1', quote: 'Đây là chính sách do AI tự bịa ra.' }, 'SOURCE_REF_QUOTE_MISMATCH'],
  ])('rejects nonexistent or unsupported references', (raw, code) => {
    expect(groundSourceRef(raw, [source()])).toMatchObject({ ok: false, issue: { code } });
  });

  it('does not ground against a deleted source and detects invented emphasized terms', () => {
    expect(groundSourceRef({
      sectionId: 'source-1#s1',
      quote: 'chọn menu "Bán hàng"',
    }, [source({ deletedAt: '2026-10-23T01:00:00Z' })])).toMatchObject({
      ok: false,
      issue: { code: 'SOURCE_REF_SECTION_UNKNOWN' },
    });
    expect(unsupportedEmphasizedTerms(
      'Chọn **Bán hàng**, sau đó bấm `Tự động phê duyệt`.',
      [source()],
    )).toEqual(['Tự động phê duyệt']);
  });
});
