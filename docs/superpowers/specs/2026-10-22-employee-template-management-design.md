# Quản lý nhân sự và nhiều onboarding template

## Mục tiêu

Đổi tab **Nhân sự** từ danh sách các lượt onboarding sang danh sách hồ sơ nhân sự. Mỗi thành viên trong room chỉ có một hồ sơ nhân sự, nhưng một hồ sơ có thể được gán nhiều template onboarding độc lập.

Thay đổi phải giữ nguyên toàn bộ assignment, tiến độ học, bài làm và đánh giá đang tồn tại. Dashboard quản trị và giao diện người học tiếp tục hoạt động theo từng assignment.

## Phạm vi

- Thêm hồ sơ nhân sự từ danh sách thành viên hiện tại của room.
- Chống thêm trùng cùng một `memberId` trong một room.
- Lưu một phân loại cố định cho hồ sơ: `normal` hoặc `advanced`.
- Hiển thị mỗi nhân sự đúng một dòng trong tab Nhân sự.
- Hiển thị mọi assignment của nhân sự trong modal chi tiết.
- Chỉ cho phép gán onboarding từ modal chi tiết nhân sự.
- Cho phép nhiều template cho một nhân sự nhưng không cho phép trùng cùng `templateId + templateVersion`.
- Tự động tạo hồ sơ nhân sự cho dữ liệu assignment cũ.

Không thuộc phạm vi:

- Xóa nhân sự.
- Đổi phân loại nhân sự sau khi đã thêm.
- Thay đổi cách dashboard tổng hợp assignment.
- Thay đổi trải nghiệm học của learner.

## Mô hình dữ liệu

Thêm collection room-scoped `onboarding_employees` với các trường:

- `memberId`: định danh thành viên PrivOS trong room.
- `employeeType`: `normal` hoặc `advanced`.
- `addedBy`: admin thêm hồ sơ; với hồ sơ tự chuyển đổi dùng người đã tạo assignment mới nhất.
- `addedAt`, `createdAt`, `updatedAt`: thời gian ISO.

Collection có unique index trên `memberId`. Vì collection đã được cô lập theo room, index này đảm bảo một thành viên chỉ có một hồ sơ trong mỗi room mà vẫn có thể là nhân sự ở room khác.

`onboarding_assignments` tiếp tục là nguồn dữ liệu cho từng chương trình học. Mỗi assignment liên kết đến hồ sơ bằng `memberId`; không thay đổi ID hay nội dung snapshot của assignment cũ.

Không sửa index của `onboarding_assignments` đang có để tránh làm quá trình đăng ký schema thất bại nếu dữ liệu cũ từng chứa bản ghi trùng. Service kiểm tra `memberId + templateId + templateVersion` trước khi tạo và trả lỗi nghiệp vụ dễ hiểu. Unique index của hồ sơ nhân sự mới vẫn là lớp bảo vệ bắt buộc cho yêu cầu không thêm trùng nhân sự.

## Chuyển đổi dữ liệu hiện có

Trước khi trả danh sách nhân sự cho admin, service thực hiện reconcile idempotent:

1. Đọc các hồ sơ `onboarding_employees` hiện có.
2. Nhóm các assignment theo `memberId`.
3. Với mỗi member chưa có hồ sơ, tạo một hồ sơ từ assignment mới nhất.
4. Nếu dữ liệu cũ có cả hai phân loại, dùng `employeeType` của assignment có `assignedAt` mới nhất.
5. Không cập nhật hoặc xóa assignment, progress, attempt, answer, feedback hay evaluation cũ.

Nếu một tiến trình khác vừa tạo cùng hồ sơ, lỗi duplicate được xem như kết quả reconcile thành công và service đọc lại dữ liệu. Nhờ vậy, quá trình có thể chạy nhiều lần an toàn.

## Dịch vụ và quy tắc nghiệp vụ

Tạo `EmployeeService` độc lập với các thao tác:

- `list(actor)`: admin-only; reconcile dữ liệu cũ rồi trả danh sách hồ sơ.
- `add(actor, input)`: admin-only; xác nhận member đang thuộc room, chuẩn hóa `memberId`, kiểm tra phân loại và tạo hồ sơ duy nhất.

Các lỗi nghiệp vụ có mã rõ ràng, tối thiểu gồm:

- `EMPLOYEE_NOT_FOUND`
- `EMPLOYEE_ALREADY_EXISTS`
- `MEMBER_NOT_FOUND`
- `EMPLOYEE_TYPE_INVALID`

Luồng `AssignmentService.assign` được bổ sung các điều kiện:

- Member phải có hồ sơ trong `onboarding_employees`.
- `employeeType` lấy từ hồ sơ, không nhận từ lựa chọn tự do của giao diện.
- Template phải đang published và cùng phân loại với hồ sơ.
- Cùng member không được có assignment trùng `templateId + templateVersion`.
- Một phiên bản mới hơn của cùng template vẫn có thể được gán.

Các assignment cũ có phân loại khác hồ sơ sau migration vẫn được giữ và hiển thị. Hạn chế phân loại chỉ áp dụng khi tạo assignment mới.

## API công cụ

Giữ tool `onboarding_admin_assignments` để giảm thay đổi tích hợp và bổ sung action:

- `list_employees`: trả hồ sơ nhân sự đã reconcile.
- `add_employee`: nhận `memberId` và `employeeType`.

Các action hiện tại tiếp tục tồn tại:

- `list_members`: danh bạ thành viên room dùng cho modal thêm nhân sự.
- `list`: danh sách assignment dùng để tổng hợp UI và dashboard.
- `assign`: gán template; UI chỉ gọi action này từ chi tiết nhân sự.

## Giao diện tab Nhân sự

### Danh sách

Mỗi hồ sơ nhân sự tạo đúng một dòng, với các cột:

- Nhân sự: tên hiển thị và username/member ID.
- Phân loại.
- Chương trình: số template đã gán.
- Tiến độ chung: trung bình tiến độ các assignment; bằng 0% nếu chưa có assignment.
- Trạng thái: ưu tiên trạng thái cần xử lý, nếu không hiển thị trạng thái tổng hợp phù hợp.
- Cập nhật: thời điểm assignment mới nhất hoặc thời điểm thêm nhân sự.

Tìm kiếm theo tên, username và member ID. Bộ lọc phân loại nằm cạnh ô tìm kiếm như tab Template. Số đếm và empty state dùng đơn vị nhân sự, không dùng lượt onboarding.

### Modal Thêm nhân sự

Nút đầu trang là **Thêm nhân sự**. Modal gồm:

- Thành viên room: chỉ hiển thị người chưa có hồ sơ nhân sự.
- Phân loại: `Thông thường` hoặc `Chuyên sâu`.
- Nút **Thêm nhân sự** có trạng thái loading và bị vô hiệu hóa khi đang lưu.

Sau khi thành công, modal đóng, danh sách refresh và hiển thị thông báo. Backend vẫn chặn duplicate để xử lý race condition.

### Modal Chi tiết nhân sự

Click, Enter hoặc Space trên một dòng mở modal. Phần đầu hiển thị hồ sơ nhân sự và nút **Gán onboarding**. Phần nội dung hiển thị danh sách mọi assignment của người đó với:

- Template và phiên bản.
- Tiến độ.
- Trạng thái.
- Ngày giao và hạn hoàn thành.

Khi chưa có assignment, modal hiển thị empty state cùng nút gán.

Nút **Gán onboarding** chuyển modal sang biểu mẫu gán trong cùng lớp modal, không xếp chồng hai dialog. Member và phân loại được khóa theo hồ sơ; chỉ các template published cùng phân loại được hiển thị. Sau khi gán thành công, modal quay lại chi tiết, refresh dữ liệu và hiển thị template mới.

Modal đóng bằng nút Đóng, click backdrop hoặc Escape. Khi quay lại danh sách, bộ lọc và từ khóa đang dùng được giữ nguyên.

## Trạng thái tổng hợp của nhân sự

Hàm tổng hợp thuần được dùng để tạo row model:

- `templateCount`: số assignment.
- `averageProgress`: trung bình làm tròn của `progressPercent`; 0 khi rỗng.
- `attentionStatus`: ưu tiên `awaiting_essay_feedback`, `awaiting_evaluation`, `failed`, overdue, active, completed, rồi `not_started`.
- `updatedAt`: `assignedAt` mới nhất, hoặc `addedAt` nếu chưa có assignment.

Trạng thái tổng hợp chỉ phục vụ danh sách nhân sự. Trạng thái thật của từng assignment không bị thay đổi.

## Xử lý lỗi

- Lỗi duplicate nhân sự và duplicate assignment hiển thị bằng tiếng Việt, không lộ thông báo MongoDB.
- Member đã rời room không thể được thêm mới; hồ sơ/assignment cũ của họ vẫn hiển thị với member ID nếu không thể enrich tên.
- Lỗi tải danh bạ không làm mất assignment đã tải; UI có trạng thái retry phù hợp.
- Notification và audit tiếp tục là best-effort như luồng assignment hiện tại; assignment tạo thành công không bị rollback nếu hai tích hợp này lỗi.

## Kiểm thử

### Backend

- Thêm thành viên room thành nhân sự và lưu phân loại.
- Từ chối member ngoài room và duplicate member.
- Reconcile assignment cũ thành hồ sơ nhân sự, chạy lặp lại không tạo trùng.
- Chọn phân loại từ assignment mới nhất khi dữ liệu cũ bị trộn.
- Gán nhiều template khác nhau cho một nhân sự.
- Từ chối assignment khi chưa có hồ sơ, sai phân loại hoặc trùng template/version.
- Cho phép phiên bản template mới hơn.

### UI

- Gộp nhiều assignment thành một dòng nhân sự.
- Tìm kiếm và lọc theo hồ sơ nhân sự.
- Modal thêm nhân sự loại bỏ member đã thêm.
- Modal chi tiết hiển thị danh sách nhiều assignment và empty state.
- Luồng gán khóa member/phân loại, lọc template phù hợp và quay về chi tiết sau thành công.
- Loading, đóng modal và thao tác bàn phím hoạt động đúng.

### Xác minh phát hành

- Chạy test mục tiêu theo chu kỳ đỏ–xanh, sau đó toàn bộ test suite.
- Chạy typecheck và production build.
- Rebuild container app dev.
- Reload URL PrivOS hiện tại trong Chrome và kiểm tra thêm nhân sự, chống trùng, gán nhiều template và modal chi tiết.
