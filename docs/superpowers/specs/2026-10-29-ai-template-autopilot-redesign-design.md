# Thiết kế lại modal AI tạo template: kiểm tra độ phủ trước, AI tự tạo trọn gói

**Ngày:** 2026-10-29
**Trạng thái:** Chờ duyệt
**Phạm vi:** Modal "Tạo template bằng AI" (UI + server pipeline `module_v2`), tài liệu `docs/AI_TEMPLATE_MODAL_GUIDE.vi.md`
**Mockup đã duyệt:** `.superpowers/brainstorm/1545-1793267480/content/flow-v1.html` (kèm 1 chỉnh sửa, xem mục 6.2)

## 1. Vì sao làm

Admin muốn: đưa tài liệu vào, AI cho biết ngay tài liệu đã đủ cho từng module chưa, bổ sung hoặc bỏ module, rồi bấm **một lần** "Tạo template" và chỉ việc chờ, xem lại, xuất bản.

Hiện tại (đã tái hiện trên `roxane-dev`, 1 file "Sổ tay hội nhập", Template thông thường):

| Triệu chứng | Nguyên nhân gốc |
|---|---|
| Lộ trình hiện ra nhưng 3 nút (Thêm, Chỉnh sửa, Duyệt) bị khóa thêm ~1 phút | `generateTemplate()` vẫn chạy `pump()` nên `busy=true` |
| Bấm "Duyệt lộ trình và tiếp tục" → màn hình trống vài giây | `approveOutlineAndStartDrafting()` gọi `setStep(3)` trước khi server trả `outlineApprovedRevision`; bước 3 render `null` |
| 3/4 module "Cần bổ sung tài liệu" dù tài liệu có nội dung | `buildTemplateOutline` (`src/onboarding/ai/outline.ts`) chấm điểm từ khóa **tiếng Anh** của frameKey (`access`, `navigation`, `core`) với nội dung **tiếng Việt** → không bao giờ khớp. Khung cố định cũng không hợp tài liệu không phải phần mềm |
| Module 1 chỉ có "bản dự phòng" chép nguyên văn nguồn | Bài học AI bị loại 2 lần vì `parseFlags` bắt buộc `flag.location` và `parseBlocks` bắt buộc `sourceRefs` là mảng (lỗi thật: `root.flags[0].location: Flag location is required`, `root.blocks[6].sourceRefs must be an array`) → `fallbackRun` |
| Module 2–4 "Cần tự soạn", AI không viết | Không có section nguồn → `fallbackRun` trả `manual_required` |
| Admin phải bấm duyệt ~2 lần/module | `lessonState`/`questionState` chờ `approve_module_*` |
| Nhiều chữ tiếng Anh: `t1-overview`, `concept`, `steps`, cờ "Missing source sections for module." | Tiêu đề outline mặc định = frameKey; prompt bài học/câu hỏi viết bằng tiếng Anh và không yêu cầu ngôn ngữ đầu ra; nhiều thông báo server bằng tiếng Anh được hiển thị nguyên văn |
| Nút chính ở chân modal bị bong bóng chat PrivOS che | Footer không chừa chỗ góc phải dưới |

## 2. Mục tiêu

1. Mỗi lần chỉ tạo **một** template: Thông thường **hoặc** Nâng cao. Bỏ "Cả hai".
2. Kiểm tra độ phủ tài liệu **trước** khi tạo nội dung; mọi thiếu sót được xử lý ở bước này.
3. Sau khi bấm "Tạo template", AI tự viết bài học + câu hỏi cho mọi module, **không có bước duyệt giữa chừng**; Admin chỉ xem lại bản nháp hoàn chỉnh rồi xuất bản.
4. Bổ sung tài liệu cho module thiếu: AI **chỉ đọc file mới**, gắn vào module đang thiếu, và liên kết sang module/tài liệu đã có khi liên quan.
5. Toàn bộ chữ người dùng nhìn thấy là **tiếng Việt** — kể cả nội dung AI sinh ra.
6. Giao diện gọn: 4 bước, mỗi bước một nút chính, màu chỉ dùng cho trạng thái.
7. Sửa các lỗi ở mục 1.

## 3. Không làm / chống mục tiêu

- **Không** đổi schema template đã xuất bản, luồng xuất bản (PDF + JSON vào Roomfiles), checkpoint xuất bản, Native fallback, hủy job, "Xóa dữ liệu".
- **Không** gọi AI một lần cho cả template (đã cân nhắc, loại — mục 4).
- **Không** để giao diện tự bấm duyệt thay Admin (đã cân nhắc, loại — mục 4).
- Chống mục tiêu: AI bịa nội dung cho module không có nguồn; Admin phải chờ ở màn hình trống; còn sót chuỗi tiếng Anh hay mã nội bộ trên UI; bản nháp tự xuất bản khi Admin chưa bấm.
- Ngoài phạm vi: tần suất polling `templates list`/`assignments list` ở trang nền (quan sát thấy nhiều request; ghi nhận để xử lý riêng).

## 4. Các hướng đã cân nhắc

| Hướng | Mô tả | Đánh đổi | Kết luận |
|---|---|---|---|
| **A. Tự động hóa pipeline từng module** | Giữ `module_v2` (job, call, lease, retry, Native, fallback), thêm bước AI lập lộ trình, màn hình độ phủ, chế độ tự duyệt | Sửa cả server và UI; tận dụng được độ bền đang có | **Chọn** (Admin chọn ngày 2026-10-29) |
| B. Một lần gọi AI cho cả template | Prompt lớn tạo mọi bài học + câu hỏi | Dễ vượt giới hạn context; lỗi một chỗ hỏng cả bài; mất retry theo module | Loại |
| C. UI tự bấm duyệt | Server giữ nguyên, client gọi `approve_module_*` | Logic duyệt nằm rải ở client, dễ lệch trạng thái khi khôi phục; không sửa lỗi gốc (outline, validator) | Loại |

## 5. Luồng mới

```text
1. Nguồn & loại ──[Phân tích tài liệu]──► (inventory job → template job: AI lập lộ trình)
2. Kiểm tra độ phủ ── bổ sung file / bỏ module / sửa tên ──[Tạo template]──►
3. AI tạo nội dung (tự động, có thể đóng modal) ──► materialize bản nháp
4. Xem lại & xuất bản ──[Xuất bản template]──► PDF + JSON + publish → đóng modal, reset phiên
```

### Bước 1 — Nguồn & loại template
- Một màn hình: chọn loại (segmented 2 lựa chọn: **Thông thường** / **Nâng cao**), tên template (không bắt buộc), tên hệ thống/tổ chức (bắt buộc như hiện tại; phiên bản và ngày hiệu lực thu vào phần "Thông tin thêm" có thể mở ra), nhiệm vụ chính 2–8 dòng (chỉ khi Nâng cao), tải file/ghi chú, chọn 1–10 nguồn.
- Nút chính: **Phân tích tài liệu** (mở khi: đã chọn loại, ≥1 nguồn, nhiệm vụ hợp lệ nếu Nâng cao).
- Bấm → chạy inventory job như hiện tại; khi xong, **tự động** `start_job` template với `templateKind` đã chọn và chạy bước AI lập lộ trình (6.2). UI chuyển sang bước 2 ngay, hiển thị tiến trình "Đang đọc tài liệu → Đang lập lộ trình".
- Nếu inventory đã hoàn tất với đúng tập nguồn hiện chọn, dùng lại (không phân tích lại).

### Bước 2 — Kiểm tra độ phủ
- Dải tóm tắt 4 số **chia đều toàn chiều rộng** (grid 4 cột, mỗi ô căn giữa): module đề xuất · đủ tài liệu · cần bổ sung · phút học ước tính.
- Danh sách module (thứ tự = thứ tự học): số thứ tự, tiêu đề tiếng Việt, dòng phụ nêu nguồn ("Sổ tay hội nhập · mục 2 · liên kết An toàn làm việc từ xa"), chip trạng thái **Đủ tài liệu** (xanh) / **Cần bổ sung** (vàng), nút phụ **Sửa** (tên, mô tả, thời lượng, mục tiêu; Nâng cao: nhiệm vụ gắn với module) và **Bỏ module**.
- Module thiếu: hàng viền vàng + ghi chú AI giải thích thiếu gì (`gapNote`) + nút **Tải tài liệu bổ sung** (mở chọn file; luồng 6.3). Thêm 2 nút phụ (Admin quyết định cuối cùng — chốt ngày 2026-10-29):
  - **Chọn đoạn từ tài liệu đã có**: picker section của các nguồn trong job (tái dùng `list_module_sources` / `supplement_module_sources`), tick các đoạn liên quan → module có section → tính lại độ phủ.
  - **Vẫn dùng tài liệu hiện có**: chỉ hiện khi module đã có ≥1 section dùng được nhưng AI đánh giá `insufficient`. Bấm → `coverageOverride: true` trên module, chip thành "Đủ tài liệu (Admin xác nhận)"; AI viết bài chỉ với các section đó.
- Nguồn sự thật của độ phủ: module "Đủ tài liệu" ⇔ có section dùng được **và** (`coverage === 'sufficient'` **hoặc** `coverageOverride === true`). Module không có section dùng được thì không thể override.
- Thêm module: một nút phụ "+ Thêm module" cuối danh sách (nhập tên + mô tả; module mới sẽ ở trạng thái Cần bổ sung cho tới khi có nguồn hoặc AI gắn được section từ nguồn hiện có — xem 6.3 bước "liên kết").
- Đổi thứ tự: kéo-thả hoặc nút ↑/↓ trong panel Sửa.
- Nút chính **Tạo template**: chỉ mở khi mọi module "Đủ tài liệu" và số module trong giới hạn (Thông thường 4–8, Nâng cao 5–8; Nâng cao: mọi nhiệm vụ được gắn). Khi khóa, bên trái nút hiện lý do ngắn ("Còn 1 module cần bổ sung hoặc bỏ").
- Nút phụ trái: **← Quay lại** (về bước 1; đổi loại/nguồn sẽ tạo template job mới, hủy job cũ).
- Bấm **Tạo template** = `approve_outline` + bật autopilot (6.4). UI chỉ chuyển sang bước 3 **sau khi** server trả job đã duyệt; trong lúc chờ, nút hiện spinner "Đang bắt đầu…" (sửa lỗi màn hình trống).

### Bước 3 — AI tạo nội dung
- Vòng tiến độ % + tiêu đề "AI đang viết bài học và câu hỏi" + dòng phụ "Giữ cửa sổ này mở trong lúc AI làm việc. Nếu đóng, AI tạm dừng và tiếp tục khi mở lại."
- AI chạy từ trình duyệt (gateway + `pumpAiJob` trong modal): **đóng modal = tạm dừng**, mở lại = tiếp tục từ job đã lưu (hành vi khôi phục hiện có). Chốt ngày 2026-10-29.
- **Xác nhận khi đóng**: bấm × (hoặc Esc / click backdrop) trong lúc có job đang chạy (phân tích, lập lộ trình, bổ sung tài liệu, tạo nội dung, xuất bản) → `ConfirmDialog` "Đóng cửa sổ?" — "AI đang tạo nội dung. Nếu đóng, AI sẽ tạm dừng và tiếp tục khi bạn mở lại." Nút: **Tiếp tục ở lại** (mặc định) / **Đóng và tạm dừng**. Không có job chạy → đóng ngay không hỏi.
- Mỗi module một hàng: chip **Bài học** (Chờ / Đang viết… / ✓ / Bản từ nguồn) và chip **Câu hỏi** (Chờ / Đang tạo… / ✓ N câu / Câu hỏi dự phòng).
- Không có nút duyệt. Nút phụ: **Tạm dừng & sửa lộ trình** — là **tạm dừng**, không hủy job: dừng pump, hủy và xác nhận call đang chạy bằng cơ chế cleanup hiện có, đặt `outlineApprovedRevision = 0` (action server mới `pause_autopilot`), quay về bước 2. Module đã xong được giữ; chỉ module bị sửa (nguồn/nội dung outline) mới bị invalidate và viết lại khi bấm Tạo template lần nữa. Nút "Hủy job" thật vẫn nằm trong "Xóa dữ liệu". Nút chính **Xem lại template** mở khi job `completed` và đã materialize; app cũng tự chuyển sang bước 4 khi xong.
- Lỗi không phục hồi được (hết retry, Native cũng lỗi, lỗi quyền): banner đỏ một dòng + nút **Thử lại**; thông điệp tiếng Việt (mục 7).

### Bước 4 — Xem lại & xuất bản
- Trái: tên template, danh sách module (kèm số câu), nhãn thiết lập thu gọn (Đạt 70% · 2 lượt/module · Tuần tự) — bấm vào nhãn mở popover sửa.
- Phải: tab **Bài học** / **Câu hỏi (N)** của module đang chọn; dẫn chứng nguồn hiển thị dạng nhãn nhỏ cạnh đoạn văn; nút **Chỉnh sửa** và **AI viết lại** (6.5).
- **Chỉnh sửa đi qua job, không sửa thẳng bản nháp** (bản nháp module_v2 bị khóa editor và `assertModuleTemplateCurrent` yêu cầu khớp version job): lưu bài học → `update_module_lesson` (provenance manual) rồi autopilot tự duyệt; vì lesson đổi làm câu hỏi stale, autopilot tạo lại câu hỏi của **riêng module đó** rồi materialize lại. Trước khi lưu bài học, cảnh báo một dòng: "Câu hỏi của module này sẽ được AI tạo lại cho khớp bài học mới." Lưu câu hỏi → `update_module_questions` + tự duyệt + materialize, không ảnh hưởng bài học. Trong lúc materialize lại, vùng nội dung module hiện trạng thái "Đang cập nhật…" (không về màn hình trống). Editor dùng lại các trường soạn thảo trong `AiModuleWorkspace`/`AiReview` hiện có, bố trí lại theo mockup.
- Cờ kiểm chứng còn mở: hiển thị gọn trong module liên quan; cờ bắt buộc chặn xuất bản như hiện tại, với lý do ở cạnh nút chính.
- Nút phụ trái: **← Về độ phủ** (sửa lộ trình → job quay lại bước 2; mọi module bị thay đổi sẽ được tạo lại khi bấm Tạo template lần nữa). Nút chính: **Xuất bản template** → luồng xuất bản hiện có (`publishAiTemplateBatch` với 1 target), tiến trình hiển thị trong chính nút/banner.

## 6. Thay đổi server (`src/onboarding/ai/*`)

### 6.1 Bỏ "Cả hai"
- `TemplateSelection = 'normal' | 'advanced' | null`; xóa nhánh `'both'` khỏi `ai-template-batch.ts`, `templateKindsForSelection`, `reviewAdvanceState`, khôi phục phiên, key `onboarding:ai:selection`.
- Phiên cũ có 2 run: khi mở modal chỉ khôi phục run mới nhất chưa xuất bản; run còn lại bị bỏ qua (Admin có thể "Xóa dữ liệu" để dọn).

### 6.2 AI lập lộ trình (thay `buildTemplateOutline` chấm từ khóa)
- Template job mới bắt đầu bằng một call **stage `P` (plan)** trước mọi call module. Input: inventory hợp nhất (features, systemSummary.modules, glossary, flags), danh sách section (id, sourceId, tên file, heading, độ dài — **không** gửi toàn văn để giữ prompt nhỏ), loại template, nhiệm vụ (Nâng cao), giới hạn số module.
- Output (JSON, validate chặt nhưng không quá khắt khe — 6.6): `modules[] = { title, description, estimatedMinutes, objectives[2–4], featureIds[], sourceSectionIds[], responsibilityIndexes[], coverage: 'sufficient'|'insufficient', gapNote }`, `taskCoverage` (Nâng cao). Mọi chuỗi bằng tiếng Việt.
- Server gán `frameKey` theo **vị trí** (NORMAL_FRAMES/ADVANCED_FRAMES dùng như slot nội bộ, không hiển thị); `title` lấy từ AI, **không bao giờ** mặc định bằng frameKey. Nâng cao: giữ quy tắc mỗi nhiệm vụ gắn đúng một module hoặc có cờ missing.
- Server tự kiểm lại coverage: module "Đủ tài liệu" ⇔ có ≥1 section tồn tại, thuộc nguồn của job, text ≥ `minQuoteChars` và có chữ/số (cùng điều kiện `moduleContext().usable`). Nếu AI ghi `sufficient` nhưng không có section hợp lệ → hạ thành `insufficient`.
- Thất bại (sau retry/repair/Native theo cơ chế hiện có): fallback xác định — một module cho mỗi mục trong `inventory.systemSummary.modules` (gắn section qua `sourceRefs` của features có `feature.module` khớp, so khớp sau `normalizeForMatch`), cắt/ghép cho vừa giới hạn; tiêu đề lấy nguyên tên mục (tiếng Việt từ tài liệu).
- Lưu `coverage` và `gapNote` vào `TemplateOutlineModule` (field mới, tùy chọn — outline cũ không có thì tính `coverage` từ section).
- Cờ "Missing source sections for module." thay bằng thông điệp tiếng Việt; với outline mới, module thiếu nguồn không cần cờ blocking nữa vì nút Tạo template đã chặn (giữ validate cũ cho job cũ).

### 6.3 Bổ sung tài liệu cho module thiếu (chỉ đọc file mới)
- Action mới `supplement_module_document { jobId, expectedRevision, moduleLocalId, sourceId }` (sourceId = file vừa ingest bằng `ingest_source` như hiện tại; UI tải lên Roomfiles rồi ingest, giống bước 1).
- Server thêm sourceId vào `job.sourceIds` (≤10), tạo call **stage `S` (supplement)**. Prompt chỉ chứa: section của **file mới**, và tóm tắt outline hiện tại (mỗi module: title, description, objectives, gapNote, heading các section đã gắn). Không gửi lại toàn văn tài liệu cũ.
- Giới hạn kích thước: section của file mới được chia lô theo cùng cách `planBatches` của inventory (mỗi lô vừa `maxSystemContextChars`); mỗi lô một call `S1..Sn`, chạy tuần tự; kết quả gộp bằng hợp các `sectionIds` theo module, `coverageUpdates` lấy của lô cuối có đề cập module đó. Coverage cuối luôn do server tính lại (6.2).
- Output: `{ attachments: [{ moduleLocalId, sectionIds[] , reason }], coverageUpdates: [{ moduleLocalId, coverage, gapNote }] }`. Ưu tiên module đang thiếu (`moduleLocalId` được yêu cầu); được phép gắn section mới vào module khác nếu liên quan ("liên kết với module đã có"). Section phải thuộc file mới.
- Server áp dụng như `supplementModuleSources` hiện có (outline revision +1, module bị đổi nguồn bị invalidate), tính lại coverage theo 6.2. Nếu AI không gắn được gì cho module yêu cầu → module vẫn "Cần bổ sung" với gapNote AI giải thích file này chưa đủ chỗ nào.
- Liên kết tài liệu cũ: khi viết bài học (6.4), `moduleContext` đã đưa section của module; thêm vào prompt bài học danh sách tiêu đề các module khác để AI có thể nhắc chéo ("xem module 2") — không thêm section của module khác.
- Module Admin tự thêm ở bước 2: lúc thêm, server chạy call `S` cho riêng module mới với context = **danh mục section đang có của job** (id, heading, 300 ký tự đầu mỗi section — không gửi toàn văn), AI chọn `sectionIds` phù hợp. Nếu không đủ → Cần bổ sung (Admin có thể dùng picker hoặc tải file).

### 6.4 Autopilot (không duyệt giữa chừng)
- Job mới có `autoApprove: true`. Job `module_v2` cũ đang dở (không có cờ) được **chuyển sang autopilot khi mở modal** (action `enable_autopilot`: đặt `autoApprove: true`; bài học/câu hỏi đã duyệt giữ nguyên; bài học `review_ready`/`fallback_review` và câu hỏi `review_ready` được tự duyệt ở lượt pump kế tiếp; module `manual_required` không có nguồn → job quay về bước 2 để bổ sung/bỏ). Nhờ vậy gỡ được `AiOutlineReview` / `AiModuleWorkspace` mà không cần giữ UI cũ. Job legacy (không phải `module_v2`) đã có `result` mở thẳng bước 4.
- `approveOutline` trên job autopilot chỉ cho phép khi mọi module active có section dùng được; nếu không trả `OPERATION_CONFLICT` với thông điệp tiếng Việt.
- Trong `nextModuleStep` với `autoApprove`:
  - Bài học hợp lệ (AI) → `approveLesson` ngay, đưa câu hỏi của **chính module đó** vào hàng đợi (không chờ mọi bài học khác).
  - Bài học AI hỏng sau repair → dùng `buildFallbackLesson` (bản từ nguồn) và tự duyệt, ghi cờ `warning` tiếng Việt "Bài học được dựng trực tiếp từ tài liệu nguồn, nên rà soát cách diễn đạt."
  - Câu hỏi hợp lệ → `approveQuestions` ngay. Câu hỏi hỏng → chuỗi phục hồi hiện có (Native một lần → `use_question_fallback`), rồi tự duyệt.
  - Thứ tự call: bài học module 1, câu hỏi module 1, bài học module 2… (một call tại một thời điểm như hiện nay; lease/Native giữ nguyên).
  - Khi `modulesComplete` → `materializeModuleTemplate` như hiện tại → `result = {templateId, version}`.
- Ghi audit `__moduleAudit` với `approvedBy: 'autopilot'` để còn truy vết.

### 6.5 AI viết lại một module ở bước 4
- Dùng lại đường `editApprovedModules` + `retry_module` (target lesson): job quay lại running, autopilot viết lại bài học + câu hỏi của module đó, materialize bản nháp mới (version mới). UI hiển thị bước 3 thu gọn chỉ với module đó, xong tự quay về bước 4 ở đúng module. Chỉnh sửa tay khác của Admin trên bản nháp cũ được giữ nếu materialize hiện tại đã hỗ trợ; nếu không, UI cảnh báo trước khi viết lại ("Các chỉnh sửa tay trong module này sẽ bị thay thế").

### 6.6 Bộ kiểm tra đầu ra bớt khắt khe (chỉ lỗi vô hại)
- `parseFlags`: thiếu/không hợp lệ `location` → mặc định `{ moduleLocalId: <module đang viết> }` (bài học/câu hỏi module) hoặc `{}` (inventory/plan), không báo lỗi. Cờ hỏng hẳn (thiếu type/message) → bỏ cờ đó và ghi `generationNotes`, không loại cả output.
- `parseBlocks`: thiếu `sourceRefs` → coi là `[]`; sau đó luật grounding vẫn bắt buộc block không phải summary có ≥1 sourceRef hợp lệ (nên không nới lỏng tính kiểm chứng).
- Giữ nguyên mọi luật grounding quote, số câu hỏi 3–5, 4 phương án.

## 7. Tiếng Việt ở mọi nơi

1. **Prompt**: viết lại `lessonRules`, prompt câu hỏi, prompt repair trong `module-draft.ts` và prompt plan/supplement mới bằng tiếng Việt, cùng một luật chung: "Mọi trường hiển thị cho người học/Admin (title, description, objectives, body, steps.text, prompt, options.label, explanation, message, questionForAdmin, gapNote, reason) viết bằng tiếng Việt có dấu, kể cả khi tài liệu nguồn bằng tiếng Anh. Riêng `quote` trong sourceRefs/evidence phải chép **nguyên văn** từ nguồn (không dịch)." Tăng `PROMPT_VERSION`.
2. **Mã nội bộ không bao giờ hiện**: frameKey, `concept|steps|scenario|tip|warning|summary`, `recall|procedure|scenario`, provider id, call id. Bảng nhãn tiếng Việt tập trung trong UI (ví dụ block: Khái niệm, Các bước, Tình huống, Mẹo, Lưu ý, Tóm tắt; mức câu hỏi: Ghi nhớ, Quy trình, Tình huống). Sửa `lesson-markdown.tsx` / workspace / PDF bài học (`lesson-pdf.ts`) đang in `concept`, `steps`.
3. **Thông điệp server hiển thị cho Admin**: cờ do server tạo (outline/plan/fallback/autopilot) viết tiếng Việt. Lỗi trả về UI: `generationErrorMessage` map theo `code` sang tiếng Việt; bổ sung các code còn thiếu (`OPERATION_CONFLICT`, `JOB_NOT_RUNNING`, `SOURCE_NOT_FOUND`, `INVENTORY_REQUIRED`, `PROJECT_BUSY`, `JOB_CALL_MISMATCH`…). Nếu `error.message` không phải tiếng Việt (heuristic: không có ký tự tiếng Việt có dấu) → hiển thị thông điệp chung tiếng Việt kèm mã lỗi nhỏ để tra cứu, không hiện câu tiếng Anh.
4. Thông điệp validate nội bộ dùng cho repair prompt có thể giữ tiếng Anh (AI đọc, người không thấy), nhưng không được lọt ra UI.
5. Rà toàn bộ chuỗi trong `src/ui/onboarding/ai/*` và nhãn phân bổ trong `ai-job-milestones.tsx` bằng một test: không còn chuỗi hiển thị chứa từ tiếng Anh thông dụng hay mã frame (test grep trên DOM render của các bước).

## 8. Thiết kế giao diện

Theo mockup đã duyệt; nguyên tắc:
- **Header**: tiêu đề "Tạo template bằng AI" + stepper 4 bước nằm cùng một hàng (bỏ kicker "AI ONBOARDING" và câu mô tả dài). Bước xong: chấm xanh lá ✓; bước hiện tại: chấm tím đặc; bước sau: viền xám.
- **Footer**: trái = hành động phụ (ghost), phải = **một** nút chính duy nhất + lý do khóa (chữ xám) nếu có. Chừa `padding-right` đủ để bong bóng chat PrivOS (góc phải dưới, ~72px) không che nút chính.
- **Màu**: xanh lá = xong, vàng = cần xử lý, tím (primary) = đang chạy/được chọn, đỏ = lỗi; còn lại chữ trung tính (text / text-soft / muted). Không tô màu cho nhãn tĩnh.
- **Khoảng cách**: body padding 28–32px, khoảng cách hàng 10px, vùng bấm tối thiểu 30px cao và cách nhau ≥6px; nút phụ trong hàng là ghost nhỏ.
- **Dải tóm tắt bước 2**: grid 4 cột bằng nhau, nội dung mỗi cột căn giữa, lấp đầy chiều rộng khung.
- **Ít chữ**: mỗi màn hình tối đa 1 dòng mô tả; trợ giúp chi tiết bỏ sang tooltip hoặc tài liệu hướng dẫn.
- Dùng token `--on-*` hiện có cho cả theme sáng và tối; layout co về 1 cột ≤ 900px; không cuộn ngang.
- Gỡ các phần không còn dùng: `AiOutlineReview` (thay bằng màn hình độ phủ), `AiModuleWorkspace` duyệt từng module (thay bằng danh sách tiến trình bước 3), thanh chọn Template 1/2, `ai-run-sequence`.

## 9. Ràng buộc

- Chạy trong iframe PrivOS sandboxed; Web Storage có thể không dùng được (giữ try/catch hiện có).
- Giới hạn: ≤10 nguồn/phiên, 2 MB/file, prompt ≤40.000 byte, system context ≤150.000 byte — call `P` và `S` phải nằm trong giới hạn này (call `S` chỉ chứa file mới + tóm tắt outline).
- App chạy bằng Docker: sau khi sửa phải `docker compose build app && docker compose up -d app`, rồi tải lại Chrome để kiểm tra (CLAUDE.md). Không tự commit/push.
- Test hiện có (`tests/onboarding-ai-*.spec.ts`, `tests/ai-*.spec.ts`) phải được cập nhật theo luồng mới; không xóa test của phần giữ nguyên (xuất bản, Native, hủy, reset).

## 10. Tiêu chí hoàn thành

1. Trên `roxane-dev` với file "Sổ tay hội nhập": bước 2 đề xuất ≥4 module tiêu đề tiếng Việt khớp nội dung, phần lớn "Đủ tài liệu".
2. Tải thêm "An toàn làm việc từ xa" cho một module thiếu: AI chỉ đọc file đó, module chuyển "Đủ tài liệu" (hoặc nêu rõ vì sao chưa), có thể gắn thêm vào module liên quan.
3. Bấm "Tạo template" → không có bước duyệt nào; bước 3 cập nhật theo từng module; bấm × lúc đang chạy hiện hộp xác nhận; đóng rồi mở lại thì tiếp tục từ chỗ dừng.
4. Bước 4 hiển thị đủ bài học + 3–5 câu/module, toàn tiếng Việt, không còn `t1-…`, `concept`, câu tiếng Anh.
5. Xuất bản thành công, PDF + JSON trong `Onboarding-app/Created templates/<tên>`; modal đóng và reset về bước 1.
6. Không còn màn hình trống khi chuyển bước; nút chính không bị bong bóng chat che.
7. `npm test` và typecheck xanh; tài liệu `docs/AI_TEMPLATE_MODAL_GUIDE.vi.md` cập nhật theo luồng mới.

## 11. Quyết định của người dựng (đánh dấu để Admin kiểm tra)

- Spec viết tiếng Việt vì Admin là người duyệt (các spec cũ viết tiếng Anh).
- frameKey giữ làm slot nội bộ theo vị trí thay vì xóa, để không phải đổi schema/validate/materialize.
- Phiên bản / ngày hiệu lực thu vào "Thông tin thêm" ở bước 1.
- Bài học hỏng → tự dùng bản từ nguồn + cờ cảnh báo (không dừng chờ Admin).
- Job `module_v2` cũ đang dở được chuyển sang autopilot khi mở modal (Admin đồng ý 2026-10-29).
- Sửa bài học ở bước 4 → câu hỏi của module đó được AI tạo lại (Admin đồng ý).
- "Tạm dừng & sửa lộ trình" là tạm dừng, giữ module đã xong (Admin đồng ý).
- Call `S` chia lô theo `planBatches` (Admin đồng ý).

## 12. Câu hỏi đã chốt với Admin (2026-10-29)

- Hướng A. Bỏ "Cả hai".
- Bổ sung tài liệu: AI chỉ đọc file mới, gắn vào module thiếu, liên kết module/tài liệu cũ khi cần.
- Toàn bộ chữ hiển thị và nội dung AI sinh ra bằng tiếng Việt.
- Độ phủ: Admin có quyền quyết định cuối (picker đoạn có sẵn + "Vẫn dùng tài liệu hiện có").
- Đóng modal khi đang chạy: hỏi xác nhận; đóng = tạm dừng, mở lại = tiếp tục.
- Dải tóm tắt bước 2 chia đều 4 cột lấp kín khung.
