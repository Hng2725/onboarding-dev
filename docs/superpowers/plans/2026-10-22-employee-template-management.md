# Employee Template Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Nhân sự tab manage one persistent employee profile per room member and let each profile own multiple onboarding assignments.

**Architecture:** Add a room-scoped employee collection and service, reconcile legacy assignments into employee profiles, and make assignment creation depend on that service. Build a pure UI row-model layer that groups assignments by employee, then replace the assignment-first page with add-employee, employee-detail, and employee-scoped assignment views.

**Tech Stack:** TypeScript, React 18, Vitest, PrivOS MCP app database/tools, Vite, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-22-employee-template-management-design.md`

## Global Constraints

- Preserve all existing assignment, progress, attempt, answer, feedback, and evaluation records.
- An employee profile has one immutable `normal` or `advanced` classification in this scope.
- A room member may have only one employee profile per room.
- A member may receive multiple templates, but not the same `templateId + templateVersion` twice.
- Do not add employee deletion or reclassification.
- Keep dashboard and learner behavior assignment-based.
- Keep user-facing copy in Vietnamese and follow the existing visual system.
- Do not commit or push automatically; use diff checkpoints because `CLAUDE.md` reserves Git history changes for explicit user requests.

## Review Focus

- Legacy assignments with mixed classifications: `tests/onboarding-employees.spec.ts` must prove the newest `assignedAt` determines the migrated profile classification.
- Legacy member missing from the current room directory: `tests/onboarding-employees.spec.ts` must prove reconciliation keeps a profile and the UI can fall back to `memberId`.
- Concurrent employee insertion returning Mongo `E11000`: `tests/onboarding-employees.spec.ts` must prove it becomes `EMPLOYEE_ALREADY_EXISTS` without leaking the database error.
- Exact template-version duplicate versus a newer version: `tests/onboarding-assignments.spec.ts` must block the former and allow the latter.
- Employee with zero assignments: `tests/onboarding-admin-ui.spec.ts` and `tests/onboarding-eager-tabs.spec.ts` must prove 0%/empty-state rendering and access to the assignment action.

---

### Task 1: Persistent employee profiles and legacy reconciliation

**Files:**
- Create: `src/onboarding/employees.ts`
- Create: `tests/onboarding-employees.spec.ts`
- Modify: `src/onboarding/contracts.ts`
- Modify: `src/onboarding/schema.ts`
- Modify: `tests/onboarding-store.spec.ts`

**Interfaces:**
- Produces: `EmployeeRecord` in `contracts.ts` with `id`, `roomId`, `memberId`, `employeeType`, `addedBy`, `addedAt`, `createdAt`, and `updatedAt`.
- Produces: `AddEmployeeInput { memberId: string; employeeType: EmployeeType }`.
- Produces: `EmployeeService.list(actor): Promise<readonly EmployeeRecord[]>`.
- Produces: `EmployeeService.getByMemberId(actor, memberId): Promise<EmployeeRecord>`; this reconciles a missing legacy profile before returning or throwing.
- Produces: `EmployeeService.add(actor, input): Promise<EmployeeRecord>`.
- Produces: `createEmployeeService(store, options?: EmployeeServiceOptions): EmployeeService`, where options support the existing `AppPlatformToolCaller` and deterministic `now` for tests.
- Depends on: `OnboardingStore`, `OnboardingActor`, and `mcpapp.rooms.getMembers` using the verified room.

- [ ] **Step 1: Write failing schema and service tests**

  Add tests named:

  - `adds one current-room member with an immutable classification`
  - `rejects outsiders, non-admin callers, and duplicate members with typed errors`
  - `maps an E11000 create race to EMPLOYEE_ALREADY_EXISTS`
  - `reconciles legacy assignments once and uses the newest assignment classification`
  - `keeps a reconciled profile when the legacy member is no longer in the room directory`
  - `defines onboarding_employees with a room-scoped unique memberId index`

  Assert that two calls to `list` produce one profile per `memberId`, never mutate legacy rows, and choose the greatest `assignedAt` when old classifications conflict.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `npm test -- --run tests/onboarding-employees.spec.ts tests/onboarding-store.spec.ts`

  Expected: FAIL because `src/onboarding/employees.ts`, `EmployeeRecord`, and `onboarding_employees` do not exist.

- [ ] **Step 3: Implement the employee schema and service**

  Add `onboarding_employees` fields and `employees_member_unique` to `ONBOARDING_COLLECTIONS`. Implement normalized room-member detection, admin authorization, classification validation, pre-create duplicate checking, `E11000` translation, and idempotent reconciliation from `onboarding_assignments`. Sort legacy assignments by `assignedAt` descending before choosing migration metadata.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run: `npm test -- --run tests/onboarding-employees.spec.ts tests/onboarding-store.spec.ts`

  Expected: PASS.

- [ ] **Step 5: Review the Task 1 diff checkpoint without committing**

  Run: `git diff --check -- src/onboarding/contracts.ts src/onboarding/schema.ts src/onboarding/employees.ts tests/onboarding-employees.spec.ts tests/onboarding-store.spec.ts`

  Expected: exit code 0.

### Task 2: Employee-aware assignment rules and MCP actions

**Files:**
- Modify: `src/onboarding/assignments.ts`
- Modify: `src/onboarding/tools.ts`
- Modify: `tests/onboarding-assignments.spec.ts`
- Modify: `tests/onboarding-tools.spec.ts`
- Modify: `tests/caller-room-binding.spec.ts`
- Modify: `tests/onboarding-attempts.spec.ts`
- Modify: `tests/onboarding-reviews.spec.ts`

**Interfaces:**
- Consumes: `EmployeeService.getByMemberId(actor, memberId)` and `EmployeeService.add(actor, input)` from Task 1.
- Changes: `AssignMemberInput` becomes `{ memberId: string; templateId: string; templateVersion: number; dueAt?: string }`; `employeeType` is derived from the profile.
- Produces: assignment errors `EMPLOYEE_NOT_FOUND` and `ASSIGNMENT_ALREADY_EXISTS` in addition to existing typed errors.
- Changes: `OnboardingServiceBundle` gains `employees: EmployeeService`.
- Produces: `onboarding_admin_assignments` actions `list_employees` and `add_employee`.

- [ ] **Step 1: Write failing assignment-policy and dispatcher tests**

  Add tests proving:

  - `assign` rejects a member with no employee profile.
  - Employee classification is copied to the assignment and a mismatched template is rejected.
  - Two different template identities can be assigned to one employee.
  - The same template and version is rejected with `ASSIGNMENT_ALREADY_EXISTS`.
  - A later version of the same template ID is allowed.
  - `list_employees` and `add_employee` call the employee service with the verified admin actor.
  - Learners cannot invoke the new admin actions.

  Update shared test setups to create an employee profile before their first assignment rather than weakening production validation.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `npm test -- --run tests/onboarding-assignments.spec.ts tests/onboarding-tools.spec.ts tests/caller-room-binding.spec.ts tests/onboarding-attempts.spec.ts tests/onboarding-reviews.spec.ts`

  Expected: FAIL because the bundle has no employee service, the actions are unsupported, and assignment creation does not enforce employee identity or duplicate template versions.

- [ ] **Step 3: Wire the employee service and enforce assignment rules**

  Instantiate one employee service per default service bundle, inject it into the assignment service, remove `employeeType` from assignment tool input, query exact `memberId/templateId/templateVersion` duplicates before create, and preserve notification/audit best-effort behavior. Extend all test bundle fakes with the exact `EmployeeService` methods.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run: `npm test -- --run tests/onboarding-assignments.spec.ts tests/onboarding-tools.spec.ts tests/caller-room-binding.spec.ts tests/onboarding-attempts.spec.ts tests/onboarding-reviews.spec.ts`

  Expected: PASS.

- [ ] **Step 5: Review the Task 2 diff checkpoint without committing**

  Run: `git diff --check -- src/onboarding/assignments.ts src/onboarding/tools.ts tests/onboarding-assignments.spec.ts tests/onboarding-tools.spec.ts tests/caller-room-binding.spec.ts tests/onboarding-attempts.spec.ts tests/onboarding-reviews.spec.ts`

  Expected: exit code 0.

### Task 3: Employee list row model and filtering

**Files:**
- Create: `src/ui/onboarding/employee-model.ts`
- Modify: `tests/onboarding-admin-ui.spec.ts`

**Interfaces:**
- Consumes: `EmployeeRecord`, existing `AssignmentRow`, `MemberRow`, and `TemplateRow`.
- Produces: `EmployeeAttentionStatus = 'needs_essay_feedback' | 'needs_evaluation' | 'failed' | 'overdue' | 'active' | 'completed' | 'not_started'`.
- Produces: `EmployeeListRow` with `employee`, optional `member`, `assignments`, `templateCount`, `averageProgress`, `attentionStatus`, and `updatedAt`.
- Produces: `buildEmployeeRows(employees, assignments, members, now): readonly EmployeeListRow[]`.
- Produces: `filterEmployeeRows(rows, query, employeeType): readonly EmployeeListRow[]`.
- Produces: `availableRoomMembers(members, employees): readonly MemberRow[]`.
- Produces: `assignableTemplates(templates, employee, assignments): readonly TemplateRow[]`.

- [ ] **Step 1: Write failing pure-model tests**

  Add tests named:

  - `groups multiple assignments into one employee row`
  - `keeps an employee with zero assignments at zero percent and not started`
  - `searches employee identity and combines it with classification filtering`
  - `excludes existing employees from the add-member choices`
  - `offers only published matching templates not already assigned at the exact version`
  - `keeps a newer version of an already assigned template available`

  Assert average progress is rounded, `updatedAt` falls back to `addedAt`, and a missing member directory entry uses `memberId` for search/display fallback.

- [ ] **Step 2: Run the UI model test and verify RED**

  Run: `npm test -- --run tests/onboarding-admin-ui.spec.ts`

  Expected: FAIL because `employee-model.ts` and the new functions do not exist.

- [ ] **Step 3: Implement the pure employee row model**

  Group in one pass by `memberId`, calculate average progress from every assignment, derive attention status with the spec priority, and keep all functions independent of React and APIs. Sort rows by `updatedAt` descending with `memberId` as the stable tie-breaker.

- [ ] **Step 4: Run the UI model test and verify GREEN**

  Run: `npm test -- --run tests/onboarding-admin-ui.spec.ts`

  Expected: PASS.

- [ ] **Step 5: Review the Task 3 diff checkpoint without committing**

  Run: `git diff --check -- src/ui/onboarding/employee-model.ts tests/onboarding-admin-ui.spec.ts`

  Expected: exit code 0.

### Task 4: Employee-first page, add dialog, and assignment detail flow

**Files:**
- Modify: `src/ui/onboarding/employees.tsx`
- Modify: `src/ui/onboarding/styles.css`
- Modify: `tests/onboarding-eager-tabs.spec.ts`
- Modify: `tests/onboarding-admin-ui.spec.ts`

**Interfaces:**
- Consumes: every selector and row type from `employee-model.ts`.
- Produces: `AddEmployeeDraft { memberId: string; employeeType: EmployeeType }` and `validateAddEmployeeDraft`.
- Produces: `AddEmployeeDialog` with available room members, classification control, loading button, and Vietnamese validation/error copy.
- Changes: `EmployeeDetailDialog` consumes one `EmployeeListRow`, renders all child assignments, and exposes `onAssign`.
- Changes: `AssignmentDialog` receives a fixed employee profile, omits member/classification controls, and receives only matching unassigned published templates.
- Changes: `EmployeesPage` modal mode is `'detail' | 'assign'`; successful assignment refreshes data and returns to `'detail'` for the same employee.

- [ ] **Step 1: Write failing dialog and page-contract tests**

  Add static rendering/model tests proving:

  - Header and primary action say `Thêm nhân sự`, never `Gán onboarding` outside employee detail.
  - Add dialog renders only non-employee room members and changes its button to a disabled loading icon while saving.
  - Each employee renders one table row with count and aggregate progress.
  - Detail dialog lists two independently tracked assignments and has one `Gán onboarding` button.
  - Zero-assignment detail displays the empty state and still has the assignment action.
  - Assignment form contains the fixed employee identity/classification, no member selector, and only allowed templates.
  - Successful add closes/reset the add dialog; successful assignment returns to detail for the same employee.

- [ ] **Step 2: Run the UI tests and verify RED**

  Run: `npm test -- --run tests/onboarding-admin-ui.spec.ts tests/onboarding-eager-tabs.spec.ts`

  Expected: FAIL because the page is still assignment-first and the new dialogs/contracts are absent.

- [ ] **Step 3: Implement the employee-first React flow**

  Load `list_employees`, assignment `list`, and template `list` as required data, while settling `list_members` independently so directory failure falls back to member IDs. Replace assignment rows with employee rows, keep the search/filter controls side by side, and change count/empty copy to employees. Implement add, detail, and in-place assignment modes with Escape/backdrop/keyboard behavior and preserve query/filter state. Render `EmployeeAttentionStatus` with a dedicated employee-level badge rather than passing it to the assignment-only `StatusBadge`.

- [ ] **Step 4: Implement focused styling**

  Reuse current dialog, toolbar, chip, progress, and table tokens. Add compact assignment cards/table inside employee detail, an action-aligned profile header, responsive one-column detail rows, and visible hover/focus states without changing other tabs.

- [ ] **Step 5: Run UI tests and verify GREEN**

  Run: `npm test -- --run tests/onboarding-admin-ui.spec.ts tests/onboarding-eager-tabs.spec.ts`

  Expected: PASS.

- [ ] **Step 6: Review the Task 4 diff checkpoint without committing**

  Run: `git diff --check -- src/ui/onboarding/employees.tsx src/ui/onboarding/employee-model.ts src/ui/onboarding/styles.css tests/onboarding-admin-ui.spec.ts tests/onboarding-eager-tabs.spec.ts`

  Expected: exit code 0.

### Task 5: Regression verification, app-dev rebuild, and Chrome acceptance test

**Files:**
- Verify only; modify implementation/tests only if a failing check exposes a defect covered by the spec.

**Interfaces:**
- Consumes: the complete backend and UI behavior from Tasks 1–4.
- Produces: a healthy rebuilt `onboarding-dev-app-1` container and verified behavior at the existing PrivOS dev URL.

- [ ] **Step 1: Run all feature-relevant tests together**

  Run: `npm test -- --run tests/onboarding-employees.spec.ts tests/onboarding-assignments.spec.ts tests/onboarding-tools.spec.ts tests/onboarding-store.spec.ts tests/onboarding-admin-ui.spec.ts tests/onboarding-eager-tabs.spec.ts tests/onboarding-attempts.spec.ts tests/onboarding-reviews.spec.ts`

  Expected: PASS.

- [ ] **Step 2: Run the full suite**

  Run: `npm test`

  Expected: all application tests pass. If `tests/packaging.spec.ts` still exits 127 because its Unix packaging script is unavailable on Windows, record that exact pre-existing environment failure and run `npm test -- --exclude tests/packaging.spec.ts` to prove the remaining suite passes.

- [ ] **Step 3: Run static and production checks**

  Run: `npm run typecheck:strict-unused`

  Run: `npm run build`

  Expected: both exit code 0 and the PrivOS manifest remains valid.

- [ ] **Step 4: Rebuild the dev app container**

  Run: `docker compose up -d --build app`

  Run: `docker compose ps`

  Expected: `onboarding-dev-app-1` is `healthy` on port 3000.

- [ ] **Step 5: Test the deployed UI in Chrome**

  Reload with cache disabled:

  `https://roxane-dev.privos.io/group/test-apps-6dps39/mcpapp/6ad87c38fbc62e6c0f76918d`

  Verify:

  - Existing assignments appear grouped under one row per migrated employee.
  - Search and the adjacent `Thông thường / Chuyên sâu` filter use employee counts.
  - `Thêm nhân sự` excludes existing profiles and successfully adds an unused room member once.
  - Clicking/pressing Enter on a row opens detail and shows every assignment or the zero-assignment empty state.
  - `Gán onboarding` exists only inside detail, filters by profile classification, and adds a second distinct template when available.
  - The exact assigned template/version no longer appears as an option.
  - Escape, backdrop, loading states, success notices, and responsive layout behave correctly.

- [ ] **Step 6: Final diff and status review**

  Run: `git diff --check`

  Run: `git status --short`

  Expected: no whitespace errors; report all pre-existing and task-created working-tree changes without committing or discarding user work.
