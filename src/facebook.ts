// Đọc comment Facebook Live qua Graph API chính thức (chỉ đọc, không đăng nhập bằng mật khẩu).
// Cần: ID Page + Page Access Token của một người có quyền trên Page (xem docs/FACEBOOK.md).

export interface FbConfig {
  pageId: string;
  token: string;
  version: string; // phiên bản Graph API, ví dụ v23.0
  pollMs: number; // bao lâu hỏi Facebook một lần
}

export type FbState = 'off' | 'searching' | 'connected' | 'error';

export interface FbStatus {
  configured: boolean;
  state: FbState;
  liveVideoId: string | null;
  liveTitle: string | null;
  message: string;
  comments: number; // số comment đã nhận từ buổi live này
  lastCommentAt: number | null;
}

export interface FbComment {
  fbId: string;
  userId?: string;
  name: string;
  text: string;
  ts: number;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export class GraphError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** Gọi Graph API. Mọi chuỗi bí mật (token...) bị che khỏi thông báo lỗi. */
export async function graphGet(
  o: { version: string; token?: string; secrets?: string[]; fetchImpl?: FetchLike },
  path: string,
  params: Record<string, string> = {},
): Promise<any> {
  const url = new URL(`https://graph.facebook.com/${o.version}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (o.token) url.searchParams.set('access_token', o.token);
  const secrets = [o.token, ...(o.secrets ?? [])].filter((s): s is string => !!s);
  const redact = (s: string) => secrets.reduce((acc, sec) => acc.split(sec).join('***'), s);
  let res;
  try {
    res = await (o.fetchImpl ?? (fetch as unknown as FetchLike))(url.toString());
  } catch (e) {
    throw new GraphError(redact('Không kết nối được tới Facebook: ' + (e as Error).message));
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    throw new GraphError(redact(String(body?.error?.message ?? `Facebook trả lỗi HTTP ${res.status}`)), body?.error?.code);
  }
  return body;
}

/** Đổi lỗi Facebook sang câu tiếng Việt dễ hiểu. */
export function explainError(e: unknown): { message: string; fatal: boolean; slow: boolean } {
  const err = e as GraphError;
  const raw = err?.message ?? String(e);
  switch (err?.code) {
    case 190:
      return { message: 'Token hết hạn hoặc không hợp lệ. Hãy lấy token mới (xem docs/FACEBOOK.md).', fatal: true, slow: false };
    case 10:
    case 200:
    case 299:
      return { message: 'Thiếu quyền đọc comment của Page. Kiểm tra quyền của app và vai trò của tài khoản trên Page.', fatal: true, slow: false };
    case 4:
    case 17:
    case 32:
    case 613:
      return { message: 'Facebook đang giới hạn tốc độ, sẽ tự thử lại sau ít phút.', fatal: false, slow: true };
    default:
      return { message: raw, fatal: false, slow: false };
  }
}

const parseTime = (s: string | undefined) => {
  const t = s ? Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
  return Number.isFinite(t) ? t : Date.now();
};

export function createFacebookReader(o: {
  config: FbConfig;
  onComment: (c: FbComment) => boolean | void; // trả false nếu comment này đã có rồi (trùng)
  fetchImpl?: FetchLike;
}) {
  const cfg = o.config;
  const graph = (path: string, params?: Record<string, string>) =>
    graphGet({ version: cfg.version, token: cfg.token, fetchImpl: o.fetchImpl }, path, params);

  let videoId: string | null = null;
  let title: string | null = null;
  let manual = false; // đã chọn tay một video: không tự đổi
  let cursor: string | null = null;
  let polls = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let st: Omit<FbStatus, 'configured' | 'liveVideoId' | 'liveTitle'> = {
    state: 'off', message: 'Chưa bắt đầu', comments: 0, lastCommentAt: null,
  };

  const findLive = async () => {
    const r = await graph(`${cfg.pageId}/live_videos`, { fields: 'id,status,broadcast_status,title', limit: '10' });
    const live = (r.data ?? []).find(
      (v: any) => v.status === 'LIVE_NOW' || v.status === 'LIVE' || v.broadcast_status === 'LIVE',
    );
    return live ? { id: String(live.id), title: (live.title as string) ?? null } : null;
  };

  const readComments = async () => {
    // Đọc hết các trang mới; nhớ con trỏ để lần sau chỉ lấy comment mới.
    for (let page = 0; page < 20; page++) {
      const params: Record<string, string> = {
        fields: 'id,message,created_time,from{id,name}',
        order: 'chronological',
        filter: 'toplevel',
        live_filter: 'no_filter',
        limit: '100',
      };
      if (cursor) params.after = cursor;
      const r = await graph(`${videoId}/comments`, params);
      const data: any[] = r.data ?? [];
      for (const c of data) {
        if (!c.id || !c.message) continue;
        if (c.from?.id && c.from.id === cfg.pageId) continue; // bỏ comment của chính Page
        const isNew = o.onComment({
          fbId: String(c.id),
          // Nếu Facebook không trả thông tin người comment, mỗi comment tính là một khách riêng.
          userId: c.from?.id ? String(c.from.id) : `fbc:${c.id}`,
          name: c.from?.name ?? 'Khách Facebook',
          text: String(c.message),
          ts: parseTime(c.created_time),
        });
        if (isNew === false) continue;
        st.comments++;
        st.lastCommentAt = Date.now();
      }
      const next = r.paging?.cursors?.after;
      if (next) cursor = String(next);
      if (data.length < 100 || !r.paging?.next) break;
    }
  };

  /** Một vòng: tìm live (nếu chưa có) rồi đọc comment mới. Trả về số ms nên chờ trước vòng sau. */
  async function pollOnce(): Promise<number> {
    try {
      polls++;
      if (!videoId || (!manual && polls % 10 === 0)) {
        const live = await findLive();
        if (!live) {
          if (videoId) { videoId = null; title = null; cursor = null; }
          st = { ...st, state: 'searching', message: 'Chưa thấy buổi live nào đang phát. Hãy bắt đầu live trên Page.' };
          return 5000;
        }
        if (live.id !== videoId) { videoId = live.id; title = live.title; cursor = null; }
      }
      await readComments();
      st = { ...st, state: 'connected', message: 'Đang đọc comment live' };
      return cfg.pollMs;
    } catch (e) {
      const x = explainError(e);
      st = { ...st, state: 'error', message: x.message };
      if (x.fatal) running = false; // token sai/thiếu quyền: dừng, chờ người dùng sửa rồi bấm bắt đầu lại
      return x.slow ? 60000 : 10000;
    }
  }

  const loop = async () => {
    if (!running) return;
    const wait = await pollOnce();
    if (running) timer = setTimeout(loop, wait);
  };

  return {
    pollOnce,
    status(): FbStatus {
      return { configured: true, liveVideoId: videoId, liveTitle: title, ...st };
    },
    start() {
      if (running) return;
      running = true;
      st = { ...st, state: 'searching', message: 'Đang tìm buổi live…' };
      void loop();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      st = { ...st, state: 'off', message: 'Đã dừng' };
    },
    /** Đọc một video cụ thể (dán ID video live) thay vì tự tìm. */
    async attach(id: string) {
      const v = await graph(id, { fields: 'id,title' });
      videoId = String(v.id);
      title = v.title ?? null;
      manual = true;
      cursor = null;
      st = { ...st, comments: 0 };
    },
    /** Quay lại chế độ tự tìm buổi live đang phát. */
    auto() {
      manual = false; videoId = null; title = null; cursor = null;
    },
    /** Buổi live mới: quên video và con trỏ cũ. */
    reset() {
      manual = false; videoId = null; title = null; cursor = null;
      st = { ...st, comments: 0, lastCommentAt: null };
    },
  };
}

export type FacebookReader = ReturnType<typeof createFacebookReader>;

// ---- Hỗ trợ lấy token (dùng trong scripts/fb-token.ts) ----

export async function exchangeLongLivedUserToken(
  o: { version: string; appId: string; appSecret: string; shortToken: string; fetchImpl?: FetchLike },
): Promise<string> {
  const r = await graphGet(
    { version: o.version, secrets: [o.appSecret, o.shortToken], fetchImpl: o.fetchImpl },
    'oauth/access_token',
    { grant_type: 'fb_exchange_token', client_id: o.appId, client_secret: o.appSecret, fb_exchange_token: o.shortToken },
  );
  if (!r.access_token) throw new GraphError('Facebook không trả về token dài hạn');
  return String(r.access_token);
}

export async function listPages(
  o: { version: string; userToken: string; fetchImpl?: FetchLike },
): Promise<{ id: string; name: string; token: string }[]> {
  const r = await graphGet({ version: o.version, token: o.userToken, fetchImpl: o.fetchImpl }, 'me/accounts', {
    fields: 'id,name,access_token',
    limit: '100',
  });
  return (r.data ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name), token: String(p.access_token) }));
}
