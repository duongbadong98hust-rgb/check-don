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
  function stamp(canvas, lines) {
    const ctx = canvas.getContext('2d');
    const fs = Math.max(18, Math.round(Math.min(canvas.width, canvas.height) / 22));
    ctx.font = `bold ${fs}px -apple-system, Roboto, "Segoe UI", Arial, sans-serif`;
    const padX = Math.round(fs * 0.5), lh = Math.round(fs * 1.3);
    const maxW = canvas.width - padX * 4;
    const fit = (t) => {
      if (ctx.measureText(t).width <= maxW) return t;
      while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      return t + '…';
    };
    lines = lines.filter(Boolean).map(fit);
    const boxW = Math.max(...lines.map((t) => ctx.measureText(t).width)) + padX * 2;
    const boxH = lh * lines.length + padX;
    const x = padX, y = canvas.height - boxH - padX;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(x, y, boxW, boxH);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
    lines.forEach((t, i) => ctx.fillText(t, x + padX, y + padX * 0.6 + i * lh));
  }

  async function compressStamped(src, lines) {
    for (const side of [PHOTO_MAX_SIDE, 1080, 900]) {
      const c = drawScaled(src, side);
      stamp(c, lines);
      for (const q of [0.72, 0.62, 0.52, 0.44]) {
        const b = await toBlob(c, q);
        if (b.size <= PHOTO_MAX_BYTES) return b;
      }
    }
    const c = drawScaled(src, 800); stamp(c, lines);
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
  async function readQR(src) {
    // 1) Trình đọc có sẵn của trình duyệt (Android Chrome)
    if ('BarcodeDetector' in window) {
      try {
        const det = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
        const found = await det.detect(drawScaled(src, 1600));
        const qr = found.filter((f) => f.format === 'qr_code').map((f) => f.rawValue);
        const code = pickCode(qr.length ? qr : found.map((f) => f.rawValue));
        if (code) return code;
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
      const qr = res.filter((r) => r.format === 'QRCode').map((r) => r.text);
      const code = pickCode(qr.length ? qr : res.map((r) => r.text));
      if (code) return code;
    }
    return '';
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
          } else if (w.confidence < 40) continue;
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
    const c = drawScaled(src, 1600);
    const { data } = await worker.recognize(c, {}, { text: true, blocks: true });
    return { name: extractName(flattenBlocks(data)), data };
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
    const qrP = readQR(src).catch((e) => { console.error(e); return ''; });
    const nameP = readName(src).catch((e) => { console.error(e); return { name: '' }; });
    const tracking = await qrP;
    status(statusEl, tracking ? `✓ Mã: ${tracking}. ⏳ Đang đọc tên khách…` : '⏳ Đang đọc tên khách…');
    const { name } = await nameP;
    return { tracking, name, src };
  }

  // ---------- Trạng thái màn đóng hàng ----------
  let photos = []; // { file, url }
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
    prev.src = URL.createObjectURL(file); prev.hidden = false;
    try {
      const { tracking, name } = await scanLabel(file, $('label-status'));
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
      for (let i = 0; i < photos.length; i++) {
        status(st, `⏳ Đang xử lý và tải ảnh ${i + 1}/${photos.length}…`);
        const blob = await compressStamped(await loadBitmap(photos[i].file), lines);
        const path = `${folder}/${tracking.replace(/[^A-Z0-9_-]/gi, '_')}_${stampId}_${i + 1}.jpg`;
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
      $('usage').textContent = `Bộ nhớ ảnh: ${mb(used)} MB / 1.024 MB (${pct}%). Ảnh tự xoá sau 3 tháng.`;
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
  function resultHtml(r) {
    const n = (r.photos || []).length;
    return `<button class="result" data-id="${r.id}">
      <b>${esc(r.customer || '(chưa có tên)')}</b>
      <div class="trk">${esc(r.tracking)}</div>
      <div class="meta">🕒 ${esc(fmtTime(r.packed_at))} · ${n} ảnh</div></button>`;
  }
  let lastResults = [];
  async function search(q) {
    const st = $('search-status');
    q = (q || '').trim();
    status(st, '⏳ Đang tìm…');
    let query = sb.from('orders').select('id,tracking,customer,packed_at,photos')
      .order('packed_at', { ascending: false }).limit(50);
    if (q) {
      const safe = (s) => s.replace(/[,()%*\\"]/g, ' ').trim();
      const t = safe(q.toUpperCase()).replace(/\s+/g, '');
      const n = safe(noAccent(q));
      query = query.or(`tracking.ilike.*${t}*,customer_norm.ilike.*${n}*`);
    }
    const { data, error } = await query;
    if (error) { status(st, 'Lỗi tìm kiếm: ' + error.message, 'err'); return; }
    lastResults = data;
    status(st, q ? (data.length ? `Tìm thấy ${data.length} đơn.` : 'Không tìm thấy đơn nào.') : '');
    $('results').innerHTML = (q ? '' : '<div class="section-title">Đơn mới đóng gần đây</div>')
      + data.map(resultHtml).join('');
    if (q && data.length === 1) openDetail(data[0]);
  }
  $('search-form').onsubmit = (e) => { e.preventDefault(); $('q').blur(); search($('q').value); };
  $('results').onclick = (e) => {
    const b = e.target.closest('.result'); if (!b) return;
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
      search(code);
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
    box.innerHTML = (r.photos || []).map(() => '<img class="detail-photo" alt="">').join('');
    show('detail');
    const paths = (r.photos || []).map((p) => p.path);
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
      show('search'); showUsage();
    } catch (err) { toast('Xoá không được: ' + (err.message || err)); }
  };

  // ---------- Điều hướng ----------
  let activeTab = 'pack';
  function show(name) {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== 'screen-' + name;
    $('tabs').hidden = name === 'login';
    if (name === 'pack' || name === 'search') {
      activeTab = name;
      for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
    }
  }
  $('tabs').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    show(b.dataset.tab);
    if (b.dataset.tab === 'search' && !lastResults.length) search('');
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
    setTimeout(() => { getOcr().catch(() => {}); prepareZxing(); }, 800);
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
  window.__checkdon = { extractName, flattenBlocks, readQR, readName, loadBitmap, compressStamped, noAccent, fmtTime };
})();
