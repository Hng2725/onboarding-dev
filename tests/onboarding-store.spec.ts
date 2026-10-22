import { beforeEach, describe, expect, it, vi } from 'vitest';

const callAppPlatformTool = vi.hoisted(() => vi.fn());
vi.mock('../src/app-platform-tool-call', () => ({ callAppPlatformTool }));

import { ONBOARDING_COLLECTIONS, ensureOnboardingSchema } from '../src/onboarding/schema';
import { OnboardingStoreError, createOnboardingStore } from '../src/onboarding/store';

const COLLECTION_NAMES = [
  'onboarding_templates',
  'onboarding_modules',
  'onboarding_resources',
  'onboarding_questions',
  'onboarding_employees',
  'onboarding_assignments',
  'onboarding_material_progress',
  'onboarding_attempts',
  'onboarding_answers',
  'onboarding_essay_feedback',
  'onboarding_evaluations',
  'onboarding_audit_events',
];

describe('onboarding App Database schema', () => {
  beforeEach(() => {
    callAppPlatformTool.mockReset();
  });

  it('defines all twelve room-scoped collections and required unique indexes', () => {
    expect(ONBOARDING_COLLECTIONS.map((definition) => definition.collection)).toEqual(COLLECTION_NAMES);
    expect(ONBOARDING_COLLECTIONS.every((definition) => definition.scope === 'room')).toBe(true);

    const indexes = (collection: string) => ONBOARDING_COLLECTIONS
      .find((definition) => definition.collection === collection)?.indexes;
    expect(indexes('onboarding_employees')).toContainEqual(expect.objectContaining({
      fields: { memberId: 1 }, unique: true,
    }));
    expect(indexes('onboarding_assignments')).not.toContainEqual(expect.objectContaining({
      fields: { memberId: 1, templateId: 1, templateVersion: 1 }, unique: true,
    }));
    expect(indexes('onboarding_material_progress')).toContainEqual(expect.objectContaining({
      fields: { assignmentId: 1, resourceId: 1 }, unique: true,
    }));
    expect(indexes('onboarding_attempts')).toContainEqual(expect.objectContaining({
      fields: { operationId: 1 }, unique: true,
    }));
    expect(indexes('onboarding_evaluations')).toContainEqual(expect.objectContaining({
      fields: { attemptId: 1 }, unique: true,
    }));
    expect(indexes('onboarding_evaluations')).toContainEqual(expect.objectContaining({
      fields: { operationId: 1 }, unique: true,
    }));
  });

  it('registers every schema in the same explicit room', async () => {
    callAppPlatformTool.mockResolvedValue({ registered: true });

    await ensureOnboardingSchema('room-a');

    expect(callAppPlatformTool).toHaveBeenCalledTimes(24);
    for (const [index, [toolName, args, scope, roomId]] of callAppPlatformTool.mock.calls.entries()) {
      if (index % 2 === 0) {
        expect(toolName).toBe('mcpapp.db.registerCollection');
        expect(args.scope).toBe('room');
        expect(scope).toBe('db:schema:write');
      } else {
        expect(toolName).toBe('mcpapp.db.getSchema');
        expect(scope).toBe('db:schema:read');
      }
      expect(roomId).toBe('room-a');
    }
  });

  it('treats already registered as success per collection and continues', async () => {
    callAppPlatformTool.mockImplementation(async (toolName) => {
      if (toolName === 'mcpapp.db.registerCollection') throw new Error('collection already registered');
      return { collection: 'registered' };
    });

    const result = await ensureOnboardingSchema('room-a');
    expect(result).toBeUndefined();
    expect(callAppPlatformTool).toHaveBeenCalledTimes(24);
  });
});

describe('onboarding store adapter', () => {
  beforeEach(() => {
    callAppPlatformTool.mockReset();
  });

  it('maps CRUD, count, and aggregate operations to exact tools and scopes', async () => {
    callAppPlatformTool
      .mockResolvedValueOnce({ record: { id: 'new' } })
      .mockResolvedValueOnce({ record: { id: 'one' } })
      .mockResolvedValueOnce({ records: [{ id: 'one' }], nextCursor: 'next' })
      .mockResolvedValueOnce({ record: { id: 'one', title: 'Updated' } })
      .mockResolvedValueOnce({ deleted: true })
      .mockResolvedValueOnce({ count: 7 })
      .mockResolvedValueOnce({ result: [{ status: 'assigned', count: 3 }] });
    const store = createOnboardingStore();

    await store.create('room-a', 'onboarding_templates', { title: 'Mẫu' });
    await store.get('room-a', 'onboarding_templates', 'one');
    await store.query('room-a', 'onboarding_templates');
    await store.update('room-a', 'onboarding_templates', 'one', { title: 'Updated' });
    await store.softDelete('room-a', 'onboarding_templates', 'one');
    await store.count('room-a', 'onboarding_assignments', { status: 'assigned' });
    await store.aggregate('room-a', 'onboarding_assignments', { groupBy: ['status'] });

    expect(callAppPlatformTool.mock.calls.map(([tool, , scope, room]) => [tool, scope, room])).toEqual([
      ['mcpapp.db.create', 'db:write', 'room-a'],
      ['mcpapp.db.get', 'db:read', 'room-a'],
      ['mcpapp.db.query', 'db:read', 'room-a'],
      ['mcpapp.db.update', 'db:write', 'room-a'],
      ['mcpapp.db.delete', 'db:write', 'room-a'],
      ['mcpapp.db.count', 'db:read', 'room-a'],
      ['mcpapp.db.aggregate', 'db:read', 'room-a'],
    ]);
    expect(callAppPlatformTool.mock.calls[2][1]).toMatchObject({ limit: 50 });
    expect(callAppPlatformTool.mock.calls[4][1]).toEqual({
      collection: 'onboarding_templates', id: 'one',
    });
  });

  it('keeps every operation bound to its explicit actor-derived room', async () => {
    callAppPlatformTool.mockResolvedValue({ records: [] });
    const store = createOnboardingStore();

    await store.query('verified-room', 'onboarding_assignments', { limit: 10 });

    expect(callAppPlatformTool).toHaveBeenCalledWith(
      'mcpapp.db.query',
      expect.objectContaining({ collection: 'onboarding_assignments', limit: 10 }),
      'db:read',
      'verified-room',
    );
  });

  it('accepts direct Hub records and normalizes _id to the store id contract', async () => {
    callAppPlatformTool.mockResolvedValue({ _id: 'mongo-1', title: 'Mẫu' });
    const store = createOnboardingStore();

    const created = await store.create<{ id: string; title: string }>(
      'room-a',
      'onboarding_templates',
      { title: 'Mẫu' },
    );

    expect(created).toEqual({ _id: 'mongo-1', id: 'mongo-1', title: 'Mẫu' });
  });

  it('translates equality filters to Hub where clauses and normalizes queried _id values', async () => {
    callAppPlatformTool
      .mockResolvedValueOnce({ records: [{ _id: 'mongo-2', templateId: 'template-a', version: 2 }], total: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const store = createOnboardingStore();

    const result = await store.query('room-a', 'onboarding_templates', {
      filter: { templateId: 'template-a', version: 2 },
      limit: 2,
    });
    await store.count('room-a', 'onboarding_templates', { status: 'draft' });

    expect(callAppPlatformTool.mock.calls[0][1]).toEqual({
      collection: 'onboarding_templates',
      where: [
        { field: 'templateId', op: '==', value: 'template-a' },
        { field: 'version', op: '==', value: 2 },
      ],
      limit: 2,
    });
    expect(callAppPlatformTool.mock.calls[1][1]).toEqual({
      collection: 'onboarding_templates',
      where: [{ field: 'status', op: '==', value: 'draft' }],
    });
    expect(result.records).toEqual([
      { _id: 'mongo-2', id: 'mongo-2', templateId: 'template-a', version: 2 },
    ]);
  });

  it('treats any resolved Hub delete response as a successful soft delete', async () => {
    callAppPlatformTool.mockResolvedValue({ _id: 'mongo-3', _deletedAt: '2026-10-22T00:00:00.000Z' });
    const store = createOnboardingStore();

    await expect(store.softDelete('room-a', 'onboarding_templates', 'mongo-3')).resolves.toBeUndefined();
  });

  it('bounds query limits and rejects values above 1000', async () => {
    callAppPlatformTool.mockResolvedValue({ records: [] });
    const store = createOnboardingStore();

    await store.query('room-a', 'onboarding_assignments');
    await expect(store.query('room-a', 'onboarding_assignments', { limit: 1001 })).rejects.toMatchObject({
      name: 'OnboardingStoreError', code: 'STORE_LIMIT_EXCEEDED',
    });
    expect(callAppPlatformTool).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['create', async () => createOnboardingStore().create('room-a', 'onboarding_templates', {})],
    ['get', async () => createOnboardingStore().get('room-a', 'onboarding_templates', 'one')],
    ['query', async () => createOnboardingStore().query('room-a', 'onboarding_templates')],
    ['count', async () => createOnboardingStore().count('room-a', 'onboarding_templates')],
  ])('throws a typed error for malformed %s results', async (_operation, invoke) => {
    callAppPlatformTool.mockResolvedValue({ unexpected: true });

    const error = await invoke().catch((caught) => caught);

    expect(error).toBeInstanceOf(OnboardingStoreError);
    expect(error).toMatchObject({ code: 'STORE_MALFORMED_RESULT' });
  });
});
