import type {
  OnboardingStore,
  StoreFilter,
  StoreQueryOptions,
  StoreRecord,
  StoreUpdateOptions,
} from '../../src/onboarding/store';

export class MemoryOnboardingStore implements OnboardingStore {
  private sequence = 0;
  private readonly rows = new Map<string, Map<string, StoreRecord>>();

  constructor(private readonly maxPageSize?: number) {}

  private table(collection: string): Map<string, StoreRecord> {
    const current = this.rows.get(collection) ?? new Map<string, StoreRecord>();
    this.rows.set(collection, current);
    return current;
  }

  private matches(row: StoreRecord, filter: StoreFilter = {}): boolean {
    return Object.entries(filter).every(([key, value]) => row[key] === value);
  }

  async create<T extends StoreRecord>(
    _roomId: string,
    collection: string,
    data: StoreRecord,
  ): Promise<T> {
    const id = `db-${++this.sequence}`;
    const row = { ...data, id };
    this.table(collection).set(id, row);
    return row as T;
  }

  async get<T extends StoreRecord>(_roomId: string, collection: string, id: string): Promise<T | null> {
    const row = this.table(collection).get(id);
    return row && !row.deletedAt ? row as T : null;
  }

  async query<T extends StoreRecord>(
    _roomId: string,
    collection: string,
    options: StoreQueryOptions = {},
  ): Promise<{ records: readonly T[]; nextCursor?: string }> {
    let records = [...this.table(collection).values()]
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
      records: records.slice(offset, nextOffset) as T[],
      ...(nextOffset < records.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async update<T extends StoreRecord>(
    _roomId: string,
    collection: string,
    id: string,
    data: StoreRecord,
    _options?: StoreUpdateOptions,
  ): Promise<T> {
    const current = this.table(collection).get(id);
    if (!current) throw new Error('missing record');
    const row = { ...current, ...data, id };
    this.table(collection).set(id, row);
    return row as T;
  }

  async softDelete(_roomId: string, collection: string, id: string): Promise<void> {
    const current = this.table(collection).get(id);
    if (current) this.table(collection).set(id, { ...current, deletedAt: 'deleted' });
  }

  async count(_roomId: string, collection: string, filter: StoreFilter = {}): Promise<number> {
    return [...this.table(collection).values()]
      .filter((row) => !row.deletedAt && this.matches(row, filter)).length;
  }

  async aggregate<T>(): Promise<T> {
    throw new Error('aggregate is not implemented in the in-memory test adapter');
  }
}
