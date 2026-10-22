# Privacy Notice

Last updated: 2026-10-20

PrivOS Onboarding xử lý dữ liệu onboarding trong workspace PrivOS mà ứng dụng được cài đặt. Ứng dụng không có quảng cáo, behavioral analytics hoặc SDK theo dõi bên thứ ba.

## Dữ liệu được xử lý

Tùy theo vai trò và thao tác, ứng dụng xử lý:

- danh tính, username và role đã được PrivOS xác minh;
- danh sách thành viên của room để Admin gán onboarding;
- template, phân loại nhân sự, assignment, hạn và tiến độ đọc;
- tài liệu hoặc link do Admin đưa vào template;
- câu trả lời trắc nghiệm/tự luận, điểm trắc nghiệm;
- nhận xét tự luận, đánh giá chung và kết luận;
- audit metadata và trạng thái gửi thông báo.

## Lưu trữ và retention

Nội dung nghiệp vụ được lưu trong App Database và File service của room, chịu chính sách retention, backup và quyền truy cập của workspace PrivOS. Process ứng dụng là stateless và không có persistent volume riêng. Trình duyệt có thể lưu theme và recovery draft theo app để khôi phục khi mất kết nối.

Dữ liệu được giữ cho đến khi installation hoặc các record/file tương ứng bị xóa theo chính sách của workspace. Ứng dụng không bán dữ liệu và không gửi nội dung onboarding đến bên thứ ba độc lập.

## Kiểm soát truy cập

Backend dùng actor và room đã được PrivOS xác minh. Admin chỉ có quyền trong room phù hợp. Learner chỉ đọc assignment, attempt, feedback và evaluation của chính mình. Answer key và trường vận hành nội bộ không được đưa vào Learner DTO.

Workspace admin kiểm soát cài đặt, scope và gỡ ứng dụng. Yêu cầu truy cập, sửa, export hoặc xóa dữ liệu cần thực hiện qua quản trị workspace PrivOS. Câu hỏi bảo mật hoặc riêng tư gửi tới `dev@privos.ai`.
