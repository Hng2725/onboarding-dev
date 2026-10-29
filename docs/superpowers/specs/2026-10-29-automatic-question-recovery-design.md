# Thiết kế phục hồi tự động khi AI tạo câu hỏi thất bại

Ngày: 2026-10-29  
Trạng thái: Đã duyệt  
Phạm vi: bước tạo câu hỏi theo module của AI Template Generator

## Ý định

Admin không phải tự nhập câu hỏi chỉ vì một provider trả output rỗng hoặc sai schema. App phải tự phục hồi có giới hạn, giữ đầy đủ dẫn chứng và chỉ yêu cầu Admin rà soát trước khi duyệt.

## Mục tiêu

- Với mỗi module đã duyệt bài học, app tự tạo 3–5 câu hỏi.
- Sandbox thất bại thì tự chuyển sang Native AI Chat đúng một lần khi quyền Native khả dụng.
- Nếu Native không khả dụng hoặc vẫn thất bại, app tạo đúng 3 câu hỏi nháp xác định từ các khối bài học và dẫn chứng đã duyệt.
- Bản dự phòng chỉ ở trạng thái chờ rà soát; không tự duyệt và không tự xuất bản.
- Không retry vô hạn, không làm mất bài học đã duyệt và không yêu cầu Admin nhập lại dữ liệu nguồn.
- Reload hoặc đóng/mở modal không tạo trùng attempt; lịch sử provider quyết định bước phục hồi tiếp theo.

## Phi mục tiêu

- Không bảo đảm câu hỏi dự phòng có độ khó hoặc văn phong ngang bản AI.
- Không tạo câu hỏi không dẫn chứng cho bài học thủ công không có nguồn; trường hợp đó vẫn cần Admin xử lý.
- Không thay đổi quy tắc 3–5 câu hỏi, approval/version gate hoặc batch publish.
- Không chạy hai provider song song.

## Các phương án đã cân nhắc

1. Chỉ retry Sandbox: ít thay đổi nhưng lặp lại đúng failure mode và tăng thời gian chờ; không chọn.
2. Sandbox → Native → fallback xác định: tận dụng provider thứ hai nhưng vẫn có đường lui không phụ thuộc AI; đã chọn.
3. Bỏ qua lỗi và yêu cầu Admin tự soạn: an toàn nhưng trái mục tiêu tự động hóa; chỉ giữ cho bài học thật sự không có dẫn chứng.

## Luồng đã chọn

1. App tạo câu hỏi bằng provider chính hiện tại.
2. Nếu call của câu hỏi kết thúc lỗi hoặc output không hợp lệ sau schema repair, job giữ checkpoint của module và pump xác định lịch sử provider.
3. Nếu call hiện tại là Sandbox, Native AI Chat khả dụng và chưa được thử cho version câu hỏi này, app tạo một retry riêng cho đúng module và dispatch bằng Native.
4. Nếu Native đã thất bại, hoặc Native không khả dụng, app gọi fallback câu hỏi phía server.
5. Fallback chọn nội dung từ các block không phải summary của bài học đã duyệt. Mỗi câu hỏi là một kiểm tra nhận biết một phát biểu có xuất hiện trong bài học, trỏ đúng `blockIds` và sao chép `sourceRefs` hiện có. Nếu chỉ có một block, app dùng tối đa ba phát biểu khác nhau trong block đó; nếu không đủ thì dùng ba cách hỏi xác định khác nhau quanh cùng bằng chứng.
6. Kết quả được lưu với `questionState = review_ready` và provenance `fallback`. UI hiển thị “Bản câu hỏi dự phòng — cần rà soát”. Admin có thể sửa, duyệt hoặc chủ động tạo lại bằng AI.
7. Sau khi Admin duyệt, luồng tiếp tục module kế tiếp như hiện tại.

## Trách nhiệm và ranh giới

- `ai-pump`/orchestrator phía UI chọn provider dựa trên capability hiện tại và lịch sử call đã persist; không suy đoán từ timer.
- Job service phía server sở hữu fallback xác định, validation, version check, audit và persistence.
- Fallback chỉ đọc `lessonDraft` đã được duyệt và các `sourceRefs` đã tồn tại; không đọc nguồn ngoài module và không tạo thêm kiến thức.
- `questionAttempts` và call history ngăn Sandbox/Native được thử nhiều hơn một lần cho cùng vòng phục hồi.

## Xử lý lỗi và resume

- Tab đóng sau khi dispatch: lần mở lại nhận đúng attempt/provider đã lưu.
- Native thiếu quyền hoặc dispatch không bắt đầu: chuyển thẳng sang fallback xác định.
- Bài học không có block kèm dẫn chứng: giữ trạng thái cần Admin xử lý và không giả lập chứng cứ.
- Fallback không qua validator: fail closed, ghi lỗi chi tiết; không cho duyệt hoặc publish.
- Thay đổi bài học sau đó vẫn làm stale câu hỏi theo version gate hiện có.

## Tiêu chí chấp nhận

- Tái hiện output câu hỏi rỗng từ Sandbox không còn buộc Admin nhập tay.
- Khi Native khả dụng, call kế tiếp của đúng module dùng `native_chat` đúng một lần.
- Khi cả hai provider thất bại, module có đúng 3 câu hỏi nháp hợp lệ, mỗi câu có `blockIds` và `sourceRefs` hợp lệ.
- Bản nháp fallback không thể publish trước khi Admin duyệt.
- Resume không dispatch trùng và không lặp lại provider đã thất bại cho cùng version.
- Các module “Làm quen giao diện” và “Quy trình công việc chính” tiếp tục được xử lý, sau đó toàn bộ template có thể qua materialize/publish gate hiện có.

