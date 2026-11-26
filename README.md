# check-don — chốt đơn livestream quần áo

## Chạy thử
```
npm install
npm start        # http://localhost:3000   (đổi cổng: PORT=3111 npm start)
npm test
```
Cần Node.js ≥ 22.18 (chạy TypeScript trực tiếp, SQLite có sẵn, không cần build).

## Đã có
**Tạo mã + in tem** (`/`)
- Mã **1 chữ + 3 số** (A100…Z999), bỏ chữ I, O → **21.600 mã**.
- Tạo theo lô: "50 mã giá 49.000đ", tuỳ chọn số cái mỗi mã (mã có nhiều cái).
- In tem **A6** kèm giá: 6 / 8 / 10 / 15 / 18 tem mỗi tờ (mặc định 8).
- "Buổi live mới" xoá hết mã, comment, đơn cũ.

**Màn hình live** (`/live.html`)
- Comment hiện realtime (SSE), tự bắt mã trong comment (không phân biệt hoa/thường, chấp nhận "a 123").
- Nút **Chốt ngay dưới từng comment** (chốt đúng người đó, không cần họ dẫn đầu).
- Bảng mã: ai comment sớm nhất (theo giờ comment) dẫn đầu; bấm **Chốt**, **Bỏ**, hoặc **Hủy, chuyển người kế**.
- Đơn theo khách: gom các mã đã chốt, tổng tiền, đánh dấu **Đã CK**, **in bill A6**.
- Comment giả lập (ô nhập tay + nút tự chạy) để thử, hoặc **Facebook Live thật** nếu đã cấu hình.

**Facebook** (`docs/FACEBOOK.md`)
- Đọc comment live qua Graph API chính thức (chỉ đọc), tự tìm buổi live đang phát, không nhận trùng comment.
- `npm run fb:token` đổi token, `npm run fb:check` kiểm tra kết nối. Token cất trong `.env` (không lên GitHub).
- `APP_PASSWORD` trong `.env` để đặt mật khẩu cho trang web.
- ⚠ Mới test với Facebook giả, chưa thử với Facebook thật.

## API chính
- `POST /api/live/comments` `{name, text, userId?, ts?}` — cửa nhận comment; Facebook sẽ gọi vào đây.
- `POST /api/bids/:id/win|drop`, `POST /api/customers/:userId/paid`
- `GET /print?batch=&layout=2x4` (tem), `GET /bill?user=` (bill)

## Kế tiếp
- Thử với Facebook thật và chỉnh theo kết quả.
- Tuỳ chọn: bot nhắn Messenger xin thông tin giao hàng, đối chiếu chuyển khoản.
