import {
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
  return derived || 'Tài liệu onboarding';
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

/** Short badge for a source row: the file extension, or "GHI" for an Admin note. */
function sourceBadge(source: Pick<SourceSummary, 'kind' | 'fileName'>): string {
  if (source.kind === 'admin_note') return 'GHI';
  const extension = /\.([a-z0-9]+)$/iu.exec(source.fileName)?.[1] ?? '';
  return extension ? extension.slice(0, 4).toUpperCase() : 'TL';
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
  const [dragging, setDragging] = useState(false);

  return (
    <section className="ai-sources" aria-label="Tài liệu nguồn">
      <span className="ai-label">Tài liệu nguồn · {selectedIds.size}/{AI_GENERATION_LIMITS.maxSourcesPerRoom}</span>
      <label
        className={'ai-drop' + (dragging ? ' dragging' : '') + (busy ? ' busy' : '')}
        onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer?.files?.[0];
          if (file && !busy) onUpload(file);
        }}
      >
        <span className="ai-drop-icon" aria-hidden="true">{busy ? <LoadingOutlined spin /> : <UploadOutlined />}</span>
        <span>
          <strong>{busy ? 'Đang xử lý tài liệu…' : 'Kéo thả hoặc chọn file'}</strong>
          <small>PDF, DOCX, MD, TXT, HTML · tối đa 2 MB</small>
        </span>
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
      <div className="ai-source-files" aria-label="Danh sách tài liệu nguồn">
        {sources.length === 0 && <p className="ai-source-none">Chưa có tài liệu nào.</p>}
        {sources.map((source) => (
          <article className={selectedIds.has(source.sourceId) ? 'ai-source-file selected' : 'ai-source-file'} key={source.sourceId}>
            <label>
              <input type="checkbox" checked={selectedIds.has(source.sourceId)} onChange={() => onToggle(source.sourceId)} />
              <span className="ai-source-badge" aria-hidden="true">{sourceBadge(source)}</span>
              <span className="ai-source-name">
                <strong>{source.fileName}</strong>
                <small>{source.kind === 'admin_note' ? 'Ghi chú Admin' : 'Tài liệu'}{source.textLength ? ' · ' + source.textLength.toLocaleString('vi-VN') + ' ký tự' : ''}</small>
              </span>
            </label>
            <button className="button button-ghost button-sm" type="button" aria-label={'Xóa ' + source.fileName} disabled={busy} onClick={() => onDelete(source.sourceId)}>Xóa</button>
          </article>
        ))}
      </div>
      <button className="button button-ghost button-sm ai-note-toggle" type="button" disabled={busy} aria-expanded={noteOpen} onClick={() => setNoteOpen((value) => !value)}>
        <PlusOutlined /> Thêm ghi chú văn bản
      </button>
      {noteOpen && (
        <div className="ai-note-form">
          <label className="ai-field"><span className="ai-label">Tiêu đề ghi chú</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="ai-field"><span className="ai-label">Nội dung</span><textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} /></label>
          <button
            className="button button-secondary button-sm"
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
  );
}
