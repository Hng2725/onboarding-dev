# PrivOS Onboarding

**Tagline:** Biến onboarding trong room thành một lộ trình học, làm bài và đánh giá rõ ràng.

**Short description:** Gán chương trình onboarding cho thành viên room, bắt buộc đọc tài liệu trước khi làm bài, tự động chấm trắc nghiệm và công bố đánh giá của Admin.

## Long description

PrivOS Onboarding giúp room owner, moderator và workspace admin xây dựng chương trình hội nhập ngay trong PrivOS. Admin có thể dùng template PrivOS bất biến, clone để tùy biến hoặc tạo template riêng với file/link, module, trắc nghiệm và tự luận.

Chỉ thành viên được gán thủ công mới nhận chương trình. Nhân sự phải mở và hoàn thành tài liệu bắt buộc trước khi làm bài. Trắc nghiệm được chấm tự động; tự luận không có điểm và được Admin nhận xét riêng. Mọi bài, kể cả bài hoàn toàn trắc nghiệm, đều cần đánh giá chung với kết luận Đạt, Không đạt hoặc Làm lại.

Mỗi learner chỉ xem dữ liệu của chính mình. Dữ liệu, file và audit state được cô lập theo room PrivOS.

**Category:** Productivity / Human Resources

**Keywords:** onboarding, training, learning, employee, assessment, PrivOS

## Reviewer notes

- Admin access: room owner/moderator hoặc workspace admin.
- Learner access: room leader/member.
- `notifications:write` là optional và best-effort; lỗi delivery không rollback dữ liệu.
- Không có analytics, quảng cáo hoặc external processing.
- Scope/call-site map đầy đủ tại `SCOPES.md`.
