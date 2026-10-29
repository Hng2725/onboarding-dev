import { useEffect, useState } from 'react';

import type { AiCallRecord, AiJobRecord } from '../../../onboarding/contracts';
import {
  aiCallDisplayLabel,
  aiCallRuntimeText,
  aiJobCurrentCall,
} from './ai-generator';
import { isSandboxWorkerCrash } from './inventory-recovery';

export type AiMilestoneStatus = 'pending' | 'active' | 'completed' | 'failed';

export interface AiMilestone {
  readonly id: string;
  readonly label: string;
  readonly status: AiMilestoneStatus;
  readonly detail?: string;
}

function rootCallId(callId: string): string {
  return callId.replace(/-(?:retry|r)\d+$/u, '');
}

function matchingCalls(
  job: AiJobRecord | null | undefined,
  matches: (rootId: string) => boolean,
): readonly AiCallRecord[] {
  return job?.calls.filter((call) => matches(rootCallId(call.callId))) ?? [];
}

function rootsComplete(calls: readonly AiCallRecord[]): boolean {
  if (calls.length === 0) return false;
  const roots = new Map<string, boolean>();
  for (const call of calls) {
    const root = rootCallId(call.callId);
    roots.set(root, (roots.get(root) ?? false) || call.status === 'completed');
  }
  return [...roots.values()].every(Boolean);
}

function currentCall(job: AiJobRecord | null | undefined): AiCallRecord | undefined {
  return job ? aiJobCurrentCall(job) : undefined;
}

function callStatus(
  job: AiJobRecord | null | undefined,
  call: AiCallRecord | undefined,
  matches: (rootId: string) => boolean,
): AiMilestoneStatus | undefined {
  if (!call || !matches(rootCallId(call.callId))) return undefined;
  return job?.status === 'failed' ? 'failed' : 'active';
}

function callDetail(
  job: AiJobRecord | null | undefined,
  call: AiCallRecord | undefined,
  matches: (rootId: string) => boolean,
): string | undefined {
  return call && job && matches(rootCallId(call.callId))
    ? aiCallDisplayLabel(call, job.calls)
    : undefined;
}

function inventoryAnalysisDetail(
  job: AiJobRecord | null | undefined,
  call: AiCallRecord | undefined,
  matches: (rootId: string) => boolean,
): string | undefined {
  const detail = callDetail(job, call, matches);
  if (!detail || !job || !call) return detail;
  const nativeRetry = call.provider === 'native_chat'
    || call.attemptRef?.startsWith('native-chat:') === true;
  const sandboxCrashed = job.calls.some((candidate) =>
    candidate.callId !== call.callId
    && matches(rootCallId(candidate.callId))
    && isSandboxWorkerCrash(candidate, job.errorMessage));
  return nativeRetry && sandboxCrashed
    ? detail + ' · Sandbox lỗi, đang chuyển sang Native AI Chat'
    : detail;
}

export function inventoryMilestones(
  job: AiJobRecord | null | undefined,
  sourceCount: number,
): readonly AiMilestone[] {
  if (job?.status === 'completed') {
    return [
      { id: 'prepare', label: 'Chuẩn bị nguồn tài liệu', status: 'completed' },
      { id: 'analysis', label: 'Phân tích từng lô nguồn', status: 'completed' },
      { id: 'merge', label: 'Hợp nhất kho kiến thức', status: 'completed' },
      { id: 'ready', label: 'Sẵn sàng tạo lộ trình', status: 'completed' },
    ];
  }

  const isAnalysis = (root: string) => /^A\d+$/u.test(root);
  const analysisCalls = matchingCalls(job, isAnalysis);
  const current = currentCall(job);
  const analysisComplete = rootsComplete(analysisCalls);
  const currentAnalysisStatus = callStatus(job, current, isAnalysis);
  const analysisStatus: AiMilestoneStatus = currentAnalysisStatus
    ?? (analysisComplete ? 'completed' : sourceCount > 0 || job ? 'active' : 'pending');
  const mergeStatus: AiMilestoneStatus = analysisComplete
    ? (job?.status === 'failed' ? 'failed' : 'active')
    : 'pending';

  return [
    {
      id: 'prepare',
      label: 'Chuẩn bị nguồn tài liệu',
      status: sourceCount > 0 || job ? 'completed' : 'active',
    },
    {
      id: 'analysis',
      label: 'Phân tích từng lô nguồn',
      status: analysisStatus,
      ...(currentAnalysisStatus ? { detail: inventoryAnalysisDetail(job, current, isAnalysis) } : {}),
    },
    { id: 'merge', label: 'Hợp nhất kho kiến thức', status: mergeStatus },
    { id: 'ready', label: 'Sẵn sàng tạo lộ trình', status: 'pending' },
  ];
}

export function templateMilestones(
  job: AiJobRecord | null | undefined,
): readonly AiMilestone[] {
  if (job?.pipelineVersion === 'module_v2') {
    const runs = (job.moduleRuns ?? []).filter((run) => !run.outline.tombstoned);
    const approved = job.outline?.revision === job.outlineApprovedRevision;
    const documents = runs.filter((run) => Boolean(run.lessonDraft)).length;
    const approvedQuestions = runs.filter((run) => run.questionState === 'approved').length;
    const lessonDone = runs.length > 0 && runs.every((run) => run.lessonState === 'approved');
    const questionDone = lessonDone && runs.every((run) => run.questionState === 'approved');
    return [
      { id: 'outline', label: 'Khung lộ trình', status: approved ? 'completed' : 'active' },
      { id: 'lessons', label: 'Viết và duyệt tài liệu học', status: lessonDone ? 'completed' : approved ? 'active' : 'pending', detail: documents + '/' + runs.length + ' module có tài liệu' },
      { id: 'questions', label: 'Tạo và duyệt câu hỏi', status: questionDone ? 'completed' : lessonDone ? 'active' : 'pending', detail: approvedQuestions + '/' + runs.length + ' module đã duyệt câu hỏi' },
      { id: 'ready', label: 'Sẵn sàng xuất bản', status: job.status === 'completed' ? 'completed' : questionDone ? 'active' : 'pending' },
    ];
  }
  const completed = job?.status === 'completed';
  if (completed) {
    return [
      { id: 'outline', label: 'Khung lộ trình', status: 'completed' },
      { id: 'lessons', label: 'Viết tài liệu học', status: 'completed' },
      { id: 'questions', label: 'Tạo câu hỏi kiểm tra', status: 'completed' },
      { id: 'ready', label: 'Sẵn sàng xuất bản', status: 'completed' },
    ];
  }

  const isLessons = (root: string) => /^(?:B|C)-lessons$/u.test(root);
  const isQuestions = (root: string) => /^(?:B|C)-questions$/u.test(root);
  const isVerification = (root: string) => /^D\d+$/u.test(root);
  const lessonComplete = rootsComplete(matchingCalls(job, isLessons));
  const questionComplete = rootsComplete(matchingCalls(job, isQuestions));
  const verificationCalls = matchingCalls(job, isVerification);
  const verificationComplete = rootsComplete(verificationCalls);
  const current = currentCall(job);

  const stage = (
    matches: (root: string) => boolean,
    isComplete: boolean,
    ready: boolean,
  ): Pick<AiMilestone, 'status' | 'detail'> => {
    const currentStatus = callStatus(job, current, matches);
    if (currentStatus) {
      return { status: currentStatus, detail: callDetail(job, current, matches) };
    }
    if (isComplete) return { status: 'completed' };
    return { status: ready ? 'active' : 'pending' };
  };

  const lessons = stage(isLessons, lessonComplete, Boolean(job));
  const questions = stage(isQuestions, questionComplete, lessonComplete);
  const ready = stage(isVerification, false, questionComplete);
  const readyStatus = verificationComplete
    ? { status: job?.status === 'failed' ? 'failed' as const : 'active' as const }
    : ready;

  return [
    { id: 'outline', label: 'Khung lộ trình', status: job ? 'completed' : 'active' },
    { id: 'lessons', label: 'Viết tài liệu học', ...lessons },
    { id: 'questions', label: 'Tạo câu hỏi kiểm tra', ...questions },
    { id: 'ready', label: 'Kiểm chứng và sẵn sàng xuất bản', ...readyStatus },
  ];
}

const STATUS_ICONS: Readonly<Record<AiMilestoneStatus, string>> = {
  pending: '○',
  active: '●',
  completed: '✓',
  failed: '!',
};

export function AiMilestoneProgress({
  label,
  job,
  milestones,
}: {
  readonly label: string;
  readonly job: AiJobRecord | null;
  readonly milestones: readonly AiMilestone[];
}) {
  const current = currentCall(job);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (current?.status !== 'dispatched') return undefined;
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, [current?.callId, current?.status]);

  const runtime = current ? aiCallRuntimeText(current, nowMs) : null;
  const failedCall = job?.status === 'failed' ? current : undefined;
  const failureProvider = failedCall?.provider === 'native_chat'
    || failedCall?.attemptRef?.startsWith('native-chat:')
    ? 'Native AI Chat'
    : failedCall?.provider === 'sandbox' || failedCall?.attemptRef ? 'Sandbox' : 'Không xác định';
  const failureMessage = failedCall?.errors?.find((message) => message.trim())
    ?? job?.errorMessage
    ?? 'PrivOS không trả về thông báo lỗi.';
  const compact = job?.status !== 'failed' && milestones.length > 0 && milestones.every((milestone) => milestone.status === 'completed');
  return (
    <section className={`ai-milestone-progress${compact ? ' compact' : ''}`} aria-label={label}>
      <header className="ai-milestone-header">
        <strong>{label}</strong>
        {runtime && <small>{runtime}</small>}
      </header>
      <ol className="ai-milestone-list">
        {milestones.map((milestone) => (
          <li
            className="ai-milestone-item"
            data-status={milestone.status}
            aria-current={milestone.status === 'active' ? 'step' : undefined}
            key={milestone.id}
          >
            <span className="ai-milestone-icon" aria-hidden="true">
              {STATUS_ICONS[milestone.status]}
            </span>
            <span className="ai-milestone-copy">
              <strong>{milestone.label}</strong>
              {milestone.detail && <small>{milestone.detail}</small>}
            </span>
          </li>
        ))}
      </ol>
      {failedCall && job && (
        <details className="ai-failure-log" open>
          <summary>Chi tiết lỗi kỹ thuật</summary>
          <dl>
            <div><dt>Job</dt><dd><code>{job.jobId}</code></dd></div>
            <div><dt>Bước</dt><dd>{aiCallDisplayLabel(failedCall, job.calls)}</dd></div>
            <div><dt>Call</dt><dd><code>{failedCall.callId}</code></dd></div>
            <div><dt>Nhà cung cấp</dt><dd>{failureProvider}</dd></div>
            <div><dt>Attempt</dt><dd><code>{failedCall.attemptRef ?? 'Chưa được tạo'}</code></dd></div>
            <div><dt>Mã lỗi</dt><dd><code>{failedCall.providerErrorCode ?? job.errorCode ?? 'AI_FAILED'}</code></dd></div>
            {failedCall.providerPhase && <div><dt>Phase</dt><dd><code>{failedCall.providerPhase}</code></dd></div>}
            {failedCall.finishedAt && <div><dt>Thời điểm</dt><dd><time dateTime={failedCall.finishedAt}>{failedCall.finishedAt}</time></dd></div>}
            <div><dt>Thông báo</dt><dd>{failureMessage}</dd></div>
            {failedCall.diagnosticError && <div><dt>Thu thập log</dt><dd>{failedCall.diagnosticError}</dd></div>}
          </dl>
        </details>
      )}
    </section>
  );
}
