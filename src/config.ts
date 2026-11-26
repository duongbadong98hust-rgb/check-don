import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { FbConfig } from './facebook.ts';

/** Đọc file .env (nếu có) vào process.env. Không ghi đè biến đã đặt sẵn. */
export function loadEnv(file = '.env') {
  try {
    process.loadEnvFile(file);
  } catch {
    /* không có .env cũng được */
  }
}

export function fbConfigFromEnv(env = process.env): FbConfig | null {
  const pageId = env.FB_PAGE_ID?.trim();
  const token = env.FB_PAGE_TOKEN?.trim();
  if (!pageId || !token) return null;
  const poll = Number(env.FB_POLL_MS);
  return {
    pageId,
    token,
    version: env.FB_GRAPH_VERSION?.trim() || 'v23.0',
    pollMs: Number.isFinite(poll) && poll >= 1000 ? poll : 2000,
  };
}

/** Ghi/cập nhật một dòng KEY=value trong .env (giữ nguyên các dòng khác). */
export function setEnvVar(file: string, key: string, value: string) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => l.startsWith(key + '='));
  const line = `${key}=${value}`;
  if (idx >= 0) lines[idx] = line;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(line, '');
  }
  writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}
