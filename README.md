# check-don — chốt đơn livestream quần áo

## Chạy thử
```
npm install
npm start        # http://localhost:3000
npm test
```
Cần Node.js ≥ 22.18 (chạy TypeScript trực tiếp, SQLite có sẵn, không cần build).

## Đã có (giai đoạn 1a)
- Mã sản phẩm: **1 chữ + 1 số** (A1…Z9), bỏ chữ I, O và số 0 để khỏi đọc nhầm → **216 mã**.
- Tạo mã theo lô: "50 mã giá 49.000đ"; giá sửa riêng từng mã qua `PATCH /api/codes/:code`.
- In tem **A6 (105×148 mm)** kèm giá: 6 / 8 / 10 / 15 / 18 tem mỗi tờ (mặc định 8 tem, mỗi tem ≈ 48,5×35 mm).
- "Buổi live mới" xoá hết mã để dùng lại.

## Kế tiếp
1. Màn hình live realtime (comment giả lập) + bắt mã trong comment + người comment sớm nhất dẫn đầu.
2. Chốt / chuyển người kế tiếp, gom đơn theo khách, in bill.
3. Nối Facebook Live qua Graph API (chỉ đọc comment).
