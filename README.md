# Check đơn

App kiểm đóng hàng chạy trên điện thoại: quét tem Shopee/SPX (đọc mã QR ra mã vận đơn, đọc tên khách dưới chữ "Đến:"), chụp ảnh hàng, in tên khách + mã vận đơn + giờ đóng lên ảnh, lưu lên Supabase, tra cứu lại theo tên hoặc mã.

- Web tĩnh (GitHub Pages), không cần build. Dữ liệu và ảnh: Supabase gói miễn phí.
- Ảnh nén ≤100KB, giữ 90 ngày rồi tự xoá. Khi kho ảnh vượt 950MB, app tự xoá đơn cũ nhất xuống dưới 900MB và hiện cảnh báo.
- Cài đặt cơ sở dữ liệu: mở `setup.html` (hoặc chạy `setup.sql` trong Supabase SQL Editor).
- Điền `config.js`: SUPABASE_URL, SUPABASE_ANON_KEY (khoá public/publishable, an toàn khi để công khai vì dữ liệu được khoá bằng đăng nhập), LOGIN_EMAIL.
