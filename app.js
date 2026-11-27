/* Check đơn: app kiểm đóng hàng */
(() => {
  'use strict';

  // ---------- Cài đặt ----------
  const CFG = window.APP_CONFIG || {};
  const RETENTION_DAYS = 90;                       // giữ ảnh 3 tháng
  const SOFT_LIMIT = 950 * 1024 * 1024;            // gần đầy 1GB thì bắt đầu xoá ảnh cũ
  const TARGET_AFTER_TRIM = 900 * 1024 * 1024;     // xoá đến khi còn dưới mức này
  const PHOTO_MAX_SIDE = 1280;
  const PHOTO_MAX_BYTES = 100 * 1024;              // mỗi ảnh tối đa ~100KB
  const BUCKET = 'photos';
  const TZ = 'Asia/Ho_Chi_Minh';
  const VENDOR = new URL('vendor/', location.href).href;

  const $ = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  // ---------- Tiện ích ----------
  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(d) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
    return `${p.day}/${p.month}/${p.year} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
  }
  function vnDate(d) { return fmtTime(d).slice(0, 10); }
  function noAccent(s) {
    return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function titleCase(s) {
    return s.toLowerCase().split(/\s+/).filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function mb(bytes) { return (bytes / 1024 / 1024).toFixed(0); }
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }
  function status(el, msg, kind = '') {
    el.hidden = !msg; el.textContent = msg || ''; el.className = 'status ' + kind;
  }
  function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* bỏ qua */ } }

  // ---------- Ảnh ----------
  async function loadBitmap(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image(); img.src = url; await img.decode(); return img;
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  }
  function drawScaled(src, maxSide) {
    const w0 = src.width, h0 = src.height;
    const k = Math.min(1, maxSide / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  const toBlob = (c, q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));

  // In tên khách, mã vận đơn, ngày giờ lên góc dưới ảnh
  // In tên khách, mã vận đơn, ngày giờ vào dải đen NỐI THÊM bên dưới ảnh (không che ảnh hàng)
  function stamp(photo, lines) {
    const W = photo.width;
    const fs = Math.max(16, Math.round(W / 26));
    const padX = Math.round(fs * 0.6), lh = Math.round(fs * 1.3);
    lines = lines.filter(Boolean);
    const bandH = lh * lines.length + padX * 2;
    const c = document.createElement('canvas');
    c.width = W; c.height = photo.height + bandH;
    const ctx = c.getContext('2d');
    ctx.drawImage(photo, 0, 0);
    ctx.fillStyle = '#111'; ctx.fillRect(0, photo.height, W, bandH);
    ctx.font = `bold ${fs}px -apple-system, Roboto, "Segoe UI", Arial, sans-serif`;
    const maxW = W - padX * 2;
    const fit = (t) => {
      if (ctx.measureText(t).width <= maxW) return t;
      while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      return t + '…';
    };
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
    lines.map(fit).forEach((t, i) => ctx.fillText(t, padX, photo.height + padX + i * lh));
    return c;
  }

  async function makeThumb(src) {
    const side = 320, s0 = Math.min(src.width, src.height);
    const c = document.createElement('canvas'); c.width = side; c.height = side;
    c.getContext('2d').drawImage(src, (src.width - s0) / 2, (src.height - s0) / 2, s0, s0, 0, 0, side, side);
    return toBlob(c, 0.6);
  }

  async function compressStamped(src, lines) {
    for (const side of [PHOTO_MAX_SIDE, 1080, 900]) {
      const c = stamp(drawScaled(src, side), lines);
      for (const q of [0.72, 0.62, 0.52, 0.44]) {
        const b = await toBlob(c, q);
        if (b.size <= PHOTO_MAX_BYTES) return b;
      }
    }
    const c = stamp(drawScaled(src, 800), lines);
    return toBlob(c, 0.45);
  }

  // ---------- Đọc tem: QR + tên khách ----------
  let zxingReady = false;
  function prepareZxing() {
    if (zxingReady || !window.ZXingWASM) return;
    window.ZXingWASM.prepareZXingModule({
      overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? VENDOR + 'zxing_reader.wasm' : prefix + p) },
    });
    zxingReady = true;
  }
  function pickCode(texts) {
    const clean = texts.map((t) => (t || '').trim()).filter(Boolean);
    return clean.find((t) => /^SPX[A-Z]{0,3}\d{6,}[A-Z0-9]*$/i.test(t))
      || clean.find((t) => /^[A-Z0-9]{8,30}$/i.test(t))
      || clean[0] || '';
  }
  // Đọc mã vận đơn. Trả về { code, quad }: quad = 4 góc mã QR (toạ độ ảnh gốc) nếu có
  async function readCodes(src) {
    const pick = (items, k) => {
      const qr = items.filter((x) => x.isQR);
      const code = pickCode((qr.length ? qr : items).map((x) => x.text));
      if (!code) return null;
      const hit = items.find((x) => x.text.trim() === code && x.isQR && x.pts && x.pts.length === 4);
      return { code, quad: hit ? hit.pts.map((p) => ({ x: p.x * k, y: p.y * k })) : null };
    };
    // 1) Trình đọc có sẵn của trình duyệt (Android Chrome)
    if ('BarcodeDetector' in window) {
      try {
        const det = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
        const c = drawScaled(src, 1600);
        const found = await det.detect(c);
        const r = pick(found.map((f) => ({ text: f.rawValue, isQR: f.format === 'qr_code', pts: f.cornerPoints })), src.width / c.width);
        if (r) return r;
      } catch { /* dùng cách 2 */ }
    }
    // 2) ZXing (mọi điện thoại), thử vài cỡ ảnh
    prepareZxing();
    for (const side of [1000, 1600, 700, 2200]) {
      const c = drawScaled(src, side);
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      const res = await window.ZXingWASM.readBarcodes(data, {
        formats: ['QRCode', 'Code128'], tryHarder: true, maxNumberOfSymbols: 4,
      });
      const r = pick(res.map((x) => ({
        text: x.text, isQR: x.format === 'QRCode',
        pts: x.position && [x.position.topLeft, x.position.topRight, x.position.bottomRight, x.position.bottomLeft],
      })), src.width / c.width);
      if (r) return r;
    }
    return { code: '', quad: null };
  }
  async function readQR(src) { return (await readCodes(src)).code; }

  // Trên tem SPX, khung "Đến:" nằm ngay phía trên-bên trái mã QR với tỉ lệ cố định theo cỡ mã QR.
  // Từ vị trí mã QR suy ra khung người nhận (chỉ khi tem đặt thẳng đứng).
  function toBoxFromQR(quad, src) {
    if (!quad) return null;
    const [tl, tr, , bl] = quad;
    const ang = Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180 / Math.PI;
    if (Math.abs(ang) > 12) return null;                  // tem bị xoay: bỏ qua
    const q = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(bl.x - tl.x, bl.y - tl.y)) / 2;
    const left = Math.min(tl.x, bl.x), right = Math.max(tr.x, quad[2].x), top = Math.min(tl.y, tr.y);
    const x0 = Math.max(0, left - q * 1.65), x1 = Math.min(src.width, right + q * 0.1);
    const y0 = Math.max(0, top - q * 1.08), y1 = Math.min(src.height, top - q * 0.25);
    if (x1 - x0 < 40 || y1 - y0 < 20) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function cropCanvas(src, box, width) {
    const k = width / box.w;
    const c = document.createElement('canvas');
    c.width = Math.round(box.w * k); c.height = Math.round(box.h * k);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
    return c;
  }
  // Đọc tên trong ảnh đã cắt khung người nhận: dòng ngay dưới "Đến:", hoặc dòng chữ đầu tiên
  async function readNameInBox(src, box) {
    const worker = await getOcr();
    const c = cropCanvas(src, box, 1400);
    const { data } = await worker.recognize(c, {}, { text: true, blocks: true });
    const flat = flattenBlocks(data);
    let name = extractName(flat);
    if (!name) {
      for (const l of flat.lines || []) {
        const t = (l.text || '').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        if (t.length >= 2 && !isDen(t.split(' ')[0]) && (l.confidence ?? 100) > 45) { name = titleCase(t.split(' ').slice(0, 5).join(' ')); break; }
      }
    }
    return name;
  }

  let ocrWorkerP = null;
  function getOcr() {
    if (!ocrWorkerP) {
      ocrWorkerP = window.Tesseract.createWorker('vie', 1, {
        workerPath: VENDOR + 'worker.min.js',
        corePath: VENDOR + 'core/',
        langPath: VENDOR.replace(/\/$/, ''),
        gzip: true,
      }).catch((e) => { ocrWorkerP = null; throw e; });
    }
    return ocrWorkerP;
  }
  // "Đến:" (OCR đôi khi đọc nhầm thành Đếm:, Đếu:)
  const isDen = (t) => /^de[nmu]:?$/.test(noAccent(t).replace(/[^a-z:]/g, ''));
  const hasLetter = (t) => /\p{L}/u.test(t);
  function extractName(data) {
    const lines = data.lines || [];
    for (let i = 0; i < lines.length - 1; i++) {
      const den = (lines[i].words || []).find((w) => isDen(w.text));
      if (!den) continue;
      // Dòng ngay dưới chữ "Đến:", chỉ lấy các chữ nằm thẳng cột với "Đến:"
      for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
        const h = den.bbox.y1 - den.bbox.y0;
        let words = (lines[j].words || [])
          .filter((w) => w.bbox.x0 >= den.bbox.x0 - h * 1.5)
          .sort((a, b) => a.bbox.x0 - b.bbox.x0);
        const out = [];
        for (const w of words) {
          const t = w.text.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
          if (!t) { if (out.length) break; else continue; }
          if (out.length) {
            const prev = out[out.length - 1].w;
            if (w.bbox.x0 - prev.bbox.x1 > h * 2.5) break;   // khoảng trống lớn: hết tên
          } else if (t.length < 2 || (w.confidence < 20 && t.length < 3)) continue;
          out.push({ t, w });
        }
        const name = out.map((o) => o.t).join(' ').trim();
        if (name.length >= 2 && hasLetter(name)) return titleCase(name);
      }
    }
    // Dự phòng: tìm bằng văn bản thuần
    const txt = (data.text || '').split('\n');
    for (let i = 0; i < txt.length - 1; i++) {
      if (/[ĐD][eếêề][nmu]\s*:/i.test(txt[i])) {
        const n = txt[i + 1].replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        if (n) return titleCase(n.split(' ').slice(0, 5).join(' '));
      }
    }
    return '';
  }
  async function readName(src) {
    const worker = await getOcr();
    // Ảnh chụp cả tem thì chữ nhỏ: thử cỡ vừa trước, không thấy "Đến:" thì đọc lại ở cỡ lớn hơn
    let c, data, flat, r;
    for (const side of [1600, 2800]) {
      if (c && Math.max(src.width, src.height) <= 1600 * 1.1) break;   // ảnh nhỏ: không cần đọc lại
      c = drawScaled(src, side);
      ({ data } = await worker.recognize(c, {}, { text: true, blocks: true }));
      flat = flattenBlocks(data);
      r = findToBox(flat);
      if (r) break;
    }
    const k = src.width / c.width;   // đổi toạ độ về ảnh gốc
    const box = r && { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
    return { name: extractName(flat), box, data };
  }

  // Tìm khung "Đến:" (tên + địa chỉ người nhận) trên tem
  function findToBox(data) {
    const lines = data.lines || [];
    for (let i = 0; i < lines.length; i++) {
      const den = (lines[i].words || []).find((w) => isDen(w.text));
      if (!den) continue;
      const h = Math.max(8, den.bbox.y1 - den.bbox.y0);
      let x0 = den.bbox.x0, y0 = den.bbox.y0, x1 = den.bbox.x1, y1 = den.bbox.y1;
      let prevBottom = den.bbox.y1;
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const ws = (lines[j].words || []).filter((w) => w.bbox.x0 >= den.bbox.x0 - h * 1.5)
          .sort((a, b) => a.bbox.x0 - b.bbox.x0);
        const kept = [];
        for (const w of ws) {
          if (kept.length && w.bbox.x0 - kept[kept.length - 1].bbox.x1 > h * 3) break;
          if (!kept.length && !hasLetter(w.text)) continue;
          kept.push(w);
        }
        if (!kept.length) break;
        const top = Math.min(...kept.map((w) => w.bbox.y0));
        if (top - prevBottom > h * 1.6) break;          // khoảng trống lớn: hết khung
        const bottom = Math.max(...kept.map((w) => w.bbox.y1));
        x1 = Math.max(x1, kept[kept.length - 1].bbox.x1);
        x0 = Math.min(x0, kept[0].bbox.x0);
        y1 = Math.max(y1, bottom); prevBottom = bottom;
      }
      const m = h * 0.8;
      return { x: Math.max(0, x0 - m), y: Math.max(0, y0 - m), w: (x1 - x0) + 2 * m, h: (y1 - y0) + 2 * m };
    }
    return null;
  }

  // Cắt khung "Đến:" ra ảnh JPEG nhỏ; không tìm thấy thì lưu cả tem (thu nhỏ)
  async function cropToBox(src, box) {
    let c;
    if (box) {
      const x = Math.max(0, Math.round(box.x)), y = Math.max(0, Math.round(box.y));
      const w = Math.min(src.width - x, Math.round(box.w)), hh = Math.min(src.height - y, Math.round(box.h));
      const k = Math.min(1, 1100 / w);
      c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(hh * k);
      c.getContext('2d').drawImage(src, x, y, w, hh, 0, 0, c.width, c.height);
    } else {
      c = drawScaled(src, 1100);
    }
    for (const q of [0.8, 0.65, 0.5]) {
      const b = await toBlob(c, q);
      if (b.size <= PHOTO_MAX_BYTES) return b;
    }
    return toBlob(c, 0.4);
  }
  // tesseract.js v5: lấy danh sách dòng/từ từ blocks
  function flattenBlocks(data) {
    if (data.lines && data.lines.length) return data;
    const lines = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push(l);
    return { ...data, lines };
  }

  async function scanLabel(file, statusEl) {
    status(statusEl, '⏳ Đang đọc tem…');
    const src = await loadBitmap(file);
    getOcr().catch(() => {});   // tải sẵn bộ đọc chữ trong lúc đọc QR
    const { code: tracking, quad } = await readCodes(src).catch((e) => { console.error(e); return { code: '', quad: null }; });
    status(statusEl, tracking ? `✓ Mã: ${tracking}. ⏳ Đang đọc tên khách…` : '⏳ Đang đọc tên khách…');
    let box = toBoxFromQR(quad, src), name = '';
    if (box) {
      name = await readNameInBox(src, box).catch((e) => { console.error(e); return ''; });
    } else {
      const r = await readName(src).catch((e) => { console.error(e); return { name: '', box: null }; });
      name = r.name; box = r.box;
    }
    const crop = await cropToBox(src, box).catch(() => null);
    return { tracking, name, src, crop, found: !!box };
  }

  // ---------- Trạng thái màn đóng hàng ----------
  let photos = []; // { file, url }
  let labelCrop = null; // ảnh cắt khung người nhận trên tem
  let saving = false;

  function renderPhotos() {
    const g = $('photo-grid'); g.innerHTML = '';
    photos.forEach((p, i) => {
      const d = document.createElement('div'); d.className = 'ph';
      d.innerHTML = `<img src="${p.url}" alt="Ảnh ${i + 1}"><button aria-label="Xoá ảnh">✕</button>`;
      d.querySelector('button').onclick = () => { URL.revokeObjectURL(p.url); photos.splice(i, 1); renderPhotos(); };
      g.appendChild(d);
    });
    updateSaveBtn();
  }
  function updateSaveBtn() {
    $('save-btn').disabled = !($('f-tracking').value.trim() && photos.length) || saving;
    $('save-btn').textContent = photos.length ? `✅ Lưu đơn (${photos.length} ảnh)` : '✅ Lưu đơn';
  }
  function resetPack() {
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    photos = [];
    $('f-tracking').value = ''; $('f-customer').value = '';
    $('label-preview').hidden = true; $('label-preview').removeAttribute('src');
    labelCrop = null;
    $('dup-warning').hidden = true;
    status($('label-status'), '');
    renderPhotos();
  }

  async function checkDuplicate() {
    const t = $('f-tracking').value.trim().toUpperCase();
    const w = $('dup-warning');
    if (!t) { w.hidden = true; return; }
    const { data } = await sb.from('orders').select('id,packed_at,photos').eq('tracking', t)
      .order('packed_at', { ascending: false }).limit(1);
    if (data && data.length) {
      w.innerHTML = `⚠️ Mã này đã được đóng lúc <b>${esc(fmtTime(data[0].packed_at))}</b>. Lưu nữa sẽ tạo thêm 1 lần đóng mới.`;
      w.hidden = false;
    } else w.hidden = true;
  }

  $('label-input').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const prev = $('label-preview');
    if (prev.src) URL.revokeObjectURL(prev.src);
    prev.src = URL.createObjectURL(file); prev.hidden = false;
    labelCrop = null;
    try {
      const { tracking, name, crop } = await scanLabel(file, $('label-status'));
      if (crop) {
        labelCrop = crop;
        URL.revokeObjectURL(prev.src);
        prev.src = URL.createObjectURL(crop);
      }
      if (tracking) $('f-tracking').value = tracking.toUpperCase();
      if (name) $('f-customer').value = name;
      const miss = [];
      if (!tracking) miss.push('mã QR');
      if (!name) miss.push('tên khách');
      if (miss.length) status($('label-status'), `Không đọc được ${miss.join(' và ')}. Chụp lại gần, rõ hơn, hoặc gõ tay vào ô bên dưới.`, 'err');
      else status($('label-status'), '✓ Đã đọc xong. Kiểm tra lại tên khách (sửa nếu sai dấu).', 'ok');
      updateSaveBtn();
      checkDuplicate();
    } catch (err) {
      console.error(err);
      status($('label-status'), 'Lỗi khi đọc tem. Kiểm tra mạng rồi thử lại, hoặc gõ tay.', 'err');
    }
  };
  $('f-tracking').oninput = () => updateSaveBtn();
  $('f-tracking').onchange = () => { $('f-tracking').value = $('f-tracking').value.trim().toUpperCase(); checkDuplicate(); };

  $('photo-input').onchange = (e) => {
    for (const file of e.target.files) photos.push({ file, url: URL.createObjectURL(file) });
    e.target.value = '';
    renderPhotos();
  };

  // ---------- Lưu đơn ----------
  $('save-btn').onclick = async () => {
    const tracking = $('f-tracking').value.trim().toUpperCase();
    const customer = $('f-customer').value.trim();
    if (!tracking || !photos.length || saving) return;
    saving = true; updateSaveBtn();
    const st = $('save-status');
    try {
      status(st, '⏳ Đang lấy giờ…');
      const { data: now, error: e1 } = await sb.rpc('server_now');
      if (e1) throw e1;
      const packedAt = new Date(now);
      const lines = [customer ? `Khách: ${customer}` : '', `Mã: ${tracking}`, `Đóng: ${fmtTime(packedAt)}`];
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' })
        .formatToParts(packedAt).map((x) => [x.type, x.value]));
      const folder = `${p.year}-${p.month}`;
      const stampId = packedAt.getTime().toString(36);
      const saved = [];
      const safeTrk = tracking.replace(/[^A-Z0-9_-]/gi, '_');
      if (labelCrop) {
        status(st, '⏳ Đang tải ảnh tem…');
        const path = `${folder}/${safeTrk}_${stampId}_tem.jpg`;
        const { error } = await sb.storage.from(BUCKET).upload(path, labelCrop, { contentType: 'image/jpeg', upsert: false });
        if (error && !/exists|duplicate/i.test(error.message || '')) throw error;
        saved.push({ path, size: labelCrop.size, kind: 'label' });
      }
      for (let i = 0; i < photos.length; i++) {
        status(st, `⏳ Đang xử lý và tải ảnh ${i + 1}/${photos.length}…`);
        const blob = await compressStamped(await loadBitmap(photos[i].file), lines);
        const path = `${folder}/${safeTrk}_${stampId}_${i + 1}.jpg`;
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
          if (!error) { lastErr = null; break; }
          lastErr = error;
          if (/exists|duplicate/i.test(error.message || '')) { lastErr = null; break; }
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        }
        if (lastErr) {
          if (saved.length) await sb.storage.from(BUCKET).remove(saved.map((s) => s.path));
          throw lastErr;
        }
        saved.push({ path, size: blob.size });
        if (i === 0) {
          // ảnh nhỏ (~10KB) để hiện trong lưới tra cứu, đỡ tốn dung lượng mạng
          try {
            const tb = await makeThumb(await loadBitmap(photos[0].file));
            const tpath = `${folder}/${safeTrk}_${stampId}_nho.jpg`;
            const { error: te } = await sb.storage.from(BUCKET).upload(tpath, tb, { contentType: 'image/jpeg', upsert: false });
            if (!te) saved.push({ path: tpath, size: tb.size, kind: 'thumb' });
          } catch (e) { console.warn('thumb', e); }
        }
      }
      status(st, '⏳ Đang lưu đơn…');
      const total = saved.reduce((a, s) => a + s.size, 0);
      const { error: e2 } = await sb.from('orders').insert({
        tracking, customer, customer_norm: noAccent(customer), packed_at: packedAt.toISOString(),
        photos: saved, total_bytes: total,
      });
      if (e2) { await sb.storage.from(BUCKET).remove(saved.map((s) => s.path)); throw e2; }
      status(st, '');
      toast(`✅ Đã lưu đơn ${tracking} lúc ${fmtTime(packedAt).slice(11)}`, 3500);
      resetPack();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      housekeeping(true);
    } catch (err) {
      console.error(err);
      status(st, `Lưu không được: ${err.message || err}. Ảnh vẫn còn, bấm Lưu lại để thử tiếp.`, 'err');
    } finally {
      saving = false; updateSaveBtn();
    }
  };

  // ---------- Tự dọn: xoá đơn quá 3 tháng, và xoá đơn cũ nhất khi gần đầy ----------
  async function deleteOrders(rows) {
    const paths = rows.flatMap((r) => (r.photos || []).map((p) => p.path));
    for (let i = 0; i < paths.length; i += 500) {
      const { error } = await sb.storage.from(BUCKET).remove(paths.slice(i, i + 500));
      if (error) throw error;
    }
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await sb.from('orders').delete().in('id', ids.slice(i, i + 200));
      if (error) throw error;
    }
  }
  async function housekeeping(force = false) {
    const last = Number(storageGet('hk_last') || 0);
    if (!force && Date.now() - last < 3 * 3600 * 1000) { showUsage(); return; }
    storageSet('hk_last', String(Date.now()));
    try {
      // 1) Quá hạn 3 tháng
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
      for (let k = 0; k < 20; k++) {
        const { data, error } = await sb.from('orders').select('id,photos').lt('packed_at', cutoff).limit(200);
        if (error) throw error;
        if (!data.length) break;
        await deleteOrders(data);
      }
      // Đơn đi quá 3 tháng
      await sb.from('dispatches').delete().lt('day', cutoff.slice(0, 10));
      // 2) Gần đầy: xoá đơn cũ nhất
      let used = await usedBytes();
      if (used > SOFT_LIMIT) {
        let removed = 0, oldest = null, newestRemoved = null;
        for (let k = 0; k < 20 && used > TARGET_AFTER_TRIM; k++) {
          const { data, error } = await sb.from('orders').select('id,photos,total_bytes,packed_at')
            .order('packed_at', { ascending: true }).limit(100);
          if (error) throw error;
          if (!data.length) break;
          const batch = [];
          for (const r of data) {
            if (used <= TARGET_AFTER_TRIM) break;
            batch.push(r); used -= Number(r.total_bytes || 0);
          }
          await deleteOrders(batch);
          removed += batch.length;
          oldest = oldest || batch[0]?.packed_at;
          newestRemoved = batch[batch.length - 1]?.packed_at || newestRemoved;
        }
        if (removed) {
          storageSet('trim_warning', JSON.stringify({
            at: Date.now(), removed, from: oldest, to: newestRemoved,
          }));
        }
      }
    } catch (err) {
      console.error('Dọn dẹp lỗi', err);
    }
    showUsage();
  }
  async function usedBytes() {
    const { data, error } = await sb.rpc('storage_used');
    if (error) throw error;
    return Number(data || 0);
  }
  async function showUsage() {
    try {
      const used = await usedBytes();
      const pct = Math.round((used / (1024 * 1024 * 1024)) * 100);
      $('usage').textContent = `Phiên bản 8 · Bộ nhớ ảnh: ${mb(used)} MB / 1.024 MB (${pct}%). Ảnh tự xoá sau 3 tháng.`;
      let warn = '';
      if (used > 0.85 * 1024 * 1024 * 1024) warn = `⚠️ Bộ nhớ ảnh đã dùng ${pct}%. Khi gần đầy, app sẽ tự xoá các đơn cũ nhất.`;
      const tw = JSON.parse(storageGet('trim_warning') || 'null');
      if (tw && Date.now() - tw.at < 7 * 86400000) {
        warn = `⚠️ Bộ nhớ gần đầy nên app đã tự xoá ${tw.removed} đơn cũ nhất (đóng từ ${vnDate(tw.from)} đến ${vnDate(tw.to)}).`;
      }
      $('storage-warning').textContent = warn; $('storage-warning').hidden = !warn;
    } catch { /* bỏ qua */ }
  }

  // ---------- Tra cứu ----------
  const isProduct = (p) => !p.kind;
  function thumbPath(r) {
    const ph = r.photos || [];
    return (ph.find((p) => p.kind === 'thumb') || ph.find(isProduct) || ph.find((p) => p.kind === 'label') || {}).path;
  }
  function dayLabel(d) {
    const day = vnDate(d), today = vnDate(new Date()), yest = vnDate(Date.now() - 86400000);
    return day === today ? `Hôm nay · ${day}` : day === yest ? `Hôm qua · ${day}` : day;
  }
  function cardHtml(r) {
    const n = (r.photos || []).filter(isProduct).length;
    return `<button class="card-o" data-id="${r.id}">
      <div class="thumb"><img alt="" data-path="${esc(thumbPath(r) || '')}"><span class="cnt">${n} ảnh</span></div>
      <div class="ci"><b>${esc(r.customer || '(chưa có tên)')}</b>
      <div class="trk">…${esc(r.tracking.slice(-5))}</div>
      <div class="meta">🕒 ${esc(fmtTime(r.packed_at).slice(11, 16))}</div></div></button>`;
  }
  const thumbUrls = new Map();
  async function loadThumbs(root) {
    const imgs = [...root.querySelectorAll('img[data-path]')].filter((i) => i.dataset.path && !i.src);
    const need = [...new Set(imgs.map((i) => i.dataset.path).filter((p) => !thumbUrls.has(p)))];
    if (need.length) {
      const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
      (data || []).forEach((d) => { if (d.signedUrl) thumbUrls.set(d.path, d.signedUrl); });
    }
    imgs.forEach((i) => { const u = thumbUrls.get(i.dataset.path); if (u) i.src = u; });
  }
  function renderResults(append) {
    let html = '', lastDay = append ? $('results').dataset.lastDay : '';
    const list = append ? lastResults.slice(-append) : lastResults;
    for (const r of list) {
      const d = vnDate(r.packed_at);
      if (d !== lastDay) {
        const cnt = lastResults.filter((x) => vnDate(x.packed_at) === d).length;
        html += `${lastDay ? '</div>' : ''}<div class="day-h">${esc(dayLabel(r.packed_at))}</div><div class="ogrid">`;
        lastDay = d;
      }
      html += cardHtml(r);
    }
    if (html) html += '</div>';
    $('results').dataset.lastDay = lastDay;
    if (append) $('results').insertAdjacentHTML('beforeend', html);
    else $('results').innerHTML = html;
    $('more-btn').hidden = !hasMore;
    loadThumbs($('results'));
  }
  const PAGE = 40;
  let lastResults = [], lastQ = '', hasMore = false;
  async function search(q, autoOpen = false, more = false) {
    const st = $('search-status');
    q = (q || '').trim();
    if (!more) { lastQ = q; status(st, '⏳ Đang tìm…'); }
    const from = more ? lastResults.length : 0;
    let query = sb.from('orders').select('id,tracking,customer,packed_at,photos')
      .order('packed_at', { ascending: false }).range(from, from + PAGE - 1);
    const day = $('day').value;   // yyyy-mm-dd, theo giờ Việt Nam
    if (day) query = query.gte('packed_at', `${day}T00:00:00+07:00`).lt('packed_at', new Date(Date.parse(`${day}T00:00:00+07:00`) + 86400000).toISOString());
    if (q) {
      const safe = (x) => x.replace(/[,()%*\\"]/g, ' ').trim();
      const t = safe(q.toUpperCase()).replace(/\s+/g, '');
      const n = safe(noAccent(q));
      // so khớp một phần mã: gõ 5 ký tự cuối (vd 6039B) cũng ra đơn
      query = query.or(`tracking.ilike.*${t}*,customer_norm.ilike.*${n}*`);
    }
    const { data, error } = await query;
    if (error) { status(st, 'Lỗi tìm kiếm: ' + error.message, 'err'); return; }
    if (!more && q !== lastQ) return;   // đã gõ tiếp, bỏ kết quả cũ
    hasMore = data.length === PAGE;
    if (more) { lastResults = lastResults.concat(data); renderResults(data.length); }
    else { lastResults = data; renderResults(0); }
    status(st, (q || day) ? (lastResults.length ? `Tìm thấy ${lastResults.length}${hasMore ? '+' : ''} đơn.` : 'Không tìm thấy đơn nào.') : '');
    if (autoOpen && q && lastResults.length === 1) openDetail(lastResults[0]);
  }
  let searchTimer;
  $('q').oninput = () => {
    clearTimeout(searchTimer);
    const v = $('q').value.trim();
    if (v.length >= 3 || v.length === 0) searchTimer = setTimeout(() => search(v), 450);
  };
  $('search-form').onsubmit = (e) => { e.preventDefault(); clearTimeout(searchTimer); $('q').blur(); search($('q').value, true); };
  $('day').onchange = () => { $('day-clear').hidden = !$('day').value; search($('q').value); };
  $('day-clear').onclick = () => { $('day').value = ''; $('day-clear').hidden = true; search($('q').value); };
  $('more-btn').onclick = () => search(lastQ, false, true);
  $('results').onclick = (e) => {
    const b = e.target.closest('.card-o'); if (!b) return;
    const r = lastResults.find((x) => String(x.id) === b.dataset.id);
    if (r) openDetail(r);
  };
  $('search-label-input').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const src = await loadBitmap(file);
      status($('search-status'), '⏳ Đang đọc mã QR…');
      const code = await readQR(src);
      if (!code) { status($('search-status'), 'Không đọc được mã QR. Chụp lại gần hơn hoặc gõ mã.', 'err'); return; }
      $('q').value = code.toUpperCase();
      search(code, true);
    } catch (err) {
      console.error(err);
      status($('search-status'), 'Lỗi khi đọc tem.', 'err');
    }
  };

  // ---------- Chi tiết đơn ----------
  let current = null;
  async function openDetail(r) {
    current = r;
    $('detail-info').innerHTML = `
      <div class="kv"><span>Tên khách</span><b class="big">${esc(r.customer || '(chưa có tên)')}</b></div>
      <div class="kv"><span>Mã vận đơn</span><b>${esc(r.tracking)}</b></div>
      <div class="kv"><span>Giờ đóng</span><b class="big">${esc(fmtTime(r.packed_at))}</b></div>`;
    const box = $('detail-photos');
    let shownHang = false;
    box.innerHTML = (r.photos || []).map((p) => {
      if (p.kind === 'thumb') return '';
      if (p.kind === 'label') return '<div class="section-title">Ảnh tem (người nhận)</div><img class="detail-photo" alt="">';
      const head = shownHang ? '' : '<div class="section-title">Ảnh hàng</div>';
      shownHang = true;
      return head + '<img class="detail-photo" alt="">';
    }).join('');
    show('detail');
    const paths = (r.photos || []).filter((p) => p.kind !== 'thumb').map((p) => p.path);
    if (!paths.length) return;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    if (error) { box.innerHTML = '<div class="status err">Không tải được ảnh.</div>'; return; }
    const imgs = box.querySelectorAll('img');
    data.forEach((d, i) => {
      if (!d.signedUrl) return;
      imgs[i].src = d.signedUrl;
      imgs[i].onclick = () => window.open(d.signedUrl, '_blank');
    });
  }
  $('back-btn').onclick = () => show('search');
  $('delete-btn').onclick = async () => {
    if (!current) return;
    if (!confirm(`Xoá đơn ${current.tracking} và toàn bộ ảnh? Không khôi phục được.`)) return;
    try {
      await deleteOrders([current]);
      toast('Đã xoá đơn');
      lastResults = lastResults.filter((x) => x.id !== current.id);
      $('results').querySelector(`[data-id="${current.id}"]`)?.remove();
      lastResults = lastResults.filter((x) => x.id !== current.id);
      show('search'); showUsage();
    } catch (err) { toast('Xoá không được: ' + (err.message || err)); }
  };

  // ---------- Đi đơn (quét khi giao cho shipper) ----------
  const ship = { day: '', rows: [], orderMap: new Map(), packedDay: [], stream: null, timer: null, lastCode: '', lastAt: 0, audio: null, busy: false };
  function vnToday() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  const dayRange = (day) => {
    const start = Date.parse(`${day}T00:00:00+07:00`);
    return [new Date(start).toISOString(), new Date(start + 86400000).toISOString()];
  };
  const dmy = (day) => day.split('-').reverse().join('/');
  function beep(ok) {
    try {
      const a = ship.audio; if (!a) return;
      const o = a.createOscillator(), g = a.createGain();
      o.frequency.value = ok ? 1250 : 330; o.type = ok ? 'sine' : 'square';
      g.gain.value = 0.25; o.connect(g); g.connect(a.destination);
      o.start(); o.stop(a.currentTime + (ok ? 0.12 : 0.45));
      if (!ok && navigator.vibrate) navigator.vibrate([200, 80, 200]);
    } catch { /* bỏ qua */ }
  }
  function shipFlash(msg, kind) {
    const f = $('ship-flash'); f.textContent = msg; f.className = 'ship-flash ' + kind; f.hidden = false;
  }
  async function lookupCustomers(trackings) {
    const need = [...new Set(trackings)].filter((t) => !ship.orderMap.has(t));
    for (let i = 0; i < need.length; i += 100) {
      const { data } = await sb.from('orders').select('tracking,customer,packed_at').in('tracking', need.slice(i, i + 100))
        .order('packed_at', { ascending: true });
      (data || []).forEach((o) => ship.orderMap.set(o.tracking, o.customer || ''));
    }
  }
  async function loadShip(day) {
    ship.day = day; $('ship-day').value = day;
    $('ship-summary').textContent = '⏳ Đang tải…';
    const { data, error } = await sb.from('dispatches').select('id,tracking,customer,scanned_at')
      .eq('day', day).order('scanned_at', { ascending: true }).limit(3000);
    if (error) {
      $('ship-summary').textContent = /dispatches/.test(error.message || '')
        ? '⚠️ Chưa cài bảng Đi đơn. Mở trang setup.html, sao chép lệnh và chạy lại trong Supabase SQL Editor.'
        : 'Lỗi tải danh sách: ' + error.message;
      return;
    }
    ship.rows = data;
    const [a, b] = dayRange(day);
    const { data: packed } = await sb.from('orders').select('tracking,customer,packed_at').gte('packed_at', a).lt('packed_at', b).limit(3000);
    ship.packedDay = packed || [];
    ship.packedDay.forEach((o) => ship.orderMap.set(o.tracking, o.customer || ''));
    await lookupCustomers(ship.rows.map((r) => r.tracking));
    renderShip();
  }
  function shipNameCounts() {
    const m = new Map();
    for (const r of ship.rows) {
      const n = noAccent(r.customer || ship.orderMap.get(r.tracking) || '');
      if (n) m.set(n, (m.get(n) || 0) + 1);
    }
    return m;
  }
  function renderShip(flashId) {
    const rows = ship.rows, counts = shipNameCounts();
    const dupNames = [...counts.values()].filter((v) => v > 1).length;
    const notPacked = rows.filter((r) => !ship.orderMap.has(r.tracking)).length;
    const sent = new Set(rows.map((r) => r.tracking));
    const notShipped = ship.packedDay.filter((o) => !sent.has(o.tracking));
    $('ship-summary').innerHTML = `${ship.day === vnToday() ? 'Hôm nay' : 'Ngày ' + esc(dmy(ship.day))}: <b>${rows.length}</b> đơn đi`
      + (dupNames ? ` · <span class="tag-w">⚠️ ${dupNames} tên trùng</span>` : '')
      + (notPacked ? ` · <span class="tag-w">⚠️ ${notPacked} đơn chưa đóng hàng</span>` : '');
    const nd = $('ship-notdone');
    if (notShipped.length) {
      nd.hidden = false;
      nd.innerHTML = `<details><summary>⚠️ <b>${notShipped.length}</b> đơn đã đóng ngày này nhưng <b>chưa quét đi</b></summary>`
        + notShipped.map((o) => `<div class="kv">${esc(o.customer || '(chưa có tên)')} · <span class="trk">${esc(o.tracking)}</span></div>`).join('')
        + '</details>';
    } else nd.hidden = true;
    $('ship-list').innerHTML = rows.map((r, i) => {
      const name = r.customer || ship.orderMap.get(r.tracking) || '';
      const tags = [];
      if (name && counts.get(noAccent(name)) > 1) tags.push('<span class="tag-w">Trùng tên</span>');
      if (!ship.orderMap.has(r.tracking)) tags.push('<span class="tag-r">Chưa đóng hàng</span>');
      return { i, html: `<div class="srow${r.id === flashId ? ' flash' : ''}" data-id="${r.id}">
        <div class="no">${i + 1}</div>
        <div class="mid"><b>${esc(name || '(chưa có tên)')}</b><div class="trk">${esc(r.tracking)}</div>
        ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}</div>
        <div class="tm">${esc(fmtTime(r.scanned_at).slice(11, 16))}</div>
        <button class="x" aria-label="Xoá">✕</button></div>` };
    }).reverse().map((x) => x.html).join('');
    checkShipReminder();
  }
  async function addShip(raw) {
    const code = (raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!code) return;
    if (ship.busy) return; ship.busy = true;
    try {
      if (ship.day !== vnToday()) await loadShip(vnToday());
      const existing = ship.rows.findIndex((r) => r.tracking === code);
      if (existing >= 0) {
        beep(false);
        shipFlash(`🔴 TRÙNG MÃ: ${code} đã quét lúc ${fmtTime(ship.rows[existing].scanned_at).slice(11, 16)} (số ${existing + 1}). Không thêm lần 2.`, 'dup');
        return;
      }
      await lookupCustomers([code]);
      const customer = ship.orderMap.get(code) || '';
      const { data, error } = await sb.from('dispatches').insert({ tracking: code, customer }).select('id,tracking,customer,scanned_at').single();
      if (error) {
        if (error.code === '23505') { beep(false); shipFlash(`🔴 TRÙNG MÃ: ${code} đã được quét hôm nay (máy khác).`, 'dup'); await loadShip(ship.day); return; }
        throw error;
      }
      ship.rows.push(data);
      const warns = [];
      if (!ship.orderMap.has(code)) warns.push('chưa có ảnh đóng hàng');
      if (customer && shipNameCounts().get(noAccent(customer)) > 1) warns.push(`trùng tên khách "${customer}" với đơn khác`);
      beep(!warns.length);
      shipFlash(`${warns.length ? '🟡' : '✅'} Số ${ship.rows.length}: ${customer || '(chưa có tên)'} · ${code}${warns.length ? ' · ⚠️ ' + warns.join(', ') : ''}`, warns.length ? 'warn' : 'ok');
      renderShip(data.id);
    } catch (err) {
      console.error(err); beep(false);
      shipFlash('Lỗi khi lưu: ' + (err.message || err), 'dup');
    } finally { ship.busy = false; }
  }
  async function startShipCam() {
    try {
      if (!ship.audio) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ship.audio = new AC(); }
      ship.audio?.resume?.();
      if (ship.day !== vnToday()) await loadShip(vnToday());
      ship.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const v = $('ship-video'); v.srcObject = ship.stream; await v.play().catch(() => {});
      $('ship-cam').hidden = false; $('ship-scan-btn').hidden = true;
      prepareZxing();
      const det = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
      const c = document.createElement('canvas');
      const tick = async () => {
        if (!ship.stream) return;
        try {
          if (v.readyState >= 2 && v.videoWidth) {
            const k = Math.min(1, 900 / v.videoWidth);
            c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(v, 0, 0, c.width, c.height);
            let code = '';
            if (det) { const f = await det.detect(c); code = f[0]?.rawValue || ''; }
            else {
              const res = await window.ZXingWASM.readBarcodes(ctx.getImageData(0, 0, c.width, c.height), { formats: ['QRCode'], tryHarder: false, maxNumberOfSymbols: 1 });
              code = res[0]?.text || '';
            }
            code = code.trim().toUpperCase();
            const now = Date.now();
            if (code && !(code === ship.lastCode && now - ship.lastAt < 4000)) {
              ship.lastCode = code; ship.lastAt = now;
              await addShip(code);
            } else if (code) ship.lastAt = now;
          }
        } catch (e) { console.warn(e); }
        ship.timer = setTimeout(tick, 180);
      };
      tick();
    } catch (err) {
      console.error(err);
      shipFlash('Không mở được camera. Cho phép app dùng camera (Cài đặt → Safari → Camera) rồi thử lại, hoặc gõ mã bên dưới.', 'dup');
      stopShipCam();
    }
  }
  function stopShipCam() {
    clearTimeout(ship.timer);
    if (ship.stream) ship.stream.getTracks().forEach((t) => t.stop());
    ship.stream = null;
    $('ship-cam').hidden = true; $('ship-scan-btn').hidden = false;
  }
  $('ship-scan-btn').onclick = startShipCam;
  $('ship-stop').onclick = stopShipCam;
  $('ship-manual').onsubmit = (e) => {
    e.preventDefault();
    if (!ship.audio) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ship.audio = new AC(); }
    addShip($('ship-code').value); $('ship-code').value = '';
  };
  $('ship-day').onchange = () => { if ($('ship-day').value) loadShip($('ship-day').value); };
  $('ship-list').onclick = async (e) => {
    const x = e.target.closest('.x'); if (!x) return;
    const id = Number(x.closest('.srow').dataset.id);
    const r = ship.rows.find((y) => y.id === id); if (!r) return;
    if (!confirm(`Xoá đơn ${r.tracking} khỏi danh sách đi đơn?`)) return;
    const { error } = await sb.from('dispatches').delete().eq('id', id);
    if (error) { toast('Xoá không được: ' + error.message); return; }
    ship.rows = ship.rows.filter((y) => y.id !== id);
    renderShip();
  };

  // ----- Báo cáo gửi shipper -----
  function reportRows() {
    return ship.rows.map((r, i) => [i + 1, r.customer || ship.orderMap.get(r.tracking) || '', r.tracking, fmtTime(r.scanned_at).slice(11, 16)]);
  }
  async function reportImage() {
    const rows = reportRows(), W = 1080, rh = 58, head = 190, pad = 40;
    const c = document.createElement('canvas'); c.width = W; c.height = head + rh * (rows.length + 1) + pad;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, c.height);
    const font = (w, s) => `${w} ${s}px -apple-system, Roboto, "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = '#ee4d2d'; ctx.font = font('bold', 46); ctx.textBaseline = 'top';
    ctx.fillText(`DANH SÁCH ĐƠN ĐI ${dmy(ship.day)}`, pad, 40);
    ctx.fillStyle = '#111'; ctx.font = font('bold', 38); ctx.fillText(`Tổng: ${rows.length} đơn`, pad, 110);
    const cols = [pad, pad + 80, pad + 520, W - pad - 110];
    let y = head;
    ctx.fillStyle = '#f0f1f4'; ctx.fillRect(pad - 10, y, W - 2 * pad + 20, rh);
    ctx.fillStyle = '#444'; ctx.font = font('bold', 28);
    ['STT', 'Tên khách', 'Mã vận đơn', 'Giờ'].forEach((t, i) => ctx.fillText(t, cols[i], y + 15));
    ctx.font = font('', 28);
    const clip = (t, w) => { if (ctx.measureText(t).width <= w) return t; while (t.length > 1 && ctx.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…'; };
    rows.forEach((r, i) => {
      y += rh;
      if (i % 2) { ctx.fillStyle = '#fafafa'; ctx.fillRect(pad - 10, y, W - 2 * pad + 20, rh); }
      ctx.fillStyle = '#111';
      ctx.fillText(String(r[0]), cols[0], y + 15);
      ctx.fillText(clip(r[1] || '-', cols[2] - cols[1] - 20), cols[1], y + 15);
      ctx.fillText(r[2], cols[2], y + 15);
      ctx.fillText(r[3], cols[3], y + 15);
    });
    return toBlob(c, 0.9);
  }
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let n = 0; n < buf.length; n++) {
      let c = (crc ^ buf[n]) & 0xFF;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files, type) {
    const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data), sz = data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true);
      lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + sz;
    }
    const csize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type });
  }
  function reportXlsx() {
    const x = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${x(v)}</t></is></c>`);
    const all = [[`Danh sách đơn đi ${dmy(ship.day)} - Tổng ${ship.rows.length} đơn`], [], ['STT', 'Tên khách', 'Mã vận đơn', 'Giờ quét'], ...reportRows()];
    const sheetRows = all.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell('ABCD'[j] + (i + 1), v)).join('')}</row>`).join('');
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="28" customWidth="1"/><col min="3" max="3" width="24" customWidth="1"/><col min="4" max="4" width="10" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData></worksheet>`;
    return zipStore([
      { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
      { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Don di" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', text: sheet },
    ], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  async function shareReport(kind) {
    if (!ship.rows.length) { toast('Chưa có đơn đi nào trong ngày này'); return; }
    const blob = kind === 'img' ? await reportImage() : reportXlsx();
    const fname = `don-di-${ship.day}.${kind === 'img' ? 'jpg' : 'xlsx'}`;
    const file = new File([blob], fname, { type: blob.type });
    const text = `Đơn đi ${dmy(ship.day)}: ${ship.rows.length} đơn`;
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: text });
      } else {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
      if (ship.day === vnToday()) storageSet('ship_sent_' + ship.day, '1');
      checkShipReminder();
    } catch (err) {
      if (err.name !== 'AbortError') toast('Không chia sẻ được: ' + (err.message || err));
    }
  }
  $('ship-send-img').onclick = () => shareReport('img');
  $('ship-send-xlsx').onclick = () => shareReport('xlsx');

  // Nhắc gửi shipper sau 20:00 giờ VN
  let remindToastDay = '';
  function checkShipReminder() {
    const today = vnToday();
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));
    const due = hour >= 20 && !storageGet('ship_sent_' + today);
    const b = $('ship-remind');
    b.textContent = due ? '⏰ Đã quá 20:00. Nhớ bấm Gửi ảnh / Gửi Excel để gửi danh sách đơn đi hôm nay cho shipper qua Zalo.' : '';
    b.hidden = !due;
    if (due && remindToastDay !== today && !$('tabs').hidden) { remindToastDay = today; toast('⏰ 20:00 rồi: gửi danh sách đơn đi cho shipper nhé (tab Đi đơn)', 6000); }
  }
  setInterval(() => { if (!$('tabs').hidden) checkShipReminder(); }, 60000);

  // ---------- Điều hướng ----------
  let activeTab = 'pack';
  function show(name) {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== 'screen-' + name;
    $('tabs').hidden = name === 'login';
    if (name !== 'ship' && typeof stopShipCam === 'function' && ship.stream) stopShipCam();
    if (name === 'pack' || name === 'search' || name === 'ship') {
      activeTab = name;
      for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
    }
  }
  $('tabs').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    show(b.dataset.tab);
    if (b.dataset.tab === 'search' && !lastResults.length) search('');
    if (b.dataset.tab === 'ship') loadShip(ship.day && ship.day !== vnToday() ? ship.day : vnToday());
  };

  // ---------- Đăng nhập ----------
  if (CFG.LOGIN_EMAIL) { $('login-email').value = CFG.LOGIN_EMAIL; $('email-wrap').hidden = true; }
  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    const { error } = await sb.auth.signInWithPassword({
      email: $('login-email').value.trim(), password: $('login-pass').value,
    });
    if (error) { $('login-error').textContent = 'Sai email hoặc mật khẩu.'; return; }
    $('login-pass').value = '';
    afterLogin();
  };
  $('logout-btn').onclick = async () => {
    if (!confirm('Đăng xuất khỏi máy này?')) return;
    await sb.auth.signOut(); show('login');
  };
  function afterLogin() {
    show('pack');
    housekeeping();
    // Tải trước bộ đọc chữ cho lần quét đầu nhanh hơn
    setTimeout(() => { getOcr().catch(() => {}); prepareZxing(); checkShipReminder(); }, 800);
  }

  async function start() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
      document.body.innerHTML = '<div class="screen"><div class="card" style="margin-top:20vh">App chưa được cài đặt (thiếu SUPABASE_URL / SUPABASE_ANON_KEY trong config.js).</div></div>';
      return;
    }
    const { data } = await sb.auth.getSession();
    if (data.session) afterLogin(); else show('login');
    sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') show('login'); });
  }
  start();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // để kiểm thử
  window.__checkdon = { reportXlsx, reportImage, addShip, ship, scanLabel, readCodes, toBoxFromQR, readNameInBox, extractName, cropToBox, findToBox, flattenBlocks, readQR, readName, loadBitmap, compressStamped, noAccent, fmtTime };
})();
