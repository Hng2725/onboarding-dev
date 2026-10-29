import { normalizeForMatch } from '../../../onboarding/ai/grounding';
import type { AiJobRecord, AiPublicationBatch, AiPublicationTarget, AiTemplateAssessmentSettings, EmployeeType, RoleProfile } from '../../../onboarding/contracts';
import type { AdminTemplateDetail } from '../../../onboarding/templates';

export type TemplateSelection = EmployeeType | null;

export interface TemplateRequestErrors {
  readonly selection?: string;
  readonly responsibilities?: string;
}

export type AiTemplateSettings = AiTemplateAssessmentSettings;

export interface AiTemplateRun {
  readonly kind: EmployeeType;
  readonly job: AiJobRecord | null;
  readonly review: AdminTemplateDetail | null;
  readonly settings?: AiTemplateSettings;
  readonly publicationBatchId?: string;
  readonly publicationTarget?: AiPublicationTarget;
}

export function templateKindsForSelection(selection: TemplateSelection): readonly EmployeeType[] {
  return selection ? [selection] : [];
}

export function validateTemplateRequest(input: {
  readonly selection: TemplateSelection;
  readonly responsibilities: string;
}): TemplateRequestErrors {
  if (!input.selection) {
    return { selection: 'Chọn loại template.' };
  }
  if (input.selection === 'normal') return {};

  const responsibilities = input.responsibilities
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    ...(responsibilities.length < 2 || responsibilities.length > 8 || new Set(responsibilities.map(normalizeForMatch)).size !== responsibilities.length
      ? { responsibilities: 'Nhập từ 2 đến 8 nhiệm vụ chính, mỗi nhiệm vụ một dòng.' }
      : {}),
  };
}

export function templateTitleForKind(baseTitle: string): string | undefined {
  return baseTitle.trim() || undefined;
}

export class AiTemplateGenerationError extends Error {
  readonly runs: readonly AiTemplateRun[];
  readonly originalError: unknown;

  constructor(runs: readonly AiTemplateRun[], originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : 'Không thể tạo lộ trình.');
    this.name = 'AiTemplateGenerationError';
    this.runs = runs;
    this.originalError = originalError;
  }
}

export async function generateTemplateRuns(
  runs: readonly AiTemplateRun[],
  generateOne: (run: AiTemplateRun) => Promise<AiTemplateRun>,
  onUpdate?: (runs: readonly AiTemplateRun[]) => void,
): Promise<readonly AiTemplateRun[]> {
  const latest = [...runs];

  for (let index = 0; index < latest.length; index += 1) {
    if (latest[index].review) {
      if (!aiReviewReadiness(latest[index].review).allowed) break;
      continue;
    }
    if (latest[index].job?.pipelineVersion === 'module_v2' && latest[index].job?.status === 'completed' && !latest[index].job?.result) continue;
    try {
      latest[index] = await generateOne(latest[index]);
      onUpdate?.([...latest]);
      if (latest[index].job?.pipelineVersion === 'module_v2') break;
    } catch (error) {
      throw new AiTemplateGenerationError([...latest], error);
    }
  }

  return latest;
}

export function mergeTemplateRunJobs(
  snapshot: readonly AiTemplateRun[],
  liveRuns: readonly AiTemplateRun[],
): readonly AiTemplateRun[] {
  return snapshot.map((run) => {
    const liveJob = liveRuns.find((candidate) => candidate.kind === run.kind)?.job;
    return liveJob ? { ...run, job: liveJob } : run;
  });
}
export function selectResumableTemplateRuns(input: {
  readonly jobs: readonly AiJobRecord[];
  /** Saved job ids (the single key plus any legacy per-kind keys); the newest eligible job wins. */
  readonly resumeJobIds: readonly (string | null | undefined)[];
  readonly userId?: string;
  readonly publicationBatches?: readonly AiPublicationBatch[];
}): readonly AiTemplateRun[] {
  const eligible = input.jobs.filter((job) => job.kind === 'template'
    && job.status !== 'cancelled'
    && Boolean(job.templateKind)
    && (!input.userId || job.createdBy === input.userId));
  const byId = (jobId: string | null | undefined) => eligible.find((job) => job.jobId === jobId);
  const createdAt = (job: AiJobRecord | undefined) => (job ? Date.parse(job.createdAt) : 0);
  const publication = input.publicationBatches?.filter((batch) => !input.userId || batch.createdBy === input.userId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const target = publication && [...publication.targets]
    .sort((a, b) => createdAt(byId(b.jobId)) - createdAt(byId(a.jobId)))[0];
  if (publication && target) {
    return [{ kind: target.kind, job: byId(target.jobId) ?? null, review: null,
      settings: target.settings, publicationBatchId: publication.batchId, publicationTarget: target }];
  }
  const saved = input.resumeJobIds.flatMap((jobId) => byId(jobId) ?? []);
  const recoverable = eligible.filter((job) => job.status === 'running' || job.status === 'failed');
  const newest = (jobs: readonly AiJobRecord[]) => [...jobs].sort((left, right) => createdAt(right) - createdAt(left))[0];
  // A saved id wins over any newer recoverable job; recovery is only the fallback.
  const job = newest(saved) ?? newest(recoverable);
  return job?.templateKind ? [{ kind: job.templateKind, job, review: null }] : [];
}

export interface TemplateStartJobRequest extends Readonly<Record<string, unknown>> {
  readonly kind: 'template';
  readonly inventoryJobId: string;
  readonly templateKind: EmployeeType;
  readonly roleProfile?: RoleProfile;
  readonly title?: string;
  readonly operationId: string;
}

export function templateJobRequest(input: {
  readonly selection: TemplateSelection;
  readonly kind: EmployeeType;
  readonly inventoryJobId: string;
  readonly baseTitle: string;
  readonly responsibilities: string;
  readonly operationId: string;
}): TemplateStartJobRequest {
  const responsibilities = input.responsibilities
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    kind: 'template',
    inventoryJobId: input.inventoryJobId,
    templateKind: input.kind,
    ...(input.kind === 'advanced'
      ? {
          roleProfile: {
            responsibilities,
          },
        }
      : {}),
    ...(templateTitleForKind(input.baseTitle) ? { title: templateTitleForKind(input.baseTitle) } : {}),
    operationId: input.operationId,
  };
}

export async function generateValidatedTemplateRuns(input: {
  readonly selection: TemplateSelection;
  readonly responsibilities: string;
  readonly runs: readonly AiTemplateRun[];
  readonly generateOne: (run: AiTemplateRun) => Promise<AiTemplateRun>;
  readonly onUpdate?: (runs: readonly AiTemplateRun[]) => void;
}): Promise<{
  readonly runs: readonly AiTemplateRun[];
  readonly errors: TemplateRequestErrors;
}> {
  const errors = validateTemplateRequest(input);
  if (Object.keys(errors).length > 0) return { runs: input.runs, errors };

  const ordered = templateKindsForSelection(input.selection).map((kind) =>
    input.runs.find((run) => run.kind === kind) ?? { kind, job: null, review: null });
  return {
    runs: await generateTemplateRuns(ordered, input.generateOne, input.onUpdate),
    errors,
  };
}
export function aiReviewReadiness(
  review: Pick<AdminTemplateDetail, 'flags'> | null | undefined,
): { readonly allowed: boolean; readonly blockingCount: number } {
  const blockingCount = (review?.flags ?? []).filter(
    (flag) => flag.status === 'open' && flag.severity === 'blocking',
  ).length;
  return { allowed: Boolean(review) && blockingCount === 0, blockingCount };
}

export function reviewAdvanceState(
  runs: readonly AiTemplateRun[],
): {
  readonly canBack: boolean;
  readonly canNext: boolean;
  readonly atPublishSummary: boolean;
  readonly blockingCount: number;
} {
  const current = runs[0];
  const readiness = aiReviewReadiness(current?.review);
  return {
    canBack: false,
    canNext: Boolean(current?.review) && readiness.allowed,
    atPublishSummary: runs.length > 0,
    blockingCount: readiness.blockingCount,
  };
}
