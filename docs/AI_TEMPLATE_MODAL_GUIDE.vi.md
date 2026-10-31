# Hướng dẫn luồng tạo template onboarding bằng AI

## 1. Mục đích của modal

Modal **Tạo template bằng AI** giúp Admin biến các tài liệu nghiệp vụ có sẵn thành **một** template onboarding hoàn chỉnh trong mỗi lượt chạy. Template có:

- Lộ trình gồm nhiều module học.
- Tài liệu để nhân sự đọc ngay trong app.
- 3–5 câu hỏi kiểm tra cho mỗi module.
- Dẫn chứng liên kết nội dung AI tạo với tài liệu nguồn.
- Thiết lập ngưỡng đạt, số lượt làm và chế độ học.
- File PDF bài học và file JSON lưu trong Roomfiles.

AI phân tích, đề xuất và soạn nội dung theo chế độ **tự động (autopilot)**: Admin không phải duyệt từng module. **Admin vẫn là người kiểm tra độ phủ tài liệu, rà soát kết quả cuối và quyết định xuất bản.** AI không tự xuất bản khi Admin chưa xác nhận.

## 2. Tổng quan luồng

Modal có 4 bước:

```text
1. Nguồn & loại
   ↓ Chọn loại template, chọn tài liệu, bấm "Phân tích tài liệu"
2. Kiểm tra độ phủ
   ↓ AI liệt kê module; Admin bổ sung tài liệu cho module còn thiếu; bấm "Tạo template"
3. AI tạo nội dung
   ↓ AI tự viết bài học và câu hỏi cho mọi module, không cần duyệt từng module
4. Xem lại & xuất bản
   ↓ Admin xem lại, chỉnh sửa; bấm "Lưu template" → template vào thư viện ở trạng thái Bản nháp
Thư viện template → mở bản nháp (Chỉnh sửa) → Bước 4
   ↓ Admin xử lý cờ bắt buộc; bấm "Xuất bản template" → app tạo PDF + JSON và xuất bản
```

Lượt tạo mới kết thúc bằng **Lưu template**, không xuất bản ngay. Việc xuất bản diễn ra khi Admin mở bản nháp từ thư viện template.

Mỗi lượt chạy chỉ tạo **một** template, **Thông thường** hoặc **Nâng cao**. Không còn lựa chọn “Cả hai”; muốn có cả hai bản, hãy chạy hai lượt riêng.

## 3. Vai trò của Admin, AI và app

| Thành phần | Trách nhiệm chính |
|---|---|
| **Admin** | Thêm và chọn nguồn; chọn loại template; nhập nhiệm vụ (loại Nâng cao); xử lý module “Cần bổ sung”; xem lại, chỉnh sửa, xử lý cờ; thiết lập template; lưu bản nháp; mở bản nháp từ thư viện và bấm xuất bản. |
| **AI** | Phân tích nguồn; đề xuất module và đánh giá độ phủ; đọc tài liệu bổ sung; viết bài học có dẫn chứng; tạo câu hỏi; phát hiện thiếu dữ liệu hoặc mâu thuẫn; thử sửa đầu ra chưa hợp lệ. |
| **App** | Kiểm tra file; quản lý job và tiến trình; lưu trạng thái để tiếp tục; tự thử lại khi máy chủ phản hồi chậm; điều phối Sandbox/Native/dự phòng an toàn; tạo PDF và JSON; lưu Roomfiles; gọi API xuất bản. |

## 4. Chuẩn bị trước khi sử dụng

### 4.1. Quyền cần có

- App cần quyền **Run sandbox agent** (`sandbox:generate`) để chạy AI chính.
- Để dùng Native AI Chat dự phòng, app cần cả hai quyền:
  - `sandbox:ai-chat`
  - `sandbox:ai-chat:write`
- App cần quyền đọc/ghi Roomfiles để tải nguồn lên và lưu kết quả xuất bản.

Nếu thiếu quyền tạo nội dung AI, modal sẽ thông báo để Admin cấp quyền trong phần **Customize access**.

### 4.2. Cấu trúc Roomfiles

Khi cần lưu file, app kiểm tra và tự tạo các thư mục sau nếu chưa có:

```text
Onboarding-app/
├── Uploaded documents/
└── Created templates/
    └── <tên-template>/
```

- Nếu thư mục đã tồn tại, app dùng lại và không tạo trùng.
- `Uploaded documents` chứa tài liệu user tải lên.
- `Created templates/<tên-template>` chứa PDF bài học và file JSON của template đã tạo.

## 5. Chi tiết từng bước

### Bước 1 — Nguồn & loại

Màn hình chia hai cột: bên trái là loại template và thông tin đặt tên, bên phải là tài liệu nguồn.

#### Admin cần làm gì?

1. Mở modal **Tạo template bằng AI** (Template → Tạo bằng AI).
2. Chọn **một** loại template:

   | Lựa chọn | Dùng khi nào? | Thông tin Admin phải nhập |
   |---|---|---|
   | **Thông thường** | Onboarding kiến thức chung cho nhân sự mới. | Không cần nhập thêm. |
   | **Nâng cao** | Onboarding theo vai trò và công việc cụ thể. | **2–8 nhiệm vụ chính**, mỗi dòng một nhiệm vụ. |

3. Nhập (không bắt buộc) **Tên template** và **Tên hệ thống / tổ chức**; phần **Thông tin thêm** có phiên bản phần mềm và ngày hiệu lực. Nếu để trống tên template, AI tự đặt tên.
4. Thêm nguồn bằng một trong hai cách:
   - Tải file lên.
   - Thêm **Ghi chú Admin** bằng tiêu đề và nội dung văn bản.
5. Trong danh sách **Nguồn đã thêm**, đánh dấu từ **1 đến 10 nguồn** dùng cho lần chạy này.
6. Bấm **Phân tích tài liệu** ở chân modal.

#### Quy tắc đối với file tải lên

- Định dạng app chấp nhận: PDF, DOCX, Markdown, TXT và HTML.
- Kích thước tối đa: **2 MB mỗi file**.
- File rỗng hoặc sai định dạng sẽ bị từ chối trước khi phân tích.
- File được lưu vào `Onboarding-app/Uploaded documents`.
- Nếu tên file bị trùng, app giữ cả hai bản thay vì ghi đè file cũ.
- DOCX được app chấp nhận, nhưng việc lấy được nội dung còn phụ thuộc khả năng parse của PrivOS. Với DOCX parse không ổn định, nên chuyển sang PDF có lớp text trước khi tải lên.
- PDF chỉ chứa ảnh scan có thể không cung cấp đủ text cho AI nếu hệ thống chưa OCR được file.

#### App và AI làm gì?

- App kiểm tra file, tạo thư mục Roomfiles nếu cần, tải file lên và yêu cầu hệ thống trích xuất nội dung.
- Khi bấm **Phân tích tài liệu**, AI đọc các nguồn đã chọn, hợp nhất kho kiến thức rồi lập lộ trình module đề xuất. Tiến trình hiển thị theo các cột mốc (đọc tài liệu, hợp nhất, lập lộ trình). Khi xong, modal tự chuyển sang Bước 2.

#### Điều cần hiểu về “Nguồn đã thêm”

- Đây là thư viện nguồn dùng lại, không phải dữ liệu tạm của riêng một lần tạo template.
- Bỏ chọn một nguồn chỉ loại nó khỏi lần chạy hiện tại, không xóa file.
- Nút xóa ở từng nguồn mới thực hiện thao tác xóa nguồn đó.
- Nút **Xóa phiên** của modal không xóa danh sách này.

### Bước 2 — Kiểm tra độ phủ

Đây là bước quan trọng nhất của Admin: bảo đảm mỗi module đều có tài liệu để AI dựa vào trước khi tạo nội dung.

#### Màn hình hiển thị gì?

- Dải 4 số: **module đề xuất**, **đủ tài liệu**, **cần bổ sung**, **phút học** (ước tính).
- Danh sách module (tên tiếng Việt, mô tả, thời lượng, các đoạn tài liệu đang dùng). Mỗi module có trạng thái:
  - **Đủ tài liệu**: AI tìm thấy đoạn tài liệu phù hợp.
  - **Cần bổ sung**: chưa đủ căn cứ; kèm ghi chú AI thiếu gì.

#### Xử lý module “Cần bổ sung”

Với mỗi module chưa đủ, Admin chọn một trong các cách:

| Thao tác | Tác dụng |
|---|---|
| **Tải tài liệu bổ sung** | Tải thêm một file cho module đó. AI chỉ đọc **file mới** (không đọc lại toàn bộ nguồn cũ) và có thể gắn file đó vào cả các module khác nếu phù hợp. Nếu vẫn chưa đủ, module hiển thị ghi chú thiếu bằng tiếng Việt. |
| **Chọn đoạn từ tài liệu đã có** | Tự chọn các đoạn trong tài liệu đã phân tích để gắn cho module. |
| **Vẫn dùng tài liệu hiện có** | Admin xác nhận module đủ dùng với tài liệu hiện có; module chuyển thành “Đủ tài liệu (Admin xác nhận)”. |

#### Chỉnh lộ trình

- **Sửa**: đổi tên, mô tả, thời lượng, mục tiêu của module.
- **Bỏ module**: loại module khỏi lộ trình (các module bắt buộc của khung template không thể bỏ).
- **Thêm module**: thêm một module mới vào cùng template (tên, mô tả), sau đó bổ sung tài liệu cho module đó.

#### Khi nào bấm được “Tạo template”?

Nút **Tạo template** ở chân modal chỉ mở khi **mọi module đã được phủ** (Đủ tài liệu hoặc Admin đã xác nhận). Nếu còn module thiếu, chân modal ghi rõ lý do, ví dụ “Còn module chưa đủ tài liệu.”

### Bước 3 — AI tạo nội dung

- Sau khi bấm **Tạo template**, AI **tự động** viết bài học rồi tạo câu hỏi cho từng module. **Không có bước duyệt từng module.**
- Màn hình hiển thị phần trăm tiến độ và trạng thái của mỗi module (bài học, câu hỏi). Module gặp lỗi có nút **Thử lại**.
- Câu hỏi của mỗi module được tạo sau bài học và dựa trên bài học đó (3–5 câu).
- Khi hoàn tất, bấm **Xem lại template** (hoặc app tự chuyển sang Bước 4).

#### Đóng modal khi AI đang làm việc

- Bấm **×** khi AI đang chạy sẽ hiện hộp xác nhận **“Đóng cửa sổ?”**.
  - **Tiếp tục ở lại**: giữ modal mở, AI tiếp tục.
  - **Đóng và tạm dừng**: đóng modal, AI **tạm dừng**.
- Khi mở lại modal, app khôi phục job đã lưu và **tự tiếp tục** từ chỗ đang dừng.
- Giữ modal mở trong lúc AI làm việc nếu muốn hoàn tất nhanh nhất.

#### Khi máy chủ phản hồi chậm

Khi một yêu cầu tới máy chủ không có phản hồi kịp (ví dụ `tools/call timeout`), app **tự thử lại tối đa 3 lần**, sau khoảng 2 giây, 5 giây rồi 10 giây. Trong lúc đó chân modal hiện “Máy chủ phản hồi chậm, đang thử lại… (n/3)” và màn hình giữ nguyên trạng thái đang làm việc, không hiện thông báo lỗi. Cơ chế này áp dụng cho Bước 2 (các thao tác sửa lộ trình, bổ sung tài liệu, thêm module và lượt AI đọc tài liệu sau đó), Bước 3 và các chỉnh sửa module ở Bước 4.

- Trước khi gửi lại một thao tác thay đổi dữ liệu, app đọc lại job: nếu thao tác đã được máy chủ ghi nhận (ví dụ lộ trình đã sang phiên bản mới, bài học đã lưu), app coi như thành công và làm tiếp, **không gửi lại lần hai**.
- Lỗi có mã từ máy chủ (ví dụ dữ liệu vừa thay đổi, room đang bận) **không** được thử lại tự động; thông báo hiện ngay.
- Chỉ khi cả 3 lần thử lại đều không thành công, app mới hiện “Máy chủ phản hồi chậm. Hãy bấm Thử lại.” kèm nút **Thử lại**.
- Tạm dừng, Xóa phiên hoặc đóng modal sẽ dừng ngay các lần thử lại đang chờ.

#### Sandbox và Native AI Chat hoạt động thế nào?

- **Sandbox** là nhà cung cấp chính.
- Nếu Sandbox thật sự bị lỗi worker, ví dụ `worker_failed` hoặc `Worker exited with code 1`, app có thể tự thử lại **một lần** bằng **Native AI Chat** nếu đủ quyền.
- App không tự chuyển Native cho mọi loại lỗi. Lỗi quyền, dữ liệu đầu vào, đầu ra không hợp lệ hoặc thao tác hủy cần được xử lý theo đúng nguyên nhân.
- Sau một lần Native thất bại, app dừng để tránh lặp vô hạn và hiển thị **Chi tiết lỗi kỹ thuật** (bước, nhà cung cấp, mã lỗi, thông báo).
- Nếu một tiến trình Native cũ chưa được xác nhận đã dừng, app chặn việc tạo thêm tiến trình Native mới. Admin có thể bấm **Kiểm tra lại trạng thái**.
- Nếu tạo bài học hoặc câu hỏi vẫn thất bại, app dùng bản dự phòng dựng trực tiếp từ đoạn nguồn có dẫn chứng (module hiển thị là dự phòng). Admin kiểm tra kỹ ở Bước 4 hoặc dùng **AI viết lại**.

### Bước 4 — Xem lại & xuất bản

Màn hình gồm danh sách module, nội dung module đang chọn (tab **Bài học** và **Câu hỏi**), các cờ của module đó và thiết lập template. Số trên mỗi module trong danh sách là số cờ còn mở.

Bước 4 có hai cách kết thúc, tùy cách mở modal:

| Mở modal từ | Nút chính ở chân modal | Kết quả |
|---|---|---|
| **Tạo bằng AI** (lượt tạo mới) | **Lưu template** | Template vào thư viện ở trạng thái **Bản nháp**, chưa xuất bản. |
| Thư viện template → bản nháp AI → **Chỉnh sửa** | **Xuất bản template** | Template được xuất bản và lưu JSON. |

#### Xem và chỉnh sửa nội dung

Mọi chỉnh sửa đi qua job của lượt chạy, nên nội dung luôn nhất quán:

- **Chỉnh sửa bài học**, sau đó **Lưu bài học**. Vì câu hỏi phải khớp bài học, app hỏi xác nhận: *câu hỏi của module này sẽ được AI tạo lại cho khớp bài học mới*. Sau khi lưu, **câu hỏi của module đó được tạo lại**.
- **Chỉnh sửa câu hỏi** (thêm, sửa, xóa; sửa đáp án và giải thích) rồi **Lưu câu hỏi**. Mỗi module cần từ 3 đến 5 câu.
- **AI viết lại**: AI viết lại cả bài học và câu hỏi của module đó. App cảnh báo vì chỉnh sửa tay trước đó sẽ bị thay thế.
- Trong lúc cập nhật, màn hình hiển thị “Đang cập nhật…” và giữ nguyên nội dung cũ.

#### Cờ kiểm chứng

Cờ là điểm AI không chắc (thiếu thông tin, mâu thuẫn, nguồn kém chất lượng…). Với mỗi cờ có thể:

- **Thêm ghi chú**: ghi chú của Admin và đánh dấu đã xử lý.
- **Chỉnh sửa**: mở đúng module để sửa nội dung liên quan.
- **Loại bỏ nội dung** **không khả dụng** với bản nháp AI này: nội dung được sửa qua job nên không xóa trực tiếp trên bản nháp.

Ngay dưới tab, cảnh báo được gom thành một dải **“N cảnh báo · Xem”**; bấm để mở danh sách. Cờ bắt buộc (mức chặn, màu đỏ) luôn hiện sẵn phía trên nội dung. Cờ chung của cả template chỉ hiện ở module đầu tiên.

Cờ bắt buộc (mức chặn) phải được xử lý trước khi xuất bản, nhưng **không chặn việc lưu bản nháp**: khi lưu, chân modal chỉ nhắc “Còn N cờ bắt buộc — cần xử lý trước khi xuất bản”. Cờ đã xử lý vẫn giữ trạng thái khi app dựng lại bản nháp sau một lần chỉnh sửa module khác; nếu chỉnh sửa làm cờ không còn, cờ đó biến mất.

#### Thiết lập template

- **Ngưỡng đạt (%)** — mặc định 70%.
- **Số lượt mỗi module** — mặc định 2; có thể không giới hạn.
- **Chế độ học**: `Tuần tự` (học theo thứ tự) hoặc `Tự do` (nhân sự tự chọn module).

#### Lưu template (lượt tạo mới)

1. Kiểm tra nội dung và thiết lập.
2. Bấm **Lưu template**. Chân modal hiện “Đang lưu…”; giữ modal mở đến khi app báo hoàn tất.
3. App chuẩn bị thư mục Roomfiles → tạo PDF bài học từng module → tải PDF lên → gắn tài liệu vào template → lưu thiết lập. App **không** xuất bản và **không** lưu file JSON ở bước này.
4. Khi xong, app báo “Đã lưu template vào thư viện ở trạng thái Bản nháp. Mở template để xuất bản khi sẵn sàng.”, tự đóng modal và làm mới thư viện template.
5. Nếu một bước lỗi, modal vẫn mở và nút chính chuyển thành **Thử lại lưu**; lần thử lại dùng lại các PDF đã tải lên.

Lưu bản nháp được phép ngay cả khi còn cờ bắt buộc.

#### Xuất bản (mở bản nháp từ thư viện)

1. Trong thư viện template, mở template AI có nhãn **Bản nháp** và bấm **Chỉnh sửa**. Modal mở thẳng ở Bước 4.
2. Kiểm tra tóm tắt: số module, số câu hỏi, các thiết lập. Vẫn có thể chỉnh sửa module như bình thường.
3. Đảm bảo không còn cờ bắt buộc (chân modal hiện “Còn N cờ bắt buộc” và nút xuất bản bị khóa nếu còn).
4. Bấm **Xuất bản template**. Giữ modal mở đến khi app báo hoàn tất. Nếu một bước lỗi, bấm **Thử lại xuất bản** để tiếp tục từ bước chưa xong.

App thực hiện tuần tự: chuẩn bị thư mục Roomfiles → tạo PDF bài học từng module → tải PDF lên → gắn tài liệu vào template → xuất bản template → lưu file JSON.

```text
Onboarding-app/Created templates/<tên-template>/
├── <bài-học-module-1>.pdf
├── <bài-học-module-2>.pdf
├── ...
└── <tên-template>-<id>-v<phiên-bản>.json
```

Tiến trình xuất bản có checkpoint. Nếu bị gián đoạn, lần thử lại tiếp tục từ phần chưa hoàn tất và tái sử dụng kết quả đã lưu. PDF đã tạo khi **Lưu template** được dùng lại khi xuất bản, không tải lên lần nữa. Nếu Admin chỉnh sửa module sau khi lưu, app dựng lại bản nháp và tạo lại PDF bài học khi xuất bản, nên PDF luôn khớp nội dung mới nhất.

#### Sau khi lưu hoặc xuất bản thành công

Sau khi **Lưu template** thành công, hoặc chỉ khi template đã được xuất bản và lưu JSON thành công, app mới:

- Tự đóng modal.
- Xóa trạng thái tạm của phiên vừa hoàn tất và đưa modal về **Bước 1 — Nguồn & loại** cho lần mở sau.
- Giữ nguyên thư viện **Nguồn đã thêm**.
- Giữ nguyên template (bản nháp hoặc đã xuất bản), PDF và JSON trong Roomfiles.

## 6. Đóng, Hủy và Xóa dữ liệu khác nhau thế nào?

| Thao tác | Tác dụng | Có xóa “Nguồn đã thêm” không? |
|---|---|---|
| **Đóng (×)** | Đóng giao diện. Nếu AI đang tạo nội dung, app hỏi xác nhận rồi **tạm dừng**; mở lại sẽ tự tiếp tục. | Không. |
| **Hủy job** | Yêu cầu dừng job AI đang chạy và dọn tiến trình nhà cung cấp liên quan. | Không. |
| **Xóa phiên → Xóa dữ liệu** | Sau khi xác nhận, xóa tiến trình, lộ trình, bài học, câu hỏi và bản nháp chưa xuất bản của phiên hiện tại; quay về Bước 1. Bản nháp đã **Lưu template** không còn thuộc phiên nên không bị xóa. | Không. |

**Xóa phiên** không xóa template đã xuất bản. Hộp xác nhận “Xóa dữ liệu tạo template?” được hiển thị trước khi app thực hiện.

## 7. Cách xử lý các tình huống thường gặp

### Không bấm được “Phân tích tài liệu” ở Bước 1

- Kiểm tra đã chọn loại template và ít nhất một nguồn (tối đa 10 nguồn).
- Với loại Nâng cao, phải nhập từ 2 đến 8 nhiệm vụ, mỗi dòng một nhiệm vụ.

### Không bấm được “Tạo template” ở Bước 2

- Còn module “Cần bổ sung”: tải tài liệu bổ sung, chọn đoạn từ tài liệu đã có, hoặc chọn **Vẫn dùng tài liệu hiện có**; cũng có thể **Bỏ module** không cần thiết.
- Đợi AI đọc xong tài liệu bổ sung (“AI đang đọc tài liệu bổ sung…”).

### Tải tài liệu bổ sung mà module vẫn “Cần bổ sung”

- Nếu module ghi “AI chưa đọc được tài liệu bổ sung…”, bấm **Thử lại** ở module đó: AI chỉ đọc lại phần của file mới chưa đọc được, không cần tải lại file.
- Đọc ghi chú thiếu của module để biết cần tài liệu gì.
- Tải thêm tài liệu đúng nội dung, hoặc chọn đoạn từ tài liệu đã có.
- Chỉ dùng **Vẫn dùng tài liệu hiện có** khi chắc chắn tài liệu hiện có đã đủ.

### Đóng nhầm modal khi AI đang chạy

- Chọn **Tiếp tục ở lại** ở hộp xác nhận nếu chưa muốn dừng.
- Nếu đã đóng, mở lại modal: AI tiếp tục từ vị trí đã lưu.

### Một module báo lỗi ở Bước 3

- Bấm **Thử lại** ở module đó (hoặc ở thông báo chung).
- Xem **Chi tiết lỗi kỹ thuật**; nếu Sandbox lỗi `worker_failed`, app có thể tự thử Native một lần.

### Hiện “Máy chủ phản hồi chậm, đang thử lại… (n/3)”

- Không cần làm gì: app đang tự thử lại. Giữ modal mở.
- Nếu sau 3 lần vẫn lỗi, app hiện “Máy chủ phản hồi chậm. Hãy bấm Thử lại.”; chờ ít phút rồi bấm **Thử lại**. Thao tác đã được máy chủ ghi nhận sẽ không bị áp dụng hai lần.

### Không thấy nút “Xuất bản template” ở lượt tạo mới

- Lượt tạo mới chỉ có **Lưu template**. Sau khi lưu, mở bản nháp trong thư viện template (bấm **Chỉnh sửa**) để xuất bản.

### Lưu template lỗi giữa chừng

- Modal vẫn mở; bấm **Thử lại lưu**. PDF đã tải lên được dùng lại.

### Không bấm được xuất bản

- Xử lý toàn bộ cờ bắt buộc (màu đỏ) ở từng module; module nào còn cờ có số hiển thị trong danh sách module.
- Chờ app cập nhật xong (“Đang cập nhật…”); mỗi module cần 3–5 câu hỏi.

### Xuất bản lỗi giữa chừng

- Không xóa dữ liệu.
- Bấm **Thử lại xuất bản**. App dùng checkpoint để tiếp tục từ bước chưa hoàn tất.

## 8. Checklist ngắn dành cho Admin

- [ ] Tài liệu nguồn có nội dung text đọc được và không vượt quá 2 MB/file.
- [ ] Đã chọn đúng 1–10 nguồn cần phân tích.
- [ ] Đã chọn đúng loại template (Thông thường hoặc Nâng cao).
- [ ] Nếu chọn Nâng cao, đã nhập 2–8 nhiệm vụ chính rõ ràng.
- [ ] Ở Bước 2, mọi module đều “Đủ tài liệu” và lộ trình hợp lý.
- [ ] Đã giữ modal mở (hoặc xác nhận tạm dừng) trong lúc AI tạo nội dung.
- [ ] Ở Bước 4, đã đọc bài học và kiểm tra câu hỏi, đáp án, giải thích.
- [ ] Đã kiểm tra ngưỡng đạt, số lượt và chế độ học.
- [ ] Đã bấm **Lưu template** và thấy template trong thư viện với nhãn **Bản nháp**.
- [ ] Đã mở bản nháp từ thư viện (**Chỉnh sửa**) và xử lý mọi cờ bắt buộc.
- [ ] Đã bấm **Xuất bản template** và xác nhận PDF/JSON được lưu trong `Onboarding-app/Created templates/<tên-template>`.

## 9. Nguyên tắc an toàn nội dung

- AI chỉ là công cụ soạn thảo; Admin chịu trách nhiệm với bản cuối được xuất bản.
- Bài học và câu hỏi phải có căn cứ từ nguồn hoặc phần nội dung Admin đã xác nhận; việc kiểm tra độ phủ ở Bước 2 là chốt chặn trước khi AI viết.
- Khi nguồn thiếu hoặc mâu thuẫn, ưu tiên hiển thị cảnh báo và yêu cầu rà soát thay vì tự suy diễn.
- Retry nhà cung cấp được giới hạn để tránh chạy lặp và tạo nhiều job nền.
- Bản dự phòng từ nguồn ưu tiên tính kiểm chứng hơn cách diễn đạt sáng tạo.
- Template chỉ được xuất bản sau khi Admin xem lại và không còn cờ bắt buộc.
