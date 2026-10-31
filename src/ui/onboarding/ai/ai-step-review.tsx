import { EditOutlined, LoadingOutlined, RedoOutlined, RobotOutlined } from '@ant-design/icons';
import { useState } from 'react';

import type { AiJobRecord, AiModuleDraftRun, VerificationFlag } from '../../../onboarding/contracts';
import type { GeneratedBlock, GeneratedModule, GeneratedQuestion } from '../../../onboarding/ai/validate';
import { outlineModuleDisplayTitle } from '../../../onboarding/ai/frame-labels';
import type { AdminTemplateDetail } from '../../../onboarding/templates';
import { LessonEditor, LessonReadView, QuestionEditor, QuestionReadView } from './ai-module-content';
import { moduleAttention } from './ai-step-generating';
import type { AiTemplateSettings } from './ai-template-batch';
import { FlagPanel, type FlagResolutionAction } from './flag-panel';

export const LESSON_SAVE_CONFIRM = 'Câu hỏi của module này sẽ được AI tạo lại cho khớp bài học mới.';
export const REVIEW_UPDATING = 'Đang cập nhật…';
export const REWRITE_CONFIRM = 'AI sẽ viết lại bài học và câu hỏi của module này. Chỉnh sửa tay sẽ bị thay thế.';

/** The server accepts three to five questions per module. */
const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 5;

export interface AiStepReviewProps {
  /** The content source of truth: lesson and question drafts per module. */
  readonly job: AiJobRecord;
  /** The materialized draft: flags, title and what gets published. Null while it is being rebuilt. */
  readonly review: AdminTemplateDetail | null;
  /** A module update is being pumped through the job; the panel keeps its content and says so. */
  readonly updating: boolean;
  readonly busy: boolean;
  readonly settings: AiTemplateSettings;
  onSettings(patch: Partial<AiTemplateSettings>): void;
  onSaveLesson(moduleLocalId: string, lesson: GeneratedModule, expectedVersion: number): void;
  onSaveQuestions(moduleLocalId: string, questions: readonly GeneratedQuestion[], expectedVersion: number): void;
  onRewrite(moduleLocalId: string, expectedVersion: number): void;
  onResolveFlag: (flag: VerificationFlag, action: FlagResolutionAction, note?: string, index?: number) => void;
  /** sourceId → file name, for citation chips such as "Sổ tay · mục 1". */
  readonly sourceNames?: ReadonlyMap<string, string>;
  /** The update pump stopped without finishing: a stuck module shows its error with Thử lại. */
  readonly stalled?: boolean;
  /** An update failure the app could not recover from, already in Vietnamese. */
  readonly error?: string | null;
  onRetry?(): void;
  onRetryModule?(moduleLocalId: string, target: 'lesson' | 'questions', expectedVersion: number): void;
}

type Tab = 'lesson' | 'questions';

const blankLesson = (run: AiModuleDraftRun): GeneratedModule => ({
  localId: run.outline.moduleLocalId,
  frameKey: run.outline.frameKey,
  title: outlineModuleDisplayTitle(run.outline),
  description: run.outline.description,
  estimatedMinutes: run.outline.estimatedMinutes,
  objectives: run.outline.objectives,
  featureIds: run.outline.featureIds,
  blocks: [],
  questions: [],
});

const newLocalId = () => globalThis.crypto.randomUUID();

function editKey(run: AiModuleDraftRun, tab: Tab): string {
  return run.outline.moduleLocalId + ':' + tab + ':' + String(tab === 'lesson' ? run.lessonVersion : run.questionVersion);
}

function attemptsLabel(settings: AiTemplateSettings): string {
  return settings.maxAttemptsPerModule === null || settings.maxAttemptsPerModule === undefined
    ? 'Không giới hạn'
    : String(settings.maxAttemptsPerModule) + ' lượt/module';
}

/** Bước 4 — Xem lại & xuất bản: read and edit each module through the job; flags and settings come from the draft. */
export function AiStepReview({
  job,
  review,
  updating,
  busy,
  settings,
  onSettings,
  onSaveLesson,
  onSaveQuestions,
  onRewrite,
  onResolveFlag,
  sourceNames,
  stalled = false,
  error = null,
  onRetry,
  onRetryModule,
}: AiStepReviewProps) {
  const runs = (job.moduleRuns ?? []).filter((run) => !run.outline.tombstoned)
    .sort((left, right) => left.outline.order - right.outline.order);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('lesson');
  /** The module, tab and draft version being edited; a saved version closes the editor by itself. */
  const [editing, setEditing] = useState<string | null>(null);
  const [lesson, setLesson] = useState<GeneratedModule | null>(null);
  const [questions, setQuestions] = useState<readonly GeneratedQuestion[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [confirmingRewrite, setConfirmingRewrite] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [warningsOpen, setWarningsOpen] = useState(false);

  const run = runs.find((item) => item.outline.moduleLocalId === selectedId) ?? runs[0];
  const locked = busy || updating;
  // Autopilot approves a rewrite; only then does a per-module retry help.
  const attentionFor = (item: AiModuleDraftRun) => (stalled && job.autoApprove === true ? moduleAttention(item) : null);
  const anyAttention = runs.some((item) => attentionFor(item));

  const flags = review?.flags ?? [];
  const reviewModules = review?.modules ?? [];
  const reviewModuleFor = (item: AiModuleDraftRun) => reviewModules.find((module) => module.key === item.outline.frameKey);
  const knownModuleIds = new Set(reviewModules.map((module) => module.id));
  // A flag pinned to no module of the draft belongs to the whole template: the first module shows it.
  const templateFlags = flags.filter((flag) => flag.status === 'open' && !(flag.location.moduleId && knownModuleIds.has(flag.location.moduleId)));
  const openFlagsFor = (item: AiModuleDraftRun) => {
    const moduleId = reviewModuleFor(item)?.id;
    return flags.filter((flag) => flag.status === 'open' && moduleId !== undefined && flag.location.moduleId === moduleId);
  };

  if (!run) return null;

  const moduleLocalId = run.outline.moduleLocalId;
  const lessonView = run.lessonDraft ?? blankLesson(run);
  const questionDraft = run.questionDraft ?? [];
  const isEditing = editing === editKey(run, tab) && (tab === 'lesson' ? lesson !== null : true);
  const issue = attentionFor(run);
  // Template-level flags appear once, with the first module, never repeated on every module.
  const moduleFlags = [...openFlagsFor(run), ...(run === runs[0] ? templateFlags : [])];
  const blockingFlags = moduleFlags.filter((flag) => flag.severity === 'blocking');
  const warningFlags = moduleFlags.filter((flag) => flag.severity !== 'blocking');
  const lessonApproved = run.lessonState === 'approved';
  const drafting = run.lessonState === 'drafting' || run.questionState === 'drafting';
  const questionCountValid = questions.length >= MIN_QUESTIONS && questions.length <= MAX_QUESTIONS;

  function selectModule(id: string) {
    setSelectedId(id);
    setWarningsOpen(false);
    setEditing(null);
    setConfirming(false);
    setConfirmingRewrite(false);
  }

  function selectTab(next: Tab) {
    setTab(next);
    setEditing(null);
    setConfirming(false);
    setConfirmingRewrite(false);
  }

  function startEditing(target: Tab = tab) {
    if (target === 'lesson') setLesson(lessonView);
    else setQuestions(questionDraft);
    setTab(target);
    setConfirming(false);
    setConfirmingRewrite(false);
    setEditing(editKey(run, target));
  }

  /** A flag's "Chỉnh sửa": fix the flagged content in the module itself (questions when it points at one). */
  function editFromFlag(flag: VerificationFlag) {
    const canEditQuestions = lessonApproved && questionDraft.length > 0;
    startEditing(flag.location.questionId && canEditQuestions ? 'questions' : 'lesson');
  }

  function stopEditing() {
    setEditing(null);
    setConfirming(false);
  }

  const patchLesson = (patch: Partial<GeneratedModule>) => setLesson((current) => current ? { ...current, ...patch } : current);
  const patchBlock = (index: number, patch: Partial<GeneratedBlock>) => setLesson((current) => current
    ? { ...current, blocks: current.blocks.map((block, blockIndex) => blockIndex === index ? { ...block, ...patch } : block) }
    : current);
  const patchQuestion = (index: number, patch: Partial<GeneratedQuestion>) => setQuestions((current) =>
    current.map((question, questionIndex) => questionIndex === index ? { ...question, ...patch } : question));

  return (
    <section className="ai-final-review" aria-label="Xem lại & xuất bản">
      {error ? (
        <div className="ai-generating-banner error" role="alert">
          <span>{error}</span>
          {onRetry && <button className="button button-secondary button-sm" type="button" disabled={busy} onClick={onRetry}><RedoOutlined aria-hidden="true" /> Thử lại</button>}
        </div>
      ) : stalled && !anyAttention ? (
        <div className="ai-generating-banner warn" role="status">
          <span>AI đang chờ để làm tiếp.</span>
          {onRetry && <button className="button button-secondary button-sm" type="button" disabled={busy} onClick={onRetry}><RedoOutlined aria-hidden="true" /> Thử lại</button>}
        </div>
      ) : null}
      <div className="ai-final-review-layout">
        <aside className="ai-final-review-side">
          <span className="ai-final-review-title">{review?.title ?? job.title ?? ''}</span>
          <nav className="ai-final-review-nav" aria-label="Danh sách module">
            {runs.map((item) => {
              const count = item.questionDraft?.length ?? 0;
              const open = openFlagsFor(item).length;
              const itemIssue = attentionFor(item);
              return (
                <button
                  type="button"
                  key={item.outline.moduleLocalId}
                  className={(item === run ? 'active' : '') + (itemIssue ? ' ' + itemIssue.tone : open > 0 ? ' warn' : '')}
                  aria-current={item === run ? 'true' : undefined}
                  onClick={() => selectModule(item.outline.moduleLocalId)}
                >
                  <span>{item.outline.order + 1}. {outlineModuleDisplayTitle(item.outline)}</span>
                  <small>{count} câu</small>
                  {open > 0 && <em title={open + ' cảnh báo'} aria-label={open + ' cảnh báo'}>{open}</em>}
                </button>
              );
            })}
          </nav>
          <div className="ai-final-review-settings">
            <div className="ai-final-review-pills">
              {[`Đạt ${settings.passingScore}%`, attemptsLabel(settings), settings.learningMode === 'free' ? 'Tự do' : 'Tuần tự'].map((label) => (
                <button className="ai-pill" type="button" key={label} aria-expanded={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}>{label}</button>
              ))}
            </div>
            {settingsOpen && (
              <div
                className="ai-settings-popover"
                role="dialog"
                aria-label="Thiết lập template"
                data-esc-scope
                onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setSettingsOpen(false); } }}
              >
                <label className="form-field"><span>Ngưỡng đạt (%)</span><input type="number" min={50} max={100} value={settings.passingScore} onChange={(event) => onSettings({ passingScore: Number(event.target.value) })} /></label>
                <label className="form-field"><span>Số lượt mỗi module</span><input type="number" min={1} max={10} value={settings.maxAttemptsPerModule ?? ''} placeholder="Không giới hạn" onChange={(event) => onSettings({ maxAttemptsPerModule: event.target.value ? Number(event.target.value) : null })} /></label>
                <label className="form-field"><span>Chế độ học</span><select value={settings.learningMode} onChange={(event) => onSettings({ learningMode: event.target.value as AiTemplateSettings['learningMode'] })}><option value="sequential">Tuần tự</option><option value="free">Tự do</option></select></label>
                <button className="button button-secondary button-sm" type="button" onClick={() => setSettingsOpen(false)}>Xong</button>
              </div>
            )}
          </div>
        </aside>

        <article className="ai-final-review-doc">
          <div className="ai-final-review-tabs" role="tablist" aria-label="Nội dung module">
            <button type="button" role="tab" aria-selected={tab === 'lesson'} className={tab === 'lesson' ? 'active' : ''} onClick={() => selectTab('lesson')}>Bài học</button>
            <button type="button" role="tab" aria-selected={tab === 'questions'} className={tab === 'questions' ? 'active' : ''} onClick={() => selectTab('questions')}>Câu hỏi ({questionDraft.length})</button>
          </div>

          {updating && <p className="ai-final-review-updating" role="status"><LoadingOutlined spin /> {REVIEW_UPDATING}</p>}
          {issue && (
            <div className={'ai-generating-banner ' + issue.tone} role={issue.tone === 'error' ? 'alert' : 'status'}>
              <span>{issue.message}</span>
              {onRetryModule && (
                <button
                  className="button button-secondary button-sm"
                  type="button"
                  disabled={busy}
                  onClick={() => onRetryModule(moduleLocalId, issue.target, issue.expectedVersion)}
                ><RedoOutlined aria-hidden="true" /> Thử lại</button>
              )}
            </div>
          )}
          {/* Warnings fold into one bar; blocking flags stay expanded. Module drafts cannot drop
              content from the materialized draft, so the Admin edits the module instead. */}
          {warningFlags.length > 0 && (
            <button className="ai-flag-bar warn" type="button" aria-expanded={warningsOpen} onClick={() => setWarningsOpen((value) => !value)}>
              {warningFlags.length} cảnh báo · {warningsOpen ? 'Ẩn' : 'Xem'}
            </button>
          )}
          {warningsOpen && warningFlags.length > 0 && (
            <FlagPanel flags={warningFlags} busy={locked || drafting} onResolve={onResolveFlag} allowRemove={false} onEdit={editFromFlag} compact />
          )}
          {blockingFlags.length > 0 && (
            <FlagPanel flags={blockingFlags} busy={locked || drafting} onResolve={onResolveFlag} allowRemove={false} onEdit={editFromFlag} compact />
          )}

          <div className="ai-final-review-content" role="tabpanel">
            {tab === 'lesson'
              ? isEditing && lesson
                ? (
                  <LessonEditor
                    lesson={lesson}
                    onPatch={patchLesson}
                    onPatchBlock={patchBlock}
                    onRemoveBlock={(index) => patchLesson({ blocks: lesson.blocks.filter((_, blockIndex) => blockIndex !== index) })}
                  />
                )
                : <LessonReadView lesson={lessonView} sourceNames={sourceNames} />
              : isEditing
                ? (
                  <QuestionEditor
                    questions={questions}
                    lesson={lessonView}
                    onPatch={patchQuestion}
                    onRemove={(index) => setQuestions((current) => current.filter((_, questionIndex) => questionIndex !== index))}
                  />
                )
                : <QuestionReadView questions={questionDraft} sourceNames={sourceNames} />}
          </div>

          {!isEditing && confirmingRewrite ? (
            <div className="ai-final-review-confirm" role="alertdialog" aria-label="AI viết lại">
              <p>{REWRITE_CONFIRM}</p>
              <div>
                <button className="button button-secondary button-sm" type="button" disabled={locked || drafting} onClick={() => {
                  setConfirmingRewrite(false);
                  onRewrite(moduleLocalId, run.lessonVersion);
                }}>Viết lại</button>
                <button className="button button-ghost button-sm" type="button" onClick={() => setConfirmingRewrite(false)}>Hủy</button>
              </div>
            </div>
          ) : !isEditing ? (
            <div className="ai-final-review-actions">
              <button
                className="button button-secondary button-sm"
                type="button"
                disabled={locked || drafting || (tab === 'questions' && (!lessonApproved || questionDraft.length === 0))}
                onClick={() => startEditing()}
              ><EditOutlined aria-hidden="true" /> Chỉnh sửa</button>
              {tab === 'lesson' && (
                <button
                  className="button button-accent button-sm"
                  type="button"
                  disabled={locked || drafting}
                  onClick={() => setConfirmingRewrite(true)}
                ><RobotOutlined aria-hidden="true" /> AI viết lại</button>
              )}
            </div>
          ) : tab === 'lesson' && lesson ? (
            confirming ? (
              <div className="ai-final-review-confirm" role="alertdialog" aria-label="Lưu bài học">
                <p>{LESSON_SAVE_CONFIRM}</p>
                <div>
                  <button className="button button-secondary button-sm" type="button" disabled={locked} onClick={() => {
                    setConfirming(false);
                    onSaveLesson(moduleLocalId, lesson, run.lessonVersion);
                  }}>Lưu và tạo lại câu hỏi</button>
                  <button className="button button-ghost button-sm" type="button" onClick={() => setConfirming(false)}>Hủy</button>
                </div>
              </div>
            ) : (
              <div className="ai-final-review-actions">
                <button className="button button-ghost button-sm" type="button" disabled={locked} onClick={() => patchLesson({
                  blocks: [...lesson.blocks, { localId: newLocalId(), kind: 'concept', body: '', sourceRefs: [] }],
                })}>Thêm nội dung</button>
                <button className="button button-secondary button-sm" type="button" disabled={locked} onClick={() => setConfirming(true)}>Lưu bài học</button>
                <button className="button button-ghost button-sm" type="button" onClick={stopEditing}>Đóng chỉnh sửa</button>
              </div>
            )
          ) : (
            <div className="ai-final-review-actions">
              <button className="button button-ghost button-sm" type="button" disabled={locked} onClick={() => setQuestions((current) => [...current, {
                localId: newLocalId(),
                level: 'recall',
                prompt: '',
                options: ['a', 'b', 'c', 'd'].map((key) => ({ id: key, label: '' })),
                correctOptionId: 'a',
                explanation: '',
                blockIds: [],
                sourceRefs: [],
              }])}>Thêm câu hỏi</button>
              <button
                className="button button-secondary button-sm"
                type="button"
                disabled={locked || !questionCountValid}
                onClick={() => onSaveQuestions(moduleLocalId, questions, run.questionVersion)}
              >Lưu câu hỏi</button>
              <button className="button button-ghost button-sm" type="button" onClick={stopEditing}>Đóng chỉnh sửa</button>
              {!questionCountValid && <small className="ai-final-review-hint">Cần từ {MIN_QUESTIONS} đến {MAX_QUESTIONS} câu hỏi.</small>}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
