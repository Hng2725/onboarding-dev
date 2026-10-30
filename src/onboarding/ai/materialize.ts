import { createHash } from 'node:crypto';

import type { OnboardingActor } from '../auth';
import type {
  AiJobRecord,
  AiModuleDraftRun,
  LessonBlock,
  ModuleContent,
  OnboardingQuestion,
  QuestionMeta,
  RoleProfile,
  SourceRecord,
  SourceRef,
  TemplateContentSnapshot,
  VerificationFlag,
} from '../contracts';
import type { OnboardingStore, StoreRecord } from '../store';
import type {
  AdminTemplateDetail,
  TemplateDraftInput,
  TemplateService,
} from '../templates';
import { groundSourceRef, type RawSourceRef } from './grounding';
import type { GeneratedTemplate } from './validate';
import { modulesComplete } from './module-lifecycle';
import { validApprovedLesson, validateModuleQuestionOutput } from './module-draft';
import { validateAdminOutline } from './outline-validation';

export type AiMaterializationErrorCode =
  | 'ADMIN_REQUIRED'
  | 'AI_CONTENT_INVALID'
  | 'SOURCE_NOT_FOUND';

export class AiMaterializationError extends Error {
  readonly code: AiMaterializationErrorCode;

  constructor(code: AiMaterializationErrorCode, message: string) {
    super(message);
    this.name = 'AiMaterializationError';
    this.code = code;
  }
}

export interface MaterializeAiTemplateInput {
  readonly jobId: string;
  readonly promptVersion?: string;
  readonly templateKind: 'normal' | 'advanced';
  readonly generated: GeneratedTemplate;
  readonly sources: readonly SourceRecord[];
  readonly roleProfile?: RoleProfile;
  readonly learningMode?: 'sequential' | 'free';
  readonly maxAttemptsPerModule?: number | null;
  readonly passingScore?: number;
  readonly generationNotes?: readonly string[];
}

interface ValidatedMaterializationInput extends MaterializeAiTemplateInput {
  readonly approvedJob?: AiJobRecord;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function approvalFingerprint(job: AiJobRecord): string {
  return fingerprint({
    outline: job.outline, title: job.title, responsibilities: job.roleProfile?.responsibilities,
    runs: job.outline!.modules.filter((m) => !m.tombstoned).map((m) => {
      const run = job.moduleRuns!.find((r) => r.outline.moduleLocalId === m.moduleLocalId)!;
      return { lesson: run.lessonDraft, questions: run.questionDraft, provenance: run.lessonProvenance,
        lessonVersion: run.approvedLessonVersion, questionVersion: run.approvedQuestionVersion,
        questionLessonVersion: run.questionLessonVersion, sourceFingerprint: run.sourceFingerprint };
    }),
  });
}

/** Resources, assessment settings and flag resolutions may change after approval; lesson/quiz text may not. */
export function materializedModuleFingerprint(detail: { readonly modules: TemplateDraftInput['modules']; readonly content?: TemplateContentSnapshot }): string {
  return fingerprint({
    modules: detail.modules.map((m) => ({ id: m.id, key: m.key, title: m.title, description: m.description, questions: m.questions })),
    lessons: detail.content?.modules.map((m) => ({ ...m, blocks: m.blocks.map(({ pendingVerification: _pending, ...block }) => block) })),
    questions: detail.content?.questionMeta,
  });
}

const DESCRIPTION_MAX_CHARS = 300;

/**
 * Vietnamese name and description of a module template: the job title, else
 * 'Hội nhập <system> – <kind>'; the inventory's system purpose, else a generic line.
 */
export function defaultModuleTemplateText(input: {
  readonly templateKind: 'normal' | 'advanced';
  readonly title?: string;
  readonly sources: readonly Pick<SourceRecord, 'systemName'>[];
  readonly inventory: unknown;
}): { readonly title: string; readonly description: string } {
  const systemName = input.sources.map((source) => source.systemName?.trim()).find(Boolean) || 'nhân viên mới';
  const kind = input.templateKind === 'advanced' ? 'Nâng cao' : 'Thông thường';
  const summary = input.inventory && typeof input.inventory === 'object'
    ? (input.inventory as { systemSummary?: { purpose?: unknown } }).systemSummary
    : undefined;
  const purpose = typeof summary?.purpose === 'string' ? summary.purpose.trim().slice(0, DESCRIPTION_MAX_CHARS).trim() : '';
  return {
    title: input.title?.trim() || 'Hội nhập ' + systemName + ' – ' + kind,
    description: purpose || 'Lộ trình onboarding được tạo từ tài liệu nội bộ.',
  };
}

async function currentModuleInput(store: OnboardingStore, actor: OnboardingActor, jobId: string): Promise<ValidatedMaterializationInput> {
  const row = (await store.query<StoreRecord & AiJobRecord>(actor.roomId, 'onboarding_ai_jobs', { filter: { jobId }, limit: 1 })).records[0];
  const invalid = () => new AiMaterializationError('AI_CONTENT_INVALID', 'Every current outline module requires its latest approved lesson and three to five matching approved questions.');
  if (!row || row.pipelineVersion !== 'module_v2' || row.kind !== 'template' || row.status !== 'completed'
    || !row.templateKind || !row.outline || !row.moduleRuns || row.outlineApprovedRevision !== row.outline.revision
    || validateAdminOutline(row.outline, { templateKind: row.templateKind, responsibilities: row.roleProfile?.responsibilities ?? [] }).length) throw invalid();
  const job: AiJobRecord = { ...row, roomId: actor.roomId };
  const sources = (await Promise.all((job.sourceIds ?? []).map(async (sourceId) => {
    const source = (await store.query<StoreRecord & SourceRecord>(actor.roomId, 'onboarding_sources', { filter: { sourceId }, limit: 1 })).records[0];
    return source ? { ...source, roomId: actor.roomId } : undefined;
  }))).filter((source): source is SourceRecord => !!source && source.status === 'ready' && !source.deletedAt);
  const runs: AiModuleDraftRun[] = [];
  for (const module of job.outline!.modules.filter((m) => !m.tombstoned)) {
    const matches = job.moduleRuns!.filter((r) => r.outline.moduleLocalId === module.moduleLocalId);
    const run = matches[0];
    if (matches.length !== 1 || !run || run.outlineRevision !== job.outline!.revision
      || JSON.stringify(run.outline) !== JSON.stringify(module) || !modulesComplete([run])
      || !['ai', 'fallback', 'manual'].includes(run.lessonProvenance ?? '')
      || !Number.isSafeInteger(run.lessonVersion) || run.lessonVersion < 1
      || !Number.isSafeInteger(run.questionVersion) || run.questionVersion < 1) throw invalid();
    const selected = module.sourceSectionIds.map((id) => sources.flatMap((source) =>
      (source.sections ?? []).filter((s) => s.id === id).map((section) => ({ section, checksum: source.checksum, sourceId: source.sourceId }))));
    if (selected.some((items) => items.length !== 1)
      || (run.sourceFingerprint !== undefined && run.sourceFingerprint !== fingerprint(selected))) throw invalid();
    const context = { module, sections: selected.map((items) => items[0].section), features: [], responsibilities: job.roleProfile?.responsibilities ?? [], templateKind: job.templateKind! };
    if (!validApprovedLesson(run.lessonDraft!, context, run.lessonProvenance!)
      || !validateModuleQuestionOutput({ questions: run.questionDraft, flags: run.questionFlags ?? [] }, {
        ...context, lesson: run.lessonDraft!, lessonVersion: run.lessonVersion, lessonProvenance: run.lessonProvenance,
      }, true).ok) throw invalid();
    runs.push(run);
  }
  if (!runs.length || job.moduleRuns!.some((r) => !r.outline.tombstoned && !runs.includes(r))) throw invalid();
  return {
    jobId, approvedJob: job, promptVersion: job.promptVersion, templateKind: job.templateKind!, sources,
    ...(job.roleProfile ? { roleProfile: { responsibilities: job.roleProfile.responsibilities } } : {}),
    generated: {
      ...defaultModuleTemplateText({ templateKind: job.templateKind!, title: job.title, sources, inventory: job.stageOutputs.__inventory }),
      generationNotes: [], taskCoverage: job.outline!.taskCoverage,
      modules: runs.map((run) => ({ ...run.lessonDraft!, questions: run.questionDraft! })),
      flags: [...job.outline!.flags, ...runs.flatMap((run) => [...(run.lessonFlags ?? []), ...(run.questionFlags ?? [])].map((flag) => ({ ...flag, location: { ...flag.location, moduleLocalId: run.outline.moduleLocalId } })))],
    },
  };
}

export async function materializeModuleTemplate(store: OnboardingStore, templates: TemplateService, actor: OnboardingActor, jobId: string): Promise<AdminTemplateDetail> {
  if (actor.access !== 'admin') throw new AiMaterializationError('ADMIN_REQUIRED', 'Admin access is required.');
  return materializeValidatedTemplate(store, templates, actor, await currentModuleInput(store, actor, jobId));
}

export async function assertModuleTemplateCurrent(store: OnboardingStore, actor: OnboardingActor, detail: AdminTemplateDetail): Promise<void> {
  if (!detail.jobId) return;
  const row = (await store.query<StoreRecord & AiJobRecord>(actor.roomId, 'onboarding_ai_jobs', { filter: { jobId: detail.jobId }, limit: 1 })).records[0];
  if (row?.pipelineVersion !== 'module_v2' && !detail.content?.moduleApproval) return;
  const current = await currentModuleInput(store, actor, detail.jobId);
  const approval = detail.content?.moduleApproval;
  if (!approval || approval.fingerprint !== approvalFingerprint(current.approvedJob!)
    || approval.materializedFingerprint !== materializedModuleFingerprint(detail)) {
    throw new AiMaterializationError('AI_CONTENT_INVALID', 'The materialized lesson or questions no longer match the current approved versions.');
  }
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex')
    .slice(0, 24);
  return prefix + '-' + digest;
}

/** Identifies a generated flag across approvals, whose materialized IDs change. */
function flagKey(flag: GeneratedTemplate['flags'][number]): string {
  return JSON.stringify([
    flag.type,
    flag.location.moduleLocalId ?? '',
    flag.location.blockLocalId ?? '',
    flag.location.questionLocalId ?? '',
    flag.message,
  ]);
}

/** Resolved or dismissed flags of the latest materialized version, by their stable key. */
async function previousFlagDecisions(
  store: OnboardingStore,
  actor: OnboardingActor,
  templateId: string,
): Promise<Map<string, VerificationFlag>> {
  const rows = (await store.query<StoreRecord & { templateVersion: number; flags?: readonly VerificationFlag[] }>(
    actor.roomId, 'onboarding_template_content', { filter: { templateId }, limit: 1000 },
  )).records;
  const latest = [...rows].sort((left, right) => right.templateVersion - left.templateVersion)[0];
  return new Map((latest?.flags ?? [])
    .filter((flag) => flag.key && flag.status !== 'open')
    .map((flag) => [flag.key!, flag] as const));
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AiMaterializationError('AI_CONTENT_INVALID', label + ' is required.');
  return normalized;
}

function grounded(
  refs: readonly RawSourceRef[],
  sources: readonly SourceRecord[],
  label: string,
  requiredRef: boolean,
): readonly SourceRef[] {
  const result = refs.map((ref) => groundSourceRef(ref, sources));
  const issue = result.find((item) => !item.ok);
  if (issue && !issue.ok) {
    throw new AiMaterializationError(
      'AI_CONTENT_INVALID',
      label + ': ' + issue.issue.code + ': ' + issue.issue.message,
    );
  }
  const values = result
    .filter((item): item is Extract<typeof item, { readonly ok: true }> => item.ok)
    .map((item) => item.ref);
  if (requiredRef && values.length === 0) {
    throw new AiMaterializationError('AI_CONTENT_INVALID', label + ' requires grounded evidence.');
  }
  return values;
}

function balancedOptions(
  templateId: string,
  questionLocalId: string,
  questionIndex: number,
  options: readonly { readonly id: string; readonly label: string }[],
  correctOptionId: string,
): {
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly correctOptionId: string;
} {
  const mapped = options.map((option) => ({
    id: stableId('ai-opt', templateId, questionLocalId, option.id),
    label: option.label,
    originalId: option.id,
  }));
  const correct = mapped.find((option) => option.originalId === correctOptionId);
  if (!correct) {
    throw new AiMaterializationError('AI_CONTENT_INVALID', 'A question answer key is missing.');
  }
  const distractors = mapped.filter((option) => option !== correct);
  const position = questionIndex % mapped.length;
  const ordered = [...distractors];
  ordered.splice(position, 0, correct);
  return {
    options: ordered.map(({ id, label }) => ({ id, label })),
    correctOptionId: correct.id,
  };
}

export async function materializeAiTemplate(
  store: OnboardingStore,
  templates: TemplateService,
  actor: OnboardingActor,
  input: MaterializeAiTemplateInput,
): Promise<AdminTemplateDetail> {
  if (actor.access !== 'admin') throw new AiMaterializationError('ADMIN_REQUIRED', 'Admin access is required.');
  const job = (await store.query<StoreRecord & AiJobRecord>(actor.roomId, 'onboarding_ai_jobs', { filter: { jobId: input.jobId }, limit: 1 })).records[0];
  return job?.pipelineVersion === 'module_v2'
    ? materializeModuleTemplate(store, templates, actor, input.jobId)
    : materializeValidatedTemplate(store, templates, actor, input);
}

async function materializeValidatedTemplate(
  store: OnboardingStore,
  templates: TemplateService,
  actor: OnboardingActor,
  input: ValidatedMaterializationInput,
): Promise<AdminTemplateDetail> {
  if (actor.access !== 'admin') {
    throw new AiMaterializationError('ADMIN_REQUIRED', 'Admin access is required.');
  }
  const jobId = required(input.jobId, 'Job ID');
  if (
    (input.sources.length === 0 && !input.approvedJob?.moduleRuns?.every((run) => run.outline.tombstoned || run.lessonProvenance === 'manual'))
    || input.sources.some((source) =>
      source.roomId !== actor.roomId || source.status !== 'ready' || Boolean(source.deletedAt))
  ) {
    throw new AiMaterializationError('SOURCE_NOT_FOUND', 'Every materialization source must be active in this room.');
  }
  if (input.templateKind === 'advanced' && !input.roleProfile) {
    throw new AiMaterializationError('AI_CONTENT_INVALID', 'Advanced templates require a role profile.');
  }
  const templateId = stableId('ai-template', actor.roomId, jobId);
  // A revised approval gets fresh content IDs so published versions remain immutable.
  const identityScope = input.approvedJob ? stableId('approval', templateId, approvalFingerprint(input.approvedJob)) : templateId;
  const scoped = (moduleId: string, localId: string) => input.approvedJob ? moduleId + '\u0000' + localId : localId;
  const moduleIds = new Map<string, string>();
  const blockIds = new Map<string, string>();
  const questionIds = new Map<string, string>();
  input.generated.modules.forEach((module) => {
    moduleIds.set(module.localId, stableId('ai-mod', identityScope, module.localId));
    module.blocks.forEach((block) => {
      blockIds.set(scoped(module.localId, block.localId), stableId('ai-block', identityScope, module.localId, block.localId));
    });
    module.questions.forEach((question) => {
      questionIds.set(scoped(module.localId, question.localId), stableId('ai-q', identityScope, module.localId, question.localId));
    });
  });

  // Re-materializing an approval keeps the Admin's flag decisions for flags that still exist.
  const previousFlags = input.approvedJob ? await previousFlagDecisions(store, actor, templateId) : new Map<string, VerificationFlag>();
  const flags: VerificationFlag[] = input.generated.flags.map((flag, index) => {
    const key = flagKey(flag);
    const previous = previousFlags.get(key);
    return {
      id: stableId(
        'ai-flag',
        identityScope,
        flag.type,
        flag.location.moduleLocalId ?? '',
        flag.location.blockLocalId ?? '',
        flag.location.questionLocalId ?? '',
        flag.location.featureId ?? '',
        String(index),
      ),
      type: flag.type,
      severity: flag.severity,
      message: flag.message,
      questionForAdmin: flag.questionForAdmin,
      location: {
        ...(flag.location.moduleLocalId
          ? { moduleId: moduleIds.get(flag.location.moduleLocalId) }
          : {}),
        ...(flag.location.blockLocalId
          ? { blockId: blockIds.get(scoped(flag.location.moduleLocalId ?? '', flag.location.blockLocalId)) }
          : {}),
        ...(flag.location.questionLocalId
          ? { questionId: questionIds.get(scoped(flag.location.moduleLocalId ?? '', flag.location.questionLocalId)) }
          : {}),
        ...(flag.location.featureId ? { featureId: flag.location.featureId } : {}),
      },
      evidence: previous ? previous.evidence : grounded(flag.evidence, input.sources, 'Flag ' + String(index + 1), false),
      ...(input.approvedJob ? { key } : {}),
      status: previous ? previous.status : 'open',
      ...(previous?.resolution ? { resolution: previous.resolution } : {}),
    };
  });
  const pendingBlocks = new Set(flags
    .filter((flag) => flag.severity === 'warning' && flag.status === 'open')
    .map((flag) => flag.location.blockId)
    .filter((id): id is string => Boolean(id)));

  let questionIndex = 0;
  const contentModules: ModuleContent[] = [];
  const questionMeta: QuestionMeta[] = [];
  const draftModules: TemplateDraftInput['modules'][number][] = [];
  for (const generatedModule of input.generated.modules) {
    const approved = input.approvedJob?.moduleRuns?.find((run) => run.outline.moduleLocalId === generatedModule.localId);
    const moduleId = moduleIds.get(generatedModule.localId);
    if (!moduleId) throw new AiMaterializationError('AI_CONTENT_INVALID', 'A module ID could not be materialized.');
    const blocks: LessonBlock[] = generatedModule.blocks.map((block) => {
      const blockId = blockIds.get(scoped(generatedModule.localId, block.localId));
      if (!blockId) throw new AiMaterializationError('AI_CONTENT_INVALID', 'A block ID could not be materialized.');
      return {
        id: blockId,
        kind: block.kind,
        ...(block.title ? { title: block.title } : {}),
        body: block.body,
        ...(block.steps ? { steps: block.steps } : {}),
        sourceRefs: grounded(
          block.sourceRefs,
          input.sources,
          'Block ' + block.localId,
          block.kind !== 'summary' && approved?.lessonProvenance !== 'manual',
        ),
        pendingVerification: pendingBlocks.has(blockId),
      };
    });
    const questions: OnboardingQuestion[] = generatedModule.questions.map((question) => {
      const questionId = questionIds.get(scoped(generatedModule.localId, question.localId));
      if (!questionId) {
        throw new AiMaterializationError('AI_CONTENT_INVALID', 'A question ID could not be materialized.');
      }
      const balanced = balancedOptions(
        identityScope,
        scoped(generatedModule.localId, question.localId),
        questionIndex++,
        question.options,
        question.correctOptionId,
      );
      const mappedBlockIds = question.blockIds.map((localId) => blockIds.get(scoped(generatedModule.localId, localId)))
        .filter((id): id is string => Boolean(id));
      if (mappedBlockIds.length !== question.blockIds.length) {
        throw new AiMaterializationError('AI_CONTENT_INVALID', 'A question references an unknown lesson block.');
      }
      questionMeta.push({
        questionId,
        level: question.level,
        sourceRefs: grounded(question.sourceRefs, input.sources, 'Question ' + question.localId, approved?.lessonProvenance !== 'manual'),
        blockIds: mappedBlockIds,
      });
      return {
        id: questionId,
        type: 'single_choice',
        prompt: question.prompt,
        required: true,
        options: balanced.options,
        correctOptionIds: [balanced.correctOptionId],
        explanation: question.explanation,
      };
    });
    contentModules.push({
      ...(approved ? {
        moduleLocalId: approved.outline.moduleLocalId, lessonProvenance: approved.lessonProvenance,
        approvedLessonVersion: approved.approvedLessonVersion, approvedQuestionVersion: approved.approvedQuestionVersion,
        questionLessonVersion: approved.questionLessonVersion, featureIds: approved.outline.featureIds,
        sourceSectionIds: approved.outline.sourceSectionIds, responsibilityIndexes: approved.outline.responsibilityIndexes,
      } : {}),
      moduleId,
      frameKey: generatedModule.frameKey,
      objectives: generatedModule.objectives,
      estimatedMinutes: generatedModule.estimatedMinutes,
      blocks,
    });
    draftModules.push({
      id: moduleId,
      key: generatedModule.frameKey,
      title: generatedModule.title,
      description: generatedModule.description,
      resources: [],
      questions,
    });
  }

  const maxAttemptsPerModule = input.maxAttemptsPerModule === undefined
    ? 3
    : input.maxAttemptsPerModule;
  if (
    maxAttemptsPerModule !== null
    && (!Number.isInteger(maxAttemptsPerModule) || maxAttemptsPerModule < 1)
  ) {
    throw new AiMaterializationError('AI_CONTENT_INVALID', 'Module attempts must be a positive integer or null.');
  }
  const content: TemplateContentSnapshot = {
    assessmentMode: 'per_module',
    learningMode: input.learningMode ?? 'sequential',
    maxAttemptsPerModule,
    modules: contentModules,
    questionMeta,
  };
  const draft: TemplateDraftInput = {
    title: input.generated.title,
    description: input.generated.description,
    employeeType: input.templateKind,
    passingScore: input.passingScore ?? 70,
    maxAttempts: 1,
    modules: draftModules,
  };
  const approvedContent: TemplateContentSnapshot = input.approvedJob ? { ...content, moduleApproval: {
    pipelineVersion: 'module_v2', outlineRevision: input.approvedJob.outline!.revision,
    fingerprint: approvalFingerprint(input.approvedJob), taskCoverage: input.approvedJob.outline!.taskCoverage,
    materializedFingerprint: materializedModuleFingerprint({ content, modules: draftModules }),
  } } : content;
  const detail = await templates.createAiDraft(actor, {
    templateId,
    draft,
    content: approvedContent,
    flags,
    ...(input.roleProfile ? { roleProfile: input.roleProfile } : {}),
    sourceIds: [...new Set(input.sources.map((source) => source.sourceId))],
    jobId,
    ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}),
    generationNotes: [
      ...input.generated.generationNotes,
      ...(input.generationNotes ?? []),
    ],
  });
  const operationId = 'ai-template-generated:' + jobId;
  const priorAudit = await store.query<StoreRecord>(actor.roomId, 'onboarding_audit_events', {
    filter: { operationId },
    limit: 1,
  });
  if (priorAudit.records.length === 0) {
    await store.create(actor.roomId, 'onboarding_audit_events', {
      actorId: actor.userId,
      action: 'ai_template.generated',
      targetType: 'template',
      targetId: detail.id,
      metadata: { version: detail.version, jobId },
      operationId,
      occurredAt: detail.updatedAt,
    }, operationId);
  }
  return detail;
}
