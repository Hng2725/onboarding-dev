import {
  AuditOutlined,
  BellOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CommentOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import type { AssignmentStatus } from '../../onboarding/contracts';
import type { ReminderSummary } from '../../onboarding/assignments';
import type { OnboardingApi } from './api';
import { ErrorState, LoadingState, StatusBadge } from './components';

interface AssignmentRow {
  readonly id: string;
  readonly memberId: string;
  readonly status: AssignmentStatus;
  readonly assignedAt: string;
  readonly dueAt?: string;
}

export interface AdminKpis {
  readonly total: number;
  readonly active: number;
  readonly pendingEssay: number;
  readonly pendingEvaluation: number;
  readonly completed: number;
}

export function deriveAdminKpis(rows: readonly Pick<AssignmentRow, 'status'>[]): AdminKpis {
  const count = (statuses: readonly AssignmentStatus[]) => rows.filter((row) => statuses.includes(row.status)).length;
  return {
    total: rows.length,
    active: count(['assigned', 'in_progress', 'retry']),
    pendingEssay: count(['awaiting_essay_feedback']),
    pendingEvaluation: count(['awaiting_evaluation']),
    completed: count(['passed', 'failed']),
  };
}

export function reminderMessage(summary: ReminderSummary): string {
  return `Đã gửi ${summary.sent} · Bỏ qua ${summary.skipped} · Thất bại ${summary.failed}`;
}

function dateLabel(value?: string): string {
  if (!value) return 'Không giới hạn';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium' }).format(date) : value;
}

export function AdminDashboard({ api, onOpenEmployees }: { api: OnboardingApi; onOpenEmployees: () => void }) {
  const [rows, setRows] = useState<readonly AssignmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reminding, setReminding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.adminAssignments<{ assignments: readonly AssignmentRow[] }>('list');
      setRows(response.assignments);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Không thể tải dashboard.'));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function sendReminders() {
    setReminding(true);
    setNotice(null);
    try {
      const result = await api.adminAssignments<{ summary: ReminderSummary }>('send_due_reminders', {
        at: new Date().toISOString(),
      });
      setNotice(reminderMessage(result.summary));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Không thể gửi nhắc hạn.');
    } finally {
      setReminding(false);
    }
  }

  if (loading) return <LoadingState label="Đang tổng hợp tiến độ trong room…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;

  const kpis = deriveAdminKpis(rows);
  const recent = rows.slice(0, 5);
  return (
    <div className="page-stack">
      <section className="page-heading">
        <div><span className="section-kicker">ADMIN WORKSPACE</span><h2>Chào mừng trở lại</h2><p>Nắm tiến độ, xử lý hàng đợi và hỗ trợ nhân sự hoàn thành onboarding.</p></div>
        <div className="heading-actions">
          <button className="button button-secondary" type="button" onClick={() => void sendReminders()} disabled={reminding}>
            <BellOutlined /> {reminding ? 'Đang gửi…' : 'Nhắc hạn 48 giờ'}
          </button>
          <button className="button button-primary" type="button" onClick={onOpenEmployees}><TeamOutlined /> Gán onboarding</button>
        </div>
      </section>
      {notice && <div className="inline-notice" role="status">{notice}</div>}
      <section className="stats-grid admin-kpis">
        <article className="stat-card"><div className="stat-icon stat-blue"><TeamOutlined /></div><div><span>Tổng lượt giao</span><strong>{kpis.total}</strong></div></article>
        <article className="stat-card"><div className="stat-icon stat-violet"><ClockCircleOutlined /></div><div><span>Đang thực hiện</span><strong>{kpis.active}</strong></div></article>
        <article className="stat-card"><div className="stat-icon stat-amber"><CommentOutlined /></div><div><span>Chờ nhận xét</span><strong>{kpis.pendingEssay}</strong></div></article>
        <article className="stat-card"><div className="stat-icon stat-green"><AuditOutlined /></div><div><span>Chờ đánh giá</span><strong>{kpis.pendingEvaluation}</strong></div></article>
      </section>
      <section className="content-card">
        <div className="section-header"><div><span className="section-kicker">HOẠT ĐỘNG GẦN ĐÂY</span><h2>Tiến độ nhân sự</h2></div><span className="muted-count"><CheckCircleOutlined /> {kpis.completed} đã kết thúc</span></div>
        {recent.length === 0 ? <p className="table-empty">Chưa có nhân sự nào được gán onboarding.</p> : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Nhân sự</th><th>Trạng thái</th><th>Ngày giao</th><th>Hạn hoàn thành</th></tr></thead>
              <tbody>{recent.map((row) => <tr key={row.id}><td><strong>{row.memberId}</strong></td><td><StatusBadge status={row.status} /></td><td>{dateLabel(row.assignedAt)}</td><td>{dateLabel(row.dueAt)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
