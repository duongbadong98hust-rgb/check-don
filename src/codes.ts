// Mã sản phẩm = 1 chữ + 3 số (ví dụ A123, K705).
// Chữ bỏ I, O để khỏi nhầm với 1, 0 khi đọc to. Số từ 100 đến 999 (luôn đủ 3 chữ số).
export const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split(''); // 24 chữ (không I, O)
export const NUM_MIN = 100;
export const NUM_MAX = 999;

/** Toàn bộ mã có thể tạo, theo thứ tự A100..A999, B100..B999, ... */
export const ALL_CODES: string[] = LETTERS.flatMap((l) =>
  Array.from({ length: NUM_MAX - NUM_MIN + 1 }, (_, i) => l + (NUM_MIN + i)),
);
const ALL_SET = new Set(ALL_CODES);

export const CAPACITY = ALL_CODES.length; // 21.600

/** Lấy `count` mã còn trống đầu tiên (bỏ qua mã đã dùng). */
export function pickFreeCodes(used: Set<string>, count: number): string[] {
  const out: string[] = [];
  for (const c of ALL_CODES) {
    if (out.length >= count) break;
    if (!used.has(c)) out.push(c);
  }
  return out;
}

/** Chuẩn hoá mã người dùng gõ: "a 123", "A123" -> "A123". Trả về null nếu không hợp lệ. */
export function normalizeCode(raw: string): string | null {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  return ALL_SET.has(s) ? s : null;
}

// Chữ + (tối đa 1 dấu cách) + 3 số, không dính vào chữ/số khác ("A1234" không tính, "xA123" không tính).
const CODE_RE = /(?<![A-Za-z0-9])([A-HJ-NP-Za-hj-np-z])[ ]?([1-9][0-9]{2})(?![0-9])/g;

/** Tìm các mã trong một comment, chỉ giữ mã có trong `known`. Không trùng, giữ thứ tự xuất hiện. */
export function extractCodes(text: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CODE_RE)) {
    const code = (m[1] + m[2]).toUpperCase();
    if (known.has(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

export function formatPrice(vnd: number): string {
  return new Intl.NumberFormat('vi-VN').format(vnd) + 'đ';
}
