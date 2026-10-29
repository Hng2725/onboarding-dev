import type { AiJobRecord } from '../../../onboarding/contracts';
import type { AdminTemplateDetail } from '../../../onboarding/templates';
import type { AiPublishTarget } from './ai-publish-batch';
import type { AiTemplateRun } from './ai-template-batch';

export interface AiGeneratorResetTemplateRef {
  readonly templateId: string;
  readonly version: number;
}

function templateRef(value: unknown): AiGeneratorResetTemplateRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.templateId === 'string' && record.templateId.trim()
    && typeof record.version === 'number' && Number.isInteger(record.version) && record.version > 0
    ? { templateId: record.templateId, version: record.version }
    : undefined;
}

function reviewRef(review: AdminTemplateDetail | null | undefined): AiGeneratorResetTemplateRef | undefined {
  return review ? { templateId: review.id, version: review.version } : undefined;
}

export function collectAiGeneratorResetTemplateRefs(
  runs: readonly AiTemplateRun[],
  publishTargets: readonly AiPublishTarget[],
): readonly AiGeneratorResetTemplateRef[] {
  const candidates = [
    ...runs.flatMap((run) => [
      reviewRef(run.review),
      templateRef(run.publicationTarget),
      templateRef(run.job?.result),
    ]),
    ...publishTargets.flatMap((target) => [
      reviewRef(target.review),
      reviewRef(target.preparedReview),
      reviewRef(target.publishedTemplate),
    ]),
  ];
  return [...new Map(candidates
    .filter((ref): ref is AiGeneratorResetTemplateRef => Boolean(ref))
    .map((ref) => [`${ref.templateId}:${ref.version}`, ref])).values()];
}

export async function loadAiGeneratorResetReviews(input: {
  readonly refs: readonly AiGeneratorResetTemplateRef[];
  readonly getReview: (ref: AiGeneratorResetTemplateRef) => Promise<AdminTemplateDetail>;
  readonly isMissing: (error: unknown) => boolean;
}): Promise<readonly AdminTemplateDetail[]> {
  const refs = new Map(input.refs.map((ref) => [`${ref.templateId}:${ref.version}`, ref]));
  const reviews: AdminTemplateDetail[] = [];
  for (const ref of refs.values()) {
    try {
      reviews.push(await input.getReview(ref));
    } catch (error) {
      if (!input.isMissing(error)) throw error;
    }
  }
  return reviews;
}

export interface AiGeneratorServerResetInput {
  readonly jobs: readonly AiJobRecord[];
  readonly reviews: readonly AdminTemplateDetail[];
  readonly cancelJob: (job: AiJobRecord) => Promise<{ readonly unconfirmed: number }>;
  readonly deleteDraft: (review: AdminTemplateDetail) => Promise<void>;
}

export async function resetAiGeneratorServerState(
  input: AiGeneratorServerResetInput,
): Promise<void> {
  const jobs = new Map(input.jobs.map((job) => [job.jobId, job]));
  for (const job of jobs.values()) {
    if (job.status === 'completed') continue;
    const result = await input.cancelJob(job);
    if (result.unconfirmed > 0) {
      throw new Error(
        'PrivOS chưa xác nhận dừng toàn bộ tiến trình AI nền. Hãy kiểm tra lại trạng thái rồi thử xóa dữ liệu lần nữa.',
      );
    }
  }

  const drafts = new Map(
    input.reviews
      .filter((review) => review.status === 'draft')
      .map((review) => [`${review.id}:${review.version}`, review]),
  );
  for (const draft of drafts.values()) await input.deleteDraft(draft);
}
