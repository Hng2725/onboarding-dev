# Thiết kế cải tiến luồng tạo template onboarding bằng AI

Ngày: 2026-10-26  
Trạng thái: Chờ duyệt  
Phạm vi: Onboarding AI generator, AI review, Roomfiles export và màn học theo module

## 1. Mục đích

Làm cho luồng tạo template AI rõ ràng và đáng tin cậy hơn với Admin:

- Bắt buộc chọn Template 1, Template 2 hoặc Cả hai trước khi tạo.
- Template 2 không còn bị khóa nút âm thầm khi thiếu hồ sơ vai trò.
- Nếu chọn Cả hai, tạo hai template độc lập, rà soát Template 1 trước rồi Template 2, sau đó xuất bản bằng một thao tác và tự đóng modal khi toàn bộ quy trình thành công.
- Bố cục phân tích tài liệu và tạo nội dung gọn theo phương án đã chọn: Workspace hai cột.
- Hiển thị các cột mốc AI thực thay vì chỉ một dòng trạng thái kỹ thuật.
- Mỗi module có tài liệu học dạng PDF, lưu trong Roomfiles và đọc được ngay trong app.

## 2. Hiện trạng và nguyên nhân

- `templateKind` đang mặc định là `normal`, nên chưa có trạng thái “chưa chọn” để ép người dùng quyết định.
- Nút tạo Template 2 bị vô hiệu hóa khi chưa có chức danh hoặc danh sách nhiệm vụ không nằm trong khoảng 2–8 dòng, nhưng giao diện không giải thích điều kiện đang thiếu.
- Một AI job hiện chỉ tạo một loại template và state giao diện chỉ giữ một `templateJob` cùng một `review`.
- AI đã sinh các `LessonBlock`, nhưng quá trình materialize đặt `resources: []`. Vì vậy các màn dựa vào resource có thể trông như chỉ có câu hỏi và không có tài liệu đọc.
- Progress hiện đếm các call đã xuất hiện. Các call kiểm chứng chỉ được tạo sau khi có câu hỏi, nên tổng số bước thay đổi trong lúc chạy và không diễn tả được toàn bộ hành trình cho người dùng.
- Trình xem file hiện ưu tiên tải xuống hoặc mở liên kết; chưa có trình PDF nhúng dùng blob đã tải qua authenticated Roomfiles bridge.

## 3. Mục tiêu, phi mục tiêu và điều cần tránh

### Mục tiêu

- Không thể bắt đầu tạo template khi chưa chọn loại.
- Template 2 và lựa chọn Cả hai có validation tại chỗ, có thông báo cụ thể và tập trung đúng trường lỗi.
- Luồng Cả hai có thể resume/retry mà không tạo lại Template 1 đã hoàn tất.
- Admin luôn biết AI đã làm xong gì, đang làm gì và còn những gì.
- Nội dung PDF phản ánh đúng bài học sau khi Admin đã rà soát.
- File PDF và JSON nằm tại `Onboarding-app/Created templates/<tên-template>/`.
- Nhân sự xem PDF trong app, không bị chuyển sang tab URL bên ngoài.
- Modal chỉ tự đóng sau khi cả hai template đã xuất bản và các artifact bắt buộc đã lưu thành công.

### Phi mục tiêu

- Không gộp Template 1 và Template 2 thành một template hỗn hợp.
- Không tạo PDF trong lúc AI còn chạy hoặc trước khi Admin rà soát xong.
- Không thay đổi luật tạo nội dung, số module, số câu hỏi hoặc cách kiểm chứng nguồn ngoài phần cần thiết để tạo resource.
- Không xây trình chỉnh sửa PDF; Admin vẫn chỉnh nội dung bài học trong màn rà soát.

### Điều cần tránh

- Progress giả chạy theo thời gian nhưng không phản ánh backend.
- Tạo hai template cùng tên khiến dùng chung nhầm thư mục hoặc ghi đè file.
- Upload PDF thành công nhưng template không lưu `fileId`, hoặc template được xuất bản khi resource chưa sẵn sàng.
- Đóng modal sau khi chỉ một trong hai template hoàn tất.
- Mở `sourceUrl` hoặc URL tải file ở tab ngoài để đọc tài liệu.

## 4. Các phương án đã cân nhắc

### Phương án A — Điều phối hai job ở giao diện (đã chọn)

Giao diện lần lượt khởi chạy hai template job hiện có, lưu state theo từng loại, rồi điều khiển quy trình rà soát và xuất bản chung.

Ưu điểm:

- Tận dụng service/job hiện có và giữ mỗi template độc lập.
- Ít thay đổi backend, giảm rủi ro với retry, repair và verification.
- Có thể retry riêng job hoặc export đang lỗi.

Đổi lại:

- UI phải quản lý batch state, hai resume key và trạng thái xuất bản từng template.
- “Xuất bản cả hai” là một thao tác của người dùng nhưng hai lần publish phía dưới không phải một database transaction tuyệt đối.

### Phương án B — Thêm batch job mới ở backend (không chọn)

Backend nhận một job chứa cả hai loại template và quản lý mọi stage trong một record nhóm.

Ưu điểm là tracking tập trung. Đổi lại phải thay đổi sâu schema job, pump, retry, resume và API, trong khi nội dung của hai template vẫn được sinh bởi hai pipeline riêng. Chi phí và rủi ro không tương xứng với nhu cầu hiện tại.

## 5. Trải nghiệm người dùng

### 5.1 Chọn loại template

State lựa chọn là `normal | advanced | both | null`, mặc định `null`.

Ba thẻ lựa chọn ngang:

- Template 1 — Nhân sự thông thường.
- Template 2 — Nhân sự chuyên sâu.
- Cả hai — Tạo hai template độc lập.

Khi chọn Template 2 hoặc Cả hai, hiển thị hồ sơ vai trò. Chức danh là bắt buộc; nhiệm vụ chính phải có 2–8 dòng không rỗng. Thay vì chỉ disable nút, giao diện hiển thị helper/error ngay dưới trường, số dòng hợp lệ và lý do chưa thể tạo.

Nếu Admin nhập một tên chung khi chọn Cả hai, app tự thêm hậu tố phân biệt `– Template 1` và `– Template 2`. Đây là quy ước của implementation để tránh trùng tiêu đề/thư mục.

### 5.2 Workspace hai cột

Màn phân tích và màn tạo dùng cùng ngôn ngữ bố cục:

- Hàng trên: tiêu đề, trạng thái tổng quát và selector khi phù hợp.
- Cột trái: dữ liệu đầu vào, thông tin vai trò và kết quả dự kiến.
- Cột phải: danh sách cột mốc AI theo trạng thái `chờ / đang làm / hoàn tất / lỗi`.
- Thanh hành động ngang ở cuối: hành động chính, hủy job và thông tin tự động lưu/resume.

Trên màn nhỏ, hai cột gập thành một cột nhưng nhóm hành động vẫn nằm cùng một thanh, không tạo chuỗi nút rời từ trên xuống dưới.

### 5.3 Cột mốc tiến trình

Progress không chạy theo bộ đếm thời gian giả. Nó được suy ra từ job record và state upload/publish thật.

Phân tích tài liệu:

1. Chuẩn bị nguồn tài liệu.
2. Phân tích từng lô nguồn.
3. Hợp nhất kho kiến thức.
4. Sẵn sàng tạo lộ trình.

Tạo từng template:

1. Chuẩn bị cấu trúc template.
2. Viết tài liệu học (`*-lessons`).
3. Tạo câu hỏi kiểm tra (`*-questions`).
4. Kiểm chứng với nguồn (`D*`).
5. Tạo bản nháp để rà soát.

Retry/repair được hiển thị như chi tiết của cột mốc đang chạy, ví dụ “Tự sửa lần 1/2”, không trở thành một cột mốc mới làm tăng tổng bước. Khi chọn Cả hai, có progress tổng gồm Template 1 rồi Template 2 và progress chi tiết cho template đang chạy.

### 5.4 Rà soát hai template

Luồng được cố định:

```text
Template 1 được tạo
        ↓
Rà soát Template 1 ── Next ──► Rà soát Template 2
        ▲                              │
        └──────────── Quay lại ────────┘
                                       ↓
                             Kiểm tra xuất bản cả hai
```

- Header hiển thị `Template 1/2` hoặc `Template 2/2` và loại nhân sự.
- Nội dung mỗi module được chia thành tab `Tài liệu học` và `Câu hỏi`, tránh một danh sách dài xen lẫn.
- Danh sách module vẫn ở bên trái; panel cờ kiểm chứng có thể thu gọn để tăng vùng đọc.
- Nút Next từ Template 1 dùng cùng điều kiện readiness với publish: cờ blocking phải được xử lý; warning vẫn theo luật hiện có.
- Có thể quay lại Template 1 mà không mất chỉnh sửa.
- Mỗi template giữ riêng passing score, số lượt và learning mode.

### 5.5 Xuất bản và tự đóng modal

Một nút `Xuất bản cả hai` thực hiện theo thứ tự:

1. Kiểm tra readiness của mọi template.
2. Tạo toàn bộ PDF từ nội dung đã rà soát.
3. Đảm bảo folder từng template tồn tại.
4. Upload PDF, lấy `fileId` thật và gắn resource vào đúng module draft.
5. Khi cả hai template đều đã có resource hợp lệ, publish từng template.
6. Lưu JSON artifact của từng template vào cùng folder của template đó.
7. Refresh danh sách template và tự đóng modal.

Nếu một bước lỗi, modal vẫn mở, hiển thị template/module bị lỗi và nút retry. Những PDF, resource hoặc template đã hoàn tất được tái sử dụng; retry không chạy lại AI và không nhân đôi resource.

Hai publish call không tạo thành một transaction database tuyệt đối. Nếu template thứ nhất đã publish mà template thứ hai lỗi, UI ghi nhận trạng thái thứ nhất và retry riêng template thứ hai. Người dùng vẫn chỉ thao tác qua một nút tổng.

## 6. Thiết kế kỹ thuật

### 6.1 State điều phối

Thay state đơn thành tập kết quả có thứ tự:

```ts
type TemplateSelection = EmployeeType | 'both' | null;

interface TemplateRun {
  kind: EmployeeType;
  job: AiJobRecord | null;
  review: AdminTemplateDetail | null;
  publishState: 'idle' | 'preparing_files' | 'ready' | 'published' | 'failed';
  error?: string;
}
```

`normal` tạo một run; `advanced` tạo một run; `both` tạo `[normal, advanced]`. Runner xử lý tuần tự để không mở hai Native AI attempts đồng thời và để trạng thái cleanup hiện có tiếp tục an toàn.

Resume key được tách theo loại template trong room. Khi mở lại modal, app khôi phục cả hai job, bỏ qua run đã hoàn tất và tiếp tục run đang dở.

### 6.2 Resource PDF

Mỗi module có đúng một generated resource loại `file`, bắt buộc, với ID ổn định dựa trên template/version/module. Resource gồm tiêu đề, mô tả và `fileId` Roomfiles.

AI review service được mở rộng bằng operation chuyên biệt để upsert generated resource theo module. Operation phải idempotent: retry thay `fileId`/metadata của resource cùng ID, không append bản sao.

PDF chứa:

- Tên template và module.
- Mô tả, mục tiêu, thời lượng dự kiến.
- Toàn bộ lesson blocks theo thứ tự, gồm heading, body, steps và nhãn cảnh báo/tình huống/tổng kết.
- Danh sách nguồn đối chiếu ngắn ở cuối; không đưa câu hỏi hoặc đáp án vào tài liệu học.

PDF được tạo phía client bằng thư viện hỗ trợ font Unicode tiếng Việt và được dynamic-import tại thời điểm export để không làm nặng lần tải app đầu. Lựa chọn implementation mặc định là `pdfmake` với font Unicode đóng gói sẵn; nếu bundle thực tế không tương thích Vite, builder có thể chuyển sang `pdf-lib` + font Unicode bundled mà không đổi hợp đồng tính năng.

### 6.3 Cấu trúc Roomfiles

```text
Onboarding-app/
└── Created templates/
    └── <tên-template-đã-làm-sạch>/
        ├── 01-<module-slug>.pdf
        ├── 02-<module-slug>.pdf
        ├── ...
        └── <template-slug>-<id>-v<version>.json
```

Tên folder giữ tên template dễ đọc, chỉ thay ký tự điều khiển và dấu phân cách đường dẫn, đồng thời giới hạn độ dài. Folder được tìm/tạo idempotently dưới đúng `Created templates`. Upload dùng `replace` để retry cập nhật file thay vì tạo bản sao.

### 6.4 Trình đọc trong app

Tạo component dùng chung để:

- Lấy metadata file và bytes qua authenticated `app.rest` hiện có.
- Kiểm tra file thuộc đúng room.
- Tạo blob URL cục bộ rồi render PDF bằng `iframe`/`object` ngay trong vùng học.
- Có loading, lỗi và retry; không có `target="_blank"` trong luồng đọc chính.
- Revoke blob URL khi đổi module hoặc unmount.

Màn học theo module đặt `Tài liệu PDF` làm tab mặc định và giữ `Nội dung dễ đọc` từ LessonBlock làm bản HTML truy cập tốt hơn. Việc hoàn thành bài học tiếp tục dùng API/module state hiện có; mở được tài liệu hoặc đọc đến phần tổng kết sẽ cho phép người học xác nhận hoàn thành, không tự động đánh dấu chỉ vì file tải xong.

## 7. Xử lý lỗi và tính nhất quán

- Job Template 2 lỗi không làm mất Template 1 đã tạo.
- Validation role profile chạy trước khi gọi API và backend vẫn giữ validation phòng thủ.
- PDF phải upload thành công và resource phải được lưu trước publish.
- Nếu upload một module lỗi, không publish template đó; retry chỉ module lỗi/chưa hoàn tất.
- Nếu JSON export lỗi sau publish, giữ trạng thái đã publish và retry riêng export như cơ chế hiện tại.
- Chỉ gọi callback đóng modal khi mọi run có trạng thái publish/export hoàn tất.
- Hủy job chỉ hủy run đang chạy; các draft đã tạo vẫn được giữ để resume/rà soát.

## 8. Kiểm thử

Thực hiện theo TDD, tối thiểu gồm:

- Selector không có mặc định và bắt buộc chọn.
- Validation Template 2/Cả hai hiển thị đúng lỗi chức danh và 2–8 nhiệm vụ.
- Runner Cả hai chạy normal trước advanced, resume đúng và retry không tạo lại run hoàn tất.
- Milestone mapping cho inventory, lessons, questions, verification, repair, retry, failed và completed.
- Review navigation Template 1 → Template 2 → publish summary, có thể quay lại.
- Nút publish chung không chạy khi một review chưa ready.
- Tạo folder theo template, xử lý create race, upload replace và lưu JSON/PDF đúng folder.
- PDF artifact chứa tiếng Việt, tiêu đề, lesson blocks và không chứa đáp án câu hỏi.
- Upsert resource idempotent và template learner nhận đúng `fileId`.
- PDF được render bằng blob URL trong app; URL được revoke; không mở tab ngoài.
- Modal không đóng khi bất kỳ bước nào lỗi và tự đóng đúng một lần sau khi cả hai hoàn tất.
- Typecheck, test suite, build và kiểm tra thủ công trên Chrome với luồng Template 2 và Cả hai.

## 9. Tiêu chí hoàn tất

- Người dùng tái hiện được đầy đủ ba lựa chọn và không thể tạo khi chưa chọn.
- Template 2 có thể tạo khi form hợp lệ và luôn giải thích khi chưa hợp lệ.
- Cả hai template được tạo, rà soát tuần tự, xuất bản bằng một thao tác và modal tự đóng khi thành công.
- Tiến trình hiển thị rõ các cột mốc thật và trạng thái retry/repair.
- Mỗi module xuất bản có một PDF trong đúng folder template, có resource liên kết và đọc được trong app.
- Không có regression ở luồng tạo một template, resume, cancel, review, publish và learner module quiz.
