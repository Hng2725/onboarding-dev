import { describe, expect, it } from 'vitest';

import {
  BLOCK_KIND_LABELS,
  QUESTION_LEVEL_LABELS,
  vietnameseErrorMessage,
} from '../src/ui/onboarding/ai/ai-labels';

describe('ai labels', () => {
  it('never surfaces an English server message', () => {
    expect(vietnameseErrorMessage(Object.assign(new Error('Outline revision conflict.'), { code: 'OPERATION_CONFLICT' }))).toBe('Dữ liệu vừa thay đổi. Hãy thử lại.');
    expect(vietnameseErrorMessage(new Error('Lesson is not ready for approval.'))).toBe('Không thể hoàn tất yêu cầu AI.');
    expect(vietnameseErrorMessage(Object.assign(new Error('x'), { code: 'WHATEVER' }))).toBe('Không thể hoàn tất yêu cầu AI. (mã WHATEVER)');
    expect(vietnameseErrorMessage(new Error('Tài liệu vượt quá giới hạn.'))).toBe('Tài liệu vượt quá giới hạn.');
  });
  it('explains a REVIEW_INVALID rejection in Vietnamese instead of showing the raw code', () => {
    const message = vietnameseErrorMessage(Object.assign(new Error('Change and approve module content in the module workspace first.'), { code: 'REVIEW_INVALID' }));
    expect(message).toBe('Không thể áp dụng thao tác này cho bản nháp. Hãy chỉnh sửa trực tiếp module.');
    expect(message).not.toContain('REVIEW_INVALID');
  });
  it('labels every block kind and question level in Vietnamese', () => {
    expect(BLOCK_KIND_LABELS.concept).toBe('Khái niệm');
    expect(QUESTION_LEVEL_LABELS.procedure).toBe('Quy trình');
  });
});
