import { formatPrice } from './codes.ts';
import type { CodeRow } from './db.ts';

// Khổ A6 = 105 x 148 mm. Chừa lề 4mm mỗi cạnh -> vùng in 97 x 140 mm.
export const A6 = { w: 105, h: 148, margin: 4 };

export const LAYOUTS: Record<string, { cols: number; rows: number }> = {
  '2x3': { cols: 2, rows: 3 }, //  6 tem / tờ (≈ 48 x 46 mm)
  '2x4': { cols: 2, rows: 4 }, //  8 tem / tờ (≈ 48 x 35 mm)
  '2x5': { cols: 2, rows: 5 }, // 10 tem / tờ (≈ 48 x 28 mm)
  '3x5': { cols: 3, rows: 5 }, // 15 tem / tờ (≈ 32 x 28 mm)
  '3x6': { cols: 3, rows: 6 }, // 18 tem / tờ (≈ 32 x 23 mm)
};
export const DEFAULT_LAYOUT = '2x4';

export function labelSizeMm(layout: { cols: number; rows: number }) {
  return {
    w: (A6.w - 2 * A6.margin) / layout.cols,
    h: (A6.h - 2 * A6.margin) / layout.rows,
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderLabelsHtml(codes: CodeRow[], layoutKey: string): string {
  const layout = LAYOUTS[layoutKey] ?? LAYOUTS[DEFAULT_LAYOUT];
  const perPage = layout.cols * layout.rows;
  const size = labelSizeMm(layout);
  // Mã 4 ký tự (A123) phải vừa chiều ngang tem: mỗi ký tự rộng ≈ 0.72 lần cỡ chữ.
  const codeFont = Math.min(size.h * 0.5, (size.w * 0.9) / 3.1);
  const priceFont = Math.min(size.h * 0.22, size.w * 0.17);

  const pages: CodeRow[][] = [];
  for (let i = 0; i < codes.length; i += perPage) pages.push(codes.slice(i, i + perPage));

  const sheets = pages
    .map((page) => {
      const cells = page
        .map(
          (c) =>
            `<div class="label"><div class="code">${esc(c.code)}</div><div class="price">${esc(formatPrice(c.price))}</div></div>`,
        )
        .join('');
      return `<section class="sheet">${cells}</section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<title>Tem A6 - ${codes.length} mã</title>
<style>
  @page { size: 105mm 148mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #ddd; font-family: Arial, Helvetica, sans-serif; }
  .sheet {
    width: ${A6.w}mm; height: ${A6.h}mm; padding: ${A6.margin}mm; background: #fff;
    display: grid; grid-template-columns: repeat(${layout.cols}, 1fr);
    grid-template-rows: repeat(${layout.rows}, 1fr);
    page-break-after: always; break-after: page; margin: 0 auto 8px;
  }
  .label {
    border: 0.2mm dashed #888; display: flex; flex-direction: column;
    align-items: center; justify-content: center; line-height: 1; overflow: hidden;
  }
  .code { font-size: ${codeFont.toFixed(1)}mm; font-weight: 800; letter-spacing: 0.2mm; white-space: nowrap; }
  .price { font-size: ${priceFont.toFixed(1)}mm; font-weight: 700; margin-top: 1mm; }
  @media print {
    html, body { background: #fff; }
    .sheet { margin: 0; }
    .sheet:last-child { page-break-after: auto; break-after: auto; }
  }
</style></head>
<body>${sheets || '<p style="padding:20px">Chưa có mã nào để in.</p>'}</body></html>`;
}

export interface BillOrder {
  name: string;
  items: { code: string; price: number; paid: boolean }[];
  total: number;
  paid: boolean;
}

/** Mỗi khách một tờ bill khổ A6. */
export function renderBillsHtml(orders: BillOrder[]): string {
  const sheets = orders
    .map((o) => {
      const rows = o.items
        .map((i) => `<tr><td class="c">${esc(i.code)}</td><td class="p">${esc(formatPrice(i.price))}</td></tr>`)
        .join('');
      return `<section class="bill">
        <h1>${esc(o.name)}</h1>
        <table>${rows}</table>
        <div class="sum"><span>${o.items.length} món</span><b>${esc(formatPrice(o.total))}</b></div>
        <div class="st ${o.paid ? 'ok' : 'no'}">${o.paid ? 'ĐÃ CHUYỂN KHOẢN' : 'CHƯA CHUYỂN KHOẢN'}</div>
      </section>`;
    })
    .join('');
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Bill A6 - ${orders.length} khách</title>
<style>
  @page { size: 105mm 148mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #ddd; font-family: Arial, Helvetica, sans-serif; }
  .bill { width: 105mm; min-height: 148mm; padding: 8mm; background: #fff; margin: 0 auto 8px;
    page-break-after: always; break-after: page; }
  h1 { font-size: 6mm; margin: 0 0 4mm; border-bottom: 0.4mm solid #000; padding-bottom: 2mm; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; font-size: 4.6mm; }
  td { padding: 1mm 0; border-bottom: 0.2mm dashed #aaa; }
  td.c { font-weight: 800; letter-spacing: 0.2mm; }
  td.p { text-align: right; }
  .sum { display: flex; justify-content: space-between; margin-top: 4mm; font-size: 5mm; }
  .sum b { font-size: 6.5mm; }
  .st { margin-top: 5mm; text-align: center; font-weight: 800; font-size: 4mm; padding: 2mm; border: 0.4mm solid #000; }
  .st.ok { background: #000; color: #fff; }
  @media print { html, body { background: #fff; } .bill { margin: 0; } .bill:last-child { page-break-after: auto; break-after: auto; } }
</style></head><body>${sheets || '<p style="padding:20px">Chưa có đơn nào.</p>'}</body></html>`;
}
