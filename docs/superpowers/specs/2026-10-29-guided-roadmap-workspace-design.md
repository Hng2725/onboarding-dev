# Guided Roadmap Workspace Design

**Date:** 2026-10-29  
**Status:** Proposed  
**Scope:** AI template generator steps 3 and 4

## Problem

The current "Tạo lộ trình" screen mixes roadmap review, source assignment, lesson editing, lesson approval, AI rewriting, and question generation in one dense workspace. Internal identifiers such as `t1-overview` and counters such as `0 nhiệm vụ` make the screen harder to understand. Editing controls are always visible, so an admin who only wants to review content must scan a long form and scroll to find the next action.

The AI progress panel also uses only part of the available width, leaving a large empty area on wide screens.

## Goals

- Make step 3 understandable without prior instruction.
- Make it clear that all listed modules belong to one ordered roadmap; they are not mutually exclusive choices.
- Separate roadmap structure review from lesson and question review.
- Default to a reading experience and reveal editing controls only on demand.
- Reduce visible text, buttons, and vertical scrolling.
- Preserve source assignment, AI rewrite, fallback, and module-management capabilities.
- Use the full modal width efficiently at desktop, tablet, and mobile sizes.

## Non-goals

- Change the generated template schema or module identifiers.
- Change the safe drafting rules for source-less modules.
- Change the approved Template 1 and Template 2 module limits.
- Change the publish order when both templates are selected.

## Terminology

- **Module:** one ordered learning unit in the roadmap.
- **Source sections:** uploaded-document sections assigned to a module.
- **Work responsibilities:** job responsibilities mapped primarily to Template 2 modules. They are not quiz questions.
- **Questions:** quiz questions generated only after lesson content has been approved.

Template 1 must not display a work-responsibility count. Template 2 may display a clearer label such as `2 nhiệm vụ công việc`, and zero must be presented as an actionable warning only when responsibility coverage is required.

## Information Architecture

The five main steps keep their current names:

1. Tài liệu nguồn
2. Phân tích
3. Tạo lộ trình
4. Rà soát
5. Xuất bản

Their responsibilities become explicit:

- Step 3 reviews only the roadmap structure.
- Step 4 reviews lesson content first, then questions.
- Step 5 publishes the approved template or templates.

## Step 3: Guided Roadmap Review

### Default view

Step 3 uses the full content width. It presents the roadmap as an ordered sequence of compact module cards. For Template 1, the initial modules use human-readable titles such as:

1. Tổng quan
2. Tài khoản và quyền truy cập
3. Làm quen giao diện
4. Quy trình công việc chính

Stable technical identifiers such as `t1-overview` remain in data but are not used as the primary user-facing title.

Each card shows only:

- sequence number and module title;
- short description or learning purpose;
- estimated duration;
- source status: `Đủ tài liệu` or `Cần bổ sung tài liệu`;
- review status: `Chưa duyệt` or `Đã duyệt`.

All cards are part of the same roadmap. Selecting a card inspects or edits it; it does not exclude the other cards.

### Primary actions

The persistent footer exposes at most three actions:

- `Thêm module bổ sung`
- `Chỉnh sửa module`
- `Duyệt lộ trình và tiếp tục`

Delete and reorder controls live inside edit mode or an overflow menu. The former `Thêm khung` wording is removed.

### Module editing

Editing opens a compact panel or drawer for the selected module instead of expanding a long form inside the roadmap list. It contains the module name, description, objectives, duration, and advanced module-management actions.

The always-visible `Nguồn và phần tài liệu` fieldset is removed from the main interface. A module that needs more evidence shows one compact action, `Bổ sung tài liệu`. Activating it opens the source selector only when needed. Existing source associations and safe-drafting rules remain unchanged.

### Validation

The primary approval action remains disabled only when a real blocking issue exists. The screen describes the issue in user language, for example:

- `Module này chưa có tài liệu. Hãy bổ sung tài liệu hoặc chọn tự soạn.`
- `Template chuyên sâu chưa bao phủ nhiệm vụ công việc này.`

## Step 4: Reading-first Content Review

Step 4 uses a two-pane workspace:

- a compact, sticky module list on the left;
- an in-app lesson or question preview on the right.

The selected content opens in reading mode, not as an editable form. A sticky action bar remains visible without requiring vertical scrolling.

For lesson review, the main actions are:

- `Duyệt và sang module tiếp theo` as the primary action;
- `Chỉnh sửa` as the secondary action;
- an overflow menu for `Viết lại bằng AI`, `Dùng bản từ nguồn`, and other infrequent actions.

Form inputs appear only after the admin enters edit mode. Once all lessons are approved, the same workspace changes to question review. Question status uses explicit labels such as `0/5 câu hỏi đã duyệt`, never the work-responsibility counter.

## AI Progress

The AI progress component spans the full workspace width and uses four horizontal milestones:

1. Khung lộ trình
2. Nội dung bài học
3. Câu hỏi
4. Sẵn sàng xuất bản

The active milestone displays the current template, module, completed count, current AI action, and elapsed time. Inactive or completed progress collapses into a compact strip so it does not compete with the review workspace.

When both templates are selected, the progress header exposes Template 1 and Template 2 clearly. The admin reviews Template 1 first and then Template 2. Publication still saves and publishes both together.

## Responsive Layout

- Wide desktop: ordered roadmap cards and full-width progress use the available modal width; no half-width empty progress column.
- Tablet: cards wrap into a compact grid and the edit panel overlays or stacks without clipping.
- Mobile: cards become a single vertical list; the sticky footer keeps the primary action reachable.
- No page-level horizontal overflow is allowed at supported viewport widths.

## State and Data Compatibility

This redesign does not rename persisted module IDs or alter generated template data. It changes presentation and navigation only. Source mappings, responsibility mappings, lesson drafts, approval states, questions, retry history, and publish behavior continue to use the existing state model.

Moving the visible lesson workspace from step 3 to step 4 must preserve resumability. Reloading the app returns the admin to the correct template, phase, and selected module.

## Acceptance Criteria

- Template 1 never displays `0 nhiệm vụ`.
- Work-responsibility counts cannot be mistaken for question counts.
- Step 3 explains through layout that all modules belong to one ordered roadmap.
- Step 3 does not show lesson-editing or question-editing forms.
- The long `Nguồn và phần tài liệu` block is absent from the default module view.
- Source supplementation remains available through a compact on-demand action.
- The main roadmap screen exposes no more than three persistent actions.
- Lesson review defaults to an in-app reading view with a persistent approve-and-next action.
- Infrequent lesson actions are consolidated into an overflow menu.
- AI progress uses the full available width and has no large unused right-hand region.
- Both-template review order and joint publication remain unchanged.
- Desktop, tablet, and mobile layouts have no horizontal overflow and do not hide required actions.

## Verification Strategy

- Component tests for Template 1 versus Template 2 labels and counts.
- Component tests for step 3 actions, source-selector disclosure, and approval validation.
- State-transition tests from outline approval to lesson review and then question review.
- Resume tests for each review phase and for both-template mode.
- Responsive layout checks at desktop, tablet, and mobile widths.
- Browser smoke test of the complete Template 1, Template 2, and both-template flows.
