import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckCircleFilled,
  CheckOutlined,
  CloseCircleFilled,
  FileTextOutlined,
  LockOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivosContext } from '@privos_ai/app-react';

import type {
  AssignmentRecord,
  LearnerTemplateDto,
  ModuleLearningStatus,
  ModuleQuizResultDto,
  ModuleQuizStartDto,
  ModuleStateDto,
  SourceRef,
  TemplateResource,
} from '../../onboarding/contracts';
import type { OnboardingApi } from './api';
import { ConfirmDialog, ErrorState, LoadingState, ProgressBar } from './components';
import { LessonMarkdown } from './ai/lesson-markdown';
import { InlineRoomfileViewer } from './inline-roomfile-viewer';

export interface ModuleLearnerDetail {
  readonly assignment: AssignmentRecord;
  readonly template: LearnerTemplateDto;
  readonly moduleStates?: readonly ModuleStateDto[];
}

export function moduleStatusLabel(status: ModuleLearningStatus): string {
  const labels: Record<ModuleLearningStatus, string> = {
    locked: 'Đang khóa',
    available: 'Sẵn sàng',
    learning: 'Đang học',
    quiz_ready: 'Sẵn sàng làm bài',
    quiz_failed: 'Chưa đạt',
    needs_support: 'Cần hỗ trợ',
    passed: 'Đã hoàn thành',
  };
  return labels[status];
}

export function remainingAttemptsLabel(state: Pick<ModuleStateDto, 'status' | 'attemptsUsed' | 'attemptsAllowed'>): string {
  if (state.attemptsAllowed === null) return 'Không giới hạn lượt';
  const remaining = Math.max(0, state.attemptsAllowed - state.attemptsUsed);
  if (remaining === 0 || state.status === 'needs_support') return 'Đã hết lượt';
  return 'Còn ' + remaining + ' lượt';
}

export function moduleProgressPercent(states: readonly ModuleStateDto[]): number {
  if (states.length === 0) return 0;
  const earned = states.reduce((sum, state) => {
    const lessonDone = ['quiz_ready', 'quiz_failed', 'needs_support', 'passed'].includes(state.status);
    return sum + (lessonDone ? 0.5 : 0) + (state.status === 'passed' ? 0.5 : 0);
  }, 0);
  return Math.round(earned / states.length * 100);
}

export function generatedLessonResource(
  resources: readonly TemplateResource[],
): TemplateResource | undefined {
  return resources.find((resource) => resource.kind === 'file'
    && resource.required
    && Boolean(resource.fileId?.trim())
    && resource.id.startsWith('ai-lesson-pdf-'));
}

export function canCompleteLesson({
  hasGeneratedPdf,
  pdfOpened,
  summarySeen,
}: {
  hasGeneratedPdf: boolean;
  pdfOpened: boolean;
  summarySeen: boolean;
}): boolean {
  return summarySeen || (hasGeneratedPdf && pdfOpened);
}

function statusIcon(status: ModuleLearningStatus) {
  if (status === 'locked') return <LockOutlined />;
  if (status === 'passed') return <CheckOutlined />;
  if (status === 'needs_support') return <SafetyCertificateOutlined />;
  return <span />;
}

function SourceQuote({ sourceRef }: { sourceRef: SourceRef }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="module-source-quote">
      <button type="button" onClick={() => setOpen((value) => !value)}>
        <FileTextOutlined /> Nguồn{sourceRef.page ? ' · trang ' + sourceRef.page : ''}
      </button>
      {open && <blockquote>{sourceRef.quote}</blockquote>}
    </div>
  );
}

export function ModuleLearning({
  api,
  assignmentId,
  detail,
  onBack,
}: {
  api: OnboardingApi;
  assignmentId: string;
  detail: ModuleLearnerDetail;
  onBack: () => void;
}) {
  const { roomId } = usePrivosContext();
  const [states, setStates] = useState<readonly ModuleStateDto[]>(detail.moduleStates ?? []);
  const [selectedModuleId, setSelectedModuleId] = useState(
    detail.moduleStates?.find((state) => state.status !== 'locked' && state.status !== 'passed')?.moduleId
      ?? detail.template.modules[0]?.id
      ?? '',
  );
  const [view, setView] = useState<'modules' | 'lesson' | 'quiz' | 'result'>('modules');
  const [attempt, setAttempt] = useState<ModuleQuizStartDto | null>(null);
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const [result, setResult] = useState<ModuleQuizResultDto | null>(null);
  const [summarySeen, setSummarySeen] = useState(false);
  const [lessonPane, setLessonPane] = useState<'pdf' | 'readable'>('readable');
  const [pdfOpened, setPdfOpened] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(states.length === 0);
  const [error, setError] = useState<Error | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const operationRef = useRef<string | null>(null);

  const loadStates = useCallback(async () => {
    const response = await api.learning<{ modules: readonly ModuleStateDto[] }>('get_modules', { assignmentId });
    setStates(response.modules);
    return response.modules;
  }, [api, assignmentId]);

  useEffect(() => {
    if (states.length > 0) return;
    void loadStates()
      .catch((caught) => setError(caught instanceof Error ? caught : new Error('Không thể tải module.')))
      .finally(() => setLoading(false));
  }, [loadStates, states.length]);

  const selectedState = states.find((state) => state.moduleId === selectedModuleId);
  const selectedModule = detail.template.modules.find((module) => module.id === selectedModuleId);
  const selectedContent = detail.template.content?.modules.find((module) => module.moduleId === selectedModuleId);
  const answerCount = Object.keys(answers).length;
  const progress = useMemo(() => moduleProgressPercent(states), [states]);
  const selectedPdf = generatedLessonResource(selectedModule?.resources ?? []);
  const lessonReady = canCompleteLesson({
    hasGeneratedPdf: Boolean(selectedPdf),
    pdfOpened,
    summarySeen,
  });

  useEffect(() => {
    if (view !== 'lesson') return;
    setSummarySeen(false);
    setPdfOpened(false);
    setLessonPane(selectedPdf ? 'pdf' : 'readable');
  }, [selectedModuleId, selectedPdf?.id, view]);

  useEffect(() => {
    if (view !== 'lesson' || lessonPane !== 'readable') return;
    const target = summaryRef.current;
    if (!target) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSummarySeen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSummarySeen(true);
    }, { threshold: 0.6 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [selectedModuleId, lessonPane, view]);

  async function openModule(moduleId: string) {
    const state = states.find((item) => item.moduleId === moduleId);
    if (!state || state.status === 'locked') return;
    setBusy(true);
    setError(null);
    try {
      await api.learning('open_module', { assignmentId, moduleId });
      setSelectedModuleId(moduleId);
      setView('lesson');
      await loadStates();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Không thể mở module.'));
    } finally {
      setBusy(false);
    }
  }

  async function completeLesson() {
    if (!selectedModuleId) return;
    setBusy(true);
    try {
      await api.learning('complete_lesson', { assignmentId, moduleId: selectedModuleId });
      await loadStates();
      await startQuiz();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Không thể hoàn thành bài học.'));
    } finally {
      setBusy(false);
    }
  }

  async function startQuiz() {
    if (!selectedModuleId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.learning<{ attempt: ModuleQuizStartDto }>('start_module_quiz', {
        assignmentId,
        moduleId: selectedModuleId,
      });
      setAttempt(response.attempt);
      setAnswers({});
      setResult(null);
      operationRef.current = null;
      setView('quiz');
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Không thể bắt đầu bài kiểm tra.'));
    } finally {
      setBusy(false);
    }
  }

  async function submitQuiz() {
    if (!attempt) return;
    setBusy(true);
    setConfirmSubmit(false);
    if (!operationRef.current) operationRef.current = crypto.randomUUID();
    try {
      const response = await api.learning<{ result: ModuleQuizResultDto }>('submit_module_quiz', {
        assignmentId,
        moduleId: attempt.moduleId,
        attemptId: attempt.attemptId,
        operationId: operationRef.current,
        answers: attempt.questions.map((question) => ({
          questionId: question.id,
          selectedOptionId: answers[question.id],
        })),
      });
      setResult(response.result);
      setView('result');
      await loadStates();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Không thể nộp bài.'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Đang tải lộ trình theo module…" />;
  if (error && states.length === 0) return <ErrorState error={error} onRetry={() => void loadStates()} />;

  return (
    <div className="module-learning">
      <header className="module-learning-header">
        <button className="learning-back" type="button" onClick={onBack}><ArrowLeftOutlined /> Lộ trình của tôi</button>
        <div><span className="section-kicker">HỌC THEO MODULE</span><h2>{detail.template.title}</h2><p>{detail.template.description}</p></div>
        <div className="module-overall-progress"><strong>{progress}%</strong><ProgressBar value={progress} label="Tiến độ" /></div>
      </header>
      {error && <div className="module-inline-error">{error.message}<button type="button" onClick={() => setError(null)}>Đóng</button></div>}
      {view === 'modules' && (
        <section className="module-roadmap">
          <div className="section-header"><div><span className="section-kicker">LỘ TRÌNH CỦA BẠN</span><h2>Tiến từng module theo thứ tự</h2><p>Hoàn thành bài học và đạt bài kiểm tra để mở khóa chặng tiếp theo.</p></div></div>
          <div className="module-card-grid">{states.map((state, index) => (
            <article className={'module-learning-card status-' + state.status} key={state.moduleId}>
              <header><span>{statusIcon(state.status) || index + 1}</span><em>{moduleStatusLabel(state.status)}</em></header>
              <small>MODULE {index + 1}</small>
              <h3>{state.title}</h3>
              <div className="module-card-meta"><span>Điểm cao nhất <strong>{state.bestScore === undefined ? '—' : state.bestScore + '%'}</strong></span><span>{remainingAttemptsLabel(state)}</span></div>
              <button className="button button-secondary" type="button" disabled={busy || state.status === 'locked' || state.status === 'needs_support'} onClick={() => void openModule(state.moduleId)}>
                {state.status === 'passed' ? 'Xem lại bài học' : state.status === 'locked' ? 'Chưa mở khóa' : 'Mở module'} <ArrowRightOutlined />
              </button>
            </article>
          ))}</div>
        </section>
      )}
      {view === 'lesson' && selectedModule && selectedContent && selectedState && (
        <section className="module-reader">
          <div className="module-reader-toolbar"><button className="button button-secondary" type="button" onClick={() => setView('modules')}><ArrowLeftOutlined /> Danh sách module</button><span className={'module-state-chip state-' + selectedState.status}>{moduleStatusLabel(selectedState.status)}</span></div>
          <header><span className="section-kicker">BÀI HỌC · {selectedContent.estimatedMinutes} PHÚT</span><h1>{selectedModule.title}</h1><p>{selectedModule.description}</p></header>
          {selectedPdf && <div className="module-reader-tabs" role="tablist" aria-label="Cách đọc bài học"><button type="button" role="tab" aria-selected={lessonPane === 'pdf'} className={lessonPane === 'pdf' ? 'active' : ''} onClick={() => setLessonPane('pdf')}>Tài liệu PDF</button><button type="button" role="tab" aria-selected={lessonPane === 'readable'} className={lessonPane === 'readable' ? 'active' : ''} onClick={() => setLessonPane('readable')}>Bản dễ đọc</button></div>}
          {selectedPdf && lessonPane === 'pdf'
            ? <div className="module-pdf-panel"><InlineRoomfileViewer resource={selectedPdf} roomId={roomId} onOpened={() => setPdfOpened(true)} /></div>
            : <div className="module-lesson-blocks">{selectedContent.blocks.map((block) => (
              <article className={'module-lesson-block block-' + block.kind} key={block.id} ref={block.kind === 'summary' ? (node) => { summaryRef.current = node; } : undefined}>
                <div className="module-block-heading"><span>{block.kind}</span>{block.pendingVerification && <em>Đang chờ xác minh</em>}</div>
                {block.title && <h3>{block.title}</h3>}
                <LessonMarkdown markdown={block.body} />
                {block.steps && <ol className="module-step-list">{block.steps.map((step) => <li key={step.order}><span>{step.order}</span><p>{step.text}</p></li>)}</ol>}
                <div className="module-block-sources">{block.sourceRefs.map((sourceRef, index) => <SourceQuote key={sourceRef.sourceId + sourceRef.sectionId + index} sourceRef={sourceRef} />)}</div>
              </article>
            ))}</div>}
          <footer className="module-reader-footer">
            <span>{lessonReady ? <><CheckCircleFilled /> {pdfOpened ? 'Tài liệu PDF đã mở' : 'Bạn đã đọc đến phần tổng kết'}</> : selectedPdf ? 'Mở tài liệu PDF hoặc đọc đến phần tổng kết để hoàn thành bài học.' : 'Đọc đến phần tổng kết để hoàn thành bài học.'}</span>
            {selectedState.status === 'passed'
              ? <button className="button button-primary" type="button" onClick={() => setView('modules')}>Đã hoàn thành <CheckOutlined /></button>
              : selectedState.status === 'quiz_ready' || selectedState.status === 'quiz_failed'
                ? <button className="button button-primary" type="button" disabled={busy} onClick={() => void startQuiz()}><PlayCircleOutlined /> Làm bài kiểm tra</button>
                : <button className="button button-primary" type="button" disabled={busy || !lessonReady} onClick={() => void completeLesson()}>Hoàn thành bài học <ArrowRightOutlined /></button>}
          </footer>
        </section>
      )}
      {view === 'quiz' && attempt && (
        <section className="module-quiz">
          <header><span className="section-kicker">KIỂM TRA MODULE</span><h1>{selectedModule?.title}</h1><p>Chọn một đáp án cho mỗi câu hỏi trước khi nộp.</p></header>
          <div className="module-quiz-questions">{attempt.questions.map((question, index) => (
            <article key={question.id}><span className="question-number">{index + 1}</span><div><h3>{question.prompt}</h3><div className="option-list">{question.options.map((option) => (
              <label className={answers[question.id] === option.id ? 'selected' : ''} key={option.id}>
                <input type="radio" name={question.id} checked={answers[question.id] === option.id} onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.id }))} />
                <span>{option.label}</span>
              </label>
            ))}</div></div></article>
          ))}</div>
          <footer><span>{answerCount}/{attempt.questions.length} câu đã trả lời</span><button className="button button-primary" type="button" disabled={busy || answerCount !== attempt.questions.length} onClick={() => setConfirmSubmit(true)}>Nộp bài</button></footer>
        </section>
      )}
      {view === 'result' && result && (
        <section className="module-quiz-result">
          <header className={result.passed ? 'passed' : 'failed'}>
            {result.passed ? <CheckCircleFilled /> : <CloseCircleFilled />}
            <div><span>{result.passed ? 'ĐẠT' : 'CHƯA ĐẠT'}</span><h1>{result.score}%</h1><p>Đúng {result.correctCount}/{result.totalCount} câu · Ngưỡng đạt {result.passingScore}%</p></div>
          </header>
          <div className="module-result-items">{result.items.map((item, index) => (
            <article className={item.correct ? 'correct' : 'incorrect'} key={item.questionId}>
              <h3>{index + 1}. {item.prompt}</h3>
              <p>{item.correct ? <CheckCircleFilled /> : <CloseCircleFilled />} Bạn chọn: {item.options.find((option) => option.id === item.selectedOptionId)?.label}</p>
              {!item.correct && <p>Đáp án đúng: {item.options.find((option) => option.id === item.correctOptionId)?.label}</p>}
              <div className="module-explanation">{item.explanation}</div>
              <div className="module-block-sources">{item.sourceRefs.map((sourceRef, refIndex) => <SourceQuote key={sourceRef.sourceId + sourceRef.sectionId + refIndex} sourceRef={sourceRef} />)}</div>
            </article>
          ))}</div>
          <footer>
            <button className="button button-secondary" type="button" onClick={() => setView('modules')}>Về danh sách module</button>
            {!result.passed && result.attemptsAllowed !== result.attemptsUsed && <button className="button button-primary" type="button" onClick={() => void startQuiz()}><ReloadOutlined /> Làm lại</button>}
          </footer>
        </section>
      )}
      <ConfirmDialog open={confirmSubmit} title="Nộp bài kiểm tra module?" description="Kết quả, đáp án và giải thích sẽ hiển thị ngay sau khi nộp." confirmLabel="Nộp bài" busy={busy} busyLabel="Đang chấm…" onCancel={() => setConfirmSubmit(false)} onConfirm={() => void submitQuiz()} />
    </div>
  );
}
