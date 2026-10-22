import {
  CalendarOutlined,
  CloseOutlined,
  FilterOutlined,
  LoadingOutlined,
  PlusOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState, type ReactNode, type ReactPortal } from 'react';
import { createPortal } from 'react-dom';

import type { EmployeeRecord, EmployeeType } from '../../onboarding/contracts';
import type { OnboardingApi } from './api';
import {
  ErrorState,
  InlineNotice,
  LoadingState,
  ProgressBar,
  StatusBadge,
  type InlineNoticeMessage,
} from './components';
import {
  assignableTemplates,
  availableRoomMembers,
  buildEmployeeRows,
  filterEmployeeRows,
  type AssignmentRow,
  type EmployeeAttentionStatus,
  type EmployeeListRow,
  type EmployeeTypeFilter,
  type MemberRow,
  type TemplateRow,
} from './employee-model';
import { usePolling, type PollReason } from './polling';

export type {
  AssignmentRow,
  EmployeeListRow,
  EmployeeTypeFilter,
  MemberRow,
  TemplateRow,
} from './employee-model';

export interface AddEmployeeDraft {
  readonly memberId: string;
  readonly employeeType: EmployeeType;
}

export interface AssignmentDraft {
  readonly memberId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly dueAt?: string;
}

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

const initialEmployeeDraft: AddEmployeeDraft = { memberId: '', employeeType: 'normal' };

function initialAssignmentDraft(memberId: string): AssignmentDraft {
  return { memberId, templateId: '', templateVersion: 0, dueAt: undefined };
}

export function validateAddEmployeeDraft(input: AddEmployeeDraft): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input.memberId.trim()) issues.push({ field: 'memberId', message: 'Chọn một thành viên trong room.' });
  if (input.employeeType !== 'normal' && input.employeeType !== 'advanced') {
    issues.push({ field: 'employeeType', message: 'Chọn loại nhân sự.' });
  }
  return issues;
}

export function validateAssignmentDraft(input: AssignmentDraft, now = new Date()): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input.memberId.trim()) issues.push({ field: 'memberId', message: 'Không xác định được nhân sự.' });
  if (!input.templateId.trim()) issues.push({ field: 'templateId', message: 'Chọn template phù hợp.' });
  if (!Number.isInteger(input.templateVersion) || input.templateVersion < 1) {
    issues.push({ field: 'templateVersion', message: 'Phiên bản template không hợp lệ.' });
  }
  if (input.dueAt) {
    const due = new Date(input.dueAt);
    if (!Number.isFinite(due.valueOf()) || due.valueOf() <= now.valueOf()) {
      issues.push({ field: 'dueAt', message: 'Hạn hoàn thành phải là thời điểm trong tương lai.' });
    }
  }
  return issues;
}

export function publishedAssignmentTemplates(templates: readonly TemplateRow[]): readonly TemplateRow[] {
  return templates.filter((template) => template.status === 'published');
}

export function successfulEmployeeState(): {
  readonly addOpen: false;
  readonly draft: AddEmployeeDraft;
  readonly notice: string;
} {
  return {
    addOpen: false,
    draft: initialEmployeeDraft,
    notice: 'Đã thêm nhân sự thành công.',
  };
}

export function successfulAssignmentState(employeeId: string, warning?: string): {
  readonly modalMode: 'detail';
  readonly selectedEmployeeId: string;
  readonly notice: string;
} {
  return {
    modalMode: 'detail',
    selectedEmployeeId: employeeId,
    notice: warning ? `Đã giao onboarding. Lưu ý: ${warning}` : 'Đã giao onboarding thành công.',
  };
}

function memberLabel(member: MemberRow | undefined, memberId: string): string {
  return member?.displayName || member?.username || memberId;
}

function memberIdentity(member: MemberRow | undefined, memberId: string): string {
  return member?.username ? `@${member.username}` : memberId;
}

function employeeTypeLabel(type: EmployeeType): string {
  return type === 'advanced' ? 'Chuyên sâu' : 'Thông thường';
}

function formatDate(value?: string, emptyLabel = 'Không giới hạn'): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium' }).format(date)
    : value;
}

function friendlyError(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  const message = caught.message;
  if (/EMPLOYEE_ALREADY_EXISTS|already exists|duplicate/i.test(message)) {
    return 'Nhân sự này đã có trong danh sách.';
  }
  if (/ASSIGNMENT_ALREADY_EXISTS/i.test(message)) {
    return 'Template và phiên bản này đã được gán cho nhân sự.';
  }
  return message || fallback;
}

const ATTENTION_LABELS: Readonly<Record<EmployeeAttentionStatus, string>> = {
  needs_essay_feedback: 'Chờ nhận xét',
  needs_evaluation: 'Chờ đánh giá',
  failed: 'Chưa đạt',
  overdue: 'Quá hạn',
  active: 'Đang thực hiện',
  completed: 'Đã hoàn tất',
  not_started: 'Chưa gán',
};

function EmployeeAttentionBadge({ status }: { status: EmployeeAttentionStatus }) {
  return <span className={`employee-attention employee-attention-${status}`}>{ATTENTION_LABELS[status]}</span>;
}

export function AssignmentModalLayer({ children, target }: { children: ReactNode; target?: Element }): ReactPortal {
  return createPortal(children, target ?? document.body);
}

export function EmployeesPageHeader({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="page-heading">
      <div>
        <span className="section-kicker">NHÂN SỰ TRONG ROOM</span>
        <h2>Quản lý nhân sự onboarding</h2>
        <p>Thêm nhân sự một lần, sau đó quản lý nhiều chương trình onboarding trong hồ sơ của họ.</p>
      </div>
      <button className="button button-primary" type="button" onClick={onAdd}>
        <PlusOutlined /> Thêm nhân sự
      </button>
    </section>
  );
}

export function AddEmployeeDialog({
  members,
  directoryError,
  draft,
  issues,
  saving,
  onPatch,
  onClose,
  onRetry,
  onSubmit,
}: {
  members: readonly MemberRow[];
  directoryError?: string | null;
  draft: AddEmployeeDraft;
  issues: readonly ValidationIssue[];
  saving: boolean;
  onPatch: (patch: Partial<AddEmployeeDraft>) => void;
  onClose: () => void;
  onRetry?: () => void;
  onSubmit: () => void;
}) {
  const fieldIssue = (field: string) => issues.find((issue) => issue.field === field)?.message;
  return (
    <section className="assignment-dialog add-employee-dialog" role="dialog" aria-modal="true" aria-labelledby="add-employee-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><span className="section-kicker">HỒ SƠ NHÂN SỰ</span><h2 id="add-employee-title">Thêm nhân sự</h2></div>
        <button className="icon-button" type="button" aria-label="Đóng" disabled={saving} onClick={onClose}><CloseOutlined /></button>
      </header>
      <div className="assignment-dialog-body">
        <div className="form-stack">
          <label className="form-field">
            <span>Thành viên</span>
            <select disabled={Boolean(directoryError)} value={draft.memberId} onChange={(event) => onPatch({ memberId: event.target.value })}>
              <option value="">Chọn thành viên trong room</option>
              {members.map((member) => <option key={member.userId} value={member.userId}>{memberLabel(member, member.userId)}</option>)}
            </select>
            {directoryError ? (
              <small className="directory-error" role="alert">
                <span>{directoryError}</span>
                {onRetry && <button type="button" disabled={saving} onClick={onRetry}>Thử lại</button>}
              </small>
            ) : members.length === 0 ? (
              <small className="field-hint">Tất cả thành viên trong room đã được thêm.</small>
            ) : null}
            {fieldIssue('memberId') && <small className="field-error">{fieldIssue('memberId')}</small>}
          </label>
          <fieldset className="form-field">
            <legend>Phân loại cố định</legend>
            <div className="segmented">
              <button type="button" className={draft.employeeType === 'normal' ? 'active' : ''} onClick={() => onPatch({ employeeType: 'normal' })}>Thông thường</button>
              <button type="button" className={draft.employeeType === 'advanced' ? 'active' : ''} onClick={() => onPatch({ employeeType: 'advanced' })}>Chuyên sâu</button>
            </div>
            <small className="field-hint">Các template gán sau này phải cùng phân loại với hồ sơ.</small>
            {fieldIssue('employeeType') && <small className="field-error">{fieldIssue('employeeType')}</small>}
          </fieldset>
        </div>
      </div>
      <footer>
        <button className="button button-secondary" type="button" disabled={saving} onClick={onClose}>Hủy</button>
        <button className="button button-primary" type="button" disabled={saving || Boolean(directoryError) || members.length === 0} onClick={onSubmit}>
          {saving ? <LoadingOutlined spin aria-label="Đang thêm nhân sự" /> : 'Thêm nhân sự'}
        </button>
      </footer>
    </section>
  );
}

export function AssignmentDialog({
  employee,
  member,
  availableTemplates,
  draft,
  issues,
  saving,
  onPatch,
  onBack,
  onClose,
  onSubmit,
}: {
  employee: EmployeeRecord;
  member?: MemberRow;
  availableTemplates: readonly TemplateRow[];
  draft: AssignmentDraft;
  issues: readonly ValidationIssue[];
  saving: boolean;
  onPatch: (patch: Partial<AssignmentDraft>) => void;
  onBack: () => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const fieldIssue = (field: string) => issues.find((issue) => issue.field === field)?.message;
  return (
    <section className="assignment-dialog" role="dialog" aria-modal="true" aria-labelledby="assignment-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><span className="section-kicker">GÁN CHƯƠNG TRÌNH</span><h2 id="assignment-title">Gán onboarding</h2></div>
        <button className="icon-button" type="button" aria-label="Đóng" disabled={saving} onClick={onClose}><CloseOutlined /></button>
      </header>
      <div className="assignment-dialog-body">
        <div className="form-stack">
          <section className="employee-profile-locked" aria-label="Nhân sự được gán">
            <span className="mini-avatar"><UserOutlined /></span>
            <div><strong>{memberLabel(member, employee.memberId)}</strong><small>{memberIdentity(member, employee.memberId)}</small></div>
            <span className="type-chip">{employeeTypeLabel(employee.employeeType)}</span>
          </section>
          <label className="form-field">
            <span>Template đã xuất bản</span>
            <select value={`${draft.templateId}@${draft.templateVersion}`} onChange={(event) => {
              const [templateId, version] = event.target.value.split('@');
              onPatch({ templateId, templateVersion: Number(version) });
            }}>
              <option value="@0">Chọn template</option>
              {availableTemplates.map((template) => (
                <option key={`${template.id}@${template.version}`} value={`${template.id}@${template.version}`}>
                  {template.title} · v{template.version}
                </option>
              ))}
            </select>
            {availableTemplates.length === 0 && <small className="field-hint">Không còn template phù hợp để gán. Có thể xuất bản phiên bản mới trong tab Template.</small>}
            {(fieldIssue('templateId') || fieldIssue('templateVersion')) && <small className="field-error">{fieldIssue('templateId') || fieldIssue('templateVersion')}</small>}
          </label>
          <label className="form-field">
            <span><CalendarOutlined /> Hạn hoàn thành (không bắt buộc)</span>
            <input type="datetime-local" value={draft.dueAt?.slice(0, 16) ?? ''} onChange={(event) => onPatch({ dueAt: event.target.value ? new Date(event.target.value).toISOString() : undefined })} />
            {fieldIssue('dueAt') && <small className="field-error">{fieldIssue('dueAt')}</small>}
          </label>
        </div>
      </div>
      <footer>
        <button className="button button-secondary" type="button" disabled={saving} onClick={onBack}>Quay lại</button>
        <button className="button button-primary" type="button" disabled={saving || availableTemplates.length === 0} onClick={onSubmit}>
          {saving ? <LoadingOutlined spin aria-label="Đang giao onboarding" /> : 'Giao onboarding'}
        </button>
      </footer>
    </section>
  );
}

export function EmployeeTable({
  rows,
  onSelect,
}: {
  rows: readonly EmployeeListRow[];
  onSelect: (employeeId: string) => void;
}) {
  if (rows.length === 0) return <p className="table-empty">Chưa có nhân sự phù hợp.</p>;
  return (
    <div className="data-table-wrap">
      <table className="data-table employee-table">
        <thead><tr><th>Nhân sự</th><th>Phân loại</th><th>Chương trình</th><th>Tiến độ chung</th><th>Trạng thái</th><th>Cập nhật</th></tr></thead>
        <tbody>{rows.map((row) => {
          const name = memberLabel(row.member, row.employee.memberId);
          return (
            <tr
              key={row.employee.id}
              data-employee-id={row.employee.id}
              className="employee-detail-trigger"
              tabIndex={0}
              aria-haspopup="dialog"
              aria-label={`Xem chi tiết ${name}`}
              onClick={() => onSelect(row.employee.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(row.employee.id);
                }
              }}
            >
              <td><div className="person-cell"><span className="mini-avatar"><UserOutlined /></span><div><strong>{name}</strong><small>{memberIdentity(row.member, row.employee.memberId)}</small></div></div></td>
              <td><span className="type-chip">{employeeTypeLabel(row.employee.employeeType)}</span></td>
              <td><strong className="employee-program-count">{row.templateCount} chương trình</strong></td>
              <td className="progress-cell"><ProgressBar value={row.averageProgress} label="Tiến độ chung" /></td>
              <td><EmployeeAttentionBadge status={row.attentionStatus} /></td>
              <td>{formatDate(row.updatedAt, 'Chưa cập nhật')}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

export function EmployeeDetailDialog({
  row,
  onClose,
  onAssign,
}: {
  row: EmployeeListRow;
  onClose: () => void;
  onAssign: () => void;
}) {
  const name = memberLabel(row.member, row.employee.memberId);
  return (
    <section className="assignment-dialog employee-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-detail-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><span className="section-kicker">HỒ SƠ ONBOARDING</span><h2 id="employee-detail-title">Chi tiết nhân sự</h2></div>
        <button className="icon-button" type="button" aria-label="Đóng" onClick={onClose}><CloseOutlined /></button>
      </header>
      <div className="assignment-dialog-body">
        <div className="employee-detail-content">
          <section className="employee-detail-profile" aria-label="Thông tin nhân sự">
            <span className="employee-detail-avatar"><UserOutlined /></span>
            <div><strong>{name}</strong><span>{memberIdentity(row.member, row.employee.memberId)}</span></div>
            <span className="type-chip">{employeeTypeLabel(row.employee.employeeType)}</span>
          </section>
          <section className="employee-detail-summary">
            <div><span>Chương trình</span><strong>{row.templateCount}</strong></div>
            <div><span>Tiến độ chung</span><strong>{row.averageProgress}%</strong></div>
            <div><span>Trạng thái</span><EmployeeAttentionBadge status={row.attentionStatus} /></div>
          </section>
          <div className="employee-detail-section-heading">
            <div><span className="section-kicker">CHƯƠNG TRÌNH ĐÃ GÁN</span><h3>Lịch sử onboarding</h3></div>
          </div>
          {row.assignments.length === 0 ? (
            <div className="employee-assignment-empty">
              <TeamOutlined />
              <strong>Chưa có template onboarding nào</strong>
              <span>Hãy gán chương trình đầu tiên cho nhân sự này.</span>
            </div>
          ) : (
            <div className="employee-assignment-list">
              {row.assignments.map((assignment) => (
                <article className="employee-assignment-card" key={assignment.id}>
                  <div className="employee-assignment-heading">
                    <div><strong>{assignment.templateTitle || assignment.templateId}</strong><span>Phiên bản v{assignment.templateVersion}</span></div>
                    <StatusBadge status={assignment.status} />
                  </div>
                  <ProgressBar value={assignment.progressPercent ?? 0} label="Tiến độ" />
                  <dl className="employee-assignment-meta">
                    <div><dt>Ngày giao</dt><dd>{formatDate(assignment.assignedAt)}</dd></div>
                    <div><dt>Hạn hoàn thành</dt><dd>{formatDate(assignment.dueAt)}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
      <footer>
        <button className="button button-secondary" type="button" onClick={onClose}>Đóng</button>
        <button className="button button-primary" type="button" onClick={onAssign}><PlusOutlined /> Gán onboarding</button>
      </footer>
    </section>
  );
}

type EmployeeModalMode = 'detail' | 'assign' | null;

export function dismissedEmployeeModalState(): {
  readonly modalMode: null;
  readonly selectedEmployeeId: null;
} {
  return { modalMode: null, selectedEmployeeId: null };
}

export function EmployeesPage({ api }: { api: OnboardingApi }) {
  const [members, setMembers] = useState<readonly MemberRow[]>([]);
  const [employees, setEmployees] = useState<readonly EmployeeRecord[]>([]);
  const [assignments, setAssignments] = useState<readonly AssignmentRow[]>([]);
  const [templates, setTemplates] = useState<readonly TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [query, setQuery] = useState('');
  const [employeeTypeFilter, setEmployeeTypeFilter] = useState<EmployeeTypeFilter>('all');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<EmployeeModalMode>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddEmployeeDraft>(initialEmployeeDraft);
  const [addIssues, setAddIssues] = useState<readonly ValidationIssue[]>([]);
  const [adding, setAdding] = useState(false);
  const [assignmentDraft, setAssignmentDraft] = useState<AssignmentDraft>(initialAssignmentDraft(''));
  const [assignmentIssues, setAssignmentIssues] = useState<readonly ValidationIssue[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [notice, setNotice] = useState<InlineNoticeMessage | null>(null);
  const [memberDirectoryError, setMemberDirectoryError] = useState<string | null>(null);

  const load = useCallback(async (reason: PollReason) => {
    const initial = reason === 'initial';
    if (initial) {
      setLoading(true);
      setError(null);
    }
    try {
      const memberPromise = api.adminAssignments<{ members: readonly MemberRow[] }>('list_members')
        .then((result) => {
          setMemberDirectoryError(null);
          return result;
        })
        .catch(() => {
          setMemberDirectoryError('Không thể tải danh sách thành viên.');
          return { members: [] as readonly MemberRow[] };
        });
      const [employeeResult, assignmentResult, templateResult, memberResult] = await Promise.all([
        api.adminAssignments<{ employees: readonly EmployeeRecord[] }>('list_employees'),
        api.adminAssignments<{ assignments: readonly AssignmentRow[] }>('list'),
        api.adminTemplates<{ templates: readonly TemplateRow[] }>('list'),
        memberPromise,
      ]);
      setEmployees(employeeResult.employees);
      setAssignments(assignmentResult.assignments);
      setTemplates(templateResult.templates);
      setMembers(memberResult.members);
      setError(null);
    } catch (caught) {
      if (initial) setError(caught instanceof Error ? caught : new Error('Không thể tải danh sách nhân sự.'));
    } finally {
      if (initial) setLoading(false);
    }
  }, [api]);

  const refresh = usePolling(load);
  const rows = useMemo(() => buildEmployeeRows(employees, assignments, members), [employees, assignments, members]);
  const visibleRows = useMemo(
    () => filterEmployeeRows(rows, query, employeeTypeFilter),
    [rows, query, employeeTypeFilter],
  );
  const addableMembers = useMemo(() => availableRoomMembers(members, employees), [members, employees]);
  const selectedRow = useMemo(
    () => rows.find((row) => row.employee.id === selectedEmployeeId),
    [rows, selectedEmployeeId],
  );
  const availableTemplates = useMemo(
    () => selectedRow ? assignableTemplates(templates, selectedRow.employee, assignments) : [],
    [templates, selectedRow, assignments],
  );

  const dismissEmployeeModal = useCallback(() => {
    const dismissed = dismissedEmployeeModalState();
    setModalMode(dismissed.modalMode);
    setSelectedEmployeeId(dismissed.selectedEmployeeId);
  }, []);

  useEffect(() => {
    if (!addOpen && !modalMode) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || adding || assigning) return;
      if (addOpen) setAddOpen(false);
      else dismissEmployeeModal();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [addOpen, modalMode, adding, assigning, dismissEmployeeModal]);

  useEffect(() => {
    if (selectedEmployeeId && !selectedRow) {
      setSelectedEmployeeId(null);
      setModalMode(null);
    }
  }, [selectedEmployeeId, selectedRow]);

  function openEmployee(employeeId: string) {
    setSelectedEmployeeId(employeeId);
    setModalMode('detail');
    setAssignmentIssues([]);
  }

  function openAssignment() {
    if (!selectedRow) return;
    setAssignmentDraft(initialAssignmentDraft(selectedRow.employee.memberId));
    setAssignmentIssues([]);
    setModalMode('assign');
  }

  async function submitEmployee() {
    const nextIssues = validateAddEmployeeDraft(addDraft);
    setAddIssues(nextIssues);
    if (nextIssues.length) return;
    setAdding(true);
    setNotice(null);
    try {
      await api.adminAssignments<{ employee: EmployeeRecord }>('add_employee', addDraft as unknown as Record<string, unknown>);
      const success = successfulEmployeeState();
      setAddOpen(success.addOpen);
      setAddDraft(success.draft);
      setNotice({ message: success.notice, tone: 'success' });
      await refresh();
    } catch (caught) {
      setNotice({ message: friendlyError(caught, 'Không thể thêm nhân sự.'), tone: 'error' });
    } finally {
      setAdding(false);
    }
  }

  async function submitAssignment() {
    if (!selectedRow) return;
    const nextIssues = validateAssignmentDraft(assignmentDraft);
    setAssignmentIssues(nextIssues);
    if (nextIssues.length) return;
    setAssigning(true);
    setNotice(null);
    try {
      const result = await api.adminAssignments<{ result: { warning?: string } }>(
        'assign',
        assignmentDraft as unknown as Record<string, unknown>,
      );
      const success = successfulAssignmentState(selectedRow.employee.id, result.result.warning);
      setNotice({ message: success.notice, tone: 'success' });
      setSelectedEmployeeId(success.selectedEmployeeId);
      setModalMode(success.modalMode);
      await refresh();
    } catch (caught) {
      setNotice({ message: friendlyError(caught, 'Không thể giao onboarding.'), tone: 'error' });
    } finally {
      setAssigning(false);
    }
  }

  if (loading) return <LoadingState label="Đang tải danh sách nhân sự…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refresh()} />;

  return (
    <div className="page-stack">
      <EmployeesPageHeader onAdd={() => {
        setAddDraft(initialEmployeeDraft);
        setAddIssues([]);
        setNotice(null);
        setAddOpen(true);
      }} />
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <section className="content-card table-card">
        <div className="table-toolbar">
          <div className="template-toolbar-controls employee-toolbar-controls">
            <label className="search-field">
              <SearchOutlined />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm theo tên hoặc tài khoản…" aria-label="Tìm nhân sự" />
            </label>
            <label className="template-filter-field">
              <FilterOutlined />
              <select value={employeeTypeFilter} onChange={(event) => setEmployeeTypeFilter(event.target.value as EmployeeTypeFilter)} aria-label="Lọc theo phân loại nhân sự">
                <option value="all">Tất cả phân loại</option>
                <option value="normal">Thông thường</option>
                <option value="advanced">Chuyên sâu</option>
              </select>
            </label>
          </div>
          <span className="muted-count"><TeamOutlined /> {visibleRows.length} nhân sự</span>
        </div>
        <EmployeeTable rows={visibleRows} onSelect={openEmployee} />
      </section>

      {selectedRow && modalMode && (
        <AssignmentModalLayer>
          <div className="dialog-backdrop" role="presentation" onMouseDown={() => {
            if (assigning) return;
            dismissEmployeeModal();
          }}>
            {modalMode === 'detail' ? (
              <EmployeeDetailDialog
                row={selectedRow}
                onClose={dismissEmployeeModal}
                onAssign={openAssignment}
              />
            ) : (
              <AssignmentDialog
                employee={selectedRow.employee}
                member={selectedRow.member}
                availableTemplates={availableTemplates}
                draft={assignmentDraft}
                issues={assignmentIssues}
                saving={assigning}
                onPatch={(patch) => {
                  setAssignmentDraft((current) => ({ ...current, ...patch }));
                  setAssignmentIssues([]);
                }}
                onBack={() => setModalMode('detail')}
                onClose={dismissEmployeeModal}
                onSubmit={() => void submitAssignment()}
              />
            )}
          </div>
        </AssignmentModalLayer>
      )}

      {addOpen && (
        <AssignmentModalLayer>
          <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!adding) setAddOpen(false); }}>
            <AddEmployeeDialog
              members={addableMembers}
              directoryError={memberDirectoryError}
              draft={addDraft}
              issues={addIssues}
              saving={adding}
              onPatch={(patch) => {
                setAddDraft((current) => ({ ...current, ...patch }));
                setAddIssues([]);
              }}
              onClose={() => setAddOpen(false)}
              onRetry={() => void refresh()}
              onSubmit={() => void submitEmployee()}
            />
          </div>
        </AssignmentModalLayer>
      )}
    </div>
  );
}
