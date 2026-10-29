# Guided Roadmap Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn roadmap generation into a guided step-3 outline review and a reading-first step-4 lesson/question review, with compact on-demand editing and full-width AI progress.

**Architecture:** Keep the existing `module_v2` job, outline, draft, approval, materialization, and publication data model. Refactor only the React presentation and generator step routing: `AiOutlineReview` owns roadmap structure review, `AiModuleWorkspace` owns draft lesson/question review, and `AiGeneratorPage` decides which workspace belongs to steps 3 and 4. Keep all server action names and persisted identifiers unchanged.

**Tech Stack:** React 18, TypeScript, Vitest, react-test-renderer, server-rendered markup tests, CSS, Vite, Docker.

**Spec:** `docs/superpowers/specs/2026-10-29-guided-roadmap-workspace-design.md`

## Global Constraints

- Do not rename persisted module IDs or alter generated template data.
- Keep Template 1 at 4–8 modules and Template 2 at 5–8 modules.
- Keep safe drafting rules for modules without sources.
- Keep Template 1 then Template 2 review order and joint publication when both are selected.
- Template 1 must not display a work-responsibility count.
- The default module view must not contain the long `Nguồn và phần tài liệu` block.
- The main roadmap view exposes no more than three persistent actions.
- No page-level horizontal overflow is allowed at desktop, tablet, or mobile widths.
- Use existing dependencies; add no UI framework or state library.

## Review Focus

- A restored running `module_v2` job whose outline is already approved must reopen step 4, not the step-3 outline editor; Task 3 adds the regression test.
- An outline approval API failure after optimistic navigation must return the admin to step 3 with their outline intact; Task 3 adds the failure-path test.
- Template 2 with zero mapped responsibilities must show an actionable coverage warning, while Template 1 must show no responsibility copy; Task 1 adds both cases.
- Approve-and-next must not change the selected module when the server action fails; Task 2 adds success and failure tests.
- A narrow viewport must keep roadmap actions and the active AI milestone reachable without body-level horizontal overflow; Task 4 adds CSS assertions and Task 5 performs browser checks.

---

### Task 1: Guided Step-3 Roadmap Review

**Files:**
- Modify: `src/ui/onboarding/ai/ai-outline-review.tsx`
- Modify: `tests/onboarding-ai-outline-ui.spec.ts`

**Interfaces:**
- Consumes: `TemplateOutline`, `EmployeeType`, `OutlineEdit`, `NORMAL_FRAMES`, `ADVANCED_FRAMES`, and the existing `AiOutlineReview` props.
- Produces: `outlineFrameLabel(frameKey: string): string`, `outlineModuleDisplayTitle(module: TemplateOutline['modules'][number]): string`, and the unchanged `AiOutlineReview` callback contract used by Task 3.

- [ ] **Step 1: Write failing presentation tests**

Add tests named:

- `renders every normal module as one ordered roadmap instead of four choices`
- `uses friendly frame labels when generated titles are raw frame keys`
- `hides work responsibility counts for Template 1`
- `shows mapped work responsibilities with explicit wording for Template 2`

Assert that four normal modules are all visible simultaneously, `t1-overview` is presented as `Tổng quan`, normal markup does not contain `nhiệm vụ`, and advanced markup uses `nhiệm vụ công việc` rather than question wording.

- [ ] **Step 2: Run the outline UI tests and confirm they fail**

Run: `npm test -- tests/onboarding-ai-outline-ui.spec.ts`

Expected: FAIL because the current cards use raw titles and always render `0 nhiệm vụ`.

- [ ] **Step 3: Implement the roadmap card surface**

In `ai-outline-review.tsx`, add the two exported label helpers and replace the collapsed-details list with an ordered selectable card grid. Each card must show only its order/title, short description, duration, source state, and review state. Selection inspects a module; it never excludes other modules.

- [ ] **Step 4: Write failing interaction tests for the compact editor**

Add tests named:

- `keeps only add edit and approve as persistent roadmap actions`
- `opens module fields only after edit is requested`
- `opens source selection only after bổ sung tài liệu is requested`
- `keeps add reorder remove save and approve callbacks compatible`

Assert that the default view does not contain `Nguồn và phần tài liệu`, source checkboxes are absent until the on-demand control is opened, and the persistent action bar contains exactly `Thêm module bổ sung`, `Chỉnh sửa module`, and `Duyệt lộ trình và tiếp tục`.

- [ ] **Step 5: Run the interaction tests and confirm they fail**

Run: `npm test -- tests/onboarding-ai-outline-ui.spec.ts`

Expected: FAIL because the current form and source fieldset are always nested in each expanded card.

- [ ] **Step 6: Implement compact add/edit/source panels**

Keep selection and edit state local to `AiOutlineReview`. Open one compact panel for either adding a frame or editing the selected module. Render the source catalog only inside an on-demand `Bổ sung tài liệu` disclosure. Preserve every existing `OutlineEdit` payload, minimum/maximum validation, protected-frame deletion rule, dirty-state approval lock, and `onSupplement(moduleLocalId, sourceIds, sectionIds)` call.

- [ ] **Step 7: Run the outline tests**

Run: `npm test -- tests/onboarding-ai-outline-ui.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/ui/onboarding/ai/ai-outline-review.tsx tests/onboarding-ai-outline-ui.spec.ts
git commit -m "feat: simplify roadmap structure review"
```

### Task 2: Reading-first Step-4 Module Workspace

**Files:**
- Modify: `src/ui/onboarding/ai/ai-module-workspace.tsx`
- Modify: `tests/onboarding-ai-module-workspace.spec.ts`

**Interfaces:**
- Consumes: existing `AiModuleDraftRun`, `AiCallRecord`, `GeneratedModule`, `GeneratedBlock`, and `GeneratedQuestion` records.
- Produces: exported `ModuleWorkspaceAction` union and `ModuleWorkspaceActionHandler = (action: ModuleWorkspaceAction, args: Record<string, unknown>) => boolean | void | Promise<boolean | void>`; `AiModuleWorkspace` keeps its existing props except `onAction` uses that named handler.

- [ ] **Step 1: Write failing reading-mode tests**

Add tests named:

- `opens an approved draft in reading mode without form fields`
- `reveals lesson fields only after Chỉnh sửa is selected`
- `keeps question review hidden until every lesson is approved`
- `labels question progress explicitly as questions`

Assert that block bodies and steps render in the default view, lesson inputs are absent until edit mode, the lesson phase is selected while any lesson is unapproved, and question status uses text such as `0/5 câu hỏi đã duyệt` rather than `nhiệm vụ`.

- [ ] **Step 2: Run the module-workspace tests and confirm they fail**

Run: `npm test -- tests/onboarding-ai-module-workspace.spec.ts`

Expected: FAIL because the current workspace renders lesson and question forms together.

- [ ] **Step 3: Implement reading mode and phased review**

Derive a workspace phase of `lessons` until every active run has `lessonState === 'approved'`, then `questions`. Keep a sticky module list and render the selected lesson or question as readable content. Add local `viewMode: 'read' | 'edit'`; reuse the current editing controls only in edit mode, preserving versioned update payloads and unsaved edits across job refreshes.

- [ ] **Step 4: Write failing action hierarchy tests**

Add tests named:

- `approves the current lesson and selects the next module after success`
- `does not advance when approve-and-next reports failure`
- `puts retry and source fallback inside Thao tác khác`
- `routes a source-less module through Bổ sung tài liệu`

The success test must await the handler and assert both the versioned `approve_module_lesson` call and the next module ID. The failure test returns `false` and asserts no selection change.

- [ ] **Step 5: Run the action tests and confirm they fail**

Run: `npm test -- tests/onboarding-ai-module-workspace.spec.ts`

Expected: FAIL because approval does not advance and five peer buttons are always visible.

- [ ] **Step 6: Implement the sticky action bar and overflow menu**

Expose `Duyệt và sang module tiếp theo` or `Duyệt câu hỏi và tiếp tục` as the single primary action, `Chỉnh sửa` as the secondary action, and place retry/fallback/history actions under `Thao tác khác`. Await `onAction`; advance only when it does not return `false`. Keep source-less safety text and call `onSources` from a compact `Bổ sung tài liệu` action.

- [ ] **Step 7: Run the module-workspace tests**

Run: `npm test -- tests/onboarding-ai-module-workspace.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/ui/onboarding/ai/ai-module-workspace.tsx tests/onboarding-ai-module-workspace.spec.ts
git commit -m "feat: add reading-first module review"
```

### Task 3: Generator Step Routing and Resume Behavior

**Files:**
- Modify: `src/ui/onboarding/ai/ai-generator.tsx`
- Modify: `tests/onboarding-ai-admin-ui.spec.ts`
- Modify: `tests/onboarding-ai-generator-lifecycle.spec.ts`

**Interfaces:**
- Consumes: the Task 1 `AiOutlineReview` callbacks and Task 2 `ModuleWorkspaceActionHandler`.
- Produces: `aiGeneratorStepFor` gains `outlineApproved?: boolean`; `moduleAction(action, args, resume)` returns `Promise<boolean>`; new local `approveOutlineAndStartDrafting(): Promise<void>` owns optimistic navigation and rollback.

- [ ] **Step 1: Write failing step-derivation and restore tests**

Extend `models the five source-to-publish steps in the requested order` to assert an approved running outline maps to step index `3`. Add lifecycle tests named:

- `restores an approved running module job directly in Rà soát`
- `keeps an unapproved outline in Tạo lộ trình`
- `keeps final materialized review in Rà soát`

- [ ] **Step 2: Run the focused generator tests and confirm they fail**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts`

Expected: FAIL because restored approved module jobs currently reopen step index `2`.

- [ ] **Step 3: Split step-3 outline and step-4 content rendering**

Render `AiOutlineReview` only at `step === 2`. Render `AiModuleWorkspace` at `step === 3` whenever an approved `module_v2` job has not yet materialized a review; render the existing `AiReview` in the same step after materialization. Keep the Template 1 then Template 2 sequence and final step-5 publication logic unchanged.

- [ ] **Step 4: Write failing transition tests**

Add tests named:

- `moves to Rà soát immediately after outline approval and starts the module pump`
- `returns to Tạo lộ trình when outline approval fails`
- `opens the selected outline source panel from a source-less review module`
- `edits materialized module content without returning to the outline by default`

Assert that source supplementation sets `editingOutline` and step index `2`, while editing already-generated module content remains at step index `3`.

- [ ] **Step 5: Run the transition tests and confirm they fail**

Run: `npm test -- tests/onboarding-ai-generator-lifecycle.spec.ts`

Expected: FAIL because outline approval and draft review currently share step index `2`.

- [ ] **Step 6: Implement safe transitions**

Make `moduleAction` return `true` only after its API/pump work succeeds and `false` on handled errors. `approveOutlineAndStartDrafting` moves to step `3`, invokes approval and pumping, and restores step `2` on failure. Update restore, back-button, edit-module, and source-supplement navigation without changing persisted resume keys.

- [ ] **Step 7: Run the generator tests**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/ui/onboarding/ai/ai-generator.tsx tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts
git commit -m "feat: separate roadmap and content review steps"
```

### Task 4: Full-width AI Progress and Responsive Workspace

**Files:**
- Modify: `src/ui/onboarding/ai/ai-job-milestones.tsx`
- Modify: `src/ui/onboarding/styles.css`
- Modify: `tests/onboarding-ai-admin-ui.spec.ts`
- Modify: `tests/onboarding-ai-generator-density.spec.ts`

**Interfaces:**
- Consumes: current `AiMilestone`, job calls, and module-run states.
- Produces: `templateMilestones(job)` returns the fixed IDs `outline`, `lessons`, `questions`, and `ready`; `AiMilestoneProgress` adds a `compact` class only when every milestone is completed and there is no failure.

- [ ] **Step 1: Write failing four-milestone tests**

Update milestone tests to require:

```ts
expect(templateMilestones(job).map(({ id }) => id)).toEqual([
  'outline', 'lessons', 'questions', 'ready',
]);
```

Add assertions that verification/repair calls activate `ready` with their current-call detail, module counts appear in lesson/question detail, and fully completed progress renders the compact class.

- [ ] **Step 2: Run milestone tests and confirm they fail**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts`

Expected: FAIL because template progress currently exposes five vertical milestones.

- [ ] **Step 3: Implement the four milestone model**

Fold verification and draft materialization into `ready`. Preserve completed-stage monotonicity, retries, repair detail, provider/runtime display, and technical failure logging.

- [ ] **Step 4: Write failing layout-density tests**

Extend `onboarding-ai-generator-density.spec.ts` to assert:

- `.ai-workspace` uses the available width rather than `max-width: 1180px`;
- `.ai-workspace-progress-card` spans `grid-column: 1 / -1`;
- desktop `.ai-milestone-list` uses four equal columns;
- mobile milestones return to one column;
- roadmap actions are sticky/reachable;
- the module workspace stacks at the established mobile breakpoint;
- the generator body keeps `overflow-x: hidden`.

- [ ] **Step 5: Run density tests and confirm they fail**

Run: `npm test -- tests/onboarding-ai-generator-density.spec.ts`

Expected: FAIL against the current half-width, vertical progress layout.

- [ ] **Step 6: Implement desktop, tablet, and mobile styling**

Use the full generator width, a horizontal four-column milestone layout on desktop/tablet, and a vertical layout on mobile. Style the roadmap card grid, compact edit panel, reading view, sticky action bar, and overflow disclosure. Avoid fixed widths that clip controls; retain internal scrolling only for long module/source content.

- [ ] **Step 7: Run milestone and density tests**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-density.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/ui/onboarding/ai/ai-job-milestones.tsx src/ui/onboarding/styles.css tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-density.spec.ts
git commit -m "feat: expand guided AI progress layout"
```

### Task 5: Integrated Verification

**Files:**
- Verify only; change files only to correct a discovered regression.

**Interfaces:**
- Consumes: the completed Tasks 1–4.
- Produces: verified production bundle and Docker image; no new application interface.

- [ ] **Step 1: Run all focused UI and lifecycle tests together**

Run: `npm test -- tests/onboarding-ai-outline-ui.spec.ts tests/onboarding-ai-module-workspace.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts tests/onboarding-ai-generator-density.spec.ts`

Expected: PASS.

- [ ] **Step 2: Run strict type checking**

Run: `npm run typecheck:strict-unused`

Expected: exit code `0` with no unused TypeScript symbols.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: all test files and tests pass.

- [ ] **Step 4: Build the production bundle and lint the manifest**

Run: `npm run build`

Expected: Vite build and `privos-app lint privos-app.json` succeed.

- [ ] **Step 5: Rebuild and smoke-test Docker**

Run: `npm run docker:build`

Then start the image on an unused local port, verify `/ready` returns success, and stop the temporary container.

- [ ] **Step 6: Perform browser checks**

Using Chrome DevTools against the local Docker build, verify the normal, advanced, and both-template flows at desktop, 720px tablet, and 390px mobile widths. Confirm no body-level horizontal overflow, no large blank region beside AI progress, no default lesson form, reachable sticky actions, on-demand source selection, resume into the correct step, and joint publication behavior.

- [ ] **Step 7: Inspect the final diff and working tree**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors and no unintended/uncommitted files. Commit only targeted fixes discovered during verification.
