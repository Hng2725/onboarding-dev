import { createHash } from 'node:crypto';

import type { OnboardingActor } from '../auth';
import type {
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

function stableId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex')
    .slice(0, 24);
  return prefix + '-' + digest;
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
  if (actor.access !== 'admin') {
    throw new AiMaterializationError('ADMIN_REQUIRED', 'Admin access is required.');
  }
  const jobId = required(input.jobId, 'Job ID');
  if (
    input.sources.length === 0
    || input.sources.some((source) =>
      source.roomId !== actor.roomId || source.status !== 'ready' || Boolean(source.deletedAt))
  ) {
    throw new AiMaterializationError('SOURCE_NOT_FOUND', 'Every materialization source must be active in this room.');
  }
  if (input.templateKind === 'advanced' && !input.roleProfile) {
    throw new AiMaterializationError('AI_CONTENT_INVALID', 'Advanced templates require a role profile.');
  }
  const templateId = stableId('ai-template', actor.roomId, jobId);
  const moduleIds = new Map<string, string>();
  const blockIds = new Map<string, string>();
  const questionIds = new Map<string, string>();
  input.generated.modules.forEach((module) => {
    moduleIds.set(module.localId, stableId('ai-mod', templateId, module.localId));
    module.blocks.forEach((block) => {
      blockIds.set(block.localId, stableId('ai-block', templateId, module.localId, block.localId));
    });
    module.questions.forEach((question) => {
      questionIds.set(question.localId, stableId('ai-q', templateId, module.localId, question.localId));
    });
  });

  const flags: VerificationFlag[] = input.generated.flags.map((flag, index) => ({
    id: stableId(
      'ai-flag',
      templateId,
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
        ? { blockId: blockIds.get(flag.location.blockLocalId) }
        : {}),
      ...(flag.location.questionLocalId
        ? { questionId: questionIds.get(flag.location.questionLocalId) }
        : {}),
      ...(flag.location.featureId ? { featureId: flag.location.featureId } : {}),
    },
    evidence: grounded(flag.evidence, input.sources, 'Flag ' + String(index + 1), false),
    status: 'open',
  }));
  const pendingBlocks = new Set(flags
    .filter((flag) => flag.severity === 'warning' && flag.status === 'open')
    .map((flag) => flag.location.blockId)
    .filter((id): id is string => Boolean(id)));

  let questionIndex = 0;
  const contentModules: ModuleContent[] = [];
  const questionMeta: QuestionMeta[] = [];
  const draftModules: TemplateDraftInput['modules'][number][] = [];
  for (const generatedModule of input.generated.modules) {
    const moduleId = moduleIds.get(generatedModule.localId);
    if (!moduleId) throw new AiMaterializationError('AI_CONTENT_INVALID', 'A module ID could not be materialized.');
    const blocks: LessonBlock[] = generatedModule.blocks.map((block) => {
      const blockId = blockIds.get(block.localId);
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
          block.kind !== 'summary',
        ),
        pendingVerification: pendingBlocks.has(blockId),
      };
    });
    const questions: OnboardingQuestion[] = generatedModule.questions.map((question) => {
      const questionId = questionIds.get(question.localId);
      if (!questionId) {
        throw new AiMaterializationError('AI_CONTENT_INVALID', 'A question ID could not be materialized.');
      }
      const balanced = balancedOptions(
        templateId,
        question.localId,
        questionIndex++,
        question.options,
        question.correctOptionId,
      );
      const mappedBlockIds = question.blockIds.map((localId) => blockIds.get(localId))
        .filter((id): id is string => Boolean(id));
      if (mappedBlockIds.length !== question.blockIds.length) {
        throw new AiMaterializationError('AI_CONTENT_INVALID', 'A question references an unknown lesson block.');
      }
      questionMeta.push({
        questionId,
        level: question.level,
        sourceRefs: grounded(question.sourceRefs, input.sources, 'Question ' + question.localId, true),
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
  const detail = await templates.createAiDraft(actor, {
    templateId,
    draft,
    content,
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
