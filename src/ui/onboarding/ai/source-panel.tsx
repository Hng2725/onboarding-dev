import {
  DeleteOutlined,
  FileTextOutlined,
  LoadingOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useState } from 'react';

import { AI_GENERATION_LIMITS } from '../../../onboarding/ai/limits';
import type { SourceSummary } from '../../../onboarding/ai/sources';

export const acceptedSourceTypes = '.pdf,.docx,.md,.markdown,.txt,.html,.htm';
const ACCEPTED_EXTENSIONS = new Set(['pdf', 'docx', 'md', 'markdown', 'txt', 'html', 'htm']);

export function resolveUploadSystemName(currentName: string, fileName: string): string {
  const existing = currentName.trim();
  if (existing) return existing;
  const derived = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return derived || 'Onboarding document';
}

export function validateSourceFile(file: Pick<File, 'name' | 'size'>): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    return 'Chỉ hỗ trợ PDF, DOCX, Markdown, TXT và HTML.';
  }
  if (file.size > AI_GENERATION_LIMITS.maxSourceFileBytes) {
    return 'Mỗi tài liệu nguồn không được vượt quá 2 MB.';
  }
  if (file.size === 0) return 'Tài liệu nguồn đang trống.';
  return null;
}

export function SourcePanel({
  sources,
  selectedIds,
  busy,
  onToggle,
  onUpload,
  onDelete,
  onAddNote,
}: {
  sources: readonly SourceSummary[];
  selectedIds: ReadonlySet<string>;
  busy: boolean;
  onToggle: (sourceId: string) => void;
  onUpload: (file: File) => void;
  onDelete: (sourceId: string) => void;
  onAddNote: (title: string, text: string) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  return (
    <div className="ai-source-layout">
      <section className="ai-source-upload">
        <div>
          <span className="section-kicker">TÀI LIỆU ĐẦU VÀO</span>
          <h3>Thêm kiến thức cho AI</h3>
          <p>AI chỉ tạo nội dung có thể đối chiếu với các tài liệu được chọn.</p>
        </div>
        <label className="ai-upload-zone">
          {busy ? <LoadingOutlined spin /> : <UploadOutlined />}
          <strong>{busy ? 'Đang xử lý tài liệu…' : 'Tải tài liệu lên'}</strong>
          <span>PDF, DOCX, Markdown, TXT hoặc HTML · tối đa 2 MB/file</span>
          <input
            type="file"
            accept={acceptedSourceTypes}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file);
              event.target.value = '';
            }}
          />
        </label>
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => setNoteOpen((value) => !value)}>
          <PlusOutlined /> Thêm ghi chú Admin
        </button>
        {noteOpen && (
          <div className="ai-note-form">
            <label className="form-field"><span>Tiêu đề ghi chú</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label className="form-field"><span>Nội dung xác minh</span><textarea rows={5} value={text} onChange={(event) => setText(event.target.value)} /></label>
            <button
              className="button button-primary"
              type="button"
              disabled={busy || !title.trim() || !text.trim()}
              onClick={() => {
                onAddNote(title, text);
                setTitle('');
                setText('');
                setNoteOpen(false);
              }}
            >
              Lưu ghi chú
            </button>
          </div>
        )}
      </section>
      <section className="ai-source-list" aria-label="Danh sách tài liệu nguồn">
        <header>
          <div><h3>Nguồn đã thêm</h3><p>Chọn từ 1 đến 10 nguồn để phân tích.</p></div>
          <span>{selectedIds.size}/{sources.length} đã chọn</span>
        </header>
        {sources.length === 0 && <div className="ai-source-empty"><FileTextOutlined /><strong>Chưa có tài liệu nguồn</strong><span>Tải file hoặc thêm ghi chú để bắt đầu.</span></div>}
        {sources.map((source) => (
          <article className={selectedIds.has(source.sourceId) ? 'ai-source-item selected' : 'ai-source-item'} key={source.sourceId}>
            <label>
              <input type="checkbox" checked={selectedIds.has(source.sourceId)} onChange={() => onToggle(source.sourceId)} />
              <span className="ai-source-icon"><FileTextOutlined /></span>
              <span>
                <strong>{source.fileName}</strong>
                <small>{source.kind === 'admin_note' ? 'Ghi chú Admin' : source.mimeType ?? 'Tài liệu'}{source.textLength ? ' · ' + source.textLength.toLocaleString('vi-VN') + ' ký tự' : ''}</small>
              </span>
            </label>
            <button className="icon-button" type="button" aria-label={'Xóa ' + source.fileName} disabled={busy} onClick={() => onDelete(source.sourceId)}><DeleteOutlined /></button>
          </article>
        ))}
      </section>
    </div>
  );
}
