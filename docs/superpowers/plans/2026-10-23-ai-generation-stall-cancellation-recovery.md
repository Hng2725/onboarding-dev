# AI Template Generation Stall and Cancellation Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Làm cho luồng tạo template bằng AI luôn đi tới một trạng thái rõ ràng (`completed`, `failed` hoặc `cancelled`), hủy được attempt thật ở PrivOS, retry không đụng attempt cũ, và không còn kẹt lâu ở các lần sửa nguyên khối như `B-lessons-r2`.

**Architecture:** Server tiếp tục sở hữu state machine, prompt, validation và materialization; browser chỉ dispatch/poll provider. Mỗi call sẽ lưu provider cùng trạng thái cleanup, một coordinator riêng sẽ hủy rồi xác nhận trạng thái terminal mà không chặn lúc mở modal, và giai đoạn tạo template sẽ được chia thành outline cùng các call bài học/câu hỏi theo module để mọi repair chỉ sửa một phần nhỏ.

**Tech Stack:** Node.js 22, TypeScript, React 18, Vitest, PrivOS MCP App SDK, App Database, Docker Compose, Chrome DevTools.

**Spec:** `docs/superpowers/specs/onboarding-ai-implementation-spec.md`

**Content rules:** `docs/superpowers/specs/onboarding-templates.md`, đặc biệt mục 2, 5–10, 14 và 16.

## Global Constraints

- Tạm dừng implementation cho đến khi người dùng duyệt plan này.
- Không commit hoặc push; cuối mỗi task dùng diff và progress ledger làm checkpoint.
- Giữ nguyên mọi thay đổi đang có trong working tree; không reset hoặc ghi đè phần không thuộc lỗi này.
- Mọi dữ liệu, attempt và thao tác phải được ràng buộc theo room và actor; chỉ Admin được điều khiển job.
- Browser không được tự dựng prompt, tự validate, tự materialize hoặc bỏ qua bước do server cấp.
- Không ghi prompt, tài liệu nguồn, output AI đầy đủ, secret hoặc đáp án vào log/telemetry; chỉ lưu metadata kích thước, thời gian, provider và mã lỗi.
- Không redispatch khi chưa biết request cũ đã tới provider hay chưa; `attemptRef` đã lưu phải được adopt và poll tiếp.
- Timeout áp dụng cho từng call, tối đa 15 phút/call; hết hạn phải thành `AI_TIMEOUT`, không để spinner vô hạn.
- Giữ nguyên luồng template cũ `final_exam`, assignment đã tồn tại và DTO an toàn cho learner.
- Không thêm scope PrivOS mới nếu các endpoint hiện tại `agents.sandbox.*` và `ai-messages.*` đã đủ.

## Review Focus

- Cancel request timeout nhưng provider đã terminal: phải reconcile thành `confirmed`, không chặn retry; test ở Task 2.
- Cancel request timeout và provider vẫn `running`: phải lưu `unknown`, không khởi chạy Native attempt mới; test ở Task 3.
- Refresh khi call đã có `attemptRef`: phải poll attempt cũ, không gọi `startGeneration` lần hai; test ở Task 5.
- Output một module sai cấu trúc: chỉ repair module đó, không yêu cầu model trả lại toàn bộ template; test ở Task 4.
- Job/attempt cũ của room hoặc user khác: không được cancel, adopt hoặc làm modal hiện tại bị kẹt; test ở Task 2 và Task 3.

---

## Incident Snapshot at Planning Time

### Trạng thái đã xác minh

- Bản đang chạy là `2.19.6`; full suite gần nhất pass 367/367, strict typecheck, production build, preflight và Docker build đều pass.
- Sandbox có thể dispatch sau khi cấp `sandbox:generate`, nhưng các call tạo template thực tế thường kết thúc `AI_FAILED`.
- Native AI Chat fallback đã chạy được bằng `ai-messages.send` → `ai-messages.startGeneration` → poll `ai-messages.list`.
- Lỗi cũ đã tái hiện: bấm Hủy chỉ dừng browser pump nên lần Native kế tiếp bị `Another request in this project is still running`.
- Bản `2.19.6` đã gọi `ai-messages.cancel` hoặc `agents.sandbox.attempt-cancel`; sau cleanup, `A1-retry1` Native đã khởi chạy mà không còn lỗi concurrent ngay lập tức và hoàn tất sau khoảng 4–5 phút.
- Lần QA gần nhất đi đến `B-lessons-r2`, vẫn chạy sau khoảng 9–10 phút. Theo yêu cầu hiện tại, job đã được bấm Hủy và không tiếp tục test.

### Chưa được chứng minh

- Chưa có bằng chứng provider của attempt vừa hủy đã thực sự chuyển sang terminal; hiện UI chỉ biết server job đã bị hủy.
- Chưa có một template thật hoàn tất toàn bộ B/C → D → review → publish trên Chrome.
- Chưa xác định chính xác tỷ trọng giữa ba nguyên nhân: độ lớn prompt/output repair, Native provider chậm, hay polling/cancel bridge không phản ánh đúng trạng thái.
- Cleanup orphan hiện chạy trước khi khôi phục job trong modal, nên có thể làm màn hình mở chậm.
- `B-lessons-r2` vẫn yêu cầu model sửa và trả lại một output lớn; đây là giả thuyết kỹ thuật mạnh nhất cho độ trễ nhưng phải được đo bằng metadata, không suy đoán từ spinner.
- Readiness hiện còn manifest drift: local digest `sha256:39b7784d998b3b148727bd1d32ec6f4319cd53e0f5786f4e71d1be6973628136`, pinned digest `sha256:e7a4708ee6538570bf6dd719b893ea304a686117c83071793ef3a914c655e574`.

### Không được báo là đã fix cho đến khi

- Cancel Native và Sandbox đều có terminal confirmation hoặc trạng thái `unknown` minh bạch.
- Retry sau cancel không tạo concurrent-request error.
- Refresh giữa call không dispatch trùng.
- Một Template 1 thật hoàn tất, review được, publish được và gán cho learner.
- Ma trận Chrome ở Task 8 có bằng chứng pass.

## File Structure

- `src/onboarding/contracts.ts`: kiểu provider, cleanup và diagnostic metadata được lưu trên từng AI call.
- `src/onboarding/ai/jobs.ts`: state machine, call planning theo module, server-side transition và idempotency.
- `src/onboarding/ai/prompts.ts`: prompt outline, bài học/câu hỏi theo module và repair có phạm vi nhỏ.
- `src/onboarding/ai/validate.ts`: validator cho outline, module lessons, module questions và template đã assemble.
- `src/onboarding/tools.ts`: action ghi kết quả cleanup từ browser về server.
- `src/ui/onboarding/ai/ai-attempt-lifecycle.ts` (mới): cancel + terminal reconciliation dùng chung cho Sandbox và Native.
- `src/ui/onboarding/ai/ai-gateway-sandbox.ts`: transport Sandbox; không chứa orchestration UI.
- `src/ui/onboarding/ai/ai-gateway-native-chat.ts`: transport Native AI Chat; parse attempt ref và map trạng thái.
- `src/ui/onboarding/ai/ai-pump.ts`: adopt/poll/timeout một call, không quản lý modal.
- `src/ui/onboarding/ai/ai-generator.tsx`: hiển thị, điều khiển job và gọi lifecycle coordinator; không chờ cleanup orphan trước khi render job.
- `tests/ai-attempt-lifecycle.spec.ts` (mới): cancel/reconcile theo fake clock.
- `tests/ai-generation-recovery.spec.ts` (mới): regression tích hợp cho cancel → refresh/retry → hoàn tất.
- Các test hiện có được mở rộng tại đúng lớp sở hữu hành vi; không gom tất cả vào một test UI.

## Chosen Recovery Approach

Ba phương án đã được cân nhắc:

1. **Chỉ tăng timeout:** thay đổi ít nhưng giữ nguyên output nguyên khối, spinner dài và repair không ổn định. Không chọn.
2. **Giữ call nguyên khối, chỉ cải thiện cancel:** giải quyết conflict sau Hủy nhưng không giải quyết `B-lessons-r2` dài và output invalid lặp lại. Không chọn.
3. **Lifecycle xác nhận + trạng thái cleanup lưu bền + generation theo module:** thay đổi nhiều hơn nhưng tách đúng hai lỗi độc lập, cho phép resume chính xác và giới hạn phạm vi repair. Chọn phương án này.

---

### Task 1: Persist Provider and Privacy-Safe Call Diagnostics

**Files:**

- Modify: `src/onboarding/contracts.ts:144-179`
- Modify: `src/onboarding/ai/jobs.ts:274-312, 1159-1197`
- Modify: `src/onboarding/tools.ts:477-482`
- Modify: `src/ui/onboarding/ai/ai-pump.ts:90-120`
- Test: `tests/ai-contracts.spec.ts`
- Test: `tests/ai-jobs.spec.ts`
- Test: `tests/onboarding-tools.spec.ts`
- Test: `tests/ai-pump.spec.ts`

**Interfaces:**

- Produces: `type AiProvider = 'sandbox' | 'native_chat'`.
- Produces: optional `AiCallRecord.provider`, `promptChars`, `systemContextChars`, `cleanupState`, `cleanupMessage`, `cleanupUpdatedAt`.
- Changes: `RecordDispatchInput` nhận `provider: AiProvider`; server tự tính kích thước prompt/context, không tin số liệu do browser gửi.
- Compatibility: record cũ thiếu các field mới vẫn đọc được; provider cũ chỉ được suy ra từ prefix `native-chat:` ở nhánh migration.

- [ ] **Step 1: Viết test RED cho metadata call**

  Thêm các test có tên:

  - `records provider and server-computed request sizes without storing prompt text`
  - `keeps legacy calls without provider readable`
  - `rejects an unknown provider at the tool boundary`

  Assertion bắt buộc: persisted call có `provider`, hai độ dài dạng number, và không có field chứa prompt/system context thô.

- [ ] **Step 2: Chạy test để xác nhận RED**

  Run: `npm test -- tests/ai-contracts.spec.ts tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts tests/ai-pump.spec.ts`

  Expected: FAIL vì `AiProvider` và `provider` chưa tồn tại trong dispatch contract.

- [ ] **Step 3: Thêm contract và ghi metadata tối thiểu**

  Mở rộng `AiCallRecord` bằng field optional để không cần migration dữ liệu. Trong `recordDispatch()`, gọi lại `promptFor()` để server tính `promptChars` và `systemContextChars`; chỉ lưu số đo và provider.

- [ ] **Step 4: Truyền provider từ pump**

  Thêm `readonly provider: AiProvider` vào `PumpAiJobOptions`; `AiGeneratorPage.pump()` truyền `sandbox` hoặc `native_chat` đúng gateway đã chọn.

- [ ] **Step 5: Chạy GREEN và typecheck**

  Run: `npm test -- tests/ai-contracts.spec.ts tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts tests/ai-pump.spec.ts`

  Expected: PASS.

  Run: `npm run typecheck:strict-unused`

  Expected: PASS.

- [ ] **Step 6: Checkpoint không commit**

  Ghi quyết định và kết quả test vào `.superpowers/sdd/2026-10-23-onboarding-ai-generation/progress.md`; kiểm tra `git diff --check`.

### Task 2: Cancel and Confirm Provider Attempts

**Files:**

- Create: `src/ui/onboarding/ai/ai-attempt-lifecycle.ts`
- Modify: `src/ui/onboarding/ai/ai-gateway-sandbox.ts:3-21, 97-115`
- Modify: `src/ui/onboarding/ai/ai-gateway-native-chat.ts:81-110, 185-238`
- Create: `tests/ai-attempt-lifecycle.spec.ts`
- Modify: `tests/ai-gateway.spec.ts`
- Modify: `tests/ai-gateway-native-chat.spec.ts`

**Interfaces:**

- Consumes: `AiGateway.cancel()` và `AiGateway.status()`.
- Produces:

  ```ts
  export type AiCancellationOutcome =
    | { readonly state: 'confirmed'; readonly terminalState: 'cancelled' | 'completed' | 'failed' }
    | { readonly state: 'unknown'; readonly message: string };

  export function cancelAndConfirmAttempt(
    gateway: AiGateway,
    attemptRef: string,
    options?: AiCancellationOptions,
  ): Promise<AiCancellationOutcome>;
  ```

- Policy: poll mỗi 1 giây, tối đa 15 giây; `completed`, `failed` và `cancelled` đều là terminal an toàn.

- [ ] **Step 1: Viết test RED cho state machine cancel**

  Bao phủ đúng năm trường hợp:

  - attempt đã `completed` trước khi cancel → `confirmed/completed`, không POST cancel;
  - POST cancel thành công rồi status `cancelled` → `confirmed/cancelled`;
  - POST cancel timeout nhưng status kế tiếp `cancelled` → vẫn `confirmed/cancelled`;
  - POST cancel lỗi và status vẫn `running` hết 15 giây → `unknown`;
  - AbortSignal bị abort → dừng poll ngay với `AbortError`.

- [ ] **Step 2: Chạy test để xác nhận RED**

  Run: `npm test -- tests/ai-attempt-lifecycle.spec.ts tests/ai-gateway.spec.ts tests/ai-gateway-native-chat.spec.ts`

  Expected: FAIL vì coordinator và typed outcome chưa tồn tại.

- [ ] **Step 3: Implement coordinator với fakeable clock**

  `AiCancellationOptions` nhận `timeoutMs`, `pollIntervalMs`, `now` và `wait` để test không sleep thật. Không đặt retry logic này trong hai gateway.

- [ ] **Step 4: Chuẩn hóa gateway terminal state**

  Sandbox tiếp tục dùng `agents.sandbox.attempt-cancel/status`; Native dùng `ai-messages.cancel/list`. Cả hai phải fail closed khi room/session/message không khớp và không đưa response thô vào lỗi UI.

- [ ] **Step 5: Chạy GREEN và typecheck**

  Run: `npm test -- tests/ai-attempt-lifecycle.spec.ts tests/ai-gateway.spec.ts tests/ai-gateway-native-chat.spec.ts`

  Expected: PASS.

  Run: `npm run typecheck:strict-unused`

  Expected: PASS.

- [ ] **Step 6: Checkpoint không commit**

  Ghi trạng thái test và interface cuối cùng vào progress ledger; chạy `git diff --check`.

### Task 3: Persist Cleanup State and Make Recovery Non-Blocking

**Files:**

- Modify: `src/onboarding/ai/jobs.ts:303-313, 1280-1370`
- Modify: `src/onboarding/tools.ts:499-504`
- Modify: `privos-app.json` only for the existing tool action schema
- Modify: `src/ui/onboarding/ai/ai-generator.tsx:209-247, 354-390, 576-615`
- Test: `tests/ai-jobs.spec.ts`
- Test: `tests/onboarding-tools.spec.ts`
- Test: `tests/manifest.spec.ts`
- Test: `tests/onboarding-ai-admin-ui.spec.ts`

**Interfaces:**

- Produces: `RecordAttemptCleanupInput { jobId, callId, attemptRef, state: 'confirmed' | 'unknown', message? }`.
- Produces: `AiJobService.recordAttemptCleanup(actor, input): Promise<AiJobRecord>`.
- Produces: tool action `record_attempt_cleanup`.
- Produces: `selectBlockingNativeCleanup(jobs): AiCallRecord | undefined`.
- Rule: `cancelJob()` đặt `cleanupState: 'pending'` cho call `dispatched`; chỉ exact `jobId/callId/attemptRef` được cập nhật kết quả.

- [ ] **Step 1: Viết test RED cho server transitions**

  Thêm test:

  - cancel job marks only dispatched attempts `pending`;
  - exact attempt can transition `pending → confirmed|unknown`;
  - stale/different attemptRef returns `JOB_CALL_MISMATCH`;
  - actor khác room/Admin không cập nhật được cleanup;
  - repeated identical report is idempotent.

- [ ] **Step 2: Chạy server tests để xác nhận RED**

  Run: `npm test -- tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts tests/manifest.spec.ts`

  Expected: FAIL ở action và transition mới.

- [ ] **Step 3: Implement server action và manifest schema**

  Không thêm collection. Dùng chính `onboarding_ai_jobs.calls[]`; message chỉ lưu mã/lý do đã sanitize, tối đa 500 ký tự.

- [ ] **Step 4: Viết test RED cho UI recovery**

  Thêm test:

  - modal chọn và render resumable job trước khi orphan cleanup promise resolve;
  - cancel aborts local poll, cancels server, reconcile provider, rồi report kết quả;
  - `unknown` Native cleanup khóa dispatch Native mới và hiện nút `Kiểm tra lại trạng thái`;
  - confirmed cleanup mở lại retry;
  - attempt của user khác không chặn modal và không bị đánh dấu confirmed giả.

- [ ] **Step 5: Tách cleanup khỏi blocking startup**

  Trong effect mở modal: `list_jobs` → chọn/set job/step ngay; sau đó chạy reconciliation nền bằng một AbortController riêng. Không `await cancelOrphanedNativeAttempts()` trước `selectResumableAiJobs()`.

- [ ] **Step 6: Thay cleanup kiểu fire-and-forget bằng persisted reconciliation**

  `cancelRunningAiJob()` dùng `cancelAndConfirmAttempt()`, gọi `record_attempt_cleanup` cho từng attempt và trả job mới nhất. Xóa helper cũ khi không còn call site.

- [ ] **Step 7: Chạy GREEN và typecheck**

  Run: `npm test -- tests/ai-jobs.spec.ts tests/onboarding-tools.spec.ts tests/manifest.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/ai-attempt-lifecycle.spec.ts`

  Expected: PASS.

  Run: `npm run typecheck:strict-unused`

  Expected: PASS.

- [ ] **Step 8: Checkpoint không commit**

  Cập nhật progress ledger và chạy `git diff --check`.

### Task 4: Replace Monolithic Template Repairs with Module-Scoped Calls

**Files:**

- Modify: `src/onboarding/ai/prompts.ts:104-200`
- Modify: `src/onboarding/ai/validate.ts`
- Modify: `src/onboarding/ai/jobs.ts:621-766` and template call planning/processing
- Modify: `src/onboarding/ai/limits.ts`
- Modify: `docs/ai-generation-spikes.md`
- Test: `tests/ai-prompts.spec.ts`
- Test: `tests/ai-validate.spec.ts`
- Test: `tests/ai-jobs.spec.ts`
- Test: `tests/ai-limits.spec.ts`

**Interfaces:**

- Produces: `GeneratedTemplateOutline`, `GeneratedModuleLessons`, `GeneratedModuleQuestions`.
- Produces:

  ```ts
  buildTemplateOutlinePrompt(input: TemplatePromptInput): AiPromptRequest;
  buildModuleLessonsPrompt(input: ModuleLessonsPromptInput): AiPromptRequest;
  buildModuleQuestionsPrompt(input: ModuleQuestionsPromptInput): AiPromptRequest;
  assembleGeneratedTemplate(input: GeneratedTemplateParts): GeneratedTemplate;
  ```

- Call IDs:
  - normal: `B-outline`, `B-m01-lessons`, `B-m01-questions`, …;
  - advanced: `C-outline`, `C-m01-lessons`, `C-m01-questions`, …;
  - repair: append `-r1` or `-r2` to the exact failed unit;
  - manual provider retry remains `-retryN` and never reuses an old `operationId`.

- [ ] **Step 1: Viết prompt/validator tests RED**

  Các test phải chứng minh:

  - outline chứa 4–8 module với stable `localId/frameKey`, không chứa blocks/questions;
  - lesson call chỉ nhận một outline module và các inventory feature mà module tham chiếu;
  - question call chỉ nhận module lessons tương ứng;
  - module repair prompt chứa output của đúng module, không chứa output module khác;
  - assemble giữ thứ tự outline và từ chối thiếu/trùng module.

- [ ] **Step 2: Chạy prompt tests để xác nhận RED**

  Run: `npm test -- tests/ai-prompts.spec.ts tests/ai-validate.spec.ts tests/ai-limits.spec.ts`

  Expected: FAIL vì các type/builder/validator mới chưa tồn tại.

- [ ] **Step 3: Implement prompt và validator theo module**

  Giữ nguyên luật nội dung trong spec. Scope inventory bằng `featureIds`; luôn giữ evidence/flag liên quan. Advanced outline vẫn phải tạo đủ `taskCoverage` và missing flags cho trách nhiệm không có bằng chứng.

- [ ] **Step 4: Viết job tests RED cho dynamic call planning**

  Bao phủ:

  - valid outline lập đúng call lessons theo thứ tự;
  - mỗi lessons hợp lệ lập question call cùng module;
  - một module invalid chỉ lập repair call của module đó;
  - hai repair thất bại làm job `AI_OUTPUT_INVALID`;
  - refresh giữa các module trả lại attemptRef của call hiện tại;
  - assemble xong mới lập verification batches D;
  - materialization vẫn idempotent.

- [ ] **Step 5: Implement state machine mới**

  Persist từng phần trong `stageOutputs` bằng key ổn định (`outline`, `lessons:<moduleLocalId>`, `questions:<moduleLocalId>`). Không giữ một full-template repair path cho job mới; job cũ có `B-lessons/B-questions` vẫn resume theo legacy branch để không phá dữ liệu đang tồn tại.

- [ ] **Step 6: Đặt giới hạn có thể kiểm chứng**

  Mỗi prompt module phải nằm trong `maxPromptChars/maxSystemContextChars`; previous output repair chỉ chứa unit tương ứng. Thêm assertion rằng một repair không tăng context theo tổng số module.

- [ ] **Step 7: Chạy GREEN, regression và typecheck**

  Run: `npm test -- tests/ai-prompts.spec.ts tests/ai-validate.spec.ts tests/ai-jobs.spec.ts tests/ai-materialize.spec.ts tests/ai-review.spec.ts`

  Expected: PASS.

  Run: `npm run typecheck:strict-unused`

  Expected: PASS.

- [ ] **Step 8: Ghi lại quyết định từ bằng chứng**

  Cập nhật `docs/ai-generation-spikes.md` với kích thước/timing trước và sau; không chép prompt hay tài liệu nguồn. Cập nhật progress ledger và chạy `git diff --check`.

### Task 5: Make Pump Resume, Timeout, and Retry Deterministic

**Files:**

- Modify: `src/ui/onboarding/ai/ai-pump.ts:24-223`
- Modify: `src/ui/onboarding/ai/ai-generator.tsx:397-570`
- Modify: `src/onboarding/ai/jobs.ts:1159-1352`
- Test: `tests/ai-pump.spec.ts`
- Test: `tests/ai-jobs.spec.ts`
- Test: `tests/ai-generation-recovery.spec.ts`

**Interfaces:**

- Consumes: persisted `AiCallRecord.provider`, `attemptRef` và cleanup state.
- Produces: one-call invariant: một `operationId` chỉ có tối đa một active `attemptRef`.
- Rule: timeout/failed call phải được server ghi terminal trước khi UI cho retry.

- [ ] **Step 1: Tạo regression test RED cho toàn chuỗi**

  Dùng fake gateways và fake clock:

  1. Sandbox dispatch rồi fail `AI_FAILED`;
  2. retry tạo callId/operationId mới và dùng Native;
  3. refresh adopt Native attempt đã lưu, không dispatch lại;
  4. cancel trả `unknown`, Native retry bị chặn;
  5. reconcile thành terminal, retry mới được dispatch;
  6. tất cả module calls hoàn tất và job `completed`.

- [ ] **Step 2: Chạy test để xác nhận RED**

  Run: `npm test -- tests/ai-pump.spec.ts tests/ai-jobs.spec.ts tests/ai-generation-recovery.spec.ts`

  Expected: FAIL ở provider adoption/cleanup gate hoặc dynamic calls.

- [ ] **Step 3: Implement persisted-provider adoption**

  Khi step có `attemptRef`, chọn gateway từ `provider` đã lưu; chỉ dùng prefix fallback cho legacy call. Không để lỗi `AI_FAILED` của job tự động chuyển mọi call mới sang Native nếu call hiện tại đã có provider khác.

- [ ] **Step 4: Tách các đường terminal**

  `AbortError` do người dùng hủy không được ghi `AI_FAILED`; deadline 15 phút ghi `timeout`; provider `failed` ghi `failed`; dispatch không rõ kết quả ghi `dispatch_unknown`.

- [ ] **Step 5: Giữ lease khi poll dài**

  Heartbeat tiếp tục gia hạn lease; lỗi 429/5xx poll dùng backoff hiện có nhưng không được kéo deadline của call quá 15 phút.

- [ ] **Step 6: Chạy GREEN và typecheck**

  Run: `npm test -- tests/ai-pump.spec.ts tests/ai-jobs.spec.ts tests/ai-generation-recovery.spec.ts`

  Expected: PASS.

  Run: `npm run typecheck:strict-unused`

  Expected: PASS.

- [ ] **Step 7: Checkpoint không commit**

  Cập nhật progress ledger và chạy `git diff --check`.

### Task 6: Expose Honest, Useful Progress in the Generator UI

**Files:**

- Modify: `src/ui/onboarding/ai/ai-generator.tsx:37-126, 297-825`
- Modify: `src/ui/onboarding/styles.css`
- Test: `tests/onboarding-ai-admin-ui.spec.ts`

**Interfaces:**

- Produces: `aiCallDisplayLabel(call): string`.
- Produces: `aiJobProgress(job)` dựa trên planned/completed dynamic calls, không hard-code `0/4`.
- UI copy:
  - `Đang tạo bài học: Module 2/6`;
  - `Đang sửa bài học: Module 2/6 (lần 2/2)`;
  - `Đang chờ PrivOS xác nhận hủy tiến trình AI nền`;
  - `Không thể retry bằng Native cho đến khi tiến trình trước đã dừng`.

- [ ] **Step 1: Viết UI-model tests RED**

  Bao phủ label outline/module/repair/verification, dynamic progress, elapsed time, cleanup `pending/unknown/confirmed`, và trạng thái modal vừa mở trong khi cleanup nền còn pending.

- [ ] **Step 2: Chạy test để xác nhận RED**

  Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts`

  Expected: FAIL vì model hiển thị mới chưa tồn tại.

- [ ] **Step 3: Implement progress và cleanup controls**

  Hiển thị provider, thời gian đã chạy và bước có nghĩa với người dùng. `Hủy job` chỉ disabled trong lúc gửi yêu cầu hủy; modal có thể đóng sau khi server job đã `cancelled`, còn cleanup provider tiếp tục được reconcile khi mở lại.

- [ ] **Step 4: Giữ notice đúng chuẩn app**

  Success dùng màu xanh lá, error/unknown dùng màu đỏ, tự biến mất sau 2 giây theo behavior đã thống nhất ở app; thông báo cleanup chưa xác nhận không được gọi là “đã hủy hoàn toàn”.

- [ ] **Step 5: Chạy GREEN và visual regression thủ công cục bộ**

  Run: `npm test -- tests/onboarding-ai-admin-ui.spec.ts`

  Expected: PASS.

  Run: `npm run typecheck:strict-unused`

  Expected: PASS.

- [ ] **Step 6: Checkpoint không commit**

  Chụp snapshot accessibility của modal ở running/cancelling/unknown/completed; cập nhật ledger và chạy `git diff --check`.

### Task 7: Run Automated Regression and Prepare One Deployable Build

**Files:**

- Modify: `README.md`
- Modify: `docs/app-overview.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`, `package-lock.json`, `privos-app.json` for one final patch-version bump
- Modify: `.superpowers/sdd/2026-10-23-onboarding-ai-generation/progress.md`

**Interfaces:**

- No new runtime interface.
- Documentation must distinguish server job cancellation from provider terminal confirmation.

- [ ] **Step 1: Chạy focused AI suite**

  Run: `npm test -- tests/ai-contracts.spec.ts tests/ai-gateway.spec.ts tests/ai-gateway-native-chat.spec.ts tests/ai-attempt-lifecycle.spec.ts tests/ai-pump.spec.ts tests/ai-prompts.spec.ts tests/ai-validate.spec.ts tests/ai-jobs.spec.ts tests/ai-generation-recovery.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/ai-onboarding-integration.spec.ts`

  Expected: PASS, không có unhandled rejection hoặc timer còn mở.

- [ ] **Step 2: Chạy toàn bộ verification**

  Run: `npm run typecheck:strict-unused`

  Run: `npm test`

  Run: `npm run build`

  Run: `npm run preflight`

  Run: `npm run docker:build`

  Expected: tất cả exit 0.

- [ ] **Step 3: Cập nhật tài liệu và version đúng một lần**

  Ghi rõ call flow mới, trạng thái cleanup, cách retry và backward compatibility. Không bump version trong từng task.

- [ ] **Step 4: Kiểm tra diff**

  Run: `git diff --check`

  Run: `git status --short`

  Expected: không có whitespace error; không mất file/thay đổi cũ của người dùng.

- [ ] **Step 5: Checkpoint không commit**

  Ghi toàn bộ lệnh và số test pass vào progress ledger. Không báo hoàn tất trước Task 8.

### Task 8: Deploy and Execute the Real Chrome QA Matrix

**Files:**

- No product changes unless a failed QA check first receives a minimal automated regression test.
- Append evidence: `docs/ai-generation-spikes.md`
- Append status: `.superpowers/sdd/2026-10-23-onboarding-ai-generation/progress.md`

**Interfaces:**

- Uses the paired app URL: `https://roxane-dev.privos.io/group/test-apps-6dps39/mcpapp/6ad87c38fbc62e6c0f76918d`.
- Uses existing app identity volume; do not re-pair unless identity/relay is actually broken.

- [ ] **Step 1: Rebuild the paired service**

  Run: `docker compose up -d --build app`

  Run: `docker compose ps`

  Expected: service `app` running.

- [ ] **Step 2: Resolve manifest readiness before functional QA**

  Verify local `/ready` returns 200. If it returns `MANIFEST_DRIFT`, request/perform the normal PrivOS “Approve update” flow for the final digest, then recheck. Do not change permissions merely to clear drift.

- [ ] **Step 3: Baseline one normal generation**

  In Chrome, create Template 1 from the approved room sources. Record per call only: callId, provider, prompt/context character counts, start/end time, terminal state and error code. Expected: no call exceeds 15 minutes; no spinner remains after a terminal provider state.

- [ ] **Step 4: Verify cancel and immediate recovery**

  Start a Native call, click `Hủy job`, and confirm:

  - UI server state changes to cancelled without waiting indefinitely;
  - cleanup reaches `confirmed`, or displays `unknown` honestly;
  - a Native retry is disabled while cleanup is unknown;
  - after confirmed terminal state, a new retry starts without `Another request in this project is still running`.

- [ ] **Step 5: Verify refresh/resume**

  Refresh Chrome during a module lesson call. Expected: same callId/attemptRef/provider is adopted; Network shows no second `ai-messages.startGeneration` or Sandbox generation request for that operation.

- [ ] **Step 6: Verify scoped repair**

  Use a fixture/output path that causes one module validation error. Expected: only `<prefix>-mNN-<part>-r1` is created; prompt metadata does not grow with unrelated modules; repaired module rejoins deterministic assembly.

- [ ] **Step 7: Complete the product journey**

  Finish Template 1 → review citations/flags → resolve blocking flag → publish → assign to a learner → open module roadmap and quiz. Confirm legacy `final_exam` template/assignment still works.

- [ ] **Step 8: Perform the privacy/security Network check**

  Inspect request/response names and DTO payloads without exporting secrets. Confirm learner pre-submit payloads contain no `correctOptionId`, `explanation` or `sourceRefs`. Do not use tooling that dumps authorization headers or complete source documents into the report.

- [ ] **Step 9: Repeat the critical path**

  Run cancel/retry three times and a full normal-template generation at least twice. Acceptance:

  - zero concurrent-request errors after confirmed cancel;
  - zero duplicate dispatches after refresh;
  - every call becomes terminal within 15 minutes;
  - both full runs reach review without manual database edits;
  - no cross-room/user attempt is adopted or cancelled.

- [ ] **Step 10: Final verification and evidence**

  Rerun the focused failing test if Chrome exposed a defect, then `npm test`, `npm run typecheck:strict-unused`, `npm run build`, `npm run preflight`, and `git diff --check`. Record exact pass counts, final app version/digest and Chrome observations.

---

## Acceptance Criteria

- Hủy job luôn kết thúc server UI nhanh; provider có `confirmed` hoặc `unknown`, không bị coi là đã dừng khi chưa có bằng chứng.
- Native retry không thể bắt đầu khi một Native attempt cũ cùng project còn chưa terminal.
- Refresh không tạo call trùng; persisted `attemptRef/provider` là nguồn sự thật.
- Repair chỉ xử lý outline/module/part bị lỗi; không gửi lại toàn bộ template ở `B-lessons-r2` kiểu cũ.
- Progress hiển thị đúng bước, module, provider và elapsed time; không còn `0/4` gây hiểu nhầm khi có dynamic/repair calls.
- Mỗi call có deadline 15 phút và luôn kết thúc bằng `completed`, `failed` hoặc `cancelled`.
- Hai lần tạo Template 1 thật liên tiếp đi tới review; publish/assign/learner flow và legacy flow đều pass.
- Full automated suite, build, preflight, Docker build, readiness và Chrome QA đều có bằng chứng pass trước khi báo “đã fix”.

## Rollback Boundary

- Nếu module-scoped generation làm chất lượng nội dung giảm, chỉ rollback call planner/prompt mới; giữ provider metadata, cancel reconciliation và non-blocking recovery vì các phần đó độc lập.
- Không xóa job cũ. Legacy `B-lessons/B-questions` records tiếp tục dùng compatibility branch; job mới dùng call IDs theo module.
- Nếu PrivOS provider không thể xác nhận cancel, giữ trạng thái `unknown` và khóa Native retry; không quay lại hành vi “báo hủy thành công” khi attempt có thể còn chạy.
