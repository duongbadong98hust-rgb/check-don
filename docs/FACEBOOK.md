# Nối Facebook Live (đọc comment)

Phần mềm chỉ **đọc** comment qua Graph API chính thức. Nó không đăng nhập bằng mật khẩu, không comment, không nhắn tin.
Giao diện Facebook hay đổi tên menu, nên nếu chỗ nào không khớp, hãy tìm mục có ý nghĩa tương tự.

> **Quy tắc quan trọng:** token và App Secret là "chìa khóa". Chỉ dán vào file `.env` trên máy chạy phần mềm.
> **Không dán vào chat, không gửi tin nhắn, không đưa lên GitHub.** (`.env` đã được đưa vào `.gitignore`.)

## Bước 1 — Cho nick phụ quyền trên Page (làm bằng nick chính, một lần)
1. Nick phụ nên là tài khoản **thật của một người thật** (người nhà, nhân viên).
2. Nick chính vào Page → Cài đặt → **Quyền truy cập Page** (Page access) → thêm người → chọn nick phụ → cấp quyền **Facebook access** (hoặc "Kiểm soát toàn bộ") → xác nhận.
3. Nick phụ vào thông báo và **chấp nhận lời mời**.
Nick chính vẫn là quản trị cao nhất. Từ đây trở đi nick chính không cần làm gì nữa.

## Bước 2 — Tạo app (bằng nick phụ)
1. Vào https://developers.facebook.com, đăng nhập bằng **nick phụ**, đăng ký làm nhà phát triển.
2. **Tạo ứng dụng** (Create App). Nếu hỏi mục đích/loại app, chọn loại "Khác" hoặc "Doanh nghiệp" (Other / Business), đặt tên bất kỳ.
3. Để app ở chế độ **Phát triển (Development)**. Với Page của chính bạn thường không cần xét duyệt app.
4. Vào **Cài đặt ứng dụng → Cơ bản**: ghi lại **App ID**, bấm hiện **App Secret**.

## Bước 3 — Lấy token ngắn hạn (nick phụ)
1. Mở https://developers.facebook.com/tools/explorer
2. Chọn đúng app của bạn, loại token **User Token**.
3. Thêm 3 quyền: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`.
4. Bấm **Generate Access Token**, đồng ý, và **tick đúng Page** của bạn khi được hỏi.
5. Sao chép token vừa tạo (hết hạn sau khoảng 1 giờ, không sao).

## Bước 4 — Ghi vào `.env` và đổi sang token dùng lâu
1. Chạy `cp .env.example .env`, mở `.env` và điền: `FB_APP_ID`, `FB_APP_SECRET`, `FB_USER_TOKEN` (token ở bước 3).
2. Chạy: `npm run fb:token`
   Script tự đổi sang token dài hạn, tìm Page của bạn và **tự ghi `FB_PAGE_ID`, `FB_PAGE_TOKEN` vào `.env`** (không in token ra màn hình).
   Nếu nick phụ quản lý nhiều Page, script sẽ liệt kê; bạn điền `FB_PAGE_ID=<id>` rồi chạy lại.
3. Xoá 3 dòng tạm `FB_APP_ID`, `FB_APP_SECRET`, `FB_USER_TOKEN` khỏi `.env`.

## Bước 5 — Kiểm tra
```
npm run fb:check
```
Nếu ổn sẽ thấy: tên Page, các video live gần đây, và "Đọc được comment". Nếu lỗi sẽ có câu tiếng Việt nói rõ lý do.

## Bước 6 — Chạy khi live
1. Đặt `APP_PASSWORD=<mật khẩu của bạn>` trong `.env` nếu chạy trên internet.
2. `npm start`, mở trang **Màn hình live**.
3. Bắt đầu live trên Page. Huy hiệu ở đầu trang chuyển sang xanh "Facebook: đang đọc live · N comment".
4. Mỗi buổi live mới: tạo mã mới (hoặc bấm "Buổi live mới" ở trang chính), phần mềm tự bắt live đang phát.
Muốn đọc một video cụ thể: `POST /api/facebook/live` với `{"videoId":"<id video>"}`.

## Khi gặp lỗi
| Dấu hiệu | Nguyên nhân thường gặp |
|---|---|
| "Token hết hạn hoặc không hợp lệ" | Lấy token mới (bước 3–4). Đổi mật khẩu Facebook hoặc gỡ quyền app cũng làm token mất hiệu lực. |
| "Thiếu quyền đọc comment" | Thiếu quyền `pages_read_engagement`/`pages_read_user_content`, hoặc nick phụ không còn quyền trên Page. |
| "Chưa thấy buổi live nào đang phát" | Chưa bấm phát live, hoặc token không thấy video live của Page. |
| Comment hiện nhưng tên là "Khách Facebook" | Facebook không trả tên người comment cho app của bạn. Phần mềm vẫn chạy nhưng mỗi comment tính là một khách riêng, nên không gom được đơn theo người. Cần cấp quyền đọc nội dung người dùng cho app (có thể phải qua App Review của Meta). |
| Không có comment nào dù khách đang comment | Tương tự: comment của người không có vai trò trong app có thể bị ẩn khi app ở chế độ Phát triển. Báo lại để xử lý. |

## Chưa được kiểm chứng
Phần code đã được test bằng một "Facebook giả". **Chưa thử với Facebook thật**, nên hai điểm cần xác nhận lần đầu chạy thật:
tên người comment có hiện không, và comment của khách (không có vai trò trong app) có đọc được không.
