# Publishing PrivOS Onboarding

## 1. Đồng bộ metadata

Trước mỗi release, cập nhật cùng một version trong `package.json`, `package-lock.json` và `privos-app.json`, rồi thêm mục tương ứng vào `CHANGELOG.md`. Repository, title và description phải giống giữa package và manifest.

## 2. Review permission

Đọc [`SCOPES.md`](SCOPES.md) và xác nhận từng scope vẫn có một call site thật. Thay đổi permission là thay đổi consent và cần Marketplace review lại. Không thêm scope chỉ để thử nghiệm.

Các scope App Database và File service là bắt buộc vì onboarding không thể hoạt động đúng nếu không đọc/ghi progress, template và tài liệu. `notifications:write` là optional; lỗi thông báo không rollback assignment hoặc evaluation đã lưu.

## 3. Chạy gate local

```bash
npm ci
npm run typecheck:strict-unused
npm test
npm run build
npm run preflight
npm run package
```

`npm run build` phải tạo asset có hash, không sourcemap. `npm run preflight` phải xác minh canonical manifest hash, permission declaration hash, source archive và Docker inputs.

## 4. Kiểm tra room thật

Trước khi publish, dùng tối thiểu hai tài khoản trong một room test:

1. owner/moderator tạo template, upload file và gán một member;
2. member đọc tài liệu, nộp bài trắc nghiệm và tự luận;
3. Admin nhận xét tự luận, công bố từng kết luận;
4. member chỉ xem được feedback đã publish và làm lại khi có kết luận `Làm lại`;
5. đổi request argument để xác nhận member không đọc được dữ liệu của người khác;
6. tắt permission notification để xác nhận dữ liệu vẫn lưu và UI chỉ cảnh báo.

Không dùng dữ liệu nhân sự thật trong screenshot, video hoặc room review.

## 5. Build và publish

```bash
npm run docker:build
npm run publish:marketplace
```

Giữ lại canonical manifest hash, image digest, test output và source archive checksum trong hồ sơ release. Marketplace secret, pairing URL, identity file và `.env` không được đưa vào log hay artifact.
