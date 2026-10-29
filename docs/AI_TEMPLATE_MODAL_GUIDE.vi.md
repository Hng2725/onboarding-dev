# Hướng dẫn luồng tạo template onboarding bằng AI

## 1. Mục đích của modal

Modal **Tạo template từ tài liệu** giúp Admin biến các tài liệu nghiệp vụ có sẵn thành một hoặc hai template onboarding hoàn chỉnh. Mỗi template có:

- Lộ trình gồm nhiều module học.
- Tài liệu để nhân sự đọc ngay trong app.
- Câu hỏi kiểm tra theo từng module.
- Dẫn chứng liên kết nội dung AI tạo với tài liệu nguồn.
- Thiết lập ngưỡng đạt, số lượt làm và chế độ học.
- File PDF bài học và file JSON lưu trong Roomfiles.

AI hỗ trợ phân tích, đề xuất và soạn nội dung. **Admin vẫn là người rà soát, chỉnh sửa, duyệt và quyết định xuất bản**. AI không tự xuất bản template khi Admin chưa xác nhận.

## 2. Tổng quan luồng

```text
1. Tài liệu nguồn
   ↓ Admin tải lên/chọn nguồn
2. Phân tích
   ↓ AI lập kho kiến thức và ghi nhận điểm cần xác minh
3. Tạo lộ trình
   ↓ Admin chọn loại template; AI đề xuất các module
4. Rà soát
   ↓ Admin duyệt khung, tài liệu học, câu hỏi và thiết lập cuối
5. Xuất bản
   ↓ App tạo PDF + JSON, lưu Roomfiles và xuất bản template
```

Nếu chọn **Cả hai**, thứ tự xử lý là:

```text
Template 1 (Thông thường) → Admin rà soát
→ Template 2 (Chuyên sâu) → Admin rà soát
→ Xuất bản cả hai trong cùng một lượt
```

## 3. Vai trò của Admin, AI và app

| Thành phần | Trách nhiệm chính |
|---|---|
| **Admin** | Thêm và chọn nguồn; chọn loại template; nhập nhiệm vụ cho Template 2; rà soát/chỉnh sửa/duyệt lộ trình, bài học và câu hỏi; xử lý cờ kiểm chứng; thiết lập template; bấm xuất bản. |
| **AI** | Phân tích nội dung nguồn; hợp nhất kho kiến thức; đề xuất module; viết bài học có dẫn chứng; tạo câu hỏi; phát hiện thiếu dữ liệu hoặc mâu thuẫn; thử sửa đầu ra chưa hợp lệ. |
| **App** | Kiểm tra file; quản lý job và tiến trình; lưu trạng thái để tiếp tục; điều phối Sandbox/Native/fallback an toàn; tạo PDF và JSON; lưu Roomfiles; gọi API xuất bản. |

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

### Bước 1 — Tài liệu nguồn

#### Admin cần làm gì?

1. Mở modal **Tạo template từ tài liệu**.
2. Nhập thông tin mô tả nguồn:
   - **Tên hệ thống**: tên sản phẩm hoặc hệ thống được hướng dẫn, ví dụ `PrivOS`.
   - **Phiên bản**: không bắt buộc.
   - **Ngày hiệu lực**: không bắt buộc.
3. Thêm nguồn bằng một trong hai cách:
   - Tải file lên.
   - Thêm **Ghi chú Admin** bằng tiêu đề và nội dung văn bản.
4. Trong phần **Nguồn đã thêm**, đánh dấu từ **1 đến 10 nguồn** muốn dùng cho lần phân tích này.
5. Bấm **Tiếp tục**.

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
- Nguồn được đưa vào thư viện **Nguồn đã thêm** để có thể tái sử dụng ở các lần tạo template sau.
- AI chưa tạo template ở bước này; app chỉ chuẩn bị nội dung nguồn cho bước phân tích.

#### Điều cần hiểu về “Nguồn đã thêm”

- Đây là thư viện nguồn dùng lại, không phải dữ liệu tạm của riêng một lần tạo template.
- Bỏ chọn một nguồn chỉ loại nó khỏi lần phân tích hiện tại, không xóa file.
- Nút xóa ở từng nguồn mới thực hiện thao tác xóa nguồn đó.
- Nút **Xóa dữ liệu** của modal không xóa danh sách này.

### Bước 2 — Phân tích

#### Admin cần làm gì?

1. Kiểm tra lại danh sách nguồn đầu vào.
2. Bấm **Phân tích tài liệu**.
3. Theo dõi các cột mốc trên khung **Tiến trình AI**.
4. Nếu job dừng do lỗi có thể thử lại, bấm **Thử lại**.
5. Khi phân tích hoàn tất, bấm **Chọn loại lộ trình**.

#### AI làm gì?

AI xử lý theo các cột mốc:

1. **Chuẩn bị nguồn tài liệu**: đọc nội dung đã được trích xuất từ các nguồn được chọn.
2. **Phân tích từng lô nguồn**: nhận diện tính năng, thao tác, thuật ngữ, quy tắc và bằng chứng trong từng nhóm tài liệu.
3. **Hợp nhất kho kiến thức**: ghép kết quả các lô, loại nội dung trùng và giữ quan hệ với nguồn.
4. **Sẵn sàng tạo lộ trình**: tạo đầu vào đã chuẩn hóa cho bước đề xuất module.

AI cũng đánh dấu:

- Nội dung chưa đủ bằng chứng.
- Các nguồn có thông tin mâu thuẫn.
- Thuật ngữ hoặc quy tắc cần Admin xác minh.

#### Sandbox và Native AI Chat hoạt động thế nào?

- **Sandbox** là nhà cung cấp chính cho lần phân tích đầu tiên.
- Nếu Sandbox thật sự bị lỗi worker, ví dụ `worker_failed` hoặc `Worker exited with code 1`, app có thể tự thử lại **một lần** bằng **Native AI Chat** nếu đủ quyền.
- Thanh tiến trình sẽ hiển thị việc chuyển từ Sandbox sang Native để Admin biết app vẫn đang xử lý.
- App không tự chuyển Native cho mọi loại lỗi. Lỗi quyền, dữ liệu đầu vào, đầu ra không hợp lệ hoặc thao tác hủy cần được xử lý theo đúng nguyên nhân.
- Sau một lần Native thất bại, app dừng để tránh lặp vô hạn và hiển thị chi tiết lỗi.
- Nếu một tiến trình Native cũ chưa được xác nhận đã dừng, app chặn việc tạo thêm tiến trình Native mới. Admin có thể bấm **Kiểm tra lại trạng thái**.

#### Có thể đóng modal khi AI đang chạy không?

Có. Job và khóa khôi phục được lưu để lần mở modal sau app tiếp tục theo trạng thái đã có. Tuy nhiên, đóng modal sẽ ngăn app bắt đầu một lượt chuyển sang Native mới ở nền. Khi mở lại, app sẽ đối chiếu trạng thái job trước khi tiếp tục.

### Bước 3 — Tạo lộ trình

Bước này gồm hai phần: **chọn loại template** và **duyệt khung lộ trình**.

#### 5.3.1. Chọn loại template

Admin bắt buộc chọn một trong ba phương án:

| Lựa chọn | Dùng khi nào? | Thông tin Admin phải nhập |
|---|---|---|
| **Template 1 — Thông thường** | Onboarding kiến thức chung cho nhân sự thông thường. | Không cần nhập phòng ban, chức danh hoặc nhiệm vụ. |
| **Template 2 — Chuyên sâu** | Onboarding theo vai trò và các công việc thực tế. | Nhập **2–8 nhiệm vụ chính**, mỗi dòng một nhiệm vụ. |
| **Cả hai** | Cần cả bản kiến thức chung và bản chuyên sâu. | Nhập **2–8 nhiệm vụ chính** để tạo Template 2. |

Admin có thể nhập **Tên template**. Nếu để trống, AI/app tự đặt tên phù hợp với nội dung và loại template.

Sau khi thông tin hợp lệ, Admin bấm **Tạo lộ trình**.

#### 5.3.2. AI đề xuất khung lộ trình

AI dùng kho kiến thức đã hợp nhất để đề xuất:

- Danh sách module và thứ tự học.
- Tiêu đề, mô tả, thời lượng và mục tiêu của mỗi module.
- Nguồn hoặc phần nội dung làm bằng chứng cho từng module.
- Mức độ bao phủ nội dung và các điểm còn thiếu.
- Với Template 2, quan hệ giữa module và các nhiệm vụ Admin đã nhập.

#### 5.3.3. Admin duyệt khung

Admin cần kiểm tra toàn bộ module, có thể chỉnh sửa nội dung hoặc bổ sung nguồn trước khi duyệt khung.

Các tên như `t1-overview`, `t1-access`, `t1-navigation`, `t1-core` là **các module khác nhau trong cùng Template 1**, không phải bốn lựa chọn để user chọn một. Ví dụ:

- `t1-overview`: tổng quan.
- `t1-access`: truy cập, quyền hoặc điều kiện bắt đầu.
- `t1-navigation`: làm quen giao diện và điều hướng.
- `t1-core`: quy trình công việc chính.

Admin cần rà soát các module cần thiết trong lộ trình. Nếu giao diện có thao tác thêm module/khung, thao tác đó dùng để bổ sung **một module mới vào cùng template**, không tạo thêm một template độc lập.

Sau khi khung hợp lý, Admin bấm duyệt để AI bắt đầu viết nội dung theo từng module.

### Bước 4 — Rà soát

Bước rà soát có ba tầng: bài học từng module, câu hỏi từng module và bản template tổng thể.

#### 5.4.1. Rà soát bài học của từng module

AI lần lượt viết tài liệu học dựa trên nguồn đã gắn với module. Mỗi bài học có thể gồm:

- Tiêu đề và mô tả.
- Thời lượng dự kiến.
- Mục tiêu học tập.
- Các khối nội dung hướng dẫn.
- Các bước thao tác.
- Dẫn chứng từ tài liệu nguồn.

Admin đọc nội dung ngay trong app, không cần mở URL ở tab khác. Với mỗi module, Admin có thể:

- Sửa tiêu đề, mô tả, thời lượng hoặc mục tiêu.
- Thêm, sửa, sắp xếp hoặc xóa khối nội dung.
- Sửa các bước thao tác và dẫn chứng.
- Bấm **Lưu bài học** để lưu bản đang chỉnh sửa.
- Bấm **Viết lại bài học** nếu muốn AI tạo một bản mới.
- Bấm **Dùng bản từ nguồn** để dùng bản an toàn được dựng trực tiếp từ các đoạn nguồn đã chọn.
- Bấm **Duyệt và sang module tiếp theo** khi bài học đã đạt yêu cầu.

##### Cơ chế “AI + bản an toàn từ nguồn”

Luồng ưu tiên là:

1. AI viết bài học có cấu trúc và dẫn chứng.
2. App kiểm tra đầu ra và yêu cầu sửa nếu cấu trúc chưa hợp lệ.
3. Nếu AI không thể tạo bản đáng tin cậy, Admin có thể dùng **bản từ nguồn**.
4. Bản từ nguồn chỉ tổng hợp nội dung đã có dẫn chứng, hạn chế việc AI tự suy diễn.
5. Admin chỉnh sửa và duyệt bản cuối.

Nếu module không có đủ nguồn, app/AI phải cảnh báo để Admin bổ sung nguồn hoặc tự soạn; không nên tự bịa nội dung.

#### 5.4.2. Rà soát câu hỏi của từng module

Sau khi bài học được duyệt, AI tự tạo câu hỏi dựa trên bài học và nguồn của module. Admin không phải tự tạo toàn bộ câu hỏi từ đầu.

Mỗi câu hỏi có thể gồm:

- Nội dung câu hỏi.
- Các phương án trả lời.
- Đáp án đúng.
- Giải thích đáp án.
- Mức độ: ghi nhớ, quy trình hoặc tình huống.
- Nội dung liên quan và dẫn chứng nguồn.

Admin có thể thêm, sửa hoặc xóa câu hỏi; sửa đáp án và giải thích; yêu cầu **Tạo lại câu hỏi**; sau đó bấm **Duyệt câu hỏi và tiếp tục**.

Nếu quá trình tạo câu hỏi lỗi, app dùng chuỗi phục hồi có giới hạn:

```text
Sandbox thất bại
→ thử Native AI Chat một lần nếu đủ quyền
→ nếu vẫn thất bại, tạo câu hỏi dự phòng từ bài học đã được Admin duyệt
```

Câu hỏi dự phòng chỉ được tạo khi đã có bài học có căn cứ. App không lặp vô hạn các lần gọi AI.

> Lưu ý: “nhiệm vụ” là công việc/trách nhiệm dùng cho Template 2, không phải số câu hỏi trắc nghiệm. Số câu hỏi được hiển thị riêng trong phần câu hỏi hoặc bản tóm tắt xuất bản.

#### 5.4.3. Rà soát template tổng thể

Khi tất cả module đã có bài học và câu hỏi được duyệt, app tạo bản nháp template để Admin kiểm tra lần cuối:

- Tên và mô tả template.
- Thứ tự, nội dung và tài liệu của các module.
- Câu hỏi và đáp án.
- Cờ kiểm chứng còn tồn tại.
- **Ngưỡng đạt** — mặc định 70% nếu chưa thay đổi.
- **Số lượt mỗi module** — mặc định 2; có thể để không giới hạn.
- **Chế độ học**:
  - `Tuần tự`: học theo thứ tự module.
  - `Tự do`: nhân sự có thể tự chọn module.

Các cờ bắt buộc phải được xử lý trước khi nút chuyển sang xuất bản được mở. Nếu cần sửa lại nội dung module, Admin có thể bấm **Chỉnh sửa module**.

Nếu chọn **Cả hai**, Admin hoàn tất Template 1 rồi bấm **Tiếp: Template 2**, rà soát Template 2 và cuối cùng bấm **Kiểm tra xuất bản**.

### Bước 5 — Xuất bản

#### Admin cần làm gì?

1. Kiểm tra thẻ tóm tắt của từng template: số module, số khối tài liệu, số câu hỏi và các thiết lập.
2. Đảm bảo không còn cờ bắt buộc.
3. Bấm **Xuất bản template** hoặc **Xuất bản cả hai**.
4. Giữ modal mở cho đến khi app báo hoàn tất. Nếu một bước lỗi, bấm **Thử lại xuất bản** để tiếp tục từ bước chưa xong.

#### App làm gì?

App thực hiện tuần tự và hiển thị tiến trình:

1. **Chuẩn bị thư mục Roomfiles**.
2. **Tạo PDF bài học** cho từng module.
3. **Tải PDF lên Roomfiles**.
4. **Gắn tài liệu vào template** để nhân sự có thể đọc trong app.
5. **Xuất bản template** qua API template.
6. **Lưu file JSON** mô tả template đã xuất bản.

Kết quả được lưu theo cấu trúc:

```text
Onboarding-app/Created templates/<tên-template>/
├── <bài-học-module-1>.pdf
├── <bài-học-module-2>.pdf
├── ...
└── <tên-template>-<id>-v<phiên-bản>.json
```

Tiến trình xuất bản có checkpoint. Nếu bị gián đoạn, lần thử lại tiếp tục từ phần chưa hoàn tất và tái sử dụng kết quả đã lưu thay vì tạo lại tất cả từ đầu.

Khi chọn **Cả hai**, app xuất bản Template 1 và Template 2 trong cùng một batch sau khi cả hai đã được rà soát đầy đủ.

#### Sau khi xuất bản thành công

Chỉ khi tất cả template mục tiêu đã được xuất bản và lưu JSON thành công, app mới:

- Tự đóng modal.
- Xóa trạng thái tạm của phiên tạo vừa hoàn tất.
- Đưa modal về **Bước 1 — Tài liệu nguồn** cho lần mở tiếp theo.
- Giữ nguyên thư viện **Nguồn đã thêm**.
- Giữ nguyên các template, PDF và JSON đã xuất bản trong Roomfiles.

## 6. Đóng modal, Hủy job và Xóa dữ liệu khác nhau thế nào?

| Thao tác | Tác dụng | Có xóa “Nguồn đã thêm” không? |
|---|---|---|
| **Đóng (X)** | Đóng giao diện. Trạng thái job đã lưu có thể được khôi phục khi mở lại. | Không. |
| **Hủy job** | Yêu cầu dừng job AI đang chạy và dọn tiến trình nhà cung cấp liên quan. | Không. |
| **Xóa dữ liệu** | Sau khi xác nhận, xóa tiến trình, lộ trình, bài học, câu hỏi và bản nháp chưa xuất bản của phiên hiện tại; quay về Bước 1. | Không. |

Nút **Xóa dữ liệu** không xóa template đã xuất bản. Hộp xác nhận được hiển thị trước khi app thực hiện thao tác này.

## 7. Cách xử lý các tình huống thường gặp

### Không bấm được “Tiếp tục” ở Bước 1

- Kiểm tra đã chọn ít nhất một nguồn hay chưa.
- Mỗi lần chỉ chọn tối đa 10 nguồn.

### Không bấm được “Tạo lộ trình”

- Phải chọn Template 1, Template 2 hoặc Cả hai.
- Nếu chọn Template 2/Cả hai, phải nhập từ 2 đến 8 nhiệm vụ, mỗi dòng một nhiệm vụ.
- Bước phân tích phải hoàn tất.

### AI báo module thiếu nguồn

- Quay lại khung lộ trình và bổ sung nguồn phù hợp cho module.
- Hoặc Admin tự soạn nội dung nếu tài liệu hiện có chưa mô tả nghiệp vụ đó.
- Không nên duyệt một bài học có thông tin không kiểm chứng được.

### Sandbox báo `worker_failed`

- Xem phần chi tiết lỗi và nhà cung cấp trên tiến trình.
- Nếu đủ quyền Native và tiến trình cũ đã dừng, app tự thử Native một lần cho các luồng có hỗ trợ.
- Nếu không có Native hoặc Native cũng thất bại, dùng **Thử lại** sau khi hệ thống ổn định; với bài học/câu hỏi có thể dùng phương án dự phòng từ nguồn khi giao diện cung cấp.

### Không bấm được xuất bản

- Mở từng template và xử lý toàn bộ cờ bắt buộc.
- Đảm bảo bài học và câu hỏi của tất cả module đã được duyệt.
- Với lựa chọn Cả hai, phải hoàn tất rà soát cả Template 1 và Template 2.

### Xuất bản lỗi giữa chừng

- Không xóa dữ liệu.
- Bấm **Thử lại xuất bản**. App dùng checkpoint để tiếp tục từ bước chưa hoàn tất.

## 8. Checklist ngắn dành cho Admin

- [ ] Tài liệu nguồn có nội dung text đọc được và không vượt quá 2 MB/file.
- [ ] Đã chọn đúng 1–10 nguồn cần phân tích.
- [ ] Đã xem các mâu thuẫn hoặc điểm AI yêu cầu xác minh.
- [ ] Đã chọn đúng Template 1, Template 2 hoặc Cả hai.
- [ ] Nếu có Template 2, đã nhập 2–8 nhiệm vụ chính rõ ràng.
- [ ] Đã duyệt khung và nguồn của từng module.
- [ ] Đã đọc, chỉnh sửa và duyệt bài học của mọi module.
- [ ] Đã kiểm tra câu hỏi, đáp án và phần giải thích.
- [ ] Đã xử lý mọi cờ bắt buộc.
- [ ] Đã kiểm tra ngưỡng đạt, số lượt và chế độ học.
- [ ] Đã xác nhận PDF/JSON được lưu trong `Onboarding-app/Created templates/<tên-template>` sau khi xuất bản.

## 9. Nguyên tắc an toàn nội dung

- AI chỉ là công cụ soạn thảo; Admin chịu trách nhiệm với bản cuối được xuất bản.
- Bài học và câu hỏi phải có căn cứ từ nguồn hoặc phần nội dung Admin đã xác nhận.
- Khi nguồn thiếu hoặc mâu thuẫn, ưu tiên hiển thị cảnh báo và yêu cầu rà soát thay vì tự suy diễn.
- Retry nhà cung cấp được giới hạn để tránh chạy lặp và tạo nhiều job nền.
- Bản dự phòng từ nguồn ưu tiên tính kiểm chứng hơn cách diễn đạt sáng tạo.
- Template chỉ được xuất bản sau khi Admin duyệt và không còn cờ bắt buộc.
