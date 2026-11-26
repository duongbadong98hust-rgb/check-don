// Đổi token ngắn hạn thành token Page dùng lâu dài và ghi vào .env:  npm run fb:token
// Cần trong .env: FB_APP_ID, FB_APP_SECRET, FB_USER_TOKEN (token ngắn hạn lấy từ Graph API Explorer).
// Không in token ra màn hình.
import { loadEnv, setEnvVar } from '../src/config.ts';
import { exchangeLongLivedUserToken, listPages, explainError } from '../src/facebook.ts';

loadEnv();
const { FB_APP_ID: appId, FB_APP_SECRET: appSecret, FB_USER_TOKEN: shortToken, FB_PAGE_ID: wantPage } = process.env;
const version = process.env.FB_GRAPH_VERSION || 'v23.0';
if (!appId || !appSecret || !shortToken) {
  console.error('Thiếu FB_APP_ID, FB_APP_SECRET hoặc FB_USER_TOKEN trong file .env (xem docs/FACEBOOK.md, bước 5).');
  process.exit(1);
}
try {
  const longToken = await exchangeLongLivedUserToken({ version, appId, appSecret, shortToken });
  const pages = await listPages({ version, userToken: longToken });
  if (!pages.length) {
    console.error('Tài khoản này không quản lý Page nào (hoặc app chưa được cấp quyền pages_show_list).');
    process.exit(1);
  }
  let page = wantPage ? pages.find((p) => p.id === wantPage) : pages.length === 1 ? pages[0] : undefined;
  if (!page) {
    console.log('Tài khoản quản lý các Page sau. Điền FB_PAGE_ID=<id> vào .env rồi chạy lại:');
    for (const p of pages) console.log(`  ${p.id}  ${p.name}`);
    process.exit(1);
  }
  setEnvVar('.env', 'FB_PAGE_ID', page.id);
  setEnvVar('.env', 'FB_PAGE_TOKEN', page.token);
  console.log(`✔ Đã ghi FB_PAGE_ID và FB_PAGE_TOKEN cho Page "${page.name}" vào .env.`);
  console.log('Bạn có thể xoá FB_USER_TOKEN và FB_APP_SECRET khỏi .env. Chạy tiếp: npm run fb:check');
} catch (e) {
  console.error('✘ ' + explainError(e).message);
  process.exit(1);
}
