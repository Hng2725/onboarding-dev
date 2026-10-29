# PrivOS Onboarding

Ứng dụng onboarding theo room dành cho PrivOS. Admin cung cấp tài liệu nghiệp vụ để AI tạo chương trình, rà soát/chỉnh sửa bản nháp rồi gán cho thành viên. Nhân sự học theo module, làm bài kiểm tra, theo dõi tiến độ và xem kết quả của chính mình.

## Vai trò và quy trình

- Room owner, room moderator và workspace admin được ánh xạ thành `admin`.
- Room leader và member là `learner`.
- Thành viên chỉ có onboarding sau khi Admin gán thủ công và chọn loại `normal` hoặc `advanced`.
- Template mới chỉ được tạo bằng AI từ nguồn do Admin cung cấp; UI và backend không còn đường tạo thủ công hoặc clone template hệ thống.
- Template hệ thống và template tùy chỉnh cũ tiếp tục hoạt động theo luồng bài thi cuối chương trình để tương thích ngược.
- Template AI là bản nháp có thể chỉnh sửa, có nguồn trích dẫn và cờ kiểm chứng; cờ blocking phải được xử lý trước khi publish.
- Template AI đã publish có thể chỉnh sửa thành một version nháp mới mà không thay đổi assignment đang học.
- Mọi tài liệu bắt buộc phải được mở rồi xác nhận hoàn thành trước khi bài tập được mở khóa.
- Trắc nghiệm được chấm tự động. Tự luận không có điểm số và chỉ cần nộp.
- Admin nhận xét riêng từng câu tự luận và luôn công bố một đánh giá chung, kể cả bài chỉ có trắc nghiệm.
- Kết luận cuối cùng là `Đạt`, `Không đạt` hoặc `Làm lại`.

## Giao diện

Admin có năm khu vực: Tổng quan, Nhân sự, Template, Nhận xét tự luận và Đánh giá chung. Tab Template có quy trình AI gồm chọn nguồn, phân tích, sinh nội dung, rà soát và xuất bản. Learner có Tổng quan của tôi, Nội dung học và Kết quả. UI dùng Ant Design Icons bản miễn phí, hỗ trợ light/dark theme từ host, responsive mobile và `prefers-reduced-motion`.

## Tạo template bằng AI

- Nguồn hỗ trợ: PDF có lớp chữ, DOCX, Markdown, TXT và HTML; tối đa 2 MiB mỗi file.
- PDF scan/ảnh không có lớp chữ bị từ chối với thông báo rõ ràng; phiên bản này không chạy OCR.
- Admin có thể thêm ghi chú xác minh làm nguồn, xem trích dẫn theo section/trang và xử lý cờ thiếu dữ liệu, xung đột hoặc nội dung chưa chắc chắn.
- Job mới dùng Sandbox và cần quyền `sandbox:generate`. Hai quyền `sandbox:ai-chat` và `sandbox:ai-chat:write` chỉ hỗ trợ luồng retry/resume đủ điều kiện: job đã failed với `AI_FAILED` (gồm inventory/legacy) hoặc job running/failed có attempt Native trước đó. Chỉ cấp quyền Native không chuyển job mới sang Native; lỗi module-v2 đi qua retry/backoff có giới hạn rồi tới rà soát fallback/manual hoặc câu hỏi lỗi, không tự chuyển sang Native.
- Job AI được lưu ở server, có thể tiếp tục sau khi refresh và chống chạy trùng bằng operation ID/lease. Mỗi lượt gọi lưu provider (`sandbox`/`native_chat`), nên refresh luôn tiếp tục đúng attempt cũ qua đúng provider; hạn 15 phút tính từ lúc dispatch lần đầu.
- Hủy job gồm hai phần tách biệt: server job chuyển `cancelled` ngay, còn tiến trình AI nền ở PrivOS được yêu cầu dừng và kiểm tra trạng thái tối đa 15 giây. Kết quả lưu theo từng attempt (`pending` → `confirmed` hoặc `unknown`). Khi tiến trình Native của chính Admin chưa được xác nhận dừng, app khóa lượt Native mới và hiện nút **Kiểm tra lại trạng thái**.
- Context gửi cho AI được ngắt dòng (≤ 400 ký tự/dòng) vì agent đọc file của PrivOS cắt các dòng quá dài.

## Kiến trúc và dữ liệu

Backend cung cấp bảy data/UI MCP tools được khai báo trong [`privos-app.json`](privos-app.json):

- `onboarding_dashboard`
- `onboarding_bootstrap`
- `onboarding_admin_templates`
- `onboarding_admin_ai`
- `onboarding_admin_assignments`
- `onboarding_learning`
- `onboarding_reviews`

Dữ liệu được lưu trong 19 collection App Database theo room. File onboarding nằm trong File service của room. Trình duyệt chỉ giữ theme, bản nháp khôi phục và ID job để tiếp tục; App Database vẫn là nguồn dữ liệu chính.

Mọi request backend lấy user và room từ actor đã được PrivOS xác minh. Backend không tin `memberId`, `roomId` hoặc role do UI tự khai báo. Learner DTO loại answer key và các trường nội bộ; learner chỉ đọc được assignment, attempt và feedback của chính mình.

Chi tiết collection, trạng thái và API nằm tại [`docs/app-overview.md`](docs/app-overview.md). Lý do cấp quyền nằm tại [`SCOPES.md`](SCOPES.md).

## Chạy local

Yêu cầu Node.js 22+, npm và Git.

```bash
git clone https://github.com/Hng2725/onboarding-dev.git
cd onboarding-dev
npm ci
copy .env.example .env
npm run dev
```

`npm run dev` dùng Relay development và Vite UI tại `http://localhost:5179`. URL pairing được lấy từ PrivOS Admin. Không dùng credential development cho production.

Các lệnh chính:

```bash
npm run typecheck:strict-unused
npm test
npm run build
npm run preflight
npm run package
```

`npm run build` tạo UI production đã hash tại `dist/ui`, không tạo sourcemap, sinh manifest runtime và lint manifest Marketplace.

## Runtime production

Ứng dụng dùng `@privos_ai/app-server` để chọn một runtime duy nhất:

1. `managed`: PrivOS mount workload identity socket.
2. `standalone-production`: dùng identity file đã pair với Hub.
3. `development`: chỉ khi không ở `NODE_ENV=production`.

Trong managed runtime:

```bash
npm run build
PORT=3000 npm start
```

Standalone production pair một lần bằng `npm run pair`, sau đó chạy `npm run start:standalone`. Không commit identity file, `.env` hoặc credential vào repository.

## Giới hạn kiểm tra local

Automated tests xác minh policy, workflow, schema, tools, UI model, manifest và packaging. Các bước sau cần một room PrivOS thật:

- kiểm tra owner/moderator thấy Admin còn leader/member thấy Learner;
- upload và preview file thật trong room;
- xác nhận thông báo bell/push;
- kiểm tra cách ly dữ liệu giữa hai tài khoản;
- chạy trọn luồng upload nguồn → AI tạo → rà soát cờ → publish → gán → học module → làm lại;
- xác nhận template cũ vẫn chạy luồng bài thi cuối chương trình.

Xem [`PRIVACY.md`](PRIVACY.md), [`TERMS.md`](TERMS.md) và [`PUBLISHING.md`](PUBLISHING.md) trước khi phát hành.

## Safe module drafting (module_v2)

1. Upload or select sources, analyze them, then choose Template 1, Template 2, or Both. Template 2 requires only 2-8 distinct responsibilities (one per line); Department and Job Title are not requested. Old records retain readable optional role metadata.
2. Review the deterministic outline before generating any lesson. Template 1 has 4-8 modules; Template 2 has 5-8. Edit titles, objectives, sources, order, and responsibility coverage, then explicitly approve the current outline revision.
3. Draft and review one module at a time. Approve its lesson before generating 3-5 questions, then approve those questions before moving on. The workspace uses editable cards and separate module/global milestones; waiting for Admin review is not generation completion.
4. Provider failure preserves earlier modules. A source-only fallback reuses selected text and headings without inventing facts or a scenario. With no usable source, a blocking manual placeholder requires Admin content and approval. Questions remain blocked until that lesson is approved.
5. Editing an approved lesson invalidates its approval and marks its questions stale. Prior approvals remain in audit history. Only the latest approved lesson and questions tied to that exact version can be materialized or published.
6. Both proceeds through Template 1 review, an explicit Next to Template 2, and a single resumable publish. Publication prepares lesson PDFs, publishes each template, and saves JSON in order. Repeating a completed publish does not duplicate completed artifacts. The modal closes only after every target and artifact succeeds.

Close/reopen or refresh adopts a dispatched attempt through its recorded provider; it neither cancels that attempt nor starts later work automatically. Use Continue explicitly to resume waiting work, and Cancel explicitly to cancel. A room/project lease permits only one live provider attempt. Transient failures receive at most one automatic retry per module and malformed output at most one schema repair; project-busy responses use bounded backoff and eventually require Admin action. Unknown provider outcomes remain fenced until reconciled.

Artifacts retain the English Roomfiles path `Onboarding-app/Created templates/<template-name>/` and open in the app. New room-scoped collections `onboarding_ai_room_leases` and `onboarding_ai_publications` use existing database permissions; no additional scope is needed.

For a Windows linked worktree whose WSL Git cannot resolve the Windows `.git` pointer, run `npm test -- --exclude tests/packaging.spec.ts`, `npm run typecheck:strict-unused`, and `npm run build`. Packaging must still run from a compatible checkout before release. Deploy the existing local service with `docker compose up -d --build app`, then verify `/ready`, container health, relay connection, and the live host UI.
