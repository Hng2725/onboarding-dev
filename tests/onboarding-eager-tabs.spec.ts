import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrivosAppProvider } from '@privos_ai/app-react';
import { describe, expect, it } from 'vitest';

import { AdminWorkspace, LearnerWorkspace } from '../src/ui/App';
import {
  AdminDashboardHeader,
  AdminOverviewContent,
  overviewDateRangeLabel,
} from '../src/ui/onboarding/admin-dashboard';
import {
  AddEmployeeDialog,
  AssignmentDialog,
  EmployeeDetailDialog,
  EmployeeTable,
  EmployeesPageHeader,
  type AssignmentDraft,
} from '../src/ui/onboarding/employees';
import { InlineNotice, scheduleNoticeDismiss } from '../src/ui/onboarding/components';
import { templateOperationError } from '../src/ui/onboarding/templates';
import type { EmployeeListRow } from '../src/ui/onboarding/employee-model';
import type { EmployeeRecord } from '../src/onboarding/contracts';
import type { AdminBootstrapSummary, OnboardingApi } from '../src/ui/onboarding/api';

const api = {} as OnboardingApi;
const adminSummary: AdminBootstrapSummary = {
  assignmentCount: 0,
  templateCount: 0,
  pendingEssayCount: 0,
  pendingEvaluationCount: 0,
};

function routeTag(markup: string, route: string): string {
  return markup.match(new RegExp(`<section[^>]*data-onboarding-route="${route}"[^>]*>`))?.[0] ?? '';
}

function renderWithPrivos(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(PrivosAppProvider, null, element));
}

describe('eager onboarding route mounting', () => {
  it('mounts every Admin tab immediately and only reveals the active route', () => {
    const markup = renderWithPrivos(createElement(AdminWorkspace, {
      api,
      summary: adminSummary,
      route: 'employees',
      onNavigate: () => undefined,
    }));

    for (const route of ['admin-overview', 'employees', 'templates', 'essay-feedback', 'evaluations']) {
      expect(routeTag(markup, route), route).not.toBe('');
    }
    expect(routeTag(markup, 'employees')).not.toContain('hidden=');
    expect(routeTag(markup, 'templates')).toContain('hidden=""');
  });

  it('mounts every learner tab immediately and only reveals the active route', () => {
    const markup = renderWithPrivos(createElement(LearnerWorkspace, {
      api,
      route: 'my-overview',
      onNavigate: () => undefined,
    }));

    for (const route of ['my-overview', 'my-learning', 'results']) {
      expect(routeTag(markup, route), route).not.toBe('');
    }
    expect(routeTag(markup, 'my-overview')).not.toContain('hidden=');
    expect(routeTag(markup, 'results')).toContain('hidden=""');
  });
});

describe('assignment dialog layout contract', () => {
  const employee: EmployeeRecord = {
    id: 'employee-1', roomId: 'room-a', memberId: 'member-1', employeeType: 'normal',
    addedBy: 'admin-1', addedAt: '2026-10-20T00:00:00Z',
    createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
  };

  it('renders a centered dialog shell with an independently scrollable body', () => {
    const draft: AssignmentDraft = {
      memberId: 'member-1',
      templateId: '',
      templateVersion: 0,
    };
    const markup = renderToStaticMarkup(createElement(AssignmentDialog, {
      employee,
      member: { userId: 'member-1', displayName: 'Lan Nguyễn' },
      availableTemplates: [],
      draft,
      issues: [],
      saving: false,
      onPatch: () => undefined,
      onBack: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(markup).toContain('class="assignment-dialog"');
    expect(markup).toContain('class="assignment-dialog-body"');
    expect(markup).toContain('role="dialog"');
    expect(markup).not.toContain('class="side-panel"');
  });

  it('replaces the submit label with a disabled loading icon while saving', () => {
    const draft: AssignmentDraft = {
      memberId: 'member-1',
      templateId: 'privos-foundations',
      templateVersion: 1,
    };
    const markup = renderToStaticMarkup(createElement(AssignmentDialog, {
      employee,
      member: { userId: 'member-1', username: 'lan' },
      availableTemplates: [{
        id: 'privos-foundations', version: 1, title: 'Foundations',
        employeeType: 'normal', status: 'published',
      }],
      draft,
      issues: [],
      saving: true,
      onPatch: () => undefined,
      onBack: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(markup).toContain('anticon-loading');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('>Giao onboarding<');
  });

  it('locks employee identity and classification while offering only provided templates', () => {
    const markup = renderToStaticMarkup(createElement(AssignmentDialog, {
      employee,
      member: { userId: 'member-1', username: 'lan', displayName: 'Lan Nguyễn' },
      availableTemplates: [{
        id: 'allowed', version: 2, title: 'Template phù hợp', employeeType: 'normal', status: 'published',
      }],
      draft: { memberId: 'member-1', templateId: '', templateVersion: 0 },
      issues: [], saving: false,
      onPatch: () => undefined, onBack: () => undefined, onClose: () => undefined, onSubmit: () => undefined,
    }));

    expect(markup).toContain('Lan Nguyễn');
    expect(markup).toContain('Thông thường');
    expect(markup).toContain('Template phù hợp');
    expect(markup).not.toContain('Chọn thành viên trong room');
    expect(markup).not.toContain('Chuyên sâu</button>');
  });
});

describe('employee detail dialog', () => {
  const employee: EmployeeRecord = {
    id: 'employee-1', roomId: 'room-a', memberId: 'member-1', employeeType: 'advanced',
    addedBy: 'admin-1', addedAt: '2026-10-20T00:00:00Z',
    createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
  };
  const assignment = (id: string, templateTitle: string, progressPercent: number) => ({
    id, memberId: 'member-1', employeeType: 'advanced' as const,
    templateId: id, templateVersion: 1, templateTitle,
    status: 'in_progress' as const, assignedAt: '2026-10-20T00:00:00Z',
    dueAt: '2026-10-29T00:00:00Z', progressPercent,
  });

  it('shows every onboarding assignment for the selected employee', () => {
    const row: EmployeeListRow = {
      employee,
      member: { userId: 'member-1', username: 'lan', displayName: 'Lan Nguyễn' },
      assignments: [assignment('advanced', 'Vận hành PrivOS', 65), assignment('security', 'Bảo mật', 20)],
      templateCount: 2, averageProgress: 43, attentionStatus: 'active', updatedAt: '2026-10-20T00:00:00Z',
    };
    const markup = renderToStaticMarkup(createElement(EmployeeDetailDialog, {
      row,
      onClose: () => undefined,
      onAssign: () => undefined,
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('Chi tiết nhân sự');
    expect(markup).toContain('Lan Nguyễn');
    expect(markup).toContain('@lan');
    expect(markup).toContain('Chuyên sâu');
    expect(markup).toContain('Vận hành PrivOS');
    expect(markup).toContain('Bảo mật');
    expect(markup).toContain('65%');
    expect(markup.match(/Gán onboarding/g)).toHaveLength(1);
    expect(markup).toContain('Ngày giao');
    expect(markup).toContain('Hạn hoàn thành');
  });

  it('keeps the assignment action available for an employee with no templates', () => {
    const row: EmployeeListRow = {
      employee, member: undefined, assignments: [], templateCount: 0, averageProgress: 0,
      attentionStatus: 'not_started', updatedAt: employee.addedAt,
    };
    const markup = renderToStaticMarkup(createElement(EmployeeDetailDialog, {
      row, onClose: () => undefined, onAssign: () => undefined,
    }));

    expect(markup).toContain('Chưa có template onboarding nào');
    expect(markup).toContain('Gán onboarding');
    expect(markup).toContain('member-1');
  });
});

describe('employee list and add flow', () => {
  it('keeps the page-level primary action focused on adding an employee', () => {
    const markup = renderToStaticMarkup(createElement(EmployeesPageHeader, { onAdd: () => undefined }));
    expect(markup).toContain('Thêm nhân sự');
    expect(markup).not.toContain('Gán onboarding');
  });

  it('renders only available room members and a disabled loading icon while adding', () => {
    const markup = renderToStaticMarkup(createElement(AddEmployeeDialog, {
      members: [{ userId: 'member-2', displayName: 'Minh Phạm' }],
      draft: { memberId: 'member-2', employeeType: 'normal' },
      issues: [], saving: true,
      onPatch: () => undefined, onClose: () => undefined, onSubmit: () => undefined,
    }));
    expect(markup).toContain('Minh Phạm');
    expect(markup).not.toContain('Lan Nguyễn');
    expect(markup).toContain('anticon-loading');
    expect(markup).toContain('disabled=""');
  });

  it('shows a retry action when the room member directory cannot be loaded', () => {
    const markup = renderToStaticMarkup(createElement(AddEmployeeDialog, {
      members: [],
      directoryError: 'Không thể tải danh sách thành viên.',
      draft: { memberId: '', employeeType: 'normal' },
      issues: [], saving: false,
      onPatch: () => undefined, onClose: () => undefined, onSubmit: () => undefined,
      onRetry: () => undefined,
    }));

    expect(markup).toContain('Không thể tải danh sách thành viên.');
    expect(markup).toContain('Thử lại');
    expect(markup).not.toContain('Tất cả thành viên trong room đã được thêm.');
  });

  it('renders one table row for an employee with multiple assignments', () => {
    const row: EmployeeListRow = {
      employee: {
        id: 'employee-1', roomId: 'room-a', memberId: 'member-1', employeeType: 'normal',
        addedBy: 'admin-1', addedAt: '2026-10-20T00:00:00Z',
        createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
      },
      member: { userId: 'member-1', displayName: 'Lan Nguyễn' },
      assignments: [], templateCount: 2, averageProgress: 55,
      attentionStatus: 'active', updatedAt: '2026-10-21T00:00:00Z',
    };
    const markup = renderToStaticMarkup(createElement(EmployeeTable, {
      rows: [row], onSelect: () => undefined,
    }));
    expect(markup.match(/data-employee-id="employee-1"/g)).toHaveLength(1);
    expect(markup).toContain('2 chương trình');
    expect(markup).toContain('55%');
  });
});

describe('shared operation notices', () => {
  it('renders successful operations in green and failed operations in red', () => {
    const successMarkup = renderToStaticMarkup(createElement(InlineNotice, {
      notice: { message: 'Đã giao onboarding thành công.', tone: 'success' },
      onDismiss: () => undefined,
    }));
    const errorMarkup = renderToStaticMarkup(createElement(InlineNotice, {
      notice: { message: 'Không thể giao onboarding.', tone: 'error' },
      onDismiss: () => undefined,
    }));

    expect(successMarkup).toContain('inline-notice-success');
    expect(successMarkup).toContain('role="status"');
    expect(errorMarkup).toContain('inline-notice-error');
    expect(errorMarkup).toContain('role="alert"');
  });

  it('dismisses each operation notice after exactly two seconds', () => {
    let scheduledDelay = 0;
    let scheduledCallback = () => undefined;
    let cleared = false;
    let dismissed = false;
    const cleanup = scheduleNoticeDismiss(
      () => { dismissed = true; },
      {
        set(callback, delayMs) {
          scheduledCallback = callback;
          scheduledDelay = delayMs;
          return 7 as unknown as ReturnType<typeof setTimeout>;
        },
        clear() { cleared = true; },
      },
    );

    expect(scheduledDelay).toBe(2_000);
    scheduledCallback();
    expect(dismissed).toBe(true);
    cleanup();
    expect(cleared).toBe(true);
  });

  it('normalizes failed Template actions into the shared red error notice', () => {
    expect(templateOperationError(new Error('Không thể lưu trữ template.'))).toEqual({
      message: 'Không thể lưu trữ template.',
      tone: 'error',
    });
    expect(templateOperationError('unknown')).toEqual({
      message: 'Không thể cập nhật template.',
      tone: 'error',
    });
  });
});

describe('Admin overview dashboard', () => {
  it('keeps only the assignment action in the overview header', () => {
    const markup = renderToStaticMarkup(createElement(AdminDashboardHeader, {
      onOpenEmployees: () => undefined,
    }));

    expect(markup).toContain('Tổng quan onboarding');
    expect(markup).not.toContain('Tình hình onboarding');
    expect(markup).toContain('Gán onboarding');
    expect(markup).not.toContain('Nhắc hạn 48 giờ');
  });

  it('shows the current seven-day date range across a month boundary', () => {
    expect(overviewDateRangeLabel(new Date(2026, 11, 29, 12))).toBe('Từ 29/12 đến 05/01');
  });

  it('renders management insights instead of duplicating the employee table', () => {
    const markup = renderToStaticMarkup(createElement(AdminOverviewContent, {
      rows: [
        {
          id: 'assignment-1', memberId: 'member-1', status: 'in_progress',
          assignedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-20T00:00:00Z',
          templateId: 'foundations', templateTitle: 'Hội nhập cơ bản', progressPercent: 35,
        },
        {
          id: 'assignment-2', memberId: 'member-2', status: 'awaiting_evaluation',
          assignedAt: '2026-10-02T00:00:00Z', templateId: 'advanced',
          templateTitle: 'Hội nhập nâng cao', progressPercent: 75,
        },
      ],
      members: [{ userId: 'member-1', displayName: 'Nguyễn An' }],
      now: new Date('2026-10-22T00:00:00Z'),
      onNavigate: () => undefined,
    }));

    expect(markup).toContain('Tỷ lệ hoàn thành');
    expect(markup).toContain('Luồng trạng thái');
    expect(markup).toContain('Cần xử lý ngay');
    expect(markup).toContain('Từ 22/10 đến 29/10');
    expect(markup).not.toContain('Sức khỏe thời hạn');
    expect(markup).toContain('Tiến độ theo template');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Đang học: 1/2"');
    expect(markup).toContain('<strong class="overview-stage-value"><span>1</span><small>/2</small></strong>');
    expect(markup).toContain('class="overview-stage-dot" aria-hidden="true"');
    expect(markup).toContain('1/2');
    expect(markup).not.toContain('% tổng lượt');
    expect(markup).not.toContain('overview-stage-index');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('Tiến độ nhân sự');
  });
});
