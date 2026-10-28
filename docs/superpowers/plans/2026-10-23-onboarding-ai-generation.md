# AI-Generated Onboarding Templates Implementation Plan

> **For implementers:** Use `superpowers:executing-plans` to execute this plan task by task. Apply test-driven development for every production behavior and run verification before claiming completion.

**Goal:** Replace manual template creation with a PrivOS AI workflow that generates grounded onboarding templates from Admin-provided documents, while preserving editing, review, publishing, assignment, and backward compatibility for existing templates.

**Architecture:** The browser uploads source files and dispatches/polls PrivOS Sandbox AI through a small `AiGateway`; the MCP backend owns extraction, prompt construction, validation, grounding, job state, flags, materialization, publishing gates, and learner progress. AI templates use immutable content snapshots and `assessmentMode: 'per_module'`; legacy templates without that field continue through `final_exam`. Manual create is removed from the UI and disabled as a public action; when the optional AI permission is unavailable, creation is unavailable rather than falling back to a manual builder.

**Tech stack:** Node.js 22, TypeScript, React 18, Vitest, PrivOS MCP App SDK, App Database, `unpdf`, `mammoth`, Docker.

**Primary specification:** `docs/superpowers/specs/onboarding-ai-implementation-spec.md`

**Content rules:** `docs/superpowers/specs/onboarding-templates.md` sections 2, 5, 6, 7, 8, and 10.

**Repository rules:** Do not commit or push. Preserve the existing dirty learner-file fixes. Do not edit `.claude/`, `node_modules/`, or `.git`. Keep all data room-scoped and all authorization server-side.

---

## Task 1: Establish the baseline and complete Phase 0 spikes

**Files:**

- Create: `docs/ai-generation-spikes.md`
- Modify: `privos-app.json`
- Modify: `SCOPES.md`
- Test: `tests/manifest.spec.ts`
- Test: `tests/scope-audit.spec.ts`

1. Run the existing strict typecheck and focused manifest/tool tests to record the baseline without modifying the current dirty files.
2. Add a failing manifest test for optional `sandbox:generate` with room/user execution and explicit degraded behavior that disables AI creation.
3. Add the optional permission and matching call-site rationale; make the test pass.
4. Build a disposable iframe-side probe for `agents.sandbox.generate-async` and `agents.sandbox.attempt-status`; verify duplicate `operationId`, a large `systemContext`, terminal status shapes, and timing in the paired development app.
5. If Sandbox cannot satisfy the contract, probe the app01 native AI Chat adapter contract. If neither adapter works, stop and report the blocker instead of inventing an API.
6. Probe a near-5MB file through the existing upload/read bridge.
7. Probe PDF/DOCX extraction under the Docker image's read-only, 256MB constraints.
8. Probe registration of the five new collections and storage of a representative 600KB content snapshot in the current room.
9. Run the model-B generation prompt three times; if fewer than two outputs validate, split generation into the smaller prompt sequence prescribed by the main spec.
10. Record S1-S6 inputs, observed response shapes, limits, timings, adapter decision, and any required prompt split in `docs/ai-generation-spikes.md`. Remove any disposable UI/probe code not part of the selected adapter.

**Checkpoint:** Do not continue to production implementation until the selected AI path and database/file/extraction constraints are evidenced in the spike document.

## Task 2: Add domain contracts, limits, and database schema

**Files:**

- Modify: `src/onboarding/contracts.ts`
- Modify: `src/onboarding/schema.ts`
- Create: `src/onboarding/ai/limits.ts`
- Modify: `tests/helpers/onboarding-memory-store.ts`
- Create: `tests/ai-schema.spec.ts`
- Modify: `tests/onboarding-schema-index-format.spec.ts`

1. Write failing contract/schema tests for `AssessmentMode`, source references, lesson blocks, module content, question metadata, content snapshots, role profiles, flags, AI jobs, module progress, and module attempts.
2. Add optional `assessmentMode` and `content` fields without changing the behavior of legacy snapshots.
3. Register `onboarding_sources`, `onboarding_ai_jobs`, `onboarding_template_content`, `onboarding_module_progress`, and `onboarding_module_attempts` with room scope and indexes from the main spec.
4. Ensure no unique index is created for an optional `operationId` or other nullable field.
5. Centralize file, extracted-text, prompt, JSON, module, question, and polling limits in `ai/limits.ts`.
6. Update the in-memory test store so the new collections and uniqueness rules behave like App Database.
7. Run the schema and contract tests, then strict typecheck.

## Task 3: Implement safe source ingestion and text extraction

**Files:**

- Create: `src/onboarding/ai/extract.ts`
- Create: `src/onboarding/ai/sources.ts`
- Modify: `src/onboarding/store.ts` only if a generic store capability is genuinely missing
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/ai-extract.spec.ts`
- Create: `tests/ai-sources.spec.ts`

1. Read `superpowers:test-driven-development/writing-good-tests.md` before adding tests.
2. Write failing extraction tests for PDF text, DOCX, Markdown, TXT, HTML-to-text, unsupported types, encrypted/image-only PDF, malformed input, size limits, and deterministic section ranges.
3. Add `unpdf` and `mammoth`; implement bounded extraction without OCR, remote fetching, HTML execution, or trusting client-provided text.
4. Write failing source-service tests for Admin-only access, room isolation, file metadata verification, idempotent ingestion, admin notes, source listing, section retrieval, and deletion rules.
5. Implement `listSources`, `ingestSource`, `addAdminNote`, `deleteSource`, and `getSourceSection` using factory-injected store/file readers and typed service errors.
6. Persist original PrivOS `fileId`, hash, mime/name metadata, normalized text, sections, timestamps, and actor ID; never persist base64 in App Database.
7. Run focused tests, strict typecheck, and a Docker extraction smoke test.

## Task 4: Build deterministic prompts, parsing, validation, grounding, and inventory

**Files:**

- Create: `src/onboarding/ai/prompts.ts`
- Create: `src/onboarding/ai/parse.ts`
- Create: `src/onboarding/ai/validate.ts`
- Create: `src/onboarding/ai/grounding.ts`
- Create: `src/onboarding/ai/inventory.ts`
- Create: `tests/ai-grounding.spec.ts`
- Create: `tests/ai-validate.spec.ts`
- Create: `tests/ai-inventory.spec.ts`
- Create: `tests/ai-trap-doc.spec.ts`

1. Write failing parser tests for fenced JSON, leading/trailing prose, malformed/truncated JSON, duplicate IDs, oversized results, and unknown fields.
2. Implement deterministic extraction of exactly one bounded JSON object; do not add Zod.
3. Encode the mandatory rules from `onboarding-templates.md`: template-1/template-2 module frames, objective/content sizes, question counts, four options, one correct answer, source references, scenario requirements, responsibility coverage, and flag semantics.
4. Write failing grounding tests that reject nonexistent source IDs/ranges and claims not supported by referenced sections.
5. Write failing inventory tests for conflicting documents, missing role details, missing advanced-role controls, and stable flag creation.
6. Implement source inventory and validation as pure functions with stable error/flag codes.
7. Add adversarial document tests proving source text cannot override system instructions, request secrets, inject unsupported fields, or make the model invent company policy.
8. Run focused tests and strict typecheck.

## Task 5: Implement resumable AI jobs and browser gateway

**Files:**

- Create: `src/onboarding/ai/jobs.ts`
- Create: `src/ui/onboarding/ai/ai-gateway-sandbox.ts` or the spike-selected fallback
- Create: `src/ui/onboarding/ai/ai-pump.ts`
- Modify: `src/ui/onboarding/api.ts`
- Create: `tests/ai-jobs.spec.ts`
- Create: `tests/ai-gateway.spec.ts`

1. Write failing gateway tests for dispatch/status normalization, operation-ID reuse, request mismatch, polling cancellation, permission denial, retryable failures, terminal failures, and malformed Hub responses.
2. Implement the `AiGateway` contract using only the endpoint and response shapes evidenced in Task 1; annotate the `sandbox:generate` call site.
3. Write failing job-service tests for Admin-only access, allowed transitions, lease/step ownership, idempotent dispatch receipts, resume after refresh, stale worker recovery, retry, cancel, AI-output submission, and room isolation.
4. Implement the server-owned state machine. The browser may dispatch and poll but must not choose prompts, validate content, materialize templates, or skip server steps.
5. Persist attempt references and submitted outputs before advancing a job; never blindly redispatch an unknown attempt.
6. Add `OnboardingApi.adminAi()` and the pump that repeatedly asks the server for `next_step`, dispatches the selected AI request, polls with abort support, and submits terminal output.
7. Run focused tests and strict typecheck.

## Task 6: Materialize AI drafts, review flags, and guard publishing

**Files:**

- Create: `src/onboarding/ai/materialize.ts`
- Create: `src/onboarding/ai/review.ts`
- Modify: `src/onboarding/templates.ts`
- Modify: `src/onboarding/contracts.ts`
- Create: `tests/ai-materialize.spec.ts`
- Create: `tests/ai-review.spec.ts`
- Modify: `tests/onboarding-templates.spec.ts`

1. Write failing materialization tests for stable IDs, `source: 'ai_generated'`, `assessmentMode: 'per_module'`, immutable content snapshots, edit revisions, and idempotent reruns.
2. Persist generated lesson/question content in `onboarding_template_content` while retaining the template catalog/version records required by existing assignment flows.
3. Write failing review tests for optimistic concurrency, editable AI content, flag listing/resolution, resolution notes, automatic reopening when evidence becomes invalid, and audit events.
4. Extend the template service so AI-generated drafts can be edited and versioned, while the public manual `create` action is rejected with a typed error.
5. Keep existing manual/system/final-exam templates readable, assignable, and behaviorally unchanged; allow existing custom templates to be maintained for backward compatibility without exposing a new-manual-template path.
6. Guard publish when any blocking flag is open, content validation fails, or an advanced template lacks the required evidence/flags.
7. Run focused tests and strict typecheck.

## Task 7: Implement per-module learner state and scoring

**Files:**

- Create: `src/onboarding/module-learning.ts`
- Modify: `src/onboarding/assignments.ts`
- Modify: `src/onboarding/attempts.ts` only where shared scoring primitives are reused
- Modify: `src/onboarding/contracts.ts`
- Create: `tests/module-learning.spec.ts`
- Create: `tests/module-learning-dto.spec.ts`
- Modify: `tests/onboarding-assignments.spec.ts`

1. Write failing tests for the exact module-state precedence: passed, locked, needs_support, quiz_failed, quiz_ready, learning, available.
2. Write failing tests for lesson completion, quiz start, quiz submission, attempt limits, retry grants, module unlocks, progress formula, assignment completion, and room/member authorization.
3. Implement `getModules`, `openModule`, `completeLesson`, `startModuleQuiz`, `submitModuleQuiz`, and `getModuleAttempt` as a factory service with typed errors.
4. Before submission, learner DTOs must omit correct answers, explanations, and source references; after submission, return only the submitted attempt's authorized result details.
5. Extend Admin assignment detail with module states and add `grantModuleRetry` plus question statistics from stored attempts.
6. Route templates with missing/`final_exam` assessment mode through the old resource/final-attempt services unchanged.
7. Run focused tests, all legacy attempt/assignment tests, and strict typecheck.

## Task 8: Wire server tools, manifest contracts, and bootstrap capabilities

**Files:**

- Modify: `src/onboarding/tools.ts`
- Modify: `src/onboarding/schema.ts`
- Modify: `privos-app.json`
- Modify: `SCOPES.md`
- Modify: `src/manifest.ts` only if the canonical field list requires no structural change
- Modify: `tests/onboarding-tools.spec.ts`
- Modify: `tests/onboarding-api.spec.ts`
- Modify: `tests/manifest.spec.ts`
- Modify: `tests/scope-audit.spec.ts`
- Modify: `tests/permission-catalog.spec.ts` only if catalog expectations need the already-supported scope

1. Write failing tool-dispatch tests for every `onboarding_admin_ai` action and new `onboarding_learning`/assignment action, including invalid args and authorization.
2. Register the `onboarding_admin_ai` service in the bundle and action dispatcher; keep all actor/room validation on the server.
3. Add the new actions to the existing learning and assignment tools and return learner-safe/admin-safe DTOs.
4. Update bootstrap capabilities so the UI can distinguish Admin access, file upload support, and optional AI generation availability.
5. Update canonical manifest tool schemas/descriptions and permission documentation without adding unsupported fields or changing `resourceManifestTemplate`.
6. Assert the manifest's exact tool order and permissions, then run manifest lint and focused tests.

## Task 9: Replace manual creation with the Admin AI generation and review UI

**Files:**

- Create: `src/ui/onboarding/ai/ai-generator.tsx`
- Create: `src/ui/onboarding/ai/source-panel.tsx`
- Create: `src/ui/onboarding/ai/ai-review.tsx`
- Create: `src/ui/onboarding/ai/flag-panel.tsx`
- Modify: `src/ui/onboarding/templates.tsx`
- Modify: `src/ui/onboarding/template-editor-ui.tsx`
- Modify: `src/ui/onboarding/template-editor.css`
- Modify: `src/ui/onboarding/styles.css`
- Modify: `src/ui/App.tsx`
- Create: `tests/onboarding-ai-admin-ui.spec.ts`
- Modify: `tests/onboarding-admin-ui.spec.ts`
- Modify: `tests/template-editor-ui.spec.ts`

1. Write failing UI-model tests for the five steps: sources, inventory, generation, review, publish.
2. Remove the manual "Tạo template" wizard entry point and replace it with "Tạo bằng AI".
3. Implement source upload/list/delete/admin-note controls, clear file/type/size guidance, and a disabled state explaining missing optional AI permission.
4. Implement resumable progress with current server step, attempt state, retry/cancel, refresh recovery, and actionable error messages.
5. Implement review of generated modules, lessons, questions, citations, validation issues, and flags; retain editing through the existing version/concurrency model.
6. Require blocking flags to be resolved before enabling publish and show the exact unresolved items.
7. Keep list/detail/archive/delete/use-template behavior and all existing success/error notices.
8. Run focused UI tests and strict typecheck.

## Task 10: Add the per-module learner UI

**Files:**

- Create: `src/ui/onboarding/ai/lesson-markdown.tsx`
- Modify: `src/ui/onboarding/learning-workspace.tsx`
- Modify: `src/ui/onboarding/learner-dashboard.tsx`
- Modify: `src/ui/onboarding/results.tsx` only where per-module summary is needed
- Modify: `src/ui/onboarding/styles.css`
- Create: `tests/onboarding-module-learning-ui.spec.ts`
- Modify: `tests/onboarding-learner-ui.spec.ts`

1. Write failing renderer tests for supported paragraphs, newlines, bold, inline code, lists, and level-3 headings; render links as inert text and never use `dangerouslySetInnerHTML`.
2. Write failing UI-model tests for module cards, locked/available/learning/quiz-ready/failed/support/passed states, lesson completion, quiz flows, feedback, retries, and resume after refresh.
3. Implement the module list, lesson reader, and one-module quiz screens using only learner-safe DTOs.
4. Show progress using `round(sum(0.5 * lessonDone + 0.5 * passed) / moduleCount * 100)` and synchronize dashboard/assignment states.
5. Preserve the existing final-exam workspace for legacy assignments.
6. Run focused UI tests and legacy learner tests.

## Task 11: Complete integration, resilience, and regression coverage

**Files:**

- Modify: relevant existing tests under `tests/`
- Create: integration fixtures under `tests/fixtures/` only if needed
- Modify: `README.md`
- Modify: `docs/app-overview.md`
- Modify: `CHANGELOG.md`

1. Add an end-to-end service test covering source ingestion → inventory → generation outputs → validation/flags → materialization → edit → publish → assign → per-module learning → retry → completion.
2. Add explicit regressions for old system/custom final-exam templates, multiple templates per employee, assignment-pinned versions, and existing file-resource downloads.
3. Add failure tests for refresh during generation, duplicate pump calls, stale revisions, malformed AI output, permission denial, unavailable source files, database retries, and nonblocking audit failure behavior defined by the spec.
4. Verify no learner/network DTO leaks answer keys before submission and no cross-room IDs are accepted.
5. Update user/developer documentation to describe AI-only creation, editable AI drafts, optional permission behavior, supported files, no OCR, flag review, and legacy-template compatibility.

## Task 12: Verify, deploy, and test in the paired development app

**Files:**

- No new product files unless verification exposes a defect.

1. Run `npm run typecheck:strict-unused`.
2. Run every focused test added above, then `npm test`.
3. Run `npm run build` and `npm run preflight`.
4. Run `npm run docker:build` and start/rebuild the existing development compose service.
5. Inspect container health and logs; confirm the manifest and optional scope are active for the paired installation.
6. Refresh the existing Chrome tab and execute the main spec's real QA matrix: conflicting documents and flags, advanced missing-data flag, publish blocking/resolution, generated-template edit/version, assignment, learner module progression, answer-key network check, failed quiz/support/retry, refresh/resume, and a legacy final-exam assignment.
7. Capture observed pass/fail evidence. If any check fails, write the smallest failing automated test first, fix it, and rerun the relevant focused and full verification commands.
8. Run `git diff --check`, inspect `git diff` and `git status --short`, and request a code review before reporting completion. Do not commit or push.

---

## Acceptance criteria

- Admin cannot create a template manually; creation starts only from approved room documents/admin notes through PrivOS AI.
- Missing optional AI permission disables creation with a clear message and no manual fallback.
- AI content is traceable to sources, validated against the content rules, editable, reviewable, versioned, and blocked from publishing while blocking flags remain.
- AI-generated templates use per-module learning and safe DTOs; legacy templates retain the existing final-exam behavior.
- Jobs are idempotent and resumable across refreshes, with server-owned orchestration and room isolation.
- All required commands and real-Chrome QA pass, the Dockerized paired app runs the new build, and no unrelated dirty work is lost.
