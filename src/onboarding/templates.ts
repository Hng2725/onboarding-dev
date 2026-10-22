import type { OnboardingActor } from './auth';
import type {
  EmployeeType,
  LearnerTemplateDto,
  OnboardingQuestion,
  QuestionOption,
  QuestionType,
  ResourceKind,
  TemplateModule,
  TemplateResource,
  TemplateSnapshot,
  TemplateStatus,
} from './contracts';
import type { OnboardingStore, StoreRecord } from './store';
import { SYSTEM_TEMPLATES, getSystemTemplate } from './system-templates';

export interface TemplateResourceInput {
  readonly id?: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: ResourceKind;
  readonly required: boolean;
  readonly sourceUrl?: string;
  readonly fileId?: string;
}

export interface TemplateQuestionInput {
  readonly id?: string;
  readonly type: QuestionType;
  readonly prompt: string;
  readonly required?: boolean;
  readonly options?: readonly QuestionOption[];
  readonly correctOptionIds?: readonly string[];
  readonly explanation?: string;
}

export interface TemplateModuleInput {
  readonly id?: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly resources: readonly TemplateResourceInput[];
  readonly questions: readonly TemplateQuestionInput[];
}

export interface TemplateDraftInput {
  readonly title: string;
  readonly description: string;
  readonly employeeType: EmployeeType;
  readonly passingScore?: number;
  readonly maxAttempts?: number;
  readonly modules: readonly TemplateModuleInput[];
}

export interface AdminTemplateDetail extends TemplateSnapshot {
  readonly locked: boolean;
  readonly maxAttempts: number;
  readonly createdAt?: string;
  readonly updatedAt: string;
  readonly publishedAt?: string;
}

export interface TemplateCatalogItem {
  readonly id: string;
  readonly version: number;
  readonly source: 'system' | 'custom';
  readonly status: TemplateStatus;
  readonly employeeType: EmployeeType;
  readonly title: string;
  readonly description: string;
  readonly locked: boolean;
  readonly updatedAt: string;
}

export interface UpdateTemplateDraftInput {
  readonly templateId: string;
  readonly version: number;
  readonly expectedUpdatedAt: string;
  readonly draft: TemplateDraftInput;
}

export interface TemplateService {
  list(actor: OnboardingActor): Promise<readonly TemplateCatalogItem[]>;
  getAdminDetail(actor: OnboardingActor, templateId: string, version: number): Promise<AdminTemplateDetail>;
  getLearnerSnapshot(actor: OnboardingActor, templateId: string, version: number): Promise<LearnerTemplateDto>;
  createDraft(actor: OnboardingActor, draft: TemplateDraftInput): Promise<AdminTemplateDetail>;
  updateDraft(actor: OnboardingActor, input: UpdateTemplateDraftInput): Promise<AdminTemplateDetail>;
  cloneSystemTemplate(actor: OnboardingActor, templateId: string, version: number): Promise<AdminTemplateDetail>;
  publish(actor: OnboardingActor, templateId: string, version: number, expectedUpdatedAt?: string): Promise<AdminTemplateDetail>;
  archive(actor: OnboardingActor, templateId: string, version: number): Promise<AdminTemplateDetail>;
  deleteDraft(actor: OnboardingActor, templateId: string, version: number): Promise<void>;
}

type TemplateServiceErrorCode =
  | 'ADMIN_REQUIRED'
  | 'SYSTEM_TEMPLATE_LOCKED'
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_CONFLICT'
  | 'TEMPLATE_IN_USE'
  | 'TEMPLATE_INVALID'
  | 'TEMPLATE_NOT_PUBLISHED';

export class TemplateServiceError extends Error {
  readonly code: TemplateServiceErrorCode;

  constructor(code: TemplateServiceErrorCode, message: string) {
    super(message);
    this.name = 'TemplateServiceError';
    this.code = code;
  }
}

interface TemplateDbRecord extends StoreRecord {
  readonly id: string;
  readonly templateId: string;
  readonly title: string;
  readonly description: string;
  readonly employeeType: EmployeeType;
  readonly status: TemplateStatus;
  readonly version: number;
  readonly passingScore?: number;
  readonly maxAttempts: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt?: string;
}

interface ModuleDbRecord extends StoreRecord {
  readonly id: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly moduleId: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly order: number;
}

interface ResourceDbRecord extends StoreRecord {
  readonly id: string;
  readonly moduleId: string;
  readonly resourceId: string;
  readonly kind: ResourceKind;
  readonly title: string;
  readonly description?: string;
  readonly fileId?: string;
  readonly url?: string;
  readonly required: boolean;
  readonly order: number;
}

interface QuestionDbRecord extends StoreRecord {
  readonly id: string;
  readonly moduleId: string;
  readonly questionId: string;
  readonly type: QuestionType;
  readonly prompt: string;
  readonly options?: readonly QuestionOption[];
  readonly correctOptionIds?: readonly string[];
  readonly explanation?: string;
  readonly required: boolean;
  readonly order: number;
}

export interface TemplateServiceOptions {
  readonly id?: () => string;
  readonly now?: () => string;
}

function requireAdmin(actor: OnboardingActor): void {
  if (actor.access !== 'admin') {
    throw new TemplateServiceError('ADMIN_REQUIRED', 'Admin access is required to manage templates.');
  }
}

function systemId(templateId: string): boolean {
  return SYSTEM_TEMPLATES.some((template) => template.id === templateId);
}

function locked(templateId: string): never {
  throw new TemplateServiceError(
    'SYSTEM_TEMPLATE_LOCKED',
    `System template ${templateId} is immutable. Clone it to create a custom draft.`,
  );
}

function systemDetail(snapshot: TemplateSnapshot): AdminTemplateDetail {
  return {
    ...snapshot,
    locked: true,
    maxAttempts: 1,
    updatedAt: `system:${snapshot.version}`,
    publishedAt: `system:${snapshot.version}`,
  };
}

function text(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TemplateServiceError('TEMPLATE_INVALID', `${label} is required.`);
  return normalized;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value.toISOString();
    throw new TemplateServiceError('TEMPLATE_INVALID', `${label} is not a valid timestamp.`);
  }
  if (typeof value === 'string') {
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds) ? value : new Date(milliseconds).toISOString();
  }
  throw new TemplateServiceError('TEMPLATE_INVALID', `${label} is not a valid timestamp.`);
}

function normalizeDraft(
  input: TemplateDraftInput,
  templateId: string,
  version: number,
  makeId: () => string,
  forceNewIds = false,
): { snapshot: TemplateSnapshot; maxAttempts: number } {
  if (input.employeeType !== 'normal' && input.employeeType !== 'advanced') {
    throw new TemplateServiceError('TEMPLATE_INVALID', 'Employee type must be normal or advanced.');
  }
  if (input.modules.length === 0) {
    throw new TemplateServiceError('TEMPLATE_INVALID', 'A template requires at least one module.');
  }
  const hasScoredQuestion = input.modules.some((item) => item.questions.some((question) => question.type !== 'essay'));
  const passingScore = hasScoredQuestion ? input.passingScore : undefined;
  if (passingScore !== undefined) {
    if (!Number.isFinite(passingScore) || passingScore < 0 || passingScore > 100) {
      throw new TemplateServiceError('TEMPLATE_INVALID', 'Passing score must be from 0 to 100.');
    }
  }
  const maxAttempts = input.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TemplateServiceError('TEMPLATE_INVALID', 'Maximum attempts must be a positive integer.');
  }

  const moduleKeys = new Set<string>();
  const resourceIds = new Set<string>();
  const questionIds = new Set<string>();
  const modules: TemplateModule[] = input.modules.map((item, moduleIndex) => {
    const key = text(item.key, 'Module key');
    if (moduleKeys.has(key)) throw new TemplateServiceError('TEMPLATE_INVALID', `Duplicate module key: ${key}`);
    moduleKeys.add(key);
    const moduleId = forceNewIds || !item.id ? makeId() : item.id;
    const resources: TemplateResource[] = item.resources.map((entry) => {
      const id = forceNewIds || !entry.id ? makeId() : entry.id;
      if (resourceIds.has(id)) throw new TemplateServiceError('TEMPLATE_INVALID', `Duplicate resource ID: ${id}`);
      resourceIds.add(id);
      if (!entry.sourceUrl && !entry.fileId) {
        throw new TemplateServiceError('TEMPLATE_INVALID', `Resource ${entry.title} requires a URL or file ID.`);
      }
      return {
        id,
        title: text(entry.title, 'Resource title'),
        description: entry.description?.trim(),
        kind: entry.kind,
        required: entry.required,
        sourceUrl: entry.sourceUrl,
        fileId: entry.fileId,
      };
    });
    const questions: OnboardingQuestion[] = item.questions.map((entry) => {
      const id = forceNewIds || !entry.id ? makeId() : entry.id;
      if (questionIds.has(id)) throw new TemplateServiceError('TEMPLATE_INVALID', `Duplicate question ID: ${id}`);
      questionIds.add(id);
      if (entry.type !== 'essay' && (!entry.options?.length || !entry.correctOptionIds?.length)) {
        throw new TemplateServiceError('TEMPLATE_INVALID', `Choice question ${id} requires options and an answer key.`);
      }
      return {
        id,
        type: entry.type,
        prompt: text(entry.prompt, 'Question prompt'),
        required: entry.required ?? true,
        ...(entry.type === 'essay' ? {} : {
          options: entry.options,
          correctOptionIds: entry.correctOptionIds,
          explanation: entry.explanation?.trim(),
        }),
      };
    });
    return {
      id: moduleId,
      key,
      title: text(item.title, 'Module title'),
      description: item.description.trim(),
      order: moduleIndex + 1,
      resources,
      questions,
    };
  });

  return {
    maxAttempts,
    snapshot: {
      id: templateId,
      version,
      source: 'custom',
      status: 'draft',
      employeeType: input.employeeType,
      title: text(input.title, 'Template title'),
      description: input.description.trim(),
      passingScore,
      modules,
    },
  };
}

function toDraftInput(snapshot: TemplateSnapshot, title = snapshot.title): TemplateDraftInput {
  return {
    title,
    description: snapshot.description,
    employeeType: snapshot.employeeType,
    passingScore: snapshot.passingScore,
    maxAttempts: 1,
    modules: snapshot.modules.map((module) => ({
      key: module.key,
      title: module.title,
      description: module.description,
      resources: module.resources.map((resource) => ({ ...resource })),
      questions: module.questions.map((question) => ({ ...question })),
    })),
  };
}

function learnerSnapshot(snapshot: TemplateSnapshot): LearnerTemplateDto {
  return {
    ...snapshot,
    modules: snapshot.modules.map((module) => ({
      ...module,
      questions: module.questions.map((question) => {
        const { correctOptionIds: _answerKey, explanation: _explanation, ...safe } = question;
        return { ...safe, required: question.required ?? true };
      }),
    })),
  };
}

export function createTemplateService(
  store: OnboardingStore,
  options: TemplateServiceOptions = {},
): TemplateService {
  const makeId = options.id ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  async function findRecord(roomId: string, templateId: string, version: number): Promise<TemplateDbRecord | undefined> {
    const result = await store.query<TemplateDbRecord>(roomId, 'onboarding_templates', {
      filter: { templateId, version },
      limit: 2,
    });
    return result.records[0];
  }

  async function requireRecord(roomId: string, templateId: string, version: number): Promise<TemplateDbRecord> {
    const record = await findRecord(roomId, templateId, version);
    if (!record) throw new TemplateServiceError('TEMPLATE_NOT_FOUND', `Template ${templateId}@${version} was not found.`);
    return record;
  }

  async function persistContent(roomId: string, snapshot: TemplateSnapshot, timestamp: string): Promise<void> {
    for (const module of snapshot.modules) {
      await store.create(roomId, 'onboarding_modules', {
        templateId: snapshot.id,
        templateVersion: snapshot.version,
        moduleId: module.id,
        key: module.key,
        title: module.title,
        description: module.description,
        order: module.order,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      for (const [order, resource] of module.resources.entries()) {
        await store.create(roomId, 'onboarding_resources', {
          moduleId: module.id,
          resourceId: resource.id,
          kind: resource.kind,
          title: resource.title,
          description: resource.description,
          fileId: resource.fileId,
          url: resource.sourceUrl,
          required: resource.required,
          order: order + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      for (const [order, question] of module.questions.entries()) {
        await store.create(roomId, 'onboarding_questions', {
          moduleId: module.id,
          questionId: question.id,
          type: question.type,
          prompt: question.prompt,
          options: question.options,
          correctOptionIds: question.correctOptionIds,
          explanation: question.explanation,
          required: question.required ?? true,
          order: order + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }
  }

  async function removeContent(roomId: string, templateId: string, version: number): Promise<void> {
    const modules = await store.query<ModuleDbRecord>(roomId, 'onboarding_modules', {
      filter: { templateId, templateVersion: version }, limit: 1000,
    });
    for (const module of modules.records) {
      const [resources, questions] = await Promise.all([
        store.query<ResourceDbRecord>(roomId, 'onboarding_resources', { filter: { moduleId: module.moduleId }, limit: 1000 }),
        store.query<QuestionDbRecord>(roomId, 'onboarding_questions', { filter: { moduleId: module.moduleId }, limit: 1000 }),
      ]);
      for (const resource of resources.records) {
        await store.update(roomId, 'onboarding_resources', resource.id, {
          moduleId: `deleted:${resource.id}`,
        });
        await store.softDelete(roomId, 'onboarding_resources', resource.id);
      }
      for (const question of questions.records) {
        await store.update(roomId, 'onboarding_questions', question.id, {
          moduleId: `deleted:${question.id}`,
        });
        await store.softDelete(roomId, 'onboarding_questions', question.id);
      }
      await store.update(roomId, 'onboarding_modules', module.id, {
        templateId: `deleted:${module.id}`,
      });
      await store.softDelete(roomId, 'onboarding_modules', module.id);
    }
  }

  async function loadCustom(roomId: string, record: TemplateDbRecord): Promise<AdminTemplateDetail> {
    const moduleRows = await store.query<ModuleDbRecord>(roomId, 'onboarding_modules', {
      filter: { templateId: record.templateId, templateVersion: record.version },
      orderBy: [{ field: 'order', direction: 'asc' }],
      limit: 1000,
    });
    const modules: TemplateModule[] = [];
    for (const moduleRow of moduleRows.records) {
      const [resourceRows, questionRows] = await Promise.all([
        store.query<ResourceDbRecord>(roomId, 'onboarding_resources', {
          filter: { moduleId: moduleRow.moduleId }, orderBy: [{ field: 'order', direction: 'asc' }], limit: 1000,
        }),
        store.query<QuestionDbRecord>(roomId, 'onboarding_questions', {
          filter: { moduleId: moduleRow.moduleId }, orderBy: [{ field: 'order', direction: 'asc' }], limit: 1000,
        }),
      ]);
      modules.push({
        id: moduleRow.moduleId,
        key: moduleRow.key,
        title: moduleRow.title,
        description: moduleRow.description,
        order: moduleRow.order,
        resources: resourceRows.records.map((row) => ({
          id: row.resourceId,
          title: row.title,
          description: row.description,
          kind: row.kind,
          required: row.required,
          sourceUrl: row.url,
          fileId: row.fileId,
        })),
        questions: questionRows.records.map((row) => ({
          id: row.questionId,
          type: row.type,
          prompt: row.prompt,
          required: row.required,
          options: row.options,
          correctOptionIds: row.correctOptionIds,
          explanation: row.explanation,
        })),
      });
    }
    return {
      id: record.templateId,
      version: record.version,
      source: 'custom',
      status: record.status,
      employeeType: record.employeeType,
      title: record.title,
      description: record.description,
      passingScore: record.passingScore,
      modules,
      locked: false,
      maxAttempts: record.maxAttempts,
      createdAt: canonicalTimestamp(record.createdAt, 'Template createdAt'),
      updatedAt: canonicalTimestamp(record.updatedAt, 'Template updatedAt'),
      publishedAt: record.publishedAt === undefined
        ? undefined
        : canonicalTimestamp(record.publishedAt, 'Template publishedAt'),
    };
  }

  async function createCustomDraft(
    actor: OnboardingActor,
    draft: TemplateDraftInput,
    forceNewIds = false,
  ): Promise<AdminTemplateDetail> {
    const templateId = makeId();
    const normalized = normalizeDraft(draft, templateId, 1, makeId, forceNewIds);
    const timestamp = now();
    await store.create<TemplateDbRecord>(actor.roomId, 'onboarding_templates', {
      templateId,
      title: normalized.snapshot.title,
      description: normalized.snapshot.description,
      employeeType: normalized.snapshot.employeeType,
      status: 'draft',
      version: 1,
      passingScore: normalized.snapshot.passingScore,
      maxAttempts: normalized.maxAttempts,
      createdBy: actor.userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await persistContent(actor.roomId, normalized.snapshot, timestamp);
    return loadCustom(actor.roomId, await requireRecord(actor.roomId, templateId, 1));
  }

  return {
    async list(actor) {
      const custom = await store.query<TemplateDbRecord>(actor.roomId, 'onboarding_templates', {
        orderBy: [{ field: 'updatedAt', direction: 'desc' }], limit: 1000,
      });
      return [
        ...SYSTEM_TEMPLATES.map((snapshot): TemplateCatalogItem => ({
          id: snapshot.id,
          version: snapshot.version,
          source: 'system',
          status: 'published',
          employeeType: snapshot.employeeType,
          title: snapshot.title,
          description: snapshot.description,
          locked: true,
          updatedAt: `system:${snapshot.version}`,
        })),
        ...custom.records.map((record): TemplateCatalogItem => ({
          id: record.templateId,
          version: record.version,
          source: 'custom',
          status: record.status,
          employeeType: record.employeeType,
          title: record.title,
          description: record.description,
          locked: false,
          updatedAt: canonicalTimestamp(record.updatedAt, 'Template updatedAt'),
        })),
      ];
    },

    async getAdminDetail(actor, templateId, version) {
      requireAdmin(actor);
      const builtIn = getSystemTemplate(templateId, version);
      if (builtIn) return systemDetail(builtIn);
      return loadCustom(actor.roomId, await requireRecord(actor.roomId, templateId, version));
    },

    async getLearnerSnapshot(actor, templateId, version) {
      const builtIn = getSystemTemplate(templateId, version);
      if (builtIn) return learnerSnapshot(builtIn);
      const detail = await loadCustom(actor.roomId, await requireRecord(actor.roomId, templateId, version));
      if (detail.status !== 'published' && detail.status !== 'archived') {
        throw new TemplateServiceError('TEMPLATE_NOT_PUBLISHED', 'Learners can access only published template versions.');
      }
      return learnerSnapshot(detail);
    },

    async createDraft(actor, draft) {
      requireAdmin(actor);
      return createCustomDraft(actor, draft);
    },

    async updateDraft(actor, input) {
      requireAdmin(actor);
      if (systemId(input.templateId)) return locked(input.templateId);
      const record = await requireRecord(actor.roomId, input.templateId, input.version);
      const currentUpdatedAt = canonicalTimestamp(record.updatedAt, 'Template updatedAt');
      const expectedUpdatedAt = canonicalTimestamp(input.expectedUpdatedAt, 'Expected template updatedAt');
      if (currentUpdatedAt !== expectedUpdatedAt) {
        throw new TemplateServiceError('TEMPLATE_CONFLICT', 'Template changed after this editor loaded it.');
      }
      const timestamp = now();
      if (record.status === 'draft') {
        const normalized = normalizeDraft(input.draft, record.templateId, record.version, makeId);
        await removeContent(actor.roomId, record.templateId, record.version);
        await store.update(actor.roomId, 'onboarding_templates', record.id, {
          title: normalized.snapshot.title,
          description: normalized.snapshot.description,
          employeeType: normalized.snapshot.employeeType,
          passingScore: normalized.snapshot.passingScore,
          maxAttempts: normalized.maxAttempts,
          updatedAt: timestamp,
        }, { expectedUpdatedAt: currentUpdatedAt });
        await persistContent(actor.roomId, normalized.snapshot, timestamp);
        return loadCustom(actor.roomId, await requireRecord(actor.roomId, record.templateId, record.version));
      }
      if (record.status !== 'published') {
        throw new TemplateServiceError('TEMPLATE_INVALID', 'Only draft or published templates can be edited.');
      }
      const allVersions = await store.query<TemplateDbRecord>(actor.roomId, 'onboarding_templates', {
        filter: { templateId: record.templateId }, limit: 1000,
      });
      const version = Math.max(...allVersions.records.map((item) => item.version)) + 1;
      const normalized = normalizeDraft(input.draft, record.templateId, version, makeId, true);
      await store.create(actor.roomId, 'onboarding_templates', {
        templateId: record.templateId,
        title: normalized.snapshot.title,
        description: normalized.snapshot.description,
        employeeType: normalized.snapshot.employeeType,
        status: 'draft',
        version,
        passingScore: normalized.snapshot.passingScore,
        maxAttempts: normalized.maxAttempts,
        createdBy: actor.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await persistContent(actor.roomId, normalized.snapshot, timestamp);
      return loadCustom(actor.roomId, await requireRecord(actor.roomId, record.templateId, version));
    },

    async cloneSystemTemplate(actor, templateId, version) {
      requireAdmin(actor);
      const source = getSystemTemplate(templateId, version);
      if (!source) throw new TemplateServiceError('TEMPLATE_NOT_FOUND', `System template ${templateId}@${version} was not found.`);
      return createCustomDraft(actor, toDraftInput(source, `${source.title} — bản sao`), true);
    },

    async publish(actor, templateId, version, expectedUpdatedAt) {
      requireAdmin(actor);
      if (systemId(templateId)) return locked(templateId);
      const record = await requireRecord(actor.roomId, templateId, version);
      if (record.status !== 'draft') throw new TemplateServiceError('TEMPLATE_CONFLICT', 'Only a draft can be published.');
      const currentUpdatedAt = canonicalTimestamp(record.updatedAt, 'Template updatedAt');
      if (expectedUpdatedAt && canonicalTimestamp(expectedUpdatedAt, 'Expected template updatedAt') !== currentUpdatedAt) {
        throw new TemplateServiceError('TEMPLATE_CONFLICT', 'Template changed before publication.');
      }
      const timestamp = now();
      await store.update(actor.roomId, 'onboarding_templates', record.id, {
        status: 'published', publishedAt: timestamp, updatedAt: timestamp,
      }, { expectedUpdatedAt: currentUpdatedAt });
      return loadCustom(actor.roomId, await requireRecord(actor.roomId, templateId, version));
    },

    async archive(actor, templateId, version) {
      requireAdmin(actor);
      if (systemId(templateId)) return locked(templateId);
      const record = await requireRecord(actor.roomId, templateId, version);
      if (record.status !== 'published') {
        throw new TemplateServiceError('TEMPLATE_INVALID', 'Only a published custom template can be archived.');
      }
      await store.update(actor.roomId, 'onboarding_templates', record.id, {
        status: 'archived', updatedAt: now(),
      });
      return loadCustom(actor.roomId, await requireRecord(actor.roomId, templateId, version));
    },

    async deleteDraft(actor, templateId, version) {
      requireAdmin(actor);
      if (systemId(templateId)) return locked(templateId);
      const record = await requireRecord(actor.roomId, templateId, version);
      const assignments = await store.count(actor.roomId, 'onboarding_assignments', {
        templateId, templateVersion: version,
      });
      if (assignments > 0) throw new TemplateServiceError('TEMPLATE_IN_USE', 'This template version is assigned.');
      await removeContent(actor.roomId, templateId, version);
      await store.softDelete(actor.roomId, 'onboarding_templates', record.id);
    },
  };
}
