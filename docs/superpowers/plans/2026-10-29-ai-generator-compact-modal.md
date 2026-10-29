# AI Generator Compact Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Làm modal “Tạo template từ tài liệu” gần phủ viewport và thu gọn typography, control, khoảng cách để Admin xem được nhiều nội dung hơn mà không mất khả năng đọc hoặc thao tác.

**Architecture:** Giữ nguyên component tree và toàn bộ luồng AI; chỉ điều chỉnh CSS trong `styles.css`, scope dưới `.ai-generator-panel`. Một regression test đọc stylesheet sẽ khóa các kích thước desktop, vùng review, wrapping/overflow và fallback mobile; sau đó xác nhận bằng build Docker và Chrome live trên PrivOS.

**Tech Stack:** React 18, TypeScript, CSS, Vitest, Vite, Docker Compose, Chrome DevTools

**Spec:** `docs/superpowers/specs/2026-10-29-ai-generator-compact-modal-design.md`

## Global Constraints

- Không đổi component hierarchy, nội dung, state machine, AI provider, Roomfiles hoặc publication flow.
- Không dùng CSS `transform: scale()` hoặc browser zoom.
- Mọi thay đổi density phải được scope dưới `.ai-generator-panel`; không làm nhỏ các màn hình Onboarding khác.
- Desktop dùng font nội dung khoảng 13px và control cao tối thiểu 34px; không thêm explicit font-size dưới 12px.
- Mobile ở breakpoint tối đa 700px vẫn là modal full-screen, bố cục một cột và không có horizontal overflow.
- Giữ nguyên focus ring, keyboard navigation và các vùng review có thể focus hiện tại.

## Review Focus

- Viewport desktop rộng 1770px: panel phải gần phủ chiều ngang thay vì bị giới hạn ở 1440px, nhưng vẫn có max-width hợp lý trên màn hình cực rộng.
- Viewport thấp: header, step bar và footer không được đẩy phần nội dung chính ra ngoài; panel phải dùng `100dvh` với fallback `100vh`.
- Label nút dài và nhóm action: phải wrap, không cắt chữ và không tạo horizontal scrollbar.
- Danh sách module/nội dung lesson dài: sidebar và review region phải tự cuộn độc lập, toolbar hành động vẫn ở ngoài vùng nội dung cuộn.
- Mobile ≤700px: panel phải full-screen, module workspace về một cột, text không nhỏ hơn 12px và control vẫn dễ bấm.

---

### Task 1: Compact AI Generator modal with responsive regression coverage

**Files:**
- Create: `tests/onboarding-ai-generator-density.spec.ts`
- Modify: `src/ui/onboarding/styles.css:492-507,1169-1203`
- Modify: `docs/superpowers/specs/2026-10-29-ai-generator-compact-modal-design.md`

**Interfaces:**
- Consumes: các class CSS hiện có `.ai-generator-backdrop`, `.ai-generator-panel`, `.ai-generator-header`, `.ai-generator-steps`, `.ai-generator-body`, `.ai-generator-footer`, `.ai-module-workspace`, `.ai-review-scroll`, `.ai-review-toolbar`.
- Produces: không có API mới; chỉ thay đổi presentation contract được regression test khóa lại.

- [ ] **Step 1: Viết regression test đang fail cho desktop density**

  Tạo `tests/onboarding-ai-generator-density.spec.ts`, đọc `src/ui/onboarding/styles.css` và thêm test `uses a near-viewport compact desktop modal` với các assertion:

  - `.ai-generator-backdrop` có `padding: 8px`.
  - `.ai-generator-panel` có `width: min(1920px, calc(100vw - 16px))`, fallback `height: calc(100vh - 16px)`, dynamic height `height: calc(100dvh - 16px)`, `font-size: 13px`, và không chứa `transform: scale`.
  - header/body/footer/step bar dùng các padding compact đã chốt: header `12px 16px`, steps `8px 16px`, body `12px 14px`, footer `8px 14px`.
  - button trong panel có `min-height: 34px`, font `13px`, được phép wrap; input/select/textarea dùng font `13px`.

- [ ] **Step 2: Bổ sung regression test đang fail cho workspace, overflow và mobile**

  Trong cùng file, thêm các test:

  - `keeps long review content usable without widening the modal`: sidebar là `200px`, workspace gap `12px`, `.ai-review-scroll` có `max-height: 54dvh`, `overflow: auto`, `.ai-module-actions` có `flex-wrap: wrap`, và panel/workspace không tạo horizontal overflow.
  - `preserves the full-screen single-column mobile layout`: trong `@media (max-width: 700px)`, backdrop trở về `padding: 0`, panel là `width: 100%` và `height: 100dvh`, workspace là một cột, font không bị override xuống dưới 13px, và control vẫn có min-height 34px.
  - `keeps review focus and sticky actions intact`: `.ai-review-scroll:focus-visible` vẫn có outline và `.ai-review-toolbar` vẫn `position: sticky`.

- [ ] **Step 3: Chạy test mới để xác nhận nó fail vì CSS cũ**

  Run: `npm test -- tests/onboarding-ai-generator-density.spec.ts`

  Expected: FAIL ở các giá trị cũ như backdrop 18px, panel max 1440px, review 40vh và workspace gap 20px.

- [ ] **Step 4: Triển khai CSS compact tối thiểu để test pass**

  Trong `src/ui/onboarding/styles.css`:

  - Mở panel desktop lên gần toàn viewport với khoảng thở 8px, max-width 1920px, fallback `100vh` trước `100dvh`, và giảm border-radius vừa phải.
  - Scope font/line-height và control density trong `.ai-generator-panel`; close button còn vùng bấm tối thiểu 34px.
  - Thu header, steps, body, footer, module cards, editor panels, toolbar, fieldset và action gaps theo các giá trị trong test; giữ button wrap và dùng `min-width: 0`/`overflow-x: hidden` tại container cần thiết.
  - Đặt module sidebar 200px, gap 12px; tăng lesson/question review lên 54dvh và outline review lên 56dvh; giữ sidebar/review cuộn độc lập và toolbar sticky.
  - Trong breakpoint tối đa 700px, giữ full-screen bằng `100vh` + `100dvh`, workspace một cột, typography 13px và control tối thiểu 34px.

- [ ] **Step 5: Cập nhật trạng thái tài liệu thiết kế**

  Đổi `Trạng thái: Chờ duyệt` thành `Trạng thái: Đã duyệt` trong spec; không thay đổi phạm vi hoặc quyết định A đã chốt.

- [ ] **Step 6: Chạy focused tests**

  Run: `npm test -- tests/onboarding-ai-generator-density.spec.ts tests/onboarding-visual-theme.spec.ts tests/onboarding-ai-module-workspace.spec.ts`

  Expected: toàn bộ test PASS; visual-theme vẫn xác nhận không có explicit font-size dưới 12px và module workspace vẫn giữ hai region có thể focus.

- [ ] **Step 7: Chạy verification toàn project**

  Run: `npm run typecheck:strict-unused`

  Expected: exit code 0.

  Run: `npm test`

  Expected: toàn bộ suite PASS.

  Run: `npm run build`

  Expected: Vite build, manifest generation và manifest lint đều exit code 0; cảnh báo chunk size hiện hữu được ghi nhận nhưng không xem là lỗi.

- [ ] **Step 8: Rebuild Docker và live-check trên PrivOS**

  Run: `docker compose up -d --build app`

  Expected: container `app` healthy và endpoint `/ready` trả `ok: true`.

  Trên tab Chrome PrivOS hiện tại, reload app và mở AI Generator tới bước “Tạo lộ trình”. Kiểm tra ở desktop và viewport ≤700px:

  - panel gần phủ viewport, không còn giới hạn hẹp 1440px ở màn hình 1770px;
  - nhìn thấy nhiều module và nội dung review hơn ảnh ban đầu;
  - không có horizontal scrollbar hoặc label bị cắt;
  - sidebar/review tự cuộn, action toolbar còn thấy và focus ring còn hoạt động;
  - mobile full-screen, workspace một cột và control vẫn dễ bấm.

  Chụp số đo bounding box/screenshot làm bằng chứng; nếu live check phát hiện overflow thì chỉ chỉnh CSS trong phạm vi task và chạy lại Steps 6–8.

- [ ] **Step 9: Commit thay đổi**

  ```bash
  git add src/ui/onboarding/styles.css tests/onboarding-ai-generator-density.spec.ts docs/superpowers/specs/2026-10-29-ai-generator-compact-modal-design.md
  git commit -m "fix: compact AI generator modal layout"
  ```

