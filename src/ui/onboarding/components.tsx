import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  LoadingOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';

import type { AssignmentStatus, FinalConclusion } from '../../onboarding/contracts';

const STATUS_LABELS: Readonly<Record<AssignmentStatus, string>> = {
  assigned: 'Đã giao',
  in_progress: 'Đang học',
  submitted: 'Đã nộp',
  awaiting_essay_feedback: 'Chờ nhận xét tự luận',
  awaiting_evaluation: 'Chờ đánh giá chung',
  passed: 'Đạt',
  failed: 'Không đạt',
  retry: 'Làm lại',
};

const CONCLUSION_LABELS: Readonly<Record<FinalConclusion, string>> = {
  passed: 'Đạt',
  failed: 'Không đạt',
  retry: 'Làm lại',
};

export const LEARNER_EMPTY_STATE = {
  title: 'Bạn chưa được gán onboarding',
  description: 'Khi Admin gán chương trình phù hợp, nội dung học và tiến độ sẽ xuất hiện tại đây.',
} as const;

export function assignmentStatusLabel(status: AssignmentStatus): string {
  return STATUS_LABELS[status];
}

export function conclusionLabel(conclusion: FinalConclusion): string {
  return CONCLUSION_LABELS[conclusion];
}

export function StatusBadge({ status }: { status: AssignmentStatus }) {
  return <span className={`status-badge status-${status}`}>{assignmentStatusLabel(status)}</span>;
}

export function ProgressBar({ value, label = 'Tiến độ' }: { value: number; label?: string }) {
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="progress-block">
      <div className="progress-label"><span>{label}</span><strong>{bounded}%</strong></div>
      <div className="progress-track" role="progressbar" aria-valuenow={bounded} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${bounded}%` }} />
      </div>
    </div>
  );
}

export function LoadingState({ label = 'Đang tải dữ liệu onboarding…' }: { label?: string }) {
  return (
    <div className="state-card state-loading" role="status">
      <LoadingOutlined spin aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="state-card state-empty">
      <div className="state-icon">{icon ?? <CheckCircleFilled aria-hidden="true" />}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <section className="state-card state-error" role="alert">
      <CloseCircleFilled aria-hidden="true" />
      <h2>Không thể tải Onboarding</h2>
      <p>{error.message}</p>
      {onRetry && <button className="button button-primary" type="button" onClick={onRetry}><ReloadOutlined /> Thử lại</button>}
    </section>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Xác nhận',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <ExclamationCircleFilled className="dialog-icon" aria-hidden="true" />
        <h2 id="confirm-title">{title}</h2>
        <p>{description}</p>
        <div className="dialog-actions">
          <button className="button button-secondary" type="button" onClick={onCancel}>Hủy</button>
          <button className="button button-primary" type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
