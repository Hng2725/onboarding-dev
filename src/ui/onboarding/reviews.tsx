import {
  AuditOutlined,
  CheckCircleOutlined,
  CommentOutlined,
  FormOutlined,
  SendOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { FinalConclusion } from '../../onboarding/contracts';
import type { OnboardingApi } from './api';
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, conclusionLabel } from './components';

export interface EssayQueueItem {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly answerId: string;
  readonly questionId: string;
  readonly prompt: string;
  readonly answer: string;
  readonly reviewed: boolean;
  readonly comment?: string;
}

export interface EssayQueueGroup {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly items: readonly EssayQueueItem[];
  readonly reviewedCount: number;
  readonly totalCount: number;
}

export function groupEssayQueue(items: readonly EssayQueueItem[]): readonly EssayQueueGroup[] {
  const grouped = new Map<string, EssayQueueItem[]>();
  for (const item of items) grouped.set(item.assignmentId, [...(grouped.get(item.assignmentId) ?? []), item]);
  return [...grouped.entries()].map(([assignmentId, group]) => ({
    assignmentId,
    attemptId: group[0].attemptId,
    items: group,
    reviewedCount: group.filter((item) => item.reviewed).length,
    totalCount: group.length,
  }));
}

export function applySavedEssayFeedback(
  items: readonly EssayQueueItem[],
  answerId: string,
  comment: string,
): readonly EssayQueueItem[] {
  return items.map((item) => item.answerId === answerId ? { ...item, reviewed: true, comment } : item);
}

export interface EvaluationDraft {
  readonly completionLevel: string;
  readonly strengths: string;
  readonly improvements: string;
  readonly publicComment: string;
  readonly conclusion: FinalConclusion | '';
}

export interface EvaluationIssue { readonly field: keyof EvaluationDraft; readonly message: string }

export function validateEvaluationDraft(draft: EvaluationDraft): readonly EvaluationIssue[] {
  const issues: EvaluationIssue[] = [];
  if (!draft.completionLevel.trim()) issues.push({ field: 'completionLevel', message: 'Nhập mức độ hoàn thành.' });
  if (!draft.strengths.trim()) issues.push({ field: 'strengths', message: 'Nhập điểm mạnh.' });
  if (!draft.improvements.trim()) issues.push({ field: 'improvements', message: 'Nhập nội dung cần cải thiện.' });
  if (!draft.publicComment.trim()) issues.push({ field: 'publicComment', message: 'Nhập nhận xét chung cho nhân sự.' });
  if (!['passed', 'failed', 'retry'].includes(draft.conclusion)) issues.push({ field: 'conclusion', message: 'Chọn kết luận.' });
  return issues;
}

interface EvaluationQueueItem {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly memberId: string;
  readonly templateTitle: string;
}

const emptyEvaluation: EvaluationDraft = {
  completionLevel: '', strengths: '', improvements: '', publicComment: '', conclusion: '',
};

export function EssayFeedbackPage({ api }: { api: OnboardingApi }) {
  const [items, setItems] = useState<readonly EssayQueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await api.reviews<{ items: readonly EssayQueueItem[] }>('list_essays');
      setItems(response.items);
      setSelectedId((current) => current && response.items.some((item) => item.answerId === current) ? current : response.items[0]?.answerId ?? null);
    } catch (caught) { setError(caught instanceof Error ? caught : new Error('Không thể tải câu tự luận.')); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => groupEssayQueue(items), [items]);
  const selected = items.find((item) => item.answerId === selectedId);
  useEffect(() => { setComment(selected?.comment ?? ''); }, [selectedId, selected?.comment]);

  async function save() {
    if (!selected || !comment.trim()) return;
    setSaving(true); setNotice(null);
    try {
      await api.reviews('save_essay_feedback', { attemptId: selected.attemptId, answerId: selected.answerId, comment: comment.trim() });
      setItems((current) => applySavedEssayFeedback(current, selected.answerId, comment.trim()));
      setNotice('Đã lưu nhận xét. Bài sẽ vào hàng đợi đánh giá chung khi mọi câu tự luận đều được nhận xét.');
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Không thể lưu nhận xét.'); }
    finally { setSaving(false); }
  }

  if (loading) return <LoadingState label="Đang tải hàng đợi tự luận…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!items.length) return <EmptyState title="Không có câu tự luận đang chờ" description="Các bài trắc nghiệm hoàn toàn sẽ đi thẳng tới hàng đợi đánh giá chung." icon={<CommentOutlined />} />;

  return <div className="page-stack">
    <section className="page-heading"><div><span className="section-kicker">PHẢN HỒI TỪNG CÂU</span><h2>Nhận xét tự luận</h2><p>Tự luận không có điểm số. Hãy phản hồi cụ thể cho từng câu trước khi đánh giá chung.</p></div><span className="muted-count"><FormOutlined /> {items.filter((item) => !item.reviewed).length} câu đang chờ</span></section>
    {notice && <div className="inline-notice" role="status">{notice}</div>}
    <div className="review-workspace">
      <aside className="review-queue">{groups.map((group) => <section key={group.assignmentId}><header><strong>{group.assignmentId}</strong><span>{group.reviewedCount}/{group.totalCount}</span></header>{group.items.map((item) => <button key={item.answerId} className={item.answerId === selectedId ? 'active' : ''} type="button" onClick={() => setSelectedId(item.answerId)}><span className={item.reviewed ? 'queue-dot done' : 'queue-dot'} /> <span><strong>{item.prompt}</strong><small>{item.reviewed ? 'Đã nhận xét' : 'Đang chờ'}</small></span></button>)}</section>)}</aside>
      {selected && <section className="review-editor"><div className="answer-card"><span className="section-kicker">CÂU HỎI</span><h3>{selected.prompt}</h3><div className="learner-answer"><UserOutlined /><p>{selected.answer}</p></div></div><label className="form-field"><span>Nhận xét dành cho nhân sự</span><textarea rows={7} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Nêu điểm tốt và gợi ý cải thiện…" /></label><div className="editor-actions"><small>Không chấm điểm cho câu tự luận</small><button className="button button-primary" type="button" disabled={saving || !comment.trim()} onClick={() => void save()}><SendOutlined /> {saving ? 'Đang lưu…' : 'Lưu nhận xét'}</button></div></section>}
    </div>
  </div>;
}

export function EvaluationsPage({ api }: { api: OnboardingApi }) {
  const [items, setItems] = useState<readonly EvaluationQueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EvaluationDraft>(emptyEvaluation);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issues, setIssues] = useState<readonly EvaluationIssue[]>([]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await api.reviews<{ items: readonly EvaluationQueueItem[] }>('list_evaluations');
      setItems(response.items); setSelectedId((current) => current && response.items.some((item) => item.attemptId === current) ? current : response.items[0]?.attemptId ?? null);
    } catch (caught) { setError(caught instanceof Error ? caught : new Error('Không thể tải hàng đợi đánh giá.')); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  const selected = items.find((item) => item.attemptId === selectedId);

  function update(patch: Partial<EvaluationDraft>) { setDraft((current) => ({ ...current, ...patch })); setDirty(true); setIssues([]); }
  function choose(attemptId: string) {
    if (dirty && !window.confirm('Bỏ nội dung đánh giá chưa công bố?')) return;
    setSelectedId(attemptId); setDraft(emptyEvaluation); setDirty(false); setIssues([]);
  }
  function requestPublish() {
    const next = validateEvaluationDraft(draft); setIssues(next); if (!next.length) setConfirming(true);
  }
  async function publish() {
    if (!selected || !draft.conclusion) return;
    setPublishing(true); setNotice(null);
    try {
      const response = await api.reviews<{ result: { warning?: string } }>('publish_evaluation', {
        attemptId: selected.attemptId,
        operationId: crypto.randomUUID(),
        ...draft,
      });
      const retry = draft.conclusion === 'retry';
      setNotice(`${retry ? 'Đã mở lượt làm lại mới.' : 'Đã công bố đánh giá.'}${response.result.warning ? ` Lưu ý: ${response.result.warning}` : ''}`);
      setConfirming(false); setDraft(emptyEvaluation); setDirty(false); await load();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Không thể công bố đánh giá.'); setConfirming(false); }
    finally { setPublishing(false); }
  }

  if (loading) return <LoadingState label="Đang tải hàng đợi đánh giá…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!items.length) return <EmptyState title="Không có bài đang chờ đánh giá" description="Bài trắc nghiệm sẽ xuất hiện ngay sau khi nộp; bài có tự luận xuất hiện sau khi đã nhận xét đủ." icon={<AuditOutlined />} />;
  const issue = (field: keyof EvaluationDraft) => issues.find((item) => item.field === field)?.message;

  return <div className="page-stack">
    <section className="page-heading"><div><span className="section-kicker">KẾT LUẬN CUỐI</span><h2>Đánh giá chung</h2><p>Mọi bài đã nộp, kể cả hoàn toàn trắc nghiệm, đều cần Admin đánh giá trước khi có kết luận.</p></div><span className="muted-count"><AuditOutlined /> {items.length} bài sẵn sàng</span></section>
    {notice && <div className="inline-notice" role="status">{notice}</div>}
    <div className="review-workspace evaluation-workspace"><aside className="review-queue">{items.map((item) => <button key={item.attemptId} className={item.attemptId === selectedId ? 'active' : ''} type="button" onClick={() => choose(item.attemptId)}><span className="queue-dot ready" /><span><strong>{item.templateTitle}</strong><small>{item.memberId}</small></span></button>)}</aside>
      {selected && <section className="review-editor evaluation-editor"><div className="evaluation-context"><CheckCircleOutlined /><div><span>Bài đã đủ điều kiện đánh giá</span><strong>{selected.templateTitle}</strong><small>{selected.memberId} · {selected.attemptId}</small></div></div><div className="form-grid"><label className="form-field form-wide"><span>Mức độ hoàn thành</span><input value={draft.completionLevel} onChange={(event) => update({ completionLevel: event.target.value })} placeholder="Ví dụ: Hoàn thành tốt" />{issue('completionLevel') && <small className="field-error">{issue('completionLevel')}</small>}</label><label className="form-field"><span>Điểm mạnh</span><textarea rows={4} value={draft.strengths} onChange={(event) => update({ strengths: event.target.value })} />{issue('strengths') && <small className="field-error">{issue('strengths')}</small>}</label><label className="form-field"><span>Cần cải thiện</span><textarea rows={4} value={draft.improvements} onChange={(event) => update({ improvements: event.target.value })} />{issue('improvements') && <small className="field-error">{issue('improvements')}</small>}</label><label className="form-field form-wide"><span>Nhận xét chung hiển thị cho nhân sự</span><textarea rows={4} value={draft.publicComment} onChange={(event) => update({ publicComment: event.target.value })} />{issue('publicComment') && <small className="field-error">{issue('publicComment')}</small>}</label></div><fieldset className="form-field conclusion-field"><legend>Kết luận</legend><div className="conclusion-grid">{(['passed', 'failed', 'retry'] as const).map((conclusion) => <button key={conclusion} type="button" className={draft.conclusion === conclusion ? `active conclusion-${conclusion}` : ''} onClick={() => update({ conclusion })}>{conclusionLabel(conclusion)}</button>)}</div>{issue('conclusion') && <small className="field-error">{issue('conclusion')}</small>}</fieldset><div className="editor-actions"><small>Đánh giá chỉ hiển thị sau khi công bố</small><button className="button button-primary" type="button" onClick={requestPublish}><SendOutlined /> Công bố đánh giá</button></div></section>}
    </div>
    <ConfirmDialog open={confirming} title={`Công bố kết luận “${draft.conclusion ? conclusionLabel(draft.conclusion) : ''}”?`} description={draft.conclusion === 'retry' ? 'Nhân sự sẽ nhận thêm một lượt làm bài mới; bài cũ vẫn được giữ nguyên.' : 'Nhân sự sẽ nhìn thấy nhận xét chung và kết luận này.'} confirmLabel={publishing ? 'Đang công bố…' : 'Công bố'} onCancel={() => !publishing && setConfirming(false)} onConfirm={() => void publish()} />
  </div>;
}
