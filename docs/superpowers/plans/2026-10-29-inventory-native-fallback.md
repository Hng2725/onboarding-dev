# Inventory Native Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically hand an inventory-analysis job from a crashed PrivOS Sandbox worker to Native AI Chat exactly once.

**Architecture:** Add a focused inventory recovery module that classifies persisted Sandbox failures and orchestrates one server-owned retry through Native. Wire it into the existing generator pump without changing job storage, prompts, review, publishing, or Roomfiles; the existing call history remains the progress and audit source.

**Tech Stack:** TypeScript, React 18, Vitest, PrivOS MCP App APIs, Vite

**Spec:** `docs/superpowers/specs/2026-10-29-inventory-native-fallback-design.md`

## Global Constraints

- Sandbox remains the primary provider.
- Native requires both `sandbox:ai-chat` and `sandbox:ai-chat:write`.
- Automatic fallback is limited to one Native pass and never dispatches both providers concurrently.
- Parsing, validation, authorization, cancellation, and invalid-output failures do not trigger Native fallback.
- Existing job IDs, source selection, diagnostic fields, and call history are preserved.

## Review Focus

- Provider code casing or a missing code with `Worker exited with code N` must still classify a real Sandbox worker crash; Task 1 pins both representations.
- Missing either Native scope must leave the failed Sandbox job untouched; Task 1 verifies no retry is queued.
- A failed Native fallback must stop after the second provider pass; Task 1 verifies there is no third pump or second retry.
- A refreshed job that already contains a Native attempt must never restart the Sandbox-to-Native handoff; Task 1 covers resumed Native history.
- Permission, cancellation, invalid output, and ordinary data failures must retain current behavior; Task 1 covers representative non-infrastructure codes and messages.

---

### Task 1: Bounded inventory recovery orchestration

**Files:**
- Create: `src/ui/onboarding/ai/inventory-recovery.ts`
- Create: `tests/onboarding-ai-inventory-recovery.spec.ts`

**Interfaces:**
- Consumes: `AiJobRecord` and persisted `AiCallRecord` provider diagnostics from `src/onboarding/contracts.ts`.
- Produces: `isInventoryNativeFallbackCandidate(job: AiJobRecord): boolean` and `pumpWithInventoryRecovery(options: InventoryRecoveryOptions): Promise<AiJobRecord>`.
- `InventoryRecoveryOptions` contains `initialJob`, `initialPreferNative`, `nativeAvailable`, `pumpOnce(job, preferNative)`, `reloadJob(jobId)`, and `retryJob(jobId)`.

- [ ] **Step 1: Write failing classifier tests**

Add tests proving that only a failed `inventory` job whose current failed call belongs to `sandbox` and reports `worker_failed` (case-insensitive) or `Worker exited with code N` is eligible. Assert false for Native history, template jobs, `AI_OUTPUT_INVALID`, `AI_PERMISSION_DENIED`, cancellation, and generic data errors.

- [ ] **Step 2: Run classifier tests to verify they fail**

Run: `npx vitest run tests/onboarding-ai-inventory-recovery.spec.ts`

Expected: FAIL because `inventory-recovery.ts` does not exist.

- [ ] **Step 3: Implement the classifier**

Create `isInventoryNativeFallbackCandidate(job: AiJobRecord): boolean`. Resolve the failed call from the persisted call list, require Sandbox ownership, reject any history containing a Native attempt, and match only the approved worker-crash diagnostics.

- [ ] **Step 4: Run classifier tests to verify they pass**

Run: `npx vitest run tests/onboarding-ai-inventory-recovery.spec.ts`

Expected: classifier tests PASS.

- [ ] **Step 5: Write failing orchestration tests**

Add tests with mocked callbacks asserting:

- Sandbox failure reloads persisted state, queues one `retryJob`, and calls `pumpOnce` again with `preferNative === true`.
- Missing Native capability rethrows the original failure without calling `retryJob`.
- An ineligible persisted failure rethrows without retry.
- A Native failure after the handoff is rethrown after exactly two pump calls and one retry.
- `initialPreferNative === true` never creates another fallback pass.

- [ ] **Step 6: Run orchestration tests to verify they fail**

Run: `npx vitest run tests/onboarding-ai-inventory-recovery.spec.ts`

Expected: FAIL because `pumpWithInventoryRecovery` is not implemented.

- [ ] **Step 7: Implement bounded orchestration**

Implement `pumpWithInventoryRecovery(options: InventoryRecoveryOptions): Promise<AiJobRecord>`. Run the initial pump once; on failure reload the persisted job, classify it, queue one retry, and pump that retry with Native. Preserve and rethrow the original error whenever fallback is unavailable or ineligible, and allow the Native error to propagate without another recovery loop.

- [ ] **Step 8: Run the focused tests**

Run: `npx vitest run tests/onboarding-ai-inventory-recovery.spec.ts`

Expected: all inventory recovery tests PASS.

- [ ] **Step 9: Commit the recovery unit**

```bash
git add src/ui/onboarding/ai/inventory-recovery.ts tests/onboarding-ai-inventory-recovery.spec.ts
git commit -m "feat: add bounded inventory native fallback"
```

### Task 2: Connect recovery to source analysis and progress

**Files:**
- Modify: `src/ui/onboarding/ai/ai-generator.tsx:41-46,1276-1321,1412-1436`
- Modify: `src/ui/onboarding/ai/ai-job-milestones.tsx:20-85`
- Modify: `tests/onboarding-ai-admin-ui.spec.ts:887-937`
- Test: `tests/onboarding-ai-inventory-recovery.spec.ts`

**Interfaces:**
- Consumes: `pumpWithInventoryRecovery(options)` from Task 1 and the existing `pump(job, preferNative)` callback.
- Produces: inventory analysis that automatically queues `retry_job`, calls `get_job` after a provider failure, and selects the Native gateway for the one fallback pass.

- [ ] **Step 1: Write the failing generator integration contract test**

Extend the focused recovery test with an adapter-shaped case asserting the callbacks use `get_job` for the same job ID and unwrap `{ job }` from `retry_job`, while the retried call stays in the original job history.

- [ ] **Step 2: Write the failing progress test**

In `tests/onboarding-ai-admin-ui.spec.ts`, add an inventory job containing failed Sandbox `A1` plus dispatched Native `A1-retry1`. Assert the analysis milestone is active, its detail names the retry and says `Sandbox lỗi, đang chuyển sang Native AI Chat`, and the old Sandbox failure does not render the whole job as failed.

- [ ] **Step 3: Run the integration and progress tests to verify they fail**

Run: `npx vitest run tests/onboarding-ai-inventory-recovery.spec.ts tests/onboarding-ai-admin-ui.spec.ts`

Expected: at least the new integration/progress assertions FAIL.

- [ ] **Step 4: Wire recovery into `analyze()`**

Import `pumpWithInventoryRecovery`. Keep the existing start/resume/manual-retry selection, then call the orchestrator with:

- `nativeAvailable: nativeFallbackAvailable && !nativeCleanupBlock`
- `initialPreferNative: aiJobPrefersNative(inventoryJob)`
- `pumpOnce: pump`
- `reloadJob`: `adminAi('get_job', { jobId })`
- `retryJob`: `adminAi('retry_job', { jobId })`

Do not change template-job pumping or question recovery.

- [ ] **Step 5: Make the fallback transition explicit in progress**

Update inventory milestone detail derivation so a running Native retry remains the active analysis step and appends `Sandbox lỗi, đang chuyển sang Native AI Chat`. Keep the previous failed Sandbox call in job history and do not add a second progress component.

- [ ] **Step 6: Run the focused integration tests**

Run: `npx vitest run tests/onboarding-ai-inventory-recovery.spec.ts tests/onboarding-ai-admin-ui.spec.ts`

Expected: both files PASS.

- [ ] **Step 7: Run related AI regression tests**

Run: `npx vitest run tests/ai-pump.spec.ts tests/onboarding-ai-question-recovery.spec.ts tests/ai-jobs.spec.ts`

Expected: all related AI tests PASS and no question fallback behavior changes.

- [ ] **Step 8: Commit the integration**

```bash
git add src/ui/onboarding/ai/ai-generator.tsx src/ui/onboarding/ai/ai-job-milestones.tsx tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-inventory-recovery.spec.ts
git commit -m "fix: recover inventory analysis through native chat"
```

### Task 3: Full verification and live handoff check

**Files:**
- Modify only if verification reveals a defect in files owned by Tasks 1-2.

**Interfaces:**
- Consumes: completed fallback implementation and existing project verification scripts.
- Produces: evidence that the branch is type-safe, regression-safe, buildable, and packaged in Docker.

- [ ] **Step 1: Run strict type checking**

Run: `npm run typecheck:strict-unused`

Expected: exit code 0.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: all test files and tests PASS.

- [ ] **Step 3: Build the production bundle**

Run: `npm run build`

Expected: Vite build, manifest generation, and manifest lint all complete successfully.

- [ ] **Step 4: Build the Docker image**

Run: `npm run docker:build`

Expected: image `privos-onboarding:local` builds successfully.

- [ ] **Step 5: Inspect the final diff and worktree**

Run: `git diff --check HEAD~2..HEAD` and `git status --short`

Expected: no whitespace errors and no unintended uncommitted files.

- [ ] **Step 6: Verify the live flow after deployment/reload**

In the existing Chrome tab, start source analysis with Native permissions granted. If Sandbox returns `worker_failed`, verify the same job automatically gains a Native retry call, the progress remains active, and a successful Native response advances to step 3 without an Admin click.

- [ ] **Step 7: Commit any verification-only correction**

If verification required a code correction, add only the affected Task 1-2 files and commit with a focused `fix:` message. If no correction was needed, do not create an empty commit.
