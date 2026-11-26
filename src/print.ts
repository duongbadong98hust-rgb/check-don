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
  const codeFont = Math.min(size.h * 0.55, size.w * 0.55);
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
  .code { font-size: ${codeFont.toFixed(1)}mm; font-weight: 800; letter-spacing: 0.5mm; }
  .price { font-size: ${priceFont.toFixed(1)}mm; font-weight: 700; margin-top: 1mm; }
  @media print {
    html, body { background: #fff; }
    .sheet { margin: 0; }
    .sheet:last-child { page-break-after: auto; break-after: auto; }
  }
</style></head>
<body>${sheets || '<p style="padding:20px">Chưa có mã nào để in.</p>'}</body></html>`;
}
