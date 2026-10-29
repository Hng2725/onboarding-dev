import { useEffect, useState, type ReactNode } from 'react';

import type { AiCallRecord, AiModuleDraftRun } from '../../../onboarding/contracts';
import type { GeneratedBlock, GeneratedModule, GeneratedQuestion } from '../../../onboarding/ai/validate';

export type ModuleWorkspaceAction =
  | 'update_module_lesson'
  | 'approve_module_lesson'
  | 'update_module_questions'
  | 'approve_module_questions'
  | 'retry_module'
  | 'use_source_fallback';

export type ModuleWorkspaceActionHandler = (
  action: ModuleWorkspaceAction,
  args: Record<string, unknown>,
) => boolean | void | Promise<boolean | void>;

const lessonStatus: Record<AiModuleDraftRun['lessonState'], string> = {
  queued: 'Chờ viết',
  drafting: 'AI đang viết',
  validating: 'Đang kiểm tra',
  review_ready: 'Sẵn sàng rà soát',
  fallback_review: 'Bản dự phòng cần rà soát',
  approved: 'Đã duyệt',
  stale: 'Cần duyệt lại',
  failed: 'Không hoàn tất',
  manual_required: 'Cần bổ sung tài liệu hoặc tự soạn',
};

const questionStatus: Record<AiModuleDraftRun['questionState'], string> = {
  blocked: 'Chờ duyệt bài học',
  queued: 'Chờ tạo câu hỏi',
  drafting: 'AI đang viết câu hỏi',
  review_ready: 'Câu hỏi sẵn sàng rà soát',
  approved: 'Câu hỏi đã duyệt',
  stale: 'Câu hỏi đã cũ',
  failed: 'Tạo câu hỏi chưa hoàn tất',
};

const blankLesson = (run: AiModuleDraftRun): GeneratedModule => ({
  localId: run.outline.moduleLocalId,
  frameKey: run.outline.frameKey,
  title: run.outline.title,
  description: run.outline.description,
  estimatedMinutes: run.outline.estimatedMinutes,
  objectives: run.outline.objectives,
  featureIds: run.outline.featureIds,
  blocks: [],
  questions: [],
});

const newLocalId = () => globalThis.crypto.randomUUID();

export function AiModuleWorkspace({
  runs,
  calls,
  history,
  selectedId,
  busy,
  onSelect,
  onAction,
  onSources,
}: {
  runs: readonly AiModuleDraftRun[];
  calls: readonly AiCallRecord[];
  history?: unknown;
  selectedId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onAction: ModuleWorkspaceActionHandler;
  onSources: () => void;
}) {
  const active = runs.filter((run) => !run.outline.tombstoned).sort((left, right) => left.outline.order - right.outline.order);
  const run = active.find((item) => item.outline.moduleLocalId === selectedId) ?? active[0];
  const phase: 'lessons' | 'questions' = active.length > 0 && active.every((item) => item.lessonState === 'approved')
    ? 'questions'
    : 'lessons';
  const reviewContext = `${run?.outline.moduleLocalId ?? ''}:${phase}`;
  const [editingContext, setEditingContext] = useState<string | null>(null);
  const viewMode: 'read' | 'edit' = editingContext === reviewContext ? 'edit' : 'read';
  const [lesson, setLesson] = useState<GeneratedModule | undefined>(() => run ? run.lessonDraft ?? blankLesson(run) : undefined);
  const [draftQuestions, setQuestions] = useState<readonly GeneratedQuestion[]>(() => run?.questionDraft ?? []);

  useEffect(() => {
    setLesson(run ? run.lessonDraft ?? blankLesson(run) : undefined);
  }, [run?.outline.moduleLocalId, run?.lessonVersion]);
  useEffect(() => {
    setQuestions(run?.questionDraft ?? []);
  }, [run?.outline.moduleLocalId, run?.questionVersion]);

  if (!run || !lesson) return null;

  const currentIndex = active.indexOf(run);
  const nextRun = active[currentIndex + 1];
  const lessonDirty = JSON.stringify(lesson) !== JSON.stringify(run.lessonDraft ?? blankLesson(run));
  const questionsDirty = JSON.stringify(draftQuestions) !== JSON.stringify(run.questionDraft ?? []);
  const base = { moduleLocalId: run.outline.moduleLocalId };
  const currentCall = [...calls].reverse().find((call) => call.moduleLocalId === run.outline.moduleLocalId && (call.status === 'dispatched' || call.status === 'pending'));
  const approvedLessons = active.filter((item) => item.lessonState === 'approved').length;
  const approvedQuestionModules = active.filter((item) => item.questionState === 'approved').length;
  const approvedQuestions = run.questionState === 'approved' ? draftQuestions.length : 0;
  const patchLesson = (patch: Partial<GeneratedModule>) => setLesson((current) => current ? { ...current, ...patch } : current);
  const patchBlock = (index: number, patch: Partial<GeneratedBlock>) => patchLesson({
    blocks: lesson.blocks.map((block, blockIndex) => blockIndex === index ? { ...block, ...patch } : block),
  });
  const patchQuestion = (index: number, patch: Partial<GeneratedQuestion>) => setQuestions(
    draftQuestions.map((question, questionIndex) => questionIndex === index ? { ...question, ...patch } : question),
  );

  async function approveAndContinue() {
    const result = phase === 'lessons'
      ? await onAction('approve_module_lesson', { ...base, expectedVersion: run.lessonVersion })
      : await onAction('approve_module_questions', { ...base, expectedVersion: run.questionVersion });
    if (result === false) return;
    setEditingContext(null);
    if (nextRun) onSelect(nextRun.outline.moduleLocalId);
  }

  const canApprove = phase === 'lessons'
    ? !busy && !lessonDirty && Boolean(run.lessonDraft) && run.lessonState !== 'approved'
    : !busy && !questionsDirty && run.lessonState === 'approved' && Boolean(run.questionDraft?.length) && run.questionState !== 'approved';

  return (
    <section className="ai-module-workspace">
      <nav aria-label="Danh sách module">
        <header>
          <strong>{phase === 'lessons'
            ? `${approvedLessons}/${active.length} bài học đã duyệt`
            : `${approvedQuestionModules}/${active.length} module đã duyệt câu hỏi`}</strong>
          <small data-phase={phase}>{phase === 'lessons' ? 'Bài học' : 'Câu hỏi'}</small>
        </header>
        {active.map((item) => {
          const questionCount = item.questionDraft?.length ?? 0;
          const approvedCount = item.questionState === 'approved' ? questionCount : 0;
          return (
            <button
              type="button"
              className={item === run ? 'active' : ''}
              key={item.outline.moduleLocalId}
              onClick={() => onSelect(item.outline.moduleLocalId)}
            >
              <strong>{item.outline.order + 1}. {item.outline.title}</strong>
              <small>{phase === 'lessons'
                ? lessonStatus[item.lessonState]
                : `${approvedCount}/${questionCount} câu hỏi đã duyệt`}</small>
              {calls.filter((call) => call.moduleLocalId === item.outline.moduleLocalId && call.provider).slice(-1).map((call) => (
                <small key={call.callId}>{call.provider === 'sandbox' ? 'Sandbox' : 'Native AI Chat'}</small>
              ))}
              {item.nextRetryAt && <small>Chờ đến {item.nextRetryAt}</small>}
            </button>
          );
        })}
      </nav>

      <article className="ai-module-review-pane">
        <header className="ai-module-review-heading">
          <div>
            <span data-phase={phase}>{phase === 'lessons' ? 'Bài học' : 'Câu hỏi'}</span>
            <h3>{run.outline.title}</h3>
            <p>{phase === 'lessons' ? lessonStatus[run.lessonState] : questionStatus[run.questionState]}</p>
          </div>
          {phase === 'questions' && <strong>{approvedQuestions}/{draftQuestions.length} câu hỏi đã duyệt</strong>}
        </header>

        {currentCall?.provider && <small>Nhà cung cấp: {currentCall.provider === 'sandbox' ? 'Sandbox' : 'Native AI Chat'}</small>}
        {run.nextRetryAt && <p>Chờ nhà cung cấp đến <time dateTime={run.nextRetryAt}>{run.nextRetryAt}</time></p>}
        {!run.outline.sourceSectionIds.length && (
          <div className="ai-module-source-warning">
            <p>Cần bổ sung tài liệu hoặc tự soạn. AI không tự suy đoán nội dung khi module chưa có nguồn.</p>
            <button type="button" onClick={onSources}>Bổ sung tài liệu</button>
          </div>
        )}

        {viewMode === 'read' ? (
          phase === 'lessons'
            ? <LessonReadView lesson={lesson} />
            : <QuestionReadView questions={draftQuestions} />
        ) : (
          phase === 'lessons'
            ? (
              <LessonEditor
                lesson={lesson}
                onPatch={patchLesson}
                onPatchBlock={patchBlock}
                onRemoveBlock={(index) => patchLesson({ blocks: lesson.blocks.filter((_, blockIndex) => blockIndex !== index) })}
              />
            )
            : (
              <QuestionEditor
                questions={draftQuestions}
                lesson={lesson}
                onPatch={patchQuestion}
                onRemove={(index) => setQuestions(draftQuestions.filter((_, questionIndex) => questionIndex !== index))}
              />
            )
        )}

        {viewMode === 'read' ? (
          <div className="ai-module-actionbar">
            <button type="button" disabled={busy} onClick={() => setEditingContext(reviewContext)}>Chỉnh sửa</button>
            <button type="button" className="button button-primary" disabled={!canApprove} onClick={approveAndContinue}>
              {phase === 'lessons' ? 'Duyệt và sang module tiếp theo' : 'Duyệt câu hỏi và tiếp tục'}
            </button>
            <MoreActions run={run} history={history} busy={busy} onAction={onAction} />
          </div>
        ) : phase === 'lessons' ? (
          <div className="ai-module-actionbar editing">
            <button type="button" disabled={busy} onClick={() => patchLesson({
              blocks: [...lesson.blocks, { localId: newLocalId(), kind: 'concept', body: '', sourceRefs: [] }],
            })}>Thêm nội dung</button>
            <button type="button" disabled={busy} onClick={() => onAction('update_module_lesson', {
              ...base, expectedVersion: run.lessonVersion, module: lesson,
            })}>Lưu bài học</button>
            <button type="button" onClick={() => setEditingContext(null)}>Đóng chỉnh sửa</button>
          </div>
        ) : (
          <div className="ai-module-actionbar editing">
            <button type="button" disabled={busy} onClick={() => setQuestions([...draftQuestions, {
              localId: newLocalId(),
              level: 'recall',
              prompt: '',
              options: ['a', 'b', 'c', 'd'].map((key) => ({ id: key, label: '' })),
              correctOptionId: 'a',
              explanation: '',
              blockIds: [],
              sourceRefs: [],
            }])}>Thêm câu hỏi</button>
            <button type="button" disabled={busy} onClick={() => onAction('update_module_questions', {
              ...base, expectedVersion: run.questionVersion, questions: draftQuestions,
            })}>Lưu câu hỏi</button>
            <button type="button" onClick={() => setEditingContext(null)}>Đóng chỉnh sửa</button>
          </div>
        )}
      </article>
    </section>
  );
}

function LessonReadView({ lesson }: { lesson: GeneratedModule }) {
  return (
    <section className="ai-module-reading" aria-label="Nội dung bài học">
      <header>
        <div><h4>{lesson.title}</h4><p>{lesson.description}</p></div>
        <span>{lesson.estimatedMinutes} phút</span>
      </header>
      {lesson.objectives.length > 0 && <div><strong>Mục tiêu</strong><ul>{lesson.objectives.map((objective) => <li key={objective}>{objective}</li>)}</ul></div>}
      {lesson.blocks.length > 0 ? lesson.blocks.map((block, index) => (
        <article className="ai-module-reading-block" key={block.localId}>
          <small>{index + 1}. {block.kind}</small>
          {block.title && <h4>{block.title}</h4>}
          <p>{block.body}</p>
          {block.steps && <ol>{block.steps.map((step) => <li key={step.order}>{step.text}</li>)}</ol>}
          {block.sourceRefs.length > 0 && <span>{block.sourceRefs.length} dẫn chứng</span>}
        </article>
      )) : <p>Chưa có nội dung bài học. Chọn Chỉnh sửa để tự soạn.</p>}
    </section>
  );
}

function QuestionReadView({ questions }: { questions: readonly GeneratedQuestion[] }) {
  return (
    <section className="ai-module-reading ai-module-question-reading" aria-label="Nội dung câu hỏi">
      {questions.length > 0 ? questions.map((question, index) => (
        <article key={question.localId}>
          <small>Câu {index + 1} · {question.level}</small>
          <h4>{question.prompt}</h4>
          <div>{question.options.map((option) => (
            <span className={option.id === question.correctOptionId ? 'correct' : ''} key={option.id}>
              {option.id.toUpperCase()}. {option.label}
            </span>
          ))}</div>
          {question.explanation && <p>{question.explanation}</p>}
        </article>
      )) : <p>Chưa có câu hỏi để rà soát.</p>}
    </section>
  );
}

function LessonEditor({
  lesson,
  onPatch,
  onPatchBlock,
  onRemoveBlock,
}: {
  lesson: GeneratedModule;
  onPatch: (patch: Partial<GeneratedModule>) => void;
  onPatchBlock: (index: number, patch: Partial<GeneratedBlock>) => void;
  onRemoveBlock: (index: number) => void;
}) {
  return (
    <section className="ai-editor-panel">
      <div className="ai-review-scroll" role="region" aria-label="Chỉnh sửa bài học" tabIndex={0}>
        <label>Tiêu đề bài học<input aria-label="Tiêu đề bài học" value={lesson.title} onChange={(event) => onPatch({ title: event.target.value })} /></label>
        <label>Mô tả<textarea value={lesson.description} onChange={(event) => onPatch({ description: event.target.value })} /></label>
        <label>Thời lượng (phút)<input type="number" value={lesson.estimatedMinutes} onChange={(event) => onPatch({ estimatedMinutes: Number(event.target.value) })} /></label>
        <label>Mục tiêu (mỗi dòng một mục tiêu)<textarea value={lesson.objectives.join('\n')} onChange={(event) => onPatch({ objectives: event.target.value.split('\n') })} /></label>
        {lesson.blocks.map((block, index) => (
          <ReviewCard key={block.localId} initiallyOpen={!block.body}>
            <summary><strong>{index + 1}. {block.title || block.body.slice(0, 90) || 'Nội dung mới'}</strong><small>{block.kind} · {block.sourceRefs.length} dẫn chứng</small></summary>
            <fieldset>
              <legend>Nội dung {index + 1}</legend>
              <label>Loại<select value={block.kind} onChange={(event) => onPatchBlock(index, { kind: event.target.value as GeneratedBlock['kind'] })}>{['concept', 'steps', 'scenario', 'tip', 'warning', 'summary'].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
              <label>Tiêu đề<input value={block.title ?? ''} onChange={(event) => onPatchBlock(index, { title: event.target.value })} /></label>
              <label>Nội dung<textarea value={block.body} onChange={(event) => onPatchBlock(index, { body: event.target.value })} /></label>
              {block.kind === 'steps' && <label>Các bước (mỗi dòng một bước)<textarea value={(block.steps ?? []).map((step) => step.text).join('\n')} onChange={(event) => onPatchBlock(index, { steps: event.target.value.split('\n').map((text, stepIndex) => ({ order: stepIndex + 1, text })) })} /></label>}
              <SourceRefs refs={block.sourceRefs} onChange={(sourceRefs) => onPatchBlock(index, { sourceRefs })} />
              <button type="button" onClick={() => onRemoveBlock(index)}>Xóa nội dung</button>
            </fieldset>
          </ReviewCard>
        ))}
      </div>
    </section>
  );
}

function QuestionEditor({
  questions,
  lesson,
  onPatch,
  onRemove,
}: {
  questions: readonly GeneratedQuestion[];
  lesson: GeneratedModule;
  onPatch: (index: number, patch: Partial<GeneratedQuestion>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <section className="ai-editor-panel">
      <div className="ai-review-scroll" role="region" aria-label="Chỉnh sửa câu hỏi" tabIndex={0}>
        {questions.map((question, index) => (
          <ReviewCard key={question.localId} initiallyOpen={!question.prompt}>
            <summary><strong>{index + 1}. {question.prompt || 'Câu hỏi mới'}</strong><small>{question.level} · {question.options.length} đáp án</small></summary>
            <fieldset>
              <legend>Câu hỏi {index + 1}</legend>
              <label>Mức độ<select value={question.level} onChange={(event) => onPatch(index, { level: event.target.value as GeneratedQuestion['level'] })}><option value="recall">Ghi nhớ</option><option value="procedure">Quy trình</option><option value="scenario">Tình huống</option></select></label>
              <label>Câu hỏi<textarea value={question.prompt} onChange={(event) => onPatch(index, { prompt: event.target.value })} /></label>
              {question.options.map((option, optionIndex) => (
                <label key={option.id}>Đáp án {option.id}<input value={option.label} onChange={(event) => onPatch(index, { options: question.options.map((item, itemIndex) => itemIndex === optionIndex ? { ...item, label: event.target.value } : item) })} /></label>
              ))}
              <label>Đáp án đúng<select value={question.correctOptionId} onChange={(event) => onPatch(index, { correctOptionId: event.target.value })}>{question.options.map((option) => <option key={option.id} value={option.id}>{option.id}</option>)}</select></label>
              <label>Giải thích<textarea value={question.explanation} onChange={(event) => onPatch(index, { explanation: event.target.value })} /></label>
              <div><strong>Nội dung liên quan</strong>{lesson.blocks.map((block) => (
                <label key={block.localId}><input type="checkbox" checked={question.blockIds.includes(block.localId)} onChange={(event) => onPatch(index, { blockIds: event.target.checked ? [...question.blockIds, block.localId] : question.blockIds.filter((value) => value !== block.localId) })} /> {block.title || block.body.slice(0, 60) || block.localId}</label>
              ))}</div>
              <SourceRefs refs={question.sourceRefs} onChange={(sourceRefs) => onPatch(index, { sourceRefs })} />
              <button type="button" onClick={() => onRemove(index)}>Xóa câu hỏi</button>
            </fieldset>
          </ReviewCard>
        ))}
      </div>
    </section>
  );
}

function MoreActions({
  run,
  history,
  busy,
  onAction,
}: {
  run: AiModuleDraftRun;
  history?: unknown;
  busy: boolean;
  onAction: ModuleWorkspaceActionHandler;
}) {
  const base = { moduleLocalId: run.outline.moduleLocalId };
  const canRetryLesson = ['review_ready', 'approved', 'failed', 'fallback_review', 'manual_required'].includes(run.lessonState);
  const canUseFallback = ['queued', 'stale', 'review_ready', 'approved', 'failed', 'fallback_review', 'manual_required'].includes(run.lessonState);
  const canRetryQuestions = ['review_ready', 'approved', 'failed', 'stale'].includes(run.questionState) && run.lessonState === 'approved';
  const entries = Array.isArray(history)
    ? history.filter((entry: unknown) => entry && typeof entry === 'object' && (entry as { moduleLocalId?: unknown }).moduleLocalId === run.outline.moduleLocalId)
    : [];

  return (
    <details className="ai-module-more-actions">
      <summary>Thao tác khác</summary>
      <div>
        {canRetryLesson && <button type="button" disabled={busy} onClick={() => onAction('retry_module', { ...base, target: 'lesson', expectedVersion: run.lessonVersion })}>Viết lại bài học</button>}
        {canUseFallback && <button type="button" disabled={busy || run.questionState === 'drafting'} onClick={() => onAction('use_source_fallback', { ...base, expectedVersion: run.lessonVersion })}>Dùng bản từ nguồn</button>}
        {canRetryQuestions && <button type="button" disabled={busy} onClick={() => onAction('retry_module', { ...base, target: 'questions', expectedVersion: run.questionVersion })}>Tạo lại câu hỏi</button>}
        {entries.length > 0 && <section><strong>Lịch sử phê duyệt</strong>{entries.map((entry, index) => <pre key={index}>{JSON.stringify(entry, null, 2)}</pre>)}</section>}
      </div>
    </details>
  );
}

function SourceRefs({
  refs,
  onChange,
}: {
  refs: readonly { readonly sectionId: string; readonly quote: string }[];
  onChange: (refs: readonly { sectionId: string; quote: string }[]) => void;
}) {
  return (
    <details className="ai-source-details">
      <summary>Dẫn chứng ({refs.length})</summary>
      {refs.map((ref, index) => (
        <div key={index}>
          <label>Mã phần nguồn<input value={ref.sectionId} onChange={(event) => onChange(refs.map((item, itemIndex) => itemIndex === index ? { ...item, sectionId: event.target.value } : item))} /></label>
          <label>Trích dẫn<textarea value={ref.quote} onChange={(event) => onChange(refs.map((item, itemIndex) => itemIndex === index ? { ...item, quote: event.target.value } : item))} /></label>
          <button type="button" onClick={() => onChange(refs.filter((_, itemIndex) => itemIndex !== index))}>Xóa dẫn chứng</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...refs, { sectionId: '', quote: '' }])}>Thêm dẫn chứng</button>
    </details>
  );
}

function ReviewCard({ initiallyOpen, children }: { initiallyOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className="ai-content-card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>{children}</details>;
}
