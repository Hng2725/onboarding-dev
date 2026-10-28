import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  WarningFilled,
} from '@ant-design/icons';

import type { VerificationFlag } from '../../../onboarding/contracts';

export type FlagResolutionAction = 'choose_option' | 'add_note' | 'remove' | 'accept';

function flagLabel(flag: VerificationFlag): string {
  const labels: Record<VerificationFlag['type'], string> = {
    missing: 'Thiếu thông tin',
    conflict: 'Mâu thuẫn',
    ambiguous: 'Chưa rõ',
    outdated: 'Có thể lỗi thời',
    unsupported: 'Không có căn cứ',
    audience_unclear: 'Chưa rõ đối tượng',
    low_quality_source: 'Nguồn chất lượng thấp',
    generation_error: 'Lỗi tạo nội dung',
  };
  return labels[flag.type];
}

export function FlagPanel({
  flags,
  busy,
  onResolve,
}: {
  flags: readonly VerificationFlag[];
  busy: boolean;
  onResolve: (
    flag: VerificationFlag,
    action: FlagResolutionAction,
    note?: string,
    chosenEvidenceIndex?: number,
  ) => void;
}) {
  const ordered = [...flags].sort((left, right) => {
    if (left.status !== right.status) return left.status === 'open' ? -1 : 1;
    if (left.severity !== right.severity) return left.severity === 'blocking' ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
  return (
    <aside className="ai-flag-panel">
      <header>
        <div><span className="section-kicker">KIỂM CHỨNG</span><h3>Cờ cần rà soát</h3></div>
        <span>{flags.filter((flag) => flag.status === 'open').length} đang mở</span>
      </header>
      {ordered.length === 0 && <div className="ai-flag-empty"><CheckOutlined /><span>Không có cờ cần xử lý.</span></div>}
      {ordered.map((flag) => (
        <article className={'ai-flag ai-flag-' + flag.severity + ' ai-flag-' + flag.status} key={flag.id}>
          <div className="ai-flag-heading">
            {flag.severity === 'blocking' ? <ExclamationCircleFilled /> : <WarningFilled />}
            <strong>{flag.severity === 'blocking' ? 'Cần xử lý' : 'Cảnh báo'}</strong>
            <span>{flagLabel(flag)}</span>
          </div>
          <p>{flag.message}</p>
          <small>{flag.questionForAdmin}</small>
          {flag.status === 'open' ? (
            <div className="ai-flag-actions">
              {flag.type === 'conflict' && flag.evidence.length > 0 && (
                <button type="button" disabled={busy} onClick={() => onResolve(flag, 'choose_option', undefined, 0)}><CheckOutlined /> Chọn phương án</button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const note = window.prompt('Nhập ghi chú xác minh');
                  if (note?.trim()) onResolve(flag, 'add_note', note.trim());
                }}
              ><EditOutlined /> Thêm ghi chú</button>
              <button type="button" disabled={busy} onClick={() => onResolve(flag, 'remove')}><DeleteOutlined /> Loại bỏ nội dung</button>
              {flag.severity === 'warning' && <button type="button" disabled={busy} onClick={() => onResolve(flag, 'accept')}><CheckOutlined /> Chấp nhận cảnh báo</button>}
            </div>
          ) : <span className="ai-flag-resolved"><CheckOutlined /> Đã xử lý</span>}
        </article>
      ))}
    </aside>
  );
}
