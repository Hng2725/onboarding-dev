import { callAppPlatformTool, type AppPlatformToolCaller } from '../app-platform-tool-call';
import type { OnboardingCollectionName } from './schema';

export type StoreRecord = Record<string, unknown>;
export type StoreFilter = Readonly<Record<string, unknown>>;

export interface QueryOrder {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export interface StoreQueryOptions {
  readonly filter?: StoreFilter;
  readonly orderBy?: readonly QueryOrder[];
  readonly limit?: number;
  readonly cursor?: string;
  readonly includeDeleted?: boolean;
}

export interface StoreQueryResult<T extends StoreRecord> {
  readonly records: readonly T[];
  readonly nextCursor?: string;
}

export interface StoreUpdateOptions {
  readonly expectedUpdatedAt?: string;
  readonly operationId?: string;
}

export interface OnboardingStore {
  create<T extends StoreRecord>(
    roomId: string,
    collection: OnboardingCollectionName,
    data: StoreRecord,
    operationId?: string,
  ): Promise<T>;
  get<T extends StoreRecord>(
    roomId: string,
    collection: OnboardingCollectionName,
    id: string,
  ): Promise<T | null>;
  query<T extends StoreRecord>(
    roomId: string,
    collection: OnboardingCollectionName,
    options?: StoreQueryOptions,
  ): Promise<StoreQueryResult<T>>;
  update<T extends StoreRecord>(
    roomId: string,
    collection: OnboardingCollectionName,
    id: string,
    data: StoreRecord,
    options?: StoreUpdateOptions,
  ): Promise<T>;
  softDelete(
    roomId: string,
    collection: OnboardingCollectionName,
    id: string,
  ): Promise<void>;
  count(
    roomId: string,
    collection: OnboardingCollectionName,
    filter?: StoreFilter,
  ): Promise<number>;
  aggregate<T>(
    roomId: string,
    collection: OnboardingCollectionName,
    pipeline: StoreRecord,
  ): Promise<T>;
}

export class OnboardingStoreError extends Error {
  readonly code: 'STORE_MALFORMED_RESULT' | 'STORE_LIMIT_EXCEEDED' | 'STORE_INVALID_ARGUMENT';
  readonly operation?: string;

  constructor(
    code: OnboardingStoreError['code'],
    message: string,
    operation?: string,
  ) {
    super(message);
    this.name = 'OnboardingStoreError';
    this.code = code;
    this.operation = operation;
  }
}

function asRecord(value: unknown): StoreRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as StoreRecord
    : undefined;
}

function requiredRoom(roomId: string): string {
  const value = roomId.trim();
  if (!value) throw new OnboardingStoreError('STORE_INVALID_ARGUMENT', 'A verified roomId is required.');
  return value;
}

function malformed(operation: string): never {
  throw new OnboardingStoreError(
    'STORE_MALFORMED_RESULT',
    `${operation} returned a malformed App Database result.`,
    operation,
  );
}

function recordResult<T extends StoreRecord>(value: unknown, operation: string): T {
  const envelope = asRecord(value);
  const nestedRecord = envelope && asRecord(envelope.record);
  const directRecord = envelope
    && (typeof envelope.id === 'string' || typeof envelope._id === 'string')
    ? envelope
    : undefined;
  const record = nestedRecord ?? directRecord;
  if (!record) return malformed(operation);
  if (typeof record.id === 'string') return record as T;
  if (typeof record._id === 'string') return { ...record, id: record._id } as unknown as T;
  return malformed(operation);
}

function equalityWhere(filter: StoreFilter): StoreRecord[] {
  return Object.entries(filter).map(([field, value]) => ({ field, op: '==', value }));
}

export function createOnboardingStore(caller: AppPlatformToolCaller = callAppPlatformTool): OnboardingStore {
  return {
    async create<T extends StoreRecord>(
      roomId: string,
      collection: OnboardingCollectionName,
      data: StoreRecord,
      operationId?: string,
    ): Promise<T> {
      const args: StoreRecord = { collection, data };
      if (operationId) args.operationId = operationId;
      const result = await caller('mcpapp.db.create', args, 'db:write', requiredRoom(roomId));
      return recordResult<T>(result, 'mcpapp.db.create');
    },

    async get<T extends StoreRecord>(
      roomId: string,
      collection: OnboardingCollectionName,
      id: string,
    ): Promise<T | null> {
      const result = await caller(
        'mcpapp.db.get',
        { collection, id },
        'db:read',
        requiredRoom(roomId),
      );
      const envelope = asRecord(result);
      if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'record')) {
        return malformed('mcpapp.db.get');
      }
      if (envelope.record === null) return null;
      const record = asRecord(envelope.record);
      return record ? record as T : malformed('mcpapp.db.get');
    },

    async query<T extends StoreRecord>(
      roomId: string,
      collection: OnboardingCollectionName,
      options: StoreQueryOptions = {},
    ): Promise<StoreQueryResult<T>> {
      const limit = options.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new OnboardingStoreError(
          'STORE_LIMIT_EXCEEDED',
          'App Database query limit must be an integer from 1 to 1000.',
          'mcpapp.db.query',
        );
      }
      const args: StoreRecord = { collection, limit };
      if (options.filter) args.where = equalityWhere(options.filter);
      if (options.orderBy) args.orderBy = options.orderBy;
      if (options.cursor) args.cursor = options.cursor;
      if (options.includeDeleted) args.includeDeleted = true;
      const result = await caller('mcpapp.db.query', args, 'db:read', requiredRoom(roomId));
      const envelope = asRecord(result);
      if (!envelope || !Array.isArray(envelope.records) || !envelope.records.every(asRecord)) {
        return malformed('mcpapp.db.query');
      }
      if (
        envelope.nextCursor !== undefined
        && envelope.nextCursor !== null
        && typeof envelope.nextCursor !== 'string'
      ) return malformed('mcpapp.db.query');
      return {
        records: envelope.records.map((record) => recordResult<T>(record, 'mcpapp.db.query')),
        ...(typeof envelope.nextCursor === 'string' ? { nextCursor: envelope.nextCursor } : {}),
      };
    },

    async update<T extends StoreRecord>(
      roomId: string,
      collection: OnboardingCollectionName,
      id: string,
      data: StoreRecord,
      options: StoreUpdateOptions = {},
    ): Promise<T> {
      const args: StoreRecord = { collection, id, data };
      if (options.expectedUpdatedAt) args.expectedUpdatedAt = options.expectedUpdatedAt;
      if (options.operationId) args.operationId = options.operationId;
      const result = await caller('mcpapp.db.update', args, 'db:write', requiredRoom(roomId));
      return recordResult<T>(result, 'mcpapp.db.update');
    },

    async softDelete(
      roomId: string,
      collection: OnboardingCollectionName,
      id: string,
    ): Promise<void> {
      await caller(
        'mcpapp.db.delete',
        { collection, id },
        'db:write',
        requiredRoom(roomId),
      );
    },

    async count(
      roomId: string,
      collection: OnboardingCollectionName,
      filter: StoreFilter = {},
    ): Promise<number> {
      const where = equalityWhere(filter);
      const result = await caller(
        'mcpapp.db.count',
        { collection, ...(where.length > 0 ? { where } : {}) },
        'db:read',
        requiredRoom(roomId),
      );
      const envelope = asRecord(result);
      if (!envelope || typeof envelope.count !== 'number' || !Number.isFinite(envelope.count)) {
        return malformed('mcpapp.db.count');
      }
      return envelope.count;
    },

    async aggregate<T>(
      roomId: string,
      collection: OnboardingCollectionName,
      pipeline: StoreRecord,
    ): Promise<T> {
      const result = await caller(
        'mcpapp.db.aggregate',
        { collection, ...pipeline },
        'db:read',
        requiredRoom(roomId),
      );
      const envelope = asRecord(result);
      if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'result')) {
        return malformed('mcpapp.db.aggregate');
      }
      return envelope.result as T;
    },
  };
}
