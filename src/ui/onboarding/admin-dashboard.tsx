import {
  ArrowRightOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useCallback, useState } from 'react';

import type { AssignmentStatus } from '../../onboarding/contracts';
import type { OnboardingApi } from './api';
import { ErrorState, LoadingState, StatusBadge } from './components';
import { usePolling, type PollReason } from './polling';

interface AssignmentRow {
  readonly id: string;
  readonly memberId: string;
  readonly status: AssignmentStatus;
  readonly assignedAt: string;
  readonly dueAt?: string;
  readonly templateId?: string;
  readonly templateVersion?: number;
  readonly templateTitle?: string;
  readonly progressPercent?: number;
}

interface MemberRow {
  readonly userId: string;
  readonly username?: string;
  readonly displayName?: string;
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

export function dashboardMemberLabel(members: readonly MemberRow[], memberId: string): string {
  const member = members.find((item) => item.userId === memberId);
  return member?.displayName || member?.username || memberId;
}

type AttentionRoute = 'employees' | 'essay-feedback' | 'evaluations';

export interface AdminOverview {
  readonly kpis: {
    readonly total: number;
    readonly completionRate: number;
    readonly active: number;
    readonly overdue: number;
    readonly needsAction: number;
  };
  readonly stages: readonly {
    readonly key: 'assigned' | 'learning' | 'essay' | 'evaluation' | 'completed';
    readonly label: string;
    readonly count: number;
    readonly percent: number;
  }[];
  readonly attention: readonly {
    readonly id: string;
    readonly memberName: string;
    readonly templateTitle: string;
    readonly status: AssignmentStatus;
    readonly reason: string;
    readonly route: AttentionRoute;
  }[];
  readonly deadlines: {
    readonly overdue: number;
    readonly next3Days: number;
    readonly days4To7: number;
    readonly later: number;
    readonly noDue: number;
  };
  readonly templates: readonly {
    readonly key: string;
    readonly title: string;
    readonly templateVersion?: number;
    readonly assignmentCount: number;
    readonly averageProgress: number;
  }[];
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const FINISHED_STATUSES: readonly AssignmentStatus[] = ['passed', 'failed'];
const ACTION_STATUSES: readonly AssignmentStatus[] = ['submitted', 'awaiting_essay_feedback', 'awaiting_evaluation', 'failed'];
export function overviewDateRangeLabel(now = new Date()): string {
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  const format = (date: Date) => `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
  return `Từ ${format(now)} đến ${format(end)}`;
}

function validDateValue(value?: string): number | null {
  if (!value) return null;
  const timestamp = new Date(value).valueOf();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function attentionRoute(status: AssignmentStatus): AttentionRoute {
  if (status === 'submitted' || status === 'awaiting_essay_feedback') return 'essay-feedback';
  if (status === 'awaiting_evaluation') return 'evaluations';
  return 'employees';
}

function attentionReason(row: AssignmentRow, overdue: boolean, now: number): string {
  const statusReason: Partial<Record<AssignmentStatus, string>> = {
    submitted: 'Bài đã nộp, cần kiểm tra',
    awaiting_essay_feedback: 'Chờ nhận xét tự luận',
    awaiting_evaluation: 'Chờ đánh giá chung',
    failed: 'Cần xem xét kết quả',
  };
  if (!overdue) return statusReason[row.status] ?? 'Cần theo dõi';
  const dueAt = validDateValue(row.dueAt) ?? now;
  const overdueDays = Math.max(1, Math.ceil((now - dueAt) / DAY_IN_MS));
  const suffix = statusReason[row.status];
  return `Quá hạn ${overdueDays} ngày${suffix ? ` · ${suffix}` : ''}`;
}

export function buildAdminOverview(
  rows: readonly AssignmentRow[],
  members: readonly MemberRow[],
  now = new Date(),
): AdminOverview {
  const nowValue = now.valueOf();
  const isFinished = (row: AssignmentRow) => FINISHED_STATUSES.includes(row.status);
  const isOverdue = (row: AssignmentRow) => {
    const dueAt = validDateValue(row.dueAt);
    return !isFinished(row) && dueAt !== null && dueAt < nowValue;
  };
  const count = (statuses: readonly AssignmentStatus[]) => rows.filter((row) => statuses.includes(row.status)).length;
  const completed = count(FINISHED_STATUSES);
  const total = rows.length;

  const stageDefinitions = [
    { key: 'assigned', label: 'Chưa bắt đầu', statuses: ['assigned'] },
    { key: 'learning', label: 'Đang học', statuses: ['in_progress', 'retry'] },
    { key: 'essay', label: 'Chờ nhận xét', statuses: ['submitted', 'awaiting_essay_feedback'] },
    { key: 'evaluation', label: 'Chờ đánh giá', statuses: ['awaiting_evaluation'] },
    { key: 'completed', label: 'Hoàn tất', statuses: ['passed', 'failed'] },
  ] as const;
  const stages = stageDefinitions.map((stage) => {
    const stageCount = count(stage.statuses);
    return { key: stage.key, label: stage.label, count: stageCount, percent: total ? Math.round(stageCount / total * 100) : 0 };
  });

  const attention = rows
    .map((row) => {
      const overdue = isOverdue(row);
      if (!overdue && !ACTION_STATUSES.includes(row.status)) return null;
      const priority = overdue ? 0 : row.status === 'awaiting_evaluation' ? 1
        : row.status === 'submitted' || row.status === 'awaiting_essay_feedback' ? 2 : 3;
      return {
        id: row.id,
        memberName: dashboardMemberLabel(members, row.memberId),
        templateTitle: row.templateTitle || row.templateId || 'Chương trình onboarding',
        status: row.status,
        reason: attentionReason(row, overdue, nowValue),
        route: attentionRoute(row.status),
        priority,
        dueAt: validDateValue(row.dueAt) ?? Number.POSITIVE_INFINITY,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => left.priority - right.priority || left.dueAt - right.dueAt)
    .map(({ priority: _priority, dueAt: _dueAt, ...item }) => item);

  const deadlines = { overdue: 0, next3Days: 0, days4To7: 0, later: 0, noDue: 0 };
  for (const row of rows.filter((item) => !isFinished(item))) {
    const dueAt = validDateValue(row.dueAt);
    if (dueAt === null) deadlines.noDue += 1;
    else if (dueAt < nowValue) deadlines.overdue += 1;
    else if (dueAt <= nowValue + 3 * DAY_IN_MS) deadlines.next3Days += 1;
    else if (dueAt <= nowValue + 7 * DAY_IN_MS) deadlines.days4To7 += 1;
    else deadlines.later += 1;
  }

  const templateGroups = new Map<string, { title: string; templateVersion?: number; count: number; progress: number }>();
  for (const row of rows) {
    const title = row.templateTitle || row.templateId || 'Chương trình chưa đặt tên';
    const key = row.templateId ? `${row.templateId}@${row.templateVersion ?? 'unknown'}` : `title:${title}`;
    const fallbackProgress = isFinished(row) ? 100 : 0;
    const progress = Math.max(0, Math.min(100, row.progressPercent ?? fallbackProgress));
    const group = templateGroups.get(key) ?? { title, templateVersion: row.templateVersion, count: 0, progress: 0 };
    group.count += 1;
    group.progress += progress;
    templateGroups.set(key, group);
  }
  const templates = [...templateGroups.entries()]
    .map(([key, group]) => ({
      key,
      title: group.title,
      templateVersion: group.templateVersion,
      assignmentCount: group.count,
      averageProgress: Math.round(group.progress / group.count),
    }))
    .sort((left, right) => right.assignmentCount - left.assignmentCount || left.title.localeCompare(right.title, 'vi'));

  return {
    kpis: {
      total,
      completionRate: total ? Math.round(completed / total * 100) : 0,
      active: count(['assigned', 'in_progress', 'retry']),
      overdue: rows.filter(isOverdue).length,
      needsAction: count(ACTION_STATUSES),
    },
    stages,
    attention,
    deadlines,
    templates,
  };
}

export async function loadAdminDashboard(api: OnboardingApi): Promise<{
  readonly assignments: readonly AssignmentRow[];
  readonly members: readonly MemberRow[];
}> {
  const [assignmentResult, memberResult] = await Promise.all([
    api.adminAssignments<{ assignments: readonly AssignmentRow[] }>('list'),
    api.adminAssignments<{ members: readonly MemberRow[] }>('list_members')
      .catch(() => ({ members: [] as readonly MemberRow[] })),
  ]);
  return { assignments: assignmentResult.assignments, members: memberResult.members };
}

function deadlineGradient(deadlines: AdminOverview['deadlines']): string {
  const total = deadlines.overdue + deadlines.next3Days + deadlines.days4To7 + deadlines.later;
  if (!total) return 'conic-gradient(var(--on-border) 0 100%)';
  const overdueEnd = deadlines.overdue / total * 100;
  const next3End = overdueEnd + deadlines.next3Days / total * 100;
  const weekEnd = next3End + deadlines.days4To7 / total * 100;
  return `conic-gradient(#d84c5b 0 ${overdueEnd}%, #e7a83e ${overdueEnd}% ${next3End}%, #6b6fd9 ${next3End}% ${weekEnd}%, #3f9d78 ${weekEnd}% 100%)`;
}

function attentionActionLabel(route: AttentionRoute): string {
  if (route === 'essay-feedback') return 'Nhận xét';
  if (route === 'evaluations') return 'Đánh giá';
  return 'Xem nhân sự';
}

export function AdminOverviewContent({
  rows,
  members,
  now = new Date(),
  onNavigate,
}: {
  rows: readonly AssignmentRow[];
  members: readonly MemberRow[];
  now?: Date;
  onNavigate: (route: AttentionRoute) => void;
}) {
  const overview = buildAdminOverview(rows, members, now);
  const completed = overview.stages.find((stage) => stage.key === 'completed')?.count ?? 0;
  const deadlineTotal = overview.deadlines.overdue + overview.deadlines.next3Days
    + overview.deadlines.days4To7 + overview.deadlines.later;
  const deadlineRange = overviewDateRangeLabel(now);
  const deadlineItems = [
    { key: 'overdue', label: 'Đã quá hạn', value: overview.deadlines.overdue },
    { key: 'soon', label: 'Trong 3 ngày tới', value: overview.deadlines.next3Days },
    { key: 'week', label: 'Từ 4–7 ngày', value: overview.deadlines.days4To7 },
    { key: 'safe', label: 'Trên 7 ngày', value: overview.deadlines.later },
  ] as const;

  return (
    <div className="overview-dashboard">
      <section className="overview-kpi-grid" aria-label="Chỉ số onboarding quan trọng">
        <article className="overview-kpi-card overview-kpi-success">
          <div className="overview-kpi-heading"><span className="overview-kpi-icon"><CheckCircleOutlined /></span><span>Tỷ lệ hoàn thành</span></div>
          <strong>{overview.kpis.completionRate}%</strong>
          <small>{completed}/{overview.kpis.total} lượt đã kết thúc</small>
        </article>
        <article className="overview-kpi-card overview-kpi-primary">
          <div className="overview-kpi-heading"><span className="overview-kpi-icon"><ClockCircleOutlined /></span><span>Đang thực hiện</span></div>
          <strong>{overview.kpis.active}</strong>
          <small>Đã giao, đang học hoặc làm lại</small>
        </article>
        <article className="overview-kpi-card overview-kpi-danger">
          <div className="overview-kpi-heading"><span className="overview-kpi-icon"><ExclamationCircleOutlined /></span><span>Đã quá hạn</span></div>
          <strong>{overview.kpis.overdue}</strong>
          <small>Lượt chưa hoàn tất cần theo dõi</small>
        </article>
        <article className="overview-kpi-card overview-kpi-warning">
          <div className="overview-kpi-heading"><span className="overview-kpi-icon"><TeamOutlined /></span><span>Cần Admin xử lý</span></div>
          <strong>{overview.kpis.needsAction}</strong>
          <small>Nhận xét, đánh giá hoặc xem kết quả</small>
        </article>
      </section>

      <div className="overview-primary-grid">
        <section className="content-card overview-flow-card">
          <div className="section-header">
            <div><span className="section-kicker">TOÀN BỘ HÀNH TRÌNH</span><h2>Luồng trạng thái</h2><p>Phân bổ hiện tại của các lượt onboarding.</p></div>
            <span className="overview-total-pill">{overview.kpis.total} lượt</span>
          </div>
          {overview.kpis.total === 0 ? (
            <div className="overview-empty"><TeamOutlined /><strong>Chưa có dữ liệu onboarding</strong><span>Gán chương trình đầu tiên để bắt đầu theo dõi.</span></div>
          ) : (
            <div className="overview-stage-list" aria-label="Luồng trạng thái onboarding">
              {overview.stages.map((stage) => (
                <article className={`overview-stage overview-stage-${stage.key}`} key={stage.key} aria-label={`${stage.label}: ${stage.count}/${overview.kpis.total}`}>
                  <div className="overview-stage-heading"><span className="overview-stage-dot" aria-hidden="true" /><span>{stage.label}</span></div>
                  <strong className="overview-stage-value"><span>{stage.count}</span><small>/{overview.kpis.total}</small></strong>
                  <div className="overview-stage-track" role="progressbar" aria-label={stage.label} aria-valuemin={0} aria-valuemax={overview.kpis.total} aria-valuenow={stage.count}>
                    <span style={{ width: `${Math.max(stage.percent, stage.count ? 4 : 0)}%` }} />
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="content-card overview-deadline-card">
          <div className="section-header"><div><span className="section-kicker">7 NGÀY TỚI</span><h2>{deadlineRange}</h2><p>Ưu tiên theo mốc cần hoàn thành.</p></div><CalendarOutlined className="overview-card-icon" /></div>
          <div className="overview-deadline-body">
            <div className="overview-deadline-ring" style={{ background: deadlineGradient(overview.deadlines) }} role="img" aria-label={`${overview.deadlines.overdue} lượt quá hạn trên ${deadlineTotal} lượt có thời hạn`}>
              <div><strong>{deadlineTotal}</strong><span>có thời hạn</span></div>
            </div>
            <div className="overview-deadline-legend">
              {deadlineItems.map((item) => <div key={item.key} className={`deadline-${item.key}`}><span className="overview-legend-dot" /><span>{item.label}</span><strong>{item.value}</strong></div>)}
            </div>
          </div>
          <div className="overview-deadline-foot"><span>Chưa đặt thời hạn</span><strong>{overview.deadlines.noDue}</strong></div>
        </section>
      </div>

      <div className="overview-secondary-grid">
        <section className="content-card overview-attention-card">
          <div className="section-header">
            <div><span className="section-kicker">ƯU TIÊN HÔM NAY</span><h2>Cần xử lý ngay</h2><p>Quá hạn và các bước đang chờ Admin.</p></div>
            <span className="overview-total-pill overview-total-alert">{overview.attention.length}</span>
          </div>
          {overview.attention.length === 0 ? (
            <div className="overview-empty overview-empty-compact"><CheckCircleOutlined /><strong>Không có việc tồn đọng</strong><span>Mọi lượt onboarding đang đúng tiến độ.</span></div>
          ) : (
            <div className="overview-attention-list">
              {overview.attention.slice(0, 5).map((item) => (
                <button className="overview-attention-row" type="button" key={item.id} onClick={(event) => { event.currentTarget.blur(); onNavigate(item.route); }}>
                  <span className="overview-person-mark">{item.memberName.trim().charAt(0).toLocaleUpperCase('vi') || '?'}</span>
                  <span className="overview-attention-copy"><strong>{item.memberName}</strong><small>{item.templateTitle}</small><span className={item.reason.startsWith('Quá hạn') ? 'overview-reason-danger' : ''}>{item.reason}</span></span>
                  <StatusBadge status={item.status} />
                  <span className="overview-row-action">{attentionActionLabel(item.route)} <ArrowRightOutlined /></span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="content-card overview-template-card">
          <div className="section-header"><div><span className="section-kicker">HIỆU QUẢ CHƯƠNG TRÌNH</span><h2>Tiến độ theo template</h2><p>Tiến độ trung bình của từng chương trình.</p></div></div>
          {overview.templates.length === 0 ? (
            <div className="overview-empty overview-empty-compact"><TeamOutlined /><strong>Chưa có template được giao</strong><span>Dữ liệu sẽ xuất hiện sau khi có lượt onboarding.</span></div>
          ) : (
            <div className="overview-template-list">
              {overview.templates.slice(0, 5).map((template) => (
                <div className="overview-template-row" key={template.key}>
                  <div><strong>{template.title}</strong><span>{template.assignmentCount} lượt{template.templateVersion !== undefined ? ` · v${template.templateVersion}` : ''}</span></div>
                  <div className="overview-template-progress" role="progressbar" aria-label={`Tiến độ ${template.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={template.averageProgress}>
                    <span style={{ width: `${template.averageProgress}%` }} />
                  </div>
                  <strong>{template.averageProgress}%</strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function AdminDashboardHeader({ onOpenEmployees }: { onOpenEmployees: () => void }) {
  return (
    <section className="page-heading">
      <div><span className="section-kicker">ADMIN WORKSPACE</span><h2>Tổng quan onboarding</h2><p>Nắm các chỉ số quan trọng, thời hạn và việc cần xử lý trong một màn hình.</p></div>
      <div className="heading-actions">
        <button className="button button-primary" type="button" onClick={(event) => { event.currentTarget.blur(); onOpenEmployees(); }}><TeamOutlined /> Gán onboarding</button>
      </div>
    </section>
  );
}

export function AdminDashboard({ api, onNavigate }: { api: OnboardingApi; onNavigate: (route: AttentionRoute) => void }) {
  const [rows, setRows] = useState<readonly AssignmentRow[]>([]);
  const [members, setMembers] = useState<readonly MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async (reason: PollReason) => {
    const initial = reason === 'initial';
    if (initial) { setLoading(true); setError(null); }
    try {
      const result = await loadAdminDashboard(api);
      setRows(result.assignments);
      setMembers(result.members);
      setError(null);
    } catch (caught) {
      if (initial) setError(caught instanceof Error ? caught : new Error('Không thể tải dashboard.'));
    } finally {
      if (initial) setLoading(false);
    }
  }, [api]);

  const refresh = usePolling(load);

  if (loading) return <LoadingState label="Đang tổng hợp tiến độ trong room…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refresh()} />;

  return (
    <div className="page-stack">
      <AdminDashboardHeader onOpenEmployees={() => onNavigate('employees')} />
      <AdminOverviewContent rows={rows} members={members} onNavigate={onNavigate} />
    </div>
  );
}
