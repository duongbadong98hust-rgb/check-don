import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { pickFreeCodes, CAPACITY } from './codes.ts';

export interface CodeRow {
  code: string;
  price: number;
  qty: number; // số cái của mã này (đa số là 1)
  batch_id: number;
}

export interface BatchRow {
  id: number;
  price: number;
  count: number;
  created_at: string;
}

export function openDb(file = 'data/check-don.db') {
  if (file !== ':memory:') mkdirSync('data', { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price INTEGER NOT NULL,
      count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      price INTEGER NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      batch_id INTEGER NOT NULL REFERENCES batches(id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,            -- giờ comment (ms), dùng để xếp "ai trước"
      codes TEXT NOT NULL DEFAULT '', -- các mã bắt được, cách nhau bởi dấu cách
      fb_id TEXT                      -- ID comment trên Facebook (để không nhận trùng)
    );
    -- Một khách muốn một mã. state: waiting (đang chờ) | won (đã chốt) | dropped (bỏ/hủy)
    CREATE TABLE IF NOT EXISTS bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL REFERENCES codes(code) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      ts INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting',
      paid INTEGER NOT NULL DEFAULT 0,
      comment_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS bids_code ON bids(code, state, ts);
  `);
  // DB tạo từ bản cũ chưa có cột fb_id
  const cols = raw.prepare('PRAGMA table_info(comments)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'fb_id')) raw.exec('ALTER TABLE comments ADD COLUMN fb_id TEXT');
  raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS comments_fb ON comments(fb_id)');

  return {
    raw,

    usedCodes(): Set<string> {
      const rows = raw.prepare('SELECT code FROM codes').all() as { code: string }[];
      return new Set(rows.map((r) => r.code));
    },

    /** Tạo lô: `count` mã còn trống, cùng giá `price`, mỗi mã có `qty` cái. */
    createBatch(count: number, price: number, qty = 1): BatchRow & { codes: string[] } {
      const codes = pickFreeCodes(this.usedCodes(), count);
      if (codes.length < count) {
        throw new Error(`Chỉ còn ${codes.length} mã trống, không đủ ${count} mã`);
      }
      raw.exec('BEGIN');
      try {
        const info = raw.prepare('INSERT INTO batches (price, count) VALUES (?, ?)').run(price, count);
        const batchId = Number(info.lastInsertRowid);
        const ins = raw.prepare('INSERT INTO codes (code, price, qty, batch_id) VALUES (?, ?, ?, ?)');
        for (const c of codes) ins.run(c, price, qty, batchId);
        raw.exec('COMMIT');
        const batch = raw.prepare('SELECT * FROM batches WHERE id = ?').get(batchId) as unknown as BatchRow;
        return { ...batch, codes };
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },

    listCodes(batchId?: number): CodeRow[] {
      const stmt = raw.prepare(
        batchId ? 'SELECT * FROM codes WHERE batch_id = ? ORDER BY rowid' : 'SELECT * FROM codes ORDER BY rowid',
      );
      return (batchId ? stmt.all(batchId) : stmt.all()) as unknown as CodeRow[];
    },

    listBatches(): BatchRow[] {
      return raw.prepare('SELECT * FROM batches ORDER BY id DESC').all() as unknown as BatchRow[];
    },

    setPrice(code: string, price: number): boolean {
      return Number(raw.prepare('UPDATE codes SET price = ? WHERE code = ?').run(price, code).changes) > 0;
    },

    setQty(code: string, qty: number): boolean {
      return Number(raw.prepare('UPDATE codes SET qty = ? WHERE code = ?').run(qty, code).changes) > 0;
    },

    /** Bắt đầu buổi live mới: xoá toàn bộ mã, comment, đơn cũ. */
    reset() {
      raw.exec('DELETE FROM bids; DELETE FROM comments; DELETE FROM codes; DELETE FROM batches;');
    },

    stats() {
      const used = (raw.prepare('SELECT COUNT(*) AS n FROM codes').get() as { n: number }).n;
      return { capacity: CAPACITY, used, free: CAPACITY - used };
    },
  };
}

export type Db = ReturnType<typeof openDb>;
