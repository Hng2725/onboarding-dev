import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  WarningFilled,
} from '@ant-design/icons';
import { useState } from 'react';

import type { VerificationFlag } from '../../../onboarding/contracts';
import { FLAG_TYPE_LABELS } from './ai-labels';

export type FlagResolutionAction = 'choose_option' | 'add_note' | 'remove' | 'accept';

function flagLabel(flag: VerificationFlag): string {
  return FLAG_TYPE_LABELS[flag.type] ?? flag.type;
}

export function FlagPanel({
  flags,
  busy,
  onResolve,
  allowRemove = true,
  onEdit,
}: {
  flags: readonly VerificationFlag[];
  busy: boolean;
  /**
   * False where the content lives in a module job: the server rejects removing it from the
   * draft (REVIEW_INVALID), so the Admin edits the module itself through `onEdit` instead.
   */
  allowRemove?: boolean;
  onEdit?: (flag: VerificationFlag) => void;
  onResolve: (
    flag: VerificationFlag,
    action: FlagResolutionAction,
    note?: string,
    chosenEvidenceIndex?: number,
  ) => void;
}) {
  const [noteFlagId, setNoteFlagId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
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
              {noteFlagId !== flag.id && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setNoteFlagId(flag.id);
                    setNoteText('');
                  }}
                ><EditOutlined /> Thêm ghi chú</button>
              )}
              {allowRemove && <button type="button" disabled={busy} onClick={() => onResolve(flag, 'remove')}><DeleteOutlined /> Loại bỏ nội dung</button>}
              {onEdit && <button type="button" disabled={busy} onClick={() => onEdit(flag)}><EditOutlined /> Chỉnh sửa</button>}
              {flag.severity === 'warning' && <button type="button" disabled={busy} onClick={() => onResolve(flag, 'accept')}><CheckOutlined /> Chấp nhận cảnh báo</button>}
              {noteFlagId === flag.id && (
                <div className="ai-flag-note-editor">
                  <textarea
                    aria-label="Ghi chú xác minh"
                    autoFocus
                    disabled={busy}
                    onChange={(event) => setNoteText(event.target.value)}
                    placeholder="Nhập căn cứ hoặc kết quả xác minh của Admin"
                    rows={3}
                    value={noteText}
                  />
                  <div>
                    <button
                      type="button"
                      disabled={busy || noteText.trim().length === 0}
                      onClick={() => {
                        const note = noteText.trim();
                        if (!note) return;
                        onResolve(flag, 'add_note', note);
                      }}
                    ><CheckOutlined /> Lưu ghi chú</button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setNoteFlagId(null);
                        setNoteText('');
                      }}
                    >Hủy</button>
                  </div>
                </div>
              )}
            </div>
          ) : <span className="ai-flag-resolved"><CheckOutlined /> Đã xử lý</span>}
        </article>
      ))}
    </aside>
  );
}
