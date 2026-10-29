import type { CSSProperties } from 'react';

import type { AiCallRecord, AiJobRecord, AiModuleDraftRun } from '../../../onboarding/contracts';
import { outlineModuleDisplayTitle } from '../../../onboarding/ai/frame-labels';

export type GenerationHalfState = 'waiting' | 'running' | 'done' | 'fallback';

export interface ModuleProgress {
  readonly lesson: GenerationHalfState;
  readonly questions: GenerationHalfState;
  readonly questionCount: number;
}

export const GENERATING_SUBLINE = 'Giữ cửa sổ này mở trong lúc AI làm việc. Nếu đóng, AI tạm dừng và tiếp tục khi mở lại.';

function liveCall(calls: readonly AiCallRecord[], run: AiModuleDraftRun, target: 'lesson' | 'questions'): boolean {
  return calls.some((call) => call.moduleLocalId === run.outline.moduleLocalId
    && call.moduleTarget === target
    && (call.status === 'pending' || call.status === 'dispatched'));
}

/** What a module's lesson and question chips show; autopilot approves every finished half. */
export function moduleProgress(run: AiModuleDraftRun, calls: readonly AiCallRecord[]): ModuleProgress {
  const lesson: GenerationHalfState = run.lessonState === 'approved'
    ? run.lessonProvenance === 'fallback' ? 'fallback' : 'done'
    : ['drafting', 'validating', 'review_ready', 'fallback_review'].includes(run.lessonState) || liveCall(calls, run, 'lesson')
      ? 'running'
      : 'waiting';
  const questions: GenerationHalfState = run.questionState === 'approved'
    ? run.questionProvenance === 'fallback' ? 'fallback' : 'done'
    : run.questionState === 'drafting' || run.questionState === 'review_ready' || liveCall(calls, run, 'questions')
      ? 'running'
      : 'waiting';
  return { lesson, questions, questionCount: run.questionDraft?.length ?? 0 };
}

function activeRuns(runs: readonly AiModuleDraftRun[]): readonly AiModuleDraftRun[] {
  return runs.filter((run) => !run.outline.tombstoned);
}

/** The rounded share of finished halves: each module has a lesson half and a question half. */
export function generationPercent(runs: readonly AiModuleDraftRun[]): number {
  const active = activeRuns(runs);
  if (active.length === 0) return 0;
  const finished = active.reduce((sum, run) => sum
    + (run.lessonState === 'approved' ? 1 : 0)
    + (run.questionState === 'approved' ? 1 : 0), 0);
  return Math.round(finished / (active.length * 2) * 100);
}

export interface ModuleAttention {
  readonly target: 'lesson' | 'questions';
  readonly expectedVersion: number;
  /** warn = a draft autopilot could not approve; error = AI could not write it. */
  readonly tone: 'warn' | 'error';
  readonly message: string;
}

/**
 * A module autopilot cannot finish by itself once generation has stalled: a draft that did not
 * pass the automatic checks, or a lesson/question set AI could not write and recovery could not fix.
 */
export function moduleAttention(run: AiModuleDraftRun): ModuleAttention | null {
  if (run.outline.tombstoned) return null;
  if (run.lessonState === 'review_ready' || run.lessonState === 'fallback_review') {
    return { target: 'lesson', expectedVersion: run.lessonVersion, tone: 'warn', message: 'Bài học chưa đạt kiểm tra tự động.' };
  }
  if (run.lessonState === 'failed') {
    return { target: 'lesson', expectedVersion: run.lessonVersion, tone: 'error', message: 'AI chưa viết được bài học.' };
  }
  if (run.lessonState !== 'approved') return null;
  if (run.questionState === 'failed') {
    return { target: 'questions', expectedVersion: run.questionVersion, tone: 'error', message: 'AI chưa tạo được câu hỏi.' };
  }
  if (run.questionState === 'review_ready') {
    return { target: 'questions', expectedVersion: run.questionVersion, tone: 'warn', message: 'Câu hỏi chưa đạt kiểm tra tự động.' };
  }
  return null;
}

const CHIP_TONE: Readonly<Record<GenerationHalfState, string>> = {
  waiting: 'wait',
  running: 'run',
  done: 'ok',
  fallback: 'warn',
};

/** The chip of the half a stuck module needs retried, instead of in-progress text. */
const STUCK_CHIP = 'Cần thử lại';

function lessonChip(state: GenerationHalfState): string {
  return { waiting: 'Chờ', running: 'Đang viết…', done: 'Bài học ✓', fallback: 'Bản từ nguồn' }[state];
}

function questionChip(state: GenerationHalfState, count: number): string {
  return { waiting: 'Câu hỏi', running: 'Đang tạo câu hỏi…', done: String(count) + ' câu hỏi ✓', fallback: 'Câu hỏi dự phòng' }[state];
}

export interface AiStepGeneratingProps {
  readonly job: AiJobRecord;
  /** The pump stopped on an approved outline without finishing: stuck modules get a Thử lại. */
  readonly stalled: boolean;
  /** A failure the app could not recover from, already in Vietnamese. */
  readonly error: string | null;
  readonly busy: boolean;
  onRetryModule(moduleLocalId: string, target: 'lesson' | 'questions', expectedVersion: number): void;
  onRetry(): void;
}

/** Bước 3 — AI tạo nội dung: progress per module, no approvals. */
export function AiStepGenerating({ job, stalled, error, busy, onRetryModule, onRetry }: AiStepGeneratingProps) {
  const runs = [...activeRuns(job.moduleRuns ?? [])].sort((left, right) => left.outline.order - right.outline.order);
  const percent = generationPercent(runs);
  // A per-module retry only helps when autopilot approves the rewrite; other jobs retry from the banner.
  const autopilot = job.autoApprove === true;
  const attention = new Map(runs.map((run) => [run.outline.moduleLocalId, stalled && autopilot ? moduleAttention(run) : null] as const));
  const anyAttention = [...attention.values()].some(Boolean);
  return (
    <section className="ai-generating" aria-label="AI tạo nội dung">
      {error ? (
        <div className="ai-generating-banner error" role="alert">
          <span>{error}</span>
          <button className="button button-secondary button-sm" type="button" disabled={busy} onClick={onRetry}>Thử lại</button>
        </div>
      ) : stalled && !anyAttention ? (
        <div className="ai-generating-banner warn" role="status">
          <span>AI đang chờ để làm tiếp.</span>
          <button className="button button-secondary button-sm" type="button" disabled={busy} onClick={onRetry}>Thử lại</button>
        </div>
      ) : null}
      <header className="ai-generating-hero">
        <div
          className="ai-generating-ring"
          role="progressbar"
          aria-label="Tiến độ tạo nội dung"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          style={{ '--ai-progress': String(percent) + '%' } as CSSProperties}
        >
          <span>{percent}%</span>
        </div>
        <div>
          <h3>AI đang viết bài học và câu hỏi</h3>
          <p>{GENERATING_SUBLINE}</p>
        </div>
      </header>
      <ol className="ai-generating-modules">
        {runs.map((run) => {
          const progress = moduleProgress(run, job.calls);
          const issue = attention.get(run.outline.moduleLocalId) ?? null;
          const lessonTone = issue?.target === 'lesson' ? issue.tone : CHIP_TONE[progress.lesson];
          const questionTone = issue?.target === 'questions' ? issue.tone : CHIP_TONE[progress.questions];
          return (
            <li className={'ai-generating-module' + (issue ? ' ' + issue.tone : '')} key={run.outline.moduleLocalId}>
              <span className="ai-coverage-order">{run.outline.order + 1}</span>
              <strong className="ai-generating-title">{outlineModuleDisplayTitle(run.outline)}</strong>
              <span className={'ai-chip ' + lessonTone} title="Bài học">
                {issue?.target === 'lesson' ? STUCK_CHIP : lessonChip(progress.lesson)}
              </span>
              <span className={'ai-chip ' + questionTone} title="Câu hỏi">
                {issue?.target === 'questions' ? STUCK_CHIP : questionChip(progress.questions, progress.questionCount)}
              </span>
              {issue && (
                <div className="ai-generating-attention">
                  <p>{issue.message}</p>
                  <button
                    className="button button-ghost button-sm"
                    type="button"
                    disabled={busy}
                    onClick={() => onRetryModule(run.outline.moduleLocalId, issue.target, issue.expectedVersion)}
                  >Thử lại</button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
