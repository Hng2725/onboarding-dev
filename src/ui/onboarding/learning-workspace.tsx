import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckCircleFilled,
  CheckOutlined,
  DownloadOutlined,
  FileTextOutlined,
  LinkOutlined,
  LockOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import type {
  AnswerRecord,
  AssignmentRecord,
  AttemptRecord,
  LearnerAssignmentDto,
  LearnerQuestionDto,
  TemplateResource,
} from '../../onboarding/contracts';
import type { MaterialProgressRecord } from '../../onboarding/assignments';
import { reconcileDraft, type OnboardingApi, type RecoveryDraft } from './api';
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, ProgressBar } from './components';

export interface DraftAnswer {
  readonly questionId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly essayText?: string;
}

export function isExerciseUnlocked(
  resources: readonly Pick<TemplateResource, 'id' | 'required'>[],
  progress: readonly Pick<MaterialProgressRecord, 'resourceId' | 'openedAt' | 'completedAt'>[],
): boolean {
  const byId = new Map(progress.map((item) => [item.resourceId, item]));
  return resources.filter((resource) => resource.required).every((resource) => {
    const state = byId.get(resource.id);
    return Boolean(state?.openedAt && state.completedAt);
  });
}

export function resourceViewState(
  progress: Pick<MaterialProgressRecord, 'resourceId' | 'openedAt' | 'completedAt'> | undefined,
  error?: Error | null,
) {
  return {
    completed: Boolean(progress?.completedAt),
    opened: Boolean(progress?.openedAt),
    ...(error ? { recoverableError: error.message, canRetry: true as const } : {}),
  };
}

export function validateRequiredAnswers(
  questions: readonly Pick<LearnerQuestionDto, 'id' | 'type' | 'required'>[],
  answers: readonly DraftAnswer[],
): readonly string[] {
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  return questions.filter((question) => question.required).filter((question) => {
    const answer = byQuestion.get(question.id);
    return question.type === 'essay' ? !answer?.essayText?.trim() : !answer?.selectedOptionIds?.length;
  }).map((question) => question.id);
}

export interface SubmissionOperation {
  readonly operationId: string;
  readonly payloadKey: string;
}

function answerPayloadKey(answers: readonly DraftAnswer[]): string {
  return JSON.stringify([...answers].map((answer) => ({
    questionId: answer.questionId,
    selectedOptionIds: [...(answer.selectedOptionIds ?? [])].sort(),
    essayText: answer.essayText?.trim() ?? '',
  })).sort((left, right) => left.questionId.localeCompare(right.questionId)));
}

export function nextSubmissionOperation(
  previous: SubmissionOperation | null,
  answers: readonly DraftAnswer[],
  createId: () => string = () => crypto.randomUUID(),
): SubmissionOperation {
  const payloadKey = answerPayloadKey(answers);
  return previous?.payloadKey === payloadKey ? previous : { operationId: createId(), payloadKey };
}

export function buildSubmission(assignmentId: string, operationId: string) {
  return { assignmentId, operationId } as const;
}

interface LearnerDetail {
  readonly assignment: AssignmentRecord;
  readonly template: {
    readonly title: string;
    readonly description: string;
    readonly modules: readonly {
      readonly id: string;
      readonly key: string;
      readonly title: string;
      readonly description: string;
      readonly order: number;
      readonly resources: readonly TemplateResource[];
      readonly questions: readonly LearnerQuestionDto[];
    }[];
  };
  readonly progress: readonly MaterialProgressRecord[];
  readonly moduleUnlocks: Readonly<Record<string, boolean>>;
}

interface RoomFile {
  readonly _id: string;
  readonly name?: string;
  readonly type?: string;
  readonly downloadUrl?: string;
}

interface ResourcePreview {
  readonly resource: TemplateResource;
  readonly file?: RoomFile;
  readonly text?: string;
}

function fileKind(file: RoomFile): 'image' | 'pdf' | 'text' | 'other' {
  const type = file.type ?? '';
  const extension = (file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (type.startsWith('text/') || ['txt', 'md', 'json', 'csv', 'yaml', 'yml'].includes(extension)) return 'text';
  return 'other';
}

function previewBody(preview: ResourcePreview) {
  if (preview.resource.sourceUrl) return <div className="external-resource"><LinkOutlined /><h3>{preview.resource.title}</h3><p>{preview.resource.description || 'Tài liệu liên kết của chương trình.'}</p><a className="button button-primary" href={preview.resource.sourceUrl} target="_blank" rel="noreferrer">Mở tài liệu <ArrowRightOutlined /></a></div>;
  if (!preview.file) return null;
  const kind = fileKind(preview.file);
  if (kind === 'image' && preview.file.downloadUrl) return <img className="learning-image" src={preview.file.downloadUrl} alt={preview.file.name || preview.resource.title} />;
  if (kind === 'pdf' && preview.file.downloadUrl) return <iframe className="learning-frame" src={preview.file.downloadUrl} title={preview.file.name || preview.resource.title} />;
  if (kind === 'text') return <pre className="learning-text">{preview.text}</pre>;
  return <div className="external-resource"><DownloadOutlined /><h3>{preview.file.name || preview.resource.title}</h3>{preview.file.downloadUrl && <a className="button button-primary" href={preview.file.downloadUrl} target="_blank" rel="noreferrer">Tải xuống</a>}</div>;
}

export function LearningWorkspace({ api, assignmentId, onBack, onSubmitted }: { api: OnboardingApi; assignmentId?: string | null; onBack: () => void; onSubmitted: () => void }) {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const [resolvedId, setResolvedId] = useState<string | null>(assignmentId ?? null);
  const [detail, setDetail] = useState<LearnerDetail | null>(null);
  const [moduleIndex, setModuleIndex] = useState(0);
  const [preview, setPreview] = useState<ResourcePreview | null>(null);
  const [previewError, setPreviewError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [busyResource, setBusyResource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<AttemptRecord | null>(null);
  const [answers, setAnswers] = useState<readonly DraftAnswer[]>([]);
  const [syncLabel, setSyncLabel] = useState('Chưa có thay đổi');
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submission, setSubmission] = useState<SubmissionOperation | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      let id = assignmentId ?? resolvedId;
      if (!id) {
        const list = await api.learning<{ assignments: readonly LearnerAssignmentDto[] }>('list');
        id = list.assignments.find((item) => !['passed', 'failed'].includes(item.status))?.id ?? list.assignments[0]?.id;
      }
      if (!id) { setResolvedId(null); setDetail(null); return; }
      setResolvedId(id);
      const response = await api.learning<{ detail: LearnerDetail }>('get', { assignmentId: id });
      setDetail(response.detail);
    } catch (caught) { setError(caught instanceof Error ? caught : new Error('Không thể tải nội dung học.')); }
    finally { setLoading(false); }
  }, [api, assignmentId, resolvedId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const allQuestions = useMemo(() => detail?.template.modules.flatMap((module) => module.questions) ?? [], [detail]);
  const allUnlocked = detail ? Object.values(detail.moduleUnlocks).every(Boolean) : false;
  const module = detail?.template.modules[Math.min(moduleIndex, Math.max(0, detail.template.modules.length - 1))];
  const completedRequired = detail ? detail.template.modules.flatMap((item) => item.resources.filter((resource) => resource.required)).filter((resource) => detail.progress.some((entry) => entry.resourceId === resource.id && entry.completedAt)).length : 0;
  const requiredCount = detail?.template.modules.reduce((sum, item) => sum + item.resources.filter((resource) => resource.required).length, 0) ?? 0;

  async function openResource(resource: TemplateResource) {
    if (!detail || !resolvedId) return;
    setBusyResource(resource.id); setPreviewError(null);
    try {
      let next: ResourcePreview = { resource };
      if (resource.fileId) {
        // `files:read` authorizes the current-room file list and preview calls.
        const response = await app.rest({ method: 'GET', path: `file-management.files.channel/${roomId}` });
        if (response.statusCode >= 400) throw new Error(`Không thể đọc file (${response.statusCode}).`);
        const body = response.body as { files?: RoomFile[]; data?: RoomFile[] } | RoomFile[];
        const files = Array.isArray(body) ? body : body.files ?? body.data ?? [];
        const file = files.find((item) => item._id === resource.fileId);
        if (!file) throw new Error('File đã bị xóa hoặc bạn không còn quyền truy cập.');
        if (fileKind(file) === 'text') {
          const content = await app.rest({ method: 'GET', path: `file-management.files/${file._id}/content/${encodeURIComponent(file.name ?? '')}` });
          if (content.statusCode >= 400) throw new Error(`Không thể mở nội dung file (${content.statusCode}).`);
          const value = content.body as { result?: unknown };
          next = { resource, file, text: typeof value?.result === 'string' ? value.result : JSON.stringify(content.body, null, 2) };
        } else next = { resource, file };
      }
      setPreview(next);
      await api.learning('open_resource', { assignmentId: resolvedId, resourceId: resource.id });
      await load();
    } catch (caught) {
      setPreview({ resource });
      setPreviewError(caught instanceof Error ? caught : new Error('Không thể mở tài liệu.'));
    } finally { setBusyResource(null); }
  }

  async function completeResource(resource: TemplateResource) {
    if (!resolvedId) return;
    setBusyResource(resource.id);
    try { await api.learning('complete_resource', { assignmentId: resolvedId, resourceId: resource.id }); await load(); }
    catch (caught) { setPreviewError(caught instanceof Error ? caught : new Error('Không thể xác nhận tài liệu.')); }
    finally { setBusyResource(null); }
  }

  async function startExercise() {
    if (!resolvedId) return;
    try {
      const response = await api.learning<{ attempt: AttemptRecord }>('start_attempt', { assignmentId: resolvedId });
      const [local, server] = await Promise.all([
        api.readRecoveryDraft(resolvedId),
        api.learning<{ result: { answers: readonly AnswerRecord[] } }>('get_result', { attemptId: response.attempt.id }),
      ]);
      const serverDraft: RecoveryDraft = {
        revision: Date.parse(response.attempt.updatedAt) || 0,
        assignmentId: resolvedId,
        attemptId: response.attempt.id,
        answers: server.result.answers,
        savedAt: response.attempt.updatedAt,
      };
      const decision = reconcileDraft(serverDraft, local);
      const useLocal = Boolean(local?.answers) && (decision === 'local'
        || (decision === 'confirm' && window.confirm('Bản nháp trên thiết bị mới hơn bản trên PrivOS. Bạn có muốn khôi phục?')));
      const recovered = useLocal ? local?.answers : server.result.answers;
      setAnswers((recovered ?? []) as readonly DraftAnswer[]);
      setAttempt(response.attempt); setModuleIndex(detail?.template.modules.length ?? 0); setSyncLabel('Bài nháp đã sẵn sàng');
    } catch (caught) { setError(caught instanceof Error ? caught : new Error('Không thể bắt đầu bài tập.')); }
  }

  function updateAnswer(next: DraftAnswer) {
    if (!resolvedId) return;
    const updated = [...answers.filter((answer) => answer.questionId !== next.questionId), next];
    setAnswers(updated); setSyncLabel('Đang lưu trên thiết bị…');
    const recovery: RecoveryDraft = { revision: Date.now(), assignmentId: resolvedId, attemptId: attempt?.id, answers: updated, savedAt: new Date().toISOString() };
    void api.saveRecoveryDraft(resolvedId, recovery).then(() => setSyncLabel('Đã lưu trên thiết bị'));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (attempt) {
      saveTimer.current = setTimeout(() => {
        setSyncLabel('Đang đồng bộ…');
        void api.learning('save_draft', { assignmentId: resolvedId, attemptId: attempt.id, answers: updated })
          .then(() => setSyncLabel('Đã đồng bộ với PrivOS'))
          .catch(() => setSyncLabel('Đã lưu cục bộ · Chưa đồng bộ'));
      }, 500);
    }
  }

  function requestSubmit() {
    const missing = validateRequiredAnswers(allQuestions, answers);
    if (missing.length) { setSyncLabel(`Còn ${missing.length} câu bắt buộc chưa trả lời`); return; }
    setSubmission((current) => nextSubmissionOperation(current, answers)); setConfirmSubmit(true);
  }

  async function submit() {
    if (!resolvedId || !submission) return;
    try {
      if (attempt) await api.learning('save_draft', { assignmentId: resolvedId, attemptId: attempt.id, answers });
      await api.learning('submit', buildSubmission(resolvedId, submission.operationId));
      await api.clearRecoveryDraft(resolvedId); setConfirmSubmit(false); onSubmitted();
    } catch (caught) { setSyncLabel(caught instanceof Error ? caught.message : 'Không thể nộp bài.'); setConfirmSubmit(false); }
  }

  if (loading) return <LoadingState label="Đang tải nội dung học…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!detail || !module) return <EmptyState title="Không có nội dung học" description="Bạn chưa có chương trình onboarding để mở." icon={<FileTextOutlined />} />;
  const progressById = new Map(detail.progress.map((item) => [item.resourceId, item]));
  const exerciseSelected = moduleIndex >= detail.template.modules.length;

  return <div className="learning-layout">
    <aside className="learning-sidebar"><button className="learning-back" type="button" onClick={onBack}><ArrowLeftOutlined /> Lộ trình của tôi</button><h2>{detail.template.title}</h2><ProgressBar value={requiredCount ? completedRequired / requiredCount * 100 : 100} label="Tài liệu bắt buộc" /><ol>{detail.template.modules.map((item, index) => { const unlocked = detail.moduleUnlocks[item.id]; return <li key={item.id}><button type="button" className={moduleIndex === index ? 'active' : ''} onClick={() => setModuleIndex(index)}><span>{unlocked ? <CheckOutlined /> : index + 1}</span><div><strong>{item.title}</strong><small>{unlocked ? 'Đã mở bài tập' : 'Đang học tài liệu'}</small></div></button></li>; })}<li><button type="button" className={exerciseSelected ? 'active' : ''} disabled={!allUnlocked} onClick={() => void startExercise()}><span>{allUnlocked ? <PlayCircleOutlined /> : <LockOutlined />}</span><div><strong>Bài tập tổng hợp</strong><small>{allUnlocked ? 'Sẵn sàng' : 'Hoàn thành tài liệu trước'}</small></div></button></li></ol></aside>
    <section className="learning-main">{!exerciseSelected ? <><div className="learning-heading"><span className="section-kicker">MODULE {module.order}</span><h1>{module.title}</h1><p>{module.description}</p></div><div className="resource-cards">{module.resources.map((resource) => { const state = resourceViewState(progressById.get(resource.id), preview?.resource.id === resource.id ? previewError : null); return <article key={resource.id} className={state.completed ? 'resource-card completed' : 'resource-card'}><div className="resource-icon">{resource.kind === 'link' ? <LinkOutlined /> : <FileTextOutlined />}</div><div><div className="resource-title"><h3>{resource.title}</h3>{resource.required && <span>Bắt buộc</span>}</div><p>{resource.description || 'Tài liệu thuộc chương trình onboarding.'}</p>{state.recoverableError && <div className="resource-error">{state.recoverableError} <button type="button" onClick={() => void openResource(resource)}><ReloadOutlined /> Thử lại</button></div>}<div className="resource-actions"><button className="button button-secondary" type="button" disabled={busyResource === resource.id} onClick={() => void openResource(resource)}>{state.opened ? 'Mở lại' : 'Mở tài liệu'}</button><button className="button button-primary" type="button" disabled={!state.opened || state.completed || busyResource === resource.id} onClick={() => void completeResource(resource)}>{state.completed ? <><CheckCircleFilled /> Đã hoàn thành</> : 'Xác nhận đã đọc'}</button></div></div></article>; })}</div>{preview && <div className="resource-viewer"><header><strong>{preview.resource.title}</strong><button className="icon-button" type="button" aria-label="Đóng tài liệu" onClick={() => setPreview(null)}>×</button></header><div>{previewError ? <div className="viewer-error"><ReloadOutlined /><p>{previewError.message}</p><button className="button button-secondary" type="button" onClick={() => void openResource(preview.resource)}>Thử lại</button></div> : previewBody(preview)}</div></div>}<div className="module-next"><button className="button button-primary" type="button" disabled={!detail.moduleUnlocks[module.id]} onClick={() => setModuleIndex((current) => Math.min(current + 1, detail.template.modules.length))}>Tiếp tục <ArrowRightOutlined /></button></div></> : <div className="exercise-panel"><div className="learning-heading"><span className="section-kicker">BÀI TẬP TỔNG HỢP</span><h1>Kiểm tra kiến thức</h1><p>Trả lời đầy đủ trước khi nộp. Trắc nghiệm được chấm tự động; tự luận sẽ được Admin nhận xét.</p></div>{!attempt ? <button className="button button-primary" type="button" onClick={() => void startExercise()}><PlayCircleOutlined /> Bắt đầu làm bài</button> : <><div className="question-list">{allQuestions.map((question, index) => { const answer = answers.find((item) => item.questionId === question.id); return <article className="question-card" key={question.id}><span className="question-number">{index + 1}</span><div><div className="question-title"><h3>{question.prompt}</h3><span>{question.type === 'essay' ? 'Tự luận' : 'Trắc nghiệm'}</span></div>{question.type === 'essay' ? <textarea rows={5} value={answer?.essayText ?? ''} onChange={(event) => updateAnswer({ questionId: question.id, essayText: event.target.value })} placeholder="Nhập câu trả lời của bạn…" /> : <div className="option-list">{question.options?.map((option) => { const selected = answer?.selectedOptionIds?.includes(option.id) ?? false; return <label key={option.id} className={selected ? 'selected' : ''}><input type={question.type === 'single_choice' ? 'radio' : 'checkbox'} name={question.id} checked={selected} onChange={() => { const existing = answer?.selectedOptionIds ?? []; const selectedOptionIds = question.type === 'single_choice' ? [option.id] : selected ? existing.filter((id) => id !== option.id) : [...existing, option.id]; updateAnswer({ questionId: question.id, selectedOptionIds }); }} /><span>{option.label}</span></label>; })}</div>}</div></article>; })}</div><div className="submit-bar"><span><SaveOutlined /> {syncLabel}</span><button className="button button-primary" type="button" onClick={requestSubmit}><SendOutlined /> Nộp bài</button></div></>}</div>}
    </section>
    <ConfirmDialog open={confirmSubmit} title="Nộp bài onboarding?" description="Sau khi nộp, bạn không thể chỉnh sửa câu trả lời của lượt này. Kết quả cuối cùng sẽ có sau khi Admin đánh giá." confirmLabel="Nộp bài" onCancel={() => setConfirmSubmit(false)} onConfirm={() => void submit()} />
  </div>;
}
