# AI Generator Session Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm thao tác xác nhận xóa phiên tạo template AI, trả modal về bước 1 nhưng giữ nguyên nguồn, đồng thời tự dọn phiên sau khi xuất bản thành công.

**Architecture:** Tách orchestration dọn server vào một helper nhỏ, nhận callback hủy job/xóa draft để kiểm thử độc lập. `AiGeneratorPage` chịu trách nhiệm hộp xác nhận, reload nguồn, xóa resume keys và reset toàn bộ React state; luồng xuất bản chỉ chạy reset cục bộ sau khi mọi target đã xuất bản và export thành công.

**Tech Stack:** React 18, TypeScript, Vitest, `@privos_ai/app-react`, API onboarding hiện có.

**Spec:** `docs/superpowers/specs/2026-10-29-ai-generator-reset-design.md`

## Global Constraints

- Không dùng `window.confirm`; dùng `ConfirmDialog` nội tuyến vì iframe PrivOS không cấp quyền browser modal.
- Không gọi `delete_source` và không xóa file trong `Onboarding-app/Uploaded documents`.
- Không xóa template đã xuất bản.
- Chỉ báo reset thành công sau khi cleanup server, reload nguồn và xóa resume keys hoàn tất.
- Reset phải thử lại an toàn sau một lần cleanup dở dang.

## Review Focus

- Một job xuất hiện ở cả `inventoryJob` và `templateRuns`: chỉ hủy một lần theo `jobId`.
- Reset được thử lại sau khi job đã chuyển sang `cancelled`: vẫn kiểm chứng attempt nền và hoàn tất an toàn.
- Một batch có cả draft và published review: chỉ draft bị xóa.
- API xóa draft hoặc reload nguồn thất bại: modal không xóa state cục bộ và hiển thị lỗi.
- Xuất bản thành công với state review cũ còn mang `draft`: không gọi API xóa draft sau publish.

---

### Task 1: Orchestrator dọn dữ liệu server

**Files:**
- Create: `src/ui/onboarding/ai/ai-generator-reset.ts`
- Create: `tests/onboarding-ai-generator-reset.spec.ts`

**Interfaces:**
- Consumes: `AiJobRecord`, `AdminTemplateDetail`, callback hủy job hiện có và `adminTemplates('delete', ...)`.
- Produces: `resetAiGeneratorServerState(input: AiGeneratorServerResetInput): Promise<void>`.

- [ ] **Step 1: Viết test thất bại cho cleanup server**

Thêm các test khẳng định helper:

- loại trùng job theo `jobId`;
- xử lý `running`, `failed` và `cancelled`, bỏ qua `completed`;
- ném lỗi khi callback trả `unconfirmed > 0` và chưa xóa draft;
- chỉ xóa review có `status === 'draft'`, loại trùng theo `id:version`;
- có thể chạy lại khi job đã `cancelled`;
- dừng và truyền nguyên lỗi khi xóa draft thất bại.

- [ ] **Step 2: Chạy test để xác nhận RED**

Run: `npm test -- tests/onboarding-ai-generator-reset.spec.ts`

Expected: FAIL vì module/helper chưa tồn tại.

- [ ] **Step 3: Cài đặt helper tối thiểu**

Trong `ai-generator-reset.ts`, định nghĩa:

```ts
export interface AiGeneratorServerResetInput {
  readonly jobs: readonly AiJobRecord[];
  readonly reviews: readonly AdminTemplateDetail[];
  readonly cancelJob: (job: AiJobRecord) => Promise<{ readonly unconfirmed: number }>;
  readonly deleteDraft: (review: AdminTemplateDetail) => Promise<void>;
}

export async function resetAiGeneratorServerState(
  input: AiGeneratorServerResetInput,
): Promise<void>;
```

Hủy tuần tự các job duy nhất có trạng thái `running`, `failed` hoặc `cancelled`; nếu còn attempt chưa xác nhận thì ném lỗi có thể hiển thị cho Admin. Chỉ sau khi mọi job sạch mới xóa tuần tự các draft duy nhất; không xử lý review `published`/`archived`.

- [ ] **Step 4: Chạy test để xác nhận GREEN**

Run: `npm test -- tests/onboarding-ai-generator-reset.spec.ts`

Expected: toàn bộ test trong file PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/onboarding/ai/ai-generator-reset.ts tests/onboarding-ai-generator-reset.spec.ts
git commit -m "feat: add AI generator session cleanup"
```

### Task 2: Nút reset, xác nhận và giữ nguồn

**Files:**
- Modify: `src/ui/onboarding/ai/ai-generator.tsx`
- Modify: `src/ui/onboarding/components.tsx`
- Modify: `src/ui/onboarding/styles.css`
- Modify: `tests/onboarding-ai-generator-lifecycle.spec.ts`
- Modify: `tests/onboarding-admin-ui.spec.ts`

**Interfaces:**
- Consumes: `resetAiGeneratorServerState(input)` từ Task 1, `cancelRunningAiJob`, `ConfirmDialog`, `clearAiResumeKeys`, `loadSources()`.
- Produces: thao tác UI **Xóa dữ liệu** và reset local state về bước 1.

- [ ] **Step 1: Viết test UI thất bại cho nút và hộp xác nhận**

Trong `onboarding-ai-generator-lifecycle.spec.ts`, kiểm tra:

- modal tạo mới có nút **Xóa dữ liệu**, còn modal `initialTemplate` không có;
- bấm nút mở `ConfirmDialog`; bấm **Hủy** không gọi API và không đổi bước;
- xác nhận khóa nút với nhãn **Đang xóa…**;
- xác nhận thành công gọi `cancel_job`/cleanup cho job hiện tại, gọi `adminTemplates('delete')` cho draft, xóa toàn bộ resume keys của room/user, quay về **Tài liệu nguồn** và vẫn hiển thị/chọn lại nguồn cũ;
- API cleanup hoặc `list_sources` thất bại giữ nguyên bước/state và hiển thị lỗi;
- một source panel đang có form ghi chú dở được remount sạch sau reset nhưng source đã lưu vẫn còn.

Trong `onboarding-admin-ui.spec.ts`, thêm test cho kiểu hiển thị danger của `ConfirmDialog` mà không làm đổi mặc định của các dialog hiện có.

- [ ] **Step 2: Chạy test để xác nhận RED**

Run: `npm test -- tests/onboarding-ai-generator-lifecycle.spec.ts tests/onboarding-admin-ui.spec.ts`

Expected: FAIL vì chưa có nút reset, prop danger và hành vi cleanup.

- [ ] **Step 3: Mở rộng `ConfirmDialog` cho thao tác nguy hiểm**

Thêm prop tùy chọn `danger?: boolean`; khi đúng, nút xác nhận dùng class `button button-danger`, mặc định vẫn là `button button-primary`. Thêm CSS màu danger, focus/disabled đồng nhất với button hiện tại.

- [ ] **Step 4: Cài đặt state và handler reset trong `AiGeneratorPage`**

Thêm `resetConfirmOpen`, `resetting`, `sourcePanelEpoch`. Handler xác nhận phải:

1. gom job/review của phiên hiện tại;
2. gọi `resetAiGeneratorServerState` với `cancelRunningAiJob` và `api.adminTemplates('delete', ...)`;
3. gọi `loadSources()`;
4. xóa các key `inventory`, legacy/per-kind template, publish, selection, responsibilities và module;
5. reset toàn bộ state tạo template (`step = 0`, metadata, inventory, runs, selection, title, responsibilities, publish, review/navigation/editor/error), tăng epoch và chọn mọi source vừa reload;
6. hiển thị thông báo thành công; nếu lỗi thì giữ state hiện tại và hiển thị lỗi.

- [ ] **Step 5: Thêm nút và hộp xác nhận**

Chỉ render nút ở modal tạo mới (`!initialTemplate`). Nút nằm bên trái footer, dùng `DeleteOutlined`, class danger và bị khóa khi `busy || resetting`. Render `ConfirmDialog` với copy đã duyệt và `danger`.

- [ ] **Step 6: Chạy test để xác nhận GREEN**

Run: `npm test -- tests/onboarding-ai-generator-lifecycle.spec.ts tests/onboarding-admin-ui.spec.ts tests/onboarding-ai-generator-reset.spec.ts`

Expected: tất cả PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/onboarding/ai/ai-generator.tsx src/ui/onboarding/components.tsx src/ui/onboarding/styles.css tests/onboarding-ai-generator-lifecycle.spec.ts tests/onboarding-admin-ui.spec.ts
git commit -m "feat: reset AI template creation safely"
```

### Task 3: Tự dọn phiên sau khi xuất bản thành công

**Files:**
- Modify: `src/ui/onboarding/ai/ai-generator.tsx`
- Modify: `tests/onboarding-ai-admin-ui.spec.ts`
- Modify: `tests/onboarding-ai-generator-lifecycle.spec.ts`

**Interfaces:**
- Consumes: local reset callback và danh sách resume keys từ Task 2.
- Produces: `finishSuccessfulAiPublish` gọi theo thứ tự clear resume → reset local → refresh → close.

- [ ] **Step 1: Viết test thất bại cho cleanup sau publish**

Mở rộng test `finishSuccessfulAiPublish` để yêu cầu thứ tự `clear`, `reset`, `refresh`, `close`, và không callback nào chạy khi một target chưa hoàn tất. Thêm lifecycle test mở lại modal sau publish: bước đầu là **Tài liệu nguồn**, nguồn cũ vẫn được load/chọn, không gọi `delete_source` hay xóa template published.

- [ ] **Step 2: Chạy test để xác nhận RED**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts`

Expected: FAIL vì callback reset sau publish chưa tồn tại.

- [ ] **Step 3: Cài đặt cleanup sau publish**

Mở rộng callbacks của `finishSuccessfulAiPublish` với `resetSession: () => void`. Chỉ khi mọi target đã `completed`, có `preparedReview`, `publishedTemplate.status === 'published'`, JSON đã export và target keys khớp thì chạy: `clearResume()`, `resetSession()`, `onComplete()`, `onClose()`. `resetSession` chỉ reset local state; tuyệt đối không gọi cleanup server/xóa draft sau publish.

- [ ] **Step 4: Chạy test tập trung để xác nhận GREEN**

Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts tests/onboarding-ai-generator-reset.spec.ts`

Expected: tất cả PASS.

- [ ] **Step 5: Chạy kiểm tra toàn dự án**

Run: `npm test`

Expected: 0 test failures.

Run: `npm run typecheck:strict-unused`

Expected: exit code 0.

Run: `npm run build`

Expected: exit code 0 và manifest hợp lệ.

- [ ] **Step 6: Commit**

```bash
git add src/ui/onboarding/ai/ai-generator.tsx tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-ai-generator-lifecycle.spec.ts docs/superpowers/specs/2026-10-29-ai-generator-reset-design.md docs/superpowers/plans/2026-10-29-ai-generator-reset.md
git commit -m "fix: clear AI generator state after publish"
```

