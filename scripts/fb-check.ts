// Kiểm tra kết nối Facebook:  npm run fb:check
import { loadEnv, fbConfigFromEnv } from '../src/config.ts';
import { graphGet, explainError } from '../src/facebook.ts';

loadEnv();
const cfg = fbConfigFromEnv();
if (!cfg) {
  console.error('Chưa có FB_PAGE_ID / FB_PAGE_TOKEN trong file .env (xem docs/FACEBOOK.md).');
  process.exit(1);
}
const g = (path: string, params: Record<string, string> = {}) =>
  graphGet({ version: cfg.version, token: cfg.token }, path, params);

try {
  const page = await g(cfg.pageId, { fields: 'id,name' });
  console.log(`✔ Token dùng được. Page: ${page.name} (${page.id})`);
  const lives = await g(`${cfg.pageId}/live_videos`, { fields: 'id,status,title,creation_time', limit: '5' });
  const list = lives.data ?? [];
  if (!list.length) console.log('• Page chưa có video live nào (hoặc chưa đủ quyền xem).');
  for (const v of list) console.log(`• Live ${v.id} [${v.status}] ${v.title ?? ''}`);
  const live = list.find((v: any) => v.status === 'LIVE_NOW' || v.status === 'LIVE') ?? list[0];
  if (live) {
    const c = await g(`${live.id}/comments`, { fields: 'id,message,from{id,name}', limit: '3', live_filter: 'no_filter' });
    const n = (c.data ?? []).length;
    console.log(`✔ Đọc được comment của live ${live.id} (${n} comment mẫu).`);
    if (n && !c.data[0].from) console.log('⚠ Facebook không trả tên người comment: mỗi comment sẽ tính là một khách riêng. Xem mục "Thiếu tên khách" trong docs/FACEBOOK.md.');
  }
} catch (e) {
  console.error('✘ ' + explainError(e).message);
  process.exit(1);
}
