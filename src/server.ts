import express from 'express';
import type { Response } from 'express';
import { openDb } from './db.ts';
import { createLive } from './live.ts';
import { LAYOUTS, DEFAULT_LAYOUT, labelSizeMm, renderLabelsHtml, renderBillsHtml } from './print.ts';
import { normalizeCode } from './codes.ts';
import { createFacebookReader } from './facebook.ts';
import type { FbConfig, FetchLike } from './facebook.ts';
import { fbConfigFromEnv, loadEnv } from './config.ts';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface AppOptions {
  fbConfig?: FbConfig | null;
  fetchImpl?: FetchLike; // dùng cho test (Facebook giả)
  password?: string; // nếu có: bắt buộc nhập mật khẩu để vào web
}

const sha = (s: string) => createHash('sha256').update(s).digest();

export function createApp(db = openDb(), opts: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Mật khẩu bảo vệ (HTTP Basic): tên đăng nhập gõ gì cũng được, chỉ cần đúng mật khẩu.
  if (opts.password) {
    const want = sha(opts.password);
    app.use((req, res, next) => {
      const [scheme, b64] = (req.headers.authorization ?? '').split(' ');
      if (scheme === 'Basic' && b64) {
        const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
        if (timingSafeEqual(sha(pass), want)) return next();
      }
      res.set('WWW-Authenticate', 'Basic realm="check-don"').status(401).send('Cần mật khẩu');
    });
  }

  app.use(express.json());
  app.use(express.static('public'));

  // Realtime: mỗi khi có thay đổi, báo cho mọi màn hình đang mở để tải lại trạng thái.
  const clients = new Set<Response>();
  const live = createLive(db, () => {
    for (const r of clients) r.write('data: update\n\n');
  });

  app.get('/api/live/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  });

  // Facebook: đọc comment live thật, đẩy vào cùng cửa nhận comment với bản giả lập.
  const fb = opts.fbConfig
    ? createFacebookReader({ config: opts.fbConfig, fetchImpl: opts.fetchImpl, onComment: (c) => live.addComment(c) !== null })
    : null;
  app.locals.fb = fb;

  const bad = (res: Response, e: unknown, status = 400) => res.status(status).json({ error: (e as Error).message });

  app.get('/api/stats', (_req, res) => res.json(db.stats()));

  app.get('/api/layouts', (_req, res) => {
    res.json(
      Object.entries(LAYOUTS).map(([key, l]) => {
        const s = labelSizeMm(l);
        return { key, perPage: l.cols * l.rows, widthMm: +s.w.toFixed(1), heightMm: +s.h.toFixed(1), default: key === DEFAULT_LAYOUT };
      }),
    );
  });

  app.get('/api/batches', (_req, res) => res.json(db.listBatches()));

  // Tạo lô: { count: 50, price: 49000, qty?: 1 }
  app.post('/api/batches', (req, res) => {
    const count = Number(req.body?.count);
    const price = Number(req.body?.price);
    const qty = req.body?.qty === undefined ? 1 : Number(req.body.qty);
    if (!Number.isInteger(count) || count < 1) return bad(res, new Error('Số lượng mã phải là số nguyên ≥ 1'));
    if (!Number.isInteger(price) || price < 0) return bad(res, new Error('Giá phải là số nguyên ≥ 0'));
    if (!Number.isInteger(qty) || qty < 1) return bad(res, new Error('Số cái mỗi mã phải là số nguyên ≥ 1'));
    try {
      res.status(201).json(db.createBatch(count, price, qty));
    } catch (e) {
      bad(res, e, 409);
    }
  });

  app.get('/api/codes', (req, res) => {
    const b = req.query.batch ? Number(req.query.batch) : undefined;
    res.json(db.listCodes(b));
  });

  // Sửa giá / số cái của một mã: { price?: 59000, qty?: 3 }
  app.patch('/api/codes/:code', (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return bad(res, new Error('Mã không hợp lệ'));
    const { price, qty } = req.body ?? {};
    if (price !== undefined && (!Number.isInteger(price) || price < 0)) return bad(res, new Error('Giá không hợp lệ'));
    if (qty !== undefined && (!Number.isInteger(qty) || qty < 1)) return bad(res, new Error('Số cái không hợp lệ'));
    if (price !== undefined && !db.setPrice(code, price)) return bad(res, new Error('Không có mã này'), 404);
    if (qty !== undefined && !db.setQty(code, qty)) return bad(res, new Error('Không có mã này'), 404);
    res.json({ code, price, qty });
  });

  app.get('/api/facebook/status', (_req, res) => {
    res.json(
      fb
        ? fb.status()
        : { configured: false, state: 'off', liveVideoId: null, liveTitle: null, comments: 0, lastCommentAt: null,
            message: 'Chưa nối Facebook (xem docs/FACEBOOK.md). Đang dùng comment giả lập.' },
    );
  });

  // Đọc một video live cụ thể: { videoId } ; bỏ trống = quay lại tự tìm live đang phát
  app.post('/api/facebook/live', async (req, res) => {
    if (!fb) return bad(res, new Error('Chưa cấu hình Facebook'), 409);
    try {
      const id = String(req.body?.videoId ?? '').trim();
      if (id) await fb.attach(id);
      else fb.auto();
      fb.start();
      res.json(fb.status());
    } catch (e) {
      bad(res, e);
    }
  });

  // Buổi live mới: xoá hết mã, comment, đơn cũ
  app.post('/api/reset', (_req, res) => {
    db.reset();
    fb?.reset();
    for (const r of clients) r.write('data: update\n\n');
    res.json(db.stats());
  });

  // ---- Live ----
  // Nguồn comment: giả lập / nhập tay (sau này Facebook cũng gọi vào đây): { name, text, userId?, ts? }
  app.post('/api/live/comments', (req, res) => {
    try {
      res.status(201).json(live.addComment(req.body ?? {}));
    } catch (e) {
      bad(res, e);
    }
  });

  app.get('/api/live/state', (_req, res) => {
    res.json({ comments: live.comments(), board: live.board(), orders: live.orders(), stats: db.stats() });
  });

  const act = (fn: (id: number) => void) => (req: express.Request, res: Response) => {
    try {
      fn(Number(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      bad(res, e, 409);
    }
  };
  app.post('/api/bids/:id/win', act((id) => live.win(id)));
  app.post('/api/bids/:id/drop', act((id) => live.drop(id)));

  // Khách đã / chưa chuyển khoản: { paid: true }
  app.post('/api/customers/:userId/paid', (req, res) => {
    live.setPaid(req.params.userId, req.body?.paid !== false);
    res.json({ ok: true });
  });

  // Trang in tem A6: /print?batch=1&layout=2x4  (bỏ batch = in tất cả)
  app.get('/print', (req, res) => {
    const b = req.query.batch ? Number(req.query.batch) : undefined;
    res.type('html').send(renderLabelsHtml(db.listCodes(b), String(req.query.layout ?? DEFAULT_LAYOUT)));
  });

  // Bill A6: /bill (tất cả khách) hoặc /bill?user=<id> (một khách)
  app.get('/bill', (req, res) => {
    const user = req.query.user ? String(req.query.user) : undefined;
    const orders = live.orders().filter((o) => !user || o.userId === user);
    res.type('html').send(renderBillsHtml(orders));
  });

  return app;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  loadEnv();
  const port = Number(process.env.PORT ?? 3000);
  const password = process.env.APP_PASSWORD || undefined;
  const app = createApp(openDb(), { fbConfig: fbConfigFromEnv(), password });
  app.listen(port, () => {
    console.log(`Chạy tại http://localhost:${port}`);
    console.log(app.locals.fb ? 'Facebook: đã cấu hình, đang tìm buổi live…' : 'Facebook: chưa cấu hình (dùng comment giả lập)');
    if (!password) console.log('Cảnh báo: chưa đặt APP_PASSWORD, ai mở được địa chỉ này đều dùng được.');
    app.locals.fb?.start();
  });
}
