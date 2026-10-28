import { callAppPlatformTool, type AppPlatformToolCaller } from '../app-platform-tool-call';
import type { OnboardingActor } from './auth';
import type { EmployeeRecord, EmployeeType } from './contracts';
import type { OnboardingStore, StoreRecord } from './store';

export interface AddEmployeeInput {
  readonly memberId: string;
  readonly employeeType: EmployeeType;
}

export interface EmployeeService {
  list(actor: OnboardingActor): Promise<readonly EmployeeRecord[]>;
  getByMemberId(actor: OnboardingActor, memberId: string): Promise<EmployeeRecord>;
  add(actor: OnboardingActor, input: AddEmployeeInput): Promise<EmployeeRecord>;
}

export type EmployeeServiceErrorCode =
  | 'ADMIN_REQUIRED'
  | 'EMPLOYEE_NOT_FOUND'
  | 'EMPLOYEE_ALREADY_EXISTS'
  | 'MEMBER_NOT_FOUND'
  | 'EMPLOYEE_TYPE_INVALID';

export class EmployeeServiceError extends Error {
  readonly code: EmployeeServiceErrorCode;

  constructor(code: EmployeeServiceErrorCode, message: string) {
    super(message);
    this.name = 'EmployeeServiceError';
    this.code = code;
  }
}

interface EmployeeDbRecord extends StoreRecord {
  readonly id: string;
  readonly memberId: string;
  readonly employeeType: EmployeeType;
  readonly addedBy: string;
  readonly addedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LegacyAssignmentDbRecord extends StoreRecord {
  readonly memberId: string;
  readonly employeeType: EmployeeType;
  readonly assignedBy?: string;
  readonly assignedAt: string;
}

export interface EmployeeServiceOptions {
  readonly callPlatform?: AppPlatformToolCaller;
  readonly now?: () => string;
}

function requireAdmin(actor: OnboardingActor): void {
  if (actor.access !== 'admin') {
    throw new EmployeeServiceError('ADMIN_REQUIRED', 'Admin access is required.');
  }
}

function isEmployeeType(value: unknown): value is EmployeeType {
  return value === 'normal' || value === 'advanced';
}

function isDuplicateError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return record.code === 11000 || [record.message, record.error, String(error)]
    .some((value) => typeof value === 'string' && /E11000|duplicate key/i.test(value));
}

function employeeFrom(row: EmployeeDbRecord, roomId: string): EmployeeRecord {
  return {
    id: row.id,
    roomId,
    memberId: row.memberId,
    employeeType: row.employeeType,
    addedBy: row.addedBy,
    addedAt: row.addedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function memberIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  return [row.userId, row.id, row._id]
    .find((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()));
}

export function createEmployeeService(
  store: OnboardingStore,
  options: EmployeeServiceOptions = {},
): EmployeeService {
  const caller = options.callPlatform ?? callAppPlatformTool;
  const now = options.now ?? (() => new Date().toISOString());

  async function employeeRows(roomId: string): Promise<readonly EmployeeDbRecord[]> {
    const rows: EmployeeDbRecord[] = [];
    let cursor: string | undefined;
    do {
      const result = await store.query<EmployeeDbRecord>(roomId, 'onboarding_employees', {
        orderBy: [{ field: 'addedAt', direction: 'desc' }], limit: 1000, ...(cursor ? { cursor } : {}),
      });
      rows.push(...result.records);
      cursor = result.nextCursor;
    } while (cursor);
    return rows;
  }

  async function legacyAssignmentRows(roomId: string): Promise<readonly LegacyAssignmentDbRecord[]> {
    const rows: LegacyAssignmentDbRecord[] = [];
    let cursor: string | undefined;
    do {
      const result = await store.query<LegacyAssignmentDbRecord>(roomId, 'onboarding_assignments', {
        orderBy: [{ field: 'assignedAt', direction: 'desc' }], limit: 1000, ...(cursor ? { cursor } : {}),
      });
      rows.push(...result.records);
      cursor = result.nextCursor;
    } while (cursor);
    return rows;
  }

  async function createRow(
    actor: OnboardingActor,
    memberId: string,
    employeeType: EmployeeType,
    addedBy: string,
    addedAt: string,
  ): Promise<EmployeeRecord> {
    try {
      const row = await store.create<EmployeeDbRecord>(actor.roomId, 'onboarding_employees', {
        memberId,
        employeeType,
        addedBy,
        addedAt,
        createdAt: addedAt,
        updatedAt: addedAt,
      });
      return employeeFrom(row, actor.roomId);
    } catch (error) {
      if (isDuplicateError(error)) {
        throw new EmployeeServiceError('EMPLOYEE_ALREADY_EXISTS', 'Nhân sự này đã có trong danh sách.');
      }
      throw error;
    }
  }

  async function reconcile(actor: OnboardingActor): Promise<readonly EmployeeRecord[]> {
    const rows = await employeeRows(actor.roomId);
    const known = new Set(rows.map((row) => row.memberId));
    const assignments = await legacyAssignmentRows(actor.roomId);
    const newestFirst = [...assignments]
      .sort((left, right) => right.assignedAt.localeCompare(left.assignedAt));

    for (const assignment of newestFirst) {
      if (known.has(assignment.memberId) || !isEmployeeType(assignment.employeeType)) continue;
      known.add(assignment.memberId);
      try {
        await createRow(
          actor,
          assignment.memberId,
          assignment.employeeType,
          assignment.assignedBy || actor.userId,
          assignment.assignedAt,
        );
      } catch (error) {
        if (!(error instanceof EmployeeServiceError) || error.code !== 'EMPLOYEE_ALREADY_EXISTS') throw error;
      }
    }

    return (await employeeRows(actor.roomId)).map((row) => employeeFrom(row, actor.roomId));
  }

  return {
    async list(actor) {
      requireAdmin(actor);
      return reconcile(actor);
    },

    async getByMemberId(actor, rawMemberId) {
      requireAdmin(actor);
      const memberId = rawMemberId.trim();
      const employee = (await reconcile(actor)).find((item) => item.memberId === memberId);
      if (!employee) {
        throw new EmployeeServiceError('EMPLOYEE_NOT_FOUND', 'Nhân sự chưa được thêm vào danh sách.');
      }
      return employee;
    },

    async add(actor, input) {
      requireAdmin(actor);
      const memberId = input.memberId.trim();
      if (!isEmployeeType(input.employeeType)) {
        throw new EmployeeServiceError('EMPLOYEE_TYPE_INVALID', 'Phân loại nhân sự không hợp lệ.');
      }
      const existing = await store.query<EmployeeDbRecord>(actor.roomId, 'onboarding_employees', {
        filter: { memberId }, limit: 1,
      });
      if (existing.records.length > 0) {
        throw new EmployeeServiceError('EMPLOYEE_ALREADY_EXISTS', 'Nhân sự này đã có trong danh sách.');
      }

      const rawMembers = await caller(
        'mcpapp.rooms.getMembers', { roomId: actor.roomId }, 'rooms:read', actor.roomId,
        { replaySafe: true },
      );
      const members: readonly unknown[] = Array.isArray(rawMembers)
        ? rawMembers
        : rawMembers && typeof rawMembers === 'object'
        && Array.isArray((rawMembers as { members?: unknown }).members)
          ? (rawMembers as { members: unknown[] }).members
          : [];
      if (!memberId || !members.some((member) => memberIdFrom(member) === memberId)) {
        throw new EmployeeServiceError('MEMBER_NOT_FOUND', 'Thành viên đã chọn không còn trong room.');
      }

      const timestamp = now();
      return createRow(actor, memberId, input.employeeType, actor.userId, timestamp);
    },
  };
}
