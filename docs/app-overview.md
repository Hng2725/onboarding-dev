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

Schema bootstrap đăng ký 17 collection room-scoped:

- catalog: templates, modules, resources, questions;
- nhân sự và học cũ: employees, assignments, material progress, attempts, answers;
- review/audit: essay feedback, evaluations, audit events;
- AI/module: sources, AI jobs, template content, module progress, module attempts.

Assignment giữ snapshot template đã giao nên lần publish mới không làm đổi chương trình đang học. Learner snapshot loại `correctOptionIds` và `explanation` trước khi nộp. Template hệ thống được định nghĩa trong `src/onboarding/system-templates.ts`, deep-freeze và không có hành động xóa. Template cũ vẫn tương thích nhưng không còn entry point tạo thủ công. Template AI lưu nội dung bài học, nguồn, cờ, role profile và prompt version riêng; sửa bản đã publish tạo version nháp mới.

## Trạng thái nghiệp vụ

Assignment cũ đi qua `assigned` → `in_progress` → trạng thái chờ review → `passed`/`failed`. Kết luận `retry` mở thêm attempt nhưng giữ attempt, answer, feedback và evaluation cũ để audit.

Assignment AI dùng `assessmentMode: per_module`. Mỗi module đi qua `available/learning/quiz_ready/quiz_failed/passed/needs_support`; chế độ sequential chỉ mở module kế tiếp sau khi module trước đạt. Tiến độ bằng trung bình 50% hoàn thành bài học + 50% đạt quiz của từng module. Admin có thể cấp thêm lượt làm module.

Một resource bắt buộc chỉ hoàn thành sau khi đã được mở thành công. Bài tập chỉ mở khi mọi resource bắt buộc trong mọi module có cả `openedAt` và `completedAt`.

Nguồn AI hỗ trợ PDF có text, DOCX, Markdown, TXT và HTML, giới hạn 2 MiB/file. Không OCR. `sandbox:generate` là quyền optional; thiếu quyền sẽ khóa tạo AI và không fallback về tạo tay. Job/lease/operation ID cho phép refresh-resume và ngăn dispatch trùng; mỗi call lưu `provider`, kích thước prompt/context do server đo và trạng thái dọn dẹp.

Hủy job tách hai trạng thái: server job `cancelled` (ngay lập tức) và xác nhận dừng ở PrivOS cho từng attempt (`record_attempt_cleanup`: `pending` → `confirmed`/`unknown`). Attempt Native chưa xác nhận của chính Admin khóa lượt Native mới. Job template mới kiểm tra bài học trước khi tạo câu hỏi và chỉ sửa các module lỗi (`__repairMode: module`); job cũ giữ nhánh sửa toàn bộ.

## Kiểm thử

Domain tests nằm trong `tests/onboarding-*.spec.ts`. Contract/runtime tests kiểm tra manifest, actor-room binding, relay verification, permissions, UI bundle và packaging. Chạy toàn bộ bằng `npm test` sau `npm run typecheck:strict-unused`.
