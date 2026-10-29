# App overview — PrivOS Onboarding

`ai.privos.mcp-app-onboarding-dev` là ứng dụng onboarding theo room, dùng actor đã được PrivOS xác minh và dữ liệu App Database được cô lập theo room.

## Ma trận quyền

| PrivOS role | Quyền trong app |
|---|---|
| Room owner, room moderator, workspace admin | Admin |
| Room leader, room member | Learner |
| Actor không xác minh hoặc không có room | Từ chối truy cập |

Admin chỉ onboarding những thành viên được gán thủ công. Khi gán, Admin chọn phân loại `normal` hoặc `advanced` và một phiên bản template đã publish.

## UI

| Khu vực | File | Chức năng |
|---|---|---|
| App shell | `src/ui/onboarding/AppShell.tsx` | Navigation theo role, responsive drawer, host identity và theme |
| Admin tổng quan | `admin-dashboard.tsx` | KPI, luồng trạng thái, module cần hỗ trợ, cờ đang mở và thời hạn |
| Nhân sự | `employees.tsx` | Thành viên room, gán thủ công, phân loại và tiến độ |
| Template | `templates.tsx`, `ai/*` | AI-only creation từ tài liệu/ghi chú, job có thể resume, rà soát nguồn/cờ, chỉnh sửa, publish/archive/delete |
| Đồng bộ dữ liệu | `polling.ts` | Polling dùng chung mỗi 2 giây, không chồng request, tạm dừng khi tab trình duyệt bị ẩn |
| Nhận xét/đánh giá | `reviews.tsx` | Nhận xét riêng từng tự luận và đánh giá chung |
| Learner tổng quan | `learner-dashboard.tsx` | Assignment, tiến độ và tiếp tục chương trình gần hạn nhất |
| Workspace học | `learning-workspace.tsx`, `module-learning.tsx` | Học/quiz theo module cho template AI; giữ luồng final exam cho template cũ |
| Kết quả | `results.tsx` | Điểm trắc nghiệm, feedback đã publish và kết luận cuối |

## Backend tools

| Tool | Ai dùng | Trách nhiệm |
|---|---|---|
| `onboarding_dashboard` | Tất cả actor hợp lệ | Mở UI resource |
| `onboarding_bootstrap` | Tất cả actor hợp lệ | Xác định access, identity, room, capability và summary |
| `onboarding_admin_templates` | Admin | Quản lý template và version |
| `onboarding_admin_ai` | Admin | Nguồn tài liệu, job AI, claim verification, rà soát và xử lý cờ |
| `onboarding_admin_assignments` | Admin | Danh sách thành viên, gán, nhắc hạn và retry |
| `onboarding_learning` | Learner | Tài liệu, progress, draft, submit, result và feedback |
| `onboarding_reviews` | Admin | Essay queue, feedback và overall evaluation |

Tool dispatcher kiểm tra action, actor và role trước khi gọi service. `operationId` bảo vệ submit/evaluation khỏi retry trùng hoặc payload thay đổi.

Tất cả route Admin và Learner được mount ngay khi workspace mở. Mỗi màn hình tải dữ liệu lần đầu ngay lập tức rồi dùng polling 2 giây; lần refresh nền giữ nguyên dữ liệu đang hiển thị nếu có lỗi tạm thời. Riêng thư viện template preload cả chi tiết và làm mới cache theo `id`, `version`, `updatedAt`, nên thay đổi từ user khác xuất hiện mà không cần bấm vào tab trước.

## Dữ liệu

Schema bootstrap đăng ký 19 collection room-scoped:

- catalog: templates, modules, resources, questions;
- nhân sự và học cũ: employees, assignments, material progress, attempts, answers;
- review/audit: essay feedback, evaluations, audit events;
- AI/module: sources, AI jobs, template content, module progress, module attempts.

Assignment giữ snapshot template đã giao nên lần publish mới không làm đổi chương trình đang học. Learner snapshot loại `correctOptionIds` và `explanation` trước khi nộp. Template hệ thống được định nghĩa trong `src/onboarding/system-templates.ts`, deep-freeze và không có hành động xóa. Template cũ vẫn tương thích nhưng không còn entry point tạo thủ công. Template AI lưu nội dung bài học, nguồn, cờ, role profile và prompt version riêng; sửa bản đã publish tạo version nháp mới.

## Trạng thái nghiệp vụ

Assignment cũ đi qua `assigned` → `in_progress` → trạng thái chờ review → `passed`/`failed`. Kết luận `retry` mở thêm attempt nhưng giữ attempt, answer, feedback và evaluation cũ để audit.

Assignment AI dùng `assessmentMode: per_module`. Mỗi module đi qua `available/learning/quiz_ready/quiz_failed/passed/needs_support`; chế độ sequential chỉ mở module kế tiếp sau khi module trước đạt. Tiến độ bằng trung bình 50% hoàn thành bài học + 50% đạt quiz của từng module. Admin có thể cấp thêm lượt làm module.

Một resource bắt buộc chỉ hoàn thành sau khi đã được mở thành công. Bài tập chỉ mở khi mọi resource bắt buộc trong mọi module có cả `openedAt` và `completedAt`.

AI sources support text PDFs, DOCX, Markdown, TXT and HTML, up to 2 MiB per file, without OCR. Fresh inventory/template jobs and new module-v2 calls use Sandbox and need `sandbox:generate`; Native scopes alone do not reroute fresh generation. Job/lease/operation IDs protect refresh-resume and duplicate dispatch; each call records provider, server-measured request size, and cleanup status.


## Kiểm thử

Domain tests nằm trong `tests/onboarding-*.spec.ts`. Contract/runtime tests kiểm tra manifest, actor-room binding, relay verification, permissions, UI bundle và packaging. Chạy toàn bộ bằng `npm test` sau `npm run typecheck:strict-unused`.

## Module drafting and operator recovery

New template jobs use `pipelineVersion: module_v2`. Inventory remains source-based; Template 2 requests only 2-8 unique responsibilities. The backend owns immutable module IDs and authoritative frames. Every outline revision requires Admin approval before dispatch. Reordering preserves approved content; changing a module skeleton or selected source invalidates affected versions.

The compact outline and two-pane editor use lesson/question cards, flags, and separate global/module milestones. Lesson states include `queued`, `drafting`, `review_ready`, `fallback_review`, `manual_required`, `approved`, and `stale`. Questions remain `blocked` until lesson approval, then progress through draft/review/approval or become `stale` after a lesson edit. An `awaiting_admin` job remains active.

Lessons are drafted one module at a time across all active modules before Admin review. All lessons must be approved before questions are generated, one set at a time with approval between sets. Failed lesson generation produces a deterministic source-only fallback; zero usable source produces a blocking manual placeholder. An advanced fallback does not invent a scenario. Admin-authored content uses explicit manual provenance. Three to five questions must be approved against the exact current lesson version. Historical approvals never satisfy the current publish gate.

A room/project lease serializes provider attempts. At most one transient retry and one schema repair are allowed per module; project-busy responses use bounded backoff. Closing is not cancellation. Reopening adopts an already-dispatched attempt with its persisted provider and original deadline, or waits for explicit Continue. It does not auto-start the next module/template. Explicit Cancel records server cancellation and requests provider cleanup; unknown outcomes remain reserved until terminal evidence permits release.

Native AI Chat is an eligible retry/resume provider, not an equivalent fresh-generation option. The generator requires both Native scopes and a Native preference: a failed job with `AI_FAILED` (including inventory/legacy retry), or a running/failed job with a prior Native attempt. Resuming a dispatched call uses its recorded provider. Module-v2 permission/provider failures remain within bounded retry/backoff and then fallback/manual lesson review or failed-question review; granting Native scopes does not add an automatic or direct Native module retry route.

Both requires Template 1 review, explicit navigation to Template 2 review, and one sequential publish. Current approved pairs materialize to drafts first. Readiness is rechecked before artifact work. PDFs and JSON are checkpointed, so reconnect/retry resumes unfinished work and completed publish is idempotent. The modal remains open on partial failure. Artifacts stay at `Onboarding-app/Created templates/<template-name>/` and open through in-app file preview. Existing assignments keep their snapshot; legacy jobs retain their prior pipeline.

Schema bootstrap registers and reads all 19 room-scoped collections with `mcpapp.db.registerCollection` and `mcpapp.db.getSchema`. Additions: `onboarding_ai_room_leases` (unique `leaseKey`) and `onboarding_ai_publications` (unique `batchId`, owner/time index). Updates forward `expectedUpdatedAt`; the live database must enforce atomic updates and unique indexes. Memory-store tests alone do not establish external atomicity.

Before local handoff, run the compatible full suite, strict-unused typecheck, and production build/manifest lint, rebuild Compose `app`, verify `/ready` and healthy/relay status, and reload the existing browser tab. Live races, reconnect, Roomfiles replacement, and modal behavior require recorded host evidence.
