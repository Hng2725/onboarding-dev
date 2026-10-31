import { createHash } from 'node:crypto';

import type { OnboardingActor } from '../auth';
import type {
  AiPublicationBatch,
  AiPublicationTarget,
  QuestionOption,
  SourceRef,
  TemplateContentSnapshot,
  TemplateResource,
  VerificationFlag,
} from '../contracts';
import type { OnboardingStore, StoreRecord } from '../store';
import {
  TemplateServiceError,
  type AdminTemplateDetail,
  type TemplateDraftInput,
  type TemplateService,
} from '../templates';
import { normalizeForMatch } from './grounding';
import { createSourceService } from './sources';
import { assertModuleTemplateCurrent, materializedModuleFingerprint } from './materialize';

export type AiReviewServiceErrorCode =
  | 'ADMIN_REQUIRED'
  | 'REVIEW_NOT_FOUND'
  | 'REVIEW_CONFLICT'
  | 'REVIEW_INVALID'
  | 'FLAG_NOT_FOUND'
  | 'FLAG_ACTION_INVALID'
  | 'MODULE_MIN_QUESTIONS';

export class AiReviewServiceError extends Error {
  readonly code: AiReviewServiceErrorCode;

  constructor(code: AiReviewServiceErrorCode, message: string) {
    super(message);
    this.name = 'AiReviewServiceError';
    this.code = code;
  }
}

export type AiReviewOperation =
  | { readonly kind: 'checkpoint_publication'; readonly moduleId: string; readonly resource: TemplateResource }
  | { readonly kind: 'checkpoint_publication'; readonly jsonFileId: string }
  | {
    readonly kind: 'update_block';
    readonly moduleId: string;
    readonly blockId: string;
    readonly title?: string;
    readonly body?: string;
    readonly steps?: readonly { readonly order: number; readonly text: string }[];
  }
  | { readonly kind: 'remove_block'; readonly moduleId: string; readonly blockId: string }
  | {
    readonly kind: 'update_question';
    readonly questionId: string;
    readonly prompt?: string;
    readonly options?: readonly QuestionOption[];
    readonly correctOptionId?: string;
    readonly explanation?: string;
  }
  | { readonly kind: 'remove_question'; readonly questionId: string }
  | { readonly kind: 'remove_module'; readonly moduleId: string }
  | {
    readonly kind: 'upsert_generated_resource';
    readonly moduleId: string;
    readonly resource: TemplateResource;
  }
  | {
    readonly kind: 'set_settings';
    readonly passingScore?: number;
    readonly maxAttemptsPerModule?: number | null;
    readonly learningMode?: 'sequential' | 'free';
  };

export interface UpdateAiReviewInput {
  readonly templateId: string;
  readonly version: number;
  readonly expectedUpdatedAt: string;
  readonly ops: readonly AiReviewOperation[];
}

export interface ResolveAiFlagInput {
  readonly templateId: string;
  readonly version: number;
  readonly flagId: string;
  readonly action: 'choose_option' | 'add_note' | 'upload_doc' | 'remove' | 'accept';
  readonly note?: string;
  readonly chosenEvidenceIndex?: number;
  readonly expectedUpdatedAt?: string;
}

export interface AiReviewService {
  beginPublication(actor: OnboardingActor, input: { readonly batchId?: string; readonly targets: readonly AiPublicationTarget[] }): Promise<AiPublicationBatch>;
  listIncompletePublications(actor: OnboardingActor): Promise<readonly AiPublicationBatch[]>;
  getReview(actor: OnboardingActor, templateId: string, version: number): Promise<AdminTemplateDetail>;
  updateReview(actor: OnboardingActor, input: UpdateAiReviewInput): Promise<AdminTemplateDetail>;
  resolveFlag(actor: OnboardingActor, input: ResolveAiFlagInput): Promise<AdminTemplateDetail>;
}

export interface AiReviewServiceOptions {
  readonly now?: () => string;
}

interface TemplateContentDbRecord extends StoreRecord {
  readonly id: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly content: TemplateContentSnapshot;
  readonly flags: readonly VerificationFlag[];
  readonly updatedAt: string;
}

interface PublicationDbRecord extends StoreRecord, AiPublicationBatch {
  readonly id: string;
  readonly updatedAt: string;
  readonly requestFingerprint?: string;
  readonly retiredAt?: string;
  readonly retirementReason?: 'superseded' | 'missing_target' | 'finished';
  readonly supersededBy?: string;
  readonly supersedesBatchIds?: readonly string[];
}

function publicationBatch(row: PublicationDbRecord): AiPublicationBatch {
  return { batchId: row.batchId, createdBy: row.createdBy, createdAt: row.createdAt, targets: row.targets };
}

function publicationSettings(detail: AdminTemplateDetail) {
  return { passingScore: detail.passingScore ?? 70, learningMode: detail.content?.learningMode ?? 'sequential',
    maxAttemptsPerModule: detail.content?.maxAttemptsPerModule === undefined ? 2 : detail.content.maxAttemptsPerModule };
}

function publicationRequestFingerprint(actor: OnboardingActor, targets: readonly AiPublicationTarget[]): string {
  return createHash('sha256').update(JSON.stringify({ userId: actor.userId,
    targets: targets.map((target) => ({ kind: target.kind, templateId: target.templateId, version: target.version,
      materializedFingerprint: target.materializedFingerprint,
      settings: target.settings ? { passingScore: target.settings.passingScore, learningMode: target.settings.learningMode,
        maxAttemptsPerModule: target.settings.maxAttemptsPerModule } : undefined })),
  })).digest('hex');
}

function samePublicationSelection(left: readonly AiPublicationTarget[], right: readonly AiPublicationTarget[]): boolean {
  return left.length === right.length && left.every((target, index) =>
    target.kind === right[index].kind && target.templateId === right[index].templateId);
}

interface SourceDbRecord extends StoreRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: 'document' | 'admin_note';
  readonly status: 'ready' | 'failed';
  readonly sections?: readonly {
    readonly id: string;
    readonly page?: number;
    readonly text: string;
  }[];
  readonly deletedAt?: string;
}

type AiDetail = AdminTemplateDetail & {
  readonly content: TemplateContentSnapshot;
  readonly flags: readonly VerificationFlag[];
  readonly jobId: string;
  readonly sourceIds: readonly string[];
};

function requireAdmin(actor: OnboardingActor): void {
  if (actor.access !== 'admin') {
    throw new AiReviewServiceError('ADMIN_REQUIRED', 'Admin access is required.');
  }
}

function requireAi(detail: AdminTemplateDetail): asserts detail is AiDetail {
  if (
    detail.source !== 'ai_generated'
    || !detail.content
    || !detail.flags
    || !detail.jobId
    || !detail.sourceIds
  ) {
    throw new AiReviewServiceError('REVIEW_NOT_FOUND', 'The AI template review was not found.');
  }
}

function draftFrom(
  detail: AdminTemplateDetail,
  modules = detail.modules,
  passingScore = detail.passingScore,
): TemplateDraftInput {
  return {
    title: detail.title,
    description: detail.description,
    employeeType: detail.employeeType,
    passingScore,
    maxAttempts: detail.maxAttempts,
    modules: modules.map((module) => ({
      id: module.id,
      key: module.key,
      title: module.title,
      description: module.description,
      resources: module.resources.map((resource) => ({ ...resource })),
      questions: module.questions.map((question) => ({ ...question })),
    })),
  };
}

function pendingContent(
  content: TemplateContentSnapshot,
  flags: readonly VerificationFlag[],
): TemplateContentSnapshot {
  const pending = new Set(flags
    .filter((flag) => flag.severity === 'warning' && flag.status === 'open')
    .map((flag) => flag.location.blockId)
    .filter((id): id is string => Boolean(id)));
  return {
    ...content,
    modules: content.modules.map((module) => ({
      ...module,
      blocks: module.blocks.map((block) => ({
        ...block,
        pendingVerification: pending.has(block.id),
      })),
    })),
  };
}

function structuralErrors(
  detail: Pick<AdminTemplateDetail, 'employeeType' | 'modules' | 'roleProfile'>,
  content: TemplateContentSnapshot,
): readonly string[] {
  const errors: string[] = [];
  const range = detail.employeeType === 'normal' ? { min: 4, max: 8 } : { min: 5, max: 8 };
  if (detail.modules.length < range.min || detail.modules.length > range.max) {
    errors.push('Template module count is outside the allowed range.');
  }
  if (detail.employeeType === 'advanced' && !detail.roleProfile) {
    errors.push('Advanced templates require a role profile.');
  }
  const contentByModule = new Map(content.modules.map((module) => [module.moduleId, module]));
  const metadata = new Map(content.questionMeta.map((item) => [item.questionId, item]));
  for (const module of detail.modules) {
    const moduleContent = contentByModule.get(module.id);
    if (!moduleContent) {
      errors.push('Module ' + module.id + ' has no lesson content.');
      continue;
    }
    if (
      (moduleContent.objectives.length < 2 && moduleContent.lessonProvenance !== 'fallback')
      || moduleContent.objectives.length > 4
      || moduleContent.estimatedMinutes <= 0
    ) {
      errors.push('Module ' + module.id + ' has invalid objectives or duration.');
    }
    const summaries = moduleContent.blocks.filter((block) => block.kind === 'summary');
    if (
      summaries.length !== 1
      || moduleContent.blocks[moduleContent.blocks.length - 1]?.kind !== 'summary'
    ) {
      errors.push('Module ' + module.id + ' requires one final summary block.');
    }
    if (
      detail.employeeType === 'advanced'
      && moduleContent.lessonProvenance !== 'fallback'
      && !moduleContent.blocks.some((block) => block.kind === 'scenario')
    ) {
      errors.push('Advanced module ' + module.id + ' requires a scenario block.');
    }
    if (module.questions.length < 3 || module.questions.length > 5) {
      errors.push('Module ' + module.id + ' requires three to five questions.');
    }
    const blockIds = new Set(moduleContent.blocks.map((block) => block.id));
    for (const block of moduleContent.blocks) {
      if (block.kind !== 'summary' && block.sourceRefs.length === 0 && moduleContent.lessonProvenance !== 'manual') {
        errors.push('Block ' + block.id + ' requires source evidence.');
      }
    }
    for (const question of module.questions) {
      const meta = metadata.get(question.id);
      if (
        question.type !== 'single_choice'
        || question.options?.length !== 4
        || question.correctOptionIds?.length !== 1
        || !question.options.some((option) => option.id === question.correctOptionIds?.[0])
        || !question.explanation?.trim()
      ) {
        errors.push('Question ' + question.id + ' is structurally invalid.');
      }
      if (
        !meta
        || (meta.sourceRefs.length === 0 && moduleContent.lessonProvenance !== 'manual')
        || meta.blockIds.length === 0
        || meta.blockIds.some((blockId) => !blockIds.has(blockId))
      ) {
        errors.push('Question ' + question.id + ' has invalid evidence metadata.');
      }
    }
  }
  if (
    content.modules.length !== detail.modules.length
    || content.questionMeta.length !== detail.modules.flatMap((module) => module.questions).length
  ) {
    errors.push('Lesson and question content are out of sync.');
  }
  return errors;
}

function touchedBy(flag: VerificationFlag, operation: AiReviewOperation): boolean {
  if (operation.kind === 'set_settings' || operation.kind === 'upsert_generated_resource' || operation.kind === 'checkpoint_publication') return false;
  if ('moduleId' in operation && flag.location.moduleId === operation.moduleId) {
    if (operation.kind === 'remove_module') return true;
    if ('blockId' in operation) return flag.location.blockId === operation.blockId;
  }
  return 'questionId' in operation && flag.location.questionId === operation.questionId;
}

function reopenTouchedFlags(
  flags: readonly VerificationFlag[],
  operations: readonly AiReviewOperation[],
): readonly VerificationFlag[] {
  return flags.map((flag) => {
    if (flag.status === 'open' || !operations.some((operation) => touchedBy(flag, operation))) {
      return flag;
    }
    const { resolution: _resolution, ...reopened } = flag;
    return { ...reopened, status: 'open' as const };
  });
}

function revisionId(prefix: string, templateId: string, version: number, oldId: string): string {
  return prefix + '-' + createHash('sha256')
    .update(templateId + '\u0000' + String(version) + '\u0000' + oldId)
    .digest('hex')
    .slice(0, 24);
}

function remapRevision(
  templateId: string,
  version: number,
  modules: AdminTemplateDetail['modules'],
  content: TemplateContentSnapshot,
  flags: readonly VerificationFlag[],
): {
  readonly modules: AdminTemplateDetail['modules'];
  readonly content: TemplateContentSnapshot;
  readonly flags: readonly VerificationFlag[];
} {
  const moduleIds = new Map(modules.map((module) => [
    module.id, revisionId('ai-mod', templateId, version, module.id),
  ]));
  const blockIds = new Map(content.modules.flatMap((module) => module.blocks).map((block) => [
    block.id, revisionId('ai-block', templateId, version, block.id),
  ]));
  const questionIds = new Map(modules.flatMap((module) => module.questions).map((question) => [
    question.id, revisionId('ai-q', templateId, version, question.id),
  ]));
  const optionIds = new Map(modules.flatMap((module) => module.questions).flatMap((question) =>
    (question.options ?? []).map((option) => [
      option.id,
      revisionId('ai-opt', templateId, version, question.id + ':' + option.id),
    ] as const)));
  const remapResource = (moduleId: string, resource: TemplateResource): TemplateResource => ({
    ...resource,
    id: resource.id === 'ai-lesson-pdf-' + moduleId
      ? 'ai-lesson-pdf-' + moduleIds.get(moduleId)
      : resource.id,
  });
  return {
    modules: modules.map((module) => ({
      ...module,
      id: moduleIds.get(module.id) ?? module.id,
      resources: module.resources.map((resource) => remapResource(module.id, resource)),
      questions: module.questions.map((question) => ({
        ...question,
        id: questionIds.get(question.id) ?? question.id,
        options: question.options?.map((option) => ({
          ...option,
          id: optionIds.get(option.id) ?? option.id,
        })),
        correctOptionIds: question.correctOptionIds?.map((id) => optionIds.get(id) ?? id),
      })),
    })),
    content: {
      ...content,
      ...(content.publication ? { publication: { pdfs: Object.fromEntries(
        Object.entries(content.publication.pdfs).filter(([id]) => moduleIds.has(id))
          .map(([id, resource]) => [moduleIds.get(id)!, remapResource(id, resource)]),
      ) } } : {}),
      modules: content.modules.map((module) => ({
        ...module,
        moduleId: moduleIds.get(module.moduleId) ?? module.moduleId,
        blocks: module.blocks.map((block) => ({
          ...block,
          id: blockIds.get(block.id) ?? block.id,
        })),
      })),
      questionMeta: content.questionMeta.map((meta) => ({
        ...meta,
        questionId: questionIds.get(meta.questionId) ?? meta.questionId,
        blockIds: meta.blockIds.map((id) => blockIds.get(id) ?? id),
      })),
    },
    flags: flags.map((flag) => ({
      ...flag,
      id: revisionId('ai-flag', templateId, version, flag.id),
      location: {
        ...flag.location,
        ...(flag.location.moduleId
          ? { moduleId: moduleIds.get(flag.location.moduleId) ?? flag.location.moduleId }
          : {}),
        ...(flag.location.blockId
          ? { blockId: blockIds.get(flag.location.blockId) ?? flag.location.blockId }
          : {}),
        ...(flag.location.questionId
          ? { questionId: questionIds.get(flag.location.questionId) ?? flag.location.questionId }
          : {}),
      },
    })),
  };
}

function evidenceIsActive(ref: SourceRef, source: SourceDbRecord | undefined): boolean {
  if (!source || source.deletedAt || source.status !== 'ready' || source.kind !== ref.kind) return false;
  const section = source.sections?.find((item) => item.id === ref.sectionId);
  return Boolean(
    section
    && normalizeForMatch(section.text).includes(normalizeForMatch(ref.quote))
    && (ref.page === undefined || ref.page === section.page),
  );
}

async function loadSources(
  store: OnboardingStore,
  roomId: string,
  refs: readonly SourceRef[],
): Promise<ReadonlyMap<string, SourceDbRecord>> {
  const ids = [...new Set(refs.map((ref) => ref.sourceId))];
  const entries = await Promise.all(ids.map(async (sourceId) => {
    const result = await store.query<SourceDbRecord>(roomId, 'onboarding_sources', {
      filter: { sourceId },
      limit: 1,
      includeDeleted: true,
    });
    return [sourceId, result.records[0]] as const;
  }));
  return new Map(
    entries.filter((entry): entry is readonly [string, SourceDbRecord] => Boolean(entry[1])),
  );
}

async function reopenInvalidEvidence(
  store: OnboardingStore,
  actor: OnboardingActor,
  detail: AiDetail,
  now: () => string,
): Promise<AiDetail> {
  const candidates = detail.flags.filter((flag) =>
    flag.status !== 'open'
    && (flag.resolution?.action === 'choose_option' || flag.resolution?.action === 'add_note'));
  if (candidates.length === 0) return detail;
  const sources = await loadSources(store, actor.roomId, candidates.flatMap((flag) => flag.evidence));
  let changed = false;
  const flags = detail.flags.map((flag) => {
    if (!candidates.includes(flag)) return flag;
    const resolutionEvidence = flag.resolution?.action === 'add_note'
      ? flag.evidence.filter((ref) =>
        ref.kind === 'admin_note' && ref.verifiedBy === flag.resolution?.by)
      : flag.evidence.filter((ref) =>
        ref.verifiedBy === flag.resolution?.by && Boolean(ref.verifiedAt));
    if (
      resolutionEvidence.length > 0
      && resolutionEvidence.some((ref) => evidenceIsActive(ref, sources.get(ref.sourceId)))
    ) return flag;
    changed = true;
    const { resolution: _resolution, ...reopened } = flag;
    return { ...reopened, status: 'open' as const };
  });
  if (!changed) return detail;
  const rows = await store.query<TemplateContentDbRecord>(actor.roomId, 'onboarding_template_content', {
    filter: { templateId: detail.id, templateVersion: detail.version },
    limit: 1,
  });
  const row = rows.records[0];
  if (!row) return detail;
  const timestamp = now();
  const content = pendingContent(detail.content, flags);
  await store.update(actor.roomId, 'onboarding_template_content', row.id, {
    flags, content, updatedAt: timestamp,
  }, { expectedUpdatedAt: row.updatedAt });
  const templateRows = await store.query<StoreRecord>(actor.roomId, 'onboarding_templates', {
    filter: { templateId: detail.id, version: detail.version },
    limit: 1,
  });
  if (templateRows.records[0]) {
    await store.update(actor.roomId, 'onboarding_templates', String(templateRows.records[0].id), {
      updatedAt: timestamp,
    });
  }
  return { ...detail, flags, content, updatedAt: timestamp };
}

export function createAiPublishGuard(
  store: OnboardingStore,
): (actor: OnboardingActor, detail: AdminTemplateDetail) => Promise<void> {
  return async (actor, detail) => {
    if (detail.source !== 'ai_generated') return;
    requireAi(detail);
    try { await assertModuleTemplateCurrent(store, actor, detail); }
    catch (error) { throw new TemplateServiceError('TEMPLATE_INVALID', error instanceof Error ? error.message : 'Module approvals are invalid.'); }
    if (detail.flags.some((flag) => flag.severity === 'blocking' && flag.status === 'open')) {
      throw new TemplateServiceError(
        'TEMPLATE_FLAGS_BLOCKING',
        'Resolve every blocking verification flag before publishing.',
      );
    }
    const errors = structuralErrors(detail, detail.content);
    if (errors.length > 0) throw new TemplateServiceError('TEMPLATE_INVALID', errors[0]);
    const refs = [
      ...detail.content.modules.flatMap((module) => module.blocks)
        .filter((block) => block.kind !== 'summary')
        .flatMap((block) => block.sourceRefs),
      ...detail.content.questionMeta.flatMap((meta) => meta.sourceRefs),
    ];
    const sources = await loadSources(store, actor.roomId, refs);
    if (refs.some((ref) => !evidenceIsActive(ref, sources.get(ref.sourceId)))) {
      throw new TemplateServiceError('TEMPLATE_INVALID', 'AI template evidence is no longer valid.');
    }
  };
}

function applyReviewOperations(
  detail: AiDetail,
  operations: readonly AiReviewOperation[],
): {
  readonly modules: AdminTemplateDetail['modules'];
  readonly content: TemplateContentSnapshot;
  readonly passingScore?: number;
} {
  let modules = detail.modules.map((module) => ({
    ...module,
    resources: module.resources.map((resource) => ({ ...resource })),
    questions: module.questions.map((question) => ({ ...question })),
  }));
  let content: TemplateContentSnapshot = {
    ...detail.content,
    modules: detail.content.modules.map((module) => ({
      ...module,
      blocks: module.blocks.map((block) => ({ ...block })),
    })),
    questionMeta: detail.content.questionMeta.map((meta) => ({ ...meta })),
  };
  let passingScore = detail.passingScore;
  for (const operation of operations) {
    if (operation.kind === 'checkpoint_publication') continue;
    if (operation.kind === 'update_block') {
      let found = false;
      content = {
        ...content,
        modules: content.modules.map((module) => module.moduleId !== operation.moduleId
          ? module
          : {
            ...module,
            blocks: module.blocks.map((block) => {
              if (block.id !== operation.blockId) return block;
              found = true;
              return {
                ...block,
                ...(operation.title === undefined ? {} : { title: operation.title.trim() }),
                ...(operation.body === undefined ? {} : { body: operation.body.trim() }),
                ...(operation.steps === undefined ? {} : { steps: operation.steps }),
              };
            }),
          }),
      };
      if (!found) throw new AiReviewServiceError('REVIEW_INVALID', 'The lesson block was not found.');
    } else if (operation.kind === 'remove_block') {
      content = {
        ...content,
        modules: content.modules.map((module) => module.moduleId !== operation.moduleId
          ? module
          : { ...module, blocks: module.blocks.filter((block) => block.id !== operation.blockId) }),
      };
    } else if (operation.kind === 'update_question') {
      let found = false;
      modules = modules.map((module) => ({
        ...module,
        questions: module.questions.map((question) => {
          if (question.id !== operation.questionId) return question;
          found = true;
          return {
            ...question,
            ...(operation.prompt === undefined ? {} : { prompt: operation.prompt.trim() }),
            ...(operation.options === undefined ? {} : { options: operation.options }),
            ...(operation.explanation === undefined
              ? {}
              : { explanation: operation.explanation.trim() }),
            correctOptionIds: operation.correctOptionId === undefined
              ? question.correctOptionIds
              : [operation.correctOptionId],
          };
        }),
      }));
      if (!found) throw new AiReviewServiceError('REVIEW_INVALID', 'The question was not found.');
    } else if (operation.kind === 'remove_question') {
      const owner = modules.find((module) =>
        module.questions.some((question) => question.id === operation.questionId));
      if (!owner) throw new AiReviewServiceError('REVIEW_INVALID', 'The question was not found.');
      if (owner.questions.length <= 3) {
        throw new AiReviewServiceError(
          'MODULE_MIN_QUESTIONS',
          'A module must retain at least three questions.',
        );
      }
      modules = modules.map((module) => ({
        ...module,
        questions: module.questions.filter((question) => question.id !== operation.questionId),
      }));
      content = {
        ...content,
        questionMeta: content.questionMeta.filter((meta) => meta.questionId !== operation.questionId),
      };
    } else if (operation.kind === 'remove_module') {
      const removedQuestions = new Set(
        modules.find((module) => module.id === operation.moduleId)?.questions.map((item) => item.id) ?? [],
      );
      modules = modules.filter((module) => module.id !== operation.moduleId);
      content = {
        ...content,
        modules: content.modules.filter((module) => module.moduleId !== operation.moduleId),
        questionMeta: content.questionMeta.filter((meta) => !removedQuestions.has(meta.questionId)),
      };
    } else if (operation.kind === 'upsert_generated_resource') {
      const resource = operation.resource;
      const moduleExists = modules.some((module) => module.id === operation.moduleId);
      if (!moduleExists) {
        throw new AiReviewServiceError('REVIEW_INVALID', 'The resource module was not found.');
      }
      if (
        resource.kind !== 'file'
        || resource.required !== true
        || !resource.id.trim()
        || !resource.title.trim()
        || !resource.fileId?.trim()
      ) {
        throw new AiReviewServiceError(
          'REVIEW_INVALID',
          'Generated lesson resources require a stable ID, title, required file kind, and file ID.',
        );
      }
      if (modules.some((module) =>
        module.id !== operation.moduleId
        && module.resources.some((entry) => entry.id === resource.id.trim()))) {
        throw new AiReviewServiceError('REVIEW_INVALID', 'The generated resource ID is already in use.');
      }
      const normalized: TemplateResource = {
        ...resource,
        id: resource.id.trim(),
        title: resource.title.trim(),
        description: resource.description?.trim(),
        fileId: resource.fileId.trim(),
      };
      modules = modules.map((module) => {
        if (module.id !== operation.moduleId) return module;
        const exists = module.resources.some((entry) => entry.id === normalized.id);
        return {
          ...module,
          resources: exists
            ? module.resources.map((entry) => entry.id === normalized.id ? normalized : entry)
            : [...module.resources, normalized],
        };
      });
    } else {
      if (
        operation.passingScore !== undefined
        && (!Number.isFinite(operation.passingScore)
          || operation.passingScore < 0
          || operation.passingScore > 100)
      ) {
        throw new AiReviewServiceError('REVIEW_INVALID', 'Passing score must be from 0 to 100.');
      }
      if (
        operation.maxAttemptsPerModule !== undefined
        && operation.maxAttemptsPerModule !== null
        && (!Number.isInteger(operation.maxAttemptsPerModule)
          || operation.maxAttemptsPerModule < 1)
      ) {
        throw new AiReviewServiceError('REVIEW_INVALID', 'Module attempts must be positive or null.');
      }
      passingScore = operation.passingScore ?? passingScore;
      content = {
        ...content,
        learningMode: operation.learningMode ?? content.learningMode,
        maxAttemptsPerModule: operation.maxAttemptsPerModule === undefined
          ? content.maxAttemptsPerModule
          : operation.maxAttemptsPerModule,
      };
    }
  }
  return { modules, content, passingScore };
}

export function createAiReviewService(
  store: OnboardingStore,
  templates: TemplateService,
  options: AiReviewServiceOptions = {},
): AiReviewService {
  const now = options.now ?? (() => new Date().toISOString());
  const sources = createSourceService(store, { now });

  async function audit(
    actor: OnboardingActor,
    action: string,
    targetId: string,
    metadata: StoreRecord,
  ): Promise<void> {
    const occurredAt = now();
    const operationId = action + ':' + targetId + ':' + occurredAt;
    await store.create(actor.roomId, 'onboarding_audit_events', {
      actorId: actor.userId,
      action,
      targetType: 'template',
      targetId,
      metadata,
      operationId,
      occurredAt,
    }, operationId);
  }

  async function reviewDetail(
    actor: OnboardingActor,
    templateId: string,
    version: number,
  ): Promise<AiDetail> {
    requireAdmin(actor);
    const detail = await templates.getAdminDetail(actor, templateId, version);
    requireAi(detail);
    return reopenInvalidEvidence(store, actor, detail, now);
  }

  async function save(
    actor: OnboardingActor,
    detail: AiDetail,
    expectedUpdatedAt: string,
    modules: AdminTemplateDetail['modules'],
    content: TemplateContentSnapshot,
    flags: readonly VerificationFlag[],
    passingScore = detail.passingScore,
    reuseSettingsRevision = false,
  ): Promise<AdminTemplateDetail> {
    let nextModules = modules;
    let nextContent = pendingContent(content, flags);
    let nextFlags = flags;
    // An attachment is reusable only while the lesson it renders remains unchanged.
    const unchangedLessons = new Set(nextContent.modules.filter((module) =>
      JSON.stringify(module) === JSON.stringify(detail.content.modules.find((old) => old.moduleId === module.moduleId)))
      .map((module) => module.moduleId));
    nextModules = nextModules.map((module) => ({ ...module, resources: module.resources.filter((resource) =>
      resource.id !== 'ai-lesson-pdf-' + module.id || unchangedLessons.has(module.id)) }));
    if (nextContent.publication) nextContent = { ...nextContent, publication: { pdfs: Object.fromEntries(
      Object.entries(nextContent.publication.pdfs).filter(([id]) => unchangedLessons.has(id)),
    ) } };
    if (detail.status === 'published') {
      // Validate the original approved snapshot before re-keying its immutable content.
      if (detail.content.moduleApproval) await assertModuleTemplateCurrent(store, actor, detail);
      const catalog = await templates.list(actor);
      const latestVersion = Math.max(...catalog
        .filter((item) => item.id === detail.id)
        .map((item) => item.version));
      if (reuseSettingsRevision && latestVersion > detail.version) {
        const latest = await templates.getAdminDetail(actor, detail.id, latestVersion);
        const expected = remapRevision(detail.id, latestVersion, nextModules, nextContent, nextFlags);
        if (latest.jobId === detail.jobId && (latest.status === 'draft' || latest.status === 'published')
          && latest.passingScore === passingScore
          && latest.content?.learningMode === nextContent.learningMode
          && latest.content?.maxAttemptsPerModule === nextContent.maxAttemptsPerModule
          && materializedModuleFingerprint(latest) === materializedModuleFingerprint(expected)) {
          if (latest.content.moduleApproval) await assertModuleTemplateCurrent(store, actor, latest);
          return latest;
        }
      }
      const nextVersion = latestVersion + 1;
      const remapped = remapRevision(
        detail.id,
        nextVersion,
        nextModules,
        nextContent,
        nextFlags,
      );
      nextModules = remapped.modules;
      nextContent = remapped.content;
      nextFlags = remapped.flags;
      if (nextContent.moduleApproval) nextContent = { ...nextContent, moduleApproval: {
        ...nextContent.moduleApproval,
        materializedFingerprint: materializedModuleFingerprint({ modules: nextModules, content: nextContent }),
      } };
    }
    const errors = structuralErrors({ ...detail, modules: nextModules }, nextContent);
    if (errors.length > 0) {
      if (errors.some((error) => error.includes('three to five questions'))) {
        throw new AiReviewServiceError('MODULE_MIN_QUESTIONS', errors[0]);
      }
      throw new AiReviewServiceError('REVIEW_INVALID', errors[0]);
    }
    try {
      return await templates.updateAiDraft(actor, {
        templateId: detail.id,
        version: detail.version,
        expectedUpdatedAt,
        draft: draftFrom(detail, nextModules, passingScore),
        content: nextContent,
        flags: nextFlags,
        roleProfile: detail.roleProfile,
        sourceIds: detail.sourceIds,
        jobId: detail.jobId,
        promptVersion: detail.promptVersion,
        generationNotes: detail.generationNotes,
      });
    } catch (error) {
      if (error instanceof TemplateServiceError && error.code === 'TEMPLATE_CONFLICT') {
        throw new AiReviewServiceError('REVIEW_CONFLICT', error.message);
      }
      throw error;
    }
  }

  async function ownedPublications(actor: OnboardingActor): Promise<readonly PublicationDbRecord[]> {
    const rows: PublicationDbRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.query<PublicationDbRecord>(actor.roomId, 'onboarding_ai_publications', {
        filter: { createdBy: actor.userId }, orderBy: [{ field: 'createdAt', direction: 'desc' }], limit: 1000, cursor,
      });
      rows.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }

  async function retirePublication(actor: OnboardingActor, row: PublicationDbRecord,
    reason: NonNullable<PublicationDbRecord['retirementReason']>, supersededBy?: string): Promise<void> {
    if (row.retiredAt) return;
    const timestamp = now();
    await store.update(actor.roomId, 'onboarding_ai_publications', row.id, {
      retiredAt: timestamp, retirementReason: reason, updatedAt: timestamp,
      ...(supersededBy ? { supersededBy } : {}),
    }, { expectedUpdatedAt: row.updatedAt });
  }

  async function publicationTargetCompleted(actor: OnboardingActor, target: AiPublicationTarget): Promise<boolean> {
    const detail = await templates.getAdminDetail(actor, target.templateId, target.version);
    return detail.status === 'published' && Boolean(detail.content?.publication?.jsonFileId)
      && materializedModuleFingerprint(detail) === target.materializedFingerprint
      && (!target.settings || JSON.stringify(publicationSettings(detail)) === JSON.stringify({
        passingScore: target.settings.passingScore, learningMode: target.settings.learningMode,
        maxAttemptsPerModule: target.settings.maxAttemptsPerModule,
      }));
  }

  /**
   * A target nothing is left to do for: completed as requested, published with its JSON (a
   * published version is immutable), or archived (it is never published again).
   */
  async function publicationTargetFinished(actor: OnboardingActor, target: AiPublicationTarget): Promise<'archived' | 'done' | false> {
    const detail = await templates.getAdminDetail(actor, target.templateId, target.version);
    if (detail.status === 'archived') return 'archived';
    if (detail.status === 'published' && detail.content?.publication?.jsonFileId) return 'done';
    return await publicationTargetCompleted(actor, target) ? 'done' : false;
  }

  function targetOverlaps(left: AiPublicationTarget, right: AiPublicationTarget): boolean {
    return left.kind === right.kind && left.templateId === right.templateId;
  }

  // A durable claim hides its predecessor immediately. Until its CAS transition succeeds,
  // project the unaffected pending selection from that predecessor's existing record.
  async function effectivePublications(actor: OnboardingActor, rows: readonly PublicationDbRecord[]): Promise<readonly PublicationDbRecord[]> {
    const effective: PublicationDbRecord[] = [];
    for (const row of rows) {
      if (row.retiredAt) continue;
      const successors = rows.filter((other) => other.supersedesBatchIds?.includes(row.batchId));
      if (!successors.length) { effective.push(row); continue; }
      const targets: AiPublicationTarget[] = [];
      for (const target of row.targets) {
        if (successors.some((successor) => successor.targets.some((replacement) => targetOverlaps(target, replacement)))) continue;
        try { if (!await publicationTargetCompleted(actor, target)) targets.push(target); }
        catch (error) { if (!(error instanceof TemplateServiceError) || error.code !== 'TEMPLATE_NOT_FOUND') throw error; }
      }
      if (targets.length) {
        const requestFingerprint = publicationRequestFingerprint(actor, targets);
        effective.push({ ...row, targets, requestFingerprint,
          batchId: revisionId('ai-publication', row.batchId, 1, requestFingerprint),
          supersedesBatchIds: [...new Set([...(row.supersedesBatchIds ?? []), row.batchId])],
        });
      }
    }
    return effective;
  }

  async function persistPublicationProjection(actor: OnboardingActor, projected: PublicationDbRecord,
    rows: readonly PublicationDbRecord[]): Promise<PublicationDbRecord> {
    const original = rows.find((row) => row.id === projected.id)!;
    if (original.batchId === projected.batchId) return projected;
    return store.update<PublicationDbRecord>(actor.roomId, 'onboarding_ai_publications', original.id, {
      batchId: projected.batchId, targets: projected.targets, requestFingerprint: projected.requestFingerprint,
      supersedesBatchIds: projected.supersedesBatchIds, updatedAt: now(),
    }, { expectedUpdatedAt: original.updatedAt });
  }

  async function reconcilePredecessors(actor: OnboardingActor, successor: PublicationDbRecord): Promise<void> {
    const rows = await ownedPublications(actor);
    const effective = await effectivePublications(actor, rows);
    for (const predecessor of rows) {
      if (predecessor.retiredAt || !successor.supersedesBatchIds?.includes(predecessor.batchId)) continue;
      const remaining = effective.find((row) => row.id === predecessor.id);
      if (remaining) await persistPublicationProjection(actor, remaining, rows);
      else await retirePublication(actor, predecessor, 'superseded', successor.batchId);
    }
  }

  const service: AiReviewService = {
    async beginPublication(actor, input) {
      requireAdmin(actor);
      if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 2
        || new Set(input.targets.map((target) => target.kind)).size !== input.targets.length) {
        throw new AiReviewServiceError('REVIEW_INVALID', 'Select one target of each template kind.');
      }
      const ordered = [...input.targets].sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'normal' ? -1 : 1);
      const previous = await ownedPublications(actor);
      const effective = await effectivePublications(actor, previous);
      let row: PublicationDbRecord | undefined = input.batchId
        ? (await store.query<PublicationDbRecord>(actor.roomId, 'onboarding_ai_publications', { filter: { batchId: input.batchId }, limit: 1 })).records[0]
        : undefined;
      if (row && (row.createdBy !== actor.userId || !samePublicationSelection(row.targets, ordered))) {
        throw new AiReviewServiceError('REVIEW_CONFLICT', 'This publication belongs to a different selection.');
      }
      if (input.batchId && previous.some((batch) => batch.supersedesBatchIds?.includes(input.batchId!))) {
        throw new AiReviewServiceError('REVIEW_CONFLICT', 'This publication is no longer active. Review the current draft first.');
      }
      if (input.batchId && !row) row = effective.find((batch) => batch.batchId === input.batchId);
      if (input.batchId && !row) throw new AiReviewServiceError('REVIEW_NOT_FOUND', 'Publication batch not found.');
      if (row && !samePublicationSelection(row.targets, ordered)) {
        throw new AiReviewServiceError('REVIEW_CONFLICT', 'This publication belongs to a different selection.');
      }
      if (row?.retiredAt) throw new AiReviewServiceError('REVIEW_CONFLICT', 'This publication is no longer active. Review the current draft first.');
      let claimsToAdd: readonly string[] = [];
      if (!row) {
        const targets: AiPublicationTarget[] = [];
        for (const target of ordered) {
          const detail = await reviewDetail(actor, target.templateId, target.version);
          if (detail.employeeType !== target.kind || !['draft', 'published'].includes(detail.status)
            || detail.flags.some((flag) => flag.severity === 'blocking' && flag.status === 'open')) {
            throw new AiReviewServiceError('REVIEW_INVALID', 'Review every selected template before publishing.');
          }
          await assertModuleTemplateCurrent(store, actor, detail);
          const settings = target.settings ?? publicationSettings(detail);
          applyReviewOperations(detail, [{ kind: 'set_settings', ...settings }]);
          targets.push({ kind: target.kind, templateId: detail.id, version: detail.version, jobId: detail.jobId,
            materializedFingerprint: materializedModuleFingerprint(detail), settings });
        }
        const requestFingerprint = publicationRequestFingerprint(actor, targets);
        const identical = previous.filter((batch) =>
          (batch.requestFingerprint ?? publicationRequestFingerprint(actor, batch.targets)) === requestFingerprint);
        row = effective.find((batch) =>
          (batch.requestFingerprint ?? publicationRequestFingerprint(actor, batch.targets)) === requestFingerprint);
        const obsolete = effective.filter((batch) => batch.batchId !== row?.batchId
          && (samePublicationSelection(batch.targets, targets) || batch.targets.some((target) => targets.some((replacement) =>
            targetOverlaps(target, replacement)
            && publicationRequestFingerprint(actor, [target]) !== publicationRequestFingerprint(actor, [replacement])))));
        // Carry the original claim when replacing a residual that has not been persisted yet.
        const supersedesBatchIds = [...new Set(obsolete.flatMap((batch) => [batch.batchId, ...(batch.supersedesBatchIds ?? [])]))];
        if (!row) {
          // Retired content can be explicitly selected again without resurrecting an old batch.
          let ordinal = identical.length;
          let batchId = 'ai-publication-' + requestFingerprint + (ordinal ? ':' + ordinal : '');
          while (previous.some((batch) => batch.batchId === batchId || batch.supersedesBatchIds?.includes(batchId))) {
            batchId = 'ai-publication-' + requestFingerprint + ':' + (++ordinal);
          }
          const timestamp = now();
          row = await store.create<PublicationDbRecord>(actor.roomId, 'onboarding_ai_publications', {
            batchId, requestFingerprint, createdBy: actor.userId, targets, createdAt: timestamp, updatedAt: timestamp,
            supersedesBatchIds,
          }, batchId);
        } else if (supersedesBatchIds.some((id) => !row!.supersedesBatchIds?.includes(id))) {
          claimsToAdd = supersedesBatchIds;
        }
      }
      const selectedRow = row;
      if (previous.some((batch) => batch.id === selectedRow.id && batch.batchId !== selectedRow.batchId)) {
        row = await persistPublicationProjection(actor, row, previous);
      }
      if (claimsToAdd.length) {
        row = await store.update<PublicationDbRecord>(actor.roomId, 'onboarding_ai_publications', row.id, {
          supersedesBatchIds: [...new Set([...(row.supersedesBatchIds ?? []), ...claimsToAdd])], updatedAt: now(),
        }, { expectedUpdatedAt: row.updatedAt });
      }
      // Persist the complete selection before any revision or external artifact work.
      // If interrupted, replaying a settings operation reuses its valid revision.
      for (let index = 0; index < row.targets.length; index += 1) {
        const target = row.targets[index];
        let detail: AdminTemplateDetail = await reviewDetail(actor, target.templateId, target.version);
        if (target.materializedFingerprint !== materializedModuleFingerprint(detail)) {
          throw new AiReviewServiceError('REVIEW_CONFLICT', 'Publication content changed. Review the current draft first.');
        }
        await assertModuleTemplateCurrent(store, actor, detail);
        if (target.settings) detail = await service.updateReview(actor, { templateId: detail.id, version: detail.version,
          expectedUpdatedAt: detail.updatedAt, ops: [{ kind: 'set_settings', ...target.settings }] });
        if (detail.version !== target.version) {
          const targets: readonly AiPublicationTarget[] = row.targets.map((item, i) => i === index
            ? { ...item, version: detail.version, materializedFingerprint: materializedModuleFingerprint(detail) } : item);
          row = await store.update<PublicationDbRecord>(actor.roomId, 'onboarding_ai_publications', row.id,
            { targets, updatedAt: now() }, { expectedUpdatedAt: row.updatedAt });
        }
      }
      await reconcilePredecessors(actor, row);
      return publicationBatch(row);
    },

    async listIncompletePublications(actor) {
      requireAdmin(actor);
      const batches: AiPublicationBatch[] = [];
      for (const row of await effectivePublications(actor, await ownedPublications(actor))) {
        if (row.retiredAt) continue;
        try {
          const states = await Promise.all(row.targets.map((target) => publicationTargetFinished(actor, target)));
          if (!states.every(Boolean)) batches.push(publicationBatch(row));
          else if (states.includes('archived')) {
            // An archived template is never published again: retire the batch so no later session
            // reopens it. Best effort; a lost race only means the next listing retires it again.
            // A completed batch stays as it is, so retrying it keeps its batch ID.
            await retirePublication(actor, row, 'finished').catch(() => undefined);
          }
        } catch (error) {
          if (!(error instanceof TemplateServiceError) || error.code !== 'TEMPLATE_NOT_FOUND') throw error;
          // A deleted target ends only its own batch; other selections remain recoverable.
          await retirePublication(actor, row, 'missing_target');
        }
      }
      return batches;
    },

    async getReview(actor, templateId, version) {
      return reviewDetail(actor, templateId, version);
    },

    async updateReview(actor, input) {
      const detail = await reviewDetail(actor, input.templateId, input.version);
      if (detail.updatedAt !== input.expectedUpdatedAt) {
        throw new AiReviewServiceError('REVIEW_CONFLICT', 'Template changed after this review loaded it.');
      }
      if (input.ops.length === 0) return detail;
      if (input.ops.some((op) => op.kind === 'checkpoint_publication')) {
        if (input.ops.length !== 1 || input.ops[0].kind !== 'checkpoint_publication') throw new AiReviewServiceError('REVIEW_INVALID', 'Checkpoint one publication artifact at a time.');
        const op = input.ops[0];
        let next: NonNullable<TemplateContentSnapshot['publication']>;
        if ('jsonFileId' in op) {
          if (detail.status !== 'published' || !op.jsonFileId?.trim()) throw new AiReviewServiceError('REVIEW_INVALID', 'A published template and JSON file ID are required.');
          next = { pdfs: {}, jsonFileId: op.jsonFileId.trim() };
        } else {
          if (!detail.modules.some((m) => m.id === op.moduleId) || op.resource?.id !== 'ai-lesson-pdf-' + op.moduleId
            || op.resource.kind !== 'file' || !op.resource.required || !op.resource.fileId?.trim() || !op.resource.title?.trim()) throw new AiReviewServiceError('REVIEW_INVALID', 'A valid lesson PDF resource is required.');
          next = { pdfs: { [op.moduleId]: op.resource } };
        }
        const rows = await store.query<TemplateContentDbRecord>(actor.roomId, 'onboarding_template_content', { filter: { templateId: detail.id, templateVersion: detail.version }, limit: 1 });
        const row = rows.records[0];
        if (!row) throw new AiReviewServiceError('REVIEW_NOT_FOUND', 'Template content not found.');
        // Settings and independent artifact checkpoints may have changed after
        // detail was read. Only merge into the same instructional snapshot.
        const identity = (content: TemplateContentSnapshot) => {
          const { publication: _publication, ...snapshot } = content;
          return JSON.stringify(snapshot);
        };
        if (identity(row.content) !== identity(detail.content)) throw new AiReviewServiceError('REVIEW_CONFLICT', 'Publication content changed. Review the current draft first.');
        const latest = await templates.getAdminDetail(actor, detail.id, detail.version);
        if (latest.updatedAt !== detail.updatedAt || latest.passingScore !== detail.passingScore || latest.status !== detail.status) throw new AiReviewServiceError('REVIEW_CONFLICT', 'Publication settings changed. Review the current draft first.');
        const publication = row.content.publication ?? { pdfs: {} };
        const merged = { ...publication, ...next, pdfs: { ...publication.pdfs, ...next!.pdfs } };
        await store.update(actor.roomId, 'onboarding_template_content', row.id, { content: { ...row.content, publication: merged }, updatedAt: now() }, { expectedUpdatedAt: row.updatedAt });
        return templates.getAdminDetail(actor, detail.id, detail.version);
      }
      if (detail.content.moduleApproval && input.ops.some((op) => op.kind !== 'set_settings' && op.kind !== 'upsert_generated_resource')) {
        throw new AiReviewServiceError('REVIEW_INVALID', 'Edit and approve lessons and questions in the module workspace first.');
      }
      const updatedState = applyReviewOperations(detail, input.ops);
      if (input.ops.every((op) => op.kind === 'set_settings')
        && updatedState.passingScore === detail.passingScore
        && updatedState.content.learningMode === detail.content.learningMode
        && updatedState.content.maxAttemptsPerModule === detail.content.maxAttemptsPerModule) return detail;
      const flags = reopenTouchedFlags(detail.flags, input.ops);
      const updated = await save(
        actor,
        detail,
        input.expectedUpdatedAt,
        updatedState.modules,
        updatedState.content,
        flags,
        updatedState.passingScore,
        input.ops.every((op) => op.kind === 'set_settings'),
      );
      await audit(actor, 'ai_template.manual_edit', updated.id, {
        fromVersion: detail.version,
        toVersion: updated.version,
        operationKinds: input.ops.map((operation) => operation.kind),
      });
      return updated;
    },

    async resolveFlag(actor, input) {
      const detail = await reviewDetail(actor, input.templateId, input.version);
      if (detail.status !== 'draft') {
        throw new AiReviewServiceError('REVIEW_INVALID', 'Create a draft revision before resolving flags.');
      }
      if (input.expectedUpdatedAt && detail.updatedAt !== input.expectedUpdatedAt) {
        throw new AiReviewServiceError('REVIEW_CONFLICT', 'Template changed after this review loaded it.');
      }
      const flag = detail.flags.find((item) => item.id === input.flagId);
      if (!flag) throw new AiReviewServiceError('FLAG_NOT_FOUND', 'The verification flag was not found.');
      if (detail.content.moduleApproval && input.action === 'remove') {
        throw new AiReviewServiceError('REVIEW_INVALID', 'Change and approve module content in the module workspace first.');
      }
      const note = input.note?.trim();
      const timestamp = now();
      let modules = detail.modules;
      let content = detail.content;
      let evidence = [...flag.evidence];
      let status: VerificationFlag['status'] = 'resolved';

      if (input.action === 'accept') {
        if (flag.severity !== 'warning') {
          throw new AiReviewServiceError('FLAG_ACTION_INVALID', 'Only warning flags can be accepted.');
        }
        status = 'dismissed';
      } else if (input.action === 'choose_option') {
        if (flag.type !== 'conflict') {
          throw new AiReviewServiceError('FLAG_ACTION_INVALID', 'Only conflict flags support choosing evidence.');
        }
        const index = input.chosenEvidenceIndex;
        if (index === undefined || index < 0 || index >= evidence.length) {
          throw new AiReviewServiceError('FLAG_ACTION_INVALID', 'Choose a valid evidence option.');
        }
        evidence = evidence.map((ref, evidenceIndex) => evidenceIndex === index
          ? { ...ref, verifiedBy: actor.userId, verifiedAt: timestamp }
          : ref);
      } else if (input.action === 'add_note') {
        if (!note) throw new AiReviewServiceError('FLAG_ACTION_INVALID', 'A resolution note is required.');
        const summary = await sources.addAdminNote(actor, {
          operationId: 'flag-note:' + detail.id + ':' + detail.version + ':' + flag.id,
          title: 'Xác minh ' + flag.id,
          text: note,
        });
        const rows = await store.query<SourceDbRecord>(actor.roomId, 'onboarding_sources', {
          filter: { sourceId: summary.sourceId },
          limit: 1,
        });
        const section = rows.records[0]?.sections?.[0];
        if (!section) throw new AiReviewServiceError('REVIEW_INVALID', 'The Admin note was not persisted.');
        const ref: SourceRef = {
          kind: 'admin_note',
          sourceId: summary.sourceId,
          sectionId: section.id,
          ...(section.page === undefined ? {} : { page: section.page }),
          quote: section.text.slice(0, 300),
          verifiedBy: actor.userId,
          verifiedAt: timestamp,
        };
        evidence.push(ref);
        if (!content.moduleApproval) content = {
          ...content,
          modules: content.modules.map((module) => ({
            ...module,
            blocks: module.blocks.map((block) => block.id === flag.location.blockId
              ? { ...block, sourceRefs: [...block.sourceRefs, ref] }
              : block),
          })),
          questionMeta: content.questionMeta.map((meta) => meta.questionId === flag.location.questionId
            ? { ...meta, sourceRefs: [...meta.sourceRefs, ref] }
            : meta),
        };
      } else if (input.action === 'remove') {
        const operation: AiReviewOperation | undefined = flag.location.questionId
          ? { kind: 'remove_question', questionId: flag.location.questionId }
          : flag.location.blockId && flag.location.moduleId
            ? { kind: 'remove_block', moduleId: flag.location.moduleId, blockId: flag.location.blockId }
            : flag.location.moduleId
              ? { kind: 'remove_module', moduleId: flag.location.moduleId }
              : undefined;
        if (!operation) {
          throw new AiReviewServiceError('FLAG_ACTION_INVALID', 'The flag has no removable content target.');
        }
        const state = applyReviewOperations(detail, [operation]);
        modules = state.modules;
        content = state.content;
      } else {
        throw new AiReviewServiceError(
          'FLAG_ACTION_INVALID',
          'Upload the document as a source before resolving the flag.',
        );
      }

      const resolution: NonNullable<VerificationFlag['resolution']> = {
        action: input.action,
        ...(note ? { note } : {}),
        by: actor.userId,
        at: timestamp,
      };
      const flags = detail.flags.map((item) => item.id === flag.id
        ? { ...item, evidence, status, resolution }
        : item);
      const updated = await save(
        actor,
        detail,
        detail.updatedAt,
        modules,
        content,
        flags,
      );
      await audit(actor, 'ai_flag.resolved', updated.id, {
        flagId: flag.id,
        before: flag.status,
        after: status,
        action: input.action,
        note,
      });
      return updated;
    },
  };
  return service;
}
