import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { createFacebookReader, exchangeLongLivedUserToken, listPages, explainError, GraphError } from '../src/facebook.ts';
import type { FetchLike } from '../src/facebook.ts';
import { fbConfigFromEnv, setEnvVar } from '../src/config.ts';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'SECRET_PAGE_TOKEN_123';
const cfg = { pageId: 'PAGE1', token: TOKEN, version: 'v23.0', pollMs: 1000 };

/** Facebook giả: trả lời theo đường dẫn, ghi lại các URL đã gọi. */
function fakeFb(handler: (path: string, q: URLSearchParams) => { status?: number; body: unknown }) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const r = handler(u.pathname.replace(/^\/v[\d.]+\//, ''), u.searchParams);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  };
  return { fetchImpl, calls };
}

const liveList = { data: [{ id: 'V1', status: 'LIVE_NOW', title: 'Live quần áo' }] };

test('đọc comment live: bắt mã, bỏ comment của Page, không nhận trùng, tiếp tục từ con trỏ', async () => {
  const db = openDb(':memory:');
  db.createBatch(3, 49000); // A100..A102
  let round = 0;
  const { fetchImpl, calls } = fakeFb((path, q) => {
    if (path === 'PAGE1/live_videos') return { body: liveList };
    if (path === 'V1/comments') {
      round++;
      if (round === 1) {
        assert.equal(q.get('after'), null);
        return { body: { data: [
          { id: 'c0', message: 'Chào cả nhà', created_time: '2026-11-26T12:00:00+0000', from: { id: 'PAGE1', name: 'Shop' } },
          { id: 'c1', message: 'chốt A100 nha', created_time: '2026-11-26T12:00:05+0000', from: { id: 'U1', name: 'Lan' } },
        ], paging: { cursors: { after: 'CUR1' } } } };
      }
      if (round === 2) {
        assert.equal(q.get('after'), 'CUR1'); // chỉ hỏi phần mới
        return { body: { data: [
          { id: 'c1', message: 'chốt A100 nha', created_time: '2026-11-26T12:00:05+0000', from: { id: 'U1', name: 'Lan' } }, // trùng
          { id: 'c2', message: 'lấy A100', created_time: '2026-11-26T12:00:01+0000', from: { id: 'U2', name: 'Mai' } },
        ], paging: { cursors: { after: 'CUR2' } } } };
      }
      return { body: { data: [] } };
    }
    throw new Error('đường dẫn lạ: ' + path);
  });
  const app = createApp(db, { fbConfig: cfg, fetchImpl });
  const fb = app.locals.fb;
  await fb.pollOnce();
  await fb.pollOnce();
  await fb.pollOnce();

  const cms = (app.locals.fb && db.raw.prepare('SELECT name FROM comments ORDER BY id').all()) as { name: string }[];
  assert.deepEqual(cms.map((c) => c.name), ['Lan', 'Mai']); // không có "Shop", không trùng Lan
  const board = (await import('../src/live.ts')).createLive(db).board();
  assert.deepEqual(board[0].waiting.map((w) => w.name), ['Mai', 'Lan']); // Mai comment sớm hơn theo giờ Facebook
  const st = fb.status();
  assert.equal(st.state, 'connected');
  assert.equal(st.liveVideoId, 'V1');
  assert.equal(st.comments, 2); // chỉ đếm comment mới (Lan, Mai), không đếm trùng hay comment của Page
  assert.ok(calls.every((c) => c.includes('access_token=' + TOKEN)));
});

test('không tìm thấy live: báo đang tìm; live kết thúc: quay lại tìm', async () => {
  let live = true;
  const { fetchImpl } = fakeFb((path) => {
    if (path === 'PAGE1/live_videos') return { body: live ? liveList : { data: [{ id: 'V1', status: 'VOD' }] } };
    return { body: { data: [] } };
  });
  const r = createFacebookReader({ config: cfg, fetchImpl, onComment: () => {} });
  await r.pollOnce();
  assert.equal(r.status().state, 'connected');
  live = false;
  for (let i = 0; i < 10; i++) await r.pollOnce(); // lần thứ 10 kiểm tra lại live
  assert.equal(r.status().state, 'searching');
  assert.equal(r.status().liveVideoId, null);
});

test('lỗi token (190): dừng, báo tiếng Việt, không lộ token', async () => {
  const { fetchImpl } = fakeFb(() => ({
    status: 400,
    body: { error: { code: 190, message: `Invalid OAuth access token ${TOKEN}` } },
  }));
  const app = createApp(openDb(':memory:'), { fbConfig: cfg, fetchImpl });
  await app.locals.fb.pollOnce();
  const st = app.locals.fb.status();
  assert.equal(st.state, 'error');
  assert.match(st.message, /Token hết hạn/);
  assert.ok(!JSON.stringify(st).includes(TOKEN));

  const server = app.listen(0);
  try {
    const j = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/facebook/status`)).text();
    assert.ok(!j.includes(TOKEN));
  } finally { server.closeAllConnections(); server.close(); }
});

test('lỗi mạng/giới hạn tốc độ: không lộ token, thử lại sau', async () => {
  const e1 = explainError(new GraphError('x', 4));
  assert.equal(e1.slow, true);
  assert.equal(e1.fatal, false);
  const fetchImpl: FetchLike = async () => { throw new Error(`connect ECONNREFUSED ${TOKEN}`); };
  const r = createFacebookReader({ config: cfg, fetchImpl, onComment: () => {} });
  await r.pollOnce();
  assert.equal(r.status().state, 'error');
  assert.ok(!r.status().message.includes(TOKEN));
});

test('Facebook không trả tên người comment: mỗi comment là một khách riêng, không sập', async () => {
  const db = openDb(':memory:');
  db.createBatch(1, 1000);
  const { fetchImpl } = fakeFb((path) =>
    path === 'PAGE1/live_videos' ? { body: liveList }
      : { body: { data: [{ id: 'cx', message: 'A100', created_time: '2026-11-26T12:00:00+0000' }] } });
  const app = createApp(db, { fbConfig: cfg, fetchImpl });
  await app.locals.fb.pollOnce();
  const row = db.raw.prepare('SELECT user_id, name FROM comments').get() as { user_id: string; name: string };
  assert.equal(row.user_id, 'fbc:cx');
  assert.equal(row.name, 'Khách Facebook');
});

test('API: attach video cụ thể, trạng thái, reset', async () => {
  const { fetchImpl } = fakeFb((path) => {
    if (path === 'V9') return { body: { id: 'V9', title: 'Live thử' } };
    return { body: { data: [] } };
  });
  const app = createApp(openDb(':memory:'), { fbConfig: cfg, fetchImpl });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const r = await fetch(base + '/api/facebook/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: 'V9' }) });
    const st = (await r.json()) as { liveVideoId: string; liveTitle: string };
    assert.equal(st.liveVideoId, 'V9');
    assert.equal(st.liveTitle, 'Live thử');
    app.locals.fb.stop();
    await fetch(base + '/api/reset', { method: 'POST' });
    assert.equal(app.locals.fb.status().liveVideoId, null);
  } finally { app.locals.fb.stop(); server.closeAllConnections(); server.close(); }
});

test('chưa cấu hình Facebook: status báo rõ, attach bị từ chối', async () => {
  const app = createApp(openDb(':memory:'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const st = (await (await fetch(base + '/api/facebook/status')).json()) as { configured: boolean };
    assert.equal(st.configured, false);
    const r = await fetch(base + '/api/facebook/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 409);
  } finally { server.closeAllConnections(); server.close(); }
});

test('mật khẩu bảo vệ: sai/thiếu bị chặn, đúng vào được', async () => {
  const app = createApp(openDb(':memory:'), { password: 'mk-bi-mat' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = (p: string) => ({ headers: { Authorization: 'Basic ' + Buffer.from('bat-ky:' + p).toString('base64') } });
  try {
    assert.equal((await fetch(base + '/api/stats')).status, 401);
    assert.equal((await fetch(base + '/api/stats', auth('sai'))).status, 401);
    assert.equal((await fetch(base + '/api/stats', auth('mk-bi-mat'))).status, 200);
    assert.equal((await fetch(base + '/live.html')).status, 401);
  } finally { server.closeAllConnections(); server.close(); }
});

test('lấy token dài hạn và danh sách Page; không lộ secret khi lỗi', async () => {
  const { fetchImpl } = fakeFb((path, q) => {
    if (path === 'oauth/access_token') {
      assert.equal(q.get('grant_type'), 'fb_exchange_token');
      assert.equal(q.get('fb_exchange_token'), 'SHORT');
      return { body: { access_token: 'LONGUSER' } };
    }
    if (path === 'me/accounts') {
      assert.equal(q.get('access_token'), 'LONGUSER');
      return { body: { data: [{ id: 'P1', name: 'Shop A', access_token: 'PTOKEN' }] } };
    }
    throw new Error('lạ');
  });
  const long = await exchangeLongLivedUserToken({ version: 'v23.0', appId: 'APP', appSecret: 'APPSECRET', shortToken: 'SHORT', fetchImpl });
  assert.equal(long, 'LONGUSER');
  assert.deepEqual(await listPages({ version: 'v23.0', userToken: long, fetchImpl }), [{ id: 'P1', name: 'Shop A', token: 'PTOKEN' }]);

  const bad: FetchLike = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 1, message: 'lỗi APPSECRET và SHORT' } }) });
  await assert.rejects(
    exchangeLongLivedUserToken({ version: 'v23.0', appId: 'APP', appSecret: 'APPSECRET', shortToken: 'SHORT', fetchImpl: bad }),
    (e: Error) => !e.message.includes('APPSECRET') && !e.message.includes('SHORT'),
  );
});

test('config: đọc biến môi trường; ghi .env giữ dòng khác, quyền riêng tư', () => {
  assert.equal(fbConfigFromEnv({}), null);
  assert.equal(fbConfigFromEnv({ FB_PAGE_ID: '1' }), null);
  const c = fbConfigFromEnv({ FB_PAGE_ID: ' 1 ', FB_PAGE_TOKEN: 't', FB_POLL_MS: '50' })!;
  assert.equal(c.pageId, '1');
  assert.equal(c.pollMs, 2000); // quá nhanh thì dùng mặc định
  assert.equal(c.version, 'v23.0');

  const f = join(mkdtempSync(join(tmpdir(), 'env-')), '.env');
  setEnvVar(f, 'A', '1');
  setEnvVar(f, 'B', '2');
  setEnvVar(f, 'A', '3');
  assert.equal(readFileSync(f, 'utf8'), 'A=3\nB=2\n');
  assert.equal(statSync(f).mode & 0o077, 0); // chỉ chủ file đọc được
});
