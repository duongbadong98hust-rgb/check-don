import express from 'express';
import { openDb } from './db.ts';
import { LAYOUTS, DEFAULT_LAYOUT, labelSizeMm, renderLabelsHtml } from './print.ts';
import { normalizeCode } from './codes.ts';

export function createApp(db = openDb()) {
  const app = express();
  app.use(express.json());
  app.use(express.static('public'));

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

  // Tạo lô: { count: 50, price: 49000 }
  app.post('/api/batches', (req, res) => {
    const count = Number(req.body?.count);
    const price = Number(req.body?.price);
    if (!Number.isInteger(count) || count < 1) return res.status(400).json({ error: 'Số lượng mã phải là số nguyên ≥ 1' });
    if (!Number.isInteger(price) || price < 0) return res.status(400).json({ error: 'Giá phải là số nguyên ≥ 0' });
    try {
      res.status(201).json(db.createBatch(count, price));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  app.get('/api/codes', (req, res) => {
    const b = req.query.batch ? Number(req.query.batch) : undefined;
    res.json(db.listCodes(b));
  });

  // Sửa giá riêng từng mã: { price: 59000 }
  app.patch('/api/codes/:code', (req, res) => {
    const code = normalizeCode(req.params.code);
    const price = Number(req.body?.price);
    if (!code) return res.status(400).json({ error: 'Mã không hợp lệ' });
    if (!Number.isInteger(price) || price < 0) return res.status(400).json({ error: 'Giá không hợp lệ' });
    if (!db.setPrice(code, price)) return res.status(404).json({ error: 'Không có mã này' });
    res.json({ code, price });
  });

  // Buổi live mới: xoá hết mã cũ
  app.post('/api/reset', (_req, res) => {
    db.reset();
    res.json(db.stats());
  });

  // Trang in tem A6: /print?batch=1&layout=2x4  (bỏ batch = in tất cả)
  app.get('/print', (req, res) => {
    const b = req.query.batch ? Number(req.query.batch) : undefined;
    res.type('html').send(renderLabelsHtml(db.listCodes(b), String(req.query.layout ?? DEFAULT_LAYOUT)));
  });

  return app;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`Chạy tại http://localhost:${port}`));
}
