import {
  ArrowRightOutlined,
  BookOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useCallback, useMemo, useState } from 'react';

import type { AssignmentStatus, EmployeeType } from '../../onboarding/contracts';
import type { OnboardingApi } from './api';
import { EmptyState, ErrorState, LEARNER_EMPTY_STATE, LoadingState, ProgressBar, StatusBadge } from './components';
import { usePolling, type PollReason } from './polling';

export interface LearnerAssignmentListItem {
  readonly id: string;
  readonly templateId?: string;
  readonly templateTitle?: string;
  readonly employeeType?: EmployeeType;
  readonly status: AssignmentStatus;
  readonly dueAt?: string;
  readonly assignedAt: string;
  readonly progressPercent?: number;
}

const LEARNABLE_STATUSES: readonly AssignmentStatus[] = ['assigned', 'in_progress', 'retry'];

export function chooseContinueAssignment<T extends Pick<LearnerAssignmentListItem, 'id' | 'status' | 'dueAt' | 'assignedAt'>>(
  assignments: readonly T[],
): T | undefined {
  return [...assignments].filter((item) => LEARNABLE_STATUSES.includes(item.status)).sort((left, right) => {
    const leftDate = left.dueAt ? new Date(left.dueAt).valueOf() : Number.POSITIVE_INFINITY;
    const rightDate = right.dueAt ? new Date(right.dueAt).valueOf() : Number.POSITIVE_INFINITY;
    return leftDate - rightDate || new Date(left.assignedAt).valueOf() - new Date(right.assignedAt).valueOf();
  })[0];
}

function dueLabel(value?: string): string {
  if (!value) return 'Không giới hạn thời gian';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? `Hạn ${new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium' }).format(date)}` : value;
}

export function LearnerDashboard({ api, onContinue, onOpenResults }: { api: OnboardingApi; onContinue: (assignmentId: string) => void; onOpenResults: () => void }) {
  const [items, setItems] = useState<readonly LearnerAssignmentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const load = useCallback(async (reason: PollReason) => {
    const initial = reason === 'initial';
    if (initial) { setLoading(true); setError(null); }
    try {
      setItems((await api.learning<{ assignments: readonly LearnerAssignmentListItem[] }>('list')).assignments);
      setError(null);
    } catch (caught) {
      if (initial) setError(caught instanceof Error ? caught : new Error('Không thể tải lộ trình của bạn.'));
    } finally {
      if (initial) setLoading(false);
    }
  }, [api]);
  const refresh = usePolling(load);

  const next = useMemo(() => chooseContinueAssignment(items), [items]);
  const complete = items.filter((item) => item.status === 'passed' || item.status === 'failed').length;
  if (loading) return <LoadingState label="Đang tải lộ trình của bạn…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refresh()} />;
  if (!items.length) return <EmptyState {...LEARNER_EMPTY_STATE} icon={<BookOutlined />} />;

  return <div className="page-stack">
    <section className="learner-hero"><div><span className="welcome-kicker"><BookOutlined /> Lộ trình cá nhân</span><h2>Tiến thêm một bước trong hành trình PrivOS.</h2><p>Hoàn thành tài liệu bắt buộc, làm bài và xem phản hồi của Admin.</p>{next && <button className="button learner-cta" type="button" onClick={() => onContinue(next.id)}>Tiếp tục học <ArrowRightOutlined /></button>}</div><div className="hero-score"><strong>{complete}/{items.length}</strong><span>chương trình hoàn tất</span><TrophyOutlined /></div></section>
    <section className="learner-summary"><article><ClockCircleOutlined /><div><strong>{items.length - complete}</strong><span>Đang thực hiện</span></div></article><article><CheckCircleOutlined /><div><strong>{complete}</strong><span>Đã kết thúc</span></div></article><button type="button" onClick={onOpenResults}>Xem tất cả kết quả <ArrowRightOutlined /></button></section>
    <section><div className="section-header"><div><span className="section-kicker">CHƯƠNG TRÌNH CỦA BẠN</span><h2>Nội dung onboarding</h2></div></div><div className="assignment-grid">{items.map((item) => { const canLearn = LEARNABLE_STATUSES.includes(item.status); return <article className="assignment-card" key={item.id}><div className="assignment-card-head"><span className="assignment-type">{item.employeeType === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}</span><StatusBadge status={item.status} /></div><div className="assignment-book"><BookOutlined /></div><h3>{item.templateTitle || item.templateId || 'Chương trình onboarding'}</h3><p><CalendarOutlined /> {dueLabel(item.dueAt)}</p><ProgressBar value={item.progressPercent ?? (item.status === 'passed' || item.status === 'failed' ? 100 : 0)} /><button className="button button-secondary" type="button" onClick={() => canLearn ? onContinue(item.id) : onOpenResults()}>{canLearn ? 'Mở chương trình' : 'Xem kết quả'} <ArrowRightOutlined /></button></article>; })}</div></section>
  </div>;
}
