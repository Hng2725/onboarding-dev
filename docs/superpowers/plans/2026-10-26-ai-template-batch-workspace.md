# AI Template Batch Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI onboarding template creation require an explicit Template 1, Template 2, or Both choice; support sequential dual-template review and one-action publishing; expose real AI milestones; and generate one in-app-readable PDF per module under the template's Roomfiles folder.

**Architecture:** Keep the existing one-template server job model and add a client-side batch coordinator that runs `normal` before `advanced`, stores each review independently, and resumes/retries only unfinished work. Generate reviewed lesson PDFs client-side, upload all module artifacts before publishing, upsert stable file resources into each draft, then publish/export each target while preserving partial-success state. Use authenticated Roomfiles downloads and blob URLs for an embedded PDF reader.

**Tech Stack:** Node.js 22, TypeScript, React 18, Vite 5, Vitest, PrivOS App React bridge, Roomfiles REST, `pdfmake@0.3.11`, `@types/pdfmake@0.3.3`, Docker Compose

**Spec:** `docs/superpowers/specs/2026-10-26-ai-template-batch-workspace-design.md`

## Global Constraints

- Template selection is `normal | advanced | both | null` and starts as `null`; generation is impossible until it is non-null.
- `advanced` and `both` require a non-empty job title and 2–8 non-empty responsibility lines.
- `both` always creates and reviews `normal` first, then `advanced`; it never creates a mixed template.
- AI runs remain sequential so only one Native AI attempt is active at a time.
- Progress must derive from real job calls/state; elapsed time may display but must not drive completion.
- Retry/repair attempts are details of a stable milestone and must never increase or regress the milestone total.
- Create exactly one required generated PDF resource per module after review and before publish.
- Store PDFs and the published JSON under `Onboarding-app/Created templates/<sanitized-template-title>/`.
- Read Roomfiles PDFs inside the app through authenticated bytes and a blob URL; do not open an external tab for the primary reading flow.
- A combined publish action may have partial server success; retain and display it, retry only unfinished work, and close the modal only after every target and artifact is complete.
- Preserve unrelated user changes in the dirty worktree, do not stage `.superpowers/` mockup artifacts, and do not commit or push automatically.

## Review Focus

- A title containing `/`, `\`, control characters, only punctuation, or more than the folder limit must create one safe deterministic child folder and must not escape `Created templates`; Task 5 tests every case.
- If Template 1 is complete and Template 2 generation/publish/export fails, retry must skip Template 1 and resume only the failed stage; Tasks 1 and 8 pin this behavior.
- Resource upsert changes `updatedAt`; publish must use the returned review rather than the stale pre-upload review, or it will conflict; Tasks 7 and 8 assert the returned revision is forwarded.
- A Roomfiles response for another room or another file ID must never be embedded, and every created blob URL must be revoked on replacement/unmount; Task 9 tests both failure classes.
- Verification calls appear only after questions and repair/retry calls add records dynamically; progress must keep a fixed milestone list and never decrease completed stages; Task 2 tests these call sequences.

---

### Task 1: Explicit selection and sequential template-run coordinator

**Files:**
- Create: `src/ui/onboarding/ai/ai-template-batch.ts`
- Create: `tests/onboarding-ai-template-batch.spec.ts`

**Interfaces:**
- Produces: `TemplateSelection = EmployeeType | 'both' | null`.
- Produces: `TemplateRequestErrors` with optional `selection`, `jobTitle`, and `responsibilities` messages.
- Produces: `AiTemplateRun { kind: EmployeeType; job: AiJobRecord | null; review: AdminTemplateDetail | null }`.
- Produces: `templateKindsForSelection(selection: TemplateSelection) => readonly EmployeeType[]`.
- Produces: `validateTemplateRequest(input: { selection: TemplateSelection; jobTitle: string; responsibilities: string }) => TemplateRequestErrors`.
- Produces: `templateTitleForKind(baseTitle: string, selection: TemplateSelection, kind: EmployeeType) => string | undefined`.
- Produces: `generateTemplateRuns(runs: readonly AiTemplateRun[], generateOne: (run: AiTemplateRun) => Promise<AiTemplateRun>, onUpdate?: (runs: readonly AiTemplateRun[]) => void) => Promise<readonly AiTemplateRun[]>`.

- [ ] **Step 1: Write failing selection and validation tests**

Assert that:

- `null` maps to no template kinds and returns the exact selection error `Chọn ít nhất một loại lộ trình.`;
- `normal`, `advanced`, and `both` map to `[normal]`, `[advanced]`, and `[normal, advanced]` in that order;
- normal ignores blank role fields;
- advanced/both report a missing job title and reject 0, 1, or 9 responsibilities while accepting 2 and 8;
- blank base title returns `undefined`, a single selection preserves the trimmed title, and both adds `– Template 1` / `– Template 2`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- tests/onboarding-ai-template-batch.spec.ts`

Expected: FAIL because the batch module and exports do not exist.

- [ ] **Step 3: Implement the types and pure choice helpers**

Add the declared exports in `ai-template-batch.ts`. Responsibility parsing must trim lines and discard empty lines before counting.

- [ ] **Step 4: Add failing coordinator tests**

Test `generateTemplateRuns` with a spy `generateOne` and assert:

- it awaits normal before starting advanced;
- it calls `onUpdate` after each completed run;
- a run that already has `review` is skipped;
- when advanced throws, the thrown batch error/state retains normal's completed review;
- a second call using that retained state invokes only advanced.

- [ ] **Step 5: Implement the minimal sequential coordinator**

Add an exported `AiTemplateGenerationError` carrying the latest `readonly AiTemplateRun[]`. Keep API/job creation out of this module: `generateOne(run)` owns existing start/retry/pump/load behavior.

- [ ] **Step 6: Run the completed batch tests**

Run: `npm test -- tests/onboarding-ai-template-batch.spec.ts`

Expected: PASS.

- [ ] **Step 7: Typecheck the batch contracts**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Inspect the task diff**

Run: `git diff -- src/ui/onboarding/ai/ai-template-batch.ts tests/onboarding-ai-template-batch.spec.ts`

Expected: only pure batch selection/coordinator code and focused tests.

---

### Task 2: Stable, evidence-backed AI milestone model

**Files:**
- Create: `src/ui/onboarding/ai/ai-job-milestones.tsx`
- Modify: `tests/onboarding-ai-admin-ui.spec.ts`
- Modify: `src/ui/onboarding/styles.css`

**Interfaces:**
- Consumes: `AiJobRecord` and `AiTemplateRun` from Task 1.
- Produces: `AiMilestoneStatus = 'pending' | 'active' | 'completed' | 'failed'`.
- Produces: `AiMilestone { id, label, status, detail? }`.
- Produces: `inventoryMilestones(job, sourceCount) => readonly AiMilestone[]`.
- Produces: `templateMilestones(job) => readonly AiMilestone[]`.
- Produces: `AiMilestoneProgress` React component.

- [ ] **Step 1: Write failing milestone mapping tests**

Add tests with exact milestone IDs/statuses for:

- inventory before start, during `A1`, after one of two batches, during repair, failed, and completed;
- template before start, `B-lessons`, `B-questions`, `C-lessons`, `C-questions`, `D1`, repair/retry, failed, and completed;
- fixed template milestone IDs `prepare`, `lessons`, `questions`, `verification`, `draft` regardless of how many call records exist;
- adding `D1` or `*-r1` never reduces the count of completed milestones;
- repair/retry text appears only in the active/failed milestone's `detail`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts`

Expected: FAIL because the milestone exports do not exist.

- [ ] **Step 3: Implement the milestone mapper and component**

Derive statuses only from `job.status`, root call IDs, and call statuses. Reuse `aiCallDisplayLabel` for detail copy; do not use a timer to advance stages. Render semantic ordered-list markup with current, completed, pending, and failed states plus elapsed provider text.

- [ ] **Step 4: Add milestone CSS and responsive behavior**

Add focused `.ai-milestone-*` styles: visible connectors, status icons, high-contrast active state, compact detail text, and a single-column mobile layout. Respect `prefers-reduced-motion` already present.

- [ ] **Step 5: Run the completed milestone tests**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts`

Expected: PASS.

- [ ] **Step 6: Typecheck the milestone contracts**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Inspect the task diff**

Run: `git diff -- src/ui/onboarding/ai/ai-job-milestones.tsx src/ui/onboarding/styles.css tests/onboarding-ai-admin-ui.spec.ts`

Expected: fixed milestone mapping and presentation only.

---

### Task 3: Workspace A layout, mandatory choice, dual generation, and resume

**Files:**
- Modify: `src/ui/onboarding/ai/ai-generator.tsx`
- Modify: `src/ui/onboarding/styles.css`
- Modify: `tests/onboarding-ai-admin-ui.spec.ts`
- Modify: `tests/onboarding-ai-template-batch.spec.ts`

**Interfaces:**
- Consumes: Task 1 selection/validation/coordinator APIs.
- Consumes: Task 2 `AiMilestoneProgress`, `inventoryMilestones`, and `templateMilestones`.
- Produces: per-kind resume keys `onboarding:ai:template:<roomId>:normal` and `...:advanced` while reading the legacy single-template key once for backward compatibility.
- Produces: generator state `readonly AiTemplateRun[]` instead of one `templateJob`/`review`.

- [ ] **Step 1: Add failing resume and request-building tests**

Assert that:

- two saved job IDs restore the matching owned normal/advanced jobs in order;
- a legacy template resume ID still restores its recorded `templateKind`;
- a completed normal run is preserved when advanced resumes;
- request title/role profile are correct for normal, advanced, and both;
- `start_job` is never reached when selection or role validation has errors.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-template-batch.spec.ts`

Expected: FAIL on the new resume/request assertions.

- [ ] **Step 3: Replace single-template state with ordered runs**

In `ai-generator.tsx`, initialize selection to `null`, create runs from `templateKindsForSelection`, and adapt start/retry/pump/load into the Task 1 `generateOne` callback. Persist/clear resume keys independently by kind. Do not run advanced after a normal failure.

- [ ] **Step 4: Implement explicit field validation and accessible error copy**

Render all three selection cards. For advanced/both, connect field errors with `aria-invalid` and `aria-describedby`, show the valid responsibility count, and put the selection error near the card group. The primary action remains disabled while errors exist but the reason must remain visible.

- [ ] **Step 5: Replace the vertical analysis/generation stack with Workspace A**

Use a two-column `.ai-workspace`:

- left card: selected sources/input metadata or selection/role fields and expected outputs;
- right card: Task 2 milestone component and active-template label;
- one bottom action bar containing primary action, cancel action, resume note, and cleanup status.

Collapse to one column below the existing mobile breakpoint without reverting to isolated vertically stacked action buttons.

- [ ] **Step 6: Run the completed workspace tests**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-template-batch.spec.ts`

Expected: PASS.

- [ ] **Step 7: Typecheck the workspace changes**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Inspect the task diff**

Run: `git diff -- src/ui/onboarding/ai/ai-generator.tsx src/ui/onboarding/ai/ai-template-batch.ts src/ui/onboarding/ai/ai-job-milestones.tsx src/ui/onboarding/styles.css tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-template-batch.spec.ts`

Expected: mandatory choice, sequential generation/resume, and Workspace A only; existing cancel/cleanup safety remains intact.

---

### Task 4: Sequential review navigation and compact lesson/question panes

**Files:**
- Modify: `src/ui/onboarding/ai/ai-review.tsx`
- Modify: `src/ui/onboarding/ai/ai-generator.tsx`
- Modify: `src/ui/onboarding/ai/ai-template-batch.ts`
- Modify: `src/ui/onboarding/styles.css`
- Modify: `tests/onboarding-ai-admin-ui.spec.ts`
- Modify: `tests/onboarding-ai-template-batch.spec.ts`

**Interfaces:**
- Produces: `aiReviewReadiness(review) => { allowed: boolean; blockingCount: number }` and preserves `canPublishAiReview` as a compatibility re-export.
- Produces: `reviewAdvanceState(runs, activeIndex) => { canBack, canNext, atPublishSummary, blockingCount }`.
- Extends `AiReview` props with `sequence?: { index: number; total: number; kind: EmployeeType }`.
- Produces: per-run settings state for `passingScore`, `maxAttemptsPerModule`, and `learningMode`.

- [ ] **Step 1: Write failing navigation/readiness tests**

Assert:

- Template 1 is active first for both;
- open blocking flags disable Next and report their count;
- resolved blocking flags enable Next to Template 2;
- Back returns to Template 1 without replacing either review/settings object;
- after Template 2, the next destination is the combined publish summary;
- single-template selection preserves the existing review-to-publish flow.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/onboarding-ai-template-batch.spec.ts tests/onboarding-ai-admin-ui.spec.ts`

Expected: FAIL on missing navigation helpers and sequence behavior.

- [ ] **Step 3: Implement ordered review state in the generator**

Track `activeReviewIndex`, update only the active run after edits/flag resolutions, and store settings by kind. Render `Template 1/2` and `Template 2/2`; use readiness to gate Next and preserve Back.

- [ ] **Step 4: Split module review into lesson and question tabs**

In `AiReview`, default each selected module to `Tài liệu học`; add `Câu hỏi` with counts. Keep module navigation left and make the verification panel collapsible. Never hide open blocking-flag counts when collapsed.

- [ ] **Step 5: Build the combined publish summary**

Show both template titles, employee types, module counts, question counts, lesson-block counts, settings, and blocking status. The summary exposes one primary publish action supplied by Task 8; until then it may call the existing single publish only for a one-target run.

- [ ] **Step 6: Style the review workspace**

Add compact tab, sequence badge, collapsible-panel, and combined-summary styles with keyboard-visible focus states.

- [ ] **Step 7: Run the completed review tests**

Run: `npm test -- tests/onboarding-ai-template-batch.spec.ts tests/onboarding-ai-admin-ui.spec.ts`

Expected: PASS.

- [ ] **Step 8: Typecheck the review changes**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Inspect the task diff**

Run: `git diff -- src/ui/onboarding/ai/ai-review.tsx src/ui/onboarding/ai/ai-generator.tsx src/ui/onboarding/ai/ai-template-batch.ts src/ui/onboarding/styles.css tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-template-batch.spec.ts`

Expected: ordered review and compact panes without changing lesson/question content.

---

### Task 5: Per-template Roomfiles folders and artifact paths

**Files:**
- Modify: `src/ui/onboarding/roomfiles.ts`
- Modify: `tests/onboarding-roomfiles.spec.ts`

**Interfaces:**
- Produces: `safeRoomfilesFolderName(title: string) => string`.
- Produces: `ensureTemplateRoomfilesFolder(app, roomId, templateTitle) => Promise<OnboardingRoomfileFolders & { templateFolderId: string }>`.
- Keeps: `ensureOnboardingRoomfiles` contract unchanged for source uploads.

- [ ] **Step 1: Write failing folder-name and nested-folder tests**

Assert exact behavior for:

- `Payroll / Việt Nam` becoming a readable safe name without `/` or `\`;
- control characters being removed, whitespace collapsed, a punctuation-only title falling back to `template`, and output capped at 96 characters;
- finding an existing exact child under `Created templates`;
- creating the child with `fatherId: templatesId`;
- create-race recovery by re-listing;
- two same-titled retries returning the same folder ID.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/onboarding-roomfiles.spec.ts`

Expected: FAIL because the new helpers do not exist.

- [ ] **Step 3: Implement safe naming and child-folder ensure**

Reuse the existing private `ensureFolder`; do not duplicate REST response normalization. Keep Vietnamese letters and spaces where Roomfiles permits them, replacing only path separators/control characters and enforcing the 96-character limit.

- [ ] **Step 4: Update JSON artifact destination contract tests**

Add assertions that publish callers can use `templateFolderId` for JSON uploads while source uploads still use `documentsId` and no existing root folder names change.

- [ ] **Step 5: Run the completed Roomfiles tests**

Run: `npm test -- tests/onboarding-roomfiles.spec.ts`

Expected: PASS.

- [ ] **Step 6: Typecheck the Roomfiles changes**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Inspect the task diff**

Run: `git diff -- src/ui/onboarding/roomfiles.ts tests/onboarding-roomfiles.spec.ts`

Expected: idempotent nested folder support only.

---

### Task 6: Unicode Vietnamese lesson PDF artifacts

**Files:**
- Create: `src/ui/onboarding/ai/lesson-pdf.ts`
- Create: `tests/onboarding-ai-lesson-pdf.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `LessonPdfArtifact { fileName, mimeType: 'application/pdf', blob }`.
- Produces: `lessonPdfDocumentDefinition(review, moduleId) => TDocumentDefinitions`.
- Produces: `createLessonPdfArtifact(review, moduleId, moduleIndex) => Promise<LessonPdfArtifact>`.
- Consumes: `AdminTemplateDetail`, its matching `ModuleContent`, and pdfmake's bundled Roboto VFS.

- [ ] **Step 1: Write failing document-definition tests**

Use an AI review fixture with Vietnamese text and assert that the definition contains:

- template/module title, description, objectives, and estimated minutes;
- lesson blocks and ordered steps in source order;
- source citations at the end;
- no question prompt, answer option, correct answer, or explanation;
- a stable file name `01-<module-slug>.pdf`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/onboarding-ai-lesson-pdf.spec.ts`

Expected: FAIL because the PDF module does not exist.

- [ ] **Step 3: Install the pinned runtime PDF dependency**

Run: `npm install pdfmake@0.3.11`

Expected: `package.json` and `package-lock.json` contain pinned `pdfmake@0.3.11` and no unrelated package changes.

- [ ] **Step 4: Install the pinned TypeScript declarations**

Run: `npm install --save-dev @types/pdfmake@0.3.3`

Expected: `devDependencies` contains pinned `@types/pdfmake@0.3.3` and the lockfile changes only for that package tree.

- [ ] **Step 5: Implement the pure document definition**

Map Markdown-ish block bodies to readable paragraphs/lists without executing HTML. Use Roboto, A4, stable margins, template/module headers, page numbers, and a source-reference section. Throw a typed error if module content is missing.

- [ ] **Step 6: Run the document-definition test and verify GREEN**

Run: `npm test -- tests/onboarding-ai-lesson-pdf.spec.ts`

Expected: the document-definition and file-name cases PASS; no byte-rendering case exists yet.

- [ ] **Step 7: Add the failing PDF byte smoke test**

Add assertions for MIME, non-zero Blob size, `%PDF-` header bytes, and successful Vietnamese text extraction through the repository's existing `unpdf` path.

- [ ] **Step 8: Run the byte smoke test and verify RED**

Run: `npm test -- tests/onboarding-ai-lesson-pdf.spec.ts`

Expected: FAIL because `createLessonPdfArtifact` still reports that rendering is not implemented.

- [ ] **Step 9: Implement lazy PDF rendering**

Dynamic-import `pdfmake/build/pdfmake` and `pdfmake/build/vfs_fonts` inside `createLessonPdfArtifact`, register the VFS, and return a Blob.

- [ ] **Step 10: Run the completed PDF tests**

Run: `npm test -- tests/onboarding-ai-lesson-pdf.spec.ts`

Expected: PASS.

- [ ] **Step 11: Typecheck the PDF contracts**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 12: Verify lazy bundle compatibility**

Run: `npm run build`

Expected: PASS and pdfmake emitted as a lazy chunk rather than the initial UI chunk.

- [ ] **Step 13: Inspect the task diff**

Run: `git diff -- package.json package-lock.json src/ui/onboarding/ai/lesson-pdf.ts tests/onboarding-ai-lesson-pdf.spec.ts`

Expected: pinned dependency plus lesson-only PDF implementation.

---

### Task 7: Idempotent generated-resource upsert in AI review

**Files:**
- Modify: `src/onboarding/ai/review.ts`
- Modify: `tests/ai-review.spec.ts`
- Modify: `tests/ai-onboarding-integration.spec.ts`

**Interfaces:**
- Extends `AiReviewOperation` with `{ kind: 'upsert_generated_resource'; moduleId: string; resource: TemplateResource }`.
- Resource requirements: `kind === 'file'`, `required === true`, non-empty `id`, `title`, and `fileId`.
- Produces: updated `AdminTemplateDetail` whose matching module has one resource with that stable ID.

- [ ] **Step 1: Write failing operation validation tests**

Assert rejection for an unknown module, non-file kind, missing/blank file ID, optional resource, blank ID, and blank title. Assert no mutation occurs on failure.

- [ ] **Step 2: Write failing idempotency/persistence tests**

Assert that:

- the first upsert adds one resource to the target module;
- a second upsert with the same resource ID replaces metadata/file ID without adding a duplicate;
- other module resources remain untouched;
- lesson blocks, questions, and flags remain unchanged;
- the returned detail has the new `updatedAt` and `get_review` returns the persisted resource;
- publish guard accepts the otherwise-valid AI template after resources are added.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm test -- tests/ai-review.spec.ts tests/ai-onboarding-integration.spec.ts`

Expected: FAIL because the new operation is unsupported.

- [ ] **Step 4: Implement operation validation and stable upsert**

Add the union member, handle it explicitly in `applyReviewOperations`, and leave `touchedBy` false so attaching a generated file does not reopen content-verification flags. Persist through the existing `draftFrom` / `updateAiDraft` path.

- [ ] **Step 5: Run the completed review-operation tests**

Run: `npm test -- tests/ai-review.spec.ts tests/ai-onboarding-integration.spec.ts`

Expected: PASS.

- [ ] **Step 6: Typecheck the review operation**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Inspect the task diff**

Run: `git diff -- src/onboarding/ai/review.ts tests/ai-review.spec.ts tests/ai-onboarding-integration.spec.ts`

Expected: one validated idempotent review operation with no schema or AI prompt changes.

---

### Task 8: Retryable combined resource preparation, publish, and modal completion

**Files:**
- Create: `src/ui/onboarding/ai/ai-publish-batch.ts`
- Create: `tests/onboarding-ai-publish-batch.spec.ts`
- Modify: `src/ui/onboarding/ai/ai-generator.tsx`
- Modify: `src/ui/onboarding/styles.css`
- Modify: `tests/onboarding-ai-admin-ui.spec.ts`

**Interfaces:**
- Produces: `AiPublishPhase = 'idle' | 'preparing_files' | 'prepared' | 'publishing' | 'exporting' | 'completed' | 'failed'`.
- Produces: `AiPublishTarget` with `kind`, `review`, optional `preparedReview`, optional `publishedTemplate`, `jsonExported`, `phase`, and optional `error`.
- Produces: `AiPublishBatchDependencies { prepareResources: (target: AiPublishTarget) => Promise<AdminTemplateDetail>; publish: (review: AdminTemplateDetail) => Promise<AdminTemplateDetail>; exportJson: (published: AdminTemplateDetail) => Promise<void> }`.
- Produces: `publishAiTemplateBatch(targets, dependencies, onUpdate?) => Promise<readonly AiPublishTarget[]>`.
- Produces: `AiPublishBatchError` carrying the latest target snapshots.
- Consumes: Task 4 `aiReviewReadiness`, Task 5 template folder helper, Task 6 PDF artifacts, and Task 7 resource upsert operation.

- [ ] **Step 1: Write failing coordinator-order and retry tests**

Assert that:

- readiness for every target is checked before side effects;
- resources for all targets are prepared before the first publish call;
- each publish receives `preparedReview`, never the stale original review;
- JSON export receives the returned published template;
- normal is published/exported before advanced;
- a failure preparing advanced publishes neither target;
- a failure publishing/exporting advanced retains normal's completed state;
- retry skips existing `preparedReview`, `publishedTemplate`, and `jsonExported` work as applicable;
- completion is emitted only when every target is complete.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/onboarding-ai-publish-batch.spec.ts`

Expected: FAIL because the batch publisher does not exist.

- [ ] **Step 3: Implement the pure retryable batch coordinator**

Keep Roomfiles and API details behind dependency functions. Update target snapshots before/after each awaited phase and wrap failures in `AiPublishBatchError` without discarding partial success.

- [ ] **Step 4: Add failing generator integration-helper tests**

Mock dependencies and assert `prepareResources`:

- ensures `Created templates/<title>`;
- creates/uploads one PDF per module with `duplicateAction: 'replace'`;
- normalizes each upload's canonical `fileId`;
- sends one `update_review` call containing one stable resource operation per module;
- stores JSON in the same template folder;
- reports template/module-specific progress and errors.

- [ ] **Step 5: Wire the combined publish action into the generator**

Replace the single `pendingTemplateExport` with `AiPublishTarget[]`. Build dependency closures using existing API methods, `createLessonPdfArtifact`, `ensureTemplateRoomfilesFolder`, `normalizeUploadedRoomFile`, and `templateJsonArtifact`. Keep the modal open on `AiPublishBatchError`; retry with its snapshots.

- [ ] **Step 6: Close only after complete success**

After every target has `phase === 'completed'`, clear both per-kind resume keys, refresh through `onComplete`, and explicitly invoke the parent close path exactly once. Never close in `finally` or after partial success.

- [ ] **Step 7: Run the completed publish tests**

Run: `npm test -- tests/onboarding-ai-publish-batch.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-roomfiles.spec.ts tests/ai-review.spec.ts`

Expected: PASS.

- [ ] **Step 8: Typecheck the publish changes**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Inspect the task diff**

Run: `git diff -- src/ui/onboarding/ai/ai-publish-batch.ts src/ui/onboarding/ai/ai-generator.tsx src/ui/onboarding/styles.css tests/onboarding-ai-publish-batch.spec.ts tests/onboarding-ai-admin-ui.spec.ts`

Expected: all-artifacts-first preparation, retryable sequential publish/export, and success-only close.

---

### Task 9: Authenticated embedded PDF reader for learner modules

**Files:**
- Create: `src/ui/onboarding/roomfile-preview.ts`
- Create: `src/ui/onboarding/inline-roomfile-viewer.tsx`
- Modify: `src/ui/onboarding/learning-workspace.tsx`
- Modify: `src/ui/onboarding/module-learning.tsx`
- Modify: `src/ui/onboarding/styles.css`
- Modify: `tests/onboarding-learner-ui.spec.ts`

**Interfaces:**
- Moves/re-exports: `roomFileMetadata` and `fileDownloadBlob` from `roomfile-preview.ts` so existing imports remain compatible.
- Produces: `loadRoomfilePreview(app, roomId, resource) => Promise<{ fileName, mimeType, blobUrl, revoke }>`.
- Produces: `InlineRoomfileViewer` with `resource`, `roomId`, optional `onOpened`, and retry UI.
- Consumes: required generated `TemplateResource` entries from Task 7.

- [ ] **Step 1: Write failing authenticated preview tests**

Assert:

- matching metadata and PDF bytes create one blob URL with `application/pdf`;
- wrong room ID, wrong file ID, missing bytes, and HTTP error reject before rendering;
- replacing a preview and calling `revoke` revoke the previous URL exactly once;
- non-PDF file types do not enter the embedded-PDF branch;
- no helper returns an external `target=_blank` URL for a Roomfiles PDF.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/onboarding-learner-ui.spec.ts`

Expected: FAIL because the preview module and embedded reader do not exist.

- [ ] **Step 3: Extract the Roomfiles byte-loading helpers**

Move metadata/blob normalization out of `learning-workspace.tsx`, add MIME preservation, and implement `loadRoomfilePreview` with the same authenticated REST endpoints. Keep compatibility exports if tests or callers still import from `learning-workspace.tsx`.

- [ ] **Step 4: Implement `InlineRoomfileViewer`**

Render loading, retryable error, and an in-app `<iframe>`/`<object>` for PDF blob URLs with a descriptive title. Revoke URLs on replacement/unmount. A download control may be secondary, but the primary action must stay in-app.

- [ ] **Step 5: Integrate the reader into AI per-module learning**

Default to a `Tài liệu PDF` tab when a generated file resource exists and retain `Nội dung dễ đọc` for LessonBlock HTML. Enable the existing lesson-completion confirmation after the learner opens the PDF or reaches the summary; never auto-complete on download.

- [ ] **Step 6: Integrate the reader into classic resource learning**

Replace the file download-only preview in `learning-workspace.tsx` with the same inline viewer for PDFs while leaving link/video behavior unchanged.

- [ ] **Step 7: Style the embedded reader**

Add responsive reader height, loading/error panel, tabs, and mobile controls without horizontal overflow.

- [ ] **Step 8: Run the completed learner tests**

Run: `npm test -- tests/onboarding-learner-ui.spec.ts`

Expected: PASS.

- [ ] **Step 9: Typecheck the reader changes**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 10: Inspect the task diff**

Run: `git diff -- src/ui/onboarding/roomfile-preview.ts src/ui/onboarding/inline-roomfile-viewer.tsx src/ui/onboarding/learning-workspace.tsx src/ui/onboarding/module-learning.tsx src/ui/onboarding/styles.css tests/onboarding-learner-ui.spec.ts`

Expected: authenticated in-app PDF reading with correct blob cleanup and no learner workflow regression.

---

### Task 10: Full regression verification, Docker rebuild, and Chrome acceptance

**Files:**
- Verify all files changed by Tasks 1–9.
- Modify production/test files only when a failure is caused by this feature.

**Interfaces:**
- Consumes: all preceding task contracts.
- Produces: rebuilt healthy Docker app and browser evidence for the supplied PrivOS channel URL.

- [ ] **Step 1: Run all focused feature tests together**

Run: `npm test -- tests/onboarding-ai-template-batch.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-roomfiles.spec.ts tests/onboarding-ai-lesson-pdf.spec.ts tests/ai-review.spec.ts tests/ai-onboarding-integration.spec.ts tests/onboarding-ai-publish-batch.spec.ts tests/onboarding-learner-ui.spec.ts`

Expected: PASS with no order-dependent state leaks.

- [ ] **Step 2: Run strict typecheck**

Run: `npm run typecheck:strict-unused`

Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`

Expected: all tests PASS; if the known Windows Bash packaging test still exits 127, report it separately with unchanged evidence and do not hide any new failure.

- [ ] **Step 4: Run the production build**

Run: `npm run build`

Expected: PASS, including manifest lint.

- [ ] **Step 5: Run preflight**

Run: `npm run preflight`

Expected: PASS.

- [ ] **Step 6: Check whitespace**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 7: Inspect final working-tree scope**

Run: `git status --short`

Expected: all unrelated existing changes remain intact; `.superpowers/` mockup artifacts remain untracked/unstaged; only approved feature/spec/plan files are newly changed by this work.

- [ ] **Step 8: Rebuild and recreate the Docker app**

Run: `docker compose up -d --build app`

Expected: `onboarding-dev-app-1` is recreated and reaches healthy state.

- [ ] **Step 9: Verify container health**

Run: `docker ps --filter name=onboarding-dev-app-1 --format "{{.Names}} {{.Status}}"`

Expected: container reports healthy.

- [ ] **Step 10: Inspect container logs**

Run: `docker logs --tail 150 onboarding-dev-app-1`

Expected: relay connected and no new startup/runtime error.

- [ ] **Step 11: Verify Template 2 in Chrome**

Reload `https://roxane-dev.privos.io/channel/test-onboarding-app-chd5tx/mcpapp/6ad87c38fbc62e6c0f76918d`.

Verify: no default selection; selecting Template 2 shows inline requirements; a valid title plus 2–8 tasks enables creation; Workspace A and real milestones remain visible through lessons, questions, verification, and draft.

- [ ] **Step 12: Verify Both, review order, publishing, and Roomfiles**

Create Both and verify normal finishes before advanced; Template 1 review opens first; Next opens Template 2; Back preserves edits; one publish action creates two per-template folders with one PDF per module and JSON; success closes the modal automatically.

- [ ] **Step 13: Verify learner PDF reading**

Assign one published AI template to a suitable room member, open each available module, and verify its PDF renders inside the app without a new tab, the accessible HTML lesson remains available, and the module quiz still unlocks/completes under existing rules.

- [ ] **Step 14: Exercise one recoverable failure path**

Use a test double or controlled failed upload in automated coverage; in the live app, do not damage Roomfiles deliberately. Confirm the modal remains open, identifies the failed template/module, and retry does not rerun completed AI work or duplicate files/resources.

- [ ] **Step 15: Ask for user action only when the host lifecycle requires it**

If the rebuilt app is healthy but PrivOS still serves stale code or explicitly requires Refresh/Repair/reload, report the exact evidence and ask the user to perform that action. Otherwise finish without requesting unnecessary host operations.
