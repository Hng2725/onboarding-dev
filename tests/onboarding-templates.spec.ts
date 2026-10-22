import { describe, expect, it } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import {
  TemplateServiceError,
  createTemplateService,
  type TemplateDraftInput,
} from '../src/onboarding/templates';
import type { StoreQueryOptions, StoreRecord, StoreUpdateOptions } from '../src/onboarding/store';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';

const admin: OnboardingActor = {
  userId: 'admin-1', username: 'admin', roomId: 'room-a', access: 'admin',
};
const learner: OnboardingActor = {
  userId: 'member-1', username: 'member', roomId: 'room-a', access: 'learner',
};

const draftInput: TemplateDraftInput = {
  title: 'Quy trình hội nhập nội bộ',
  description: 'Tài liệu và bài tập cho nhân sự mới.',
  employeeType: 'normal',
  passingScore: 70,
  maxAttempts: 2,
  modules: [{
    key: 'company-basics',
    title: 'Giới thiệu công ty',
    description: 'Các nguyên tắc làm việc chung.',
    resources: [{
      title: 'Sổ tay nhân sự', kind: 'file', required: true, fileId: 'file-1',
    }],
    questions: [{
      type: 'single_choice', prompt: 'Kênh hỗ trợ chính là gì?', required: true,
      options: [{ id: 'room', label: 'Room hỗ trợ' }, { id: 'email', label: 'Email cá nhân' }],
      correctOptionIds: ['room'],
    }],
  }],
};

function setup() {
  let tick = 0;
  const store = new MemoryOnboardingStore();
  const service = createTemplateService(store, {
    id: () => `stable-${++tick}`,
    now: () => `2026-10-20T00:00:${String(++tick).padStart(2, '0')}.000Z`,
  });
  return { store, service };
}

class NativeDateReadStore extends MemoryOnboardingStore {
  override async query<T extends StoreRecord>(
    roomId: string,
    collection: string,
    options: StoreQueryOptions = {},
  ): Promise<{ records: readonly T[]; nextCursor?: string }> {
    const result = await super.query<T>(roomId, collection, options);
    return {
      ...result,
      records: result.records.map((record) => typeof record.updatedAt === 'string'
        ? { ...record, updatedAt: new Date(record.updatedAt) } as unknown as T
        : record),
    };
  }
}

const mongoUniqueIndexes: Readonly<Record<string, readonly (readonly string[])[]>> = {
  onboarding_modules: [
    ['templateId', 'templateVersion', 'order'],
    ['templateId', 'templateVersion', 'key'],
  ],
  onboarding_resources: [
    ['moduleId', 'order'],
    ['moduleId', 'resourceId'],
  ],
  onboarding_questions: [
    ['moduleId', 'order'],
    ['moduleId', 'questionId'],
  ],
};

class MongoUniqueIndexStore extends NativeDateReadStore {
  private async rejectDuplicate(
    roomId: string,
    collection: string,
    candidate: StoreRecord,
    excludedId?: string,
  ): Promise<void> {
    const indexes = mongoUniqueIndexes[collection] ?? [];
    if (indexes.length === 0) return;
    const { records } = await super.query<StoreRecord>(roomId, collection, {
      includeDeleted: true,
      limit: 1000,
    });
    for (const fields of indexes) {
      const duplicate = records.some((record) => record.id !== excludedId
        && fields.every((field) => record[field] === candidate[field]));
      if (duplicate) throw new Error(`E11000 duplicate key error: ${collection} (${fields.join(', ')})`);
    }
  }

  override async create<T extends StoreRecord>(
    roomId: string,
    collection: string,
    data: StoreRecord,
  ): Promise<T> {
    await this.rejectDuplicate(roomId, collection, data);
    return super.create<T>(roomId, collection, data);
  }

  override async update<T extends StoreRecord>(
    roomId: string,
    collection: string,
    id: string,
    data: StoreRecord,
    options?: StoreUpdateOptions,
  ): Promise<T> {
    const current = await super.get<StoreRecord>(roomId, collection, id);
    if (!current) throw new Error('missing record');
    await this.rejectDuplicate(roomId, collection, { ...current, ...data, id }, id);
    return super.update<T>(roomId, collection, id, data, options);
  }
}

describe('onboarding template service', () => {
  it('lists system templates as published and locked and rejects every mutation', async () => {
    const { service } = setup();
    const listed = await service.list(admin);

    expect(listed.slice(0, 2).map(({ id, status, locked }) => ({ id, status, locked }))).toEqual([
      { id: 'privos-foundations', status: 'published', locked: true },
      { id: 'privos-advanced', status: 'published', locked: true },
    ]);
    await expect(service.updateDraft(admin, {
      templateId: 'privos-foundations', version: 1, expectedUpdatedAt: 'never', draft: draftInput,
    })).rejects.toMatchObject({ code: 'SYSTEM_TEMPLATE_LOCKED' });
    await expect(service.archive(admin, 'privos-foundations', 1)).rejects.toMatchObject({ code: 'SYSTEM_TEMPLATE_LOCKED' });
    await expect(service.deleteDraft(admin, 'privos-foundations', 1)).rejects.toMatchObject({ code: 'SYSTEM_TEMPLATE_LOCKED' });
  });

  it('clones system content into a custom room draft with new stable IDs', async () => {
    const { service } = setup();
    const source = await service.getAdminDetail(admin, 'privos-foundations', 1);

    const clone = await service.cloneSystemTemplate(admin, 'privos-foundations', 1);

    expect(clone).toMatchObject({ source: 'custom', status: 'draft', version: 1, locked: false });
    expect(clone.modules.map((module) => module.key)).toEqual(source.modules.map((module) => module.key));
    expect(clone.modules[0].id).not.toBe(source.modules[0].id);
    expect(clone.modules[0].resources[0].id).not.toBe(source.modules[0].resources[0].id);
    expect(clone.modules[0].questions[0].id).not.toBe(source.modules[0].questions[0].id);
  });

  it('saves and publishes a cloned template when database datetimes hydrate as Date objects', async () => {
    let tick = 0;
    const service = createTemplateService(new MongoUniqueIndexStore(), {
      id: () => `date-id-${++tick}`,
      now: () => `2026-10-20T00:01:${String(++tick).padStart(2, '0')}.000Z`,
    });
    const clone = await service.cloneSystemTemplate(admin, 'privos-foundations', 1);
    const clientClone = JSON.parse(JSON.stringify(clone)) as typeof clone;

    const saved = await service.updateDraft(admin, {
      templateId: clientClone.id,
      version: clientClone.version,
      expectedUpdatedAt: clientClone.updatedAt,
      draft: { ...draftInput, title: 'Bản sao đã chỉnh sửa' },
    });
    const published = await service.publish(admin, saved.id, saved.version, saved.updatedAt);

    expect(published).toMatchObject({
      id: clone.id,
      source: 'custom',
      status: 'published',
      title: 'Bản sao đã chỉnh sửa',
    });
  });

  it('creates and publishes a document-only template without requiring questions or a passing score', async () => {
    const { service } = setup();
    const documentOnly: TemplateDraftInput = {
      ...draftInput,
      title: 'Đọc quy định công ty',
      passingScore: 80,
      modules: draftInput.modules.map((module) => ({ ...module, questions: [] })),
    };

    const draft = await service.createDraft(admin, documentOnly);
    expect(draft.modules[0].questions).toEqual([]);
    expect(draft.passingScore).toBeUndefined();

    const published = await service.publish(admin, draft.id, draft.version, draft.updatedAt);
    expect(published).toMatchObject({ status: 'published', title: 'Đọc quy định công ty' });
    expect(published.passingScore).toBeUndefined();
  });

  it('deletes unassigned custom templates in draft, published, or archived state', async () => {
    const { service, store } = setup();
    const disposable = await service.createDraft(admin, draftInput);
    await service.deleteDraft(admin, disposable.id, disposable.version);
    await expect(service.getAdminDetail(admin, disposable.id, disposable.version)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });

    const published = await service.createDraft(admin, { ...draftInput, title: 'Đã xuất bản' });
    await service.publish(admin, published.id, published.version, published.updatedAt);
    await service.deleteDraft(admin, published.id, published.version);
    await expect(service.getAdminDetail(admin, published.id, published.version)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });

    const archivedDraft = await service.createDraft(admin, { ...draftInput, title: 'Đã lưu trữ' });
    const archivedPublished = await service.publish(admin, archivedDraft.id, archivedDraft.version, archivedDraft.updatedAt);
    await service.archive(admin, archivedPublished.id, archivedPublished.version);
    await service.deleteDraft(admin, archivedPublished.id, archivedPublished.version);
    await expect(service.getAdminDetail(admin, archivedPublished.id, archivedPublished.version)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });

    const assigned = await service.createDraft(admin, { ...draftInput, title: 'Đang được dùng' });
    await store.create('room-a', 'onboarding_assignments', {
      templateId: assigned.id, templateVersion: assigned.version,
    });
    await expect(service.deleteDraft(admin, assigned.id, assigned.version)).rejects.toMatchObject({
      code: 'TEMPLATE_IN_USE',
    });
  });

  it('publishes immutable version 1 and edits published content as version 2', async () => {
    const { service } = setup();
    const draft = await service.createDraft(admin, draftInput);
    const version1 = await service.publish(admin, draft.id, 1, draft.updatedAt);

    const version2Draft = await service.updateDraft(admin, {
      templateId: draft.id,
      version: 1,
      expectedUpdatedAt: version1.updatedAt,
      draft: { ...draftInput, title: 'Quy trình hội nhập — bản mới' },
    });
    expect(version2Draft).toMatchObject({ version: 2, status: 'draft' });
    const version2 = await service.publish(admin, draft.id, 2, version2Draft.updatedAt);

    expect(version2.status).toBe('published');
    expect((await service.getAdminDetail(admin, draft.id, 1)).title).toBe(draftInput.title);
    expect((await service.getAdminDetail(admin, draft.id, 2)).title).toBe('Quy trình hội nhập — bản mới');
  });

  it('resolves an assignment-pinned version after a newer version publishes', async () => {
    const { service } = setup();
    const draft = await service.createDraft(admin, draftInput);
    const version1 = await service.publish(admin, draft.id, 1, draft.updatedAt);
    const next = await service.updateDraft(admin, {
      templateId: draft.id, version: 1, expectedUpdatedAt: version1.updatedAt,
      draft: { ...draftInput, title: 'Version 2' },
    });
    await service.publish(admin, draft.id, 2, next.updatedAt);

    const pinned = await service.getLearnerSnapshot(learner, draft.id, 1);
    expect(pinned).toMatchObject({ id: draft.id, version: 1, title: draftInput.title });
  });

  it('rejects stale updatedAt edits instead of overwriting', async () => {
    const { service } = setup();
    const draft = await service.createDraft(admin, draftInput);
    const updated = await service.updateDraft(admin, {
      templateId: draft.id, version: 1, expectedUpdatedAt: draft.updatedAt,
      draft: { ...draftInput, title: 'Lần sửa hợp lệ' },
    });
    expect(updated.title).toBe('Lần sửa hợp lệ');

    await expect(service.updateDraft(admin, {
      templateId: draft.id, version: 1, expectedUpdatedAt: draft.updatedAt,
      draft: { ...draftInput, title: 'Ghi đè stale' },
    })).rejects.toBeInstanceOf(TemplateServiceError);
    await expect(service.updateDraft(admin, {
      templateId: draft.id, version: 1, expectedUpdatedAt: draft.updatedAt,
      draft: draftInput,
    })).rejects.toMatchObject({ code: 'TEMPLATE_CONFLICT' });
  });

  it('never exposes correct answer IDs in Learner snapshots', async () => {
    const { service } = setup();
    const snapshot = await service.getLearnerSnapshot(learner, 'privos-foundations', 1);

    expect(JSON.stringify(snapshot)).not.toContain('correctOptionIds');
    expect(snapshot.modules[0].questions[0]).not.toHaveProperty('correctOptionIds');
  });
});
