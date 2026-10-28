import { describe, expect, it } from 'vitest';

import {
  buildAdminOverview,
  dashboardMemberLabel,
  deriveAdminKpis,
  loadAdminDashboard,
} from '../src/ui/onboarding/admin-dashboard';
import {
  dismissedEmployeeModalState,
  publishedAssignmentTemplates,
  successfulEmployeeState,
  successfulAssignmentState,
  validateAddEmployeeDraft,
  validateAssignmentDraft,
} from '../src/ui/onboarding/employees';
import {
  assignableTemplates,
  availableRoomMembers,
  buildEmployeeRows,
  filterEmployeeRows,
} from '../src/ui/onboarding/employee-model';
import type { OnboardingApi } from '../src/ui/onboarding/api';
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
  const employee = (memberId: string, employeeType: 'normal' | 'advanced', addedAt = '2026-10-20T00:00:00Z') => ({
    id: `employee-${memberId}`, roomId: 'room-a', memberId, employeeType,
    addedBy: 'admin-1', addedAt, createdAt: addedAt, updatedAt: addedAt,
  });

  it('groups multiple assignments into one employee row', () => {
    const rows = buildEmployeeRows(
      [employee('m1', 'normal')],
      [
        { id: 'a1', memberId: 'm1', employeeType: 'normal', templateId: 'basic', templateVersion: 1, status: 'passed', assignedAt: '2026-10-20T08:00:00Z', progressPercent: 20 },
        { id: 'a2', memberId: 'm1', employeeType: 'normal', templateId: 'policy', templateVersion: 1, status: 'awaiting_evaluation', assignedAt: '2026-10-21T08:00:00Z', progressPercent: 70 },
      ],
      [{ userId: 'm1', displayName: 'Lan Nguyễn' }],
      new Date('2026-10-22T08:00:00Z'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      templateCount: 2, averageProgress: 45, attentionStatus: 'needs_evaluation',
      updatedAt: '2026-10-21T08:00:00Z', member: { displayName: 'Lan Nguyễn' },
    });
    expect(rows[0].assignments.map((item) => item.id)).toEqual(['a2', 'a1']);
  });

  it('keeps an employee with zero assignments at zero percent and not started', () => {
    const rows = buildEmployeeRows(
      [employee('member-without-course', 'advanced', '2026-10-19T08:00:00Z')],
      [],
      [],
      new Date('2026-10-22T08:00:00Z'),
    );

    expect(rows[0]).toMatchObject({
      templateCount: 0, averageProgress: 0, attentionStatus: 'not_started',
      updatedAt: '2026-10-19T08:00:00Z', member: undefined,
    });
    expect(filterEmployeeRows(rows, 'member-without-course', 'all')).toHaveLength(1);
  });

  it('searches employee identity and combines it with classification filtering', () => {
    const rows = buildEmployeeRows(
      [employee('m1', 'normal'), employee('m2', 'advanced')],
      [],
      [
        { userId: 'm1', displayName: 'Lan Trần', username: 'lan.tran' },
        { userId: 'm2', displayName: 'Lan Nguyễn', username: 'lan.nguyen' },
      ],
      new Date('2026-10-22T08:00:00Z'),
    );

    expect(filterEmployeeRows(rows, 'lan', 'advanced').map((row) => row.employee.memberId)).toEqual(['m2']);
    expect(filterEmployeeRows(rows, 'lan.tran', 'normal').map((row) => row.employee.memberId)).toEqual(['m1']);
  });

  it('excludes existing employees from the add-member choices', () => {
    expect(availableRoomMembers(
      [{ userId: 'm1' }, { userId: 'm2' }, { userId: 'm3' }],
      [employee('m1', 'normal'), employee('m3', 'advanced')],
    ).map((member) => member.userId)).toEqual(['m2']);
  });

  it('offers only published matching templates not already assigned at the exact version', () => {
    const profile = employee('m1', 'normal');
    const assignments = [
      { id: 'a1', memberId: 'm1', employeeType: 'normal' as const, templateId: 'basic', templateVersion: 1, status: 'assigned' as const, assignedAt: '2026-10-20T08:00:00Z' },
    ];
    const templates = [
      { id: 'basic', version: 1, title: 'Cơ bản', employeeType: 'normal' as const, status: 'published' as const },
      { id: 'other', version: 1, title: 'Khác', employeeType: 'normal' as const, status: 'published' as const },
      { id: 'draft', version: 1, title: 'Nháp', employeeType: 'normal' as const, status: 'draft' as const },
      { id: 'advanced', version: 1, title: 'Chuyên sâu', employeeType: 'advanced' as const, status: 'published' as const },
    ];

    expect(assignableTemplates(templates, profile, assignments).map((template) => template.id)).toEqual(['other']);
  });

  it('keeps a newer version of an already assigned template available', () => {
    const profile = employee('m1', 'normal');
    const assignments = [
      { id: 'a1', memberId: 'm1', employeeType: 'normal' as const, templateId: 'basic', templateVersion: 1, status: 'assigned' as const, assignedAt: '2026-10-20T08:00:00Z' },
    ];
    const templates = [
      { id: 'basic', version: 1, title: 'Cơ bản', employeeType: 'normal' as const, status: 'published' as const },
      { id: 'basic', version: 2, title: 'Cơ bản mới', employeeType: 'normal' as const, status: 'published' as const },
    ];

    expect(assignableTemplates(templates, profile, assignments).map(({ id, version }) => `${id}@${version}`))
      .toEqual(['basic@2']);
  });

  it('lists every published template regardless of employee classification', () => {
    expect(publishedAssignmentTemplates([
      { id: 'normal-template', version: 1, title: 'Normal', employeeType: 'normal', status: 'published' },
      { id: 'advanced-template', version: 2, title: 'Advanced', employeeType: 'advanced', status: 'published' },
      { id: 'draft-template', version: 1, title: 'Draft', employeeType: 'normal', status: 'draft' },
    ]).map((template) => template.id)).toEqual(['normal-template', 'advanced-template']);
  });

  it('derives dashboard KPI and work queues from mixed assignment statuses', () => {
    const assignments = [
      { status: 'assigned' }, { status: 'in_progress' }, { status: 'awaiting_essay_feedback' },
      { status: 'awaiting_evaluation' }, { status: 'passed' }, { status: 'failed' }, { status: 'retry' },
    ] as const;
    expect(deriveAdminKpis(assignments)).toEqual({
      total: 7, active: 3, pendingEssay: 1, pendingEvaluation: 1, completed: 2,
    });
  });

  it('derives actionable overview KPI without counting finished assignments as overdue', () => {
    const overview = buildAdminOverview([
      { id: 'a1', memberId: 'm1', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-21T12:00:00Z' },
      { id: 'a2', memberId: 'm2', status: 'in_progress', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-25T12:00:00Z' },
      { id: 'a3', memberId: 'm3', status: 'awaiting_evaluation', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'a4', memberId: 'm4', status: 'passed', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-10T12:00:00Z' },
      { id: 'a5', memberId: 'm5', status: 'failed', assignedAt: '2026-10-01T00:00:00Z' },
    ], [], new Date('2026-10-22T12:00:00Z'));

    expect(overview.kpis).toEqual({ total: 5, completionRate: 40, active: 2, overdue: 1, needsAction: 2 });
  });

  it('places every assignment in exactly one overview flow stage', () => {
    const overview = buildAdminOverview([
      { id: 'a1', memberId: 'm1', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'a2', memberId: 'm2', status: 'in_progress', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'a3', memberId: 'm3', status: 'retry', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'a4', memberId: 'm4', status: 'submitted', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'a5', memberId: 'm5', status: 'awaiting_essay_feedback', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'a6', memberId: 'm6', status: 'awaiting_evaluation', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'a7', memberId: 'm7', status: 'passed', assignedAt: '2026-10-01T00:00:00Z' },
      { id: 'a8', memberId: 'm8', status: 'failed', assignedAt: '2026-10-01T00:00:00Z' },
    ], [], new Date('2026-10-22T12:00:00Z'));

    expect(overview.stages.map(({ key, count }) => [key, count])).toEqual([
      ['assigned', 1], ['learning', 2], ['essay', 2], ['evaluation', 1], ['completed', 2],
    ]);
    expect(overview.stages.reduce((sum, stage) => sum + stage.count, 0)).toBe(8);
  });

  it('prioritizes overdue and review work with the correct destination', () => {
    const overview = buildAdminOverview([
      { id: 'learn', memberId: 'm1', status: 'in_progress', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-20T12:00:00Z', templateTitle: 'Cơ bản' },
      { id: 'eval', memberId: 'm2', status: 'awaiting_evaluation', assignedAt: '2026-10-01T00:00:00Z', templateTitle: 'Nâng cao' },
      { id: 'essay', memberId: 'm3', status: 'awaiting_essay_feedback', assignedAt: '2026-10-01T00:00:00Z', templateTitle: 'Cơ bản' },
      { id: 'failed', memberId: 'm4', status: 'failed', assignedAt: '2026-10-01T00:00:00Z', templateTitle: 'Nâng cao' },
      { id: 'ordinary', memberId: 'm5', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-11-20T12:00:00Z' },
    ], [
      { userId: 'm1', displayName: 'An' }, { userId: 'm2', username: 'binh' },
    ], new Date('2026-10-22T12:00:00Z'));

    expect(overview.attention.map(({ id, memberName, route }) => [id, memberName, route])).toEqual([
      ['learn', 'An', 'employees'],
      ['eval', 'binh', 'evaluations'],
      ['essay', 'm3', 'essay-feedback'],
      ['failed', 'm4', 'employees'],
    ]);
  });

  it('summarizes deadline health and average progress by template', () => {
    const overview = buildAdminOverview([
      { id: 'a1', memberId: 'm1', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-21T12:00:00Z', templateId: 'basic', templateTitle: 'Cơ bản', progressPercent: 20 },
      { id: 'a2', memberId: 'm2', status: 'in_progress', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-24T12:00:00Z', templateId: 'basic', templateTitle: 'Cơ bản', progressPercent: 60 },
      { id: 'a3', memberId: 'm3', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-28T12:00:00Z', templateId: 'advanced', templateTitle: 'Nâng cao', progressPercent: 50 },
      { id: 'a4', memberId: 'm4', status: 'passed', assignedAt: '2026-10-01T00:00:00Z', templateId: 'advanced', templateTitle: 'Nâng cao' },
      { id: 'a5', memberId: 'm5', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z' },
    ], [], new Date('2026-10-22T12:00:00Z'));

    expect(overview.deadlines).toEqual({ overdue: 1, next3Days: 1, days4To7: 1, later: 0, noDue: 1 });
    expect(overview.templates.map(({ title, assignmentCount, averageProgress }) => [title, assignmentCount, averageProgress])).toEqual([
      ['Cơ bản', 2, 40], ['Nâng cao', 2, 75], ['Chương trình chưa đặt tên', 1, 0],
    ]);
  });

  it('keeps progress for different template identities separate even when titles match', () => {
    const overview = buildAdminOverview([
      { id: 'a1', memberId: 'm1', status: 'in_progress', assignedAt: '2026-10-01T00:00:00Z', templateId: 'template-a', templateVersion: 1, templateTitle: 'Hội nhập', progressPercent: 20 },
      { id: 'a2', memberId: 'm2', status: 'in_progress', assignedAt: '2026-10-01T00:00:00Z', templateId: 'template-a', templateVersion: 1, templateTitle: 'Hội nhập', progressPercent: 60 },
      { id: 'a3', memberId: 'm3', status: 'in_progress', assignedAt: '2026-10-01T00:00:00Z', templateId: 'template-b', templateVersion: 1, templateTitle: 'Hội nhập', progressPercent: 90 },
    ], [], new Date('2026-10-22T12:00:00Z'));

    expect(overview.templates.map(({ key, assignmentCount, averageProgress }) => [key, assignmentCount, averageProgress])).toEqual([
      ['template-a@1', 2, 40], ['template-b@1', 1, 90],
    ]);
  });

  it('keeps exact 3-day and 7-day deadline boundaries in their inclusive buckets', () => {
    const overview = buildAdminOverview([
      { id: 'now', memberId: 'm1', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-22T12:00:00.000Z' },
      { id: 'three', memberId: 'm2', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-25T12:00:00.000Z' },
      { id: 'after-three', memberId: 'm3', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-25T12:00:00.001Z' },
      { id: 'seven', memberId: 'm4', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-29T12:00:00.000Z' },
      { id: 'after-seven', memberId: 'm5', status: 'assigned', assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-29T12:00:00.001Z' },
    ], [], new Date('2026-10-22T12:00:00.000Z'));

    expect(overview.deadlines).toEqual({ overdue: 0, next3Days: 2, days4To7: 2, later: 1, noDue: 0 });
  });

  it('labels dashboard assignments from the room member directory', () => {
    const members = [
      { userId: 'member-1', username: 'lan', displayName: 'Lan Nguyễn' },
      { userId: 'member-2', username: 'minh' },
    ];

    expect(dashboardMemberLabel(members, 'member-1')).toBe('Lan Nguyễn');
    expect(dashboardMemberLabel(members, 'member-2')).toBe('minh');
    expect(dashboardMemberLabel(members, 'missing')).toBe('missing');
  });

  it('keeps dashboard assignments available when member enrichment fails', async () => {
    const api = {
      async adminAssignments(action: string) {
        if (action === 'list') return { assignments: [{
          id: 'assignment-1', memberId: 'member-1', status: 'assigned', assignedAt: '2026-10-20T00:00:00.000Z',
        }] };
        throw new Error('directory unavailable');
      },
    } as unknown as OnboardingApi;

    const result = await loadAdminDashboard(api);

    expect(result.assignments).toHaveLength(1);
    expect(result.members).toEqual([]);
    expect(result.operational).toEqual({ needsSupportModules: 0, openFlags: 0 });
    expect(dashboardMemberLabel(result.members, result.assignments[0].memberId)).toBe('member-1');
  });

  it('closes and resets the add-employee modal after a successful submit', () => {
    expect(successfulEmployeeState()).toMatchObject({
      addOpen: false,
      draft: { memberId: '', employeeType: 'normal' },
      notice: 'Đã thêm nhân sự thành công.',
    });
  });

  it('returns to the same employee detail after a successful assignment', () => {
    expect(successfulAssignmentState('employee-1')).toMatchObject({
      modalMode: 'detail',
      selectedEmployeeId: 'employee-1',
      notice: 'Đã giao onboarding thành công.',
    });
  });

  it('fully dismisses employee detail and assignment modals', () => {
    expect(dismissedEmployeeModalState()).toEqual({
      modalMode: null,
      selectedEmployeeId: null,
    });
  });

  it('requires a member and valid classification when adding an employee', () => {
    expect(validateAddEmployeeDraft({ memberId: '', employeeType: 'unsupported' as 'normal' })
      .map((issue) => issue.field)).toEqual(['memberId', 'employeeType']);
    expect(validateAddEmployeeDraft({ memberId: 'm1', employeeType: 'advanced' })).toEqual([]);
  });

  it('requires member, template version, and a valid future due date', () => {
    expect(validateAssignmentDraft({
      memberId: '', templateId: '', templateVersion: 0, dueAt: 'bad',
    }, new Date('2026-10-20T00:00:00Z')).map((issue) => issue.field)).toEqual([
      'memberId', 'templateId', 'templateVersion', 'dueAt',
    ]);
    expect(validateAssignmentDraft({
      memberId: 'm1', templateId: 't1', templateVersion: 2,
      dueAt: '2026-10-25T00:00:00.000Z',
    }, new Date('2026-10-20T00:00:00Z'))).toEqual([]);
  });

  it('never offers edit or delete for system templates', () => {
    expect(templateActions({ source: 'system', status: 'published' })).toEqual(['use']);
  });

  it('offers deletion for every custom template lifecycle while archived templates remain inactive', () => {
    expect(templateActions({ source: 'custom', status: 'published' })).toEqual(['use', 'archive', 'delete']);
    expect(templateActions({ source: 'custom', status: 'draft' })).toEqual(['delete']);
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
