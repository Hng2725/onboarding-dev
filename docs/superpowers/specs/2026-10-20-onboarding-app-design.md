# PrivOS Onboarding App — Design Specification

**Date:** 2026-10-20  
**Status:** Design approved in conversation; written specification awaiting final user review  
**Target:** `ai.privos.mcp-app-onboarding-dev`

## 1. Purpose

Build a room-scoped PrivOS MCP app that serves two goals:

1. Teach assigned employees how to use PrivOS through protected, built-in learning templates.
2. Let room owners and room administrators create company-specific onboarding templates, assign them to selected room members, monitor progress, review responses, and publish final evaluations.

The first release is a working MVP, not a static mockup. It persists real data through PrivOS App Database, stores learning resources in PrivOS Files, resolves people and roles from the current PrivOS room, and inherits the workspace theme.

## 2. Product Principles

- **Guided before tested:** required materials must be completed before the related exercise unlocks.
- **One clear next action:** both dashboards prioritize the most urgent next step.
- **Room-native:** identities, roles, files, notifications, theme, and isolation come from PrivOS.
- **Private by default:** learners can access only their own assignments, attempts, feedback, and evaluations.
- **Stable learning history:** assignments remain pinned to the template version assigned to them.
- **Human evaluation remains central:** automatic multiple-choice scoring never replaces the administrator's final evaluation.
- **Calm enterprise motion:** animation clarifies hierarchy and state changes without distracting from work.

The visual direction borrows product patterns rather than branded styling from established onboarding products: visual progress and self-paced checklists from [BambooHR](https://www.bamboohr.com/platform/onboarding/), centralized employee state from [Rippling](https://www.rippling.com/en-GB/products/hr/hris), and role-specific journeys from [Enboarder](https://enboarder.com/about-us/). Motion follows Ant Design's natural, performant, and concise principles from [Ant Design Motion](https://ant.design/docs/spec/motion/).

## 3. Scope

### 3.1 MVP capabilities

- Role-based Admin and Learner workspaces.
- Manual employee assignment by an Admin.
- Employee classification as `normal` or `advanced` at assignment time.
- Immutable built-in PrivOS templates for both employee types.
- Room-owned custom template creation and versioning.
- PrivOS file upload and attachment while creating or editing a custom template draft.
- Ordered modules containing required/optional learning resources and exercises.
- Required-material completion gate before exercises unlock.
- Single-choice, multiple-choice, and essay questions.
- Automatic scoring for multiple-choice questions only.
- Per-answer Admin feedback for essay responses, with no numeric essay score.
- Separate overall Admin evaluation for every submitted assignment.
- Final Admin conclusion: `passed`, `failed`, or `retry`.
- Draft saving, submission, retry control, progress dashboards, and notifications.
- Responsive, theme-aware UI using free Ant Design SVG icons.

### 3.2 Explicit non-goals for the MVP

- Automatic assignment by department, title, group, or start date.
- SCORM/xAPI content import.
- Certificates, badges, leaderboards, or gamification points.
- AI-generated grading or AI-generated evaluations.
- Cross-room shared custom templates.
- Synchronizing progress into PrivOS Lists.
- Employee onboarding/offboarding paperwork or electronic signatures.
- Full offline mode. Local draft recovery is supported, but server persistence remains authoritative.

## 4. Personas and Authorization

### 4.1 Admin

An Admin is a current-room owner or administrator. The PrivOS role adapter treats room role `owner` and the platform's canonical room-administrator role (`moderator` in current context responses) as Admin. A verified workspace `admin` role is also accepted when the actor can access the current room. `leader` is explicitly not an Admin role for this app.

Admins can:

- View all onboarding data in the current room.
- Select room members and create assignments.
- Classify assigned people as normal or advanced employees.
- Create, edit, preview, publish, version, archive, and delete eligible custom templates.
- Use or clone built-in templates.
- View learner progress and submitted answers.
- Comment on each essay answer.
- Publish an overall evaluation and final conclusion.
- Permit another attempt when the conclusion is `retry`.

### 4.2 Learner

Room leaders and ordinary members are Learners. A member has no onboarding access until an Admin explicitly assigns a template.

Learners can:

- View only their own assignments and progress.
- Open attached learning resources.
- Mark a required resource complete after opening it.
- Work on and save their own draft answers.
- Submit unlocked exercises.
- See automatic multiple-choice results after submission.
- Read per-essay feedback and the final overall evaluation when published.
- Start a new attempt only when assignment policy permits it or an Admin grants a retry.

### 4.3 Authorization boundary

Frontend role checks control presentation only. Every privileged operation is enforced in the app backend using the Hub-verified actor, current room binding, and signed role claims. The frontend must not call `mcpapp.db.*` directly for onboarding records. The backend is the policy gateway and returns sanitized DTOs.

## 5. Information Architecture

### 5.1 Shared application shell

- Product mark, current room name, compact user identity, and theme toggle in the header.
- Desktop: collapsible left navigation and a flexible content area.
- Narrow iframe/mobile: compact top navigation or drawer; no permanently fixed wide sidebar.
- Role-aware navigation generated from one route configuration.
- Loading, empty, error, and permission-degraded states use the same page frame to avoid layout jumps.

### 5.2 Admin navigation

1. **Overview**
   - KPI cards: assigned, in progress, overdue, awaiting essay feedback, awaiting overall evaluation, completed.
   - Work queue ordered by urgency.
   - Recent activity and completion trend.
2. **Employees**
   - Searchable/filterable room-member table.
   - Assignment action with employee type, template, due date, and attempt policy.
   - Employee detail: assignment timeline, material progress, attempts, scores, feedback, evaluations.
3. **Templates**
   - Unified catalog for immutable PrivOS templates and custom room templates.
   - Accent-insensitive name search plus a status filter for Published, Archived, and Draft templates.
   - Selecting any card opens its full detail before actions are offered.
   - Built-in templates expose Use and Clone; they never expose Edit or Delete.
   - Custom actions follow lifecycle state: Draft exposes Edit/Delete, Published exposes Use/Edit/Archive/Delete, and Archived exposes Delete only.
   - Creation wizard: Basics → Modules and resources → Questions → Rules → Preview and publish.
   - Questions are optional. An empty module shows a named suggestion, while an invalid question remains a blocking error.
4. **Essay feedback**
   - Queue of submitted assignments with unanswered essay-feedback items.
   - Focused review workspace with prompt, learner answer, comment editor, and reviewed state.
5. **Overall evaluations**
   - Queue of every submitted assignment eligible for final evaluation.
   - Summary of progress, multiple-choice score when present, essay feedback completion, attempt history, and evaluation form.

### 5.3 Learner navigation

1. **My overview**
   - Overall progress, Continue learning action, active assignments, due dates, awaiting feedback/evaluation, and latest results.
2. **My learning**
   - Assignment cards grouped by active, awaiting evaluation, and completed.
3. **Learning workspace**
   - Module stepper with locked, available, current, and completed states.
   - Resource reader with required/optional badges and explicit completion action.
   - Exercise workspace, draft status, validation summary, and submission confirmation.
4. **Results and feedback**
   - Multiple-choice score where applicable.
   - Per-question essay comments.
   - Overall Admin evaluation and final conclusion.

Unassigned Learners see a friendly, non-error empty state: “Bạn chưa có chương trình onboarding”, with the current room name and no access to template content.

## 6. Learning Model

### 6.1 Template types

#### Built-in system templates

Built-in templates are versioned source assets shipped with the application. All historical versions referenced by active or completed assignments remain available.

- `privos-foundations@1`: account basics, room collaboration, messages, Files, Lists, Notifications, and MCP Apps.
- `privos-advanced@1`: Sandbox, Bots, AI workflows, application permissions, room isolation, and advanced PrivOS operating practices.

Their source material is based on the official [PrivOS documentation](https://docs.privos.ai/). They are immutable and cannot be edited, archived, or deleted through the app. An Admin can assign a built-in version directly or clone it into a custom room template.

#### Custom room templates

Custom templates are stored in room-scoped App Database collections. A template starts as a draft. Publishing creates an immutable version snapshot. Editing published content creates a new draft version; existing assignments stay pinned to their original version.

A custom template can be deleted in Draft, Published, or Archived state only when no assignment references it. Published templates may also be archived; archived templates cannot be assigned or edited. Built-in templates are never deletable. Soft-deleted database records are not exposed in ordinary queries.

### 6.2 Module sequencing

Each template contains one or more ordered modules. A module contains resources followed by an optional exercise.

1. The learner opens the current module.
2. Every required resource must be opened at least once.
3. The learner explicitly selects “Đánh dấu đã hoàn tất” for each required resource.
4. The module exercise unlocks after every required resource is complete.
5. If the module has no exercise, completing its required resources completes the module.
6. Completing the current module unlocks the next module.

Scrolling percentage, dwell time, and browser focus are not used as evidence of reading because they are unreliable across PDFs, videos, and external links.

### 6.3 Questions and scoring

- `single_choice`: one correct option; automatically scored.
- `multiple_choice`: one or more correct options; automatically scored using exact-set matching in the MVP.
- `essay`: free text; never receives a numeric score.

If an exercise contains multiple-choice questions, its numeric percentage is calculated only from those questions. If it contains only essays, no score or pass threshold is displayed.

Correct answers, scoring keys, and unpublished evaluation data are never included in Learner-facing DTOs. After submission, the learner receives their selection, correctness state, explanation when configured for release, and aggregate score.

### 6.4 Feedback and final evaluation

Scoring, essay feedback, and overall evaluation are separate concepts:

- Multiple-choice scoring occurs automatically at submission.
- Every essay answer requires an Admin comment and a reviewed marker.
- Every submitted assignment requires one overall Admin evaluation, including assignments containing only multiple-choice questions.
- An assignment containing essays becomes eligible for overall evaluation only after every essay answer has feedback.
- The overall evaluation contains completion level, strengths, improvement areas, public comments, and exactly one conclusion: `passed`, `failed`, or `retry`.
- `retry` opens another attempt and returns the assignment to active status.
- `passed` and `failed` finalize the assignment. An Admin may explicitly reopen a finalized assignment, creating an audited retry action.

## 7. State Models

### 7.1 Assignment status

```text
assigned
  → in_progress
  → submitted
  → awaiting_essay_feedback (only when essays exist)
  → awaiting_evaluation
  → passed | failed | retry

retry → in_progress (new attempt)
```

The UI may group `passed` and `failed` as completed while preserving the distinct conclusion.

### 7.2 Attempt status

```text
draft → submitted → auto_scored → reviewed
```

- `auto_scored` means multiple-choice scoring has finished or the exercise has no scored questions.
- `reviewed` means all required essay feedback and the overall evaluation have been published.
- Submission is idempotent; repeated calls with the same operation ID return the same submitted attempt.

### 7.3 Template status

```text
draft → published → archived
```

Publishing creates a new immutable version. Built-in versions are always published and locked.

Archived custom templates are terminal for assignment and editing, but an unassigned archived record can still be deleted.

## 8. Data Architecture

### 8.1 Source of truth

- Built-in template catalog: versioned TypeScript/JSON assets in the app source.
- Custom template and operational data: room-scoped PrivOS App Database collections.
- Uploaded resources: PrivOS Files, referenced by stable file ID plus display metadata.
- Browser storage: recovery cache for unsynchronized drafts only; never the authoritative record.

### 8.2 Room-scoped collections

| Collection | Main fields |
|---|---|
| `onboarding_templates` | title, description, employeeType, status, version, passingScore, maxAttempts, createdBy, publishedAt |
| `onboarding_modules` | templateId, templateVersion, title, description, order |
| `onboarding_resources` | moduleId, kind, title, fileId/url, required, order |
| `onboarding_questions` | moduleId, type, prompt, options, correctOptionIds, explanation, required, order |
| `onboarding_assignments` | memberId, employeeType, templateSource, templateId, templateVersion, dueAt, status, attemptLimit, assignedBy |
| `onboarding_material_progress` | assignmentId, moduleId, resourceId, openedAt, completedAt, memberId |
| `onboarding_attempts` | assignmentId, memberId, ordinal, status, operationId, mcScore, submittedAt |
| `onboarding_answers` | attemptId, questionId, selectedOptionIds, essayText, submittedAt |
| `onboarding_essay_feedback` | attemptId, answerId, comment, reviewedBy, reviewedAt |
| `onboarding_evaluations` | assignmentId, attemptId, completionLevel, strengths, improvements, comment, conclusion, evaluatedBy, evaluatedAt |
| `onboarding_audit_events` | actorId, action, targetType, targetId, metadata, occurredAt |

Indexes support member dashboards, status queues, template/module ordering, unique material progress, unique attempt operation IDs, and one published evaluation per attempt.

### 8.3 Data transfer objects

The backend exposes separate DTOs rather than returning database records:

- `AdminTemplateDetail` may contain answer keys.
- `LearnerTemplateDetail` never contains answer keys or private audit fields.
- `AdminAssignmentDetail` contains learner identity, answers, progress, and review state.
- `LearnerAssignmentDetail` is actor-bound and contains only the current learner's record.
- Public evaluation DTOs contain published feedback only.

## 9. Backend Modules and Tool Surface

### 9.1 Backend modules

- `onboarding-auth`: verified actor, room binding, and role normalization.
- `onboarding-db`: collection registration and typed App Database gateway.
- `onboarding-templates`: system catalog, custom drafts, cloning, version publishing.
- `onboarding-assignments`: member assignment, progress, retry, deadlines.
- `onboarding-attempts`: draft answers, submission, idempotent auto-scoring.
- `onboarding-reviews`: essay feedback and overall evaluations.
- `onboarding-files`: PrivOS file metadata and upload/link validation.
- `onboarding-notifications`: best-effort assignment, due, retry, and result notices.

### 9.2 App tool groups

The UI calls app-owned backend tools through the PrivOS bridge. Tools are split by intent so authorization and tests remain explicit:

- Bootstrap and dashboard reads.
- Admin template commands and queries.
- Admin assignment commands and queries.
- Admin feedback/evaluation commands and queues.
- Learner assignment and progress queries.
- Learner material completion, draft save, and submission commands.

Every command derives `roomId` and actor identity from verified dispatch context. User-supplied room or member IDs are treated as selectors, never proof of authority.

## 10. PrivOS Integration

- `mcpapp.context.get` / `usePrivosContext`: current room, user, roles, theme, and effective scopes.
- `mcpapp.users.*` or permitted REST equivalents: room-member search and display profiles.
- `mcpapp.db.*`: app-owned schema registration, CRUD, query, and aggregation through the backend gateway.
- PrivOS Files APIs: upload, list, preview, and stable file references.
- `mcpapp.notifications.create`: best-effort member notifications.
- Host theme tokens: all colors, borders, typography, and radii map to `--base-*` variables with safe fallbacks.

Required capability/scopes for the finished app are minimized to context and verified roles, users read, App Database read/write/schema read/schema write, and Files read/write. Notifications remain optional with visible degraded behavior. Demo-only AI, Sandbox, Lists, custom-permission, object-store, and unrelated tools/scopes are removed from the production onboarding manifest unless a retained platform requirement needs them.

## 11. Visual Design and Motion

### 11.1 Visual language

- Clean enterprise workspace with generous whitespace and clear hierarchy.
- One accent color inherited from PrivOS; semantic success, warning, and danger colors remain tokenized.
- Cards are used for summaries and learning assignments, while dense Admin data uses tables.
- Progress is shown consistently as percentage, completed/total count, and semantic state.
- Status never depends on color alone; every state includes text and an icon.
- Vietnamese is the default product language for the MVP, with strings centralized for later localization.

### 11.2 Icons

- Use the free `@ant-design/icons` package, importing individual SVG React components for tree-shaking.
- Icons accompany text for navigation and important actions; unfamiliar icon-only buttons require accessible labels and tooltips.
- Icon style, size, and stroke treatment remain consistent, following [Ant Design icon principles](https://ant.design/docs/spec/icon/).
- The full Ant Design component library is not required solely for icons; custom components preserve PrivOS theme inheritance and a smaller UI bundle.

### 11.3 Motion

- Page and panel transitions: opacity plus 4–8 px transform, 160–220 ms.
- List/card entrance: small stagger capped at five items; no long cascade.
- Progress changes: 200–300 ms interpolation.
- Button/loading feedback: immediate state change; no artificial delay.
- Modals/drawers: opacity and transform only; avoid animating layout-heavy properties.
- `prefers-reduced-motion: reduce` disables non-essential movement and shortens required feedback transitions.
- No celebratory animation blocks access to results or evaluation.

## 12. Error Handling and Resilience

- Missing room context: explain that the app must be opened inside a room.
- Missing required permission: show the affected feature and the exact permission an Admin must enable.
- Unassigned learner: show the designed empty state, not an authorization error.
- Failed file preview: preserve completion state and offer retry/download when available.
- Network failure while editing: retain the current local recovery draft and show synchronization state.
- Version conflict: reject stale Admin edits and offer reload; never silently overwrite a published version.
- Duplicate submission: return the existing attempt by operation ID.
- Notification failure: record the core action as successful and surface a non-blocking warning.
- Database schema bootstrap failure: fail closed with a recoverable setup error; do not render misleading empty dashboards.

### 12.1 Live data synchronization

- All Admin and Learner route panels mount when the workspace opens so their initial data is ready before tab navigation.
- A shared poller refreshes mounted data views every 2 seconds. It runs immediately, never overlaps requests, and schedules the next interval only after the current request settles.
- Polling pauses while the document is hidden and refreshes immediately when it becomes visible again.
- Background refresh failures retain the last successful screen and do not replace it with a loading or error page; initial-load failures remain explicit and retryable.
- Template details preload with the catalog and are cached by template ID, version, and `updatedAt`, so another user's create or edit appears without requiring the current user to open the Templates tab first.

## 13. Accessibility and Usability

- Full keyboard navigation for sidebar, stepper, forms, tables, dialogs, and question choices.
- Visible focus rings from PrivOS theme tokens.
- Semantic landmarks, headings, labels, field errors, live status regions, and descriptive button names.
- Minimum 44 px practical touch target on narrow layouts.
- Confirmation dialogs for publish, archive, deletion of an eligible custom template, submit, and final evaluation.
- Unsaved-change guard in template creation, essay feedback, and evaluation forms.
- Native select options remain readable in both light and dark themes.
- Responsive support beginning at 360 px iframe width.

## 14. Testing Strategy

### 14.1 Domain tests

- Role normalization and Admin/Learner policy.
- Module unlocking from required resource completion.
- Template version pinning and state transitions.
- Single-choice and exact-set multiple-choice scoring.
- Essay exclusion from numeric scoring.
- Essay-feedback eligibility and overall-evaluation eligibility.
- `passed`, `failed`, and `retry` conclusions.
- Attempt limits and Admin-opened retry.
- Submission idempotency.

### 14.2 Security and repository tests

- Cross-room reads/writes are rejected.
- Learner cannot select another member's assignment.
- Learner DTOs never include answer keys or unpublished feedback.
- Admin commands fail for leader/member roles even if the UI request is forged.
- Published template versions are immutable.
- Built-in templates cannot be edited or deleted.

### 14.3 UI tests

- Admin and Learner navigation states.
- Unassigned learner empty state.
- Resource completion gate and locked exercise state.
- Template builder validation and unsaved-change protection.
- Template name search, lifecycle-status filtering, detail-first actions, optional-question suggestions, and multiple-choice answer editing.
- Shared polling timing, non-overlap, visibility pause/resume, eager route mounting, and silent background refresh behavior.
- Submission, automatic score, essay feedback, and evaluation flows.
- Loading, empty, failure, degraded-permission, and retry states.
- Responsive layout, light/dark theme, keyboard flow, and reduced motion.

### 14.4 Project verification

- `npm run typecheck:strict-unused`
- `npm test`
- `npm run build`
- `npm run preflight`

## 15. Migration from the Demo Scaffold

The existing repository is a PrivOS reference/demo app whose identity has already been changed to the onboarding development app. Implementation will:

1. Preserve the user's current uncommitted identity, compose, and test changes.
2. Replace the demo tab shell with the onboarding application shell.
3. Reuse proven context, theme, REST, verified actor, App Database, notification, and file integration patterns.
4. Remove demo-only UI panels and backend tools only after equivalent onboarding paths and tests exist.
5. Update manifest title, description, tools, permissions, agent metadata, docs, tests, and marketplace assets to describe the onboarding product.

## 16. Acceptance Criteria

The MVP is accepted when:

1. A room owner/admin opens the Admin workspace; a leader/member opens the Learner workspace.
2. An Admin can assign a selected room member, classify them, choose a template/version, and set a due date.
3. An unassigned member cannot access learning content.
4. A Learner must open and explicitly complete all required resources before an exercise unlocks.
5. Multiple-choice questions are scored automatically and essays receive no numeric score.
6. Admin can publish feedback for every essay answer and a separate overall evaluation for every submission.
7. Final conclusion is exactly `Đạt`, `Không đạt`, or `Làm lại`; `Làm lại` opens another attempt.
8. Built-in PrivOS basic and advanced templates can be assigned or cloned but cannot be edited or deleted.
9. Custom templates support PrivOS file upload, versioned publishing, and safe archive/delete behavior.
10. Learners can see only their own progress, results, essay comments, and published evaluation.
11. Data remains isolated by app and room, and privileged commands are enforced server-side.
12. The interface is responsive, inherits PrivOS theme tokens, uses free Ant Design icons, and respects reduced-motion preferences.
13. Typecheck, tests, production build, and PrivOS preflight pass.
14. Every Admin and Learner tab starts loading when the app opens and reflects remote changes through non-overlapping 2-second polling.
15. The template library combines accent-insensitive name search with lifecycle-status filtering and keeps the native filter options readable in dark mode.
16. An unassigned custom template can be deleted in any lifecycle state; deletion is unavailable for built-in or assigned templates and shows a disabled loading action while in progress.
