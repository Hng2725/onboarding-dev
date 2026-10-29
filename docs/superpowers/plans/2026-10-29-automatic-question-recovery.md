# Automatic Question Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make question generation recover automatically through Sandbox, Native AI Chat, then a grounded deterministic draft so Admins only review and approve.

**Architecture:** Keep provider selection in the browser orchestrator, where effective capabilities and persisted call history are available. Keep deterministic question construction, validation, versioning, audit, and persistence on the server. Reuse the existing `failed → retry_module → review_ready → approval` lifecycle and add explicit question provenance instead of weakening publish gates.

**Tech Stack:** TypeScript, React 18, Vitest, PrivOS MCP app server/UI.

**Spec:** `docs/superpowers/specs/2026-10-29-automatic-question-recovery-design.md`

## Global Constraints

- Never run Sandbox and Native AI Chat in parallel.
- Try Native at most once for one failed question version before using deterministic fallback.
- Deterministic questions may use only approved lesson blocks and their existing `sourceRefs`.
- Every fallback question must retain a valid `blockIds` link and at least one grounded source reference.
- Fallback creates a reviewable draft only; approval and publish gates remain unchanged.
- A source-free manual lesson still requires Admin-authored questions; never fabricate evidence.
- Do not push the branch; the user will push `feat/AI-gen-template`.

## Review Focus

- Sandbox returns empty or invalid output after schema repair: recover without requiring a manual question form.
- Native capability is absent or dispatch is denied: go directly to fallback without a retry loop.
- Reload occurs after Sandbox failure or Native dispatch: use persisted call provider/version and do not duplicate an attempt.
- Approved lesson has only one grounded block or one usable statement: still produce three distinct, valid review questions.
- Lesson changes after fallback generation: existing version invalidation must make fallback questions stale and unpublishable.

---

### Task 1: Deterministic Grounded Question Builder

**Files:**
- Create: `src/onboarding/ai/fallback-questions.ts`
- Create: `tests/ai-fallback-questions.spec.ts`

**Interfaces:**
- Consumes: `GeneratedModule`, `GeneratedQuestion`, and approved block `sourceRefs` from `src/onboarding/ai/validate.ts`.
- Produces:

```ts
export type FallbackQuestionResult =
  | { readonly kind: 'draft'; readonly questions: readonly GeneratedQuestion[]; readonly provenance: 'fallback' }
  | { readonly kind: 'manual_required'; readonly reason: 'NO_GROUNDED_LESSON_BLOCK' };

export function buildFallbackQuestions(input: {
  readonly lesson: GeneratedModule;
}): FallbackQuestionResult;
```

- [ ] **Step 1: Write failing builder tests**

Add tests named:

- `builds exactly three deterministic recognition questions from grounded lesson blocks`
- `uses three distinct prompts when one grounded block has fewer than three statements`
- `copies only block-local ids and source references`
- `returns manual_required when no non-summary block has a source reference`

Assert literal option IDs `a,b,c,d`, `correctOptionId: 'a'`, three unique `localId`/prompts, and deterministic equality across repeated calls. Assert every question's `blockIds` contains exactly its source block ID and its `sourceRefs` equal an existing ref on that block.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run tests/ai-fallback-questions.spec.ts`

Expected: FAIL because `fallback-questions.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure builder**

Generate recognition prompts from non-summary lesson blocks. Prefer distinct non-empty lines/sentences, then use three fixed prompt forms around the same grounded statement when necessary. Keep labels and explanations deterministic and within the existing validator limits; never invent factual alternatives.

- [ ] **Step 4: Run the focused test and validator regression**

Run: `npm test -- --run tests/ai-fallback-questions.spec.ts tests/ai-module-draft.spec.ts tests/ai-validate.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/ai/fallback-questions.ts tests/ai-fallback-questions.spec.ts
git commit -m "feat: add grounded question fallback"
```

### Task 2: Persist Fallback Question Drafts Safely

**Files:**
- Modify: `src/onboarding/contracts.ts`
- Modify: `src/onboarding/ai/module-lifecycle.ts`
- Modify: `src/onboarding/ai/jobs.ts`
- Modify: `src/onboarding/tools.ts`
- Modify: `tests/ai-module-lifecycle.spec.ts`
- Modify: `tests/ai-jobs.spec.ts`
- Modify: `tests/onboarding-tools.spec.ts`

**Interfaces:**
- Consumes: `buildFallbackQuestions({ lesson })` from Task 1.
- Produces:

```ts
interface AiModuleDraftRun {
  readonly questionProvenance?: 'ai' | 'fallback' | 'manual';
}

updateQuestions(
  run: AiModuleDraftRun,
  expectedVersion: number,
  questions: readonly GeneratedQuestion[],
  provenance: 'ai' | 'fallback' | 'manual',
): AiModuleDraftRun;

AiJobService.useQuestionFallback(
  actor: OnboardingActor,
  input: ModuleVersionInput,
): Promise<AiJobRecord>;
```

Add admin action `use_question_fallback({ jobId, moduleLocalId, expectedVersion })`.

- [ ] **Step 1: Write failing lifecycle tests**

Assert AI/manual/fallback updates persist their exact provenance, increment `questionVersion`, bind `questionLessonVersion`, clear prior approval, and become `review_ready`. Assert lesson invalidation clears stale question provenance with the draft/version pair.

- [ ] **Step 2: Write failing service and tool tests**

Assert `useQuestionFallback`:

- rejects stale expected versions and unapproved lessons;
- stores exactly three validator-valid grounded questions and `questionProvenance: 'fallback'`;
- returns `AI_OUTPUT_INVALID`/operation conflict without mutating the run for a source-free lesson;
- records the provenance in the approval audit payload;
- is routed and argument-validated by `onboarding_admin_ai` action `use_question_fallback`.

- [ ] **Step 3: Run and verify RED**

Run: `npm test -- --run tests/ai-module-lifecycle.spec.ts tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts`

Expected: FAIL on missing provenance, service method, and tool action.

- [ ] **Step 4: Implement lifecycle, service, validation, and routing**

Require explicit provenance at every `updateQuestions` caller: AI output uses `ai`, Admin edits use `manual`, and deterministic builder uses `fallback`. Validate fallback output with `validateModuleQuestionOutput` before `saveRun`; preserve all existing approval/materialization gates.

- [ ] **Step 5: Run focused tests and strict typecheck**

Run: `npm test -- --run tests/ai-fallback-questions.spec.ts tests/ai-module-lifecycle.spec.ts tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts tests/ai-materialize.spec.ts`

Run: `npm run typecheck:strict-unused`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/onboarding/contracts.ts src/onboarding/ai/module-lifecycle.ts src/onboarding/ai/jobs.ts src/onboarding/tools.ts tests/ai-module-lifecycle.spec.ts tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts
git commit -m "feat: persist fallback question drafts"
```

### Task 3: Automatic Sandbox-to-Native Recovery Orchestration

**Files:**
- Create: `src/ui/onboarding/ai/question-recovery.ts`
- Modify: `src/ui/onboarding/ai/ai-generator.tsx`
- Modify: `tests/onboarding-ai-generator-lifecycle.spec.ts`
- Create: `tests/onboarding-ai-question-recovery.spec.ts`

**Interfaces:**
- Consumes: persisted `AiJobRecord.calls`, `AiModuleDraftRun`, `retry_module`, and `use_question_fallback`.
- Produces:

```ts
export type QuestionRecoveryDecision =
  | { readonly kind: 'retry_native'; readonly moduleLocalId: string; readonly expectedVersion: number }
  | { readonly kind: 'use_fallback'; readonly moduleLocalId: string; readonly expectedVersion: number }
  | null;

export function planQuestionRecovery(
  job: AiJobRecord,
  nativeAvailable: boolean,
): QuestionRecoveryDecision;
```

The generator's `pump` loop consumes this decision after `pumpAiJob` returns an `awaiting_admin` module job: call `retry_module` and re-enter with Native for `retry_native`, or call `use_question_fallback` once and return the review-ready job for `use_fallback`.

- [ ] **Step 1: Write failing pure decision tests**

Assert:

- a failed Sandbox question call for the current question version chooses `retry_native` only when Native is available;
- a failed Native call chooses `use_fallback`;
- unavailable Native chooses `use_fallback` directly;
- lesson failures, completed questions, different module/version calls, and source-free lessons return `null`;
- persisted Native history prevents another Native retry after reload.

- [ ] **Step 2: Write failing orchestrator tests**

Exercise the real generator lifecycle with API/gateway boundaries stubbed at the external provider level. Assert the action sequence is `retry_module → native dispatch` after Sandbox failure, then `use_question_fallback` after Native failure; assert no third provider dispatch and no manual editor interaction.

- [ ] **Step 3: Run and verify RED**

Run: `npm test -- --run tests/onboarding-ai-question-recovery.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts`

Expected: FAIL because recovery planning/loop does not exist.

- [ ] **Step 4: Implement the bounded recovery loop**

Keep the current attempt-adoption behavior in `pumpAiJob`. The wrapper may re-enter only after the previous pump has returned a persisted failed state. Update progress state after each recovery action so reload sees the same call history.

- [ ] **Step 5: Run focused tests and pump regressions**

Run: `npm test -- --run tests/onboarding-ai-question-recovery.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts tests/ai-pump.spec.ts tests/ai-attempt-lifecycle.spec.ts tests/ai-gateway-native-chat.spec.ts`

Run: `npm run typecheck:strict-unused`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/onboarding/ai/question-recovery.ts src/ui/onboarding/ai/ai-generator.tsx tests/onboarding-ai-question-recovery.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts
git commit -m "fix: recover failed question generation automatically"
```

### Task 4: Review UI Safety and End-to-End Verification

**Files:**
- Modify: `src/ui/onboarding/ai/ai-module-workspace.tsx`
- Modify: `tests/onboarding-ai-module-workspace.spec.ts`
- Modify: `tests/ai-onboarding-integration.spec.ts`

**Interfaces:**
- Consumes: `questionProvenance` and recovery behavior from Tasks 2–3.
- Produces: a fallback label and a strict approval gate requiring `questionState === 'review_ready'`.

- [ ] **Step 1: Write failing workspace safety tests**

Assert fallback questions display `Bản câu hỏi dự phòng — cần rà soát`. Assert `Duyệt câu hỏi và tiếp tục` is enabled only for a non-dirty `review_ready` draft and remains disabled for `failed`, `drafting`, `queued`, `stale`, or empty questions.

- [ ] **Step 2: Write failing integration recovery test**

Drive a module job through approved lesson → Sandbox question failure → Native question failure → deterministic fallback → Admin approval. Assert materialization remains blocked before approval and succeeds after all module question pairs are approved.

- [ ] **Step 3: Run and verify RED**

Run: `npm test -- --run tests/onboarding-ai-module-workspace.spec.ts tests/ai-onboarding-integration.spec.ts`

Expected: FAIL on missing fallback label/strict state gate/recovery path.

- [ ] **Step 4: Implement the minimal UI changes**

Use provenance only for review copy. Do not expose provider/fallback technical labels to learners or alter the published template schema.

- [ ] **Step 5: Run complete verification**

Run: `npm test`

Run: `npm run typecheck:strict-unused`

Run: `npm run build`

Run: `npm run docker:build`

Expected: all tests PASS, typecheck exits 0, production build and Docker image build succeed.

- [ ] **Step 6: Live Chrome acceptance on the existing tab**

Reload the existing PrivOS tab. Resume the current module job and verify:

1. No manual blank question draft is persisted.
2. Failed Sandbox generation automatically uses Native once or deterministic fallback.
3. “Tài khoản và quyền truy cập” becomes reviewable without Admin authoring.
4. “Làm quen giao diện” and “Quy trình công việc chính” both reach approved questions.
5. Template 1 materializes; when the selected batch is Both, Template 2 is reviewed next and both publish together.
6. Published files exist under `Onboarding-app/Created templates/<template-name>` and the modal closes after successful batch publication.

- [ ] **Step 7: Commit**

```bash
git add src/ui/onboarding/ai/ai-module-workspace.tsx tests/onboarding-ai-module-workspace.spec.ts tests/ai-onboarding-integration.spec.ts
git commit -m "fix: gate fallback question review safely"
```

---

## Self-Review Record

- Spec coverage: Tasks 1–4 cover deterministic grounded drafts, server validation/versioning/audit, bounded provider recovery, resume safety, review copy, approval gating, and live publication acceptance.
- Step scan: every production change is preceded by a focused failing test and followed by focused/full verification.
- Type consistency: `questionProvenance`, `useQuestionFallback`, `use_question_fallback`, and `QuestionRecoveryDecision` are defined once and consumed with matching names.
- Review Focus: each listed failure mode is pinned to a named test in Tasks 1–4.
- Proportion: the plan specifies observable behavior and interfaces without transcribing implementation bodies.

