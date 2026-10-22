# PrivOS Onboarding App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PrivOS demo surface with a secure, room-scoped onboarding product for Admins and assigned Learners, including immutable PrivOS learning templates, custom templates, gated materials, exercises, essay feedback, and final evaluations.

**Architecture:** Keep the existing MCP runtime, verified-actor ingress, UI bundle, and bot-authenticated App Platform transport. Add a domain/service layer behind five app-owned MCP tools; only that backend may read or write onboarding App Database collections. Replace the demo tab UI with one responsive React shell whose role-specific Admin and Learner workspaces consume sanitized DTOs and use PrivOS Files, Notifications, theme tokens, and host storage.

**Tech Stack:** Node.js 22+, TypeScript strict mode, React 18, Vite 5, Vitest 2, `@privos_ai/app-server`, `@privos_ai/app-react`, PrivOS App Database/Files/Notifications, `@ant-design/icons` 6.x.

**Spec:** `docs/superpowers/specs/2026-10-20-onboarding-app-design.md`

## Global Constraints

- Preserve the user's current uncommitted identity, compose, and UI-shell test changes; never reset or overwrite them.
- All operational collections use App Database `scope: 'room'`; all calls derive `roomId` from the verified actor.
- The browser never calls `mcpapp.db.*` directly and never receives correct-answer keys or another learner's private data.
- Admin means current-room `owner` or canonical room administrator (`moderator` in current Hub context); verified workspace `admin` is accepted only with access to the current room. `leader` and ordinary members are Learners.
- A member sees learning content only after explicit assignment by an Admin.
- Required resources must be opened and explicitly completed before the corresponding exercise unlocks.
- Single-choice and multiple-choice questions are auto-scored; essay answers never receive numeric points.
- Every essay answer needs separate Admin feedback, and every submitted assignment needs a separate overall evaluation.
- Final conclusions are exactly `passed`, `failed`, and `retry`, displayed as `Đạt`, `Không đạt`, and `Làm lại`.
- Built-in `privos-foundations@1` and `privos-advanced@1` templates are immutable and cannot be deleted.
- Use individual exports from the free `@ant-design/icons` package; do not add the full `antd` component package.
- UI copy is Vietnamese, styles inherit PrivOS `--base-*` tokens, and non-essential animation stops under `prefers-reduced-motion: reduce`.
- Keep files focused; do not expand `mcp-message-handlers.ts` with business logic.

## Review Focus

- Missing, malformed, or mixed role claims must fail closed for Admin commands while still allowing the caller's own Learner reads; pin this in Task 2 authorization tests.
- Duplicate or retried submission requests must resolve to one attempt and one score via `operationId`; pin this in Task 6 attempt-service tests.
- Editing or publishing a later template version must not mutate existing assignments; pin this in Task 4 template-service tests.
- A local recovery draft older than the server draft must not overwrite newer server answers without confirmation; pin this in Task 9 draft-sync tests.
- A deleted/inaccessible PrivOS file must show a recoverable resource error without clearing material progress; pin this in Task 12 learning-workspace tests.

---

## File Structure

### Backend/domain

- `src/onboarding/contracts.ts` — shared domain records, sanitized DTOs, tool inputs/outputs, and enums.
- `src/onboarding/system-templates.ts` — immutable built-in PrivOS template versions.
- `src/onboarding/workflow.ts` — pure scoring, unlock, status, and evaluation-eligibility rules.
- `src/onboarding/auth.ts` — verified actor/room/role policy.
- `src/onboarding/schema.ts` — App Database collection schemas and indexes.
- `src/onboarding/store.ts` — typed store interface and App Database implementation.
- `src/onboarding/templates.ts` — system/custom template queries, cloning, draft editing, publishing, version pinning.
- `src/onboarding/assignments.ts` — room-member assignment, learner progress, resource completion, retry.
- `src/onboarding/attempts.ts` — draft persistence, idempotent submit, sanitized results.
- `src/onboarding/reviews.ts` — essay feedback, evaluation eligibility, final conclusions.
- `src/onboarding/notifications.ts` — best-effort notification adapter.
- `src/onboarding/tools.ts` — five tool definitions and authorization-aware dispatcher.

### UI

- `src/ui/onboarding/api.ts` — typed `callServerTool` client and result parsing.
- `src/ui/onboarding/navigation.ts` — role-aware route model and labels.
- `src/ui/onboarding/AppShell.tsx` — responsive header/sidebar/drawer and page states.
- `src/ui/onboarding/components.tsx` — progress, status, empty/error, and confirmation primitives.
- `src/ui/onboarding/admin-dashboard.tsx` — KPIs and work queue.
- `src/ui/onboarding/employees.tsx` — member assignment and employee detail.
- `src/ui/onboarding/templates.tsx` — template library, preview, and builder wizard.
- `src/ui/onboarding/reviews.tsx` — essay-feedback and overall-evaluation workspaces.
- `src/ui/onboarding/learner-dashboard.tsx` — learner overview and assignment cards.
- `src/ui/onboarding/learning-workspace.tsx` — resources, completion gate, questions, draft, submit.
- `src/ui/onboarding/results.tsx` — score, essay feedback, evaluation, and conclusion.
- `src/ui/onboarding/styles.css` — token-based responsive visuals and reduced-motion rules.
- `src/ui/App.tsx` — provider/bootstrap root only.

### Tests

- `tests/onboarding-workflow.spec.ts`
- `tests/onboarding-auth.spec.ts`
- `tests/onboarding-store.spec.ts`
- `tests/onboarding-templates.spec.ts`
- `tests/onboarding-assignments.spec.ts`
- `tests/onboarding-attempts.spec.ts`
- `tests/onboarding-reviews.spec.ts`
- `tests/onboarding-tools.spec.ts`
- `tests/onboarding-ui-model.spec.ts`
- `tests/onboarding-admin-ui.spec.ts`
- `tests/onboarding-learner-ui.spec.ts`

---

### Task 1: Domain Contracts, Workflow Rules, and Built-in Templates

**Files:**
- Create: `src/onboarding/contracts.ts`
- Create: `src/onboarding/workflow.ts`
- Create: `src/onboarding/system-templates.ts`
- Create: `tests/onboarding-workflow.spec.ts`

**Interfaces:**
- Produces: `EmployeeType`, `QuestionType`, `AssignmentStatus`, `FinalConclusion`, `TemplateSnapshot`, `AssignmentRecord`, `AttemptRecord`, `AnswerRecord`, `EssayFeedbackRecord`, `EvaluationRecord`, and Admin/Learner DTO types.
- Produces: `scoreMultipleChoice(questions, answers): MultipleChoiceScore | null`.
- Produces: `canUnlockExercise(resources, progress): boolean`.
- Produces: `canEvaluateAttempt(questions, answers, feedback): boolean`.
- Produces: `nextAssignmentStatus(input): AssignmentStatus`.
- Produces: `SYSTEM_TEMPLATES: readonly TemplateSnapshot[]` and `getSystemTemplate(id, version)`.

- [ ] **Step 1: Write failing workflow and catalog tests**

Add tests named:

- `scores only single-choice and exact-set multiple-choice answers`
- `returns null when an exercise contains only essays`
- `never includes essays in the numeric denominator`
- `keeps an exercise locked until every required resource is opened and completed`
- `requires feedback for every submitted essay before overall evaluation`
- `maps conclusions to passed failed and retry assignment states`
- `ships immutable normal and advanced PrivOS templates at version 1`

Assert the catalog IDs are `privos-foundations` and `privos-advanced`, both have `version: 1`, and attempts to mutate their nested arrays fail or leave the values unchanged.

Pin these module keys so the initial content is deterministic:

- Foundations: `welcome`, `account`, `rooms`, `files`, `lists`, `notifications-and-apps`.
- Advanced: `sandbox`, `bots`, `ai-workflows`, `app-permissions`, `room-isolation`.

Each module contains at least one official `https://docs.privos.ai/` source URL and at least one knowledge-check question; content is Vietnamese and cites the source URL in resource metadata.

- [ ] **Step 2: Run the new tests and verify they fail**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-workflow.spec.ts`

Expected: FAIL because `src/onboarding/workflow.ts` and `system-templates.ts` do not exist.

- [ ] **Step 3: Define exact domain records and sanitized DTOs**

In `contracts.ts`, define string unions with these exact values:

- `EmployeeType = 'normal' | 'advanced'`
- `QuestionType = 'single_choice' | 'multiple_choice' | 'essay'`
- `TemplateSource = 'system' | 'custom'`
- `TemplateStatus = 'draft' | 'published' | 'archived'`
- `AssignmentStatus = 'assigned' | 'in_progress' | 'submitted' | 'awaiting_essay_feedback' | 'awaiting_evaluation' | 'passed' | 'failed' | 'retry'`
- `AttemptStatus = 'draft' | 'submitted' | 'auto_scored' | 'reviewed'`
- `FinalConclusion = 'passed' | 'failed' | 'retry'`

Make correct answer IDs available only on backend records/Admin template DTOs. Define a distinct `LearnerQuestionDto` without `correctOptionIds`.

- [ ] **Step 4: Implement pure workflow functions and frozen system templates**

Use exact-set comparison for `multiple_choice`. Require both `openedAt` and `completedAt` for each required resource. Deep-freeze the two system templates at module initialization and keep stable resource/question IDs across releases.

- [ ] **Step 5: Run the task tests**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-workflow.spec.ts`

Expected: all Task 1 tests PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/onboarding/contracts.ts src/onboarding/workflow.ts src/onboarding/system-templates.ts tests/onboarding-workflow.spec.ts
git commit -m "feat: add onboarding domain workflow"
```

### Task 2: Verified Actor and Room Role Policy

**Files:**
- Create: `src/onboarding/auth.ts`
- Create: `tests/onboarding-auth.spec.ts`
- Modify: `privos-app.json`
- Modify: `SCOPES.md`

**Interfaces:**
- Consumes: `EmployeeType` and DTO identities from Task 1.
- Produces: `OnboardingActor { userId, username?, roomId, access: 'admin' | 'learner' }`.
- Produces: `resolveOnboardingActor(actor?: VerifiedActor): OnboardingActor`.
- Produces: `requireAdmin(actor?: VerifiedActor): OnboardingActor`.
- Produces: `requireSelf(actor, requestedMemberId?): OnboardingActor`.

- [ ] **Step 1: Write failing authorization tests**

Cover:

- `owner`, `moderator`, and workspace `admin` resolve to Admin.
- `leader`, `member`, empty roles, malformed role values, and mixed arrays containing only unknown strings resolve to Learner.
- missing actor returns `IDENTITY_REQUIRED`.
- actor without `roomId` returns `ROOM_UNBOUND`.
- `requireAdmin` returns `ADMIN_REQUIRED` for leader/member/missing role claims.
- `requireSelf` accepts an absent/equal member selector and rejects a different member with `MEMBER_FORBIDDEN`.
- requested `roomId` never overrides the verified actor room.

Use claim keys `room_roles` and `workspace_roles`; accept only arrays of strings.

- [ ] **Step 2: Run the authorization tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-auth.spec.ts`

Expected: FAIL because `src/onboarding/auth.ts` does not exist.

- [ ] **Step 3: Implement fail-closed actor policy**

Reuse the existing `INVALID_PARAMS` error shape from `caller-room.ts`. Do not read role data supplied in tool arguments. Keep role normalization in this one file.

- [ ] **Step 4: Declare the exact identity/member scopes**

Add required `rooms:roles:read` for signed actor role claims and required `rooms:read` for room-member listing/validation. Retain required App Database and file permissions for later tasks; document every call site in `SCOPES.md` as it is introduced. Preserve the existing app identity changes.

- [ ] **Step 5: Run authorization and manifest checks**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-auth.spec.ts tests\manifest.spec.ts tests\permission-catalog.spec.ts tests\scope-audit.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/onboarding/auth.ts tests/onboarding-auth.spec.ts privos-app.json SCOPES.md
git commit -m "feat: enforce onboarding room roles"
```

### Task 3: Room-scoped App Database Schema and Store

**Files:**
- Create: `src/onboarding/schema.ts`
- Create: `src/onboarding/store.ts`
- Create: `tests/onboarding-store.spec.ts`
- Modify: `src/app-platform-tool-call.ts`

**Interfaces:**
- Consumes: domain record types from Task 1 and `callAppPlatformTool(toolName, args, requiredScope, roomId)`.
- Produces: `ONBOARDING_COLLECTIONS` and `ensureOnboardingSchema(roomId): Promise<void>`.
- Produces: `OnboardingStore` with `create`, `get`, `query`, `update`, `softDelete`, `count`, and `aggregate` methods whose signatures always require `roomId`.
- Produces: `createOnboardingStore(): OnboardingStore`.

- [ ] **Step 1: Write failing schema/store tests**

Assert:

- all eleven collections from the spec register with `scope: 'room'` and exact required indexes;
- “already registered” is treated as success per collection;
- CRUD maps to the exact `mcpapp.db.*` tool and OAuth scope;
- every call passes the same explicit actor-derived room ID to `callAppPlatformTool`;
- query defaults to a bounded limit and never silently exceeds 1000;
- malformed Hub results throw a typed `OnboardingStoreError` instead of returning empty data.

- [ ] **Step 2: Run store tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-store.spec.ts`

Expected: FAIL because the schema/store modules do not exist.

- [ ] **Step 3: Implement schemas and indexes**

Define the collections listed in spec section 8.2. Store cross-collection IDs as validated strings rather than App Database references so system-template IDs and custom-record IDs use one contract. Add unique indexes for `(assignmentId, resourceId)`, `(room-bound collection, operationId)`, and one evaluation per `attemptId` where supported by the platform schema.

- [ ] **Step 4: Implement the typed store adapter**

Keep Hub response normalization and tool invocation here. Do not expose `callAppPlatformTool` directly to services after this task.

- [ ] **Step 5: Run store and existing App Platform tests**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-store.spec.ts tests\caller-room-binding.spec.ts tests\app-objects-demo-helpers.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/onboarding/schema.ts src/onboarding/store.ts src/app-platform-tool-call.ts tests/onboarding-store.spec.ts
git commit -m "feat: add onboarding room data store"
```

### Task 4: Template Catalog, Cloning, Drafts, and Version Publishing

**Files:**
- Create: `src/onboarding/templates.ts`
- Create: `tests/onboarding-templates.spec.ts`

**Interfaces:**
- Consumes: `OnboardingStore`, `SYSTEM_TEMPLATES`, `TemplateSnapshot`, and `OnboardingActor`.
- Produces: `TemplateService` with `list`, `getAdminDetail`, `getLearnerSnapshot`, `createDraft`, `updateDraft`, `cloneSystemTemplate`, `publish`, `archive`, and `deleteDraft`.
- Produces: `createTemplateService(store): TemplateService`.

- [ ] **Step 1: Write failing template service tests**

Cover:

- system templates list as published/locked and reject edit/archive/delete;
- cloning creates a room-scoped custom draft with copied modules/resources/questions but new stable IDs;
- only unassigned custom drafts can be deleted;
- publishing creates immutable version 1; editing a published template creates version 2 draft data;
- an assignment pinned to version 1 still resolves version 1 after version 2 publishes;
- stale `updatedAt`/version edits throw `TEMPLATE_CONFLICT` rather than overwriting;
- Learner snapshots omit correct answer IDs.

- [ ] **Step 2: Run template tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-templates.spec.ts`

Expected: FAIL because `TemplateService` is missing.

- [ ] **Step 3: Implement template reads and mutations**

All mutations require an already-authorized Admin actor. Validate title, employee type, at least one module, stable ordering, unique question/resource IDs, and passing score only when scored questions exist.

- [ ] **Step 4: Run template tests**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-templates.spec.ts tests\onboarding-workflow.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/onboarding/templates.ts tests/onboarding-templates.spec.ts
git commit -m "feat: add versioned onboarding templates"
```

### Task 5: Assignments, Member Validation, and Material Progress

**Files:**
- Create: `src/onboarding/assignments.ts`
- Create: `src/onboarding/notifications.ts`
- Create: `tests/onboarding-assignments.spec.ts`

**Interfaces:**
- Consumes: `OnboardingStore`, `TemplateService`, `OnboardingActor`, and `callAppPlatformTool` for `mcpapp.rooms.getMembers` and notifications.
- Produces: `AssignmentService` with `listAdmin`, `getAdminDetail`, `listMine`, `getMine`, `assign`, `markResourceOpened`, `markResourceCompleted`, `grantRetry`, and `sendDueReminders`.
- Produces: `NotificationPort.notify(userId, title, message): Promise<{ delivered: boolean; warning?: string }>`.

- [ ] **Step 1: Write failing assignment tests**

Cover:

- only a current-room member returned by `mcpapp.rooms.getMembers` can be assigned;
- assignment stores explicit `normal` or `advanced` classification and exact template source/id/version;
- unassigned Learner gets an empty list and cannot fetch template content by guessing IDs;
- Learner selectors are actor-bound and cross-member access returns `MEMBER_FORBIDDEN`;
- required resource completion needs a prior `openedAt` and is idempotent;
- optional resources never block exercise unlock;
- assignment/published-version data remains stable after newer template publication;
- notification failure returns a warning but does not roll back a successful assignment;
- due reminders target active assignments due within 48 hours, are triggered explicitly by an Admin from Overview, and are deduplicated to once per assignment per UTC day;
- `grantRetry` creates a new allowed ordinal and preserves prior attempts.

- [ ] **Step 2: Run assignment tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-assignments.spec.ts`

Expected: FAIL because the assignment service is missing.

- [ ] **Step 3: Implement assignment and progress service**

Use `rooms:read` for member validation, `notifications:write` for best-effort notifications, and store an audit event for assign, classification, material completion, reminder delivery, and retry actions. `sendDueReminders(actor, now)` is an explicit Admin action in the MVP; it does not imply an unattended scheduler.

- [ ] **Step 4: Run assignment tests**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-assignments.spec.ts tests\onboarding-auth.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/onboarding/assignments.ts src/onboarding/notifications.ts tests/onboarding-assignments.spec.ts
git commit -m "feat: add onboarding assignments and progress"
```

### Task 6: Draft Answers, Idempotent Submission, and Automatic Scoring

**Files:**
- Create: `src/onboarding/attempts.ts`
- Create: `tests/onboarding-attempts.spec.ts`

**Interfaces:**
- Consumes: `AssignmentService`, `TemplateService`, `OnboardingStore`, and Task 1 workflow functions.
- Produces: `AttemptService` with `getOrCreateDraft`, `saveDraft`, `submit`, and `getLearnerResult`.
- `submit(actor, { assignmentId, operationId }): Promise<LearnerAttemptResultDto>` is the idempotency boundary.

- [ ] **Step 1: Write failing attempt tests**

Cover:

- drafts cannot be created until required resources unlock the exercise;
- answer types and required questions are validated before save/submit;
- single/multiple choice score automatically while essay has no numeric weight;
- essay-only attempt has `mcScore: null`;
- submit transitions to `awaiting_essay_feedback` when essays exist and `awaiting_evaluation` otherwise;
- two submits with the same `operationId` return the same attempt ID and do not score twice;
- reusing an `operationId` for changed answers throws `OPERATION_CONFLICT`;
- answer keys and other learners' answers never appear in result DTOs;
- exhausted attempts reject a new draft unless Admin granted retry.

- [ ] **Step 2: Run attempt tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-attempts.spec.ts`

Expected: FAIL because the attempt service is missing.

- [ ] **Step 3: Implement attempt lifecycle**

Hash the normalized submitted answer payload and bind it to `operationId`. Create answers before transitioning the attempt; on partial failure leave the attempt as draft and return a recoverable error.

- [ ] **Step 4: Run attempt tests**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-attempts.spec.ts tests\onboarding-workflow.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/onboarding/attempts.ts tests/onboarding-attempts.spec.ts
git commit -m "feat: add onboarding attempt lifecycle"
```

### Task 7: Essay Feedback and Overall Evaluation

**Files:**
- Create: `src/onboarding/reviews.ts`
- Create: `tests/onboarding-reviews.spec.ts`

**Interfaces:**
- Consumes: `OnboardingStore`, `AssignmentService`, `AttemptService`, `canEvaluateAttempt`, and Admin actor policy.
- Produces: `ReviewService` with `listEssayQueue`, `saveEssayFeedback`, `listEvaluationQueue`, `publishEvaluation`, and `getPublishedFeedback`.

- [ ] **Step 1: Write failing review tests**

Cover:

- every submitted essay answer appears once in the feedback queue;
- feedback contains comment/reviewer/timestamp and no numeric score field;
- incomplete essay feedback blocks overall evaluation with `ESSAY_FEEDBACK_REQUIRED`;
- a multiple-choice-only submission enters the evaluation queue immediately;
- every published evaluation requires completion level, strengths, improvements, public comment, and one exact conclusion;
- `passed` and `failed` finalize the assignment; `retry` opens a new attempt and returns it to `in_progress`;
- publishing the same evaluation operation twice is idempotent;
- Learner sees only published feedback/evaluation for their own assignment.

- [ ] **Step 2: Run review tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-reviews.spec.ts`

Expected: FAIL because the review service is missing.

- [ ] **Step 3: Implement review/evaluation service**

Store a separate audit event for essay feedback, evaluation publication, and retry. Send result/retry notification after the database state commits; report notification failures as warnings.

- [ ] **Step 4: Run review tests**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-reviews.spec.ts tests\onboarding-attempts.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/onboarding/reviews.ts tests/onboarding-reviews.spec.ts
git commit -m "feat: add onboarding feedback and evaluations"
```

### Task 8: MCP Tool Surface and Manifest Contract

**Files:**
- Create: `src/onboarding/tools.ts`
- Create: `tests/onboarding-tools.spec.ts`
- Modify: `src/mcp-message-handlers.ts`
- Modify: `privos-app.json`
- Modify: `tests/mcp.spec.ts`
- Modify: `tests/manifest.spec.ts`
- Modify: `tests/caller-room-binding.spec.ts`
- Modify: `SCOPES.md`

**Interfaces:**
- Consumes: all backend services from Tasks 2–7.
- Produces exact tools: `onboarding_bootstrap`, `onboarding_admin_templates`, `onboarding_admin_assignments`, `onboarding_learning`, `onboarding_reviews`, plus the UI-opening `onboarding_dashboard`.
- Produces: `handleOnboardingTool(name, args, actor): Promise<Record<string, unknown>>`.

- [ ] **Step 1: Write failing tool-contract tests**

Assert:

- `tools/list` exposes only the six onboarding tools after demo cleanup;
- each tool accepts only documented action values and rejects unknown/missing actions;
- bootstrap returns role, room, display identity, capability state, and the correct Admin or Learner summary;
- Admin tools reject leader/member actors before any store call;
- Learner tools bind `memberId` to the verified actor;
- all tool responses are JSON text and all errors preserve machine-readable error codes;
- the manifest description, tool titles, resource URI, scopes, and degraded behaviors describe onboarding rather than the demo.

- [ ] **Step 2: Run tool and manifest tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-tools.spec.ts tests\mcp.spec.ts tests\manifest.spec.ts tests\caller-room-binding.spec.ts`

Expected: FAIL because onboarding tools are not registered.

- [ ] **Step 3: Implement the dispatcher and thin MCP routing**

Create services once per request path or inject a test service bundle; keep `mcp-message-handlers.ts` limited to protocol routing, UI resources, and one onboarding dispatcher call.

- [ ] **Step 4: Replace demo manifest tools and scopes**

Preserve the current app name/title/resource URI edits. Remove demo-only tools, license/env entries, and permissions only when no onboarding call site uses them. Keep `capabilities.verifiedActor: true`, DB, Files, rooms, roles, and optional notifications declarations.

- [ ] **Step 5: Run backend contract suites**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-*.spec.ts tests\mcp.spec.ts tests\manifest.spec.ts tests\caller-room-binding.spec.ts tests\permission-catalog.spec.ts tests\scope-audit.spec.ts tests\relay-actor-verification.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add src/onboarding/tools.ts src/mcp-message-handlers.ts privos-app.json SCOPES.md tests/onboarding-tools.spec.ts tests/mcp.spec.ts tests/manifest.spec.ts tests/caller-room-binding.spec.ts
git commit -m "feat: expose onboarding MCP tools"
```

### Task 9: UI Foundation, API Client, Navigation, and Motion System

**Files:**
- Delete: every existing file under `src/ui/` (demo panels, nested panels, styles, assets, and old shell) after recording the required PrivOS host/bridge contracts.
- Delete or replace: demo-only UI tests, including the current `tests/ui-shell.spec.ts` fixtures/assertions.
- Create: `src/ui/index.html`
- Create: `src/ui/main.tsx`
- Create: `src/ui/App.tsx`
- Create: `src/ui/theme-provider.tsx`
- Create: `src/ui/vite-env.d.ts`
- Create: `src/ui/onboarding/api.ts`
- Create: `src/ui/onboarding/navigation.ts`
- Create: `src/ui/onboarding/AppShell.tsx`
- Create: `src/ui/onboarding/components.tsx`
- Create: `src/ui/onboarding/styles.css`
- Create: `tests/onboarding-ui-model.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 8 tool names and DTO contracts.
- Produces: `OnboardingApi` typed methods for all tool groups.
- Produces: `routesForAccess(access): readonly NavigationItem[]`.
- Produces: `reconcileDraft(serverDraft, localDraft): DraftDecision` with `server`, `local`, or `confirm` outcomes.
- Produces: `AppShell` and shared status/progress/empty/error/confirm primitives.

- [ ] **Step 1: Write failing UI-model tests**

Cover:

- Admin navigation contains Overview, Employees, Templates, Essay feedback, and Overall evaluations;
- Learner navigation contains My overview, My learning, and Results;
- unassigned Learner resolves the dedicated Vietnamese empty state;
- status labels map all assignment statuses and the three conclusions exactly;
- a newer local draft returns `confirm`, an older local draft returns `server`, and equal revisions do not prompt;
- tool result parser rejects malformed/error results instead of returning undefined.

- [ ] **Step 2: Run UI-model tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-ui-model.spec.ts`

Expected: FAIL because UI foundation modules do not exist.

- [ ] **Step 3: Install icons and implement the typed API/model layer**

Run: `npm install @ant-design/icons@^6.3.1`

Import individual icons only. Use `app.storage` for a namespaced recovery draft and never for authoritative assignment state.

- [ ] **Step 4: Implement the responsive shell and design tokens**

Remove the existing UI tree rather than reusing or reskinning its demo components, then build a new bootstrap-driven onboarding app with role routing. Reimplement only the required PrivOS host bridge and theme inheritance contracts in new files. Use opacity/4–8 px transforms at 160–220 ms, cap list staggering at five items, and disable non-essential motion under reduced-motion preference. Update the document title to `PrivOS Onboarding`.

- [ ] **Step 5: Run model, type, and production bundle checks**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-ui-model.spec.ts tests\ui-shell.spec.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all commands PASS and the bundle contains hashed split assets without sourcemaps.

- [ ] **Step 6: Commit Task 9**

```bash
git add package.json package-lock.json src/ui/App.tsx src/ui/main.tsx src/ui/index.html src/ui/onboarding tests/onboarding-ui-model.spec.ts
git commit -m "feat: add onboarding application shell"
```

### Task 10: Admin Dashboard, Employees, Templates, and PrivOS Files

**Files:**
- Create: `src/ui/onboarding/admin-dashboard.tsx`
- Create: `src/ui/onboarding/employees.tsx`
- Create: `src/ui/onboarding/templates.tsx`
- Create: `tests/onboarding-admin-ui.spec.ts`
- Modify: `src/ui/onboarding/api.ts`
- Modify: `src/ui/onboarding/AppShell.tsx`
- Modify: `src/ui/onboarding/styles.css`

**Interfaces:**
- Consumes: Admin DTOs and `OnboardingApi` from Task 9; `usePrivosApp().uploadFile()` and room file metadata endpoints.
- Produces: Admin Overview, Employees, Template Library, and Template Builder screens.
- Produces: `validateTemplateDraft(draft): ValidationIssue[]` and `normalizeUploadedResource(result): TemplateResourceDraft`.

- [ ] **Step 1: Write failing Admin UI/model tests**

Cover:

- KPI/work queues derive correct counts from mixed assignment statuses;
- reminder action shows the sent/skipped/failed totals returned by `sendDueReminders` without changing assignment state;
- assignment form requires member, employee type, template version, and valid due date;
- system template actions are exactly Use and Clone, never Edit/Delete;
- custom assigned/published templates offer Archive rather than Delete;
- wizard blocks publishing without module/resource/question requirements from the spec;
- file upload normalization preserves stable file ID/name/MIME/size;
- inaccessible/deleted file shows recoverable status and does not alter progress records.

- [ ] **Step 2: Run Admin UI tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-admin-ui.spec.ts`

Expected: FAIL because Admin screens/models do not exist.

- [ ] **Step 3: Implement Overview and Employees**

Use a dense responsive table on wide screens and stacked rows on narrow screens. Assignment success refreshes both employee detail and KPI queues; notification warning appears as non-blocking feedback.

- [ ] **Step 4: Implement Template Library and Builder**

Build the five-step wizard from the spec. Upload through `app.uploadFile`, store only returned/stable file metadata in the template draft, add unsaved-change confirmation, and show immutable/version badges.

- [ ] **Step 5: Run Admin UI, type, and build checks**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-admin-ui.spec.ts tests\onboarding-ui-model.spec.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit Task 10**

```bash
git add src/ui/onboarding/admin-dashboard.tsx src/ui/onboarding/employees.tsx src/ui/onboarding/templates.tsx src/ui/onboarding/api.ts src/ui/onboarding/AppShell.tsx src/ui/onboarding/styles.css tests/onboarding-admin-ui.spec.ts
git commit -m "feat: add onboarding admin workspace"
```

### Task 11: Admin Essay Feedback and Overall Evaluation UI

**Files:**
- Create: `src/ui/onboarding/reviews.tsx`
- Modify: `src/ui/onboarding/api.ts`
- Modify: `src/ui/onboarding/AppShell.tsx`
- Modify: `src/ui/onboarding/styles.css`
- Modify: `tests/onboarding-admin-ui.spec.ts`

**Interfaces:**
- Consumes: review DTOs and review API methods from Tasks 7–9.
- Produces: Essay Feedback queue/workspace and Overall Evaluation queue/workspace.
- Produces: `validateEvaluationDraft(draft): ValidationIssue[]`.

- [ ] **Step 1: Add failing review UI tests**

Assert:

- essay queue groups unanswered items by assignment and shows prompt/answer without a score input;
- saving feedback updates reviewed count and eligibility;
- overall evaluation remains disabled until all essay feedback exists;
- multiple-choice-only assignment is immediately eligible;
- evaluation form requires completion level, strengths, improvements, comment, and one of three conclusions;
- Vietnamese conclusion labels are `Đạt`, `Không đạt`, and `Làm lại`;
- publishing `Làm lại` shows the new attempt availability.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-admin-ui.spec.ts`

Expected: FAIL on the new review UI assertions.

- [ ] **Step 3: Implement feedback and evaluation workspaces**

Add unsaved-change guards, explicit publish confirmation, server validation errors beside fields, and refresh queue counts after success.

- [ ] **Step 4: Run Admin UI, type, and build checks**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-admin-ui.spec.ts tests\onboarding-reviews.spec.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit Task 11**

```bash
git add src/ui/onboarding/reviews.tsx src/ui/onboarding/api.ts src/ui/onboarding/AppShell.tsx src/ui/onboarding/styles.css tests/onboarding-admin-ui.spec.ts
git commit -m "feat: add onboarding review workspace"
```

### Task 12: Learner Dashboard, Learning Workspace, and Results

**Files:**
- Create: `src/ui/onboarding/learner-dashboard.tsx`
- Create: `src/ui/onboarding/learning-workspace.tsx`
- Create: `src/ui/onboarding/results.tsx`
- Create: `tests/onboarding-learner-ui.spec.ts`
- Modify: `src/ui/onboarding/api.ts`
- Modify: `src/ui/onboarding/AppShell.tsx`
- Modify: `src/ui/onboarding/styles.css`

**Interfaces:**
- Consumes: Learner DTOs, Task 9 recovery-draft decision, Files preview metadata, and Learner API methods.
- Produces: Learner overview, assignment list, gated learning/exercise workspace, and published results/feedback screens.
- Produces: `buildSubmission(assignment, draft, operationId): SubmitAttemptInput`.

- [ ] **Step 1: Write failing Learner UI/model tests**

Cover:

- unassigned member sees only the dedicated empty state;
- Continue learning chooses the earliest due active assignment/current module;
- exercise remains locked until every required resource reports opened and completed;
- opening a broken file exposes retry/download messaging but never clears completion state;
- validation identifies unanswered required questions;
- submit uses one stable operation ID across retry of the same answer payload;
- results show numeric score only when multiple-choice questions exist;
- essay feedback and overall evaluation render only when published;
- all three conclusions render exact labels and `Làm lại` exposes the new attempt CTA.

- [ ] **Step 2: Run Learner UI tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-learner-ui.spec.ts`

Expected: FAIL because Learner screens/models do not exist.

- [ ] **Step 3: Implement dashboard and learning workspace**

Use a vertical stepper on wide screens and compact step list on narrow screens. Mark a resource opened when its viewer succeeds; require explicit completion click. Save server drafts after field changes with debounce and mirror them to host storage for recovery.

- [ ] **Step 4: Implement submission and results**

Confirm before submission, lock submitted answers, show automatic multiple-choice results, and keep the assignment in waiting state until the Admin publishes the overall evaluation.

- [ ] **Step 5: Run Learner UI, type, and build checks**

Run: `node_modules\.bin\vitest.cmd run tests\onboarding-learner-ui.spec.ts tests\onboarding-ui-model.spec.ts tests\onboarding-attempts.spec.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit Task 12**

```bash
git add src/ui/onboarding/learner-dashboard.tsx src/ui/onboarding/learning-workspace.tsx src/ui/onboarding/results.tsx src/ui/onboarding/api.ts src/ui/onboarding/AppShell.tsx src/ui/onboarding/styles.css tests/onboarding-learner-ui.spec.ts
git commit -m "feat: add onboarding learner experience"
```

### Task 13: Demo Removal, Product Metadata, Documentation, and Full Verification

**Files:**
- Verify: `src/ui/` contains only the newly built onboarding interface from Tasks 9–12; no legacy UI file or asset may remain.
- Delete: demo backend handlers, demo helpers, and their tests after confirming no onboarding import references them.
- Modify: `README.md`
- Modify: `docs/app-overview.md`
- Modify: `PUBLISHING.md`
- Modify: `PRIVACY.md`
- Modify: `TERMS.md`
- Modify: `CHANGELOG.md`
- Modify: `launch-kit/listing.md`
- Modify: `launch-kit/demo-storyboard.md`
- Modify: `privos-app.json`
- Modify: `package.json`
- Modify: relevant retained tests under `tests/`

**Interfaces:**
- Consumes: the complete backend and UI from Tasks 1–12.
- Produces: one coherent onboarding product with no reachable demo feature or stale marketplace claim.

- [ ] **Step 1: Add/adjust failing metadata and no-demo assertions**

Update manifest/MCP/UI-shell tests to require onboarding names, tools, permissions, resource URIs, page title, and built-in template descriptions. Add an assertion that built UI and manifest do not contain demo navigation labels or removed demo tool names.

- [ ] **Step 2: Run targeted metadata tests and verify failure**

Run: `node_modules\.bin\vitest.cmd run tests\manifest.spec.ts tests\mcp.spec.ts tests\ui-shell.spec.ts tests\scope-audit.spec.ts tests\packaging.spec.ts`

Expected: FAIL while stale demo files/metadata remain.

- [ ] **Step 3: Remove unreachable demo code and update product documentation**

Use `rg` before each deletion to prove no onboarding file imports the target. Preserve runtime, relay, pairing, bundle serving, theme provider, REST helper, caller binding, and generic App Platform transport modules. Update docs and marketplace copy to match actual MVP behavior and data handling.

- [ ] **Step 4: Run the complete verification suite**

Run: `npm run typecheck:strict-unused`

Run: `npm test`

Run: `npm run build`

Run: `npm run preflight`

Expected: every command exits 0; no sourcemaps or unhashed UI assets are emitted.

- [ ] **Step 5: Inspect final diff and workspace state**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff --stat 6b2a7c7..HEAD`

Expected: no whitespace errors, only intended onboarding/product changes, and the user's pre-existing uncommitted files remain distinguishable if they were not incorporated into an approved task commit.

- [ ] **Step 6: Commit Task 13**

Stage only the reviewed product files. Update-only staging for `src` and `tests` prevents unrelated untracked files such as the existing `tests/compose.spec.ts` from entering this commit.

```bash
git add README.md docs/app-overview.md PUBLISHING.md PRIVACY.md TERMS.md CHANGELOG.md launch-kit/listing.md launch-kit/demo-storyboard.md privos-app.json package.json package-lock.json
git add -u -- src tests
git commit -m "chore: complete onboarding product migration"
```

---

## Final Manual Checks on a Real PrivOS Room

These require a live Hub and cannot be proven by the local automated suite:

- Owner/moderator sees Admin navigation; leader/member sees Learner navigation.
- Admin can select only current-room members and upload a real room file.
- A second account cannot read the first learner's assignment by changing UI state or request arguments.
- Built-in templates remain available and locked after reload/upgrade.
- Notifications arrive when the optional scope is granted and degrade to a warning when it is not.
- PDF/image/text resources preview through the Hub without cross-origin failures.
- Light/dark theme changes propagate live, and narrow iframe layout remains usable.
- Reduced-motion preference removes decorative movement.
