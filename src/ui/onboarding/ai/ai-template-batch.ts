import type { AiJobRecord, EmployeeType, RoleProfile } from '../../../onboarding/contracts';
import type { AdminTemplateDetail } from '../../../onboarding/templates';

export type TemplateSelection = EmployeeType | 'both' | null;

export interface TemplateRequestErrors {
  readonly selection?: string;
  readonly departmentLabel?: string;
  readonly jobTitle?: string;
  readonly responsibilities?: string;
}

export interface AiTemplateSettings {
  readonly passingScore: number;
  readonly maxAttemptsPerModule: number | null;
  readonly learningMode: 'sequential' | 'free';
}

export interface AiTemplateRun {
  readonly kind: EmployeeType;
  readonly job: AiJobRecord | null;
  readonly review: AdminTemplateDetail | null;
  readonly settings?: AiTemplateSettings;
}

export function templateKindsForSelection(selection: TemplateSelection): readonly EmployeeType[] {
  if (selection === 'both') return ['normal', 'advanced'];
  return selection ? [selection] : [];
}

export function validateTemplateRequest(input: {
  readonly selection: TemplateSelection;
  readonly department?: RoleProfile['department'];
  readonly departmentLabel?: string;
  readonly jobTitle: string;
  readonly responsibilities: string;
}): TemplateRequestErrors {
  if (!input.selection) {
    return { selection: 'Chọn ít nhất một loại lộ trình.' };
  }
  if (input.selection === 'normal') return {};

  const responsibilities = input.responsibilities
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    ...(input.department === 'other' && !input.departmentLabel?.trim()
      ? { departmentLabel: 'Nhập tên phòng ban khi chọn Khác.' }
      : {}),
    ...(!input.jobTitle.trim()
      ? { jobTitle: 'Nhập chức danh cho nhân sự chuyên sâu.' }
      : {}),
    ...(responsibilities.length < 2 || responsibilities.length > 8
      ? { responsibilities: 'Nhập từ 2 đến 8 nhiệm vụ chính, mỗi nhiệm vụ một dòng.' }
      : {}),
  };
}

export function templateTitleForKind(
  baseTitle: string,
  selection: TemplateSelection,
  kind: EmployeeType,
): string | undefined {
  const title = baseTitle.trim();
  if (!title) return undefined;
  if (selection !== 'both') return title;
  return `${title} – ${kind === 'normal' ? 'Template 1' : 'Template 2'}`;
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
    if (latest[index].review) continue;
    try {
      latest[index] = await generateOne(latest[index]);
      onUpdate?.([...latest]);
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
  readonly resumeJobIds: Readonly<Partial<Record<EmployeeType, string | null>>>;
  readonly legacyTemplateJobId?: string | null;
  readonly userId?: string;
}): readonly AiTemplateRun[] {
  const eligible = input.jobs.filter((job) => job.kind === 'template'
    && job.status !== 'cancelled'
    && Boolean(job.templateKind)
    && (!input.userId || job.createdBy === input.userId));
  const byId = (jobId: string | null | undefined) => eligible.find((job) => job.jobId === jobId);
  const legacy = byId(input.legacyTemplateJobId);
  const newestRecoverable = (kind: EmployeeType) => eligible
    .filter((job) => job.templateKind === kind
      && (job.status === 'running' || job.status === 'failed'))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];

  return (['normal', 'advanced'] as const).flatMap((kind) => {
    const saved = byId(input.resumeJobIds[kind]);
    const job = saved?.templateKind === kind
      ? saved
      : legacy?.templateKind === kind
        ? legacy
        : newestRecoverable(kind);
    return job ? [{ kind, job, review: null }] : [];
  });
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
  readonly department: RoleProfile['department'];
  readonly departmentLabel?: string;
  readonly jobTitle: string;
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
            department: input.department,
            ...(input.department === 'other' && input.departmentLabel?.trim()
              ? { departmentLabel: input.departmentLabel.trim() }
              : {}),
            jobTitle: input.jobTitle.trim(),
            responsibilities,
          },
        }
      : {}),
    ...(templateTitleForKind(input.baseTitle, input.selection, input.kind)
      ? { title: templateTitleForKind(input.baseTitle, input.selection, input.kind) }
      : {}),
    operationId: input.operationId,
  };
}

export async function generateValidatedTemplateRuns(input: {
  readonly selection: TemplateSelection;
  readonly department?: RoleProfile['department'];
  readonly departmentLabel?: string;
  readonly jobTitle: string;
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
  return { allowed: blockingCount === 0, blockingCount };
}

export function reviewAdvanceState(
  runs: readonly AiTemplateRun[],
  activeIndex: number,
): {
  readonly canBack: boolean;
  readonly canNext: boolean;
  readonly atPublishSummary: boolean;
  readonly blockingCount: number;
} {
  const current = runs[activeIndex];
  const readiness = aiReviewReadiness(current?.review);
  return {
    canBack: activeIndex > 0,
    canNext: Boolean(current?.review) && readiness.allowed,
    atPublishSummary: runs.length > 0 && activeIndex === runs.length - 1,
    blockingCount: readiness.blockingCount,
  };
}

export function moveReviewIndex(
  runs: readonly AiTemplateRun[],
  activeIndex: number,
  direction: 'back' | 'next',
): { readonly runs: readonly AiTemplateRun[]; readonly index: number } {
  const delta = direction === 'back' ? -1 : 1;
  const upper = Math.max(0, runs.length - 1);
  return {
    runs,
    index: Math.max(0, Math.min(upper, activeIndex + delta)),
  };
}