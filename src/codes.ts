// Mã sản phẩm = 1 chữ + 1 số (ví dụ A1, K7).
// Bỏ chữ I, O và số 0 để tránh đọc nhầm với 1, 0 khi đọc to trên live.
export const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split(''); // 24 chữ (không I, O)
export const DIGITS = '123456789'.split(''); // 9 số (không 0)

/** Toàn bộ mã có thể tạo, theo thứ tự A1..A9, B1..B9, ... */
export const ALL_CODES: string[] = LETTERS.flatMap((l) => DIGITS.map((d) => l + d));

export const CAPACITY = ALL_CODES.length; // 216

/** Lấy `count` mã còn trống đầu tiên (bỏ qua mã đã dùng). */
export function pickFreeCodes(used: Set<string>, count: number): string[] {
  const out: string[] = [];
  for (const c of ALL_CODES) {
    if (out.length >= count) break;
    if (!used.has(c)) out.push(c);
  }
  return out;
}

/** Chuẩn hoá mã người dùng gõ: "a 1", "A1" -> "A1". Trả về null nếu không hợp lệ. */
export function normalizeCode(raw: string): string | null {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  return ALL_CODES.includes(s) ? s : null;
}

export function formatPrice(vnd: number): string {
  return new Intl.NumberFormat('vi-VN').format(vnd) + 'đ';
}
