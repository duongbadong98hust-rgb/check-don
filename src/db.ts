import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { pickFreeCodes, CAPACITY } from './codes.ts';

export interface CodeRow {
  code: string;
  price: number;
  status: string; // 'free' | 'held' | 'sold' (dùng ở bước live)
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
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price INTEGER NOT NULL,
      count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'free',
      batch_id INTEGER NOT NULL REFERENCES batches(id)
    );
  `);

  return {
    usedCodes(): Set<string> {
      const rows = db.prepare('SELECT code FROM codes').all() as { code: string }[];
      return new Set(rows.map((r) => r.code));
    },

    /** Tạo lô: `count` mã còn trống, cùng giá `price`. */
    createBatch(count: number, price: number): BatchRow & { codes: string[] } {
      const codes = pickFreeCodes(this.usedCodes(), count);
      if (codes.length < count) {
        throw new Error(`Chỉ còn ${codes.length} mã trống, không đủ ${count} mã`);
      }
      db.exec('BEGIN');
      try {
        const info = db
          .prepare('INSERT INTO batches (price, count) VALUES (?, ?)')
          .run(price, count);
        const batchId = Number(info.lastInsertRowid);
        const ins = db.prepare('INSERT INTO codes (code, price, batch_id) VALUES (?, ?, ?)');
        for (const c of codes) ins.run(c, price, batchId);
        db.exec('COMMIT');
        const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId) as unknown as BatchRow;
        return { ...batch, codes };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    listCodes(batchId?: number): CodeRow[] {
      const sql = batchId
        ? 'SELECT * FROM codes WHERE batch_id = ? ORDER BY rowid'
        : 'SELECT * FROM codes ORDER BY rowid';
      const stmt = db.prepare(sql);
      return (batchId ? stmt.all(batchId) : stmt.all()) as unknown as CodeRow[];
    },

    listBatches(): BatchRow[] {
      return db.prepare('SELECT * FROM batches ORDER BY id DESC').all() as unknown as BatchRow[];
    },

    setPrice(code: string, price: number): boolean {
      const r = db.prepare('UPDATE codes SET price = ? WHERE code = ?').run(price, code);
      return Number(r.changes) > 0;
    },

    /** Bắt đầu buổi live mới: xoá toàn bộ mã cũ để dùng lại. */
    reset() {
      db.exec('DELETE FROM codes; DELETE FROM batches;');
    },

    stats() {
      const used = (db.prepare('SELECT COUNT(*) AS n FROM codes').get() as { n: number }).n;
      return { capacity: CAPACITY, used, free: CAPACITY - used };
    },
  };
}

export type Db = ReturnType<typeof openDb>;
