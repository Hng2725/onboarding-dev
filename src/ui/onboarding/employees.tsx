import {
  CalendarOutlined,
  CloseOutlined,
  PlusOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useCallback, useMemo, useState, type ReactNode, type ReactPortal } from 'react';
import { createPortal } from 'react-dom';

import type { AssignmentStatus, EmployeeType, TemplateStatus } from '../../onboarding/contracts';
import type { OnboardingApi } from './api';
import { ErrorState, LoadingState, ProgressBar, StatusBadge } from './components';
import { usePolling, type PollReason } from './polling';

export interface AssignmentDraft {
  readonly memberId: string;
  readonly employeeType: EmployeeType;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly dueAt?: string;
}

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

export function validateAssignmentDraft(input: AssignmentDraft, now = new Date()): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input.memberId.trim()) issues.push({ field: 'memberId', message: 'Chọn một thành viên trong room.' });
  if (input.employeeType !== 'normal' && input.employeeType !== 'advanced') issues.push({ field: 'employeeType', message: 'Chọn loại nhân sự.' });
  if (!input.templateId.trim()) issues.push({ field: 'templateId', message: 'Chọn template phù hợp.' });
  if (!Number.isInteger(input.templateVersion) || input.templateVersion < 1) issues.push({ field: 'templateVersion', message: 'Phiên bản template không hợp lệ.' });
  if (input.dueAt) {
    const due = new Date(input.dueAt);
    if (!Number.isFinite(due.valueOf()) || due.valueOf() <= now.valueOf()) {
      issues.push({ field: 'dueAt', message: 'Hạn hoàn thành phải là thời điểm trong tương lai.' });
    }
  }
  return issues;
}

interface MemberRow { readonly userId: string; readonly username?: string; readonly displayName?: string }
interface AssignmentRow {
  readonly id: string;
  readonly memberId: string;
  readonly employeeType: EmployeeType;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateTitle?: string;
  readonly status: AssignmentStatus;
  readonly dueAt?: string;
  readonly assignedAt: string;
  readonly progressPercent?: number;
}
interface TemplateRow {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly employeeType: EmployeeType;
  readonly status: TemplateStatus;
}

const initialDraft: AssignmentDraft = {
  memberId: '', employeeType: 'normal', templateId: '', templateVersion: 0, dueAt: undefined,
};

function memberLabel(member: MemberRow | undefined, memberId: string): string {
  return member?.displayName || member?.username || memberId;
}

function formatDate(value?: string): string {
  if (!value) return 'Không giới hạn';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium' }).format(date) : value;
}

export function AssignmentModalLayer({ children, target }: { children: ReactNode; target?: Element }): ReactPortal {
  return createPortal(children, target ?? document.body);
}

export function AssignmentDialog({
  members,
  availableTemplates,
  draft,
  issues,
  saving,
  onPatch,
  onClose,
  onSubmit,
}: {
  members: readonly MemberRow[];
  availableTemplates: readonly TemplateRow[];
  draft: AssignmentDraft;
  issues: readonly ValidationIssue[];
  saving: boolean;
  onPatch: (patch: Partial<AssignmentDraft>) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const fieldIssue = (field: string) => issues.find((issue) => issue.field === field)?.message;
  return <section className="assignment-dialog" role="dialog" aria-modal="true" aria-labelledby="assignment-title" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><span className="section-kicker">GÁN THỦ CÔNG</span><h2 id="assignment-title">Onboarding mới</h2></div><button className="icon-button" type="button" aria-label="Đóng" onClick={onClose}><CloseOutlined /></button></header>
    <div className="assignment-dialog-body"><div className="form-stack">
      <label className="form-field"><span>Thành viên</span><select value={draft.memberId} onChange={(event) => onPatch({ memberId: event.target.value })}><option value="">Chọn thành viên trong room</option>{members.map((member) => <option key={member.userId} value={member.userId}>{memberLabel(member, member.userId)}</option>)}</select>{fieldIssue('memberId') && <small className="field-error">{fieldIssue('memberId')}</small>}</label>
      <fieldset className="form-field"><legend>Loại nhân sự</legend><div className="segmented"><button type="button" className={draft.employeeType === 'normal' ? 'active' : ''} onClick={() => onPatch({ employeeType: 'normal', templateId: '', templateVersion: 0 })}>Thông thường</button><button type="button" className={draft.employeeType === 'advanced' ? 'active' : ''} onClick={() => onPatch({ employeeType: 'advanced', templateId: '', templateVersion: 0 })}>Chuyên sâu</button></div></fieldset>
      <label className="form-field"><span>Template đã xuất bản</span><select value={`${draft.templateId}@${draft.templateVersion}`} onChange={(event) => { const [templateId, version] = event.target.value.split('@'); onPatch({ templateId, templateVersion: Number(version) }); }}><option value="@0">Chọn template</option>{availableTemplates.map((template) => <option key={`${template.id}@${template.version}`} value={`${template.id}@${template.version}`}>{template.title} · v{template.version}</option>)}</select>{(fieldIssue('templateId') || fieldIssue('templateVersion')) && <small className="field-error">{fieldIssue('templateId') || fieldIssue('templateVersion')}</small>}</label>
      <label className="form-field"><span><CalendarOutlined /> Hạn hoàn thành (không bắt buộc)</span><input type="datetime-local" value={draft.dueAt?.slice(0, 16) ?? ''} onChange={(event) => onPatch({ dueAt: event.target.value ? new Date(event.target.value).toISOString() : undefined })} />{fieldIssue('dueAt') && <small className="field-error">{fieldIssue('dueAt')}</small>}</label>
    </div></div>
    <footer><button className="button button-secondary" type="button" onClick={onClose}>Hủy</button><button className="button button-primary" type="button" onClick={onSubmit} disabled={saving}>{saving ? 'Đang giao…' : 'Giao onboarding'}</button></footer>
  </section>;
}

export function EmployeesPage({ api }: { api: OnboardingApi }) {
  const [members, setMembers] = useState<readonly MemberRow[]>([]);
  const [assignments, setAssignments] = useState<readonly AssignmentRow[]>([]);
  const [templates, setTemplates] = useState<readonly TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<AssignmentDraft>(initialDraft);
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (reason: PollReason) => {
    const initial = reason === 'initial';
    if (initial) { setLoading(true); setError(null); }
    try {
      const [memberResult, assignmentResult, templateResult] = await Promise.all([
        api.adminAssignments<{ members: readonly MemberRow[] }>('list_members'),
        api.adminAssignments<{ assignments: readonly AssignmentRow[] }>('list'),
        api.adminTemplates<{ templates: readonly TemplateRow[] }>('list'),
      ]);
      setMembers(memberResult.members);
      setAssignments(assignmentResult.assignments);
      setTemplates(templateResult.templates);
      setError(null);
    } catch (caught) {
      if (initial) setError(caught instanceof Error ? caught : new Error('Không thể tải danh sách nhân sự.'));
    } finally {
      if (initial) setLoading(false);
    }
  }, [api]);

  const refresh = usePolling(load);

  const availableTemplates = useMemo(() => templates.filter((item) => (
    item.status === 'published' && item.employeeType === draft.employeeType
  )), [templates, draft.employeeType]);
  const memberById = useMemo(() => new Map(members.map((member) => [member.userId, member])), [members]);
  const visibleAssignments = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('vi');
    if (!needle) return assignments;
    return assignments.filter((item) => {
      const label = memberLabel(memberById.get(item.memberId), item.memberId);
      return `${label} ${item.templateTitle ?? item.templateId}`.toLocaleLowerCase('vi').includes(needle);
    });
  }, [assignments, memberById, query]);

  function patchDraft(patch: Partial<AssignmentDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setIssues([]);
  }

  async function submit() {
    const nextIssues = validateAssignmentDraft(draft);
    setIssues(nextIssues);
    if (nextIssues.length) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await api.adminAssignments<{ result: { warning?: string } }>('assign', draft as unknown as Record<string, unknown>);
      setNotice(result.result.warning ? `Đã giao onboarding. Lưu ý: ${result.result.warning}` : 'Đã giao onboarding thành công.');
      setFormOpen(false);
      setDraft(initialDraft);
      await refresh();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Không thể giao onboarding.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Đang tải thành viên trong room…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refresh()} />;

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div><span className="section-kicker">NHÂN SỰ TRONG ROOM</span><h2>Quản lý onboarding</h2><p>Chỉ những thành viên được Admin gán thủ công mới nhìn thấy chương trình học.</p></div>
        <button className="button button-primary" type="button" onClick={() => setFormOpen(true)}><PlusOutlined /> Gán onboarding</button>
      </section>
      {notice && <div className="inline-notice" role="status">{notice}</div>}
      <section className="content-card table-card">
        <div className="table-toolbar">
          <div className="search-field"><SearchOutlined /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm theo tên hoặc template…" aria-label="Tìm nhân sự" /></div>
          <span className="muted-count"><TeamOutlined /> {visibleAssignments.length} lượt onboarding</span>
        </div>
        {visibleAssignments.length === 0 ? <p className="table-empty">Chưa có lượt onboarding phù hợp.</p> : (
          <div className="data-table-wrap">
            <table className="data-table employee-table">
              <thead><tr><th>Nhân sự</th><th>Phân loại</th><th>Template</th><th>Tiến độ</th><th>Trạng thái</th><th>Hạn</th></tr></thead>
              <tbody>{visibleAssignments.map((item) => <tr key={item.id}>
                <td><div className="person-cell"><span className="mini-avatar"><UserOutlined /></span><div><strong>{memberLabel(memberById.get(item.memberId), item.memberId)}</strong><small>{memberById.get(item.memberId)?.username || item.memberId}</small></div></div></td>
                <td><span className="type-chip">{item.employeeType === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}</span></td>
                <td>{item.templateTitle || templates.find((template) => template.id === item.templateId && template.version === item.templateVersion)?.title || item.templateId}<small className="cell-subtitle">v{item.templateVersion}</small></td>
                <td className="progress-cell"><ProgressBar value={item.progressPercent ?? 0} /></td><td><StatusBadge status={item.status} /></td><td>{formatDate(item.dueAt)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      {formOpen && <AssignmentModalLayer><div className="dialog-backdrop" role="presentation" onMouseDown={() => setFormOpen(false)}>
        <AssignmentDialog
          members={members}
          availableTemplates={availableTemplates}
          draft={draft}
          issues={issues}
          saving={saving}
          onPatch={patchDraft}
          onClose={() => setFormOpen(false)}
          onSubmit={() => void submit()}
        />
      </div></AssignmentModalLayer>}
    </div>
  );
}
