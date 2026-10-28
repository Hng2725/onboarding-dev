# Thiết kế tạo tài liệu học an toàn theo module (A + fallback C)

Ngày: 2026-10-28  
Trạng thái: Đã duyệt  
Phạm vi: Phân tích tài liệu, duyệt khung, viết tài liệu học, tạo câu hỏi, resume/retry và fallback trong AI Template Generator

## 1. Mục đích

Thay luồng “AI tạo toàn bộ tài liệu học trong một request JSON lớn” bằng một quy trình có kiểm soát:

- App tự dựng và sở hữu cấu trúc template, module, ID, ánh xạ nhiệm vụ và trạng thái tiến trình.
- Admin duyệt khung module trước khi phát sinh nội dung AI.
- AI chỉ viết từng module độc lập và chỉ tạo câu hỏi sau khi tài liệu học tương ứng đã được duyệt.
- Khi AI hoặc PrivOS không sẵn sàng, app tạo bản dự phòng từ nội dung nguồn đã trích xuất thay vì làm thất bại toàn bộ template.
- Một module lỗi không làm mất các module đã hoàn tất và không bắt đầu lại toàn bộ job.

Thiết kế này áp dụng cho Template 1, Template 2 và lựa chọn Cả hai. Luồng Cả hai tiếp tục rà soát Template 1 trước, sau đó Template 2, rồi xuất bản cả hai cùng một thao tác.

## 2. Hiện trạng và nguyên nhân cần đổi kiến trúc

Luồng hiện tại giao cho AI tạo toàn bộ 5–8 module và `taskCoverage` trong một kết quả có schema phức tạp. Thực tế đã xuất hiện ba nhóm lỗi độc lập nhưng đều được hiển thị dưới cột mốc “Viết tài liệu học”:

1. Output không đúng hợp đồng: AI tự đoán field `responsibility`, `moduleLocalIds` hoặc giá trị `relevance` không hợp lệ; validator cần `task`, `featureIds`, `moduleLocalId` và `relevance: explicit | inferred`.
2. Provider/worker lỗi: Sandbox trả `worker_failed` dù request và quyền hợp lệ.
3. Điều phối PrivOS lỗi hoặc chậm: Native AI Chat hoàn tất sát timeout hoặc trả `Another request in this project is still running` dù các attempt đã terminal.

Auto-repair hiện sửa lại một object lớn. Một lỗi nhỏ ở một module hoặc ở `taskCoverage` có thể làm bỏ toàn bộ output. Retry tiếp tục dùng cùng phạm vi lớn nên chi phí, thời gian và xác suất lỗi đều cao.

Đây là vấn đề kiến trúc, không nên giải quyết bằng cách tăng số lần retry.

## 3. Mục tiêu, phi mục tiêu và điều cần tránh

### Mục tiêu

- Admin chỉ phải quyết định nghiệp vụ: chọn nguồn, chọn loại template, duyệt khung, rà soát nội dung và xuất bản.
- App luôn sở hữu schema và các quan hệ định danh; AI không được tự thiết kế hợp đồng dữ liệu.
- Tài liệu học được tạo, kiểm tra và lưu theo từng module.
- Mỗi module có trạng thái độc lập và có thể resume sau reload/đóng modal.
- Chỉ một request AI của app được chạy trong cùng room/project tại một thời điểm.
- Có bản dự phòng dựa hoàn toàn trên nguồn khi AI không thể hoàn tất.
- Không tự xuất bản; Admin luôn rà soát trước khi nhân viên nhìn thấy nội dung.
- Câu hỏi chỉ dựa trên tài liệu học đã được Admin duyệt.

### Phi mục tiêu

- Không thay AI bằng một trình biên soạn văn phong hoàn chỉnh không cần Admin.
- Không bảo đảm bản fallback có chất lượng diễn đạt ngang bản AI.
- Không tự tạo câu hỏi cho module fallback chưa được Admin duyệt.
- Không chạy Template 1 và Template 2 song song.
- Không sửa hoặc mở khóa project nội bộ của PrivOS từ app.

### Điều cần tránh

- Retry vô hạn hoặc retry ngay khi provider báo project đang bận.
- Một lần lỗi làm reset toàn bộ template.
- Progress giả theo timer mà không gắn với state thật.
- AI tự sinh ID, frame, quan hệ nhiệm vụ hoặc đường dẫn Roomfiles.
- Fallback diễn giải/suy luận thêm nội dung không có trong nguồn.
- Tạo câu hỏi từ nội dung chưa được duyệt.

## 4. Các phương án đã cân nhắc

### Phương án A — App dựng khung, AI viết từng module (đã chọn)

App tạo cấu trúc xác định trước; AI nhận một module và các section nguồn liên quan để viết nội dung module đó. Kết quả được validate và lưu ngay.

Ưu điểm:

- Giảm mạnh kích thước và độ phức tạp mỗi AI call.
- Lỗi chỉ ảnh hưởng một module.
- Resume, retry, cache và hiển thị tiến trình chính xác hơn.
- App kiểm soát được mọi ID và quan hệ.

Đổi lại:

- Có nhiều call nhỏ, phải có hàng đợi tuần tự và giới hạn tải.
- Cần thêm state/module lifecycle và màn duyệt khung.

### Phương án B — AI chỉ tạo Markdown, Admin tự chia module (không chọn)

Ít lỗi schema nhưng chuyển quá nhiều công việc sang Admin, không phù hợp mục tiêu tạo template có cấu trúc và câu hỏi tự động.

### Phương án C — Không phụ thuộc AI, ghép nội dung từ nguồn (chọn làm fallback)

App tạo bài học bằng tiêu đề, đoạn văn, danh sách bước và trích dẫn nguyên văn từ nguồn. Cách này ổn định và không hallucinate nhưng văn phong kém tự nhiên hơn, vì vậy chỉ dùng khi AI không thể hoàn tất hoặc Admin chủ động chọn.

### Quyết định

Dùng A làm luồng chính và C làm đường lui theo từng module. Không tăng số lần retry toàn bộ stage.

## 5. Phân chia trách nhiệm

### Admin thực hiện

1. Tải/chọn tài liệu nguồn.
2. Chọn Template 1, Template 2 hoặc Cả hai.
3. Với Template 2, nhập 2–8 nhiệm vụ chính. Không hiển thị và không yêu cầu Phòng ban hoặc Chức danh.
4. Xem cảnh báo nguồn thiếu, mâu thuẫn hoặc lỗi thời.
5. Rà soát khung module, có thể đổi tên, thêm, xóa hoặc sắp xếp module.
6. Bấm **Duyệt khung** để cho phép bắt đầu viết nội dung.
7. Rà soát từng module: duyệt, chỉnh sửa, dùng fallback hoặc thử AI lại sau.
8. Sau khi toàn bộ tài liệu học đã được duyệt, tiếp tục sang câu hỏi.
9. Rà soát câu hỏi và xuất bản.

### App thực hiện tự động, không phụ thuộc AI

- Parse file, chia section và lưu metadata nguồn.
- Dựng khung module, `localId`, `frameKey`, thứ tự và các liên kết dữ liệu.
- Dựng `taskCoverage` cho Template 2 từ danh sách nhiệm vụ và feature/section đã phân tích.
- Giới hạn một AI attempt đang chạy trong room/project.
- Điều phối hàng đợi module tuần tự.
- Validate, lưu checkpoint và cache output theo module.
- Tạo fallback từ section nguồn.
- Theo dõi trạng thái provider, timeout, cleanup và project busy.
- Tạo file/PDF/JSON và lưu Roomfiles sau khi Admin duyệt.
- Resume đúng module sau reload hoặc mở lại modal.

### AI thực hiện

- Viết nội dung của đúng một module dựa trên khung và section nguồn được cấp.
- Tạo ví dụ/tình huống cho Template 2 nhưng chỉ trong phạm vi chứng cứ nguồn.
- Đánh dấu thiếu/mâu thuẫn nếu không đủ dữ liệu.
- Sau khi tài liệu module được duyệt, tạo 3–5 câu hỏi cho module đó.

AI không được tạo ID, chọn số lượng module, sửa `taskCoverage`, quyết định thứ tự, quyết định publish hoặc đọc nguồn ngoài danh sách app cung cấp.

### Nhân viên/người học

Không tham gia quy trình tạo. Chỉ thấy template, tài liệu và câu hỏi sau khi Admin xuất bản.

## 6. Luồng trải nghiệm Admin

### 6.1 Nguồn và đối tượng

Giữ các bước hiện có:

1. Chọn nguồn.
2. Phân tích.
3. Chọn loại template; nếu là Template 2/Cả hai thì nhập 2–8 nhiệm vụ chính.

Form mới bỏ hoàn toàn trường Phòng ban và Chức danh. Validation tạo Template 2 chỉ kiểm tra danh sách nhiệm vụ. Job/template cũ có thể vẫn chứa hai field legacy; app tiếp tục đọc được nhưng không hiển thị, không bắt nhập lại và không dùng chúng làm điều kiện tạo nội dung mới.

Kết quả phân tích hiển thị nguồn hợp lệ, cảnh báo và feature/section có thể dùng. Cảnh báo blocking phải được Admin xác nhận/xử lý trước khi duyệt khung; warning không chặn.

### 6.2 Khung module bắt buộc phải duyệt

Thêm bước **Duyệt khung** giữa Phân tích và Viết tài liệu học.

Mỗi thẻ module hiển thị:

- Thứ tự, tên, loại/frame và thời lượng dự kiến.
- Mục tiêu học tập.
- Nhiệm vụ liên quan (Template 2).
- Nguồn dự kiến dùng.
- Cảnh báo thiếu nguồn.

Admin có thể đổi tên, sửa mục tiêu, thêm/xóa/sắp xếp module trong giới hạn của loại template. App cập nhật lại liên kết nhiệm vụ và báo lỗi nếu có nhiệm vụ chưa được bao phủ.

Quy tắc khung có thẩm quyền giữ nguyên theo validator hiện tại:

- Template 1 có 4–8 module, chọn theo thứ tự cố định từ `t1-overview`, `t1-access`, `t1-navigation`, `t1-core`, `t1-core-2`, `t1-data`, `t1-security`, `t1-support`.
- Template 1 bắt buộc có `t1-overview` và `t1-core`, trừ khi frame thiếu được biểu diễn bằng blocking `missing` flag.
- Template 2 có 5–8 module, chọn theo thứ tự cố định từ `t2-role`, `t2-permissions`, `t2-task-1` … `t2-task-6`, `t2-collab`, `t2-reports`, `t2-control`.
- Một frame chỉ xuất hiện tối đa một lần; Admin không thể kéo module ra ngoài thứ tự frame có thẩm quyền.

Nút **Duyệt khung và bắt đầu viết** chỉ bật khi:

- Module đáp ứng số lượng/quy tắc bắt buộc.
- Mỗi nhiệm vụ Template 2 được ánh xạ đúng một lần hoặc có cờ thiếu nguồn được Admin chấp nhận.
- Không còn lỗi cấu trúc blocking.

Sau khi duyệt, cấu trúc được khóa cho lượt tạo hiện tại. Muốn đổi cấu trúc, Admin phải chọn **Chỉnh lại khung**; app cảnh báo module nào sẽ cần tạo lại. Nội dung của module không bị ảnh hưởng vẫn được giữ.

### 6.3 Viết tài liệu học theo module

App xếp module vào hàng đợi tuần tự. Mỗi module có một trạng thái thật:

- `Chờ viết`
- `Đang chuẩn bị nguồn`
- `AI đang viết`
- `Đang kiểm tra`
- `Sẵn sàng rà soát`
- `Bản dự phòng — cần rà soát`
- `Đã duyệt`
- `Lỗi cần xử lý`

Progress tổng hiển thị `Đã có tài liệu 2/6 module`, không chỉ hiển thị thời gian chạy.

Admin có thể đóng modal. Job và checkpoint vẫn tồn tại; mở lại sẽ tiếp tục từ module chưa hoàn tất và không chạy lại module đã lưu.

Khi modal/tab đóng, app không khởi chạy module kế tiếp trong nền. Attempt đã dispatch có thể tiếp tục ở provider; khi Admin mở lại, app nhận lại đúng attemptRef và đọc trạng thái terminal/running trước khi làm gì khác. Chỉ thao tác **Hủy job** mới yêu cầu cancel provider. Sau khi reconnect và xử lý kết quả của attempt đang dở, hàng đợi mới tiếp tục module tiếp theo. Thiết kế này không yêu cầu một worker server-side chạy liên tục khi không có client.

### 6.4 Rà soát tài liệu

Admin có thể mở module ngay khi module đó sẵn sàng, không cần chờ toàn bộ template.

Các hành động:

- **Duyệt module**
- **Chỉnh sửa**
- **Tạo lại module này**
- **Dùng bản dự phòng**
- **Thử AI lại sau**

Tạo lại chỉ tác động module được chọn. Module đã duyệt không tự thay đổi.

Chỉ khi tất cả module ở trạng thái `Đã duyệt`, nút **Tiếp tục tạo câu hỏi** mới bật.

### 6.5 Tạo câu hỏi

Câu hỏi cũng được tạo tuần tự theo module, nhưng chỉ dựa trên lesson version đã duyệt. Nếu Admin sửa lesson sau khi câu hỏi đã tạo, module được đánh dấu `Câu hỏi cần cập nhật`; Admin phải tạo lại hoặc chỉnh sửa câu hỏi trước publish.

Lỗi tạo câu hỏi không làm mất tài liệu học. Admin có thể thử lại riêng module hoặc tự soạn câu hỏi.

### 6.6 Luồng Cả hai

Thứ tự cố định:

```text
Duyệt khung Template 1
  → Viết và rà soát Template 1
  → Tạo/rà soát câu hỏi Template 1
  → Next
Duyệt khung Template 2
  → Viết và rà soát Template 2
  → Tạo/rà soát câu hỏi Template 2
  → Xuất bản cả hai
  → Tự đóng modal khi toàn bộ file và publish thành công
```

Template 2 không chạy AI trong lúc Template 1 còn request đang hoạt động.

## 7. Dựng khung xác định trước

App dựng khung từ kết quả phân tích nguồn và quy tắc loại template:

- Chọn frame hợp lệ theo đúng thứ tự quy định.
- Tạo ID ổn định khi module được thêm (namespace theo template kind + frame + unique suffix server-owned), không lấy ID từ AI và không phụ thuộc thứ tự hiển thị.
- Tạo mục tiêu sơ bộ từ feature/section liên quan.
- Gắn section nguồn vào module theo feature, tiêu đề và nhiệm vụ.
- Với Template 2, mỗi nhiệm vụ có đúng một record coverage gồm `task`, `featureIds`, `relevance`, `relevanceRationale`, `moduleLocalId`, `flagIndex`.
- Trường hợp không có bằng chứng tạo `missing` flag và coverage trỏ tới flag thay vì đoán module.

AI có thể đề xuất tên/mô tả dễ đọc, nhưng app chỉ nhận text vào các slot đã có; AI không được thay đổi số module hoặc quan hệ.

`moduleLocalId` được cấp một lần khi module được tạo và bất biến trong suốt vòng đời draft. Thứ tự hiển thị là field riêng có thể thay đổi. Reorder không đổi ID, không tách lesson/question/attempt/artifact khỏi module. Module mới nhận ID mới; module bị xóa được tombstone để audit và không tái sử dụng ID.

## 8. Hợp đồng AI theo module

Mỗi call nhận:

- Module skeleton server-owned.
- Danh sách feature/section đã giới hạn cho module.
- Trích dẫn nguồn và metadata cần thiết.
- Danh sách nhiệm vụ chính nếu là Template 2.
- Một JSON schema nhỏ chỉ gồm nội dung module.

Output bài học chỉ gồm:

- `title`/`description` nếu app cho phép đề xuất.
- `objectives` theo số lượng giới hạn.
- `blocks` với `kind`, `body`, `steps` và `sourceRefs`.
- `flags` mới phát hiện trong quá trình viết module.

Không có root template, modules array toàn cục, `taskCoverage`, câu hỏi hoặc ID ngoài module hiện tại.

App áp lại ID server-owned sau parse và từ chối field lạ. Schema error không được retry bằng chính prompt cũ; app chuyển sang một repair prompt tối giản đúng một lần hoặc fallback.

## 9. Fallback C

### Điều kiện kích hoạt

Fallback được đề xuất khi xảy ra một trong các điều kiện:

- Provider fail hoặc timeout sau một retry tạm thời.
- Project busy vượt thời gian chờ cấu hình.
- Output vẫn sai schema sau một repair.
- Admin chọn **Dùng bản dự phòng** ngay từ đầu.

### Cách tạo

App tạo nội dung mà không gọi AI:

1. Dùng title, description và objectives từ khung đã duyệt.
2. Chọn các section đã gắn với module.
3. Chuyển heading thành block `concept`/`steps` theo quy tắc parser.
4. Giữ nguyên văn các bước, bullet và đoạn trích; không diễn giải thêm.
5. Tạo block `summary` chỉ bằng danh sách nội dung đã xuất hiện, không bổ sung kết luận mới.
6. Gắn sourceRefs cho mọi block.

Module được gắn nhãn **Bản dự phòng từ tài liệu nguồn — cần Admin duyệt** và chưa được dùng để tạo câu hỏi.

Khi đạt điều kiện fallback, app tự tạo bản fallback và tiếp tục xử lý module kế tiếp; không dừng toàn bộ hàng đợi để chờ Admin. Admin vẫn phải mở và duyệt/chỉnh sửa từng fallback trước khi được tạo câu hỏi hoặc publish. Nếu Admin chọn **Thử AI lại sau**, kết quả AI mới tạo một lesson version mới và không ghi đè bản fallback/phiên bản đã duyệt cho đến khi Admin duyệt lại.

### Quyền của Admin

Admin có thể dùng nguyên bản, chỉnh sửa, hoặc thử AI lại sau. Sau khi Admin bấm duyệt, module fallback trở thành lesson version chính thức và có thể dùng để tạo câu hỏi.

## 10. Retry, project busy và timeout

- Mỗi module có tối đa một retry tự động cho lỗi mạng/provider tạm thời.
- Schema invalid có tối đa một repair; không lặp lại cùng request.
- `PROJECT_BUSY` không tạo attempt mới liên tục. Module chuyển sang `Đang chờ PrivOS`, app poll trạng thái/quyền chạy với backoff và hiển thị thời điểm kiểm tra tiếp theo.
- Sau thời gian chờ cấu hình, app đưa ra fallback và nút thử lại thủ công; không tự retry thêm.
- Timeout phải kiểm tra trạng thái terminal lần cuối và attempt nền trước khi cancel.
- Mọi attemptRef/provider/error code/phase/timestamp vẫn được lưu trong log kỹ thuật.
- Chỉ một attempt của app trong room/project được phép ở trạng thái live.

Quy tắc tranh chấp:

- Tab/Admin khác mở cùng job phải attach vào cùng job và cùng attemptRef, không tạo job/attempt mới.
- Hai template/module của chính app xếp hàng tuần tự theo room/project.
- Request PrivOS bên ngoài app không thể attach; app chuyển module sang `Đang chờ PrivOS`, dùng backoff có giới hạn, rồi đề xuất fallback nếu khóa không được giải phóng.
- UI phải cho biết job nào của app đang giữ hàng đợi; không được khẳng định danh tính request bên ngoài khi PrivOS không cung cấp bằng chứng.

## 11. State và dữ liệu

Job template giữ cấu trúc cấp template và danh sách module runs độc lập. Mô hình khái niệm:

```ts
interface ModuleDraftRun {
  moduleLocalId: string;
  lessonState:
    | 'queued' | 'drafting' | 'validating' | 'review_ready'
    | 'fallback_review' | 'approved' | 'failed';
  lessonVersion: number;
  approvedLessonVersion?: number;
  questionState:
    | 'blocked' | 'queued' | 'drafting' | 'review_ready'
    | 'approved' | 'stale' | 'failed';
  sourceSectionIds: readonly string[];
  providerAttempt?: ProviderAttemptSummary;
  fallbackReason?: string;
}
```

Yêu cầu dữ liệu:

- Checkpoint được lưu sau mỗi chuyển trạng thái quan trọng.
- Operation ID ổn định theo job + module + lesson/question version để chống dispatch trùng.
- Output cache dùng hash của source sections + skeleton + danh sách nhiệm vụ + prompt version.
- Sửa nguồn hoặc skeleton làm stale đúng module bị ảnh hưởng, không reset toàn bộ job.
- Lesson và question version được lưu để phát hiện câu hỏi cũ sau khi lesson đổi.
- Job cũ theo pipeline toàn-template vẫn đọc được ở chế độ legacy; job mới dùng module lifecycle. Không tự migrate job đang chạy dở.

Ma trận invalidation/approval:

| Thay đổi | Lesson | Questions | Phiên bản cũ |
|---|---|---|---|
| Reorder module | Giữ nguyên approval | Giữ nguyên approval | Giữ nguyên |
| Đổi tên/mục tiêu/frame/source mapping của một module sau duyệt khung | Tăng skeleton version, lesson của module đó thành stale/chưa duyệt | Thành stale | Giữ snapshot để audit/rollback |
| Thêm module | Tạo run mới chưa có lesson | Block tới khi lesson mới được duyệt | Module khác giữ nguyên |
| Xóa module | Tombstone, không publish | Tombstone | Giữ snapshot audit |
| Sửa hoặc regenerate lesson đã duyệt | Tăng lesson version và bỏ approval lesson mới | Thành stale | Bản approved trước không bị ghi đè nhưng không còn là bản publish hiện hành |
| Sửa bộ câu hỏi | Lesson giữ nguyên | Tăng question version và bỏ approval câu hỏi mới | Giữ snapshot audit |
| Sửa/xóa tài liệu nguồn | Chỉ module tham chiếu section/hash bị đổi thành stale | Thành stale theo lesson | Giữ snapshot audit; không publish bản stale |

Publish luôn lấy phiên bản lesson/question mới nhất đã được Admin duyệt và khớp version; không có cơ chế “approval ngầm” sau chỉnh sửa.

## 12. Progress và thông báo

Màn tiến trình hiển thị hai cấp:

1. Tổng quan: Duyệt khung → Viết tài liệu → Rà soát → Tạo câu hỏi → Kiểm chứng → Xuất bản.
2. Danh sách module: trạng thái thật của từng module và provider nếu đang chạy.

Các thông báo quan trọng:

- `AI đang viết Module 2/6`
- `PrivOS đang xử lý yêu cầu khác; app sẽ kiểm tra lại sau …`
- `Module 3 đang dùng bản dự phòng từ nguồn và cần Admin duyệt`
- `5/6 module đã được duyệt; còn 1 module cần xử lý`

Không dùng spinner đơn lẻ trong thời gian dài. Thời gian elapsed chỉ là thông tin phụ.

## 13. Roomfiles và xuất bản

Không thay đổi cấu trúc folder đã thống nhất:

```text
Onboarding-app/
├── Uploaded documents/
└── Created templates/
    └── <template-name>/
        ├── 01-<module-slug>.pdf
        ├── 02-<module-slug>.pdf
        └── <template-slug>-<id>-v<version>.json
```

PDF/JSON chỉ được tạo từ nội dung đã duyệt. Module fallback sau khi Admin duyệt được xuất bản bình thường nhưng metadata nội bộ ghi nguồn gốc `fallback` để audit. Nhân viên không cần thấy nhãn kỹ thuật này trừ khi sản phẩm quyết định hiển thị provenance.

Xuất bản Cả hai giữ semantics resumable, không phải transaction tuyệt đối: artifact/template đã ghi thành công không bị rollback khi bước sau lỗi. Mọi upload/publish dùng operation ID và tên artifact idempotent; modal giữ mở, hiển thị phần đã thành công và retry đúng phần còn thiếu. Modal chỉ tự đóng khi cả hai template cùng toàn bộ artifact bắt buộc đã hoàn tất.

## 14. An toàn và quyền

- Mọi dữ liệu và file vẫn room-bound.
- AI chỉ nhận section của module hiện tại, giảm rò rỉ context và prompt injection surface.
- Nội dung nguồn luôn được coi là untrusted data.
- Fallback không thực thi chỉ dẫn nằm trong tài liệu.
- Admin là người duy nhất được duyệt khung, duyệt module và publish.
- App không tự sửa quyền, collocated mode, provider config hoặc project lock của PrivOS.
- Log không chứa token, credential hoặc toàn bộ nội dung tài liệu.

## 15. Kiểm thử

Tối thiểu cần các nhóm test sau:

- Dựng khung Template 1/2 deterministic và ID ổn định.
- Template 2 bao phủ đúng mỗi nhiệm vụ hoặc tạo missing flag.
- Nút bắt đầu viết bị chặn trước khi Admin duyệt khung.
- Điều phối tuần tự, không có hai attempt live trong cùng room/project.
- Module hoàn tất được giữ khi module khác lỗi.
- Reload/resume không dispatch trùng.
- Cache invalidation chỉ ảnh hưởng module có source/skeleton đổi.
- Schema invalid repair đúng một lần rồi fallback.
- Provider fail, timeout và project busy không tạo retry storm.
- Fallback chỉ dùng nội dung nguồn, có sourceRefs và nhãn review.
- Câu hỏi bị chặn trước khi lesson được duyệt.
- Sửa lesson đã duyệt làm question state thành stale.
- Luồng Cả hai chạy Template 1 rồi Template 2 và publish chung.
- PDF/JSON lưu đúng folder và modal chỉ tự đóng sau thành công đầy đủ.
- Khả năng đọc job legacy không regression.

Publish gate cho câu hỏi: mọi module phải có một bộ 3–5 câu hỏi đã được Admin duyệt và khớp approved lesson version. Admin có thể tự soạn/chỉnh câu hỏi nhưng không thể publish module với ít hơn 3, nhiều hơn 5 hoặc không có câu hỏi; không có override bỏ qua gate này.

## 16. Tiêu chí hoàn tất

- Admin phải duyệt khung trước khi AI viết.
- Mỗi AI call chỉ tạo nội dung cho một module hoặc câu hỏi của một module.
- Lỗi một module không làm mất hoặc tạo lại module khác.
- Mỗi module có thể dùng fallback không-AI có dẫn chứng nguồn.
- Không có retry vô hạn hoặc retry storm khi project busy.
- Có thể đóng/reload và tiếp tục đúng trạng thái.
- Toàn bộ lesson phải được Admin duyệt trước khi tạo câu hỏi.
- Câu hỏi phải tương ứng lesson version đã duyệt.
- Template 1/2/Cả hai vẫn tuân thủ quy trình rà soát và xuất bản hiện có.
- Tất cả artifact được lưu Roomfiles và đọc được trong app như yêu cầu trước đó.

## 17. Quyết định của sản phẩm đã chốt

- Chọn kiến trúc A với fallback C.
- Admin bắt buộc bấm **Duyệt khung** trước khi AI viết.
- AI viết theo module; app sở hữu cấu trúc và quan hệ.
- Fallback không-AI dựa hoàn toàn trên nguồn và phải được Admin duyệt.
- Câu hỏi chỉ được tạo sau khi tài liệu học đã duyệt.
- Không chạy hai template hoặc hai module AI song song trong cùng room/project.
- Template 2 chỉ yêu cầu 2–8 nhiệm vụ chính; bỏ Phòng ban và Chức danh khỏi UI, validation và prompt mới.

## 18. Quy tắc module thiếu nguồn đã chốt

Nếu một module được phép tồn tại trong khung nhờ blocking `missing` flag nhưng hoàn toàn không có section nguồn dùng được, fallback C không được phép bịa nội dung. App tạo placeholder yêu cầu Admin bổ sung nguồn hoặc tự soạn nội dung và chặn publish cho tới khi module có nội dung được duyệt. Không được tự bỏ module nếu việc bỏ làm mất frame/nhiệm vụ bắt buộc.

## 19. Phần để builder tự quyết định

- Tên cụ thể của type/table nội bộ miễn giữ đúng lifecycle và khả năng resume.
- Cách chia component UI miễn thể hiện đủ hai cấp progress và hành động theo module.
- Chiến lược backoff cụ thể trong giới hạn không retry storm và có thời điểm kiểm tra hiển thị cho Admin.
- Thuật toán scoring section-to-module cụ thể, miễn deterministic, test được và không tự tạo kiến thức mới.

