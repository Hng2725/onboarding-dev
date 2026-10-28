# Selective Hub Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover Onboarding bootstrap from transient `AgentBotHubUnreachableError` failures while never replaying unsafe platform writes.

**Architecture:** Add an explicit, fail-closed `replaySafe` option to the shared App Platform caller and a small retry primitive that recognizes only the SDK's reachability error. Opt in only at audited read/idempotent call sites; existing unsafe calls retain one attempt.

**Tech Stack:** Node.js 22, TypeScript, Vitest, `@privos_ai/app-server`, Docker Compose

**Spec:** `docs/superpowers/specs/2026-10-26-selective-hub-retry-design.md`

## Global Constraints

- Retry only `AgentBotHubUnreachableError`.
- Replay-safe calls get at most 3 total attempts with delays of 200 ms and 400 ms.
- Notifications, deletes, and writes without a non-empty `operationId` stay single-attempt.
- Do not add dependencies or change room collocation, installation mode, credentials, or Hub configuration.
- Preserve unrelated user changes in the dirty worktree.
- Do not commit or push automatically, per repository instructions.

## Review Focus

- `AgentBotCredentialAbsentError` must not be retried; Task 1 tests the generic non-reachability path with the same fail-fast expectation.
- Hub HTTP/permission/validation failures must not be retried; Task 1 tests a normal `Error` and Task 2 preserves response parsing outside the retry predicate.
- A call without `replaySafe: true` must remain exactly one attempt; Task 1 pins this behavior.
- A persistent reachability failure must stop after 3 attempts and rethrow; Task 1 pins attempts and delays.
- Database writes are replay-safe only when they carry a non-empty `operationId`; Task 2 tests create/update with and without that key.

---

### Task 1: Selective retry primitive and caller contract

**Files:**
- Create: `tests/app-platform-tool-call.spec.ts`
- Modify: `src/app-platform-tool-call.ts`

**Interfaces:**
- Produces: `AppPlatformToolCallOptions` with `readonly replaySafe?: boolean`.
- Produces: `AppPlatformToolCaller(toolName, args, requiredScope, roomId, options?) => Promise<unknown>`.
- Produces: `withSelectiveHubRetry<T>(operation, replaySafe, sleep?) => Promise<T>` for the caller and focused tests.

- [ ] **Step 1: Write failing retry tests**

Add focused tests asserting:

- a replay-safe operation that throws `AgentBotHubUnreachableError` twice succeeds on attempt 3 and records delays `[200, 400]`;
- an unsafe operation throws after one attempt with no delay;
- a replay-safe operation does not retry a normal `Error`;
- persistent reachability failure stops after 3 attempts and rethrows.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/app-platform-tool-call.spec.ts`

Expected: FAIL because `withSelectiveHubRetry` and `AppPlatformToolCallOptions` do not exist.

- [ ] **Step 3: Implement the minimal retry primitive**

In `src/app-platform-tool-call.ts`, add:

```ts
export interface AppPlatformToolCallOptions {
  readonly replaySafe?: boolean;
}

export async function withSelectiveHubRetry<T>(
  operation: () => Promise<T>,
  replaySafe: boolean,
  sleep?: (milliseconds: number) => Promise<void>,
): Promise<T>;
```

Use 3 total attempts and exponential delays from 200 ms. Retry only when `replaySafe` is true and the caught value is an `AgentBotHubUnreachableError`.

- [ ] **Step 4: Extend `AppPlatformToolCaller` and `callAppPlatformTool`**

Add the optional fifth `options` argument. Wrap the authorized request/response parse operation with `withSelectiveHubRetry`; leave app-id resolution and all behavior without `replaySafe: true` unchanged.

- [ ] **Step 5: Run focused test and typecheck**

Run: `npm test -- tests/app-platform-tool-call.spec.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS or only call-site type failures that Task 2 is explicitly responsible for.

- [ ] **Step 6: Review the task diff without committing**

Run: `git diff -- src/app-platform-tool-call.ts tests/app-platform-tool-call.spec.ts`

Expected: only the selective retry contract, implementation, and focused tests.

---

### Task 2: Audit and opt in replay-safe platform calls

**Files:**
- Modify: `src/onboarding/schema.ts`
- Modify: `src/onboarding/store.ts`
- Modify: `src/onboarding/tools.ts`
- Modify: `src/onboarding/assignments.ts`
- Modify: `src/onboarding/employees.ts`
- Modify: `tests/onboarding-store.spec.ts`
- Modify: `tests/onboarding-assignments.spec.ts`
- Modify: `tests/onboarding-employees.spec.ts`
- Test: `tests/app-platform-tool-call.spec.ts`

**Interfaces:**
- Consumes: `AppPlatformToolCallOptions` and the optional fifth caller argument from Task 1.
- Produces: explicit `{ replaySafe: true }` only for audited read/idempotent operations.

- [ ] **Step 1: Write failing call-site policy tests**

Update/add assertions so tests require:

- schema registration and schema reads to pass `{ replaySafe: true }`;
- store `get`, `query`, `count`, and `aggregate` to pass `{ replaySafe: true }`;
- store `create`/`update` to opt in only when their existing arguments contain a non-empty `operationId`;
- store delete and writes without `operationId` to omit the retry option;
- room-member reads in employee/assignment services to pass `{ replaySafe: true }`.

- [ ] **Step 2: Run policy tests and verify RED**

Run: `npm test -- tests/onboarding-store.spec.ts tests/onboarding-employees.spec.ts tests/onboarding-assignments.spec.ts`

Expected: FAIL because the audited call sites do not yet pass the retry policy.

- [ ] **Step 3: Opt in schema and read-only services**

Pass `{ replaySafe: true }` to `mcpapp.db.registerCollection`, `mcpapp.db.getSchema`, `mcpapp.db.get`, `mcpapp.db.query`, `mcpapp.db.count`, `mcpapp.db.aggregate`, `mcpapp.files.get`, and every `mcpapp.rooms.getMembers` call.

- [ ] **Step 4: Opt in idempotency-keyed writes only**

For store `create` and `update`, pass `{ replaySafe: true }` only when the already-built request contains a non-empty `operationId`. Do not opt in `softDelete` or notification calls.

- [ ] **Step 5: Run focused policy tests**

Run: `npm test -- tests/app-platform-tool-call.spec.ts tests/onboarding-store.spec.ts tests/onboarding-employees.spec.ts tests/onboarding-assignments.spec.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck and inspect the task diff**

Run: `npm run typecheck`

Expected: PASS.

Run: `git diff -- src/app-platform-tool-call.ts src/onboarding/schema.ts src/onboarding/store.ts src/onboarding/tools.ts src/onboarding/assignments.ts src/onboarding/employees.ts tests/app-platform-tool-call.spec.ts tests/onboarding-store.spec.ts tests/onboarding-employees.spec.ts tests/onboarding-assignments.spec.ts`

Expected: no notification/delete retry and no unrelated refactor.

---

### Task 3: Full verification, Docker rebuild, and browser acceptance

**Files:**
- Verify only; modify production/test files only if a verification failure is caused by Tasks 1–2.

**Interfaces:**
- Consumes: the selective retry behavior and audited call-site policy from Tasks 1–2.
- Produces: a rebuilt local Docker service and browser evidence for the supplied PrivOS URL.

- [ ] **Step 1: Run repository verification**

Run: `npm run typecheck:strict-unused`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS; report any unrelated pre-existing failure by name instead of hiding it.

Run: `npm run build`

Expected: PASS, manifest lint included.

Run: `npm run preflight`

Expected: PASS.

- [ ] **Step 2: Inspect final code state**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: retain all pre-existing user changes and show only the files changed by this fix plus the approved design/plan documents.

- [ ] **Step 3: Build and recreate the Docker app**

Run: `docker compose up -d --build app`

Expected: `onboarding-dev-app-1` is recreated and reaches healthy state. This ordinary rebuild/recreate is authorized by the fix workflow; it is not a Hub Refresh/Repair.

- [ ] **Step 4: Verify container health and logs**

Run: `docker ps --filter name=onboarding-dev-app-1 --format "{{.Names}} {{.Status}}"`

Expected: container reports healthy.

Run: `docker logs --tail 100 onboarding-dev-app-1`

Expected: Relay connected and no new `onboarding_bootstrap` error after browser verification.

- [ ] **Step 5: Reload Chrome and verify the real app**

Reload `https://roxane-dev.privos.io/channel/test-onboarding-app-chd5tx/mcpapp/6ad87c38fbc62e6c0f76918d`, wait for bootstrap, and inspect the failed request if any.

Expected: the Onboarding dashboard renders and `agent_bot_hub_unreachable` is absent.

- [ ] **Step 6: Stop for user action only if Hub lifecycle requires it**

If the rebuilt container connects but the Hub still serves a stale generation or explicitly requires Refresh/Repair, report the exact evidence and ask the user to perform that action. Otherwise, complete verification without asking for manual intervention.
