import { useState, type ReactNode } from 'react';

import type { GeneratedBlock, GeneratedModule, GeneratedQuestion } from '../../../onboarding/ai/validate';
import { BLOCK_KIND_LABELS, QUESTION_LEVEL_LABELS } from './ai-labels';

type RawRef = { readonly sectionId: string; readonly quote: string };

const BLOCK_KINDS = Object.keys(BLOCK_KIND_LABELS) as GeneratedBlock['kind'][];
const QUESTION_LEVELS = Object.keys(QUESTION_LEVEL_LABELS) as GeneratedQuestion['level'][];

/** Vietnamese label of a block kind; an unknown kind never shows its raw id. */
export function blockKindLabel(kind: string): string {
  return (BLOCK_KIND_LABELS as Readonly<Record<string, string>>)[kind] ?? 'Nội dung';
}

/** Vietnamese label of a question level; an unknown level never shows its raw id. */
export function questionLevelLabel(level: string): string {
  return (QUESTION_LEVEL_LABELS as Readonly<Record<string, string>>)[level] ?? 'Câu hỏi';
}

/**
 * A short citation such as "Sổ tay · mục 1": the source file (without extension) and the
 * section number of `sourceId#sN`. Without a known file name it falls back to "Nguồn N".
 */
export function citationLabel(ref: RawRef, index: number, sourceNames?: ReadonlyMap<string, string>): string {
  const hash = ref.sectionId.lastIndexOf('#');
  const sourceId = hash > 0 ? ref.sectionId.slice(0, hash) : '';
  const section = /#s(\d+)$/.exec(ref.sectionId)?.[1];
  const fileName = sourceNames?.get(sourceId)?.trim();
  const name = fileName ? fileName.replace(/\.[^./]+$/, '') : 'Nguồn ' + String(index + 1);
  return section ? name + ' · mục ' + section : name;
}

export function CitationChips({
  refs,
  sourceNames,
}: {
  refs: readonly RawRef[];
  sourceNames?: ReadonlyMap<string, string>;
}) {
  if (refs.length === 0) return null;
  return (
    <span className="ai-cite-list">
      {refs.map((ref, index) => (
        <span className="ai-cite" key={ref.sectionId + ':' + String(index)} title={ref.quote}>{citationLabel(ref, index, sourceNames)}</span>
      ))}
    </span>
  );
}

export function LessonReadView({
  lesson,
  sourceNames,
}: {
  lesson: GeneratedModule;
  sourceNames?: ReadonlyMap<string, string>;
}) {
  return (
    <section className="ai-module-reading" aria-label="Nội dung bài học">
      <header>
        <div>
          <h4>{lesson.title}</h4>
          <p className="ai-module-reading-meta">{lesson.estimatedMinutes} phút · {lesson.objectives.length} mục tiêu học tập</p>
          {lesson.description && <p>{lesson.description}</p>}
        </div>
      </header>
      {lesson.objectives.length > 0 && <div><strong>Mục tiêu</strong><ul>{lesson.objectives.map((objective) => <li key={objective}>{objective}</li>)}</ul></div>}
      {lesson.blocks.length > 0 ? lesson.blocks.map((block, index) => (
        <article className="ai-module-reading-block" key={block.localId}>
          <small>{index + 1}. {blockKindLabel(block.kind)}</small>
          {block.title && <h4>{block.title}</h4>}
          <p>{block.body}<CitationChips refs={block.sourceRefs} sourceNames={sourceNames} /></p>
          {block.steps && <ol>{block.steps.map((step) => <li key={step.order}>{step.text}</li>)}</ol>}
        </article>
      )) : <p>Chưa có nội dung bài học. Chọn Chỉnh sửa để tự soạn.</p>}
    </section>
  );
}

export function QuestionReadView({
  questions,
  sourceNames,
}: {
  questions: readonly GeneratedQuestion[];
  sourceNames?: ReadonlyMap<string, string>;
}) {
  return (
    <section className="ai-module-reading ai-module-question-reading" aria-label="Nội dung câu hỏi">
      {questions.length > 0 ? questions.map((question, index) => (
        <article key={question.localId}>
          <small>Câu {index + 1} · {questionLevelLabel(question.level)}</small>
          <h4>{question.prompt}</h4>
          <div>{question.options.map((option) => (
            <span className={option.id === question.correctOptionId ? 'correct' : ''} key={option.id}>
              {option.id.toUpperCase()}. {option.label}
            </span>
          ))}</div>
          {question.explanation && <p>{question.explanation}<CitationChips refs={question.sourceRefs} sourceNames={sourceNames} /></p>}
          {!question.explanation && <CitationChips refs={question.sourceRefs} sourceNames={sourceNames} />}
        </article>
      )) : <p>Chưa có câu hỏi để rà soát.</p>}
    </section>
  );
}

export function LessonEditor({
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
            <summary><strong>{index + 1}. {block.title || block.body.slice(0, 90) || 'Nội dung mới'}</strong><small>{blockKindLabel(block.kind)} · {block.sourceRefs.length} dẫn chứng</small></summary>
            <fieldset>
              <legend>Nội dung {index + 1}</legend>
              <label>Loại<select value={block.kind} onChange={(event) => onPatchBlock(index, { kind: event.target.value as GeneratedBlock['kind'] })}>{BLOCK_KINDS.map((kind) => <option key={kind} value={kind}>{BLOCK_KIND_LABELS[kind]}</option>)}</select></label>
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

export function QuestionEditor({
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
            <summary><strong>{index + 1}. {question.prompt || 'Câu hỏi mới'}</strong><small>{questionLevelLabel(question.level)} · {question.options.length} đáp án</small></summary>
            <fieldset>
              <legend>Câu hỏi {index + 1}</legend>
              <label>Mức độ<select value={question.level} onChange={(event) => onPatch(index, { level: event.target.value as GeneratedQuestion['level'] })}>{QUESTION_LEVELS.map((level) => <option key={level} value={level}>{QUESTION_LEVEL_LABELS[level]}</option>)}</select></label>
              <label>Câu hỏi<textarea value={question.prompt} onChange={(event) => onPatch(index, { prompt: event.target.value })} /></label>
              {question.options.map((option, optionIndex) => (
                <label key={option.id}>Đáp án {option.id.toUpperCase()}<input value={option.label} onChange={(event) => onPatch(index, { options: question.options.map((item, itemIndex) => itemIndex === optionIndex ? { ...item, label: event.target.value } : item) })} /></label>
              ))}
              <label>Đáp án đúng<select value={question.correctOptionId} onChange={(event) => onPatch(index, { correctOptionId: event.target.value })}>{question.options.map((option) => <option key={option.id} value={option.id}>{option.id.toUpperCase()}</option>)}</select></label>
              <label>Giải thích<textarea value={question.explanation} onChange={(event) => onPatch(index, { explanation: event.target.value })} /></label>
              <div><strong>Nội dung liên quan</strong>{lesson.blocks.map((block, blockIndex) => (
                <label key={block.localId}><input type="checkbox" checked={question.blockIds.includes(block.localId)} onChange={(event) => onPatch(index, { blockIds: event.target.checked ? [...question.blockIds, block.localId] : question.blockIds.filter((value) => value !== block.localId) })} /> {block.title || block.body.slice(0, 60) || 'Nội dung ' + String(blockIndex + 1)}</label>
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

export function SourceRefs({
  refs,
  onChange,
}: {
  refs: readonly RawRef[];
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
