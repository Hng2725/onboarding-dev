import type { OnboardingActor } from '../../src/onboarding/auth';
import type { AiJobRecord } from '../../src/onboarding/contracts';
import type { AiJobService } from '../../src/onboarding/ai/jobs';

/**
 * Drives a new template job's outline planner call (`plan-1`). With no output the planner
 * fails into the deterministic fallback, so the outline stays at revision 1 as before the
 * planner existed; with output the text (or JSON of the value) is submitted as the plan.
 */
export async function completePlan(service: AiJobService, actor: OnboardingActor, job: Pick<AiJobRecord, 'jobId'>, output?: unknown, workerId = 'plan-worker'): Promise<AiJobRecord> {
  const step = await service.nextStep(actor, { jobId: job.jobId, workerId });
  if (step.kind !== 'ai_call' || !step.callId.startsWith('plan-')) throw new Error('Expected the outline planner call, got ' + step.kind + '.');
  if (output === undefined) {
    await service.reportAiFailure(actor, { jobId: job.jobId, workerId, callId: step.callId, kind: 'failed', message: 'Planner skipped in test.' });
  } else {
    await service.submitAiOutput(actor, { jobId: job.jobId, workerId, callId: step.callId, text: typeof output === 'string' ? output : JSON.stringify(output) });
  }
  const current = await service.getJob(actor, job.jobId);
  if (current.planPending) throw new Error('The outline planner is still pending.');
  return current;
}
