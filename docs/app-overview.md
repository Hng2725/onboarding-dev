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
| Admin tổng quan | `admin-dashboard.tsx` | KPI, hàng chờ và nhắc hạn |
| Nhân sự | `employees.tsx` | Thành viên room, gán thủ công, phân loại và tiến độ |
| Template | `templates.tsx` | Template hệ thống bất biến, custom draft, upload file, publish/archive/delete |
| Nhận xét/đánh giá | `reviews.tsx` | Nhận xét riêng từng tự luận và đánh giá chung |
| Learner tổng quan | `learner-dashboard.tsx` | Assignment, tiến độ và tiếp tục chương trình gần hạn nhất |
| Workspace học | `learning-workspace.tsx` | Đọc tài liệu, mở khóa bài, recovery draft và nộp bài |
| Kết quả | `results.tsx` | Điểm trắc nghiệm, feedback đã publish và kết luận cuối |

## Backend tools

| Tool | Ai dùng | Trách nhiệm |
|---|---|---|
| `onboarding_dashboard` | Tất cả actor hợp lệ | Mở UI resource |
| `onboarding_bootstrap` | Tất cả actor hợp lệ | Xác định access, identity, room, capability và summary |
| `onboarding_admin_templates` | Admin | Quản lý template và version |
| `onboarding_admin_assignments` | Admin | Danh sách thành viên, gán, nhắc hạn và retry |
| `onboarding_learning` | Learner | Tài liệu, progress, draft, submit, result và feedback |
| `onboarding_reviews` | Admin | Essay queue, feedback và overall evaluation |

Tool dispatcher kiểm tra action, actor và role trước khi gọi service. `operationId` bảo vệ submit/evaluation khỏi retry trùng hoặc payload thay đổi.

## Dữ liệu

Schema bootstrap đăng ký 11 collection room-scoped:

- templates và template versions;
- assignments và material progress;
- attempts và answers;
- essay feedback và evaluations;
- notification/audit state cần thiết cho workflow.

Assignment giữ snapshot template đã giao nên lần publish mới không làm đổi chương trình đang học. Learner snapshot loại `correctOptionIds` và `explanation`. Template hệ thống được định nghĩa trong `src/onboarding/system-templates.ts`, deep-freeze và không có hành động xóa.

## Trạng thái nghiệp vụ

Assignment đi qua `assigned` → `in_progress` → trạng thái chờ review → `passed`/`failed`. Kết luận `retry` mở thêm attempt nhưng giữ attempt, answer, feedback và evaluation cũ để audit.

Một resource bắt buộc chỉ hoàn thành sau khi đã được mở thành công. Bài tập chỉ mở khi mọi resource bắt buộc trong mọi module có cả `openedAt` và `completedAt`.

## Kiểm thử

Domain tests nằm trong `tests/onboarding-*.spec.ts`. Contract/runtime tests kiểm tra manifest, actor-room binding, relay verification, permissions, UI bundle và packaging. Chạy toàn bộ bằng `npm test` sau `npm run typecheck:strict-unused`.
