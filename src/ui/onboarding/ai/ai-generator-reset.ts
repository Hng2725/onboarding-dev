import type { AiJobRecord } from '../../../onboarding/contracts';
import type { AdminTemplateDetail } from '../../../onboarding/templates';

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
