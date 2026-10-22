# PrivOS Onboarding

Ứng dụng onboarding theo room dành cho PrivOS. Admin tạo hoặc chọn chương trình, gán thủ công cho thành viên, theo dõi tiến độ, nhận xét bài tự luận và công bố đánh giá chung. Nhân sự đọc tài liệu bắt buộc, làm bài, theo dõi tiến độ và xem kết quả của chính mình.

## Vai trò và quy trình

- Room owner, room moderator và workspace admin được ánh xạ thành `admin`.
- Room leader và member là `learner`.
- Thành viên chỉ có onboarding sau khi Admin gán thủ công và chọn loại `normal` hoặc `advanced`.
- Template hệ thống về PrivOS là bất biến, không thể sửa hoặc xóa. Admin có thể clone để tùy biến.
- Template tùy chỉnh hỗ trợ tài liệu link hoặc file được tải lên room, module và câu hỏi.
- Mọi tài liệu bắt buộc phải được mở rồi xác nhận hoàn thành trước khi bài tập được mở khóa.
- Trắc nghiệm được chấm tự động. Tự luận không có điểm số và chỉ cần nộp.
- Admin nhận xét riêng từng câu tự luận và luôn công bố một đánh giá chung, kể cả bài chỉ có trắc nghiệm.
- Kết luận cuối cùng là `Đạt`, `Không đạt` hoặc `Làm lại`.

## Giao diện

Admin có năm khu vực: Tổng quan, Nhân sự, Template, Nhận xét tự luận và Đánh giá chung. Learner có Tổng quan của tôi, Nội dung học và Kết quả. UI dùng Ant Design Icons bản miễn phí, hỗ trợ light/dark theme từ host, responsive mobile và `prefers-reduced-motion`.

## Kiến trúc và dữ liệu

Backend cung cấp đúng sáu MCP tools được khai báo trong [`privos-app.json`](privos-app.json):

- `onboarding_dashboard`
- `onboarding_bootstrap`
- `onboarding_admin_templates`
- `onboarding_admin_assignments`
- `onboarding_learning`
- `onboarding_reviews`

Dữ liệu được lưu trong 11 collection App Database theo room. File onboarding nằm trong File service của room. Trình duyệt chỉ giữ theme và bản nháp khôi phục; App Database vẫn là nguồn dữ liệu chính.

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
- chạy trọn luồng gán → đọc → nộp → nhận xét → đánh giá → làm lại.

Xem [`PRIVACY.md`](PRIVACY.md), [`TERMS.md`](TERMS.md) và [`PUBLISHING.md`](PUBLISHING.md) trước khi phát hành.
