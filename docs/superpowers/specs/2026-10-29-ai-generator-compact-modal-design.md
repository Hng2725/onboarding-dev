# Thiết kế modal AI Generator compact cân bằng

Ngày: 2026-10-29  
Trạng thái: Chờ duyệt  
Phạm vi: Chỉ giao diện modal **Tạo template từ tài liệu**

## Mục đích

Tăng diện tích hiển thị hữu dụng của AI Template Generator trên desktop để Admin nhìn được nhiều module, trường nhập, hành động và tiến trình hơn cùng lúc. Modal phải rộng hơn, còn chữ, khoảng cách và control gọn hơn nhưng vẫn dễ đọc và thao tác.

## Mục tiêu

- Modal dùng gần toàn bộ viewport desktop, chừa khoảng thở nhỏ quanh mép.
- Giảm chiều cao header, thanh bước, footer, button, input và khoảng cách thừa.
- Giảm cỡ chữ trong modal theo mức vừa phải, không áp dụng cho toàn app.
- Thu gọn sidebar module và tăng chiều cao vùng đọc/chỉnh sửa lesson, question và outline.
- Giữ đầy đủ thông tin, cho phép button wrap và không tạo horizontal overflow.
- Giữ responsive mobile hiện tại và các trạng thái focus/keyboard/accessibility.

## Phi mục tiêu

- Không đổi component hierarchy, nội dung, state machine, AI provider, Roomfiles hay publication flow.
- Không dùng CSS `transform: scale()` hoặc browser zoom vì làm chữ mờ và sai kích thước tương tác.
- Không chuyển sang giao diện siêu dày 12px/30px-control trên toàn modal.

## Các hướng đã cân nhắc

### A — Compact cân bằng — đã chọn

Modal gần toàn viewport, font nội dung khoảng 13px, control khoảng 34–36px, padding/gap giảm 20–35%, sidebar khoảng 190–210px và vùng review cao hơn. Hướng này tăng lượng thông tin nhìn thấy mà vẫn giữ khả năng đọc và thao tác.

### B — Extra dense — không chọn

Font khoảng 12px, control khoảng 30px và khoảng cách tối thiểu. Hiển thị nhiều hơn nhưng dễ mỏi mắt, giảm touch target và khó dùng ở viewport thấp.

## Thiết kế chi tiết

- Desktop: backdrop padding khoảng 8px; panel rộng `calc(100vw - 16px)`, có giới hạn hợp lý cho màn hình rất rộng; cao `calc(100dvh - 16px)`.
- Header: padding khoảng 12–16px; tiêu đề khoảng 19px; mô tả 12–13px; nút đóng gọn hơn nhưng giữ vùng bấm tối thiểu.
- Thanh bước: padding dọc khoảng 7–8px; icon khoảng 22–24px; label khoảng 12–13px.
- Body/footer: padding khoảng 10–14px; footer thấp hơn và vẫn sticky theo grid hiện tại.
- Toàn bộ typography/density được scope dưới `.ai-generator-panel`; không ảnh hưởng màn hình Onboarding khác.
- Module workspace: sidebar khoảng 200px, gap khoảng 12px; module card, editor panel, toolbar và disclosure card giảm padding/gap.
- Lesson/question/outline scroll region tăng từ 40–48vh lên khoảng 50–56dvh, nhưng vẫn có giới hạn và giữ action toolbar ngoài vùng scroll.
- Button/input/select/textarea trong modal dùng font 13px và padding gọn; button vẫn wrap, không cắt label.
- Breakpoint nhỏ tiếp tục dùng modal full-screen; không giảm text dưới mức dễ đọc và không phá bố cục một cột.

## Tiêu chí nghiệm thu

- Ở viewport desktop tương đương ảnh báo lỗi, modal gần phủ viewport và không bị cắt bởi iframe.
- Nhìn thấy nhiều hơn danh sách module, nội dung lesson và action bar mà cần ít cuộn hơn.
- Không có horizontal scrollbar trong modal hoặc module workspace.
- Các label/nút không bị cắt chữ; focus ring và keyboard navigation còn hoạt động.
- Component/CSS regression tests, strict typecheck và production build đều pass.
- Docker được rebuild và Chrome live check lại trên URL PrivOS hiện tại.

