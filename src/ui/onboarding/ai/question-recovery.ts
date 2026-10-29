import type { AiJobRecord, AiModuleDraftRun } from '../../../onboarding/contracts';

export type QuestionRecoveryDecision =
  | { readonly kind: 'retry_native'; readonly moduleLocalId: string; readonly expectedVersion: number }
  | { readonly kind: 'use_fallback'; readonly moduleLocalId: string; readonly expectedVersion: number }
  | null;

type RecoveryAction = 'retry_module' | 'use_question_fallback';

interface QuestionRecoveryOptions {
  readonly initialJob: AiJobRecord;
  readonly nativeAvailable: boolean;
  readonly initialPreferNative: boolean;
  readonly pumpOnce: (job: AiJobRecord, preferNative: boolean) => Promise<AiJobRecord>;
  readonly runAction: (
    action: RecoveryAction,
    args: Record<string, unknown>,
  ) => Promise<{ readonly job: AiJobRecord }>;
}

export function shouldUseNativeForPump(
  job: AiJobRecord,
  explicitlyPreferred: boolean,
  persistedPreference: boolean,
): boolean {
  if (explicitlyPreferred) return true;
  return !(job.kind === 'template' && job.pipelineVersion === 'module_v2')
    && persistedPreference;
}

export function shouldBoundNativeQuestionPoll(
  job: AiJobRecord,
  useNative: boolean,
  explicitlyPreferred: boolean,
): boolean {
  const activeQuestions = (job.moduleRuns ?? []).filter(
    (run) => run.questionState === 'queued' || run.questionState === 'drafting',
  );
  if (activeQuestions.length === 0) return false;
  if (useNative && explicitlyPreferred) return true;
  return activeQuestions.some((run) => job.calls.some((call) =>
    call.provider === 'native_chat'
    && call.moduleTarget === 'questions'
    && call.moduleLocalId === run.outline.moduleLocalId
    && call.moduleVersion === run.questionVersion
    && (call.status === 'pending' || call.status === 'dispatched')));
}

function hasGroundedLesson(run: AiModuleDraftRun): boolean {
  return run.lessonDraft?.blocks.some(
    (block) => block.kind !== 'summary' && block.sourceRefs.length > 0,
  ) ?? false;
}

function failedQuestionCalls(job: AiJobRecord, run: AiModuleDraftRun) {
  return job.calls.filter((call) =>
    (call.status === 'failed' || call.status === 'invalid')
    && call.moduleLocalId === run.outline.moduleLocalId
    && call.moduleTarget === 'questions'
    && call.moduleVersion === run.questionVersion);
}

export function planQuestionRecovery(
  job: AiJobRecord,
  nativeAvailable: boolean,
): QuestionRecoveryDecision {
  if (job.kind !== 'template' || job.pipelineVersion !== 'module_v2' || job.status !== 'running') {
    return null;
  }

  for (const run of job.moduleRuns ?? []) {
    if (
      run.lessonState !== 'approved'
      || run.questionState !== 'failed'
      || !hasGroundedLesson(run)
    ) continue;

    const calls = failedQuestionCalls(job, run);
    if (calls.length === 0) continue;
    const decision = {
      moduleLocalId: run.outline.moduleLocalId,
      expectedVersion: run.questionVersion,
    };
    if (calls.some((call) => call.provider === 'native_chat')) {
      return { kind: 'use_fallback', ...decision };
    }
    if (calls.some((call) => call.provider === 'sandbox')) {
      return nativeAvailable
        ? { kind: 'retry_native', ...decision }
        : { kind: 'use_fallback', ...decision };
    }
  }
  return null;
}

function hasCurrentNativeFailure(job: AiJobRecord): boolean {
  return (job.moduleRuns ?? []).some((run) =>
    run.questionState === 'failed'
    && failedQuestionCalls(job, run).some((call) => call.provider === 'native_chat'));
}

async function applyRecovery(
  options: QuestionRecoveryOptions,
  decision: Exclude<QuestionRecoveryDecision, null>,
): Promise<AiJobRecord> {
  if (decision.kind === 'retry_native') {
    return (await options.runAction('retry_module', {
      moduleLocalId: decision.moduleLocalId,
      target: 'questions',
      expectedVersion: decision.expectedVersion,
    })).job;
  }
  return (await options.runAction('use_question_fallback', {
    moduleLocalId: decision.moduleLocalId,
    expectedVersion: decision.expectedVersion,
  })).job;
}

export async function pumpWithQuestionRecovery(
  options: QuestionRecoveryOptions,
): Promise<AiJobRecord> {
  let current = options.initialJob;
  let preferNative = options.initialPreferNative;

  // A refreshed modal can already contain the completed Native failure. Recover it
  // before selecting a gateway so a stale cleanup fence cannot block the safe fallback.
  const persisted = planQuestionRecovery(current, options.nativeAvailable);
  if (persisted?.kind === 'use_fallback' && hasCurrentNativeFailure(current)) {
    return applyRecovery(options, persisted);
  }

  // At most two provider passes are allowed: the current Sandbox pass and one Native pass.
  for (let pass = 0; pass < 2; pass += 1) {
    current = await options.pumpOnce(current, preferNative);
    const decision = planQuestionRecovery(current, options.nativeAvailable);
    if (!decision) return current;
    current = await applyRecovery(options, decision);
    if (decision.kind === 'use_fallback') return current;
    preferNative = true;
  }
  return current;
}
