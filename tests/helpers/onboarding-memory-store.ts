import type {
  OnboardingStore,
  StoreFilter,
  StoreQueryOptions,
  StoreRecord,
  StoreUpdateOptions,
} from '../../src/onboarding/store';
import { ONBOARDING_COLLECTIONS } from '../../src/onboarding/schema';

function jsonCopy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export class MemoryOnboardingStore implements OnboardingStore {
  private sequence = 0;
  private readonly rows = new Map<string, Map<string, StoreRecord>>();

  constructor(private readonly maxPageSize?: number) {}

  private table(roomId: string, collection: string): Map<string, StoreRecord> {
    const tableKey = JSON.stringify([roomId, collection]);
    const current = this.rows.get(tableKey) ?? new Map<string, StoreRecord>();
    this.rows.set(tableKey, current);
    return current;
  }

  private assertUnique(
    roomId: string,
    collection: string,
    candidate: StoreRecord,
    excludedId?: string,
  ): void {
    const definition = ONBOARDING_COLLECTIONS.find((item) => item.collection === collection);
    for (const uniqueIndex of definition?.indexes.filter((item) => item.unique) ?? []) {
      const fields = Object.keys(uniqueIndex.fields);
      const values = fields.map((fieldName) => candidate[fieldName]);
      if (values.some((value) => value === undefined || value === null)) continue;
      const duplicate = [...this.table(roomId, collection).values()].some((row) =>
        row.id !== excludedId
        && !row.deletedAt
        && fields.every((fieldName) => row[fieldName] === candidate[fieldName]));
      if (duplicate) {
        throw new Error(`unique index violation: ${uniqueIndex.name}`);
      }
    }
  }

  private matches(row: StoreRecord, filter: StoreFilter = {}): boolean {
    return Object.entries(filter).every(([key, value]) => row[key] === value);
  }

  async create<T extends StoreRecord>(
    roomId: string,
    collection: string,
    data: StoreRecord,
  ): Promise<T> {
    const id = `db-${++this.sequence}`;
    const row = jsonCopy({ ...data, id });
    this.assertUnique(roomId, collection, row);
    this.table(roomId, collection).set(id, row);
    return jsonCopy(row) as T;
  }

  async get<T extends StoreRecord>(roomId: string, collection: string, id: string): Promise<T | null> {
    const row = this.table(roomId, collection).get(id);
    return row && !row.deletedAt ? jsonCopy(row) as T : null;
  }

  async query<T extends StoreRecord>(
    roomId: string,
    collection: string,
    options: StoreQueryOptions = {},
  ): Promise<{ records: readonly T[]; nextCursor?: string }> {
    let records = [...this.table(roomId, collection).values()]
      .filter((row) => (options.includeDeleted || !row.deletedAt) && this.matches(row, options.filter));
    for (const order of [...(options.orderBy ?? [])].reverse()) {
      records = records.sort((left, right) => {
        const compared = String(left[order.field] ?? '').localeCompare(String(right[order.field] ?? ''), undefined, { numeric: true });
        return order.direction === 'asc' ? compared : -compared;
      });
    }
    const offset = options.cursor ? Number(options.cursor) : 0;
    const requestedPageSize = options.limit ?? 50;
    const pageSize = Math.min(requestedPageSize, this.maxPageSize ?? requestedPageSize);
    const nextOffset = offset + pageSize;
    return {
      records: jsonCopy(records.slice(offset, nextOffset)) as T[],
      ...(nextOffset < records.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async update<T extends StoreRecord>(
    roomId: string,
    collection: string,
    id: string,
    data: StoreRecord,
    options?: StoreUpdateOptions,
  ): Promise<T> {
    const current = this.table(roomId, collection).get(id);
    if (!current) throw new Error('missing record');
    if (options?.expectedUpdatedAt !== undefined && current.updatedAt !== options.expectedUpdatedAt) {
      throw Object.assign(new Error('Atomic update conflict'), { code: 'OPERATION_CONFLICT' });
    }
    // The real store sends `data` as JSON, so undefined fields are dropped rather than cleared.
    const sent = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
    const row = jsonCopy({ ...current, ...sent, id });
    this.assertUnique(roomId, collection, row, id);
    this.table(roomId, collection).set(id, row);
    return jsonCopy(row) as T;
  }

  async softDelete(roomId: string, collection: string, id: string): Promise<void> {
    const current = this.table(roomId, collection).get(id);
    if (current) this.table(roomId, collection).set(id, { ...current, deletedAt: 'deleted' });
  }

  async count(roomId: string, collection: string, filter: StoreFilter = {}): Promise<number> {
    return [...this.table(roomId, collection).values()]
      .filter((row) => !row.deletedAt && this.matches(row, filter)).length;
  }

  async aggregate<T>(): Promise<T> {
    throw new Error('aggregate is not implemented in the in-memory test adapter');
  }
}
