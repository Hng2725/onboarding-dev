# Đặc tả 2 template onboarding do AI tạo từ tài liệu doanh nghiệp

> Phiên bản: 1.1 · Ngày: 2026-10-23
>
> Phạm vi: chức năng **AI tạo tài liệu onboarding**. Người quản trị tải lên tài liệu
> hướng dẫn sử dụng hệ thống nội bộ. AI phân tích tài liệu rồi tạo lộ trình học tương tác
> theo 2 template dùng chung cho mọi doanh nghiệp và mọi phần mềm.

---

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Nguyên tắc bắt buộc](#2-nguyên-tắc-bắt-buộc)
3. [Luồng xử lý tổng thể](#3-luồng-xử-lý-tổng-thể)
4. [Đầu vào](#4-đầu-vào)
5. [Template 1 – Nhân sự thông thường](#5-template-1--nhân-sự-thông-thường)
6. [Template 2 – Nhân sự chuyên sâu](#6-template-2--nhân-sự-chuyên-sâu)
7. [Quy chuẩn module bài học](#7-quy-chuẩn-module-bài-học)
8. [Quy chuẩn bài kiểm tra trắc nghiệm](#8-quy-chuẩn-bài-kiểm-tra-trắc-nghiệm)
9. [Chống bịa nội dung (grounding)](#9-chống-bịa-nội-dung-grounding)
10. [Đánh dấu cần xác minh](#10-đánh-dấu-cần-xác-minh)
11. [Học theo module, chấm điểm và hiển thị đáp án](#11-học-theo-module-chấm-điểm-và-hiển-thị-đáp-án)
12. [Lưu kết quả và theo dõi tiến độ](#12-lưu-kết-quả-và-theo-dõi-tiến-độ)
13. [Mô hình dữ liệu](#13-mô-hình-dữ-liệu)
14. [Prompt AI cho từng bước](#14-prompt-ai-cho-từng-bước)
15. [Ví dụ minh họa](#15-ví-dụ-minh-họa)
16. [Tiêu chí nghiệm thu](#16-tiêu-chí-nghiệm-thu)
17. [Giả định và câu hỏi mở](#17-giả-định-và-câu-hỏi-mở)

---

## 1. Tổng quan

| Tiêu chí       | Template 1 – Thông thường               | Template 2 – Chuyên sâu                  |
|----------------|-----------------------------------------|------------------------------------------|
| Mã             | `normal`                                | `advanced`                               |
| Đối tượng      | Tất cả nhân viên                        | Nhân sự 6 phòng ban chuyên môn (mục 6.3) |
| Mục tiêu       | Hiểu tổng quan, dùng thao tác hằng ngày | Dùng thành thạo tính năng chuyên môn     |
| Cá nhân hóa    | Không                                   | Theo phòng ban + chức danh + nhiệm vụ    |
| Số module      | 5–7 (cho phép 4–8)                      | 5–8                                      |
| Nguồn nội dung | Chỉ tài liệu tải lên                    | Chỉ tài liệu tải lên                     |
| Bài kiểm tra   | 3–5 câu, 4 lựa chọn, 1 đáp án           | Như T1, ưu tiên câu tình huống           |

Hai điểm cần nhớ:

- **Khung cố định, nội dung do AI sinh.** Khung module giống nhau cho mọi doanh nghiệp.
  Nội dung bên trong do AI sinh ra từ tài liệu mà từng doanh nghiệp tải lên.
- **Template 2 nối tiếp Template 1, không thay thế.** Nhân sự chuyên sâu nên hoàn thành
  Template 1 trước (hoặc được admin miễn). Template 2 không dạy lại kiến thức nền mà
  chỉ tham chiếu sang Template 1.

---

## 2. Nguyên tắc bắt buộc

1. **Chỉ dùng nguồn được xác nhận.** Mọi tính năng, thao tác, tên menu, nút bấm, trường
   dữ liệu, quy định và con số đều phải truy được về một đoạn trích trong tài liệu tải lên.
2. **Không tự bịa.** Không suy diễn đường dẫn menu, phím tắt, tên nút, quyền hạn hay quy
   trình mà tài liệu không ghi, kể cả khi đó là cách làm phổ biến của phần mềm cùng loại.
3. **Thiếu hoặc mâu thuẫn thì gắn cờ, không tự quyết.** Thông tin thiếu, mơ hồ, mâu thuẫn
   hoặc lỗi thời được gắn cờ để admin xác minh. AI không tự chọn một phiên bản rồi trình
   bày như sự thật.
4. **Câu hỏi chỉ hỏi điều đã dạy.** Câu trắc nghiệm chỉ kiểm tra nội dung đã có trong bài
   học của chính module đó, và nội dung ấy phải có nguồn.
5. **Nội dung bị cờ chặn thì không vào bài kiểm tra.** Không đặt câu hỏi dựa trên nội dung
   có cờ `blocking` chưa được giải quyết.
6. **Admin quyết định cuối cùng.** Nội dung AI tạo luôn ở trạng thái `draft`. Chỉ admin
   publish được, và chỉ khi không còn cờ `blocking` nào mở.
7. **Tách đáp án khỏi người học.** Trước khi nộp bài, dữ liệu gửi cho người học không chứa
   `correctOptionId` và `explanation`.

---

## 3. Luồng xử lý tổng thể

```
 [1] Admin tải tài liệu lên
         │
         ▼
 [2] Hệ thống tách & chuẩn hóa tài liệu thành các section
         │
         ▼
 [3] AI trích xuất "Kho tính năng" + phát hiện chỗ thiếu / mâu thuẫn
         │
         ├──────────────────────────────┐
         ▼                              ▼
 [4a] AI tạo Template 1          [4b] AI tạo Template 2
      (1 bản / doanh nghiệp)          (1 bản / hồ sơ vai trò)
         │                              │
         └──────────────┬───────────────┘
                        ▼
 [5] Kiểm định tự động (code + AI kiểm chứng trích dẫn) → sinh thêm cờ
                        │
                        ▼
 [6] Admin rà soát: xử lý cờ, chỉnh sửa, publish phiên bản
                        │
                        ▼
 [7] Gán cho nhân sự → học module → làm quiz → xem đáp án + giải thích
     → lưu kết quả → theo dõi tiến độ
```

### Chi tiết từng bước

**Bước 1 – Tải tài liệu**
- Người làm: Admin
- Kết quả: `SourceDocument` (file gốc + checksum)

**Bước 2 – Tách và chuẩn hóa**
- Người làm: Hệ thống
- Kết quả: danh sách `SourceSection` có ID ổn định (ví dụ `doc1#s3.2`), số trang,
  văn bản thuần

**Bước 3 – Trích xuất kho tính năng**
- Người làm: AI (giai đoạn A)
- Kết quả: `FeatureInventory` gồm tính năng, bước thao tác, vai trò, phòng ban,
  thuật ngữ, kèm các `VerificationFlag` ban đầu

**Bước 4a – Tạo Template 1**
- Người làm: AI (giai đoạn B)
- Kết quả: `GeneratedTemplate` với `employeeType = normal`

**Bước 4b – Tạo Template 2**
- Người làm: AI (giai đoạn C)
- Kết quả: `GeneratedTemplate` với `employeeType = advanced`, mỗi `RoleProfile` một bản

**Bước 5 – Kiểm định**
- Người làm: Code + AI (giai đoạn D)
- Kết quả: gỡ hoặc gắn cờ nội dung không có nguồn, kiểm tra cấu trúc quiz

**Bước 6 – Rà soát và publish**
- Người làm: Admin
- Kết quả: phiên bản template `published`, không thể sửa (bất biến)

**Bước 7 – Học và đánh giá**
- Người làm: Người học
- Kết quả: `ModuleProgress`, `QuizAttempt`, tiến độ tổng

> **Vì sao cần "Kho tính năng"?** Đây là nguồn sự thật trung gian. Bước 4 chỉ được dùng
> các mục trong kho, không đọc tự do toàn văn bản. Nhờ vậy hai template luôn nhất quán
> với nhau và việc kiểm định dễ hơn.

---

## 4. Đầu vào

### 4.1. Tài liệu doanh nghiệp

- **Định dạng hỗ trợ:** PDF (có lớp văn bản), DOCX, Markdown, TXT, HTML.
  PDF scan phải qua OCR và tự động bị gắn cờ `low_quality_source`.
- **Số lượng:** nhiều file cho cùng một hệ thống (hướng dẫn chung, hướng dẫn theo phân hệ,
  quy định nội bộ…).
- **Thông tin nhập kèm:** tên hệ thống, phiên bản phần mềm (nếu có), ngày hiệu lực của
  tài liệu, phòng ban áp dụng (tùy chọn).
- **Ảnh chụp màn hình:** giữ lại làm minh họa. AI **không** suy diễn thao tác từ ảnh khi
  văn bản không mô tả. Ảnh chỉ được gắn vào bước đã có mô tả bằng chữ.
- **Tài liệu trùng hoặc khác phiên bản:** hai tài liệu mô tả cùng một tính năng theo hai
  cách khác nhau sẽ sinh cờ `conflict`.

### 4.2. Hồ sơ vai trò (chỉ dùng cho Template 2)

```ts
interface RoleProfile {
  department: 'it' | 'marketing' | 'hr' | 'sales' | 'finance' | 'operations' | 'other';
  departmentLabel?: string;      // bắt buộc khi department = 'other'
  jobTitle: string;              // ví dụ "Chuyên viên tuyển dụng"
  responsibilities: string[];    // 2–8 nhiệm vụ chuyên môn, mỗi dòng một nhiệm vụ
  systemRole?: string;           // vai trò/quyền trong phần mềm, nếu doanh nghiệp biết
  seniority?: 'junior' | 'mid' | 'senior' | 'manager';
}
```

- Admin nhập hồ sơ vai trò khi gán Template 2. Hệ thống gợi ý nhiệm vụ mẫu theo phòng ban
  (mục 6.3) để admin chọn hoặc sửa.
- Các hồ sơ trùng nhau (cùng phòng ban, chức danh đã chuẩn hóa và tập nhiệm vụ) **dùng lại**
  template đã tạo, không gọi AI lần nữa. Cách này tiết kiệm chi phí và giữ nội dung thống
  nhất giữa các nhân viên cùng vai trò.

---

## 5. Template 1 – Nhân sự thông thường

### 5.1. Mục tiêu

Sau khi hoàn thành, người học:

- Hiểu hệ thống dùng để làm gì trong doanh nghiệp và gồm những phân hệ nào.
- Đăng nhập được, nắm được giao diện chính và biết cách điều hướng.
- Tự làm được các thao tác hằng ngày phổ biến cho mọi nhân viên.
- Biết các quy định sử dụng và bảo mật, cũng như cách tìm hỗ trợ khi gặp sự cố.

### 5.2. Khung module

Khung có 7 vị trí module theo thứ tự cố định. Mỗi vị trí có **điều kiện tồn tại**: nếu tài
liệu không đủ nội dung, AI bỏ hoặc gộp vị trí đó và gắn cờ `missing` để admin biết. AI
không viết nội dung chung chung để lấp chỗ trống.

**Tóm tắt:**

| #   | Module                                  | Bắt buộc?              |
|-----|-----------------------------------------|------------------------|
| 1   | Tổng quan hệ thống                      | Có                     |
| 2   | Truy cập và tài khoản                   | Có, nếu tài liệu mô tả |
| 3   | Giao diện và điều hướng                 | Có, nếu tài liệu mô tả |
| 4   | Thao tác cốt lõi hằng ngày              | Có                     |
| 5   | Tìm kiếm, dữ liệu và báo cáo cơ bản     | Không                  |
| 6   | Phân quyền, bảo mật và quy định sử dụng | Không                  |
| 7   | Hỗ trợ và xử lý sự cố                   | Không                  |

**Chi tiết từng module:**

#### Module 1 – Tổng quan hệ thống
- **Mục tiêu học:** biết hệ thống dùng để làm gì, phục vụ ai, gồm những phân hệ chính nào.
- **AI tìm trong tài liệu:** phần giới thiệu, mục đích, sơ đồ phân hệ, thuật ngữ.
- **Điều kiện tồn tại:** bắt buộc. Nếu thiếu, gắn cờ `missing` mức `blocking`.

#### Module 2 – Truy cập và tài khoản
- **Mục tiêu học:** đăng nhập, đăng xuất, đổi mật khẩu, cập nhật hồ sơ cá nhân.
- **AI tìm trong tài liệu:** hướng dẫn đăng nhập, SSO, mật khẩu, hồ sơ người dùng.
- **Điều kiện tồn tại:** tài liệu mô tả ít nhất 1 thao tác truy cập.

#### Module 3 – Giao diện và điều hướng
- **Mục tiêu học:** nhận biết các khu vực màn hình chính, menu, cách chuyển giữa phân hệ.
- **AI tìm trong tài liệu:** mô tả màn hình chính, thanh menu, trang chủ, thông báo.
- **Điều kiện tồn tại:** tài liệu có mô tả màn hình hoặc menu.

#### Module 4 – Thao tác cốt lõi hằng ngày
- **Mục tiêu học:** làm được 3–6 tác vụ mà mọi nhân viên đều dùng (ví dụ tạo, xem, sửa,
  gửi, duyệt một bản ghi).
- **AI tìm trong tài liệu:** các quy trình không gắn riêng với một phòng ban.
- **Điều kiện tồn tại:** bắt buộc. Có hơn 6 tác vụ thì tách thành 4a, 4b.

#### Module 5 – Tìm kiếm, dữ liệu và báo cáo cơ bản
- **Mục tiêu học:** tìm, lọc, xuất dữ liệu, xem báo cáo cá nhân.
- **AI tìm trong tài liệu:** tìm kiếm, bộ lọc, xuất file, dashboard cá nhân.
- **Điều kiện tồn tại:** không bắt buộc.

#### Module 6 – Phân quyền, bảo mật và quy định sử dụng
- **Mục tiêu học:** biết mình được và không được làm gì, cách bảo vệ dữ liệu.
- **AI tìm trong tài liệu:** chính sách, quyền, quy định nội bộ, lưu ý bảo mật.
- **Điều kiện tồn tại:** không bắt buộc. Tài liệu hoàn toàn không nói về bảo mật thì gắn
  cờ `missing` mức `warning`.

#### Module 7 – Hỗ trợ và xử lý sự cố
- **Mục tiêu học:** biết cách xử lý lỗi thường gặp và liên hệ ai khi cần.
- **AI tìm trong tài liệu:** FAQ, lỗi thường gặp, đầu mối hỗ trợ, kênh báo lỗi.
- **Điều kiện tồn tại:** không bắt buộc. Thiếu đầu mối hỗ trợ thì gắn cờ `missing` mức
  `warning`.

**Quy tắc chọn nội dung cho Template 1:**

- Chỉ đưa vào tính năng mà **mọi nhân viên** đều dùng. Tính năng chỉ dành cho một phòng ban
  hoặc vai trò quản trị thì để cho Template 2.
- Tài liệu không nói rõ đối tượng: nếu tính năng thuộc nhóm thao tác chung (tài khoản, điều
  hướng, tìm kiếm, thông báo) thì xếp vào Template 1. Các trường hợp khác gắn
  `audience: "unclear"` để admin quyết định.
- Mỗi module dạy tối đa 6 tính năng/thao tác. Nếu nhiều hơn, tách thành module con.
- Tổng số module sau khi sinh: 4–8. Ít hơn 4 nghĩa là tài liệu quá mỏng, khi đó gắn cờ
  `missing` (`blocking`): *"Tài liệu chưa đủ để tạo lộ trình cơ bản"*.

### 5.3. Kết quả mong đợi của mỗi module

- 2–4 mục tiêu học, viết bằng động từ hành động ("Tạo được…", "Phân biệt được…").
- Nội dung bài học theo cấu trúc ở mục 7.
- 3–5 câu trắc nghiệm theo mục 8. Tỉ lệ gợi ý:
  - khoảng 40% câu nhận biết (`recall`)
  - khoảng 40% câu thao tác (`procedure`)
  - khoảng 20% câu tình huống (`scenario`)

---

## 6. Template 2 – Nhân sự chuyên sâu

### 6.1. Mục tiêu

Sau khi hoàn thành, người học:

- Biết vai trò của mình tương ứng với phân hệ, quyền và dữ liệu nào trong hệ thống.
- Thực hiện thành thạo quy trình nghiệp vụ phục vụ nhiệm vụ chuyên môn của mình.
- Biết phối hợp với phòng ban khác qua hệ thống (bàn giao, phê duyệt, chia sẻ dữ liệu).
- Kiểm soát chất lượng và xử lý được ngoại lệ, lỗi thường gặp trong nghiệp vụ.

### 6.2. Khung module

**Tóm tắt** (tổng 5–8 module):

| #   | Module                                 | Bắt buộc?          |
|-----|----------------------------------------|--------------------|
| 1   | Vai trò của bạn trong hệ thống         | Có                 |
| 2   | Quyền hạn và phạm vi dữ liệu           | Có                 |
| 3…n | Quy trình chuyên môn: \<tên nhiệm vụ\> | Có (phần lõi ~60%) |
| n+1 | Phối hợp liên phòng ban                | Chỉ khi có nguồn   |
| n+2 | Báo cáo và chỉ số chuyên môn           | Chỉ khi có nguồn   |
| n+3 | Kiểm soát, ngoại lệ và lỗi thường gặp  | Nếu có nguồn       |

**Chi tiết từng module:**

#### Module 1 – Vai trò của bạn trong hệ thống
- **Mục tiêu học:** nắm được phân hệ, màn hình và dữ liệu mà vị trí của mình sử dụng.
- **Cá nhân hóa:** nêu rõ phòng ban và chức danh. Liệt kê nhiệm vụ nào ứng với tính năng nào.

#### Module 2 – Quyền hạn và phạm vi dữ liệu
- **Mục tiêu học:** biết mình xem, sửa, duyệt được gì và trách nhiệm đi kèm.
- **Cá nhân hóa:** chỉ mô tả quyền mà tài liệu ghi cho vai trò này. Tài liệu không nói thì
  gắn cờ `missing`, không đoán.

#### Module 3…n – Quy trình chuyên môn: \<tên nhiệm vụ\>
- **Mục tiêu học:** thực hiện được trọn vẹn quy trình phục vụ một nhiệm vụ cụ thể.
- **Cá nhân hóa:** **mỗi nhiệm vụ chính một module**. Nhiệm vụ nhỏ dùng chung tính năng thì
  gộp lại. Đây là phần lõi, chiếm khoảng 60% lộ trình.

#### Module n+1 – Phối hợp liên phòng ban
- **Mục tiêu học:** bàn giao, phê duyệt, chia sẻ và nhận dữ liệu từ bộ phận khác.
- **Cá nhân hóa:** chỉ tạo khi tài liệu có mô tả luồng liên phòng ban liên quan.

#### Module n+2 – Báo cáo và chỉ số chuyên môn
- **Mục tiêu học:** dùng báo cáo, dashboard, xuất dữ liệu phục vụ công việc.
- **Cá nhân hóa:** chỉ tạo khi có báo cáo liên quan đến phòng ban hoặc nhiệm vụ.

#### Module n+3 – Kiểm soát, ngoại lệ và lỗi thường gặp
- **Mục tiêu học:** nhận biết sai sót, xử lý ngoại lệ, biết khi nào cần báo cáo lên.
- **Cá nhân hóa:** lấy từ FAQ, cảnh báo và quy định kiểm soát trong tài liệu.

> Nếu có nhiều nhiệm vụ hơn số module cho phép, AI gộp chúng theo nhóm tính năng dùng
> chung và ghi lại cách gộp trong `generationNotes`.

### 6.3. Lăng kính theo phòng ban

> Phần này **chỉ hướng dẫn AI nên tìm gì** trong tài liệu, không phải nội dung được phép tự
> viết. Tài liệu không có tính năng tương ứng thì AI không đưa vào, và gắn cờ nếu tính năng
> đó gắn với một nhiệm vụ admin đã nhập.

#### IT
- **Tính năng cần tìm:** quản trị người dùng, phân quyền, cấu hình, tích hợp/API, nhật ký
  hệ thống, sao lưu, xử lý sự cố.
- **Nhiệm vụ mẫu:** cấp/thu hồi tài khoản; cấu hình phân quyền; theo dõi lỗi; quản lý
  tích hợp.
- **Câu tình huống ví dụ:** *"Nhân viên mới không truy cập được phân hệ X, bạn kiểm tra ở
  đâu trước?"*

#### Marketing
- **Tính năng cần tìm:** chiến dịch, danh sách khách hàng/phân khúc, nội dung, kênh, theo
  dõi hiệu quả.
- **Nhiệm vụ mẫu:** tạo chiến dịch; phân khúc khách hàng; đo hiệu quả; quản lý nội dung.
- **Câu tình huống ví dụ:** *"Cần gửi chương trình cho nhóm khách hàng A, thao tác nào đúng
  theo hệ thống?"*

#### HR
- **Tính năng cần tìm:** hồ sơ nhân sự, tuyển dụng, chấm công, nghỉ phép, đánh giá, đào tạo.
- **Nhiệm vụ mẫu:** quản lý hồ sơ; tuyển dụng; duyệt nghỉ phép; tính công.
- **Câu tình huống ví dụ:** *"Đơn nghỉ phép bị trả về, nhân sự cần làm gì tiếp theo?"*

#### Sales
- **Tính năng cần tìm:** khách hàng tiềm năng, cơ hội, báo giá, đơn hàng, hợp đồng, công nợ
  khách hàng.
- **Nhiệm vụ mẫu:** quản lý lead; lập báo giá; tạo đơn; theo dõi pipeline.
- **Câu tình huống ví dụ:** *"Khách đồng ý báo giá, bước tiếp theo trên hệ thống là gì?"*

#### Finance
- **Tính năng cần tìm:** thu/chi, hóa đơn, công nợ, phê duyệt thanh toán, đối soát, báo cáo
  tài chính.
- **Nhiệm vụ mẫu:** duyệt thanh toán; đối soát; lập hóa đơn; báo cáo.
- **Câu tình huống ví dụ:** *"Hóa đơn vượt hạn mức, quy trình duyệt nào áp dụng?"*

#### Operations
- **Tính năng cần tìm:** kho, mua hàng, sản xuất/dịch vụ, giao vận, quy trình phê duyệt, SLA.
- **Nhiệm vụ mẫu:** nhập/xuất kho; tạo yêu cầu mua; theo dõi giao hàng; xử lý sự cố vận hành.
- **Câu tình huống ví dụ:** *"Hàng nhập về thiếu so với đơn mua, ghi nhận như thế nào?"*

#### Khác
- Dựa hoàn toàn trên nhiệm vụ do admin nhập.

### 6.4. Thuật toán cá nhân hóa

1. **Lọc ứng viên.** Lấy mọi mục trong `FeatureInventory` thỏa ít nhất một điều kiện:
   - `explicit` (liên kết mạnh): tài liệu ghi rõ tính năng dành cho phòng ban, chức danh
     hoặc vai trò hệ thống này.
   - `inferred` (liên kết suy luận): AI đánh giá tính năng phục vụ trực tiếp một nhiệm vụ
     trong `responsibilities`. AI **bắt buộc** ghi lý do một câu trong `relevanceRationale`.
2. **Xếp hạng.** `explicit` đứng trước `inferred`, sau đó xếp theo số nhiệm vụ mà tính năng
   phục vụ. Tính năng đã có ở Template 1 chỉ nhắc ngắn gọn kèm liên kết, không dạy lại.
3. **Đối chiếu nhiệm vụ với tính năng.** Mỗi nhiệm vụ admin nhập phải ứng với ít nhất một
   tính năng có nguồn. Nhiệm vụ không có tính năng tương ứng thì sinh cờ `missing`, ví dụ:
   > *"Tài liệu không mô tả tính năng phục vụ nhiệm vụ 'Đối soát ngân hàng'. Vui lòng bổ
   > sung tài liệu hoặc xác nhận nhiệm vụ này thực hiện ngoài hệ thống."*
4. **Kiểm soát liên kết suy luận.** `inferred` được phép, vì nó chỉ nói *tính năng có liên
   quan*, không mô tả *cách dùng tính năng*. Liên kết này vẫn hiển thị cho admin trong màn
   hình rà soát kèm lý do để admin có thể bỏ.
5. **Ghi nguồn cho bước thao tác.** Mọi bước thao tác trong module chuyên môn vẫn phải có
   `sourceRefs`, như ở Template 1.

### 6.5. Kết quả mong đợi của mỗi module

- Mở đầu bằng câu nối với công việc thực tế, ví dụ:
  *"Là \<chức danh\>, bạn dùng chức năng này khi…"*. Câu này chỉ dựa trên nhiệm vụ admin
  nhập và tính năng có nguồn.
- Ít nhất một khối `scenario` (tình huống nghiệp vụ) dựng từ các bước có nguồn.
- 3–5 câu trắc nghiệm. Tỉ lệ gợi ý:
  - khoảng 20% câu nhận biết (`recall`)
  - khoảng 40% câu thao tác (`procedure`)
  - khoảng 40% câu tình huống (`scenario`)

---

## 7. Quy chuẩn module bài học

### 7.1. Cấu trúc một module

```
Module
├── Tiêu đề (≤ 80 ký tự)
├── Mô tả ngắn (1–2 câu)
├── Thời lượng ước tính (phút)
├── Mục tiêu học (2–4 gạch đầu dòng)
├── Nội dung bài học: chuỗi các khối (LessonBlock)
│   ├── concept   – giải thích khái niệm/tính năng là gì, dùng khi nào
│   ├── steps     – các bước thao tác có đánh số
│   ├── scenario  – tình huống áp dụng (bắt buộc ở Template 2)
│   ├── tip       – mẹo, lưu ý hữu ích
│   ├── warning   – cảnh báo, điều cấm, lỗi dễ mắc
│   └── summary   – tóm tắt 3–5 ý chính (luôn là khối cuối)
├── Tài nguyên đính kèm (đoạn trích tài liệu gốc, ảnh chụp màn hình có nguồn)
└── Bài kiểm tra (3–5 câu)
```

### 7.2. Quy tắc viết

- **Ngôn ngữ:** theo lựa chọn của doanh nghiệp, mặc định tiếng Việt. Câu ngắn, giọng chủ
  động, gọi người học là "bạn".
- **Thuật ngữ:** giữ **nguyên văn** tên menu, nút, trường dữ liệu như trong tài liệu, viết
  **in đậm** hoặc `code`. Không dịch, không đổi tên.
- **Độ dài:** 300–900 từ mỗi module, tương đương 5–12 phút đọc.
- **Bước thao tác:** mỗi bước một hành động. Không gộp các bước mà tài liệu tách riêng,
  không chèn thêm bước tài liệu không có.
- **Nguồn:** mỗi khối (trừ `summary`) có ít nhất một `sourceRef`. Giao diện hiển thị biểu
  tượng "Nguồn" để mở đoạn trích gốc.
- **Nội dung đang bị gắn cờ:** hiển thị nhãn **"Đang chờ xác minh"** ngay tại khối đó, cho
  tới khi admin xử lý hoặc gỡ bỏ.
- **Tương tác:** có thể thêm câu hỏi kiểm tra nhanh (không tính điểm) sau khối `steps`.
  Câu này cũng phải theo quy chuẩn ở mục 8.

---

## 8. Quy chuẩn bài kiểm tra trắc nghiệm

### 8.1. Cấu trúc bắt buộc

| Thuộc tính      | Quy định                                  |
|-----------------|-------------------------------------------|
| Số câu / module | **3–5** (mặc định 4)                      |
| Loại câu        | Chọn một đáp án (`single_choice`)         |
| Số lựa chọn     | **Đúng 4** (A, B, C, D)                   |
| Đáp án đúng     | **Đúng 1**                                |
| Giải thích      | Bắt buộc, 1–3 câu, có trích dẫn nguồn     |
| Nguồn           | Ít nhất 1 `sourceRef` chứng minh đáp án   |
| Phạm vi         | Chỉ nội dung đã dạy trong module hiện tại |

**Yêu cầu với phần giải thích:** dễ hiểu, nói rõ **vì sao đáp án đúng là đúng**. Khi cần,
nói thêm vì sao phương án dễ nhầm nhất lại sai.

### 8.2. Mức độ câu hỏi

| Mức         | Tên gọi    | Kiểm tra điều gì                        |
|-------------|------------|-----------------------------------------|
| `recall`    | Nhận biết  | Nhớ tên, mục đích, vị trí của tính năng |
| `procedure` | Thao tác   | Biết đúng bước, đúng thứ tự bước        |
| `scenario`  | Tình huống | Áp dụng được vào tình huống công việc   |

Khuôn mẫu câu hỏi:

- `recall`: *"Chức năng \<X\> dùng để làm gì?"*
- `procedure`: *"Sau khi \<bước 2\>, bạn cần làm gì tiếp theo?"*
- `scenario`: *"Bạn cần \<mục tiêu\>. Cách làm đúng trên hệ thống là gì?"*

### 8.3. Quy tắc phương án nhiễu

- Phương án nhiễu phải **hợp lý và cùng loại** với đáp án đúng (cùng là tên menu, cùng là
  một bước, cùng là một vai trò…).
- Ưu tiên lấy phương án nhiễu từ **tính năng hoặc bước có thật trong tài liệu** nhưng sai
  ngữ cảnh (bước của quy trình khác, sai thứ tự). Cách này tránh tạo ra tên tính năng giả.
- Khi buộc phải dùng phương án không có trong tài liệu, phương án đó phải **sai rõ ràng** và
  không mô tả như một tính năng của hệ thống (ví dụ "Gửi email cho quản lý làm hộ").
- Không dùng "Tất cả đáp án trên", "Không có đáp án nào đúng" hay câu phủ định kép.
- 4 lựa chọn có độ dài tương đương nhau. Đáp án đúng không được dài bất thường.
- Vị trí đáp án đúng được **trộn ngẫu nhiên** khi hiển thị. Trong dữ liệu gốc, vị trí đáp
  án đúng phân bổ đều A/B/C/D trên toàn template.

### 8.4. Điều cấm

- Hỏi về nội dung có cờ `blocking` chưa được giải quyết.
- Câu hỏi mà đáp án đúng phụ thuộc vào suy luận ngoài tài liệu.
- Câu đánh đố chữ nghĩa, hỏi số trang, hỏi chi tiết vụn vặt không phục vụ công việc.
- Hai câu trong cùng một module kiểm tra cùng một ý.

---

## 9. Chống bịa nội dung (grounding)

### 9.1. Cơ chế bốn lớp

1. **Kho tính năng trung gian.** AI chỉ sinh bài học từ `FeatureInventory`, trong đó mỗi mục
   đã có `sourceRefs`.
2. **Trích dẫn nguyên văn.** Mỗi `sourceRef` chứa `quote`, là đoạn trích nguyên văn
   ≤ 300 ký tự.
3. **Kiểm định bằng code.** Kiểm tra `quote` có thật sự nằm trong section được trỏ tới (sau
   khi chuẩn hóa khoảng trắng, dấu câu, chữ hoa/thường). Không khớp thì gỡ khối hoặc câu
   hỏi, hoặc gắn cờ `unsupported`.
4. **Kiểm chứng bằng AI.** Một lượt gọi AI riêng (giai đoạn D) chấm từng khẳng định: đoạn
   trích có hỗ trợ khẳng định hay không.
   - `supported`: giữ nguyên.
   - `partial`: gắn cờ `ambiguous`.
   - `unsupported`: gỡ nội dung.

### 9.2. Danh sách kiểm tra tự động (validator)

**Template**
- [ ] Số module nằm trong giới hạn (T1: 4–8, T2: 5–8).
- [ ] ID module, khối và câu hỏi là duy nhất.
- [ ] Template 1 có Module 1 (Tổng quan), hoặc đã có cờ `blocking` cho việc thiếu module này.
- [ ] Template 2: mọi nhiệm vụ trong `RoleProfile.responsibilities` đều đã được dạy ở một
      module hoặc có cờ `missing`.

**Khối bài học**
- [ ] Mọi khối khác `summary` có ít nhất một `sourceRef` hợp lệ.
- [ ] `quote` khớp với nội dung section nguồn.
- [ ] Mọi tên menu/nút được viết nhấn mạnh đều xuất hiện nguyên văn trong tài liệu nguồn.

**Câu hỏi**
- [ ] Mỗi module có 3–5 câu.
- [ ] Mỗi câu có đúng 4 lựa chọn và không có lựa chọn trùng nhau.
- [ ] Mỗi câu có đúng 1 đáp án đúng, `correctOptionId` nằm trong tập lựa chọn.
- [ ] `explanation` không rỗng, dài 20–400 ký tự.
- [ ] Có `sourceRef` hợp lệ.
- [ ] Không dựa trên khối có cờ `blocking` đang mở.
- [ ] Không chứa các cụm bị cấm ở mục 8.3.

> Template không qua validator thì **chỉ phần bị lỗi được sinh lại, tối đa 2 lần**. Nếu
> vẫn lỗi, template giữ ở `draft` kèm cờ `generation_error` để admin xử lý thủ công.

---

## 10. Đánh dấu cần xác minh

### 10.1. Loại cờ

| Loại                 | Mức mặc định                         |
|----------------------|--------------------------------------|
| `missing`            | `blocking` hoặc `warning` (xem dưới) |
| `conflict`           | `blocking`                           |
| `ambiguous`          | `warning`                            |
| `outdated`           | `warning`                            |
| `unsupported`        | Tự gỡ, ghi nhật ký                   |
| `audience_unclear`   | `warning`                            |
| `low_quality_source` | `warning`                            |
| `generation_error`   | `blocking`                           |

**Khi nào phát sinh:**

- **`missing`:** thiếu thông tin cần thiết, ví dụ không có hướng dẫn đăng nhập, nhiệm vụ
  không có tính năng tương ứng, bước bị bỏ dở ("…sau đó hoàn tất"). Mức `blocking` nếu
  thuộc module bắt buộc hoặc nhiệm vụ chính, còn lại là `warning`.
- **`conflict`:** hai đoạn tài liệu mâu thuẫn (khác tên nút, thứ tự bước, hạn mức, quyền).
- **`ambiguous`:** diễn đạt mơ hồ, hiểu được nhiều cách ("liên hệ bộ phận liên quan"),
  hoặc AI kiểm chứng cho kết quả `partial`.
- **`outdated`:** tài liệu tự ghi là cũ, khác phiên bản phần mềm đã khai báo, hoặc đã quá
  ngày hiệu lực.
- **`unsupported`:** nội dung AI sinh ra không tìm thấy nguồn. Chỉ tạo cờ nếu việc gỡ làm
  module thiếu nội dung.
- **`audience_unclear`:** không rõ tính năng dành cho mọi nhân viên hay chỉ cho vai trò
  cụ thể.
- **`low_quality_source`:** PDF scan hoặc OCR có độ tin cậy thấp.
- **`generation_error`:** sinh lại 2 lần vẫn không qua validator.

### 10.2. Nội dung một cờ

Mỗi cờ phải giúp admin xử lý được **mà không cần đọc lại toàn bộ tài liệu**:

- **Mô tả:** điều gì đang thiếu hoặc mâu thuẫn, trong một câu.
- **Vị trí:** module, khối, câu hỏi bị ảnh hưởng.
- **Bằng chứng:** các đoạn trích liên quan. Với `conflict`, hai đoạn trích hiển thị cạnh nhau.
- **Câu hỏi cho admin:** câu hỏi cụ thể, ví dụ:
  > *"Nút xác nhận đơn tên là 'Duyệt' (Tài liệu A, tr.12) hay 'Phê duyệt' (Tài liệu B, tr.4)?"*
- **Tác động:** điều gì đang bị chặn (không publish được, câu hỏi bị loại khỏi quiz…).

### 10.3. Cách admin xử lý

1. **Chọn một phương án** (với `conflict`): AI viết lại khối liên quan theo phương án đã
   chọn. Nguồn được ghi `admin_verified` kèm người xác nhận và thời điểm.
2. **Nhập thông tin bổ sung:** văn bản admin nhập trở thành nguồn mới loại `admin_note`,
   có thể trích dẫn. AI sinh lại khối hoặc câu hỏi liên quan.
3. **Tải lên tài liệu bổ sung:** chạy lại giai đoạn A cho tài liệu mới, cập nhật kho tính
   năng. Chỉ phần bị ảnh hưởng được sinh lại.
4. **Loại bỏ:** xóa khối, câu hỏi hoặc module liên quan rồi đóng cờ kèm lý do.
5. **Chấp nhận** (chỉ áp dụng cho `warning`): giữ nguyên nội dung, đóng cờ, nhãn "Đang chờ
   xác minh" biến mất.

**Quy tắc:**
- Không publish được khi còn cờ `blocking` ở trạng thái `open`.
- Mọi thao tác xử lý cờ đều ghi audit: ai, lúc nào, trước và sau thay đổi.

---

## 11. Học theo module, chấm điểm và hiển thị đáp án

### 11.1. Trạng thái module của người học

```
 locked ─▶ available ─▶ learning ─▶ quiz_ready ─▶ passed
                                       │    ▲
                                  nộp  │    │ làm lại
                                 chưa  ▼    │
                                 đạt  quiz_failed
```

| Trạng thái    | Điều kiện                                       |
|---------------|-------------------------------------------------|
| `locked`      | Module trước chưa `passed` (chế độ học tuần tự) |
| `available`   | Được phép mở nhưng chưa mở                      |
| `learning`    | Đã mở bài học, chưa đọc hết các khối bắt buộc   |
| `quiz_ready`  | Đã đọc hết nội dung, được phép làm bài          |
| `quiz_failed` | Đã nộp bài nhưng điểm dưới ngưỡng đạt           |
| `passed`      | Điểm đạt ngưỡng, module kế tiếp được mở khóa    |

- "Đọc hết nội dung" nghĩa là cuộn tới khối `summary` hoặc bấm "Hoàn thành bài học".
- Chế độ học do admin cấu hình cho từng template:
  - **Tuần tự** (mặc định): phải đạt module trước mới mở được module sau.
  - **Tự do:** mọi module mở sẵn, nhưng vẫn phải đạt quiz thì module mới tính là hoàn thành.

### 11.2. Chấm điểm

- Mỗi câu đúng được 1 điểm.
  **Điểm module = số câu đúng ÷ tổng số câu × 100**, làm tròn đến số nguyên.
- Ngưỡng đạt mặc định **70%** (cấu hình được trong khoảng 50–100%).
  Số câu đúng tối thiểu = `ceil(ngưỡng × số câu)`, xem bảng dưới.

| Số câu | Đúng tối thiểu (70%) |
|--------|----------------------|
| 3      | 3/3                  |
| 4      | 3/4                  |
| 5      | 4/5                  |

> Module 3 câu đòi đúng tuyệt đối, nên ưu tiên dùng 4–5 câu cho module quan trọng.

- Điểm được chấm **ở server** dựa trên snapshot template đã gán. Client không bao giờ nhận
  đáp án trước khi nộp.
- Mỗi lần nộp kèm `operationId` để chống nộp trùng khi mạng chập chờn.

### 11.3. Sau khi nộp bài

Màn hình kết quả hiển thị **từng câu** gồm:

1. Câu hỏi và lựa chọn của người học, đánh dấu Đúng hoặc Sai.
2. **Đáp án đúng**, được làm nổi bật.
3. **Giải thích** dễ hiểu vì sao đáp án đó đúng.
4. Liên kết **"Xem lại trong bài học"** tới khối nội dung liên quan, và liên kết **"Nguồn"**
   tới đoạn trích tài liệu gốc.

Cuối màn hình hiển thị tổng điểm, kết luận **Đạt / Chưa đạt** và nút hành động:
**"Sang module tiếp theo"** hoặc **"Ôn lại và làm lại"**.

### 11.4. Làm lại

- Mặc định được làm tối đa **3 lần** mỗi module. Admin cấu hình được, kể cả đặt không giới hạn.
- Mỗi lần làm lại, thứ tự câu hỏi và thứ tự lựa chọn được **trộn lại**.
- Có thể đặt thời gian chờ giữa các lần (mặc định 0), hoặc bắt buộc mở lại bài học trước
  khi làm lại.
- Hết lượt mà chưa đạt thì module chuyển sang `needs_support`, admin nhận thông báo để hỗ
  trợ (cấp thêm lượt, hướng dẫn trực tiếp).
- **Điểm ghi nhận là điểm cao nhất.** Mọi lần làm vẫn được lưu đầy đủ để audit.

---

## 12. Lưu kết quả và theo dõi tiến độ

### 12.1. Dữ liệu được lưu

- **`Assignment`:** người học, template, phiên bản snapshot, hạn hoàn thành, trạng thái tổng.
- **`ModuleProgress`:** trạng thái module, thời điểm mở, thời điểm đọc xong, thời gian học,
  điểm cao nhất, số lần làm.
- **`QuizAttempt`:** lần làm thứ mấy, lựa chọn từng câu, đúng/sai từng câu, điểm, đạt hay
  không, thời điểm bắt đầu và nộp.
- **`LessonBlockView`** (tùy chọn): khối nào đã xem, dùng để xác định "đã đọc hết bài".

> Assignment luôn trỏ tới **phiên bản template đã publish tại thời điểm gán**. Khi admin
> publish phiên bản mới, người đang học không bị đổi nội dung giữa chừng.

### 12.2. Công thức tiến độ

- **Tiến độ assignment** = số module `passed` ÷ tổng số module × 100%.
- **Tiến độ chi tiết** (để thanh tiến độ chạy mượt hơn): mỗi module đóng góp 50% khi đọc
  xong bài học và 50% khi quiz đạt.
- **Trạng thái assignment:**
  - `assigned` → `in_progress` → `completed` (mọi module đã `passed`)
  - `overdue`: quá hạn mà chưa hoàn thành
  - `needs_support`: có module đã hết lượt làm

### 12.3. Màn hình theo dõi

**Người học**
- Danh sách lộ trình được giao, phần trăm hoàn thành, hạn chót.
- Danh sách module kèm trạng thái, điểm cao nhất và nút "Tiếp tục học".
- Lịch sử bài làm: xem lại đáp án và giải thích của các lần đã nộp.

**Admin**
- **Tổng quan:** số người đang học, tỉ lệ hoàn thành, số quá hạn, số cần hỗ trợ.
- **Theo người:** tiến độ từng module, điểm, số lần làm.
- **Theo module:** điểm trung bình, tỉ lệ đạt ngay lần đầu.
- **Theo câu hỏi:** tỉ lệ trả lời đúng của từng câu. Câu dưới 40% bị đánh dấu "Cần xem lại",
  vì đó thường là dấu hiệu tài liệu khó hiểu, câu hỏi gây nhầm hoặc đáp án sai. Admin mở
  nhanh được nguồn của câu đó.
- **Hàng chờ xác minh:** các cờ đang mở, nhóm theo template và mức độ.

---

## 13. Mô hình dữ liệu

Tên trường bám theo mô hình hiện có của app (`EmployeeType = 'normal' | 'advanced'`,
`single_choice`, `correctOptionIds`, `explanation`). Các trường mới cho phần AI được ghi chú
`// mới`.

```ts
// ---------- Nguồn ----------
interface SourceDocument {
  id: string;
  fileName: string;
  mimeType: string;
  checksum: string;               // sha256 để phát hiện tải trùng
  systemName: string;             // tên hệ thống/phần mềm
  softwareVersion?: string;
  effectiveDate?: string;         // ISO
  uploadedBy: string;
  uploadedAt: string;
  sections: SourceSection[];
}

interface SourceSection {
  id: string;                     // ổn định, ví dụ "doc1#s3.2"
  documentId: string;
  headingPath: string[];          // ["3. Đơn hàng", "3.2 Tạo đơn"]
  page?: number;
  text: string;
}

interface SourceRef {
  kind: 'document' | 'admin_note';
  documentId?: string;
  sectionId?: string;
  page?: number;
  quote: string;                  // trích nguyên văn, ≤ 300 ký tự
  verifiedBy?: string;            // khi admin xác nhận
  verifiedAt?: string;
}

// ---------- Kho tính năng ----------
interface FeatureInventoryItem {
  id: string;                     // "feat-order-create"
  name: string;                   // giữ nguyên tên trong tài liệu
  module?: string;                // phân hệ
  purpose: string;
  steps: { order: number; action: string; sourceRefs: SourceRef[] }[];
  audience: 'all' | 'role_specific' | 'admin' | 'unclear';
  departments: Department[];      // chỉ những phòng ban tài liệu nêu rõ
  roles: string[];                // vai trò hệ thống tài liệu nêu rõ
  sourceRefs: SourceRef[];
  flagIds: string[];
}

type Department = 'it' | 'marketing' | 'hr' | 'sales' | 'finance' | 'operations' | 'other';

// ---------- Template sinh ra ----------
interface GeneratedTemplate {
  id: string;
  version: number;
  source: 'ai_generated';                   // mới
  status: 'draft' | 'published' | 'archived';
  employeeType: 'normal' | 'advanced';
  roleProfile?: RoleProfile;                // mới, chỉ khi advanced
  title: string;
  description: string;
  passingScore: number;                     // mặc định 70
  learningMode: 'sequential' | 'free';      // mới
  maxAttemptsPerModule: number | null;      // mới, null = không giới hạn
  modules: GeneratedModule[];
  flags: VerificationFlag[];                // mới
  sourceDocumentIds: string[];              // mới
  generationNotes: string[];                // mới, ghi chú gộp/bỏ module
  generatedAt: string;
  model: string;                            // model AI đã dùng
}

interface GeneratedModule {
  id: string;
  key: string;                    // khóa khung, ví dụ "t1-overview", "t2-task-1"
  order: number;
  title: string;
  description: string;
  estimatedMinutes: number;
  objectives: string[];
  blocks: LessonBlock[];
  questions: GeneratedQuestion[];
  featureIds: string[];           // tính năng được dạy trong module
}

interface LessonBlock {
  id: string;
  kind: 'concept' | 'steps' | 'scenario' | 'tip' | 'warning' | 'summary';
  title?: string;
  body: string;                   // markdown
  steps?: { order: number; text: string }[];
  sourceRefs: SourceRef[];        // bắt buộc ≥ 1 trừ khi kind = summary
  flagIds: string[];
}

interface GeneratedQuestion {
  id: string;
  type: 'single_choice';
  level: 'recall' | 'procedure' | 'scenario';
  prompt: string;
  options: [QuestionOption, QuestionOption, QuestionOption, QuestionOption];
  correctOptionIds: [string];     // đúng 1 phần tử
  explanation: string;
  sourceRefs: SourceRef[];
  blockIds: string[];             // khối bài học mà câu hỏi kiểm tra
}

interface QuestionOption { id: string; label: string; }

// ---------- Cờ xác minh ----------
interface VerificationFlag {
  id: string;
  type: 'missing' | 'conflict' | 'ambiguous' | 'outdated' | 'unsupported'
      | 'audience_unclear' | 'low_quality_source' | 'generation_error';
  severity: 'blocking' | 'warning';
  message: string;
  questionForAdmin: string;
  location: { moduleId?: string; blockId?: string; questionId?: string; featureId?: string };
  evidence: SourceRef[];
  status: 'open' | 'resolved' | 'dismissed';
  resolution?: {
    action: 'choose_option' | 'add_note' | 'upload_doc' | 'remove' | 'accept';
    note?: string;
    by: string;
    at: string;
  };
}

// ---------- Học & kết quả ----------
interface ModuleProgress {
  assignmentId: string;
  moduleId: string;
  status: 'locked' | 'available' | 'learning' | 'quiz_ready' | 'quiz_failed'
        | 'passed' | 'needs_support';
  openedAt?: string;
  lessonCompletedAt?: string;
  timeSpentSeconds: number;
  attemptCount: number;
  bestScore?: number;
  passedAt?: string;
}

interface QuizAttempt {
  id: string;
  assignmentId: string;
  moduleId: string;
  ordinal: number;
  operationId: string;
  questionOrder: string[];
  optionOrder: Record<string, string[]>;
  answers: { questionId: string; selectedOptionId: string; correct: boolean }[];
  correctCount: number;
  totalCount: number;
  score: number;                  // 0–100
  passed: boolean;
  startedAt: string;
  submittedAt: string;
}
```

**DTO cho người học**

- **Trước khi nộp:** bỏ `correctOptionIds`, `explanation`, `sourceRefs` của câu hỏi và toàn
  bộ `flags`.
- **Sau khi nộp:** API kết quả trả `correctOptionIds` và `explanation` **chỉ cho các câu
  trong lần nộp đó**.

---

## 14. Prompt AI cho từng bước

Mọi bước đều yêu cầu AI trả về **JSON đúng schema** (khuyến nghị dùng structured output
hoặc tool use). Server luôn chạy validator ở mục 9.2 sau mỗi bước.

### 14.1. Giai đoạn A: trích xuất kho tính năng

**System prompt:**

```
Bạn là chuyên gia phân tích tài liệu hướng dẫn sử dụng phần mềm doanh nghiệp.
Nhiệm vụ: đọc các SECTION tài liệu dưới đây và lập KHO TÍNH NĂNG.

QUY TẮC BẮT BUỘC
1. Chỉ ghi nhận tính năng/thao tác được tài liệu mô tả. Không thêm kiến thức bên ngoài,
   không suy đoán tên menu, nút, đường dẫn, phím tắt, quyền hạn.
2. Giữ NGUYÊN VĂN tên tính năng, menu, nút, trường dữ liệu như trong tài liệu.
3. Mỗi tính năng và mỗi bước phải có sourceRefs với quote là đoạn trích NGUYÊN VĂN
   (≤ 300 ký tự) từ đúng sectionId.
4. audience:
   - "all" nếu tài liệu nói mọi người dùng/nhân viên đều dùng, hoặc là thao tác chung
     (đăng nhập, điều hướng, tìm kiếm, thông báo, hồ sơ cá nhân);
   - "role_specific"/"admin" chỉ khi tài liệu nêu rõ vai trò/phòng ban;
   - "unclear" cho các trường hợp còn lại.
5. Phát hiện và trả về FLAGS:
   - missing: bước bị bỏ dở, tham chiếu tới nội dung không có, thiếu thông tin cần để thực hiện;
   - conflict: hai đoạn mâu thuẫn (tên, thứ tự bước, hạn mức, quyền) — kèm cả hai đoạn trích;
   - ambiguous: diễn đạt có thể hiểu nhiều cách;
   - outdated: tài liệu tự nhận là cũ hoặc khác phiên bản đã khai báo.
   Mỗi flag phải có questionForAdmin cụ thể, trả lời được bằng một câu.
6. Nếu không chắc, hãy tạo flag thay vì khẳng định.

Trả về JSON theo schema FeatureInventoryResult.
```

**User message:** metadata (tên hệ thống, phiên bản, ngày hiệu lực) và danh sách
`SourceSection` theo dạng `[sectionId] headingPath\ntext`.

**Output schema (tóm tắt):**

```json
{
  "systemSummary": { "purpose": "string", "modules": ["string"], "sourceRefs": [] },
  "glossary": [{ "term": "string", "definition": "string", "sourceRefs": [] }],
  "features": [ /* FeatureInventoryItem[] */ ],
  "flags": [ /* VerificationFlag[] (status = open) */ ]
}
```

> Với tài liệu dài, chạy giai đoạn A theo từng nhóm section rồi **gộp** kết quả. Nếu hai
> tính năng trùng tên nhưng mô tả khác nhau thì sinh cờ `conflict`.

### 14.2. Giai đoạn B: tạo Template 1

```
Bạn là chuyên gia thiết kế đào tạo (instructional designer).
Tạo lộ trình onboarding TEMPLATE 1 – NHÂN SỰ THÔNG THƯỜNG cho hệ thống "{systemName}".

ĐẦU VÀO: KHO TÍNH NĂNG (JSON) — đây là NGUỒN DUY NHẤT bạn được dùng.

KHUNG MODULE (giữ thứ tự, bỏ/gộp vị trí không đủ nguồn và ghi lý do vào generationNotes):
1 Tổng quan hệ thống · 2 Truy cập & tài khoản · 3 Giao diện & điều hướng ·
4 Thao tác cốt lõi hằng ngày · 5 Tìm kiếm, dữ liệu & báo cáo cơ bản ·
6 Phân quyền, bảo mật & quy định · 7 Hỗ trợ & xử lý sự cố

QUY TẮC
- Chỉ dùng feature có audience = "all" hoặc "unclear" (với "unclear" gắn flag audience_unclear).
- Không dạy tính năng chỉ dành cho phòng ban/quản trị.
- Mỗi module: 2–4 mục tiêu; các khối concept/steps/tip/warning/summary; 300–900 từ.
- Mỗi khối (trừ summary) có sourceRefs sao chép từ kho tính năng — KHÔNG tạo quote mới.
- Bước thao tác: giữ đúng số bước và thứ tự của kho tính năng; không thêm bước.
- Tên menu/nút giữ nguyên văn, in đậm.
- Bài kiểm tra mỗi module: 3–5 câu single_choice, đúng 4 lựa chọn, đúng 1 đáp án,
  explanation 1–3 câu giải thích VÌ SAO đúng, có sourceRefs; tỉ lệ ~40% recall,
  40% procedure, 20% scenario; phương án nhiễu lấy từ tính năng/bước có thật nhưng sai
  ngữ cảnh; cấm "Tất cả đáp án trên"/"Không có đáp án nào".
- Không đặt câu hỏi dựa trên feature có flag blocking.
- Phân bổ đều vị trí đáp án đúng.
- Ngôn ngữ: {language}. Gọi người học là "bạn".

Trả về JSON theo schema GeneratedTemplate (employeeType = "normal").
```

### 14.3. Giai đoạn C: tạo Template 2

```
Bạn là chuyên gia thiết kế đào tạo chuyên môn.
Tạo lộ trình TEMPLATE 2 – NHÂN SỰ CHUYÊN SÂU cho hồ sơ:
- Phòng ban: {department}  - Chức danh: {jobTitle}
- Nhiệm vụ chuyên môn: {responsibilities}
- Vai trò hệ thống: {systemRole | "không rõ"}

ĐẦU VÀO: KHO TÍNH NĂNG (JSON) — NGUỒN DUY NHẤT.
Danh sách feature đã dạy ở Template 1: {t1FeatureIds}.

BƯỚC 1 — ĐỐI CHIẾU: với mỗi nhiệm vụ, liệt kê feature phục vụ nó.
  relevance = "explicit" nếu tài liệu gắn feature với phòng ban/vai trò này;
  relevance = "inferred" nếu bạn đánh giá feature phục vụ nhiệm vụ — BẮT BUỘC ghi
  relevanceRationale 1 câu. Nhiệm vụ không có feature nào → tạo flag missing.

BƯỚC 2 — KHUNG MODULE (5–8 module):
  1 Vai trò của bạn trong hệ thống · 2 Quyền hạn & phạm vi dữ liệu ·
  3…n Quy trình chuyên môn (mỗi nhiệm vụ chính 1 module, gộp nhiệm vụ dùng chung feature) ·
  Phối hợp liên phòng ban (nếu có nguồn) · Báo cáo & chỉ số (nếu có nguồn) ·
  Kiểm soát, ngoại lệ & lỗi thường gặp.

BƯỚC 3 — NỘI DUNG: như Template 1, cộng thêm:
  - Mở đầu module bằng câu nối với công việc của {jobTitle}, chỉ dựa trên nhiệm vụ đã nhập.
  - Ít nhất 1 khối scenario dựng từ các bước có nguồn.
  - Feature đã có ở Template 1: chỉ nhắc 1 câu + tham chiếu, không dạy lại.
  - Quyền hạn: chỉ nêu quyền tài liệu ghi cho vai trò này; không có → flag missing.
  - Câu hỏi: ~20% recall, 40% procedure, 40% scenario.

Trả về JSON theo schema GeneratedTemplate (employeeType = "advanced") kèm
taskCoverage: [{ task, featureIds, relevance, relevanceRationale?, moduleId | null, flagId | null }].
```

### 14.4. Giai đoạn D: kiểm chứng trích dẫn

Chạy sau validator bằng code. Có thể dùng model nhỏ hơn để tiết kiệm chi phí.

```
Với mỗi cặp (KHẲNG ĐỊNH, ĐOẠN TRÍCH) dưới đây, đánh giá đoạn trích có đủ chứng minh
khẳng định không. Chỉ dựa vào đoạn trích, không dùng kiến thức bên ngoài.
Trả về: { id, verdict: "supported" | "partial" | "unsupported", reason }.
- supported: mọi chi tiết (tên, bước, con số, điều kiện) đều có trong đoạn trích.
- partial: đúng hướng nhưng có chi tiết không có trong đoạn trích.
- unsupported: đoạn trích không nói điều này hoặc nói khác.
```

Các khẳng định cần kiểm tra:
- từng bước thao tác;
- từng câu trong các khối `concept`, `warning`, `tip`;
- từng bộ **câu hỏi + đáp án đúng + giải thích**.

---

## 15. Ví dụ minh họa

> Ví dụ dùng hệ thống giả định "Hệ thống Quản lý Đơn hàng", chỉ để minh họa định dạng.

### 15.1. Đoạn tài liệu nguồn

```
[doc1#s4.1] 4. Đơn hàng > 4.1 Tạo đơn hàng mới
Để tạo đơn hàng, chọn menu Bán hàng > Đơn hàng, bấm nút "Tạo mới".
Nhập Mã khách hàng, chọn sản phẩm và số lượng, sau đó bấm "Lưu nháp".
Đơn ở trạng thái Nháp có thể chỉnh sửa. Bấm "Gửi duyệt" để chuyển cho Trưởng nhóm.

[doc2#s2.3] Quy trình duyệt đơn
Sau khi lưu, nhân viên bấm "Trình duyệt" để gửi đơn cho Trưởng nhóm.
```

### 15.2. Cờ được sinh ra (`conflict`)

```json
{
  "id": "flag-007",
  "type": "conflict",
  "severity": "blocking",
  "message": "Hai tài liệu dùng tên nút khác nhau cho thao tác gửi đơn đi duyệt.",
  "questionForAdmin": "Nút gửi đơn cho Trưởng nhóm tên là \"Gửi duyệt\" (doc1, mục 4.1) hay \"Trình duyệt\" (doc2, mục 2.3)?",
  "location": { "featureId": "feat-order-create", "moduleId": "t1-core", "blockId": "blk-order-steps" },
  "evidence": [
    { "kind": "document", "documentId": "doc1", "sectionId": "doc1#s4.1", "quote": "Bấm \"Gửi duyệt\" để chuyển cho Trưởng nhóm." },
    { "kind": "document", "documentId": "doc2", "sectionId": "doc2#s2.3", "quote": "nhân viên bấm \"Trình duyệt\" để gửi đơn cho Trưởng nhóm." }
  ],
  "status": "open"
}
```

### 15.3. Khối bài học

Các bước 1–4 đã có nguồn. Bước 5 hiển thị nhãn chờ xác minh.

```markdown
### Tạo đơn hàng mới
1. Chọn menu **Bán hàng > Đơn hàng**.
2. Bấm nút **Tạo mới**.
3. Nhập **Mã khách hàng**, chọn sản phẩm và số lượng.
4. Bấm **Lưu nháp**. Đơn ở trạng thái Nháp vẫn có thể chỉnh sửa.
5. [Đang chờ xác minh] Gửi đơn cho Trưởng nhóm duyệt.
```

### 15.4. Câu hỏi hợp lệ

Câu này không dựa trên bước đang bị cờ chặn:

```json
{
  "id": "q-core-02",
  "type": "single_choice",
  "level": "procedure",
  "prompt": "Bạn vừa chọn sản phẩm và số lượng cho đơn hàng mới. Bạn cần bấm nút nào để lưu đơn ở trạng thái còn chỉnh sửa được?",
  "options": [
    { "id": "a", "label": "Tạo mới" },
    { "id": "b", "label": "Lưu nháp" },
    { "id": "c", "label": "Bán hàng" },
    { "id": "d", "label": "Đơn hàng" }
  ],
  "correctOptionIds": ["b"],
  "explanation": "Theo hướng dẫn mục 4.1, sau khi nhập thông tin đơn bạn bấm \"Lưu nháp\". Đơn ở trạng thái Nháp vẫn chỉnh sửa được. \"Tạo mới\" là nút để bắt đầu một đơn, còn \"Bán hàng\" và \"Đơn hàng\" là tên menu.",
  "sourceRefs": [
    { "kind": "document", "documentId": "doc1", "sectionId": "doc1#s4.1", "quote": "sau đó bấm \"Lưu nháp\". Đơn ở trạng thái Nháp có thể chỉnh sửa." }
  ],
  "blockIds": ["blk-order-steps"]
}
```

Các phương án nhiễu (`Tạo mới`, `Bán hàng`, `Đơn hàng`) đều là tên có thật trong tài liệu
nhưng sai ngữ cảnh. Không có tên tính năng nào bị bịa ra.

### 15.5. Câu hỏi không hợp lệ (bị validator loại)

> *"Nút nào dùng để gửi đơn cho Trưởng nhóm duyệt?"*

Lý do: câu này dựa trên nội dung có cờ `flag-007` (`blocking`) đang mở.

---

## 16. Tiêu chí nghiệm thu

**Sinh nội dung**
- [ ] Tải lên ít nhất 1 tài liệu (PDF/DOCX/MD) thì sinh được Template 1 có 4–8 module.
- [ ] Nhập hồ sơ vai trò cho từng phòng ban IT, Marketing, HR, Sales, Finance, Operations
      thì sinh được Template 2 có 5–8 module, mọi nhiệm vụ đều được dạy hoặc gắn cờ.
- [ ] 100% khối bài học (trừ `summary`) và câu hỏi có `sourceRef` với `quote` khớp nguồn.
- [ ] Mỗi module có 3–5 câu, mỗi câu có 4 lựa chọn, 1 đáp án đúng và giải thích.
- [ ] Tài liệu có hai đoạn mâu thuẫn thì sinh cờ `conflict` kèm cả hai đoạn trích.
- [ ] Tài liệu thiếu hướng dẫn cho một nhiệm vụ đã nhập thì sinh cờ `missing`.
- [ ] Bài kiểm thử "tài liệu cài bẫy": nội dung sinh ra không chứa tính năng có ở phần mềm
      cùng loại nhưng vắng mặt trong tài liệu.

**Quản trị**
- [ ] Không thể publish khi còn cờ `blocking` đang mở.
- [ ] Admin xử lý được cờ bằng cả 5 hành động ở mục 10.3, mọi thao tác đều được ghi audit.
- [ ] Publish tạo phiên bản bất biến, người đang học không bị đổi nội dung.

**Người học**
- [ ] Ở chế độ tuần tự, module sau chỉ mở khi module trước đạt.
- [ ] Trước khi nộp, dữ liệu client không chứa đáp án hay giải thích (kiểm tra qua network).
- [ ] Sau khi nộp, xem được đáp án đúng, giải thích và liên kết nguồn cho từng câu.
- [ ] Điểm do server tính. Nộp trùng `operationId` không tạo thêm lần làm.
- [ ] Làm lại thì thứ tự câu hỏi và lựa chọn được trộn. Hết lượt thì chuyển `needs_support`.

**Tiến độ**
- [ ] Tiến độ assignment và module cập nhật ngay sau khi nộp bài.
- [ ] Admin xem được tiến độ theo người, theo module và tỉ lệ đúng của từng câu.

---

## 17. Giả định và câu hỏi mở

1. **Nhân sự chuyên sâu có bắt buộc học Template 1 trước không?**
   Đề xuất: có. Admin có thể miễn cho từng người.

2. **Ngưỡng đạt và số lần làm lại?**
   Đề xuất: 70%, tối đa 3 lần mỗi module, cấu hình được theo template.

3. **Khi tài liệu được cập nhật, template đã publish xử lý thế nào?**
   Đề xuất: sinh bản `draft` mới kèm bảng so sánh (diff). Admin tự publish. Assignment
   cũ giữ nguyên.

4. **Ngôn ngữ đầu ra?**
   Đề xuất: theo cấu hình doanh nghiệp, mặc định tiếng Việt. Tên menu/nút giữ nguyên văn
   tài liệu.

5. **Model AI?**
   Đề xuất: model mạnh cho giai đoạn A–C, model nhỏ hơn cho giai đoạn D. Lưu tên model vào
   `GeneratedTemplate.model`.

6. **Bảo mật tài liệu?**
   Đề xuất: tài liệu và dữ liệu sinh ra được cô lập theo doanh nghiệp/room, không dùng
   chéo giữa các doanh nghiệp.

7. **Giới hạn kích thước tài liệu?**
   Cần xác định, ví dụ ≤ 50 MB/file và ≤ 500 trang/bộ, để ước tính chi phí và thời gian
   sinh nội dung.

8. **Ảnh chụp màn hình trong tài liệu?**
   Đề xuất: chỉ dùng làm minh họa cho bước đã có mô tả bằng chữ. Có thể cân nhắc model đọc
   ảnh ở giai đoạn sau.
