import {
  BookOutlined,
  CheckCircleFilled,
  CloseOutlined,
  EditOutlined,
  LinkOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';

import type {
  EmployeeType,
  LessonBlock,
  OnboardingQuestion,
  SourceRef,
  VerificationFlag,
} from '../../../onboarding/contracts';
import type { AiReviewOperation } from '../../../onboarding/ai/review';
import type { AdminTemplateDetail } from '../../../onboarding/templates';
import type { OnboardingApi } from '../api';
import { FlagPanel, type FlagResolutionAction } from './flag-panel';

function SourceButtons({
  refs,
  onOpen,
}: {
  refs: readonly SourceRef[];
  onOpen: (ref: SourceRef) => void;
}) {
  if (refs.length === 0) return null;
  return <div className="ai-source-buttons">{refs.map((ref, index) => (
    <button type="button" key={ref.sourceId + ':' + ref.sectionId + ':' + index} onClick={() => onOpen(ref)}>
      <LinkOutlined /> Nguồn {ref.page ? '· trang ' + ref.page : index + 1}
    </button>
  ))}</div>;
}

function BlockEditor({
  moduleId,
  block,
  busy,
  onSave,
  onOpenSource,
}: {
  moduleId: string;
  block: LessonBlock;
  busy: boolean;
  onSave: (operation: AiReviewOperation) => void;
  onOpenSource: (ref: SourceRef) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(block.title ?? '');
  const [body, setBody] = useState(block.body);
  useEffect(() => {
    setTitle(block.title ?? '');
    setBody(block.body);
  }, [block]);
  return (
    <article className={block.pendingVerification ? 'ai-lesson-block pending' : 'ai-lesson-block'}>
      <header>
        <span>{block.kind}</span>
        {block.pendingVerification && <em>Đang chờ xác minh</em>}
        <button className="icon-button" type="button" aria-label="Sửa khối nội dung" disabled={busy} onClick={() => setEditing((value) => !value)}><EditOutlined /></button>
      </header>
      {editing ? (
        <div className="ai-inline-editor">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Tiêu đề khối" />
          <textarea rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
          <button
            className="button button-primary"
            type="button"
            disabled={busy || !body.trim()}
            onClick={() => {
              onSave({ kind: 'update_block', moduleId, blockId: block.id, title, body });
              setEditing(false);
            }}
          ><SaveOutlined /> Lưu nội dung</button>
        </div>
      ) : (
        <>
          {block.title && <h4>{block.title}</h4>}
          <p className="ai-block-body">{block.body}</p>
          {block.steps && <ol>{block.steps.map((step) => <li key={step.order}>{step.text}</li>)}</ol>}
        </>
      )}
      <SourceButtons refs={block.sourceRefs} onOpen={onOpenSource} />
    </article>
  );
}

function QuestionReview({
  question,
  refs,
  busy,
  onSave,
  onOpenSource,
}: {
  question: OnboardingQuestion;
  refs: readonly SourceRef[];
  busy: boolean;
  onSave: (operation: AiReviewOperation) => void;
  onOpenSource: (ref: SourceRef) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(question.prompt);
  const [explanation, setExplanation] = useState(question.explanation ?? '');
  const [correctOptionId, setCorrectOptionId] = useState(question.correctOptionIds?.[0] ?? '');
  useEffect(() => {
    setPrompt(question.prompt);
    setExplanation(question.explanation ?? '');
    setCorrectOptionId(question.correctOptionIds?.[0] ?? '');
  }, [question]);
  return (
    <article className="ai-question-review">
      <header><span>Câu hỏi</span><button className="icon-button" type="button" aria-label="Sửa câu hỏi" disabled={busy} onClick={() => setEditing((value) => !value)}><EditOutlined /></button></header>
      {editing ? (
        <div className="ai-inline-editor">
          <textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <div className="ai-answer-editor">{question.options?.map((option) => (
            <label key={option.id}>
              <input type="radio" checked={correctOptionId === option.id} onChange={() => setCorrectOptionId(option.id)} />
              <span>{option.label}</span>
            </label>
          ))}</div>
          <textarea rows={3} value={explanation} onChange={(event) => setExplanation(event.target.value)} placeholder="Giải thích đáp án" />
          <button
            className="button button-primary"
            type="button"
            disabled={busy || !prompt.trim() || !correctOptionId}
            onClick={() => {
              onSave({
                kind: 'update_question',
                questionId: question.id,
                prompt,
                correctOptionId,
                explanation,
              });
              setEditing(false);
            }}
          ><SaveOutlined /> Lưu câu hỏi</button>
        </div>
      ) : (
        <>
          <h4>{question.prompt}</h4>
          <div className="ai-answer-list">{question.options?.map((option) => (
            <span className={question.correctOptionIds?.includes(option.id) ? 'correct' : ''} key={option.id}>
              {question.correctOptionIds?.includes(option.id) && <CheckCircleFilled />} {option.label}
            </span>
          ))}</div>
          {question.explanation && <p className="ai-question-explanation">{question.explanation}</p>}
        </>
      )}
      <SourceButtons refs={refs} onOpen={onOpenSource} />
    </article>
  );
}

export function AiReview({
  api,
  review,
  busy,
  sequence,
  onUpdated,
  onResolve,
}: {
  api: OnboardingApi;
  review: AdminTemplateDetail;
  busy: boolean;
  sequence?: { readonly index: number; readonly total: number; readonly kind: EmployeeType };
  onUpdated: (ops: readonly AiReviewOperation[]) => void;
  onResolve: (
    flag: VerificationFlag,
    action: FlagResolutionAction,
    note?: string,
    chosenEvidenceIndex?: number,
  ) => void;
}) {
  const [selectedModuleId, setSelectedModuleId] = useState(review.modules[0]?.id ?? '');
  const [activePane, setActivePane] = useState<'lessons' | 'questions'>('lessons');
  const [flagsCollapsed, setFlagsCollapsed] = useState(false);
  const [sourceView, setSourceView] = useState<{ fileName: string; text: string; quote: string } | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  useEffect(() => {
    if (!review.modules.some((module) => module.id === selectedModuleId)) {
      setSelectedModuleId(review.modules[0]?.id ?? '');
    }
  }, [review, selectedModuleId]);
  useEffect(() => setActivePane('lessons'), [selectedModuleId]);
  const selectedModule = review.modules.find((module) => module.id === selectedModuleId);
  const contentModule = review.content?.modules.find((module) => module.moduleId === selectedModuleId);
  const questionMeta = useMemo(
    () => new Map(review.content?.questionMeta.map((meta) => [meta.questionId, meta]) ?? []),
    [review.content],
  );
  const flags = review.flags ?? [];
  const openFlags = flags.filter((flag) => flag.status === 'open').length;
  const blockingFlags = flags.filter(
    (flag) => flag.status === 'open' && flag.severity === 'blocking',
  ).length;

  async function openSource(ref: SourceRef) {
    setSourceError(null);
    try {
      const result = await api.adminAi<{
        fileName: string;
        section: { text: string };
      }>('get_source_section', { sourceId: ref.sourceId, sectionId: ref.sectionId });
      setSourceView({ fileName: result.fileName, text: result.section.text, quote: ref.quote });
    } catch (caught) {
      setSourceError(caught instanceof Error ? caught.message : 'Không thể mở nguồn.');
    }
  }

  return (
    <div className="ai-review-shell">
      <header className="ai-review-sequence">
        <div>
          {sequence && (
            <span className="ai-sequence-badge">
              Template {sequence.index + 1}/{sequence.total} · {sequence.kind === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}
            </span>
          )}
          <h3>{review.title}</h3>
        </div>
        <span>{blockingFlags > 0 ? `${blockingFlags} cờ bắt buộc` : 'Không còn cờ bắt buộc'}</span>
      </header>
      <div className={'ai-review-layout' + (flagsCollapsed ? ' flags-collapsed' : '')}>
        <nav className="ai-module-nav" aria-label="Module template AI">
          <header><span className="section-kicker">CẤU TRÚC</span><h3>{review.modules.length} module</h3></header>
          {review.modules.map((module, index) => {
            const moduleOpenFlags = flags.filter(
              (flag) => flag.status === 'open' && flag.location.moduleId === module.id,
            ).length;
            return (
              <button
                className={module.id === selectedModuleId ? 'active' : ''}
                type="button"
                key={module.id}
                onClick={() => setSelectedModuleId(module.id)}
              >
                <span>{index + 1}</span>
                <span><strong>{module.title}</strong><small>{module.questions.length} câu hỏi</small></span>
                {moduleOpenFlags > 0 && <em>{moduleOpenFlags}</em>}
              </button>
            );
          })}
        </nav>
        <main className="ai-review-content">
          {selectedModule && contentModule ? (
            <>
              <header className="ai-review-module-heading">
                <div><span className="section-kicker">NỘI DUNG MODULE</span><h3>{selectedModule.title}</h3><p>{selectedModule.description}</p></div>
                <span><BookOutlined /> {contentModule.estimatedMinutes} phút</span>
              </header>
              <div className="ai-review-tabs" role="tablist" aria-label="Nội dung rà soát">
                <button
                  className={activePane === 'lessons' ? 'active' : ''}
                  type="button"
                  role="tab"
                  aria-selected={activePane === 'lessons'}
                  onClick={() => setActivePane('lessons')}
                >Tài liệu học ({contentModule.blocks.length})</button>
                <button
                  className={activePane === 'questions' ? 'active' : ''}
                  type="button"
                  role="tab"
                  aria-selected={activePane === 'questions'}
                  onClick={() => setActivePane('questions')}
                >Câu hỏi ({selectedModule.questions.length})</button>
              </div>
              {activePane === 'lessons' ? (
                <section className="ai-review-blocks" role="tabpanel">
                  {contentModule.blocks.map((block) => (
                    <BlockEditor
                      key={block.id}
                      moduleId={selectedModule.id}
                      block={block}
                      busy={busy}
                      onSave={(operation) => onUpdated([operation])}
                      onOpenSource={(ref) => void openSource(ref)}
                    />
                  ))}
                </section>
              ) : (
                <section className="ai-review-questions" role="tabpanel">
                  {selectedModule.questions.map((question) => (
                    <QuestionReview
                      key={question.id}
                      question={question}
                      refs={questionMeta.get(question.id)?.sourceRefs ?? []}
                      busy={busy}
                      onSave={(operation) => onUpdated([operation])}
                      onOpenSource={(ref) => void openSource(ref)}
                    />
                  ))}
                </section>
              )}
            </>
          ) : <div className="ai-source-empty"><span>Không tìm thấy nội dung module.</span></div>}
        </main>
        <aside className="ai-verification-column">
          <button
            className="ai-verification-toggle"
            type="button"
            aria-expanded={!flagsCollapsed}
            onClick={() => setFlagsCollapsed((value) => !value)}
          >
            <span>Kiểm chứng</span>
            <strong>{blockingFlags} cờ bắt buộc</strong>
            <small>{openFlags} đang mở · {flagsCollapsed ? 'Mở rộng' : 'Thu gọn'}</small>
          </button>
          {!flagsCollapsed && <FlagPanel flags={flags} busy={busy} onResolve={onResolve} />}
        </aside>
        {(sourceView || sourceError) && (
          <div className="ai-source-popover" role="dialog" aria-label="Nguồn đối chiếu">
            <header><strong>{sourceView?.fileName ?? 'Không thể mở nguồn'}</strong><button className="icon-button" type="button" aria-label="Đóng nguồn" onClick={() => { setSourceView(null); setSourceError(null); }}><CloseOutlined /></button></header>
            {sourceError ? <p>{sourceError}</p> : <><blockquote>{sourceView?.quote}</blockquote><p>{sourceView?.text}</p></>}
          </div>
        )}
      </div>
    </div>
  );
}