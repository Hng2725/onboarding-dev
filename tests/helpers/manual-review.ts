import type { AiJobRecord } from '../../src/onboarding/contracts';
import type { OnboardingStore } from '../../src/onboarding/store';

/**
 * New template jobs run on autopilot. Tests of the Admin's per-module review flow turn a started
 * job back into a pre-autopilot job, which keeps the manual approve actions and question deferral.
 */
export async function useManualReview(store: Pick<OnboardingStore, 'update'>, job: Pick<AiJobRecord, 'id' | 'roomId'>): Promise<void> {
  await store.update(job.roomId, 'onboarding_ai_jobs', job.id, { autoApprove: false });
}
