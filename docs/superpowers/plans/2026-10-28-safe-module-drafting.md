# Safe Module Drafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace whole-template lesson generation with an Admin-approved deterministic outline, sequential per-module AI drafting, source-only fallback, per-module review/versioning, and responsibilities-only Template 2 input.

**Architecture:** Keep the existing `onboarding_ai_jobs` service and browser pump, but add a `module_v2` pipeline whose server-owned outline and module runs are persisted explicitly. The server chooses one module lesson/question call at a time, a room-scoped lease prevents concurrent attempts, and every terminal failure can materialize a source-only fallback without discarding completed modules. Legacy whole-template jobs remain readable and resumable through their current path.

**Tech Stack:** TypeScript, React 18, PrivOS MCP App SDK/App Database/Roomfiles, Vitest, Vite, existing Sandbox and Native AI Chat gateways.

**Spec:** `docs/superpowers/specs/2026-10-28-safe-module-drafting-design.md`

## Global Constraints

- Template 1 has 4–8 unique frames in the authoritative order; `t1-overview` and `t1-core` are required unless represented by a blocking missing flag.
- Template 2 has 5–8 unique frames in the authoritative `t2-*` order and requires only 2–8 unique responsibilities; Department and Job Title are absent from new UI, validation, and prompts.
- Legacy `RoleProfile.department`, `departmentLabel`, and `jobTitle` values remain readable but optional and are not required for new jobs.
- Module IDs are server-owned, immutable, independent of display order, never supplied by AI, and never reused after tombstoning.
- Only one live AI attempt may exist for this app in a room/project; Template 1, Template 2, lessons, and questions all share the same queue.
- Every module requires one approved lesson version followed by an approved set of 3–5 questions tied to that exact lesson version before publish.
- A module without usable source sections becomes a blocking manual placeholder; fallback must never invent content.
- Automatic retry is limited to one transient provider retry and one schema repair per module; project busy uses bounded backoff and cannot create a retry storm.
- Closing the modal/tab does not start later modules; an already-dispatched attempt is adopted on reconnect, while only explicit Cancel requests provider cancellation.
- “Both” stays sequential: complete/review Template 1, then Template 2, then one resumable/idempotent publish action; successful artifacts are not rolled back after a later failure.
- Published PDF/JSON artifacts remain under `Onboarding-app/Created templates/<template-name>/` and are readable inside the app.
- Add no new runtime dependency unless an existing project capability cannot satisfy the spec.

## Review Focus

- Legacy advanced jobs with Department/Job Title must resume while new advanced jobs contain responsibilities only — pinned in Task 1 and Task 8 tests.
- Two tabs/Admins racing to dispatch different modules must result in exactly one provider attempt and one waiting job — pinned in Task 6 tests.
- A required module with zero usable source sections must become a blocking manual placeholder, never empty AI input or invented fallback — pinned in Task 4 and Task 7 tests.
- Outline/source/lesson edits must invalidate only affected approvals/questions while retaining prior snapshots for audit — pinned in Task 5 and Task 7 tests.
- Partial Roomfiles/publish success for “Both” must resume idempotently without duplicating files, templates, or resources — pinned in Task 8 tests.

---

### Task 1: Responsibilities-Only Template 2 Contract

**Files:**
- Modify: `src/onboarding/contracts.ts:74-82`
- Modify: `src/onboarding/ai/inventory.ts:430-530`
- Modify: `src/ui/onboarding/ai/ai-template-batch.ts:1-180`
- Modify: `src/ui/onboarding/ai/ai-generator.tsx:700-850,875-890,1048-1065,1260-1330,1515-1640`
- Modify: `src/ui/onboarding/ai/ai-generator.tsx:286-330` (error copy)
- Test: `tests/ai-inventory.spec.ts`
- Test: `tests/ai-jobs.spec.ts`
- Test: `tests/onboarding-ai-template-batch.spec.ts`
- Test: `tests/onboarding-ai-admin-ui.spec.ts`
- Test: `tests/onboarding-ai-generator-lifecycle.spec.ts`

**Interfaces:**
- Consumes: Existing `RoleProfile`, `validateRoleProfile`, `templateJobRequest`, `validateTemplateRequest`, and restored `AiJobRecord.roleProfile`.
- Produces: `RoleProfile` with required `responsibilities` and optional legacy role metadata; responsibilities-only UI/request helpers used by all later tasks.

- [ ] **Step 1: Write failing contract and batch tests**

Add assertions equivalent to:

```ts
expect(validateRoleProfile({ responsibilities: ['Xử lý sự cố', 'Bảo đảm an toàn'] })).toEqual([]);
expect(validateTemplateRequest({ selection: 'advanced', responsibilities: 'A\nB' })).toEqual({});
expect(templateJobRequest({
  selection: 'advanced', kind: 'advanced', inventoryJobId: 'inventory-1',
  baseTitle: '', responsibilities: 'A\nB', operationId: 'op-1',
}).roleProfile).toEqual({ responsibilities: ['A', 'B'] });
```

Also prove duplicate/under-2/over-8 responsibilities fail and a legacy profile containing all old fields still validates and resumes.

- [ ] **Step 2: Write failing UI tests**

Assert the Template 2 selector renders the responsibilities textarea/count but does not render `Phòng ban`, `Tên phòng ban`, or `Chức danh`; restore a legacy failed job and assert only responsibilities hydrate and Retry remains enabled.

- [ ] **Step 3: Run the focused tests and verify red**

Run: `npm test -- --run tests/ai-inventory.spec.ts tests/ai-jobs.spec.ts tests/onboarding-ai-template-batch.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts`

Expected: FAIL on required Department/Job Title and removed controls.

- [ ] **Step 4: Implement the minimal compatibility change**

Change `RoleProfile` so `department`, `departmentLabel`, and `jobTitle` are optional legacy fields; retain `systemRole`/`seniority` as optional. Make `validateRoleProfile(profile)` validate only 2–8 unique, trimmed responsibilities for new and legacy records. Change `flagsForAdvancedRole` permission copy to refer generically to the advanced role rather than `jobTitle`.

Change these signatures:

```ts
validateTemplateRequest(input: {
  selection: TemplateSelection;
  responsibilities: string;
}): TemplateRequestErrors;

templateJobRequest(input: {
  selection: TemplateSelection;
  kind: EmployeeType;
  inventoryJobId: string;
  baseTitle: string;
  responsibilities: string;
  operationId: string;
}): TemplateStartJobRequest;
```

Remove Department/Job Title state, props, controls, validation precedence, request fields, and hydration from `AiGeneratorPage`. Update `ROLE_PROFILE_INVALID` Vietnamese copy to mention only 2–8 unique tasks.

- [ ] **Step 5: Run focused tests and strict typecheck**

Run: `npm test -- --run tests/ai-inventory.spec.ts tests/ai-jobs.spec.ts tests/onboarding-ai-template-batch.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts`

Run: `npm run typecheck:strict-unused`

Expected: all focused tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/onboarding/contracts.ts src/onboarding/ai/inventory.ts src/ui/onboarding/ai/ai-template-batch.ts src/ui/onboarding/ai/ai-generator.tsx tests/ai-inventory.spec.ts tests/ai-jobs.spec.ts tests/onboarding-ai-template-batch.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts
git commit -m "feat: simplify advanced template input"
```

### Task 2: Deterministic Template Outline Domain

**Files:**
- Create: `src/onboarding/ai/outline.ts`
- Modify: `src/onboarding/contracts.ts`
- Test: `tests/ai-outline.spec.ts`
- Test: `tests/ai-contracts.spec.ts`

**Interfaces:**
- Consumes: `EmployeeType`, `RoleProfile.responsibilities`, inventory features/flags/source refs, `NORMAL_FRAMES`, `ADVANCED_FRAMES`, and module-count limits.
- Produces:

```ts
interface TemplateOutlineModule {
  readonly moduleLocalId: string;
  readonly frameKey: string;
  readonly order: number;
  readonly title: string;
  readonly description: string;
  readonly estimatedMinutes: number;
  readonly objectives: readonly string[];
  readonly featureIds: readonly string[];
  readonly sourceSectionIds: readonly string[];
  readonly responsibilityIndexes: readonly number[];
  readonly tombstoned?: boolean;
}

interface TemplateOutline {
  readonly revision: number;
  readonly modules: readonly TemplateOutlineModule[];
  readonly taskCoverage: readonly GeneratedTaskCoverage[];
  readonly flags: readonly GeneratedFlag[];
}

buildTemplateOutline(input: {
  jobId: string;
  templateKind: EmployeeType;
  inventory: FeatureInventory;
  responsibilities: readonly string[];
}): TemplateOutline;

validateTemplateOutline(outline: TemplateOutline, input: {
  templateKind: EmployeeType;
  responsibilities: readonly string[];
}): readonly ValidationError[];

applyTemplateOutlineEdits(outline: TemplateOutline, edits: readonly OutlineEdit[],
  newId: (frameKey: string) => string): TemplateOutline;
```

- [ ] **Step 1: Write failing outline tests**

Cover Template 1 range/order/required frames, Template 2 range/order/responsibility coverage, missing-source flags, immutable IDs under reorder, new ID on delete/re-add, and deterministic initial output for the same job/inventory.

Include the Review Focus assertion:

```ts
const reordered = applyTemplateOutlineEdits(outline, [{ type: 'reorder', moduleLocalId: id, order: 0 }], idFactory);
expect(reordered.modules.find((module) => module.frameKey === frame)?.moduleLocalId).toBe(id);
```

- [ ] **Step 2: Run and verify red**

Run: `npm test -- --run tests/ai-outline.spec.ts tests/ai-contracts.spec.ts`

Expected: FAIL because outline types/functions do not exist.

- [ ] **Step 3: Implement outline construction, validation, and edits**

Keep frame selection and section-to-module scoring pure and deterministic. Initial IDs must derive from `jobId + frameKey`; edits receive `newId` so re-added frames do not reuse tombstoned IDs. Recompute task coverage after edits while preserving module IDs and prior tombstones.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- --run tests/ai-outline.spec.ts tests/ai-contracts.spec.ts`

Run: `npm run typecheck:strict-unused`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/ai/outline.ts src/onboarding/contracts.ts tests/ai-outline.spec.ts tests/ai-contracts.spec.ts
git commit -m "feat: add deterministic template outlines"
```

### Task 3: Module-Scoped AI Prompts and Validators

**Files:**
- Create: `src/onboarding/ai/module-draft.ts`
- Modify: `src/onboarding/ai/prompts.ts`
- Modify: `src/onboarding/ai/validate.ts`
- Modify: `src/onboarding/ai/limits.ts`
- Test: `tests/ai-module-draft.spec.ts`
- Test: `tests/ai-prompts.spec.ts`
- Test: `tests/ai-validate.spec.ts`
- Test: `tests/ai-trap-doc.spec.ts`

**Interfaces:**
- Consumes: `TemplateOutlineModule`, selected `SourceSection[]`, inventory features, responsibilities, grounding helpers, existing `GeneratedModule`/question types.
- Produces:

```ts
buildModuleLessonPrompt(input: ModuleLessonPromptInput): AiPromptRequest;
validateModuleLessonOutput(raw: unknown, input: ModuleLessonValidationInput): ModuleLessonValidation;
buildModuleQuestionPrompt(input: ModuleQuestionPromptInput): AiPromptRequest;
validateModuleQuestionOutput(raw: unknown, input: ModuleQuestionValidationInput): ModuleQuestionValidation;
buildModuleLessonRepairPrompt(input: ModuleLessonRepairPromptInput): AiPromptRequest;
```

- [ ] **Step 1: Write failing module contract tests**

Assert a lesson response contains only the current module’s editable lesson fields/blocks/flags; server-owned module ID/frame/order/coverage are reapplied. Reject unknown fields, cross-module IDs, ungrounded source refs, questions in lesson output, and root template/task coverage fields.

Assert question output has exactly 3–5 questions for the current module and records the approved lesson version it targets.

- [ ] **Step 2: Add prompt-injection and size tests**

Assert only selected module sections enter system context, source text remains untrusted data, no legacy Department/Job Title appears, and prompt/context byte limits fail closed.

- [ ] **Step 3: Run and verify red**

Run: `npm test -- --run tests/ai-module-draft.spec.ts tests/ai-prompts.spec.ts tests/ai-validate.spec.ts tests/ai-trap-doc.spec.ts`

Expected: FAIL because module-scoped builders/validators are absent.

- [ ] **Step 4: Implement the small contracts**

Reuse grounding and block/question parsers, but do not call whole-template validation for module output. Limit repair to one exact module and make `PROMPT_VERSION` change so cache keys invalidate.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- --run tests/ai-module-draft.spec.ts tests/ai-prompts.spec.ts tests/ai-validate.spec.ts tests/ai-trap-doc.spec.ts`

Run: `npm run typecheck:strict-unused`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/onboarding/ai/module-draft.ts src/onboarding/ai/prompts.ts src/onboarding/ai/validate.ts src/onboarding/ai/limits.ts tests/ai-module-draft.spec.ts tests/ai-prompts.spec.ts tests/ai-validate.spec.ts tests/ai-trap-doc.spec.ts
git commit -m "feat: scope AI drafting to one module"
```

### Task 4: Source-Only Fallback and Manual Placeholder

**Files:**
- Create: `src/onboarding/ai/fallback-lessons.ts`
- Test: `tests/ai-fallback-lessons.spec.ts`
- Test: `tests/ai-grounding.spec.ts`

**Interfaces:**
- Consumes: `TemplateOutlineModule`, exact `SourceSection[]`, and grounding helpers.
- Produces:

```ts
type FallbackLessonResult =
  | { readonly kind: 'draft'; readonly module: GeneratedModule; readonly provenance: 'fallback' }
  | { readonly kind: 'manual_placeholder'; readonly moduleLocalId: string; readonly blockingReason: 'NO_USABLE_SOURCE' };

buildFallbackLesson(input: {
  outline: TemplateOutlineModule;
  sections: readonly SourceSection[];
}): FallbackLessonResult;
```

- [ ] **Step 1: Write failing fallback tests**

Assert headings/bullets/ordered steps become deterministic blocks, every non-summary block has grounded refs, and every emitted sentence is either structural copy or normalized source text. Assert malicious instructions inside source remain inert text.

Add the Review Focus test: zero usable sections returns `manual_placeholder`, contains no generated prose, and is blocking.

- [ ] **Step 2: Run and verify red**

Run: `npm test -- --run tests/ai-fallback-lessons.spec.ts tests/ai-grounding.spec.ts`

Expected: FAIL because the fallback builder is absent.

- [ ] **Step 3: Implement deterministic fallback**

Map heading/paragraph/list structure into existing block kinds, preserve source text, create exactly one final summary composed only of already-emitted source-backed headings, and never synthesize content when source is empty.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- --run tests/ai-fallback-lessons.spec.ts tests/ai-grounding.spec.ts`

Run: `npm run typecheck:strict-unused`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/ai/fallback-lessons.ts tests/ai-fallback-lessons.spec.ts tests/ai-grounding.spec.ts
git commit -m "feat: add source-only lesson fallback"
```

### Task 5: Persisted Module Lifecycle and Approval Versioning

**Files:**
- Create: `src/onboarding/ai/module-lifecycle.ts`
- Modify: `src/onboarding/contracts.ts`
- Modify: `src/onboarding/schema.ts:171-185`
- Modify: `src/onboarding/ai/jobs.ts`
- Modify: `src/onboarding/tools.ts:470-525`
- Modify: `tests/helpers/onboarding-memory-store.ts`
- Test: `tests/ai-module-lifecycle.spec.ts`
- Test: `tests/ai-jobs.spec.ts`
- Test: `tests/onboarding-tools.spec.ts`
- Test: `tests/ai-schema.spec.ts`
- Test: `tests/ai-memory-store.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–4 outline, module validation, and fallback interfaces.
- Produces:

```ts
type AiPipelineVersion = 'legacy' | 'module_v2';
type LessonState = 'queued' | 'drafting' | 'validating' | 'review_ready' | 'fallback_review' | 'approved' | 'stale' | 'failed' | 'manual_required';
type QuestionState = 'blocked' | 'queued' | 'drafting' | 'review_ready' | 'approved' | 'stale' | 'failed';

interface AiModuleDraftRun {
  readonly outline: TemplateOutlineModule;
  readonly outlineRevision: number;
  readonly lessonState: LessonState;
  readonly lessonVersion: number;
  readonly approvedLessonVersion?: number;
  readonly lessonDraft?: GeneratedModule;
  readonly lessonProvenance?: 'ai' | 'fallback' | 'manual';
  readonly questionState: QuestionState;
  readonly questionVersion: number;
  readonly approvedQuestionVersion?: number;
  readonly questionLessonVersion?: number;
  readonly questionDraft?: readonly GeneratedQuestion[];
  readonly nextRetryAt?: string;
  readonly providerWaitStartedAt?: string;
}
```

Add optional `pipelineVersion`, `outline`, `outlineApprovedRevision`, and `moduleRuns` JSON fields to job contracts/schema/DB mapping. Extend `AiJobNextStep` with `{ kind: 'awaiting_admin'; job }`.

Add service/tool actions with exact inputs:

```ts
update_outline({ jobId, expectedRevision, edits }): { job }
approve_outline({ jobId, expectedRevision }): { job }
update_module_lesson({ jobId, moduleLocalId, expectedVersion, module }): { job }
approve_module_lesson({ jobId, moduleLocalId, expectedVersion }): { job }
update_module_questions({ jobId, moduleLocalId, expectedVersion, questions }): { job }
approve_module_questions({ jobId, moduleLocalId, expectedVersion }): { job }
retry_module({ jobId, moduleLocalId, target: 'lesson' | 'questions' }): { job }
```

- [ ] **Step 1: Write failing lifecycle reducer tests**

Cover start → awaiting outline → approved outline → lesson review → lesson approval → question review → question approval. Pin version increments, optimistic conflicts, tombstones, and `awaiting_admin` when no AI step is allowed.

Add the Review Focus invalidation matrix tests: reorder preserves approvals; source/skeleton/lesson changes stale only affected lesson/questions; prior approved snapshots remain in stage outputs/audit history and are not publishable.

- [ ] **Step 2: Write failing service/tool/schema tests**

Assert new jobs use `module_v2`, legacy records without new fields still deserialize, actions are room/admin/owner bound, and stale expected versions fail closed. Assert `manual_required` modules block question generation and completion.

- [ ] **Step 3: Run and verify red**

Run: `npm test -- --run tests/ai-module-lifecycle.spec.ts tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts tests/ai-schema.spec.ts tests/ai-memory-store.spec.ts`

Expected: FAIL on missing state/actions/fields.

- [ ] **Step 4: Implement pure lifecycle transitions**

Keep invalidation/version logic in `module-lifecycle.ts`; `jobs.ts` owns persistence, authorization, prompt selection, and atomic expected-version checks. Do not migrate active legacy jobs.

- [ ] **Step 5: Implement service and tool actions**

New template jobs create/persist an outline and return `awaiting_admin` until approved. `submitAiOutput` processes only the active module call and stores the resulting module draft. Terminal module failure invokes fallback/manual placeholder and advances the queue rather than failing the whole template, unless persistence/integrity itself fails.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- --run tests/ai-module-lifecycle.spec.ts tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts tests/ai-schema.spec.ts tests/ai-memory-store.spec.ts`

Run: `npm run typecheck:strict-unused`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/onboarding/ai/module-lifecycle.ts src/onboarding/contracts.ts src/onboarding/schema.ts src/onboarding/ai/jobs.ts src/onboarding/tools.ts tests/helpers/onboarding-memory-store.ts tests/ai-module-lifecycle.spec.ts tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts tests/ai-schema.spec.ts tests/ai-memory-store.spec.ts
git commit -m "feat: persist per-module AI lifecycle"
```

### Task 6: Room AI Lease, Project-Busy Backoff, and Reconnect-Safe Pump

**Files:**
- Create: `src/onboarding/ai/room-ai-lease.ts`
- Modify: `src/onboarding/schema.ts`
- Modify: `src/onboarding/contracts.ts`
- Modify: `src/onboarding/ai/jobs.ts`
- Modify: `src/ui/onboarding/ai/ai-gateway-native-chat.ts`
- Modify: `src/ui/onboarding/ai/ai-gateway-sandbox.ts`
- Modify: `src/ui/onboarding/ai/ai-pump.ts`
- Modify: `tests/helpers/onboarding-memory-store.ts`
- Test: `tests/ai-room-lease.spec.ts`
- Test: `tests/ai-pump.spec.ts`
- Test: `tests/ai-gateway-native-chat.spec.ts`
- Test: `tests/ai-gateway.spec.ts`
- Test: `tests/ai-attempt-lifecycle.spec.ts`

**Interfaces:**
- Consumes: Task 5 module job transitions and existing `AiGateway`/pump interfaces.
- Produces:

```ts
interface RoomAiLease {
  readonly leaseKey: 'generation';
  readonly jobId: string;
  readonly callId: string;
  readonly holderId: string;
  readonly expiresAt: string;
}

acquireRoomAiLease(store, actor, input): Promise<{ acquired: true; lease: RoomAiLease } | { acquired: false; lease: RoomAiLease }>;
refreshRoomAiLease(store, actor, input): Promise<RoomAiLease>;
releaseRoomAiLease(store, actor, input): Promise<void>;
```

Add room-scoped `onboarding_ai_room_leases` with unique `leaseKey`. Classify Native message `Another request in this project is still running` as provider error code `PROJECT_BUSY`.

- [ ] **Step 1: Write failing lease race tests**

Use two service instances/tabs that call `next_step` concurrently. Assert only one receives an AI call/lease and the other receives `wait`; terminal completion, fallback, cancel, and expired lease release/unblock the next job. Assert the same job/tab re-adopts its recorded attempt instead of dispatching again.

- [ ] **Step 2: Write failing project-busy/backoff tests**

Assert `PROJECT_BUSY` does not immediately create another attempt, stores bounded `providerWaitStartedAt`/`nextRetryAt`, and transitions to fallback after the configured wait. Assert no more than one automatic transient retry and one schema repair.

- [ ] **Step 3: Write reconnect tests**

Close/abort the pump after `record_dispatch`; resume with a new pump and assert the same attemptRef is polled. Assert no later module starts until reconnect; explicit cancel still cancels and confirms cleanup.

- [ ] **Step 4: Run and verify red**

Run: `npm test -- --run tests/ai-room-lease.spec.ts tests/ai-pump.spec.ts tests/ai-gateway-native-chat.spec.ts tests/ai-gateway.spec.ts tests/ai-attempt-lifecycle.spec.ts`

Expected: FAIL on missing lease/project-busy behavior.

- [ ] **Step 5: Implement lease and provider classification**

Use App Database unique creation plus expected-updated-at takeover for expired leases. Never infer the identity of an external PrivOS request. Release only when job/call/holder match.

- [ ] **Step 6: Adapt pump and service waiting semantics**

Honor `awaiting_admin`; sleep until `nextRetryAt` without dispatch; adopt recorded attempts on reconnect; preserve the final terminal status check before timeout. Provider failures update only the active module run and invoke fallback according to Task 5.

- [ ] **Step 7: Run tests and typecheck**

Run: `npm test -- --run tests/ai-room-lease.spec.ts tests/ai-pump.spec.ts tests/ai-gateway-native-chat.spec.ts tests/ai-gateway.spec.ts tests/ai-attempt-lifecycle.spec.ts`

Run: `npm run typecheck:strict-unused`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/onboarding/ai/room-ai-lease.ts src/onboarding/schema.ts src/onboarding/contracts.ts src/onboarding/ai/jobs.ts src/ui/onboarding/ai/ai-gateway-native-chat.ts src/ui/onboarding/ai/ai-gateway-sandbox.ts src/ui/onboarding/ai/ai-pump.ts tests/helpers/onboarding-memory-store.ts tests/ai-room-lease.spec.ts tests/ai-pump.spec.ts tests/ai-gateway-native-chat.spec.ts tests/ai-gateway.spec.ts tests/ai-attempt-lifecycle.spec.ts
git commit -m "feat: serialize room AI generation"
```

### Task 7: Admin Outline, Module Progress, and Review Workspace

**Files:**
- Create: `src/ui/onboarding/ai/ai-outline-review.tsx`
- Create: `src/ui/onboarding/ai/ai-module-workspace.tsx`
- Modify: `src/ui/onboarding/ai/ai-generator.tsx`
- Modify: `src/ui/onboarding/ai/ai-job-milestones.tsx`
- Modify: `src/ui/onboarding/ai/ai-review.tsx`
- Modify: `src/ui/onboarding/styles.css`
- Test: `tests/onboarding-ai-outline-ui.spec.ts`
- Test: `tests/onboarding-ai-module-workspace.spec.ts`
- Test: `tests/onboarding-ai-admin-ui.spec.ts`
- Test: `tests/onboarding-ai-generator-lifecycle.spec.ts`

**Interfaces:**
- Consumes: Task 5 job/module actions and Task 6 pump waiting states.
- Produces: Admin UI for outline approval, module queue/progress, fallback/manual review, lesson approvals, and question approvals.

- [ ] **Step 1: Write failing outline UI tests**

Assert module cards show frame/order/objectives/responsibilities/sources; Admin can edit/reorder within validator limits; **Duyệt khung và bắt đầu viết** stays disabled for blocking structural errors and calls `approve_outline` with the expected revision.

- [ ] **Step 2: Write failing module workspace tests**

Assert real module statuses render (`Chờ viết`, `AI đang viết`, `Sẵn sàng rà soát`, fallback/manual labels, approved/stale); controls target one module; elapsed time is secondary; close/reopen restores the selected module/job.

Add the Review Focus placeholder test: zero-source module shows “Cần bổ sung nguồn hoặc tự soạn”, offers manual edit/source navigation, and blocks lesson/question/publish readiness until approved content exists.

- [ ] **Step 3: Write failing invalidation UI tests**

Assert changing an approved lesson shows questions as stale, preserves the prior snapshot in history, and requires new lesson/question approvals; reorder alone preserves green approvals.

- [ ] **Step 4: Run and verify red**

Run: `npm test -- --run tests/onboarding-ai-outline-ui.spec.ts tests/onboarding-ai-module-workspace.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts`

Expected: FAIL on absent components/actions.

- [ ] **Step 5: Implement outline and module components**

Keep `AiGeneratorPage` as the orchestrator; move outline/module display/edit logic into focused components. Do not mirror server state in an independent client state machine: render server `moduleRuns` and use optimistic expected versions for mutations.

- [ ] **Step 6: Update milestone/progress mapping**

Show two levels: global stages plus `N/M module có tài liệu`, and per-module state/provider/backoff time. Remove whole-stage retry wording for `module_v2`; retain legacy wording for legacy jobs.

- [ ] **Step 7: Run tests, typecheck, and UI build**

Run: `npm test -- --run tests/onboarding-ai-outline-ui.spec.ts tests/onboarding-ai-module-workspace.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts`

Run: `npm run typecheck:strict-unused`

Run: `npm run build`

Expected: PASS; manifest lint valid.

- [ ] **Step 8: Commit**

```bash
git add src/ui/onboarding/ai/ai-outline-review.tsx src/ui/onboarding/ai/ai-module-workspace.tsx src/ui/onboarding/ai/ai-generator.tsx src/ui/onboarding/ai/ai-job-milestones.tsx src/ui/onboarding/ai/ai-review.tsx src/ui/onboarding/styles.css tests/onboarding-ai-outline-ui.spec.ts tests/onboarding-ai-module-workspace.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts
git commit -m "feat: add outline and module review workspace"
```

### Task 8: Version-Safe Materialization, Publish Gates, Both/Legacy Compatibility

**Files:**
- Modify: `src/onboarding/ai/materialize.ts`
- Modify: `src/onboarding/ai/review.ts`
- Modify: `src/onboarding/templates.ts`
- Modify: `src/ui/onboarding/ai/ai-template-batch.ts`
- Modify: `src/ui/onboarding/ai/ai-publish-batch.ts`
- Modify: `src/ui/onboarding/ai/lesson-pdf.ts`
- Modify: `src/ui/onboarding/roomfiles.ts`
- Modify: `src/ui/onboarding/ai/ai-generator.tsx`
- Test: `tests/ai-materialize.spec.ts`
- Test: `tests/ai-review.spec.ts`
- Test: `tests/onboarding-ai-publish-batch.spec.ts`
- Test: `tests/onboarding-ai-template-batch.spec.ts`
- Test: `tests/onboarding-ai-lesson-pdf.spec.ts`
- Test: `tests/onboarding-roomfiles.spec.ts`
- Test: `tests/ai-onboarding-integration.spec.ts`

**Interfaces:**
- Consumes: approved `module_v2` lesson/question versions and existing legacy completed job results.
- Produces: one materialized draft with publish readiness, provenance metadata, PDF/JSON artifacts, and resumable Both-template publication.

- [ ] **Step 1: Write failing materialization/readiness tests**

Assert materialization selects only latest approved lesson/question pairs, rejects stale/mismatched versions, requires 3–5 approved questions for every module, and records `lessonProvenance: ai | fallback | manual` internally without exposing technical labels to learners.

Assert legacy jobs/templates with Department/Job Title still load and publish; new advanced content stores responsibilities only.

- [ ] **Step 2: Write failing Both/Roomfiles resume tests**

Simulate Template 1 PDF/JSON/publish success followed by Template 2 upload failure; retry and assert completed files/templates/resources are reused, no duplicates appear, and the modal closes only after all targets complete.

- [ ] **Step 3: Run and verify red**

Run: `npm test -- --run tests/ai-materialize.spec.ts tests/ai-review.spec.ts tests/onboarding-ai-publish-batch.spec.ts tests/onboarding-ai-template-batch.spec.ts tests/onboarding-ai-lesson-pdf.spec.ts tests/onboarding-roomfiles.spec.ts tests/ai-onboarding-integration.spec.ts`

Expected: FAIL on module version/provenance/publish gates.

- [ ] **Step 4: Implement materialization and readiness gates**

Assemble `GeneratedTemplate` only after all modules have matching approved lesson/question versions. Reuse current verification/materialization/template services after assembly. Keep legacy result processing unchanged behind `pipelineVersion !== 'module_v2'`.

- [ ] **Step 5: Make artifact/publish operations idempotent**

Use stable target keys/file names and persisted per-target progress so retry only resumes missing work. Preserve current Roomfiles paths and inline viewer behavior.

- [ ] **Step 6: Run tests, typecheck, and build**

Run: `npm test -- --run tests/ai-materialize.spec.ts tests/ai-review.spec.ts tests/onboarding-ai-publish-batch.spec.ts tests/onboarding-ai-template-batch.spec.ts tests/onboarding-ai-lesson-pdf.spec.ts tests/onboarding-roomfiles.spec.ts tests/ai-onboarding-integration.spec.ts`

Run: `npm run typecheck:strict-unused`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/onboarding/ai/materialize.ts src/onboarding/ai/review.ts src/onboarding/templates.ts src/ui/onboarding/ai/ai-template-batch.ts src/ui/onboarding/ai/ai-publish-batch.ts src/ui/onboarding/ai/lesson-pdf.ts src/ui/onboarding/roomfiles.ts src/ui/onboarding/ai/ai-generator.tsx tests/ai-materialize.spec.ts tests/ai-review.spec.ts tests/onboarding-ai-publish-batch.spec.ts tests/onboarding-ai-template-batch.spec.ts tests/onboarding-ai-lesson-pdf.spec.ts tests/onboarding-roomfiles.spec.ts tests/ai-onboarding-integration.spec.ts
git commit -m "feat: publish approved module drafts safely"
```

### Task 9: Full Regression, Documentation, and Live Chrome Acceptance

**Files:**
- Modify: `README.md`
- Modify: `SCOPES.md` only if behavior/copy is stale (no new permission expected)
- Modify: `CHANGELOG.md`
- Modify: `docs/app-overview.md`
- Test: all project tests except the Windows-incompatible source packaging test when Bash/unzip is unavailable.

**Interfaces:**
- Consumes: All previous tasks.
- Produces: Verified production bundle/container and documented Admin workflow.

- [ ] **Step 1: Add end-to-end regression assertions**

Extend `tests/ai-onboarding-integration.spec.ts` to prove: responsibilities-only advanced outline → Admin outline approval → one lesson AI success + one fallback + one manual placeholder resolved → lesson approvals → questions tied to versions → materialization. Extend the Both path to verify sequential execution and batch publish.

- [ ] **Step 2: Run the complete automated suite**

Run: `npm test -- --exclude tests/packaging.spec.ts`

Run: `npm run typecheck:strict-unused`

Run: `npm run build`

Expected: all tests PASS, typecheck exits 0, manifest lint valid. Run `npm test` as well where Bash/unzip exists; otherwise record the existing environment-only packaging limitation.

- [ ] **Step 3: Update product/operator documentation**

Document responsibilities-only Template 2 input, mandatory outline approval, module statuses, source-only fallback/manual placeholder, retry/backoff behavior, resume semantics, question version gate, Both publish behavior, and unchanged Roomfiles paths.

- [ ] **Step 4: Build and deploy the existing Compose service**

Run: `docker compose up -d --build app`

Verify: `/ready` returns `{ "ok": true, "status": "ready" }`, container health becomes `healthy`, and logs show `relay.connected` without secrets.

- [ ] **Step 5: Run live Chrome acceptance on the existing tab**

Reload the current PrivOS tab without opening a new tab. Verify:

1. Template 2 shows only responsibilities.
2. Outline must be reviewed before generation.
3. One module is drafted at a time with truthful progress.
4. Closing/reopening resumes the same job/attempt.
5. A forced provider failure creates fallback/manual state without losing successful modules.
6. Questions remain blocked until lesson approval and become stale after lesson edits.
7. Both reviews Template 1 then Template 2, publishes idempotently, saves artifacts, and closes the modal only after success.

- [ ] **Step 6: Commit**

```bash
git add README.md SCOPES.md CHANGELOG.md docs/app-overview.md tests/ai-onboarding-integration.spec.ts
git commit -m "docs: document safe module drafting workflow"
```

---

## Self-Review Record

- Spec coverage: Tasks 1–9 cover responsibilities-only input, deterministic outlines, mandatory outline approval, module-scoped AI, fallback/manual placeholders, retry/lease/reconnect, UI/review/versioning, questions, Both, Roomfiles, legacy compatibility, and deployment.
- Step scan: Each task has an independent red/green cycle, exact files/interfaces, verification commands, and a commit boundary.
- Type consistency: `TemplateOutline`, `AiModuleDraftRun`, lesson/question versions, `moduleLocalId`, and lifecycle action names are defined once and consumed unchanged by later tasks.
- Review Focus: all five risks are pinned to explicit tests in Tasks 1, 4, 6, 7, and 8.
- Proportion: the plan specifies interfaces/tests/decisions without transcribing implementation bodies.

