import express from 'express';
import type { Response } from 'express';
import { openDb } from './db.ts';
import { createLive } from './live.ts';
import { LAYOUTS, DEFAULT_LAYOUT, labelSizeMm, renderLabelsHtml, renderBillsHtml } from './print.ts';
import { normalizeCode } from './codes.ts';

export function createApp(db = openDb()) {
  const app = express();
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

  // Buổi live mới: xoá hết mã, comment, đơn cũ
  app.post('/api/reset', (_req, res) => {
    db.reset();
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
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`Chạy tại http://localhost:${port}`));
}
