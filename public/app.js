'use strict';
/* VidToTab frontend. Plain script, no deps. Talks to the endpoints and SSE
   shapes pinned in contracts.md. */
(() => {

  // ---------- helpers ----------

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function fmtTime(t) {
    t = Math.max(0, Math.floor(Number(t) || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const ss = String(s).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function postJSON(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || 'HTTP ' + res.status);
    }
    return res;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load ' + src));
      img.src = src;
    });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------- state ----------

  const state = {
    step: 1,
    maxStep: 1,
    job: 'idle',           // idle | downloading | ready | analyzing | done
    meta: null,
    videoSet: false,
    rect: null,            // CSS px relative to overlay
    selectMode: false,
    startAtZero: false,
    sensitivity: 0.5,
    lastAnalyze: null,     // { rect (native px), startTime } of last POST /api/analyze
    captures: [],
    items: [],             // review rows (captures + unstitched parts), delete = flag
    selected: -1,
    deletedStamps: [],     // {t0,t1} spans of deleted rows; survive re-runs (both ends ±1s)
    undoStack: [],
    snapshotApplied: false,
  };

  const video = $('video');
  const overlay = $('overlay');
  const rectEl = $('rect');
  const sections = [null, $('step1'), $('step2'), $('step3'), $('step4')];
  const stepBtns = Array.from(document.querySelectorAll('#stepper button'));

  const capSrc = (png) => '/captures/' + png; // filenames are run-unique, no cache-buster needed

  // ---------- steps / stepper ----------

  function renderStepper() {
    for (const btn of stepBtns) {
      const n = +btn.dataset.step;
      btn.parentElement.classList.toggle('active', n === state.step);
      btn.disabled = n > state.maxStep;
    }
  }

  function showStep(n) {
    state.step = n;
    if (n > state.maxStep) state.maxStep = n;
    for (let i = 1; i <= 4; i++) sections[i].hidden = i !== n;
    renderStepper();
    if (n === 2) {
      maybeRescaleRect();
      updateStartLine();
      redrawPreview();
    }
    window.scrollTo(0, 0);
  }

  for (const btn of stepBtns) {
    btn.addEventListener('click', () => {
      const n = +btn.dataset.step;
      if (n <= state.maxStep && n !== state.step) showStep(n);
    });
  }

  // ---------- error banner ----------

  function showError(msg, detail) {
    $('errorMsg').textContent = msg;
    const d = $('errorDetails');
    if (detail) {
      d.hidden = false;
      d.open = false;
      $('errorDetailText').textContent = detail;
    } else {
      d.hidden = true;
    }
    $('errorBanner').hidden = false;
    window.scrollTo(0, 0);
  }

  $('errorDismiss').addEventListener('click', () => { $('errorBanner').hidden = true; });
  $('errEscape').addEventListener('click', () => {
    $('errorBanner').hidden = true;
    showStep(1);
    $('fileInput').click();
  });

  // ---------- preflight ----------

  async function checkPreflight() {
    let p = null;
    try { p = await (await fetch('/api/preflight')).json(); } catch { return; }
    const missing = [];
    if (!p.ytdlp) missing.push('yt-dlp');
    if (!p.ffmpeg) missing.push('ffmpeg');
    $('preflight').hidden = missing.length === 0;
    $('preflightMissing').textContent = missing.join(' and ');
    $('urlInput').disabled = !p.ytdlp;
    $('urlInput').placeholder = p.ytdlp ? 'Paste a YouTube link' : 'Install yt-dlp to fetch links';
  }

  $('recheck').addEventListener('click', checkPreflight);
  $('copyBrew').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('brew install yt-dlp ffmpeg');
      $('copyBrew').textContent = 'Copied';
    } catch {
      $('copyBrew').textContent = 'Copy failed';
    }
    setTimeout(() => { $('copyBrew').textContent = 'Copy'; }, 1500);
  });

  // ---------- step 1: source ----------

  function resetForNewSource() {
    state.captures = [];
    state.items = [];
    state.undoStack = [];
    state.deletedStamps = [];
    state.lastAnalyze = null;
    state.startAtZero = false;
    state.selected = -1;
    state.meta = null;
    state.videoSet = false;
    state.maxStep = 1;
    state.job = 'downloading';
    setSelectMode(false);
    setRect(null);
    video.removeAttribute('src');
    video.load();
    $('selectAreaBtn').disabled = true;
    $('metaCard').hidden = true;
    $('fetching').hidden = true;
    $('dlProgress').hidden = true;
    $('errorBanner').hidden = true;
    $('reviewList').textContent = '';
    $('liveStack').textContent = '';
    renderStepper();
  }

  function setDlProgress(pct, label) {
    $('dlProgress').hidden = false;
    if (Number.isFinite(pct)) $('dlBarFill').style.width = clamp(pct, 0, 100) + '%';
    $('dlLabel').textContent = label;
  }

  $('urlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('urlInput').value.trim();
    if (!url) return;
    resetForNewSource();
    $('fetching').hidden = false;
    try {
      await postJSON('/api/video/url', { url });
    } catch (err) {
      $('fetching').hidden = true;
      state.job = 'idle';
      showError('Could not start the download.', String((err && err.message) || err));
    }
  });
  $('urlInput').addEventListener('paste', () => {
    setTimeout(() => $('urlForm').requestSubmit(), 0);
  });

  function uploadFile(file) {
    resetForNewSource();
    setDlProgress(0, 'Uploading ' + file.name + '…');
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/video/file?name=' + encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setDlProgress((e.loaded / e.total) * 100, 'Uploading ' + file.name + '…');
    };
    xhr.onload = () => {
      if (xhr.status >= 400) {
        state.job = 'idle';
        $('dlProgress').hidden = true;
        showError('Upload failed.', xhr.responseText || 'HTTP ' + xhr.status);
      }
    };
    xhr.onerror = () => {
      state.job = 'idle';
      $('dlProgress').hidden = true;
      showError('Upload failed — could not reach the server.');
    };
    xhr.send(file);
  }

  $('chooseFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => {
    const f = $('fileInput').files[0];
    if (f) uploadFile(f);
    $('fileInput').value = '';
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && (f.type.startsWith('video/') || /\.(mp4|mkv|webm|mov|avi|m4v)$/i.test(f.name))) uploadFile(f);
  });

  $('dlCancel').addEventListener('click', () => postJSON('/api/cancel', {}).catch(() => {}));

  function setMeta(meta) {
    state.meta = meta;
    $('fetching').hidden = true;
    $('metaCard').hidden = false;
    $('metaTitle').textContent = meta.title || 'Untitled video';
    $('metaDuration').textContent = meta.duration ? fmtTime(meta.duration) : '';
    const img = $('metaThumb');
    if (meta.thumb) {
      img.hidden = false;
      img.src = '/thumb.jpg?t=' + Date.now();
    } else {
      img.hidden = true;
    }
  }

  function videoReady() {
    if (state.videoSet) return;
    state.videoSet = true;
    video.src = '/api/video';
  }

  function onDownloaded() {
    state.job = 'ready';
    $('dlProgress').hidden = true;
    $('fetching').hidden = true;
    videoReady();
    showStep(2);
  }

  // ---------- step 2: frame & region ----------

  let lastOverlayW = 0;

  function setSelectMode(on) {
    state.selectMode = on;
    overlay.classList.toggle('selecting', on);
    if (on) {
      video.pause();
      video.removeAttribute('controls');
    } else {
      video.setAttribute('controls', '');
    }
    $('selectAreaBtn').hidden = on;
    $('backToScrub').hidden = !on;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  $('selectAreaBtn').addEventListener('click', () => setSelectMode(true));
  $('backToScrub').addEventListener('click', () => setSelectMode(false));

  function setRect(r) {
    state.rect = r || null;
    if (r) {
      rectEl.hidden = false;
      rectEl.style.left = r.x + 'px';
      rectEl.style.top = r.y + 'px';
      rectEl.style.width = r.w + 'px';
      rectEl.style.height = r.h + 'px';
    } else {
      rectEl.hidden = true;
    }
    const ok = !!r && r.w >= 8 && r.h >= 8;
    $('analyzeBtn').disabled = !ok;
    $('analyzeHint').hidden = ok;
    $('cropPreviewWrap').hidden = !r;
    const w = overlay.getBoundingClientRect().width;
    if (w) lastOverlayW = w;
    redrawPreview();
  }

  // Rect is stored in CSS px; if the layout width changes, rescale it so it
  // keeps covering the same video content.
  function maybeRescaleRect() {
    const w = overlay.getBoundingClientRect().width;
    if (!w) return;
    if (state.rect && lastOverlayW && w !== lastOverlayW) {
      const f = w / lastOverlayW;
      setRect({ x: state.rect.x * f, y: state.rect.y * f, w: state.rect.w * f, h: state.rect.h * f });
    }
    lastOverlayW = w;
  }
  window.addEventListener('resize', maybeRescaleRect);

  function toOverlay(e) {
    const r = overlay.getBoundingClientRect();
    return { x: clamp(e.clientX - r.left, 0, r.width), y: clamp(e.clientY - r.top, 0, r.height) };
  }

  function boxFrom(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    };
  }

  let drag = null; // { mode: 'draw'|'move'|'resize', ... }

  overlay.addEventListener('pointerdown', (e) => {
    if (!state.selectMode || e.button !== 0) return;
    e.preventDefault();
    try { overlay.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = toOverlay(e);
    const handle = e.target.dataset ? e.target.dataset.h : null;
    const r = state.rect;
    if (handle && r) {
      drag = { mode: 'resize', handle, orig: { ...r } };
    } else if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
      drag = { mode: 'move', orig: { ...r }, start: p };
    } else {
      drag = { mode: 'draw', anchor: p, prev: r ? { ...r } : null };
    }
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const ob = overlay.getBoundingClientRect();
    const p = toOverlay(e);
    if (drag.mode === 'draw') {
      setRect(boxFrom(drag.anchor.x, drag.anchor.y, p.x, p.y));
    } else if (drag.mode === 'move') {
      setRect({
        x: clamp(drag.orig.x + p.x - drag.start.x, 0, ob.width - drag.orig.w),
        y: clamp(drag.orig.y + p.y - drag.start.y, 0, ob.height - drag.orig.h),
        w: drag.orig.w,
        h: drag.orig.h,
      });
    } else {
      let L = drag.orig.x, T = drag.orig.y;
      let R = drag.orig.x + drag.orig.w, B = drag.orig.y + drag.orig.h;
      if (drag.handle.includes('w')) L = p.x;
      if (drag.handle.includes('e')) R = p.x;
      if (drag.handle.includes('n')) T = p.y;
      if (drag.handle.includes('s')) B = p.y;
      setRect(boxFrom(L, T, R, B));
    }
  });

  function endDrag() {
    if (!drag) return;
    // A tiny "draw" was just a stray click: restore whatever was there before.
    if (drag.mode === 'draw' && state.rect && (state.rect.w < 4 || state.rect.h < 4)) setRect(drag.prev);
    drag = null;
  }
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  function redrawPreview() {
    const r = state.rect;
    if (!r || !video.videoWidth || video.readyState < 2) return;
    const scale = video.getBoundingClientRect().width / video.videoWidth;
    if (!scale) return;
    const canvas = $('cropPreview');
    const sw = Math.max(1, Math.round(r.w / scale));
    const sh = Math.max(1, Math.round(r.h / scale));
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext('2d').drawImage(video, r.x / scale, r.y / scale, sw, sh, 0, 0, sw, sh);
  }

  function updateStartLine() {
    const cur = video.currentTime || 0;
    const t = state.startAtZero ? 0 : cur;
    $('startAt').textContent = fmtTime(t);
    $('startCtx').textContent = state.startAtZero ? '' : ' (current position)';
    $('startZeroBtn').textContent = state.startAtZero ? 'use current position instead' : 'start from 0:00 instead';
    const dur = (state.meta && state.meta.duration) || video.duration || 0;
    const warn = $('longWarn');
    if (dur > 45 * 60) {
      warn.hidden = false;
      const mins = Math.max(1, Math.ceil((dur - t) / 60 / 8));
      warn.textContent = 'This is a long video (' + Math.round(dur / 60) + ' min) — analysis may take around '
        + mins + (mins === 1 ? ' minute.' : ' minutes.');
    } else {
      warn.hidden = true;
    }
  }

  $('startZeroBtn').addEventListener('click', () => {
    state.startAtZero = !state.startAtZero;
    updateStartLine();
  });

  video.addEventListener('loadedmetadata', () => {
    $('selectAreaBtn').disabled = false;
    updateStartLine();
  });
  video.addEventListener('timeupdate', () => { updateStartLine(); redrawPreview(); });
  video.addEventListener('seeked', () => { updateStartLine(); redrawPreview(); });

  // CSS-px rect → native video px: one scale factor (video is width:100%;
  // height:auto, so there is no letterboxing). Rounded to even, clamped.
  function nativeRect() {
    const scale = video.getBoundingClientRect().width / video.videoWidth;
    if (!scale) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    let x = clamp(Math.round(state.rect.x / scale), 0, vw - 2);
    let y = clamp(Math.round(state.rect.y / scale), 0, vh - 2);
    x -= x % 2;
    y -= y % 2;
    let w = clamp(Math.round(state.rect.w / scale), 2, vw - x);
    let h = clamp(Math.round(state.rect.h / scale), 2, vh - y);
    w -= w % 2;
    h -= h % 2;
    return { x, y, w, h };
  }

  async function startAnalyze(sensitivity, reuse) {
    let rect = null, startTime = 0;
    if (reuse && state.lastAnalyze) {
      rect = state.lastAnalyze.rect;
      startTime = state.lastAnalyze.startTime;
    } else if (state.rect && video.videoWidth) {
      rect = nativeRect();
      startTime = state.startAtZero ? 0 : (video.currentTime || 0);
    }
    if (!rect) {
      showStep(2);
      setSelectMode(true);
      return;
    }
    try {
      await postJSON('/api/analyze', { rect, startTime, sensitivity });
      state.lastAnalyze = { rect, startTime };
      state.job = 'analyzing';
      resetProcessing();
      showStep(3);
    } catch (err) {
      showError('Could not start the analysis.', String((err && err.message) || err));
    }
  }

  $('analyzeBtn').addEventListener('click', () => startAnalyze(state.sensitivity, false));

  // ---------- step 3: processing ----------

  function resetProcessing() {
    state.captures = [];
    $('stageLabel').textContent = 'Extracting frames…';
    $('procBarFill').style.width = '0%';
    $('procPct').textContent = '';
    $('warnings').textContent = '';
    $('liveStack').textContent = '';
    $('foundCount').hidden = true;
  }

  function setProcProgress(label, pct, msg) {
    $('stageLabel').textContent = label;
    if (Number.isFinite(pct)) {
      const p = clamp(pct, 0, 100);
      $('procBarFill').style.width = p + '%';
      $('procPct').textContent = Math.round(p) + '%' + (msg ? ' — ' + msg : '');
    } else if (msg) {
      $('procPct').textContent = msg;
    }
  }

  function appendLiveThumb(cap) {
    const img = el('img');
    img.src = capSrc(cap.png);
    img.alt = 'Capture at ' + fmtTime(cap.tStart);
    $('liveStack').appendChild(img);
    const n = state.captures.length;
    $('foundCount').hidden = false;
    $('foundCount').textContent = n + (n === 1 ? ' screen' : ' screens') + ' found so far';
  }

  function addLiveCapture(cap) {
    state.captures.push(cap);
    appendLiveThumb(cap);
  }

  function addWarning(msg) {
    const box = el('div', 'note amber');
    if (/static|barely|no.?chang|little chang/i.test(msg || '')) {
      box.appendChild(el('span', null, 'This region barely changes — did you select the tab? '));
      const b = el('button', 'linklike', 'Adjust region');
      b.type = 'button';
      b.addEventListener('click', () => { showStep(2); setSelectMode(true); });
      box.appendChild(b);
    } else {
      box.appendChild(el('span', null, msg || 'Warning'));
    }
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss warning');
    x.addEventListener('click', () => box.remove());
    box.appendChild(x);
    $('warnings').appendChild(box);
  }

  $('procCancel').addEventListener('click', () => postJSON('/api/cancel', {}).catch(() => {}));

  // ---------- step 4: review ----------

  function visibleIndices() {
    const a = [];
    state.items.forEach((it, i) => { if (!it.deleted) a.push(i); });
    return a;
  }

  // Both span ends must match: a stamp from a deleted unstitched PART shares
  // tStart with its re-stitched strip, and matching tStart alone would silently
  // delete the whole strip (including parts the user explicitly kept).
  const isStamped = (t0, t1) =>
    state.deletedStamps.some((s) => Math.abs(s.t0 - t0) <= 1 && Math.abs(s.t1 - t1) <= 1);

  function buildReview() {
    state.items = state.captures.map((c) => ({
      key: c.id,
      png: c.png,
      w: c.w,
      h: c.h,
      tStart: c.tStart,
      tEnd: c.tEnd,
      alsoAt: c.alsoAt || [],
      parts: (c.parts && c.parts.length > 1) ? c.parts : null,
      deleted: isStamped(c.tStart, c.tEnd),
    }));
    state.selected = -1;
    state.undoStack = [];
    renderReview();
  }

  function renderReview() {
    const meta = state.meta || {};
    $('rvTitle').textContent = meta.title || 'Your captures';
    const link = $('rvSource');
    if (meta.url) {
      link.hidden = false;
      $('rvDot').hidden = false;
      link.href = meta.url;
    } else {
      link.hidden = true;
      $('rvDot').hidden = true;
    }
    const vis = visibleIndices();
    $('rvCount').textContent = vis.length + (vis.length === 1 ? ' screen' : ' screens');

    // Degenerate detection result (independent of user deletions).
    const diag = $('diagCard');
    if (state.items.length <= 1) {
      diag.hidden = false;
      $('diagText').textContent = state.items.length === 0
        ? 'No distinct screens found.'
        : 'Only one distinct screen found.';
    } else {
      diag.hidden = true;
    }

    const list = $('reviewList');
    list.textContent = '';
    state.items.forEach((it, idx) => {
      if (it.deleted) return;
      const row = el('div', 'capRow');
      row.dataset.idx = idx;
      if (idx === state.selected) row.classList.add('selected');

      const bar = el('div', 'capBar');
      const span = (it.tEnd || 0) - (it.tStart || 0);
      const badge = el('button', 'badge time' + (span < 2 ? ' short' : ''),
        fmtTime(it.tStart) + ' → ' + fmtTime(it.tEnd));
      badge.type = 'button';
      badge.title = (span < 2 ? 'Very short — possible artifact. ' : '') + 'Jump to this moment in the video';
      badge.addEventListener('click', (e) => { e.stopPropagation(); seekToSource(it.tStart); });
      bar.appendChild(badge);

      if (it.parts) {
        bar.appendChild(el('span', 'badge', 'stitched from ' + it.parts.length + ' screens'));
        const un = el('button', 'badge action', 'Unstitch');
        un.type = 'button';
        un.addEventListener('click', (e) => { e.stopPropagation(); unstitch(idx); });
        bar.appendChild(un);
      }

      for (const t of it.alsoAt) bar.appendChild(el('span', 'badge chip', 'also at ' + fmtTime(t)));

      const del = el('button', 'del', '×');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete this screen');
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteItem(idx); });
      bar.appendChild(del);

      const img = el('img');
      img.src = capSrc(it.png);
      img.alt = 'Captured tab, ' + fmtTime(it.tStart) + ' to ' + fmtTime(it.tEnd);
      if (!it.w || !it.h) {
        img.addEventListener('load', () => { it.w = img.naturalWidth; it.h = img.naturalHeight; });
      }

      row.appendChild(bar);
      row.appendChild(img);
      row.addEventListener('click', () => selectItem(idx));
      list.appendChild(row);
    });
  }

  function selectItem(idx) {
    state.selected = idx;
    for (const r of $('reviewList').children) {
      r.classList.toggle('selected', +r.dataset.idx === idx);
    }
  }

  function moveSelection(dir) {
    const vis = visibleIndices();
    if (!vis.length) return;
    let pos = vis.indexOf(state.selected);
    pos = pos === -1 ? (dir > 0 ? 0 : vis.length - 1) : clamp(pos + dir, 0, vis.length - 1);
    selectItem(vis[pos]);
    const row = $('reviewList').querySelector('[data-idx="' + vis[pos] + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function deleteItem(idx) {
    const it = state.items[idx];
    if (!it || it.deleted) return;
    it.deleted = true;
    state.deletedStamps.push({ t0: it.tStart, t1: it.tEnd });
    state.undoStack.push(it);
    if (state.selected === idx) {
      const vis = visibleIndices();
      const next = vis.find((i) => i > idx);
      state.selected = next !== undefined ? next : (vis.length ? vis[vis.length - 1] : -1);
    }
    renderReview();
    showToast('Screen deleted');
  }

  function undo() {
    const it = state.undoStack.pop();
    if (!it) return;
    it.deleted = false;
    const i = state.deletedStamps.findIndex(
      (s) => Math.abs(s.t0 - it.tStart) <= 1 && Math.abs(s.t1 - it.tEnd) <= 1);
    if (i >= 0) state.deletedStamps.splice(i, 1);
    hideToast();
    renderReview();
  }

  function unstitch(idx) {
    const it = state.items[idx];
    if (!it || !it.parts) return;
    const parts = it.parts.map((p, i) => ({
      key: it.key + '-part' + i,
      png: p.png,
      w: it.w,       // parts share the strip's width; height read from the image
      h: 0,
      tStart: p.tStart,
      tEnd: p.tEnd,
      alsoAt: [],
      parts: null,
      deleted: isStamped(p.tStart, p.tEnd),
    }));
    state.items.splice(idx, 1, ...parts);
    state.selected = -1;
    renderReview();
  }

  function seekToSource(t) {
    if (!state.videoSet) return;
    setSelectMode(false);
    showStep(2);
    try { video.currentTime = t; } catch { /* not seekable yet */ }
    video.pause();
  }

  // toast
  let toastTimer = 0;
  function showToast(msg) {
    $('toastMsg').textContent = msg;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').hidden = true;
  }
  $('toastUndo').addEventListener('click', undo);

  // detection disclosure
  for (const r of document.querySelectorAll('input[name="sens"]')) {
    r.addEventListener('change', () => {
      state.sensitivity = parseFloat(r.value);
      startAnalyze(state.sensitivity, true);
    });
  }

  $('diagAdjust').addEventListener('click', () => { showStep(2); setSelectMode(true); });
  $('diagMore').addEventListener('click', () => {
    const r = document.querySelector('input[name="sens"][value="0.75"]');
    if (r) r.checked = true;
    state.sensitivity = 0.75;
    startAnalyze(0.75, true);
  });

  // ---------- exports ----------

  function exportName() {
    const t = (state.meta && state.meta.title) || 'vidtotab';
    return t.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'vidtotab';
  }

  async function fillDims(items) {
    for (const it of items) {
      if (!it.w || !it.h) {
        const img = await loadImage(capSrc(it.png));
        it.w = img.naturalWidth;
        it.h = img.naturalHeight;
      }
    }
  }

  async function exportPdf() {
    const vis = state.items.filter((it) => !it.deleted);
    if (!vis.length) return;
    const btn = $('exportPdf');
    btn.disabled = true;
    try {
      await fillDims(vis);
      const meta = state.meta || {};
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: meta.title || 'VidToTab',
          url: meta.url || '',
          items: vis.map((it) => ({ png: it.png, w: it.w, h: it.h })),
        }),
      });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'HTTP ' + res.status);
      downloadBlob(await res.blob(), exportName() + '.pdf');
    } catch (err) {
      showError('PDF export failed.', String((err && err.message) || err));
    } finally {
      btn.disabled = false;
    }
  }

  async function exportPng() {
    const vis = state.items.filter((it) => !it.deleted);
    if (!vis.length) return;
    const btn = $('exportPng');
    btn.disabled = true;
    try {
      const imgs = [];
      for (const it of vis) imgs.push(await loadImage(capSrc(it.png)));
      const meta = state.meta || {};
      const thumb = meta.thumb ? await loadImage('/thumb.jpg').catch(() => null) : null;
      const pad = 24, gap = 16, headerH = 110;
      const W = Math.max(600, ...imgs.map((i) => i.naturalWidth)) + pad * 2;
      // ponytail: canvas height ceiling ~32k px; move server-side if someone hits it.
      const H = headerH + imgs.reduce((s, i) => s + i.naturalHeight + gap, 0) + pad;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      const textW = W - pad * 2 - (thumb ? 180 : 0);
      ctx.fillStyle = '#111';
      ctx.font = '600 28px system-ui, sans-serif';
      ctx.fillText(meta.title || 'VidToTab captures', pad, pad + 26, textW);
      if (meta.url) {
        ctx.fillStyle = '#777';
        ctx.font = '15px system-ui, sans-serif';
        ctx.fillText(meta.url, pad, pad + 54, textW);
      }
      if (thumb) {
        const th = 70, tw = th * thumb.naturalWidth / thumb.naturalHeight;
        ctx.drawImage(thumb, W - pad - tw, pad, tw, th);
      }
      let y = headerH;
      for (const img of imgs) {
        ctx.drawImage(img, pad, y);
        y += img.naturalHeight + gap;
      }
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('The composed image is too large for this browser.');
      downloadBlob(blob, exportName() + '.png');
    } catch (err) {
      showError('PNG export failed.', String((err && err.message) || err));
    } finally {
      btn.disabled = false;
    }
  }

  $('exportPdf').addEventListener('click', exportPdf);
  $('exportPng').addEventListener('click', exportPng);

  // ---------- keyboard ----------

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof Element) {
      if (t.matches('input, textarea, select')) return;
      if ((e.key === 'Enter' || e.key === ' ') && t.matches('button, a, summary, label')) return;
    }
    if (state.step === 2) step2Keys(e);
    else if (state.step === 4) step4Keys(e);
  });

  function seekBy(delta) {
    if (!video.duration) return;
    video.currentTime = clamp(video.currentTime + delta, 0, video.duration);
  }

  function step2Keys(e) {
    if (!state.videoSet) return;
    const k = e.key;
    const isArrow = k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown';
    if (state.selectMode && state.rect && isArrow) {
      e.preventDefault();
      const r = { ...state.rect };
      if (e.shiftKey) {
        if (k === 'ArrowRight') r.w += 1;
        if (k === 'ArrowLeft') r.w -= 1;
        if (k === 'ArrowDown') r.h += 1;
        if (k === 'ArrowUp') r.h -= 1;
      } else {
        if (k === 'ArrowRight') r.x += 1;
        if (k === 'ArrowLeft') r.x -= 1;
        if (k === 'ArrowDown') r.y += 1;
        if (k === 'ArrowUp') r.y -= 1;
      }
      const ob = overlay.getBoundingClientRect();
      r.w = clamp(r.w, 4, ob.width - r.x);
      r.h = clamp(r.h, 4, ob.height - r.y);
      r.x = clamp(r.x, 0, ob.width - r.w);
      r.y = clamp(r.y, 0, ob.height - r.h);
      setRect(r);
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      seekBy(k === 'ArrowRight' ? 5 : -5);
    } else if ((k === ',' || k === '.') && video.paused) {
      e.preventDefault();
      seekBy((k === '.' ? 1 : -1) / 30);
    }
  }

  function step4Keys(e) {
    switch (e.key) {
      case 'j': case 'ArrowDown':
        e.preventDefault();
        moveSelection(1);
        break;
      case 'k': case 'ArrowUp':
        e.preventDefault();
        moveSelection(-1);
        break;
      case 'x': case 'Delete': case 'Backspace':
        if (state.selected >= 0) {
          e.preventDefault();
          deleteItem(state.selected);
        }
        break;
      case 'u':
        e.preventDefault();
        undo();
        break;
      case 'Enter': {
        const it = state.items[state.selected];
        if (it && !it.deleted) {
          e.preventDefault();
          seekToSource(it.tStart);
        }
        break;
      }
    }
  }

  // ---------- SSE ----------

  function onDone(captures) {
    state.captures = Array.isArray(captures) ? captures : state.captures;
    state.job = 'done';
    setProcProgress('Detecting tab screens…', 100);
    buildReview();
    showStep(4);
  }

  function onErrorEvent(ev) {
    showError(ev.msg || 'Something went wrong.', ev.detail);
    if (state.job === 'downloading') {
      state.job = 'idle';
      $('dlProgress').hidden = true;
      $('fetching').hidden = true;
      if (state.step !== 1) showStep(1);
    } else if (state.job === 'analyzing') {
      state.job = state.videoSet ? 'ready' : 'idle';
      if (state.step === 3) showStep(state.videoSet ? 2 : 1);
    }
  }

  function onCancelled() {
    if (state.job === 'analyzing') {
      state.job = 'ready';
      if (state.step === 3) showStep(state.items.length ? 4 : 2);
    } else if (state.job === 'downloading') {
      state.job = 'idle';
      $('dlProgress').hidden = true;
      $('fetching').hidden = true;
      if (state.step !== 1) showStep(1);
    }
  }

  function applySnapshot(ev) {
    if (state.snapshotApplied) {
      // Reconnected mid-session (sleep, network blip): reconcile any terminal
      // transition we missed, no matter which step the user is looking at —
      // otherwise a finished/failed run leaves the UI stuck forever.
      if (ev.meta) setMeta(ev.meta);
      if (ev.job === 'done' && state.job !== 'done') {
        onDone(ev.captures || state.captures); // matches live behavior: 'done' always shows step 4
      } else if (ev.job === 'ready' && state.job === 'downloading') {
        onDownloaded();
      } else if (ev.job === 'ready' && state.job === 'analyzing') {
        // analysis ended without captures while we were away (error/cancel)
        state.job = 'ready';
        if (state.step === 3) showStep(state.items.length ? 4 : 2);
      } else if (ev.job === 'idle' && state.job !== 'idle') {
        // download failed/cancelled while we were away
        state.job = 'idle';
        $('dlProgress').hidden = true;
        $('fetching').hidden = true;
        if (state.step !== 1) showStep(1);
      }
      return;
    }
    state.snapshotApplied = true;
    if (ev.meta) setMeta(ev.meta);
    if (Array.isArray(ev.captures)) state.captures = ev.captures;
    switch (ev.job) {
      case 'downloading':
        state.job = 'downloading';
        $('dlProgress').hidden = false;
        if (!state.meta) $('fetching').hidden = false;
        showStep(1);
        break;
      case 'ready':
        onDownloaded();
        break;
      case 'analyzing':
        state.job = 'analyzing';
        videoReady();
        for (const c of state.captures) appendLiveThumb(c);
        showStep(3);
        break;
      case 'done':
        state.job = 'done';
        videoReady();
        buildReview();
        showStep(4);
        break;
      default:
        showStep(1);
    }
  }

  function handleEvent(ev) {
    switch (ev.phase) {
      case 'state':
        applySnapshot(ev);
        break;
      case 'download':
        state.job = 'downloading';
        $('fetching').hidden = state.meta !== null ? true : $('fetching').hidden;
        setDlProgress(ev.pct, (Number.isFinite(ev.pct) ? Math.round(clamp(ev.pct, 0, 100)) + '%' : '')
          + (ev.msg ? ' ' + ev.msg : ''));
        break;
      case 'meta':
        setMeta(ev.meta);
        break;
      case 'downloaded':
        onDownloaded();
        break;
      case 'analyze':
        setProcProgress('Extracting frames…', ev.pct, ev.msg);
        break;
      case 'composite':
        setProcProgress('Detecting tab screens…', ev.pct, ev.msg);
        break;
      case 'capture':
        addLiveCapture(ev.capture);
        break;
      case 'warning':
        addWarning(ev.msg);
        break;
      case 'done':
        onDone(ev.captures);
        break;
      case 'error':
        onErrorEvent(ev);
        break;
      case 'cancelled':
        onCancelled();
        break;
    }
  }

  function connectSSE() {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      handleEvent(ev);
    };
    // EventSource reconnects on its own; the server resends a state snapshot.
  }

  // ---------- init ----------

  checkPreflight();
  connectSSE();
  renderStepper();

})();
