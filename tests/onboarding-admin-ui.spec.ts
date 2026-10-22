import { describe, expect, it } from 'vitest';

import { deriveAdminKpis, reminderMessage } from '../src/ui/onboarding/admin-dashboard';
import { validateAssignmentDraft } from '../src/ui/onboarding/employees';
import {
  normalizeUploadedResource,
  templateActions,
  validateTemplateDraft,
} from '../src/ui/onboarding/templates';
import {
  applySavedEssayFeedback,
  groupEssayQueue,
  validateEvaluationDraft,
} from '../src/ui/onboarding/reviews';

describe('Admin onboarding UI models', () => {
  it('derives dashboard KPI and work queues from mixed assignment statuses', () => {
    const assignments = [
      { status: 'assigned' }, { status: 'in_progress' }, { status: 'awaiting_essay_feedback' },
      { status: 'awaiting_evaluation' }, { status: 'passed' }, { status: 'failed' }, { status: 'retry' },
    ] as const;
    expect(deriveAdminKpis(assignments)).toEqual({
      total: 7, active: 3, pendingEssay: 1, pendingEvaluation: 1, completed: 2,
    });
  });

  it('formats reminder totals without implying assignment state changed', () => {
    expect(reminderMessage({ sent: 3, skipped: 2, failed: 1 })).toBe('Đã gửi 3 · Bỏ qua 2 · Thất bại 1');
  });

  it('requires member, classification, template version, and a valid future due date', () => {
    expect(validateAssignmentDraft({
      memberId: '', employeeType: 'normal', templateId: '', templateVersion: 0, dueAt: 'bad',
    }, new Date('2026-10-20T00:00:00Z')).map((issue) => issue.field)).toEqual([
      'memberId', 'templateId', 'templateVersion', 'dueAt',
    ]);
    expect(validateAssignmentDraft({
      memberId: 'm1', employeeType: 'advanced', templateId: 't1', templateVersion: 2,
      dueAt: '2026-10-25T00:00:00.000Z',
    }, new Date('2026-10-20T00:00:00Z'))).toEqual([]);
  });

  it('never offers edit or delete for system templates', () => {
    expect(templateActions({ source: 'system', status: 'published' })).toEqual(['use', 'clone']);
  });

  it('offers deletion for every custom template lifecycle while archived templates remain inactive', () => {
    expect(templateActions({ source: 'custom', status: 'published' })).toEqual(['use', 'edit', 'archive', 'delete']);
    expect(templateActions({ source: 'custom', status: 'draft' })).toEqual(['edit', 'delete']);
    expect(templateActions({ source: 'custom', status: 'archived' })).toEqual(['delete']);
  });

  it('keeps missing resources blocking but makes missing questions module-named suggestions', () => {
    const issues = validateTemplateDraft({
      title: 'Hội nhập', description: '', employeeType: 'normal', maxAttempts: 1, modules: [
        { key: 'culture', title: 'Văn hóa công ty', description: '', resources: [], questions: [] },
        {
          key: 'security', title: 'Bảo mật', description: '',
          resources: [{ title: 'Quy định', kind: 'link', required: true, sourceUrl: 'https://example.com' }],
          questions: [],
        },
      ],
    });
    expect(issues).toEqual([
      {
        field: 'modules.0.resources', level: 'error',
        message: 'Module “Văn hóa công ty”: Thêm ít nhất một tài liệu.',
      },
      {
        field: 'modules.0.questions', level: 'suggestion',
        message: 'Module “Văn hóa công ty”: Nên thêm ít nhất một câu hỏi.',
      },
      {
        field: 'modules.1.questions', level: 'suggestion',
        message: 'Module “Bảo mật”: Nên thêm ít nhất một câu hỏi.',
      },
    ]);
  });

  it('normalizes stable file metadata returned by PrivOS upload', () => {
    expect(normalizeUploadedResource({
      file: { _id: 'file-1', name: 'handbook.pdf', type: 'application/pdf', size: 2048 },
    })).toEqual({ fileId: 'file-1', title: 'handbook.pdf', mimeType: 'application/pdf', size: 2048 });
  });

  it('groups essay answers by assignment and never models a numeric essay score', () => {
    const grouped = groupEssayQueue([
      { assignmentId: 'a1', attemptId: 't1', answerId: 'x1', questionId: 'q1', prompt: 'Bạn hiểu gì?', answer: 'Nội dung', reviewed: false },
      { assignmentId: 'a1', attemptId: 't1', answerId: 'x2', questionId: 'q2', prompt: 'Áp dụng ra sao?', answer: 'Ứng dụng', reviewed: true, comment: 'Tốt' },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ assignmentId: 'a1', reviewedCount: 1, totalCount: 2 });
    expect(JSON.stringify(grouped)).not.toContain('score');
  });

  it('updates reviewed count after saving one essay comment', () => {
    const items = [{ assignmentId: 'a1', attemptId: 't1', answerId: 'x1', questionId: 'q1', prompt: 'P', answer: 'A', reviewed: false }];
    expect(applySavedEssayFeedback(items, 'x1', 'Nhận xét').filter((item) => item.reviewed)).toHaveLength(1);
  });

  it('requires all overall evaluation fields and one exact conclusion', () => {
    expect(validateEvaluationDraft({ completionLevel: '', strengths: '', improvements: '', publicComment: '', conclusion: '' }).map((issue) => issue.field)).toEqual([
      'completionLevel', 'strengths', 'improvements', 'publicComment', 'conclusion',
    ]);
    expect(validateEvaluationDraft({ completionLevel: 'Tốt', strengths: 'Chủ động', improvements: 'Thực hành', publicComment: 'Hoàn thành', conclusion: 'retry' })).toEqual([]);
  });
});
