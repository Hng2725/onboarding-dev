import {
  CheckCircleFilled,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  InboxOutlined,
  LockOutlined,
  PlusOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import type { ReactNode, ReactPortal } from 'react';
import { createPortal } from 'react-dom';

import type { EmployeeType, QuestionType, TemplateStatus } from '../../onboarding/contracts';
import type { AdminTemplateDetail, TemplateQuestionInput } from '../../onboarding/templates';

export interface TemplateCatalogView {
  readonly id: string;
  readonly version: number;
  readonly source: 'system' | 'custom';
  readonly status: TemplateStatus;
  readonly employeeType: EmployeeType;
  readonly title: string;
  readonly description: string;
  readonly locked: boolean;
  readonly updatedAt: string;
}

export interface TemplateDetailCacheEntry {
  readonly detail: AdminTemplateDetail | null;
  readonly error: string | null;
}

function normalizeTemplateSearchText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('vi')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd');
}

export function filterTemplatesByName(
  items: readonly TemplateCatalogView[],
  query: string,
): readonly TemplateCatalogView[] {
  const needle = normalizeTemplateSearchText(query);
  if (!needle) return items;
  return items.filter((item) => normalizeTemplateSearchText(item.title).includes(needle));
}

export function insertQuestionAfter(
  questions: readonly TemplateQuestionInput[],
  index: number,
  question: TemplateQuestionInput,
): readonly TemplateQuestionInput[] {
  const insertionIndex = Math.min(Math.max(index + 1, 0), questions.length);
  return [...questions.slice(0, insertionIndex), question, ...questions.slice(insertionIndex)];
}

export function templateDetailCacheKey(
  item: Pick<TemplateCatalogView, 'id' | 'version' | 'updatedAt'>,
): string {
  return `${item.id}@${item.version}@${item.updatedAt}`;
}

export async function preloadTemplateDetails(
  items: readonly TemplateCatalogView[],
  existing: ReadonlyMap<string, TemplateDetailCacheEntry>,
  loadDetail: (item: TemplateCatalogView) => Promise<AdminTemplateDetail>,
): Promise<Map<string, TemplateDetailCacheEntry>> {
  const next = new Map(existing);
  await Promise.all(items.map(async (item) => {
    const key = templateDetailCacheKey(item);
    if (next.has(key)) return;
    try {
      next.set(key, { detail: await loadDetail(item), error: null });
    } catch (caught) {
      next.set(key, {
        detail: null,
        error: caught instanceof Error ? caught.message : 'Không thể tải chi tiết template.',
      });
    }
  }));
  return next;
}

export type TemplateDetailAction = 'use' | 'clone' | 'edit' | 'delete' | 'archive';

export function templateDetailActions(template: Pick<TemplateCatalogView, 'source' | 'status'>): readonly TemplateDetailAction[] {
  if (template.source === 'system') return ['use', 'clone'];
  if (template.status === 'draft') return ['edit', 'delete'];
  if (template.status === 'published') return ['use', 'edit', 'archive'];
  return [];
}

function statusLabel(status: TemplateStatus): string {
  return status === 'published' ? 'Đã xuất bản' : status === 'draft' ? 'Bản nháp' : 'Đã lưu trữ';
}

export function TemplateCard({ item, onOpen }: { item: TemplateCatalogView; onOpen: () => void }) {
  return (
    <article className="template-card">
      <button className="template-card-open" type="button" onClick={onOpen} aria-label={`Xem chi tiết ${item.title}`}>
        <span className="template-card-head">
          <span className={`template-source source-${item.source}`}>
            {item.source === 'system' ? <><LockOutlined /> Hệ thống</> : 'Tùy chỉnh'}
          </span>
          <span className={`template-status template-${item.status}`}>{statusLabel(item.status)}</span>
        </span>
        <span className="template-icon"><FileTextOutlined /></span>
        <strong className="template-title">{item.title}</strong>
        <span className="template-description">{item.description}</span>
        <span className="template-meta">
          <span>{item.employeeType === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}</span>
          <span>Phiên bản {item.version}</span>
        </span>
        <span className="template-view-action"><EyeOutlined /> Xem chi tiết</span>
      </button>
    </article>
  );
}

function actionLabel(action: TemplateDetailAction): string {
  return ({ use: 'Sử dụng', clone: 'Clone', edit: 'Chỉnh sửa', archive: 'Lưu trữ', delete: 'Xóa' } as const)[action];
}

function actionIcon(action: TemplateDetailAction): ReactNode {
  return ({
    use: <RocketOutlined />, clone: <CopyOutlined />, edit: <EditOutlined />,
    archive: <InboxOutlined />, delete: <DeleteOutlined />,
  } as const)[action];
}

export function TemplateDetailPanel({
  detail,
  loading,
  error,
  onClose,
  onRetry,
  onAction,
}: {
  detail: AdminTemplateDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  onAction: (action: TemplateDetailAction) => void;
}) {
  return (
    <section className="template-detail-panel" role="dialog" aria-modal="true" aria-labelledby="template-detail-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="template-detail-header">
        <div>
          <span className="section-kicker">CHI TIẾT TEMPLATE</span>
          <h2 id="template-detail-title">{detail?.title ?? 'Đang tải template…'}</h2>
        </div>
        <button className="icon-button" type="button" aria-label="Đóng" onClick={onClose}><CloseOutlined /></button>
      </header>

      <div className="template-detail-body">
        {loading && <div className="template-detail-state"><span className="loading-dot" /> Đang tải nội dung…</div>}
        {!loading && error && <div className="template-detail-state template-detail-error"><p>{error}</p><button className="button button-secondary" type="button" onClick={onRetry}>Thử lại</button></div>}
        {!loading && !error && detail && <>
          <div className="template-detail-summary">
            <div className="template-detail-badges">
              <span className={`template-source source-${detail.source}`}>{detail.source === 'system' ? <><LockOutlined /> Hệ thống</> : 'Tùy chỉnh'}</span>
              <span className={`template-status template-${detail.status}`}>{statusLabel(detail.status)}</span>
            </div>
            <p>{detail.description || 'Chưa có mô tả.'}</p>
            {detail.source === 'system' && <small>Template hệ thống được khóa để bảo toàn nội dung gốc. Bạn có thể clone thành bản tùy chỉnh.</small>}
          </div>
          <dl className="template-detail-stats">
            <div><dt>Phân loại</dt><dd>{detail.employeeType === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}</dd></div>
            <div><dt>Phiên bản</dt><dd>{detail.version}</dd></div>
            <div><dt>Module</dt><dd>{detail.modules.length}</dd></div>
            <div><dt>Lượt làm tối đa</dt><dd>{detail.maxAttempts}</dd></div>
          </dl>
          <div className="template-detail-modules">
            {detail.modules.map((module, moduleIndex) => <article key={module.id} className="template-detail-module">
              <header><span>{moduleIndex + 1}</span><div><h3>{module.title}</h3><p>{module.description}</p></div></header>
              <div className="template-detail-columns">
                <section><h4>Tài liệu ({module.resources.length})</h4>{module.resources.map((resource) => <div className="detail-list-row" key={resource.id}><FileTextOutlined /><span>{resource.title}</span></div>)}</section>
                <section><h4>Câu hỏi ({module.questions.length})</h4>{module.questions.map((question) => <div className="detail-question" key={question.id}><strong>{question.prompt}</strong><span>{question.type === 'essay' ? 'Tự luận' : question.type === 'single_choice' ? 'Một đáp án' : 'Nhiều đáp án'}</span>{question.type !== 'essay' && <ul>{question.options?.map((option) => <li key={option.id} className={question.correctOptionIds?.includes(option.id) ? 'correct' : ''}>{question.correctOptionIds?.includes(option.id) && <CheckCircleFilled />} {option.label}</li>)}</ul>}</div>)}</section>
              </div>
            </article>)}
          </div>
        </>}
      </div>

      {!loading && !error && detail && <footer className="template-detail-footer">
        <button className="button button-secondary" type="button" onClick={onClose}>Đóng</button>
        <div>{templateDetailActions(detail).map((action) => <button key={action} className={action === 'use' || action === 'edit' ? 'button button-primary' : 'button button-secondary'} type="button" onClick={() => onAction(action)}>{actionIcon(action)} {actionLabel(action)}</button>)}</div>
      </footer>}
    </section>
  );
}

export function updateCorrectOptionIds(
  type: 'single_choice' | 'multiple_choice',
  current: readonly string[],
  optionId: string,
): readonly string[] {
  if (type === 'single_choice') return [optionId];
  return current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId];
}

function nextOptionId(options: TemplateQuestionInput['options']): string {
  const used = new Set((options ?? []).map((option) => option.id));
  let sequence = used.size + 1;
  while (used.has(`option-${sequence}`)) sequence += 1;
  return `option-${sequence}`;
}

export function newQuestion(type: QuestionType = 'single_choice'): TemplateQuestionInput {
  if (type === 'essay') return { type, prompt: '', required: true };
  return {
    type,
    prompt: '',
    required: true,
    options: [{ id: 'option-1', label: '' }, { id: 'option-2', label: '' }],
    correctOptionIds: ['option-1'],
  };
}

function changeQuestionType(question: TemplateQuestionInput, type: QuestionType): TemplateQuestionInput {
  if (type === 'essay') return { id: question.id, type, prompt: question.prompt, required: question.required, explanation: question.explanation };
  const options = question.options?.length ? question.options : newQuestion(type).options;
  const validIds = new Set((options ?? []).map((option) => option.id));
  const retained = (question.correctOptionIds ?? []).filter((id) => validIds.has(id));
  const correctOptionIds = type === 'single_choice'
    ? [retained[0] ?? options?.[0]?.id].filter((id): id is string => Boolean(id))
    : retained.length ? retained : [options?.[0]?.id].filter((id): id is string => Boolean(id));
  return { ...question, type, options, correctOptionIds };
}

export function QuestionEditor({
  question,
  questionKey,
  questionNumber,
  onChange,
  onRemove,
}: {
  question: TemplateQuestionInput;
  questionKey?: string;
  questionNumber?: number;
  onChange: (next: TemplateQuestionInput) => void;
  onRemove: () => void;
}) {
  const options = question.options ?? [];
  const choiceType = question.type === 'single_choice' || question.type === 'multiple_choice' ? question.type : null;
  const inputName = `correct-answer-${questionKey ?? question.id ?? 'question'}`;

  return (
    <article className="question-editor">
      {questionNumber !== undefined && <strong className="question-sequence-label">Câu {questionNumber}</strong>}
      <div className="question-editor-head">
        <label className="form-field"><span>Loại câu hỏi</span><select value={question.type} onChange={(event) => onChange(changeQuestionType(question, event.target.value as QuestionType))}><option value="single_choice">Một đáp án</option><option value="multiple_choice">Nhiều đáp án</option><option value="essay">Tự luận</option></select></label>
        <button className="icon-button question-remove" type="button" aria-label="Xóa câu hỏi" onClick={onRemove}><DeleteOutlined /></button>
      </div>
      <label className="form-field"><span>Nội dung câu hỏi</span><textarea rows={2} value={question.prompt} onChange={(event) => onChange({ ...question, prompt: event.target.value })} placeholder="Nhập nội dung câu hỏi" /></label>
      {choiceType && <div className="answer-editor">
        <div className="answer-editor-heading"><div><strong>Các đáp án</strong><small>{choiceType === 'single_choice' ? 'Chọn đúng một đáp án đúng' : 'Có thể chọn nhiều đáp án đúng'}</small></div><button className="text-button" type="button" onClick={() => onChange({ ...question, options: [...options, { id: nextOptionId(options), label: '' }] })}><PlusOutlined /> Thêm đáp án</button></div>
        {options.map((option, optionIndex) => <div className="answer-row" key={option.id}>
          <label className="answer-correct" title="Đánh dấu đáp án đúng"><input name={inputName} type={choiceType === 'single_choice' ? 'radio' : 'checkbox'} checked={(question.correctOptionIds ?? []).includes(option.id)} onChange={() => onChange({ ...question, correctOptionIds: updateCorrectOptionIds(choiceType, question.correctOptionIds ?? [], option.id) })} /><span /></label>
          <input value={option.label} aria-label={`Đáp án ${optionIndex + 1}`} placeholder={`Đáp án ${optionIndex + 1}`} onChange={(event) => onChange({ ...question, options: options.map((item) => item.id === option.id ? { ...item, label: event.target.value } : item) })} />
          <button className="icon-button answer-remove" type="button" aria-label={`Xóa đáp án ${optionIndex + 1}`} disabled={options.length <= 2} onClick={() => onChange({ ...question, options: options.filter((item) => item.id !== option.id), correctOptionIds: (question.correctOptionIds ?? []).filter((id) => id !== option.id) })}><CloseOutlined /></button>
        </div>)}
        <label className="form-field"><span>Giải thích sau khi nộp <small>(không bắt buộc)</small></span><textarea rows={2} value={question.explanation ?? ''} onChange={(event) => onChange({ ...question, explanation: event.target.value })} placeholder="Giải thích vì sao đáp án đúng" /></label>
      </div>}
    </article>
  );
}

export interface TemplateEditorUiState {
  readonly open: boolean;
  readonly dirty: boolean;
  readonly confirmDiscard: boolean;
}

export type TemplateEditorEvent = 'request_close' | 'cancel_discard' | 'confirm_discard' | 'save_succeeded';

export function templateEditorTransition(state: TemplateEditorUiState, event: TemplateEditorEvent): TemplateEditorUiState {
  if (event === 'request_close') return state.dirty ? { ...state, confirmDiscard: true } : { open: false, dirty: false, confirmDiscard: false };
  if (event === 'cancel_discard') return { ...state, confirmDiscard: false };
  if (event === 'confirm_discard' || event === 'save_succeeded') return { open: false, dirty: false, confirmDiscard: false };
  return state;
}

export function TemplateModalLayer({ children, target }: { children: ReactNode; target?: Element }): ReactPortal | null {
  const container = target ?? (typeof document === 'undefined' ? null : document.body);
  return container ? createPortal(children, container) : null;
}
