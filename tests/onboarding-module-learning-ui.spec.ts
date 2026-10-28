import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ModuleStateDto, TemplateResource } from '../src/onboarding/contracts';
import { LessonMarkdown } from '../src/ui/onboarding/ai/lesson-markdown';
import {
  canCompleteLesson,
  generatedLessonResource,
  moduleProgressPercent,
  moduleStatusLabel,
  remainingAttemptsLabel,
} from '../src/ui/onboarding/module-learning';

function state(
  status: ModuleStateDto['status'],
  attemptsUsed = 0,
  attemptsAllowed: number | null = 2,
): ModuleStateDto {
  return { moduleId: status, title: status, order: 1, status, attemptsUsed, attemptsAllowed };
}

describe('per-module learner UI', () => {
  it('defaults generated modules to their required AI lesson PDF', () => {
    const resources: readonly TemplateResource[] = [
      { id: 'handbook', title: 'Handbook', kind: 'file', required: true, fileId: 'file-handbook' },
      { id: 'ai-lesson-pdf-module-1', title: 'Tài liệu bài học', kind: 'file', required: true, fileId: 'file-ai' },
    ];
    expect(generatedLessonResource(resources)?.fileId).toBe('file-ai');
    expect(generatedLessonResource([{ ...resources[1], required: false }])).toBeUndefined();
    expect(generatedLessonResource([{ ...resources[1], id: 'manual' }])).toBeUndefined();
  });

  it('allows lesson completion after the generated PDF opens or the readable summary is seen', () => {
    expect(canCompleteLesson({ hasGeneratedPdf: true, pdfOpened: true, summarySeen: false })).toBe(true);
    expect(canCompleteLesson({ hasGeneratedPdf: true, pdfOpened: false, summarySeen: true })).toBe(true);
    expect(canCompleteLesson({ hasGeneratedPdf: true, pdfOpened: false, summarySeen: false })).toBe(false);
    expect(canCompleteLesson({ hasGeneratedPdf: false, pdfOpened: false, summarySeen: true })).toBe(true);
  });
  it('renders the supported lesson markdown without active links or raw HTML', () => {
    const markup = renderToStaticMarkup(createElement(LessonMarkdown, {
      markdown: [
        '### Các bước',
        '',
        '- Mở **Không gian**',
        '- Chọn `Duyệt`',
        '',
        'Xem [tài liệu](https://evil.example) để biết thêm.',
        '<script>alert(1)</script>',
      ].join('\n'),
    }));

    expect(markup).toContain('<h3>Các bước</h3>');
    expect(markup).toContain('<ul>');
    expect(markup).toContain('<strong>Không gian</strong>');
    expect(markup).toContain('<code>Duyệt</code>');
    expect(markup).toContain('tài liệu');
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });

  it('presents every module state with a concise Vietnamese label', () => {
    expect([
      'locked', 'available', 'learning', 'quiz_ready', 'quiz_failed', 'needs_support', 'passed',
    ].map((status) => moduleStatusLabel(status as ModuleStateDto['status']))).toEqual([
      'Đang khóa', 'Sẵn sàng', 'Đang học', 'Sẵn sàng làm bài',
      'Chưa đạt', 'Cần hỗ trợ', 'Đã hoàn thành',
    ]);
  });

  it('computes learner progress from lesson and pass state and explains remaining attempts', () => {
    expect(moduleProgressPercent([
      state('passed', 1),
      state('quiz_ready'),
      state('locked'),
    ])).toBe(50);
    expect(remainingAttemptsLabel(state('quiz_failed', 1, 2))).toBe('Còn 1 lượt');
    expect(remainingAttemptsLabel(state('available', 0, null))).toBe('Không giới hạn lượt');
    expect(remainingAttemptsLabel(state('needs_support', 2, 2))).toBe('Đã hết lượt');
  });
});
