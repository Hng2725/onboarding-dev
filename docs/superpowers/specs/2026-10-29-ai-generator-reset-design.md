# Thiết kế đặt lại modal tạo template AI

## Mục đích

Cho phép Admin xóa an toàn toàn bộ phiên tạo template đang dở và bắt đầu lại từ bước 1 **Tài liệu nguồn**. Sau khi xuất bản thành công và modal tự đóng, phiên cũng được dọn tự động. Trong cả hai trường hợp, các tài liệu trong **Nguồn đã thêm** phải được giữ nguyên.

## Hành vi giao diện

- Chỉ modal **Tạo template từ tài liệu** có nút cảnh báo **Xóa dữ liệu**; không hiển thị khi mở một template có sẵn để rà soát.
- Nút nằm ở footer, tách khỏi các nút điều hướng chính và bị khóa trong lúc một thao tác reset/xuất bản khác đang chạy.
- Bấm nút mở `ConfirmDialog` nội tuyến, không dùng `window.confirm` vì iframe PrivOS không cấp quyền modal trình duyệt.
- Nội dung xác nhận nói rõ tiến trình, lộ trình, bài học, câu hỏi và bản nháp chưa xuất bản sẽ bị xóa; **Nguồn đã thêm** không bị xóa.
- Khi reset thành công, modal vẫn mở tại bước 1, tải lại danh sách nguồn và chọn lại các nguồn hiện có.
- Sau khi xuất bản thành công, chạy cùng quy trình dọn phiên rồi mới gọi `onComplete` và đóng modal. Lần mở tiếp theo bắt đầu ở bước 1 với nguồn cũ còn nguyên.

## Dữ liệu được xóa

- Hủy các job inventory/template của Admin hiện tại còn `running` hoặc `failed`, đồng thời yêu cầu dừng attempt AI nền và lưu kết quả cleanup như luồng **Hủy job** hiện có.
- Xóa các template `draft` do các run hiện tại tạo ra bằng API xóa draft; không xóa template đã xuất bản.
- Xóa checkpoint xuất bản, ID resume trong `sessionStorage`, lựa chọn loại template, tiêu đề, nhiệm vụ, tiến trình module, review, cờ, trạng thái lỗi và state điều hướng của modal.
- Không gọi API xóa source, không xóa file trong `Onboarding-app/Uploaded documents`, và không xóa mục nào khỏi **Nguồn đã thêm**.

## An toàn và lỗi

- Reset là thao tác tuần tự, có trạng thái **Đang xóa…** và không cho bấm lặp.
- Nếu không xác nhận được attempt AI đã dừng hoặc xóa draft thất bại, giữ modal ở trạng thái hiện tại và hiển thị lỗi; không báo reset thành công một phần.
- Các thao tác xóa/hủy phải idempotent để có thể thử lại an toàn.
- Dọn tự động sau xuất bản không xóa template vừa xuất bản; chỉ xóa state/resume của phiên và các draft chưa xuất bản còn sót.

## Các phương án đã cân nhắc

1. **Reset phối hợp server và giao diện — chọn dùng.** Ngăn job/bản nháp cũ tự phục hồi sau reload và vẫn giữ nguồn.
2. **Chỉ reset React/sessionStorage — không dùng.** Job server sẽ được `list_jobs` tìm lại và khôi phục modal.
3. **Chỉ đóng rồi mở lại modal — không dùng.** Không dọn dữ liệu server và không đáp ứng hành vi người dùng mong đợi.

## Kiểm thử

- Nút và hộp xác nhận hiển thị đúng, hủy xác nhận không thay đổi dữ liệu.
- Xác nhận reset hủy job, xóa draft, xóa resume keys và trả về bước 1.
- Nguồn đã thêm vẫn tồn tại và được chọn lại sau reset.
- Reset thất bại không làm giao diện giả vờ thành công.
- Xuất bản thành công dọn phiên trước khi đóng; lần mở sau không phục hồi job cũ và vẫn thấy nguồn.

