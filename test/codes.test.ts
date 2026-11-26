import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CODES, CAPACITY, pickFreeCodes, normalizeCode } from '../src/codes.ts';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { renderLabelsHtml } from '../src/print.ts';

test('mã: 1 chữ + 1 số, không có I, O, 0', () => {
  assert.equal(CAPACITY, 216);
  for (const c of ALL_CODES) assert.match(c, /^[A-HJ-NP-Z][1-9]$/);
  assert.equal(ALL_CODES[0], 'A1');
  assert.equal(ALL_CODES[9], 'B1');
});

test('pickFreeCodes bỏ qua mã đã dùng', () => {
  assert.deepEqual(pickFreeCodes(new Set(['A1', 'A2']), 3), ['A3', 'A4', 'A5']);
});

test('normalizeCode', () => {
  assert.equal(normalizeCode('a 1'), 'A1');
  assert.equal(normalizeCode('O1'), null);
  assert.equal(normalizeCode('ok'), null);
  assert.equal(normalizeCode('A0'), null);
});

test('tạo lô, không trùng mã giữa các lô, báo lỗi khi hết mã', () => {
  const db = openDb(':memory:');
  const a = db.createBatch(50, 49000);
  const b = db.createBatch(50, 9000);
  assert.equal(new Set([...a.codes, ...b.codes]).size, 100);
  assert.equal(db.stats().used, 100);
  assert.throws(() => db.createBatch(200, 1000), /Chỉ còn 116 mã/);
  assert.equal(db.stats().used, 100); // lỗi thì không tạo gì
  db.reset();
  assert.equal(db.stats().used, 0);
});

test('trang in: 8 tem/tờ -> 50 mã = 7 tờ A6, có giá', () => {
  const db = openDb(':memory:');
  db.createBatch(50, 49000);
  const html = renderLabelsHtml(db.listCodes(), '2x4');
  assert.equal((html.match(/class="sheet"/g) ?? []).length, 7);
  assert.equal((html.match(/class="label"/g) ?? []).length, 50);
  assert.ok(html.includes('49.000đ'));
  assert.ok(html.includes('size: 105mm 148mm'));
});

test('API: tạo lô, sửa giá, validate', async () => {
  const app = createApp(openDb(':memory:'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (p: string, body: unknown, method = 'POST') =>
    fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/batches', { count: 0, price: 1000 })).status, 400);
    assert.equal((await post('/api/batches', { count: 5, price: -1 })).status, 400);
    const r = await post('/api/batches', { count: 5, price: 9000 });
    assert.equal(r.status, 201);
    assert.equal((await post('/api/codes/a1', { price: 59000 }, 'PATCH')).status, 200);
    const codes = (await (await fetch(base + '/api/codes')).json()) as { code: string; price: number }[];
    assert.equal(codes.find((c) => c.code === 'A1')!.price, 59000);
    assert.equal((await post('/api/batches', { count: 999, price: 1 })).status, 409);
    const page = await (await fetch(base + '/print?layout=2x4')).text();
    assert.ok(page.includes('59.000đ'));
  } finally {
    server.close();
  }
});
