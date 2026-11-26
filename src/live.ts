import { extractCodes } from './codes.ts';
import type { Db } from './db.ts';

export interface CommentIn {
  userId?: string;
  name: string;
  text: string;
  ts?: number; // giờ comment (ms). Facebook sẽ cung cấp created_time.
}

interface BidRow {
  id: number;
  code: string;
  user_id: string;
  name: string;
  ts: number;
  state: 'waiting' | 'won' | 'dropped';
  paid: number;
}

export function createLive(db: Db, onChange: () => void = () => {}) {
  const raw = db.raw;

  const getBid = (id: number) => raw.prepare('SELECT * FROM bids WHERE id = ?').get(id) as unknown as BidRow | undefined;
  const wonCount = (code: string) =>
    (raw.prepare("SELECT COUNT(*) AS n FROM bids WHERE code = ? AND state = 'won'").get(code) as { n: number }).n;
  const qtyOf = (code: string) => (raw.prepare('SELECT qty FROM codes WHERE code = ?').get(code) as { qty: number }).qty;

  return {
    /**
     * Nhận một comment (từ Facebook, giả lập hoặc nhập tay).
     * Mỗi mã có trong danh sách tạo một "bid" xếp hàng theo giờ comment.
     */
    addComment(c: CommentIn) {
      const name = c.name.trim();
      const text = c.text.trim();
      if (!name || !text) throw new Error('Thiếu tên hoặc nội dung comment');
      const userId = c.userId?.trim() || 'name:' + name.toLowerCase();
      const ts = c.ts ?? Date.now();
      const codes = extractCodes(text, db.usedCodes());

      raw.exec('BEGIN');
      try {
        const info = raw
          .prepare('INSERT INTO comments (user_id, name, text, ts, codes) VALUES (?, ?, ?, ?, ?)')
          .run(userId, name, text, ts, codes.join(' '));
        const commentId = Number(info.lastInsertRowid);
        const added: string[] = [];
        for (const code of codes) {
          // Một khách bấm cùng mã nhiều lần thì chỉ tính một lần (trừ khi đã bị bỏ trước đó).
          const dup = raw
            .prepare("SELECT 1 FROM bids WHERE code = ? AND user_id = ? AND state != 'dropped'")
            .get(code, userId);
          if (dup) continue;
          raw
            .prepare('INSERT INTO bids (code, user_id, name, ts, comment_id) VALUES (?, ?, ?, ?, ?)')
            .run(code, userId, name, ts, commentId);
          added.push(code);
        }
        raw.exec('COMMIT');
        onChange();
        return { commentId, codes, added };
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },

    /** Chốt cho khách này (còn hàng mới chốt được). */
    win(bidId: number) {
      const b = getBid(bidId);
      if (!b) throw new Error('Không có lượt đặt này');
      if (b.state === 'won') return;
      if (wonCount(b.code) >= qtyOf(b.code)) throw new Error(`Mã ${b.code} đã hết hàng, hãy hủy người đang giữ trước`);
      raw.prepare("UPDATE bids SET state = 'won' WHERE id = ?").run(bidId);
      onChange();
    },

    /** Bỏ lượt này: khách hủy, không chuyển khoản, hoặc bạn từ chối. Người kế tiếp tự lên đầu. */
    drop(bidId: number) {
      if (!getBid(bidId)) throw new Error('Không có lượt đặt này');
      raw.prepare("UPDATE bids SET state = 'dropped', paid = 0 WHERE id = ?").run(bidId);
      onChange();
    },

    /** Đánh dấu khách đã chuyển khoản (tất cả mã đang giữ của khách). */
    setPaid(userId: string, paid: boolean) {
      raw.prepare("UPDATE bids SET paid = ? WHERE user_id = ? AND state = 'won'").run(paid ? 1 : 0, userId);
      onChange();
    },

    comments(limit = 200) {
      const rows = raw.prepare('SELECT * FROM comments ORDER BY id DESC LIMIT ?').all(limit) as unknown as {
        id: number; user_id: string; name: string; text: string; ts: number; codes: string;
      }[];
      return rows.reverse().map((r) => ({
        id: r.id, userId: r.user_id, name: r.name, text: r.text, ts: r.ts,
        codes: r.codes ? r.codes.split(' ') : [],
      }));
    },

    /** Bảng mã đang có người đặt: ai đang giữ, ai đang xếp hàng (người comment sớm nhất lên đầu). */
    board() {
      const codes = raw
        .prepare(
          `SELECT c.code, c.price, c.qty FROM codes c
           WHERE EXISTS (SELECT 1 FROM bids b WHERE b.code = c.code AND b.state != 'dropped')
           ORDER BY (SELECT MIN(ts) FROM bids b WHERE b.code = c.code AND b.state != 'dropped')`,
        )
        .all() as unknown as { code: string; price: number; qty: number }[];
      const bidsStmt = raw.prepare("SELECT * FROM bids WHERE code = ? AND state != 'dropped' ORDER BY ts, id");
      return codes.map((c) => {
        const bids = bidsStmt.all(c.code) as unknown as BidRow[];
        const won = bids.filter((b) => b.state === 'won');
        const waiting = bids.filter((b) => b.state === 'waiting');
        const map = (b: BidRow) => ({ bidId: b.id, userId: b.user_id, name: b.name, ts: b.ts, paid: !!b.paid });
        return {
          code: c.code, price: c.price, qty: c.qty,
          available: c.qty - won.length,
          won: won.map(map),
          waiting: waiting.map(map),
        };
      });
    },

    /** Đơn theo khách: gom các mã đã chốt của cùng một người. */
    orders() {
      const rows = raw
        .prepare(
          `SELECT b.id AS bid_id, b.user_id, b.name, b.code, b.paid, b.ts, c.price
           FROM bids b JOIN codes c ON c.code = b.code
           WHERE b.state = 'won' ORDER BY b.ts, b.id`,
        )
        .all() as unknown as { bid_id: number; user_id: string; name: string; code: string; paid: number; ts: number; price: number }[];
      const by = new Map<string, { userId: string; name: string; items: { bidId: number; code: string; price: number; paid: boolean }[]; total: number; paid: boolean }>();
      for (const r of rows) {
        let o = by.get(r.user_id);
        if (!o) by.set(r.user_id, (o = { userId: r.user_id, name: r.name, items: [], total: 0, paid: true }));
        o.items.push({ bidId: r.bid_id, code: r.code, price: r.price, paid: !!r.paid });
        o.total += r.price;
        if (!r.paid) o.paid = false;
      }
      return [...by.values()];
    },
  };
}

export type Live = ReturnType<typeof createLive>;
