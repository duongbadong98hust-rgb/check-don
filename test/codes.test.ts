import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CODES, CAPACITY, pickFreeCodes, normalizeCode, extractCodes } from '../src/codes.ts';
import { openDb } from '../src/db.ts';
import { createLive } from '../src/live.ts';
import { createApp } from '../src/server.ts';
import { renderLabelsHtml, renderBillsHtml } from '../src/print.ts';

test('mã: 1 chữ + 3 số (100-999), không có chữ I, O', () => {
  assert.equal(CAPACITY, 21600);
  for (const c of ALL_CODES) assert.match(c, /^[A-HJ-NP-Z][1-9]\d{2}$/);
  assert.equal(ALL_CODES[0], 'A100');
  assert.equal(ALL_CODES[899], 'A999');
  assert.equal(ALL_CODES[900], 'B100');
});

test('pickFreeCodes bỏ qua mã đã dùng', () => {
  assert.deepEqual(pickFreeCodes(new Set(['A100', 'A101']), 3), ['A102', 'A103', 'A104']);
});

test('normalizeCode', () => {
  assert.equal(normalizeCode('a 123'), 'A123');
  assert.equal(normalizeCode('O123'), null);
  assert.equal(normalizeCode('A12'), null);
  assert.equal(normalizeCode('A099'), null);
  assert.equal(normalizeCode('ok'), null);
});

test('extractCodes: bắt mã trong comment, bỏ qua chữ thường và mã lạ', () => {
  const known = new Set(['A123', 'B205', 'K705']);
  assert.deepEqual(extractCodes('chốt A123 nha', known), ['A123']);
  assert.deepEqual(extractCodes('a123', known), ['A123']);
  assert.deepEqual(extractCodes('lấy a 123 và B205, b205', known), ['A123', 'B205']);
  assert.deepEqual(extractCodes('A1234', known), []); // dính số khác
  assert.deepEqual(extractCodes('xA123', known), []); // dính chữ khác
  assert.deepEqual(extractCodes('ok shop ơi 150k', known), []);
  assert.deepEqual(extractCodes('Z999', known), []); // không có trong danh sách
});

test('tạo lô, không trùng mã giữa các lô, báo lỗi khi hết mã', () => {
  const db = openDb(':memory:');
  const a = db.createBatch(50, 49000);
  const b = db.createBatch(50, 9000);
  assert.equal(new Set([...a.codes, ...b.codes]).size, 100);
  assert.equal(db.stats().used, 100);
  assert.throws(() => db.createBatch(21600, 1000), /Chỉ còn 21500 mã/);
  assert.equal(db.stats().used, 100);
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

test('live: người comment sớm nhất dẫn đầu, chốt, hủy thì người kế lên', () => {
  const db = openDb(':memory:');
  db.createBatch(3, 49000); // A100, A101, A102
  let changes = 0;
  const live = createLive(db, () => changes++);

  live.addComment({ name: 'Mai', userId: 'u2', text: 'lấy A100', ts: 2000 });
  live.addComment({ name: 'Lan', userId: 'u1', text: 'chốt A100', ts: 1000 }); // đến sau nhưng giờ sớm hơn
  live.addComment({ name: 'Hoa', userId: 'u3', text: 'đẹp quá', ts: 3000 });
  assert.ok(changes >= 3);

  let board = live.board();
  assert.equal(board.length, 1);
  assert.equal(board[0].code, 'A100');
  assert.deepEqual(board[0].waiting.map((w) => w.name), ['Lan', 'Mai']);
  assert.equal(board[0].available, 1);

  live.win(board[0].waiting[0].bidId); // chốt Lan
  board = live.board();
  assert.deepEqual(board[0].won.map((w) => w.name), ['Lan']);
  assert.equal(board[0].available, 0);
  // hết hàng thì không chốt thêm cho Mai được
  assert.throws(() => live.win(board[0].waiting[0].bidId), /đã hết hàng/);

  live.drop(board[0].won[0].bidId); // Lan không chuyển khoản
  board = live.board();
  assert.equal(board[0].available, 1);
  assert.deepEqual(board[0].waiting.map((w) => w.name), ['Mai']); // Mai lên đầu
});

test('live: khách bấm trùng mã chỉ tính một lần; mã nhiều cái chốt được nhiều người; gom đơn', () => {
  const db = openDb(':memory:');
  db.createBatch(2, 10000, 1); // A100, A101
  db.setQty('A101', 2);
  db.setPrice('A101', 25000);
  const live = createLive(db);

  const r1 = live.addComment({ name: 'Lan', userId: 'u1', text: 'A100 A101', ts: 1 });
  const r2 = live.addComment({ name: 'Lan', userId: 'u1', text: 'A100 lại', ts: 2 });
  assert.deepEqual(r1.added, ['A100', 'A101']);
  assert.deepEqual(r2.added, []);
  live.addComment({ name: 'Mai', userId: 'u2', text: 'A101', ts: 3 });

  const board = live.board();
  const a101 = board.find((b) => b.code === 'A101')!;
  assert.equal(a101.available, 2);
  for (const w of a101.waiting) live.win(w.bidId); // chốt cả Lan và Mai
  live.win(board.find((b) => b.code === 'A100')!.waiting[0].bidId);

  const orders = live.orders();
  const lan = orders.find((o) => o.userId === 'u1')!;
  assert.deepEqual(lan.items.map((i) => i.code), ['A100', 'A101']);
  assert.equal(lan.total, 35000);
  assert.equal(lan.paid, false);
  live.setPaid('u1', true);
  assert.equal(live.orders().find((o) => o.userId === 'u1')!.paid, true);
  assert.equal(live.orders().find((o) => o.userId === 'u2')!.paid, false);

  const html = renderBillsHtml(live.orders());
  assert.equal((html.match(/class="bill"/g) ?? []).length, 2);
  assert.ok(html.includes('35.000đ'));
});

test('live: tên khách có HTML thì bill/tem được escape', () => {
  const db = openDb(':memory:');
  db.createBatch(1, 1000);
  const live = createLive(db);
  live.addComment({ name: '<img src=x onerror=alert(1)>', userId: 'x', text: 'A100' });
  live.win(live.board()[0].waiting[0].bidId);
  const html = renderBillsHtml(live.orders());
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('API: tạo lô, comment, chốt, validate', async () => {
  const app = createApp(openDb(':memory:'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (p: string, body: unknown, method = 'POST') =>
    fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/batches', { count: 0, price: 1000 })).status, 400);
    assert.equal((await post('/api/batches', { count: 5, price: -1 })).status, 400);
    assert.equal((await post('/api/batches', { count: 5, price: 9000, qty: 0 })).status, 400);
    assert.equal((await post('/api/batches', { count: 5, price: 9000 })).status, 201);
    assert.equal((await post('/api/codes/a100', { price: 59000 }, 'PATCH')).status, 200);
    assert.equal((await post('/api/batches', { count: 99999, price: 1 })).status, 409);

    assert.equal((await post('/api/live/comments', { name: '', text: 'x' })).status, 400);
    const cm = (await (await post('/api/live/comments', { name: 'Lan', text: 'chốt a100' })).json()) as { added: string[] };
    assert.deepEqual(cm.added, ['A100']);

    let st = (await (await fetch(base + '/api/live/state')).json()) as any;
    assert.equal(st.board[0].price, 59000);
    const bidId = st.board[0].waiting[0].bidId;
    assert.equal((await post(`/api/bids/${bidId}/win`, {})).status, 200);
    assert.equal((await post(`/api/bids/9999/win`, {})).status, 409);
    st = (await (await fetch(base + '/api/live/state')).json()) as any;
    assert.equal(st.orders[0].total, 59000);

    const bill = await (await fetch(base + '/bill')).text();
    assert.ok(bill.includes('59.000đ') && bill.includes('Lan'));
    assert.ok((await (await fetch(base + '/print?layout=2x4')).text()).includes('59.000đ'));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('SSE: báo update khi có comment mới', async () => {
  const app = createApp(openDb(':memory:'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ac = new AbortController();
  try {
    await fetch(base + '/api/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1, price: 1000 }) });
    const res = await fetch(base + '/api/live/stream', { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read(); // retry: 2000
    await fetch(base + '/api/live/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Lan', text: 'A100' }) });
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /data: update/);
  } finally {
    ac.abort();
    server.closeAllConnections();
    server.close();
  }
});
