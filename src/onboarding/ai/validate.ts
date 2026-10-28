import type { EmployeeType, FlagType, QuestionLevel, RoleProfile } from '../contracts';
import { normalizeForMatch, type RawSourceRef } from './grounding';
import { AI_GENERATION_LIMITS } from './limits';

export interface GeneratedOption {
  readonly id: string;
  readonly label: string;
}

export interface GeneratedQuestion {
  readonly localId: string;
  readonly level: QuestionLevel;
  readonly prompt: string;
  readonly options: readonly GeneratedOption[];
  readonly correctOptionId: string;
  readonly explanation: string;
  readonly blockIds: readonly string[];
  readonly sourceRefs: readonly RawSourceRef[];
}

export interface GeneratedBlock {
  readonly localId: string;
  readonly kind: 'concept' | 'steps' | 'scenario' | 'tip' | 'warning' | 'summary';
  readonly title?: string;
  readonly body: string;
  readonly steps?: readonly { readonly order: number; readonly text: string }[];
  readonly sourceRefs: readonly RawSourceRef[];
}

export interface GeneratedModule {
  readonly localId: string;
  readonly frameKey: string;
  readonly title: string;
  readonly description: string;
  readonly estimatedMinutes: number;
  readonly objectives: readonly string[];
  readonly featureIds: readonly string[];
  readonly blocks: readonly GeneratedBlock[];
  readonly questions: readonly GeneratedQuestion[];
}

export interface GeneratedFlag {
  readonly type: FlagType;
  readonly severity: 'blocking' | 'warning';
  readonly message: string;
  readonly questionForAdmin: string;
  readonly location: {
    readonly frameKey?: string;
    readonly moduleLocalId?: string;
    readonly blockLocalId?: string;
    readonly questionLocalId?: string;
    readonly featureId?: string;
  };
  readonly evidence: readonly RawSourceRef[];
}

export interface GeneratedTaskCoverage {
  readonly task: string;
  readonly featureIds: readonly string[];
  readonly relevance: 'explicit' | 'inferred';
  readonly relevanceRationale: string;
  readonly moduleLocalId: string | null;
  readonly flagIndex: number | null;
}

export interface GeneratedTemplate {
  readonly title: string;
  readonly description: string;
  readonly generationNotes: readonly string[];
  readonly modules: readonly GeneratedModule[];
  readonly flags: readonly GeneratedFlag[];
  readonly taskCoverage?: readonly GeneratedTaskCoverage[];
}

export interface GeneratedTemplateValidationOptions {
  readonly templateKind: EmployeeType;
  readonly roleProfile?: RoleProfile;
  /** Validates the lessons stage alone: question fields are ignored until the question stage. */
  readonly lessonsOnly?: boolean;
}

export interface ValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type GeneratedTemplateValidation =
  | {
    readonly ok: true;
    readonly value: GeneratedTemplate;
    readonly errors: readonly [];
    readonly generationNotes: readonly string[];
  }
  | {
    readonly ok: false;
    readonly errors: readonly ValidationError[];
    readonly generationNotes: readonly string[];
  };

export const NORMAL_FRAMES = [
  't1-overview',
  't1-access',
  't1-navigation',
  't1-core',
  't1-core-2',
  't1-data',
  't1-security',
  't1-support',
] as const;
export const ADVANCED_FRAMES = [
  't2-role',
  't2-permissions',
  't2-task-1',
  't2-task-2',
  't2-task-3',
  't2-task-4',
  't2-task-5',
  't2-task-6',
  't2-collab',
  't2-reports',
  't2-control',
] as const;
const BLOCK_KINDS = ['concept', 'steps', 'scenario', 'tip', 'warning', 'summary'] as const;
const QUESTION_LEVELS = ['recall', 'procedure', 'scenario'] as const;
const FLAG_TYPES: readonly FlagType[] = [
  'missing',
  'conflict',
  'ambiguous',
  'outdated',
  'unsupported',
  'audience_unclear',
  'low_quality_source',
  'generation_error',
];
const FORBIDDEN_OPTIONS = [
  'tất cả các đáp án',
  'tất cả đáp án trên',
  'không có đáp án nào',
  'cả a và b',
  'cả a, b',
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function add(
  errors: ValidationError[],
  code: string,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

export function fields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: ValidationError[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) add(errors, 'UNKNOWN_FIELD', path + '.' + key, 'Unknown field.');
  }
}

export function text(
  value: unknown,
  path: string,
  errors: ValidationError[],
  maximum = 10_000,
): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    add(errors, 'FIELD_INVALID', path, 'A non-empty bounded string is required.');
    return '';
  }
  return value.trim();
}

export function stringArray(
  value: unknown,
  path: string,
  errors: ValidationError[],
): readonly string[] {
  if (!Array.isArray(value)) {
    add(errors, 'FIELD_INVALID', path, 'An array of strings is required.');
    return [];
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    result.push(text(entry, path + '[' + String(index) + ']', errors, 500));
  });
  return result;
}

function rawRefs(
  value: unknown,
  path: string,
  errors: ValidationError[],
): readonly RawSourceRef[] {
  if (!Array.isArray(value)) {
    add(errors, 'FIELD_INVALID', path, 'sourceRefs must be an array.');
    return [];
  }
  const refs: RawSourceRef[] = [];
  value.forEach((entry, index) => {
    const itemPath = path + '[' + String(index) + ']';
    if (!isRecord(entry)) {
      add(errors, 'FIELD_INVALID', itemPath, 'A source reference object is required.');
      return;
    }
    fields(entry, ['sectionId', 'quote'], itemPath, errors);
    refs.push({
      sectionId: text(entry.sectionId, itemPath + '.sectionId', errors, 250),
      quote: text(entry.quote, itemPath + '.quote', errors, AI_GENERATION_LIMITS.maxQuoteChars),
    });
  });
  return refs;
}

function flagMissingRequiredFrame(flags: readonly GeneratedFlag[], frameKey: string): boolean {
  return flags.some((flag) =>
    flag.type === 'missing'
    && flag.severity === 'blocking'
    && normalizeForMatch(flag.message + ' ' + flag.questionForAdmin).includes(
      normalizeForMatch(frameKey.replace('t1-', '')),
    ));
}

const REQUIRED_SEVERITY: Partial<Record<FlagType, 'blocking' | 'warning'>> = {
  conflict: 'blocking',
  generation_error: 'blocking',
  ambiguous: 'warning',
  outdated: 'warning',
  audience_unclear: 'warning',
  low_quality_source: 'warning',
};

const LOCATION_ALIASES: Readonly<Record<string, string>> = {
  moduleId: 'moduleLocalId',
  blockId: 'blockLocalId',
  questionId: 'questionLocalId',
};

/**
 * Repairs shapes models repeatedly produced (copied inventory flag ids, top-level featureId,
 * public-id location keys, severities the flag type already fixes, a single note string)
 * without a model round trip. Content rules are still validated afterwards.
 */
function normalizeFlag(entry: unknown, frameModules: ReadonlyMap<string, string>): unknown {
  if (!isRecord(entry)) return entry;
  const { id: _id, featureId, ...flag } = entry;
  const location: Record<string, unknown> = isRecord(flag.location) ? { ...flag.location } : {};
  for (const [alias, key] of Object.entries(LOCATION_ALIASES)) {
    if (location[alias] === undefined) continue;
    if (location[key] === undefined) location[key] = location[alias];
    delete location[alias];
  }
  if (location.frameKey !== undefined) {
    const moduleLocalId = typeof location.frameKey === 'string'
      ? frameModules.get(location.frameKey)
      : undefined;
    if (moduleLocalId && location.moduleLocalId === undefined) location.moduleLocalId = moduleLocalId;
    delete location.frameKey;
  }
  if (typeof featureId === 'string' && location.featureId === undefined) location.featureId = featureId;
  const required = typeof flag.type === 'string'
    ? REQUIRED_SEVERITY[flag.type as FlagType]
    : undefined;
  return {
    ...flag,
    ...(required ? { severity: required } : {}),
    location,
    evidence: flag.evidence ?? [],
  };
}

function normalizeTemplateShape(value: Record<string, unknown>): Record<string, unknown> {
  const frameModules = new Map<string, string>();
  if (Array.isArray(value.modules)) {
    for (const module of value.modules) {
      if (isRecord(module) && typeof module.frameKey === 'string' && typeof module.localId === 'string') {
        frameModules.set(module.frameKey, module.localId);
      }
    }
  }
  const modules = Array.isArray(value.modules)
    ? value.modules.map((module) => {
      if (!isRecord(module) || !Array.isArray(module.questions)) return module;
      return {
        ...module,
        questions: module.questions.map((question) => {
          if (!isRecord(question) || !Array.isArray(question.options)) return question;
          return {
            ...question,
            // Models often name the option label `text`; the meaning is identical.
            options: question.options.map((option) => {
              if (!isRecord(option) || option.label !== undefined || typeof option.text !== 'string') return option;
              const { text: label, ...rest } = option;
              return { ...rest, label };
            }),
          };
        }),
      };
    })
    : value.modules;
  return {
    ...value,
    modules,
    generationNotes: typeof value.generationNotes === 'string'
      ? [value.generationNotes]
      : value.generationNotes ?? [],
    flags: Array.isArray(value.flags)
      ? value.flags.map((flag) => normalizeFlag(flag, frameModules))
      : value.flags ?? [],
  };
}

export function parseFlags(
  value: unknown,
  errors: ValidationError[],
): readonly GeneratedFlag[] {
  if (!Array.isArray(value)) {
    add(errors, 'FIELD_INVALID', 'root.flags', 'flags must be an array.');
    return [];
  }
  const flags: GeneratedFlag[] = [];
  value.forEach((entry, index) => {
    const path = 'root.flags[' + String(index) + ']';
    if (!isRecord(entry)) {
      add(errors, 'FIELD_INVALID', path, 'A flag object is required.');
      return;
    }
    fields(entry, ['type', 'severity', 'message', 'questionForAdmin', 'location', 'evidence'], path, errors);
    const type = text(entry.type, path + '.type', errors) as FlagType;
    if (!FLAG_TYPES.includes(type)) add(errors, 'FLAG_TYPE', path + '.type', 'Unknown flag type.');
    const severity = text(entry.severity, path + '.severity', errors);
    if (severity !== 'blocking' && severity !== 'warning') {
      add(errors, 'FLAG_SEVERITY', path + '.severity', 'Invalid flag severity.');
    }
    const location = isRecord(entry.location) ? entry.location : {};
    if (!isRecord(entry.location)) add(errors, 'FIELD_INVALID', path + '.location', 'Flag location is required.');
    fields(location, ['moduleLocalId', 'blockLocalId', 'questionLocalId', 'featureId'], path + '.location', errors);
    const evidence = rawRefs(entry.evidence, path + '.evidence', errors);
    if (type === 'conflict' && evidence.length < 2) {
      add(errors, 'FLAG_EVIDENCE', path + '.evidence', 'A conflict requires two source references.');
    }
    const expectedWarning = ['ambiguous', 'outdated', 'audience_unclear', 'low_quality_source'];
    if ((type === 'conflict' || type === 'generation_error') && severity !== 'blocking') {
      add(errors, 'FLAG_SEMANTICS', path + '.severity', 'This flag type must be blocking.');
    }
    if (expectedWarning.includes(type) && severity !== 'warning') {
      add(errors, 'FLAG_SEMANTICS', path + '.severity', 'This flag type must be a warning.');
    }
    flags.push({
      type,
      severity: severity === 'warning' ? 'warning' : 'blocking',
      message: text(entry.message, path + '.message', errors, 1_000),
      questionForAdmin: text(entry.questionForAdmin, path + '.questionForAdmin', errors, 1_000),
      location: {
        ...(typeof location.moduleLocalId === 'string' ? { moduleLocalId: location.moduleLocalId } : {}),
        ...(typeof location.blockLocalId === 'string' ? { blockLocalId: location.blockLocalId } : {}),
        ...(typeof location.questionLocalId === 'string' ? { questionLocalId: location.questionLocalId } : {}),
        ...(typeof location.featureId === 'string' ? { featureId: location.featureId } : {}),
      },
      evidence,
    });
  });
  return flags;
}

export function parseBlocks(
  value: unknown,
  modulePath: string,
  errors: ValidationError[],
  ids: Set<string>,
  allowUnreferenced = false,
): readonly GeneratedBlock[] {
  if (!Array.isArray(value)) {
    add(errors, 'FIELD_INVALID', modulePath + '.blocks', 'blocks must be an array.');
    return [];
  }
  const blocks: GeneratedBlock[] = [];
  value.forEach((entry, index) => {
    const path = modulePath + '.blocks[' + String(index) + ']';
    if (!isRecord(entry)) {
      add(errors, 'FIELD_INVALID', path, 'A block object is required.');
      return;
    }
    fields(entry, ['localId', 'kind', 'title', 'body', 'steps', 'sourceRefs'], path, errors);
    const localId = text(entry.localId, path + '.localId', errors, 120);
    if (ids.has(localId)) add(errors, 'DUPLICATE_ID', path + '.localId', 'IDs must be unique.');
    ids.add(localId);
    const kind = text(entry.kind, path + '.kind', errors) as GeneratedBlock['kind'];
    if (!BLOCK_KINDS.includes(kind)) add(errors, 'BLOCK_KIND', path + '.kind', 'Unknown block kind.');
    const refs = rawRefs(entry.sourceRefs, path + '.sourceRefs', errors);
    if (!allowUnreferenced && kind !== 'summary' && refs.length === 0) {
      add(errors, 'SOURCE_REF_REQUIRED', path + '.sourceRefs', 'Non-summary blocks require a source.');
    }
    let steps: GeneratedBlock['steps'];
    if (entry.steps !== undefined) {
      if (!Array.isArray(entry.steps)) {
        add(errors, 'FIELD_INVALID', path + '.steps', 'steps must be an array.');
      } else {
        steps = entry.steps.map((rawStep, stepIndex) => {
          const stepPath = path + '.steps[' + String(stepIndex) + ']';
          const step = isRecord(rawStep) ? rawStep : {};
          if (!isRecord(rawStep)) add(errors, 'FIELD_INVALID', stepPath, 'A step object is required.');
          fields(step, ['order', 'text'], stepPath, errors);
          if (step.order !== stepIndex + 1) {
            add(errors, 'STEP_ORDER', stepPath + '.order', 'Steps must be numbered from one.');
          }
          return {
            order: typeof step.order === 'number' ? step.order : 0,
            text: text(step.text, stepPath + '.text', errors, 1_000),
          };
        });
      }
    }
    if (kind === 'steps' && (!steps || steps.length === 0)) {
      add(errors, 'STEPS_REQUIRED', path + '.steps', 'A steps block requires numbered steps.');
    }
    blocks.push({
      localId,
      kind,
      ...(typeof entry.title === 'string' && entry.title.trim() ? { title: entry.title.trim() } : {}),
      body: text(entry.body, path + '.body', errors, 20_000),
      ...(steps ? { steps } : {}),
      sourceRefs: refs,
    });
  });
  return blocks;
}

export function parseQuestions(
  value: unknown,
  modulePath: string,
  blockIds: ReadonlySet<string>,
  errors: ValidationError[],
  ids: Set<string>,
  allowUnreferenced = false,
): readonly GeneratedQuestion[] {
  if (!Array.isArray(value)) {
    add(errors, 'FIELD_INVALID', modulePath + '.questions', 'questions must be an array.');
    return [];
  }
  if (
    value.length < AI_GENERATION_LIMITS.questionRange.min
    || value.length > AI_GENERATION_LIMITS.questionRange.max
  ) {
    add(errors, 'QUESTION_COUNT', modulePath + '.questions', 'Each module requires 3 to 5 questions.');
  }
  const questions: GeneratedQuestion[] = [];
  value.forEach((entry, index) => {
    const path = modulePath + '.questions[' + String(index) + ']';
    if (!isRecord(entry)) {
      add(errors, 'FIELD_INVALID', path, 'A question object is required.');
      return;
    }
    fields(entry, [
      'localId', 'level', 'prompt', 'options', 'correctOptionId',
      'explanation', 'blockIds', 'sourceRefs',
    ], path, errors);
    const localId = text(entry.localId, path + '.localId', errors, 120);
    if (ids.has(localId)) add(errors, 'DUPLICATE_ID', path + '.localId', 'IDs must be unique.');
    ids.add(localId);
    const level = text(entry.level, path + '.level', errors) as QuestionLevel;
    if (!QUESTION_LEVELS.includes(level)) add(errors, 'QUESTION_LEVEL', path + '.level', 'Invalid question level.');
    const options: GeneratedOption[] = [];
    if (!Array.isArray(entry.options)) {
      add(errors, 'FIELD_INVALID', path + '.options', 'options must be an array.');
    } else {
      entry.options.forEach((rawOption, optionIndex) => {
        const optionPath = path + '.options[' + String(optionIndex) + ']';
        const option = isRecord(rawOption) ? rawOption : {};
        if (!isRecord(rawOption)) add(errors, 'FIELD_INVALID', optionPath, 'An option object is required.');
        fields(option, ['id', 'label'], optionPath, errors);
        options.push({
          id: text(option.id, optionPath + '.id', errors, 5),
          label: text(option.label, optionPath + '.label', errors, 500),
        });
      });
    }
    if (
      options.length !== AI_GENERATION_LIMITS.optionCount
      || options.map((option) => option.id).join(',') !== 'a,b,c,d'
    ) {
      add(errors, 'OPTION_IDS', path + '.options', 'Option IDs must be exactly a, b, c, d.');
    }
    const normalizedLabels = options.map((option) => normalizeForMatch(option.label));
    if (new Set(normalizedLabels).size !== normalizedLabels.length) {
      add(errors, 'OPTION_LABEL_DUPLICATE', path + '.options', 'Option labels must be unique.');
    }
    if (normalizedLabels.some((label) => FORBIDDEN_OPTIONS.some((phrase) => label.includes(phrase)))) {
      add(errors, 'OPTION_FORBIDDEN', path + '.options', 'A forbidden catch-all option was used.');
    }
    const correctOptionId = text(entry.correctOptionId, path + '.correctOptionId', errors, 5);
    if (!options.some((option) => option.id === correctOptionId)) {
      add(errors, 'CORRECT_OPTION', path + '.correctOptionId', 'The correct option must exist.');
    }
    const explanation = text(entry.explanation, path + '.explanation', errors, 400);
    if (explanation.length < 20 || explanation.length > 400) {
      add(errors, 'EXPLANATION_LENGTH', path + '.explanation', 'Explanation must be 20 to 400 characters.');
    }
    const questionBlockIds = stringArray(entry.blockIds, path + '.blockIds', errors);
    if (
      questionBlockIds.length === 0
      || questionBlockIds.some((blockId) => !blockIds.has(blockId))
    ) {
      add(errors, 'QUESTION_BLOCK_UNKNOWN', path + '.blockIds', 'Questions must reference blocks in their module.');
    }
    const refs = rawRefs(entry.sourceRefs, path + '.sourceRefs', errors);
    if (!allowUnreferenced && refs.length === 0) add(errors, 'SOURCE_REF_REQUIRED', path + '.sourceRefs', 'Questions require a source.');
    questions.push({
      localId,
      level,
      prompt: text(entry.prompt, path + '.prompt', errors, 1_000),
      options,
      correctOptionId,
      explanation,
      blockIds: questionBlockIds,
      sourceRefs: refs,
    });
  });
  return questions;
}

function parseTaskCoverage(
  value: unknown,
  flags: readonly GeneratedFlag[],
  moduleIds: ReadonlySet<string>,
  options: GeneratedTemplateValidationOptions,
  errors: ValidationError[],
): readonly GeneratedTaskCoverage[] | undefined {
  if (options.templateKind === 'normal') {
    if (value !== undefined) add(errors, 'TASK_COVERAGE_UNEXPECTED', 'root.taskCoverage', 'Normal templates have no task coverage.');
    return undefined;
  }
  if (!Array.isArray(value)) {
    add(errors, 'RESPONSIBILITY_COVERAGE', 'root.taskCoverage', 'Advanced templates require task coverage.');
    return [];
  }
  const coverage: GeneratedTaskCoverage[] = [];
  value.forEach((entry, index) => {
    const path = 'root.taskCoverage[' + String(index) + ']';
    if (!isRecord(entry)) {
      add(errors, 'FIELD_INVALID', path, 'A task coverage object is required.');
      return;
    }
    fields(entry, [
      'task', 'featureIds', 'relevance', 'relevanceRationale', 'moduleLocalId', 'flagIndex',
    ], path, errors);
    const relevance = text(entry.relevance, path + '.relevance', errors);
    if (relevance !== 'explicit' && relevance !== 'inferred') {
      add(errors, 'TASK_RELEVANCE', path + '.relevance', 'Invalid relevance.');
    }
    const rationale = typeof entry.relevanceRationale === 'string'
      ? entry.relevanceRationale.trim()
      : '';
    if (relevance === 'inferred' && !rationale) {
      add(errors, 'TASK_RATIONALE', path + '.relevanceRationale', 'Inferred coverage requires a rationale.');
    }
    const moduleLocalId = entry.moduleLocalId === null
      ? null
      : text(entry.moduleLocalId, path + '.moduleLocalId', errors, 120);
    const flagIndex = entry.flagIndex === null
      ? null
      : typeof entry.flagIndex === 'number' && Number.isInteger(entry.flagIndex)
        ? entry.flagIndex
        : -1;
    if (moduleLocalId !== null && !moduleIds.has(moduleLocalId)) {
      add(errors, 'TASK_MODULE_UNKNOWN', path + '.moduleLocalId', 'Task module does not exist.');
    }
    if (
      moduleLocalId === null
      && (flagIndex === null || flagIndex < 0 || flags[flagIndex]?.type !== 'missing')
    ) {
      add(errors, 'TASK_MISSING_FLAG', path + '.flagIndex', 'An uncovered task requires a missing flag.');
    }
    coverage.push({
      task: text(entry.task, path + '.task', errors, 500),
      featureIds: stringArray(entry.featureIds, path + '.featureIds', errors),
      relevance: relevance === 'inferred' ? 'inferred' : 'explicit',
      relevanceRationale: rationale,
      moduleLocalId,
      flagIndex: flagIndex === -1 ? null : flagIndex,
    });
  });

  const expected = options.roleProfile?.responsibilities.map(normalizeForMatch) ?? [];
  const actual = coverage.map((entry) => normalizeForMatch(entry.task));
  if (
    expected.length !== actual.length
    || new Set(actual).size !== actual.length
    || expected.some((task) => !actual.includes(task))
  ) {
    add(
      errors,
      'RESPONSIBILITY_COVERAGE',
      'root.taskCoverage',
      'Every responsibility must occur exactly once.',
    );
  }
  return coverage;
}

export function validateGeneratedTemplate(
  rawValue: unknown,
  options: GeneratedTemplateValidationOptions,
): GeneratedTemplateValidation {
  const errors: ValidationError[] = [];
  const warningNotes: string[] = [];
  if (!isRecord(rawValue)) {
    return {
      ok: false,
      errors: [{ code: 'FIELD_INVALID', path: 'root', message: 'A template object is required.' }],
      generationNotes: [],
    };
  }
  const value = normalizeTemplateShape(rawValue);
  fields(value, ['title', 'description', 'generationNotes', 'modules', 'flags', 'taskCoverage'], 'root', errors);
  const title = text(value.title, 'root.title', errors, 160);
  const description = text(value.description, 'root.description', errors, 2_000);
  const generationNotes = stringArray(value.generationNotes, 'root.generationNotes', errors);
  const flags = parseFlags(value.flags, errors);
  const ids = new Set<string>();
  const rawModules = Array.isArray(value.modules) ? value.modules : [];
  if (!Array.isArray(value.modules)) add(errors, 'FIELD_INVALID', 'root.modules', 'modules must be an array.');
  const range = options.templateKind === 'normal'
    ? AI_GENERATION_LIMITS.normalModuleRange
    : AI_GENERATION_LIMITS.advancedModuleRange;
  if (rawModules.length < range.min || rawModules.length > range.max) {
    add(errors, 'MODULE_COUNT', 'root.modules', 'Template module count is outside the allowed range.');
  }
  const frames = options.templateKind === 'normal' ? NORMAL_FRAMES : ADVANCED_FRAMES;
  const modules: GeneratedModule[] = [];
  rawModules.forEach((entry, index) => {
    const path = 'root.modules[' + String(index) + ']';
    if (!isRecord(entry)) {
      add(errors, 'FIELD_INVALID', path, 'A module object is required.');
      return;
    }
    fields(entry, [
      'localId', 'frameKey', 'title', 'description', 'estimatedMinutes',
      'objectives', 'featureIds', 'blocks', 'questions',
    ], path, errors);
    const localId = text(entry.localId, path + '.localId', errors, 120);
    if (ids.has(localId)) add(errors, 'DUPLICATE_ID', path + '.localId', 'IDs must be unique.');
    ids.add(localId);
    const frameKey = text(entry.frameKey, path + '.frameKey', errors, 120);
    if (!(frames as readonly string[]).includes(frameKey)) {
      add(errors, 'FRAME_KEY', path + '.frameKey', 'Frame key is not allowed for this template.');
    }
    const objectives = stringArray(entry.objectives, path + '.objectives', errors);
    if (objectives.length < 2 || objectives.length > 4) {
      add(errors, 'OBJECTIVE_COUNT', path + '.objectives', 'A module requires 2 to 4 objectives.');
    }
    const blocks = parseBlocks(entry.blocks, path, errors, ids);
    const summaries = blocks.filter((block) => block.kind === 'summary');
    if (summaries.length !== 1 || blocks[blocks.length - 1]?.kind !== 'summary') {
      add(errors, 'SUMMARY_POSITION', path + '.blocks', 'Exactly one summary must be the final block.');
    }
    if (options.templateKind === 'advanced' && !blocks.some((block) => block.kind === 'scenario')) {
      add(errors, 'SCENARIO_REQUIRED', path + '.blocks', 'Advanced modules require a scenario.');
    }
    const blockIds = new Set(blocks.map((block) => block.localId));
    const questions = options.lessonsOnly
      ? []
      : parseQuestions(entry.questions, path, blockIds, errors, ids);
    const bodyWords = blocks.map((block) => block.body).join(' ').split(/\s+/).filter(Boolean).length;
    if (bodyWords < 300 || bodyWords > 900) {
      warningNotes.push('Module ' + localId + ' has ' + String(bodyWords) + ' words; recommended range is 300–900.');
    }
    for (const question of questions) {
      const correct = question.options.find((option) => option.id === question.correctOptionId);
      const distractors = question.options.filter((option) => option.id !== question.correctOptionId);
      const average = distractors.length
        ? distractors.reduce((sum, option) => sum + option.label.length, 0) / distractors.length
        : 0;
      if (correct && correct.label.length > average * 1.5 + 20) {
        warningNotes.push('Question ' + question.localId + ' has an unusually long correct answer.');
      }
    }
    modules.push({
      localId,
      frameKey,
      title: text(entry.title, path + '.title', errors, 80),
      description: text(entry.description, path + '.description', errors, 500),
      estimatedMinutes: typeof entry.estimatedMinutes === 'number'
        && Number.isFinite(entry.estimatedMinutes)
        && entry.estimatedMinutes > 0
        ? entry.estimatedMinutes
        : 0,
      objectives,
      featureIds: stringArray(entry.featureIds, path + '.featureIds', errors),
      blocks,
      questions,
    });
    if (!modules[modules.length - 1]?.estimatedMinutes) {
      add(errors, 'ESTIMATED_MINUTES', path + '.estimatedMinutes', 'Estimated minutes must be positive.');
    }
  });
  const frameIndexes = modules.map((module) => (frames as readonly string[]).indexOf(module.frameKey));
  if (
    new Set(frameIndexes).size !== frameIndexes.length
    || frameIndexes.some((frameIndex, index) => index > 0 && frameIndex <= frameIndexes[index - 1])
  ) {
    add(errors, 'FRAME_ORDER', 'root.modules', 'Frame keys must be unique and in fixed order.');
  }
  if (options.templateKind === 'normal') {
    for (const requiredFrame of ['t1-overview', 't1-core']) {
      if (
        !modules.some((module) => module.frameKey === requiredFrame)
        && !flagMissingRequiredFrame(flags, requiredFrame)
      ) {
        add(errors, 'REQUIRED_FRAME', 'root.modules', 'A required frame is missing without a blocking flag.');
      }
    }
  }
  const moduleIds = new Set(modules.map((module) => module.localId));
  const taskCoverage = parseTaskCoverage(value.taskCoverage, flags, moduleIds, options, errors);
  const result: GeneratedTemplate = {
    title,
    description,
    generationNotes,
    modules,
    flags,
    ...(taskCoverage ? { taskCoverage } : {}),
  };
  return errors.length > 0
    ? { ok: false, errors, generationNotes: warningNotes }
    : { ok: true, value: result, errors: [], generationNotes: warningNotes };
}

export function removeQuestionsBlockedByFlags(template: GeneratedTemplate): {
  readonly template: GeneratedTemplate;
  readonly removedQuestionIds: readonly string[];
} {
  const blockedBlocks = new Set(
    template.flags
      .filter((flag) => flag.severity === 'blocking')
      .map((flag) => flag.location.blockLocalId)
      .filter((blockId): blockId is string => Boolean(blockId)),
  );
  const conflictQuotes = new Set(
    template.flags
      .filter((flag) => flag.type === 'conflict' && flag.severity === 'blocking')
      .flatMap((flag) => flag.evidence.map((ref) => normalizeForMatch(ref.quote))),
  );
  const removedQuestionIds: string[] = [];
  const modules = template.modules.map((module) => ({
    ...module,
    questions: module.questions.filter((question) => {
      const blocked = question.blockIds.some((blockId) => blockedBlocks.has(blockId))
        || question.sourceRefs.some((ref) => conflictQuotes.has(normalizeForMatch(ref.quote)));
      if (blocked) removedQuestionIds.push(question.localId);
      return !blocked;
    }),
  }));
  return { template: { ...template, modules }, removedQuestionIds };
}
