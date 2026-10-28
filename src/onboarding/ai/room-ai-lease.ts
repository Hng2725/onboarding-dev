import type { OnboardingActor } from '../auth';
import type { AiCallRecord, RoomAiLease } from '../contracts';
import type { OnboardingStore, StoreRecord } from '../store';
import { AI_GENERATION_LIMITS } from './limits';

interface LeaseRecord extends StoreRecord, RoomAiLease {
  readonly id: string;
  readonly updatedAt: string;
}

export interface RoomAiLeaseInput {
  readonly jobId: string;
  readonly callId: string;
  readonly holderId: string;
  readonly now?: string;
}

function assertInput(actor: OnboardingActor, input: RoomAiLeaseInput): void {
  if (actor.access !== 'admin') throw Object.assign(new Error('Admin access is required.'), { code: 'ADMIN_REQUIRED' });
  if (![actor.roomId, input.jobId, input.callId, input.holderId].every((value) => value.trim())) {
    throw new Error('Room, job, call and holder are required for an AI lease.');
  }
}

export function isAiLeaseConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return ['OPERATION_CONFLICT', 'DB_CONFLICT', 'CONFLICT', 'VERSION_CONFLICT'].includes(String(value.code))
    || /OPERATION_CONFLICT|DB_CONFLICT|VERSION_CONFLICT|expectedUpdatedAt|optimistic|update conflict/i.test(String(value.message ?? ''));
}

function duplicate(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return value.code === 11000 || /E11000|duplicate key|unique index/i.test(String(value.message ?? error));
}

function matches(lease: RoomAiLease, input: RoomAiLeaseInput): boolean {
  return lease.jobId === input.jobId && lease.callId === input.callId && lease.holderId === input.holderId;
}

async function readLease(store: OnboardingStore, roomId: string): Promise<LeaseRecord | undefined> {
  return (await store.query<LeaseRecord>(roomId, 'onboarding_ai_room_leases', { filter: { leaseKey: 'generation' }, limit: 1 })).records[0];
}

function timestamp(input: RoomAiLeaseInput, previous?: LeaseRecord): string {
  return new Date(Math.max(Date.parse(input.now ?? new Date().toISOString()), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
}

function expiresAt(input: RoomAiLeaseInput): string {
  return new Date(Date.parse(input.now ?? new Date().toISOString()) + AI_GENERATION_LIMITS.pumpLeaseMs).toISOString();
}

export function aiCallMayBeLive(call: AiCallRecord): boolean {
  return call.cleanupState !== 'confirmed'
    && (Boolean(call.attemptRef) && call.status === 'dispatched'
      || Boolean(call.dispatchClaimedAt) && !call.attemptRef && (call.status === 'pending' || call.dispatchUnknown === true)
      || call.cleanupState === 'pending' || call.cleanupState === 'unknown');
}

/** Also fences attempts recorded before the room-lease collection was introduced. */
async function conflictingAttempt(store: OnboardingStore, roomId: string, input: RoomAiLeaseInput): Promise<RoomAiLease | undefined> {
  let cursor: string | undefined;
  do {
    const page = await store.query<StoreRecord & { jobId: string; pumpedBy?: string; calls: readonly AiCallRecord[] }>(roomId, 'onboarding_ai_jobs', { limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const job of page.records) {
      const call = job.calls.find((candidate) => aiCallMayBeLive(candidate) && !(job.jobId === input.jobId && candidate.callId === input.callId));
      if (call) return { leaseKey: 'generation', jobId: job.jobId, callId: call.callId, holderId: call.leaseHolderId ?? job.pumpedBy ?? 'recorded-attempt', expiresAt: new Date(0).toISOString() };
    }
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

export async function acquireRoomAiLease(
  store: OnboardingStore, actor: OnboardingActor, input: RoomAiLeaseInput,
): Promise<{ acquired: true; lease: RoomAiLease } | { acquired: false; lease: RoomAiLease }> {
  assertInput(actor, input);
  const current = await readLease(store, actor.roomId);
  const blocking = await conflictingAttempt(store, actor.roomId, input);
  if (blocking) return { acquired: false, lease: current ?? blocking };
  const data = { leaseKey: 'generation' as const, jobId: input.jobId, callId: input.callId, holderId: input.holderId, expiresAt: expiresAt(input), updatedAt: timestamp(input, current) };
  if (!current) {
    try {
      return { acquired: true, lease: await store.create<LeaseRecord>(actor.roomId, 'onboarding_ai_room_leases', data) };
    } catch (error) {
      if (!duplicate(error)) throw error;
      const winner = await readLease(store, actor.roomId);
      if (!winner) throw error;
      return { acquired: false, lease: winner };
    }
  }
  if (!matches(current, input) && Date.parse(current.expiresAt) > Date.parse(input.now ?? new Date().toISOString())) {
    return { acquired: false, lease: current };
  }
  try {
    return { acquired: true, lease: await store.update<LeaseRecord>(actor.roomId, 'onboarding_ai_room_leases', current.id, data, { expectedUpdatedAt: current.updatedAt }) };
  } catch (error) {
    if (!isAiLeaseConflict(error)) throw error;
    const winner = await readLease(store, actor.roomId);
    if (!winner) throw error;
    return { acquired: false, lease: winner };
  }
}

export async function refreshRoomAiLease(store: OnboardingStore, actor: OnboardingActor, input: RoomAiLeaseInput): Promise<RoomAiLease> {
  assertInput(actor, input);
  const current = await readLease(store, actor.roomId);
  if (!current || !matches(current, input)) throw Object.assign(new Error('This browser no longer owns the room AI lease.'), { code: 'JOB_LEASE_LOST' });
  return store.update<LeaseRecord>(actor.roomId, 'onboarding_ai_room_leases', current.id, { expiresAt: expiresAt(input), updatedAt: timestamp(input, current) }, { expectedUpdatedAt: current.updatedAt });
}

export async function releaseRoomAiLease(store: OnboardingStore, actor: OnboardingActor, input: RoomAiLeaseInput): Promise<void> {
  assertInput(actor, input);
  const current = await readLease(store, actor.roomId);
  if (!current || !matches(current, input)) return;
  try {
    await store.update(actor.roomId, 'onboarding_ai_room_leases', current.id, { expiresAt: new Date(0).toISOString(), updatedAt: timestamp(input, current) }, { expectedUpdatedAt: current.updatedAt });
  } catch (error) {
    // A concurrent refresh/takeover owns the record now. Never release its lease.
    if (!isAiLeaseConflict(error)) throw error;
  }
}
