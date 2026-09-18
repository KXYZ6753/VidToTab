'use strict';
/* VidToTab frontend — no dependencies. Talks to server.js over JSON endpoints
   and one SSE stream (/api/events). Analysis events carry a runId; anything
   from an older run is ignored. Loaded as a module so the preview can share the
   look maths with the PNG and PDF exports instead of reimplementing it. */
import { LOOKS, applyLook, inkRgb, isIdentity, isOriginal, lookById, mixRgb, paperRgb, rgbCss } from '/shared/look.js';
import { deleteSheet, getSheet, hasStorage, listSheets, newId, requestPersistence, saveSheet } from '/lib/library.js';
import { createLoader } from '/brand/loaders.js';

(() => {

  // ---------- helpers ----------

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // The bridge the Electron preload exposes; absent in a browser, and absent in
  // a browser that has blocked it, so the read is guarded. It lives up here
  // rather than beside isAppView because start-up asks it well before that
  // section is reached, and a const is unreachable until its own line runs.
  const isDesktop = () => { try { return window.vidtotab?.shell === 'desktop'; } catch { return false; } };
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  function fmtTime(t) {
    t = Math.max(0, Math.floor(Number(t) || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // One loader per wait the app actually has: reading the video, finding the
  // tab, scanning. Built once, because each carries a running loop and
  // rebuilding it on a state change would restart the beat the others are
  // keeping. The export loader is built per click instead — it lives inside a
  // button whose label it replaces.
  const loaders = {
    meta: createLoader('strings'),
    detect: createLoader('beam'),
    scan: createLoader('scan'),
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Static, trusted SVG markup only.
  function icon(markup) {
    const s = el('span');
    s.innerHTML = markup;
    return s.firstElementChild;
  }
  const ICON = {
    check: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>',
    warn: '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="9" y="4" width="2" height="8" rx="1"/><rect x="9" y="14" width="2" height="2" rx="1"/></svg>',
    clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2 1.6"/></svg>',
    trash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4h4v2M6 6l.8 10h6.4L14 6"/></svg>',
  };

  async function api(path, body) {
    // Always JSON, even when there is nothing to send: the server rejects POSTs
    // without it, and that is what stops another open web page from driving
    // this one (a bodyless POST needs no CORS preflight).
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;
    if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
    return data;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load ' + src));
      img.src = src;
    });
  }

  // Recolour a clean (greyscale) capture with the shared look maths and hand
  // back a canvas, usable as an image source or drawn straight into a larger
  // one. Print and Original never come here: their pixels are already right, so
  // the stored file is used untouched and nothing is uploaded for them.
  async function recolouredCanvas(src, look) {
    const img = await loadImage(src);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    applyLook(data.data, look);
    ctx.putImageData(data, 0, 0);
    return c;
  }

  // <img> exposes naturalWidth, <canvas> only width — normalise so the export
  // maths works for both kinds of source.
  const srcW = (i) => i.naturalWidth || i.width;
  const srcH = (i) => i.naturalHeight || i.height;

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Keep letters of every script; drop only what filesystems reject.
  const fileSafe = (s) => String(s || '').normalize('NFKC')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'vidtotab';

  // "Song (Fingerstyle Guitar Cover | TAB Tutorial)" -> "Song"
  function suggestTitle(raw) {
    const orig = String(raw || '').trim();
    let s = orig
      .replace(/[([【（［][^)\]】）］]*(tab|cover|tutorial|lesson|chord|fingerstyle|guitar|譜|기타)[^)\]】）］]*[)\]】）］]/gi, ' ')
      .replace(/【[★☆\s]+】/g, ' ')
      .replace(/\b(fingerstyle guitar cover|fingerstyle cover|guitar cover|tab & chord tutorial|tab tutorial|guitar tutorial|guitar lesson)\b/gi, ' ');
    for (let i = 0; i < 4; i++) {
      s = s.replace(/\s*[-|–+·]\s*(cover|tab|tabs|fingerstyle|guitar|tutorial|lesson)?\s*$/i, '').trim();
    }
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s.length >= 3 ? s : orig;
  }

  // ---------- state ----------

  const defaultPaper = /^(en-US|en-CA|es-MX|fil)/i.test(navigator.language || '') ? 'letter' : 'a4';
  const state = {
    step: 1,
    maxStep: 1,
    job: 'idle',            // idle | downloading | ready | analyzing | done
    meta: null,
    videoSet: false,
    thumbVersion: 0,
    suggestion: null,       // {crop, confidence, polarity, startTime, tabRange} | {crop:null}
    detecting: false,
    seekedToTab: false,
    rect: null,             // native video px
    rectSource: null,       // 'auto' | 'user'
    selectMode: false,
    startMode: 'auto',      // auto | suggested | current | zero
    sensitivity: 0.5,
    runId: 0,
    lastAnalyze: null,      // {rect (native px), startTime, sensitivity}
    captures: [],
    items: [],
    selected: -1,
    deletedStamps: [],      // {t0,t1} of removed pages; survive re-scans
    undoStack: [],
    warnings: [],           // shown on both the scan and songsheet steps
    jobId: null,            // newest job seen; older events are ignored
    // 'clean' was the old id for Print. lookById falls back to Print for
    // anything it does not recognise, so a stored value from before still works.
    look: lookById(store.get('vtt.look', 'print')).id,
    paper: store.get('vtt.paper', defaultPaper) === 'a4' ? 'a4' : 'letter',
    title: '',
    sheetId: null,          // library record this scan belongs to
    practice: -1,           // page shown in the full-screen reader, -1 = closed
    fromLibrary: false,     // opened from storage: no video, so no steps 2-3
    snapshotApplied: false,
  };

  const video = $('video');
  const overlay = $('overlay');
  const rectEl = $('rect');
  const sections = [null, $('step1'), $('step2'), $('step3'), $('step4')];
  const stepBtns = Array.from(document.querySelectorAll('#stepper button'));
  const capSrc = (png) => '/captures/' + encodeURIComponent(png); // run-unique names: cache-safe

  // ---------- steps ----------

  function renderStepper() {
    for (const btn of stepBtns) {
      const n = +btn.dataset.step;
      const li = btn.parentElement;
      li.classList.toggle('active', n === state.step);
      li.classList.toggle('done', n < state.step);
      // A songsheet opened from the library has no video behind it, so the
      // steps that need one stay shut. Reaching them showed an empty video
      // stage, which reads as broken rather than as "there is nothing here".
      const needsVideo = n === 2 || n === 3;
      btn.disabled = n > state.maxStep
        || (n === 3 && state.job !== 'analyzing')
        || (needsVideo && state.fromLibrary);
    }
    syncSidebar();
  }

  // index.html decided before paint whether to play the opening animation, and
  // hid the app behind it if so. Lift that cover as soon as the overlay is
  // actually on screen rather than when it finishes: the app is then already
  // there underneath, so the splash fades into it instead of cutting to a page
  // that was not there a moment ago. Every failure path reveals — the splash is
  // decoration, and decoration must never be what stands between someone and
  // the app.
  if (document.documentElement.dataset.splash === '1') {
    const reveal = () => { delete document.documentElement.dataset.splash; };
    import('/brand/splash.js')
      .then(({ playSplash }) => {
        const done = playSplash();
        requestAnimationFrame(() => requestAnimationFrame(reveal));
        return done;
      })
      .catch(reveal)
      .finally(reveal);
  }

  document.getElementById('metaLoaderSlot').append(loaders.meta.el);
  document.getElementById('detectLoaderSlot').append(loaders.detect.el);
  document.getElementById('scanLoaderSlot').append(loaders.scan.el);

  // Inside the desktop app there is no landing page, and no app to go and get.
  // The toggle is hidden rather than removed because the end-to-end test looks
  // it up by id after reloading as the desktop shell; the download card is
  // removed outright, so a screen reader cannot reach an advert for the thing
  // it is already running.
  if (isDesktop()) {
    $('viewToggle').hidden = true;
    $('getApp')?.remove();
  }

  // The version comes from the server that is serving this page, not from
  // anything baked in when it was built: a tab left open against a server that
  // has since been upgraded would otherwise go on claiming the old one.
  // /api/health is the endpoint meant to be polled, and the only one carrying it.
  (async () => {
    try {
      const { version } = await (await fetch('/api/health')).json();
      if (!version) return;
      const el = $('appVersion');
      el.textContent = `v${version}`;
      el.title = `VidToTab ${version}`;
      el.hidden = false;
    } catch { /* an older server without the field, or none reachable: no badge */ }
  })();

  // The shimmer is the shape of a thumbnail that has not arrived; the strings
  // say the app is still reading the video. They were being set in one place
  // and cleared in another, which is how they drift, so they move together
  // through here.
  function setThumbLoading(on) {
    $('thumbShimmer').hidden = !on;
    if (on) loaders.meta.show(); else loaders.meta.hide();
  }

  function showStep(n) {
    const from = state.step;
    const changed = n !== from;
    state.step = n;
    state.maxStep = Math.max(state.maxStep, n);
    // Which way the step came from, set before it is unhidden: the animation is
    // restarted by the section leaving display:none, so the attribute that
    // chooses which animation has to already be on it by then.
    if (changed) sections[n].dataset.dir = n > from ? 'fwd' : 'back';
    for (let i = 1; i <= 4; i++) sections[i].hidden = i !== n;
    if (n !== 3) loaders.scan.hide();
    renderStepper();
    // Every route home funnels through here — the stepper, backToSource, and
    // the internal calls — so the saved songsheets are refreshed in one place.
    // Hooking only backToSource missed the stepper, which is how a freshly
    // saved sheet failed to appear at all.
    if (n === 1) renderLibrary();
    if (n === 2) {
      layoutVideo();
      updateDetectUI();
      updateStartSeg();
      redrawPreview();
    }
    if (changed) {
      window.scrollTo({ top: 0 });
      // Focus follows the step. Hiding the section that held the focused
      // control otherwise drops focus onto <body>, leaving a keyboard user to
      // tab from the top of the page again on every step change.
      sections[n]?.focus?.({ preventScroll: true });
    }
  }

  for (const btn of stepBtns) {
    btn.addEventListener('click', () => {
      const n = +btn.dataset.step;
      if (n <= state.maxStep && n !== state.step) showStep(n);
    });
  }

  // ---------- home / app view ----------

  // Two front doors onto the same document. The landing page still explains the
  // thing to someone who arrived from a link; the app view drops the pitch and
  // puts a sidebar beside the workspace, because someone who already has
  // songsheets wants to switch between them, not be sold to again.
  //
  // The starting value is chosen by the inline script in index.html — before
  // paint, so a desktop launch does not flash the landing page. Here we only
  // read it back, keep the button honest, and remember what was chosen.
  const isAppView = () => document.body.dataset.view === 'app';

  function setView(view, remember = true) {
    const app = view === 'app';
    document.body.dataset.view = app ? 'app' : 'home';
    $('viewToggleLabel').textContent = app ? 'Home' : 'Open the app';
    // The label is hidden on a phone, so the name has to survive without it.
    $('viewToggle').setAttribute('aria-label', app ? 'Back to the home page' : 'Open the app view');
    $('viewToggle').title = app
      ? 'Back to the home page'
      : 'A working layout, with your songsheets alongside';
    $('viewIconApp').hidden = app;
    $('viewIconHome').hidden = !app;
    if (remember) store.set('vtt.view', app ? 'app' : 'home');
  }

  $('viewToggle').addEventListener('click', () => {
    setView(isAppView() ? 'home' : 'app');
    // The sidebar must be right the moment it appears, and a songsheet may have
    // been saved or removed since it was last drawn.
    if (isAppView()) renderLibrary();
  });

  // "New scan". A songsheet opened from the library has no video behind it, so
  // leaving it loaded would put its title on the source card as though a video
  // were ready — clear it exactly the way a cancelled download is cleared. A
  // real video is left alone: throwing away a download or a scan in progress is
  // not what "new" means, and the stepper is still the way back to it.
  function newScan() {
    if (state.fromLibrary) {
      releaseHeldUrls();
      Object.assign(state, {
        fromLibrary: false, sheetId: null, meta: null, captures: [], items: [],
        selected: -1, undoStack: [], maxStep: 1, title: '',
      });
      $('reviewList').textContent = '';
      state.meta = null;
      backToSource();
      return;
    }
    showStep(1);
  }

  $('sideNew').addEventListener('click', newScan);
  $('sidePractice').addEventListener('click', () => openPractice());

  // The sidebar follows state that changes three steps away — a scan finishing,
  // a page being removed, a stored sheet being opened — so it is refreshed from
  // the two places that already redraw the chrome rather than from each action.
  function syncSidebar() {
    for (const b of $('sideList').querySelectorAll('.side-item')) {
      if (state.sheetId && b.dataset.sheet === state.sheetId) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
    // Disabled rather than merely refused on click: a row that looks live and
    // then declines is worse than one that says it is not available yet.
    const busy = scanBusy();
    for (const b of $('sideList').querySelectorAll('.side-item')) b.disabled = busy;
    $('sideBusy').hidden = !busy;
    const ready = state.items.some((it) => !it.deleted);
    $('sidePractice').disabled = !ready;
    $('sidePracticeWhy').hidden = ready;
  }

  // ---------- banners ----------

  function showError(msg, detail, { escape = false } = {}) {
    $('errorMsg').textContent = msg;
    const d = $('errorDetails');
    d.hidden = !detail;
    d.open = false;
    $('errorDetailText').textContent = detail || '';
    $('errorEscape').hidden = !escape;
    $('errorBanner').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const hideError = () => { $('errorBanner').hidden = true; };
  $('errorDismiss').addEventListener('click', hideError);
  $('errEscape').addEventListener('click', () => {
    hideError();
    showStep(1);
    $('fileInput').click();
  });

  // Built here rather than in the markup: the preflight banner is specifically
  // about tools that are missing, and an installed-but-old yt-dlp is a
  // different message with a different fix.
  let staleEl = null;
  function staleBanner(show, version, ageDays) {
    if (!show) { staleEl?.remove(); staleEl = null; return; }
    if (staleEl) return;
    staleEl = el('div', 'banner warn');
    staleEl.appendChild(icon(ICON.warn)).classList.add('icon');
    const body = el('div', 'body');
    body.appendChild(el('p', null,
      `yt-dlp is ${ageDays} days old (${version}). YouTube changes every few weeks, and an out-of-date copy fails in ways that look like a broken link.`));
    const row = el('p', 'row wrap');
    row.style.marginTop = '6px';
    row.appendChild(el('code', null, 'brew upgrade yt-dlp'));
    body.appendChild(row);
    staleEl.appendChild(body);
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', () => { staleEl?.remove(); staleEl = null; });
    staleEl.appendChild(x);
    $('preflight').insertAdjacentElement('afterend', staleEl);
  }

  async function checkPreflight() {
    let p;
    try { p = await (await fetch('/api/preflight')).json(); } catch { return; }
    const missing = [!p.ytdlp && 'yt-dlp', !p.ffmpeg && 'ffmpeg'].filter(Boolean);
    $('preflight').hidden = missing.length === 0;
    $('preflightMissing').textContent = missing.join(' and ');
    // Installed but old is its own problem: YouTube changes every few weeks and
    // a stale yt-dlp fails in ways that read as "this link is broken".
    staleBanner(p.ytdlp && p.ytdlpStale, p.ytdlpVersion, p.ytdlpAgeDays);
    $('urlInput').disabled = !p.ytdlp;
    $('urlSubmit').disabled = !p.ytdlp;
    $('urlInput').placeholder = p.ytdlp ? 'https://www.youtube.com/watch?v=…' : 'Install yt-dlp to paste links';
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

  // ---------- 1. video ----------

  // The save in flight, if any. A new video wipes the work folder server-side,
  // so anything still being read out of it has to finish first.
  let sheetSave = null;
  const settleSave = () => (sheetSave ? sheetSave.catch(() => {}) : Promise.resolve());

  function resetForNewSource(label) {
    Object.assign(state, {
      captures: [], items: [], undoStack: [], deletedStamps: [], lastAnalyze: null, suggestion: null,
      seekedToTab: false, rect: null, rectSource: null, startMode: 'auto', meta: null, videoSet: false,
      maxStep: 1, job: 'downloading', title: '', selected: -1,
      // Sensitivity belongs to a video, not to the session: leaving it at the
      // previous song's "Fewer pages" silently merged pages in the next one,
      // from a control hidden inside a collapsed section.
      sensitivity: 0.5, warnings: [], jobId: null, sheetId: null, fromLibrary: false,
    });
    $('librarySection').hidden = true;
    updateSensSeg();
    setSelectMode(false);
    rectEl.hidden = true;
    video.removeAttribute('src');
    video.load();
    hideError();
    $('sourceCard').hidden = false;
    $('metaThumb').hidden = true;
    setThumbLoading(true);
    $('metaTitle').textContent = label;
    $('metaSub').textContent = '';
    $('how').hidden = true;
    setDlProgress(null, 'Starting…');
    $('reviewList').textContent = '';
    $('liveGrid').textContent = '';
    renderStepper();
  }

  function setDlProgress(pct, label) {
    $('dlProgress').hidden = false;
    const indeterminate = !Number.isFinite(pct);
    $('dlBar').classList.toggle('indeterminate', indeterminate);
    if (!indeterminate) $('dlBarFill').style.width = clamp(pct, 0, 100) + '%';
    $('dlLabel').textContent = label || '';
  }

  $('urlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('urlInput').value.trim();
    if (!url) return;
    await settleSave(); // the previous songsheet is still being read off disk
    resetForNewSource('Reading video info…');
    try {
      await api('/api/video/url', { url });
    } catch (err) {
      state.job = 'idle';
      $('sourceCard').hidden = true;
      $('how').hidden = false;
      showError(err.message, null, { escape: true });
    }
  });
  $('urlInput').addEventListener('paste', () => {
    setTimeout(() => {
      if (/^https?:\/\/\S+$/i.test($('urlInput').value.trim())) $('urlForm').requestSubmit();
    }, 0);
  });

  // Paste a link anywhere on the page, not just into the box. Everything routes
  // through the form so there is one code path that loads a video.
  const looksLikeLink = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());

  function loadLink(url) {
    $('urlInput').value = url.trim();
    $('urlForm').requestSubmit();
  }

  // A finished songsheet is saved to the library before anything can replace
  // it, so loading another video is not destructive. Two cases still are: work
  // in progress, and a scan that found nothing — that one saves no songsheet,
  // so replacing it would silently discard the explanation of why.
  const busyWithWork = () => state.job === 'downloading' || state.job === 'analyzing'
    || (state.job === 'done' && state.items.length === 0);

  document.addEventListener('paste', (e) => {
    const t = e.target;
    // The URL box has its own handler; reacting here too would submit twice.
    if (t && (t.id === 'urlInput' || t.matches?.('input, textarea, [contenteditable]'))) return;
    const text = e.clipboardData?.getData('text');
    if (!looksLikeLink(text)) return;
    if (busyWithWork()) {
      showToast('Still working on the current video — cancel it first', false);
      return;
    }
    e.preventDefault();
    showStep(1);
    loadLink(text);
  });

  async function uploadFile(file) {
    await settleSave(); // as above: do not wipe the folder out from under it
    resetForNewSource(file.name);
    setDlProgress(0, 'Uploading…');
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/video/file?name=' + encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setDlProgress((e.loaded / e.total) * 100, 'Uploading…');
    };
    xhr.onload = () => {
      if (xhr.status < 400) return;
      state.job = 'idle';
      $('dlProgress').hidden = true;
      let msg = 'Upload failed.';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not json */ }
      showError(msg);
    };
    xhr.onerror = () => {
      state.job = 'idle';
      $('dlProgress').hidden = true;
      showError('Upload failed — the app server isn’t reachable.');
    };
    xhr.send(file);
  }

  $('chooseFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => {
    const f = $('fileInput').files[0];
    if (f) uploadFile(f);
    $('fileInput').value = '';
  });
  const isVideoFile = (f) => f && (f.type.startsWith('video/') || /\.(mp4|mkv|webm|mov|avi|m4v)$/i.test(f.name));
  let dragDepth = 0;
  // A dragged link counts too: dropping a YouTube tab onto the window is the
  // fastest way in, and it used to do nothing at all.
  const dragHasLink = (dt) => [...(dt?.types || [])].some((t) => t === 'text/uri-list' || t === 'text/plain');
  document.addEventListener('dragenter', (e) => {
    const types = [...(e.dataTransfer?.types || [])];
    if (!types.includes('Files') && !dragHasLink(e.dataTransfer)) return;
    dragDepth++;
    $('dropVeil').hidden = false;
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropVeil').hidden = true;
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropVeil').hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (isVideoFile(f)) { uploadFile(f); return; }
    // Dropped a link rather than a file. uri-list first: dragging a browser tab
    // gives both, and the plain-text copy is sometimes the page title.
    const dropped = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (!looksLikeLink(dropped)) return;
    if (busyWithWork()) {
      showToast('Still working on the current video — cancel it first', false);
      return;
    }
    showStep(1);
    loadLink(dropped);
  });

  $('dlCancel').addEventListener('click', () => api('/api/cancel').catch(() => {}));

  function setMeta(meta) {
    const newThumb = meta.thumb && !(state.meta && state.meta.thumb);
    state.meta = meta;
    $('sourceCard').hidden = false;
    $('how').hidden = true;
    $('metaTitle').textContent = meta.title || 'Untitled video';
    const subBits = [meta.channel, meta.duration ? fmtTime(meta.duration) : ''];
    // A 360p fallback stream makes the tab too small to read, and that has to be
    // visible on the source card — otherwise the scan just reports very few
    // pages and looks like the video simply had very few.
    if (meta.lowRes) {
      subBits.push(meta.lowRes.advertised
        ? `only ${meta.lowRes.height}p came through (this video publishes ${meta.lowRes.advertised}p)`
        : `${meta.lowRes.height}p — small tab text may not scan well`);
    }
    $('metaSub').textContent = subBits.filter(Boolean).join(' · ');
    if (newThumb || (meta.thumb && $('metaThumb').hidden)) {
      state.thumbVersion = Date.now();
      const img = $('metaThumb');
      img.onload = () => { img.hidden = false; setThumbLoading(false); };
      // A thumbnail that 404s never fires load. Both ends have to clear the
      // placeholder, or it sits there animating away about reading a video the
      // app finished reading.
      img.onerror = () => setThumbLoading(false);
      img.src = '/thumb.jpg?v=' + state.thumbVersion;
    } else if (!meta.thumb) {
      // A chosen file usually has no thumbnail at all, so there is nothing here
      // to wait for and nothing to say.
      setThumbLoading(false);
    }
    if (!state.title) state.title = suggestTitle(meta.title);
    if (meta.suggestion) onSuggestion(meta.suggestion);
  }

  function videoReady() {
    if (state.videoSet) return;
    state.videoSet = true;
    video.src = '/api/video?v=' + Date.now();
  }

  function onDownloaded() {
    state.job = 'ready';
    $('dlProgress').hidden = true;
    videoReady();
    showStep(2);
  }

  // ---------- 2. tab area ----------

  const vw = () => video.videoWidth || state.meta?.width || 0;
  const vh = () => video.videoHeight || state.meta?.height || 0;
  const scale = () => (vw() ? video.getBoundingClientRect().width / vw() : 0);

  function layoutVideo() {
    if (vw() && vh()) $('videoWrap').style.setProperty('--ar', String(vw() / vh()));
    renderRect();
  }

  function normRect(r) {
    const W = vw(), H = vh();
    if (!W || !H) return { ...r };
    const x = clamp(Math.round(r.x), 0, W - 16), y = clamp(Math.round(r.y), 0, H - 16);
    return { x, y, w: clamp(Math.round(r.w), 16, W - x), h: clamp(Math.round(r.h), 16, H - y) };
  }

  function setRect(r, source) {
    state.rect = r ? normRect(r) : null;
    if (source !== undefined) state.rectSource = r ? source : null;
    renderRect();
    $('analyzeBtn').disabled = !state.rect || !state.videoSet;
    $('cropPreviewWrap').hidden = !state.rect;
    redrawPreview();
    updateDetectUI();
  }

  function renderRect() {
    const r = state.rect, s = scale();
    if (!r || !s) { rectEl.hidden = true; return; }
    rectEl.hidden = false;
    rectEl.style.left = r.x * s + 'px';
    rectEl.style.top = r.y * s + 'px';
    rectEl.style.width = r.w * s + 'px';
    rectEl.style.height = r.h * s + 'px';
    rectEl.classList.toggle('auto', state.rectSource === 'auto' && !state.selectMode);
    const tag = $('rectTag');
    tag.style.bottom = r.y * s < 26 ? 'auto' : '100%';
    tag.style.top = r.y * s < 26 ? '4px' : 'auto';
    tag.style.left = r.y * s < 26 ? '4px' : '-2px';
  }

  new ResizeObserver(() => { renderRect(); }).observe($('videoWrap'));

  function setSelectMode(on) {
    state.selectMode = on;
    overlay.classList.toggle('selecting', on);
    if (on) {
      video.pause();
      video.removeAttribute('controls');
    } else {
      video.setAttribute('controls', '');
    }
    renderRect();
    updateDetectUI();
  }

  function onSuggestion(s) {
    state.suggestion = s;
    if (state.meta) state.meta.suggestion = s;
    if (s?.crop && state.rectSource !== 'user') setRect(s.crop, 'auto');
    maybeSeekToTab();
    updateDetectUI();
    updateStartSeg();
  }

  // Show a frame with tab on it under the detected box (unless the user scrubbed).
  function maybeSeekToTab() {
    const s = state.suggestion;
    if (!s?.crop || !video.duration || state.seekedToTab || video.currentTime > 0.5) return;
    const [a, b] = s.tabRange || [s.startTime || 0, video.duration];
    state.seekedToTab = true;
    try { video.currentTime = clamp(a + (b - a) * 0.3, 0, Math.max(0, video.duration - 0.2)); } catch { /* not seekable yet */ }
  }

  function updateDetectUI() {
    const s = state.suggestion;
    let mode, title, text;
    if (state.detecting || (!s && state.job === 'ready')) {
      mode = 'pending'; title = 'Looking for the tab…'; text = 'This takes a second or two.';
    } else if (state.rectSource === 'user') {
      mode = 'found'; title = 'Using your box'; text = 'Scan when you’re ready — or detect again to start over.';
    } else if (s?.crop && s.confidence >= 0.6) {
      mode = 'found'; title = 'Tab area found'; text = 'Check that the box covers the whole tab, then scan.';
    } else if (s?.crop) {
      mode = 'low'; title = 'This might be the tab'; text = 'Make sure the box covers the notation — adjust it if not.';
    } else if (s) {
      mode = 'none'; title = 'Couldn’t find the tab'; text = 'Pause where the tab is visible, then draw a box around it.';
    } else {
      mode = 'pending'; title = 'Waiting for the video…'; text = '';
    }
    $('detectStatus').className = 'detect-status is-' + mode; // prefixed: .found is the scan-step counter
    if (mode === 'pending') loaders.detect.show(); else loaders.detect.hide();
    const ic = $('detectIcon');
    ic.hidden = mode === 'pending';
    ic.innerHTML = mode === 'found' ? ICON.check : ICON.warn;
    $('detectTitle').textContent = title;
    $('detectText').textContent = text;
    const adjust = $('adjustBtn');
    adjust.textContent = state.selectMode ? 'Done' : state.rect ? 'Adjust box' : 'Draw box';
    adjust.classList.toggle('primary', !state.rect && mode === 'none');
    $('redetectBtn').disabled = state.detecting || !state.meta?.ready;
    $('rectTag').textContent = state.rectSource === 'user' ? 'Your box' : 'Detected tab';
    $('regionSub').textContent = state.selectMode
      ? 'Drag to draw a new box, drag inside to move it, or pull the handles. Press Done when it fits.'
      : 'Only what’s inside the box is scanned — fret numbers, chord names and rhythm marks, not the guitarist.';
  }

  $('adjustBtn').addEventListener('click', () => setSelectMode(!state.selectMode));
  $('redetectBtn').addEventListener('click', async () => {
    state.detecting = true;
    state.rectSource = null;
    state.seekedToTab = false;
    updateDetectUI();
    try {
      const { suggestion } = await api('/api/detect');
      state.detecting = false;
      onSuggestion(suggestion);
    } catch (err) {
      state.detecting = false;
      updateDetectUI();
      showError('Detection failed: ' + err.message);
    }
  });

  const toNative = (e) => {
    const b = overlay.getBoundingClientRect(), s = scale() || 1;
    return { x: clamp((e.clientX - b.left) / s, 0, vw()), y: clamp((e.clientY - b.top) / s, 0, vh()) };
  };
  const boxFrom = (x1, y1, x2, y2) => ({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
  let drag = null;

  overlay.addEventListener('pointerdown', (e) => {
    if (!state.selectMode || e.button !== 0) return;
    e.preventDefault();
    try { overlay.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = toNative(e);
    const handle = e.target.dataset?.h;
    const r = state.rect;
    if (handle && r) drag = { mode: 'resize', handle, orig: { ...r } };
    else if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) drag = { mode: 'move', orig: { ...r }, start: p };
    else drag = { mode: 'draw', anchor: p, prev: r ? { ...r } : null, prevSource: state.rectSource };
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toNative(e);
    if (drag.mode === 'draw') {
      const b = boxFrom(drag.anchor.x, drag.anchor.y, p.x, p.y);
      state.rect = { ...b }; // raw while drawing; normalized on release
      state.rectSource = 'user';
      renderRect();
    } else if (drag.mode === 'move') {
      setRect({
        x: clamp(drag.orig.x + p.x - drag.start.x, 0, vw() - drag.orig.w),
        y: clamp(drag.orig.y + p.y - drag.start.y, 0, vh() - drag.orig.h),
        w: drag.orig.w, h: drag.orig.h,
      }, 'user');
    } else {
      let L = drag.orig.x, T = drag.orig.y, R = drag.orig.x + drag.orig.w, B = drag.orig.y + drag.orig.h;
      if (drag.handle.includes('w')) L = p.x;
      if (drag.handle.includes('e')) R = p.x;
      if (drag.handle.includes('n')) T = p.y;
      if (drag.handle.includes('s')) B = p.y;
      setRect(boxFrom(L, T, R, B), 'user');
    }
  });

  function endDrag() {
    if (!drag) return;
    if (drag.mode === 'draw') {
      const r = state.rect;
      // a tiny "draw" was a stray click: restore whatever was there before
      if (!r || r.w < 12 || r.h < 12) setRect(drag.prev, drag.prev ? drag.prevSource : null);
      else setRect(r, 'user');
    }
    drag = null;
  }
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  function redrawPreview() {
    const r = state.rect;
    if (!r || video.readyState < 2 || state.step !== 2) return;
    const c = $('cropPreview');
    const k = Math.min(1, 640 / r.w);
    const w = Math.max(1, Math.round(r.w * k)), h = Math.max(1, Math.round(r.h * k));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    try { c.getContext('2d').drawImage(video, r.x, r.y, r.w, r.h, 0, 0, w, h); } catch { /* frame not ready */ }
  }

  function startTimes() {
    const s = state.suggestion;
    return { suggested: s?.crop ? (s.startTime || 0) : null, current: video.currentTime || 0 };
  }

  function computeStart() {
    const t = startTimes();
    const m = state.startMode;
    if ((m === 'suggested' || m === 'auto') && t.suggested != null) return { mode: 'suggested', t: t.suggested };
    if (m === 'current') return { mode: 'current', t: t.current };
    if (m === 'zero') return { mode: 'zero', t: 0 };
    // Start at the beginning, not wherever the video happens to be paused: when
    // detection fails the UI asks the user to pause on a frame showing the tab,
    // and starting there silently dropped every page before that moment. Pass 1
    // already discards intro screens that show no staff.
    return { mode: 'zero', t: 0 };
  }

  function updateStartSeg() {
    const t = startTimes(), cur = computeStart();
    $('startSuggested').textContent = t.suggested != null ? fmtTime(t.suggested) : '—';
    $('startCurrent').textContent = fmtTime(t.current);
    for (const b of $('startSeg').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.start === cur.mode));
      if (b.dataset.start === 'suggested') b.disabled = t.suggested == null;
    }
    const dur = state.meta?.duration || video.duration || 0;
    const warn = $('longWarn');
    warn.hidden = dur <= 15 * 60;
    if (!warn.hidden) warn.textContent = `This is a long video (${Math.round(dur / 60)} min) — scanning will take a few minutes.`;
  }

  for (const b of $('startSeg').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      state.startMode = b.dataset.start;
      updateStartSeg();
    });
  }

  video.addEventListener('loadedmetadata', () => {
    layoutVideo();
    if (state.suggestion?.crop && state.rectSource !== 'user') setRect(state.suggestion.crop, 'auto');
    maybeSeekToTab();
    updateStartSeg();
  });
  video.addEventListener('timeupdate', () => { if (state.step === 2) updateStartSeg(); });
  video.addEventListener('seeked', () => { updateStartSeg(); redrawPreview(); });
  video.addEventListener('loadeddata', redrawPreview);
  video.addEventListener('pause', redrawPreview);

  // allowFallback asks the server for a capture every few seconds when no tab
  // screens are recognised. It is never automatic: that used to turn a video
  // with no tab into a hundred meaningless "pages".
  async function startAnalyze(sensitivity, reuse, allowFallback = false) {
    let rect = null, startTime = 0;
    if (reuse && state.lastAnalyze) {
      ({ rect, startTime } = state.lastAnalyze);
    } else if (state.rect) {
      rect = state.rect;
      startTime = computeStart().t;
    }
    if (!rect) {
      showStep(2);
      setSelectMode(true);
      return;
    }
    const btn = $('analyzeBtn');
    btn.disabled = true;
    try {
      const res = await api('/api/analyze', { rect, startTime, sensitivity, allowFallback });
      state.runId = Math.max(state.runId, res?.runId || 0);
      state.lastAnalyze = { rect, startTime, sensitivity };
      state.sensitivity = sensitivity;
      updateSensSeg();
      if (state.job !== 'analyzing') {
        state.job = 'analyzing';
        resetProcessing();
      }
      setSelectMode(false);
      hideError();
      showStep(3);
    } catch (err) {
      showError('Couldn’t start the scan: ' + err.message);
    } finally {
      btn.disabled = !state.rect;
    }
  }
  $('analyzeBtn').addEventListener('click', () => startAnalyze(state.sensitivity, false));

  // ---------- 3. scan ----------

  const STAGES = ['scan', 'find', 'render'];
  const STAGE_LABEL = { scan: 'Scanning the video…', find: 'Finding the pages…', render: 'Cleaning up the pages…' };

  function resetProcessing() {
    state.captures = [];
    $('liveGrid').textContent = '';
    // Clear the state, not just this one container: the songsheet step mirrors
    // the same list, so wiping only the DOM here left stale warnings on step 4
    // and brought the old ones back as soon as the new run logged its first.
    state.warnings = [];
    renderWarnings();
    $('foundCount').hidden = true;
    setProc('scan', 0, '');
    loaders.scan.show();
    renderStepper();
  }

  function setProc(stage, overall, msg) {
    const cur = STAGES.indexOf(stage);
    for (const li of $('stages').children) {
      const i = STAGES.indexOf(li.dataset.stage);
      li.classList.toggle('active', i === cur);
      li.classList.toggle('done', i < cur);
    }
    $('stageLabel').textContent = STAGE_LABEL[stage];
    const p = clamp(overall, 0, 100);
    $('procBarFill').style.width = p + '%';
    // The bar carries role="progressbar"; without a value it announces a
    // position-less bar, which is worse than no bar at all.
    $('procBar').setAttribute('aria-valuenow', String(Math.round(p)));
    const m = msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : '';
    $('procPct').textContent = Math.round(p) + '%' + (m ? ' · ' + m : '');
  }

  function onProgress(ev) {
    const p = Number(ev.pct) || 0;
    if (ev.phase === 'analyze') setProc(p < 90 ? 'scan' : 'find', p * 0.75, ev.msg);
    else setProc('render', 75 + p * 0.25, ev.msg);
  }

  function addLiveCapture(cap) {
    if (state.captures.some((c) => c.png === cap.png)) return;
    // First real page in: the stand-in has nothing left to say, so it leaves at
    // the next seam in its own loop rather than being cut off here.
    if (!state.captures.length) loaders.scan.hide();
    state.captures.push(cap);
    const img = el('img');
    img.src = capSrc(cap.png);
    img.alt = 'Page found at ' + fmtTime(cap.tStart);
    img.width = cap.w;
    img.height = cap.h;
    $('liveGrid').appendChild(img);
    const n = state.captures.length;
    $('foundCount').hidden = false;
    $('foundCount').textContent = `${n} page${n === 1 ? '' : 's'} so far`;
  }

  function warningBanner(msg) {
    const box = el('div', 'banner warn');
    box.appendChild(icon(ICON.warn)).classList.add('icon');
    const body = el('div', 'body');
    body.appendChild(el('p', null, msg || 'Warning'));
    if (/region|tab area|moving video|recognised/i.test(msg || '')) {
      const b = el('button', 'linklike', 'Adjust the tab area');
      b.type = 'button';
      b.addEventListener('click', () => { showStep(2); setSelectMode(true); });
      body.appendChild(b);
    }
    box.appendChild(body);
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', () => {
      state.warnings = state.warnings.filter((m) => m !== msg);
      renderWarnings();
    });
    box.appendChild(x);
    return box;
  }

  // Warnings live in state and are mirrored into the scan step and the
  // songsheet step. Rendering them only into step 3 meant they were never read:
  // finishing a scan hides that step immediately.
  function renderWarnings() {
    for (const id of ['warnings', 'warnings4']) {
      const host = $(id);
      if (!host) continue;
      host.textContent = '';
      for (const msg of state.warnings) host.appendChild(warningBanner(msg));
    }
  }

  function addWarning(msg) {
    if (!state.warnings.includes(msg)) state.warnings.push(msg);
    renderWarnings();
  }

  $('procCancel').addEventListener('click', () => api('/api/cancel').catch(() => {}));

  // ---------- 4. songsheet ----------

  const isStamped = (t0, t1) => state.deletedStamps.some((s) => Math.abs(s.t0 - t0) <= 1 && Math.abs(s.t1 - t1) <= 1);
  const visibleIndices = () => state.items.flatMap((it, i) => (it.deleted ? [] : [i]));

  // Object URLs handed out for a saved songsheet's pages, revoked when the
  // review is rebuilt — reopening sheets would otherwise leak one per page.
  let heldUrls = [];
  function releaseHeldUrls() {
    for (const u of heldUrls) { try { URL.revokeObjectURL(u); } catch { /* already gone */ } }
    heldUrls = [];
  }
  const holdUrl = (blob) => {
    const u = URL.createObjectURL(blob);
    heldUrls.push(u);
    return u;
  };

  // captures are either live pipeline captures (filenames under work/) or pages
  // from the library (blobs). Each item resolves its image URLs once here, so
  // the preview and both exports never need to know which kind it is — the
  // work folder is wiped by the next video, and a saved sheet has no filename
  // to point at anyway.
  function buildReview(captures) {
    releaseHeldUrls();
    state.captures = [...captures].sort((a, b) => a.tStart - b.tStart);
    state.items = state.captures.map((c, i) => {
      const stored = Boolean(c.clean);
      const src = stored ? holdUrl(c.clean) : capSrc(c.png);
      return {
        key: c.png || `stored:${i}`,
        png: c.png || null,                       // server-side name, live scans only
        pngColor: c.pngColor || c.png || null,
        src,
        srcColor: stored ? (c.color ? holdUrl(c.color) : src) : capSrc(c.pngColor || c.png),
        stored,
        w: c.w,
        h: c.h,
        tStart: c.tStart,
        tEnd: c.tEnd,
        alsoAt: c.alsoAt || [],
        deleted: isStamped(c.tStart, c.tEnd),
      };
    });
    state.selected = -1;
    state.undoStack = [];
    if (!state.title) state.title = suggestTitle(state.meta?.title);
    renderReview();
  }

  function renderReview() {
    const meta = state.meta || {};
    if (document.activeElement !== $('titleInput')) $('titleInput').value = state.title || meta.title || '';
    const link = $('rvSource');
    link.hidden = !meta.url;
    $('rvDot').hidden = !meta.url;
    if (meta.url) link.href = meta.url;
    const vis = visibleIndices();
    const removed = state.items.length - vis.length;
    $('rvCount').textContent = `${vis.length} page${vis.length === 1 ? '' : 's'}` + (removed ? ` (${removed} removed)` : '');
    $('diagCard').hidden = state.items.length > 1;
    $('diagText').textContent = state.items.length === 0 ? 'No pages found.' : 'Only one page found.';
    // Offered only when nothing was recognised. A capture every few seconds is
    // a fallback, not a result, so it must never look like the normal scan.
    $('diagTimed').hidden = state.items.length !== 0;
    for (const b of $('lookSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.look === state.look));
    $('paperSelect').value = state.paper;
    $('exportPdf').disabled = vis.length === 0;
    $('exportPng').disabled = vis.length === 0;
    // Same rule as the exports: with no page left there is nothing to practise.
    syncSidebar();

    const list = $('reviewList');
    list.textContent = '';
    if (state.items.length && !vis.length) {
      list.appendChild(el('div', 'empty', 'All pages removed — press u to undo.'));
      return;
    }
    let pageNo = 0;
    state.items.forEach((it, idx) => {
      if (it.deleted) return;
      pageNo++;
      const row = el('article', 'sheet-item' + (idx === state.selected ? ' selected' : ''));
      row.dataset.idx = idx;
      // Reachable by keyboard: these are selectable rows, and selection drives
      // the delete and jump-to-moment shortcuts. Without a tab stop they could
      // only ever be reached with a mouse.
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Page ${pageNo}, ${fmtTime(it.tStart)} to ${fmtTime(it.tEnd)}`);
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        selectItem(idx);
      });
      row.addEventListener('focus', () => selectItem(idx));

      const bar = el('div', 'sheet-meta');
      bar.appendChild(el('span', 'page-no', String(pageNo)));
      const time = el('button', 'chip time');
      time.type = 'button';
      time.title = 'Show this moment in the video';
      time.appendChild(icon(ICON.clock));
      time.appendChild(document.createTextNode(`${fmtTime(it.tStart)} – ${fmtTime(it.tEnd)}`));
      time.addEventListener('click', (e) => { e.stopPropagation(); seekToSource(it.tStart); });
      bar.appendChild(time);
      const shown = it.alsoAt.slice(0, 4);
      for (const t of shown) {
        const chip = el('button', 'chip repeat', 'repeats at ' + fmtTime(t));
        chip.type = 'button';
        chip.title = 'This page is shown again here';
        chip.addEventListener('click', (e) => { e.stopPropagation(); seekToSource(t); });
        bar.appendChild(chip);
      }
      if (it.alsoAt.length > shown.length) bar.appendChild(el('span', 'chip repeat', `+${it.alsoAt.length - shown.length} more`));
      bar.appendChild(el('span', 'spacer'));
      const del = el('button', 'icon-btn');
      del.type = 'button';
      del.title = 'Remove this page';
      del.setAttribute('aria-label', 'Remove page ' + pageNo);
      del.appendChild(icon(ICON.trash));
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteItem(idx); });
      bar.appendChild(del);

      const look = lookById(state.look);
      const paper = el('div', 'paper' + (isOriginal(look) ? ' color' : ''));
      if (!isOriginal(look)) paper.style.background = rgbCss(paperRgb(look));
      const img = el('img');
      img.src = isOriginal(look) ? it.srcColor : it.src;
      img.alt = `Page ${pageNo}, ${fmtTime(it.tStart)} to ${fmtTime(it.tEnd)}`;
      img.loading = 'lazy';
      if (it.w && it.h) { img.width = it.w; img.height = it.h; }
      // Dark and Sepia map the clean render pixel by pixel, so the preview
      // shows precisely the bytes the export will use — one recipe, not two.
      if (!isIdentity(look) && !isOriginal(look)) {
        recolouredCanvas(it.src, look)
          .then((c) => { img.src = c.toDataURL('image/png'); })
          .catch(() => { /* keep the plain render rather than blanking the page */ });
      }
      paper.appendChild(img);

      row.appendChild(bar);
      row.appendChild(paper);
      row.addEventListener('click', () => selectItem(idx));
      list.appendChild(row);
    });
  }

  function selectItem(idx) {
    state.selected = idx;
    for (const r of $('reviewList').children) r.classList.toggle('selected', +r.dataset.idx === idx);
  }

  function moveSelection(dir) {
    const vis = visibleIndices();
    if (!vis.length) return;
    let pos = vis.indexOf(state.selected);
    pos = pos === -1 ? (dir > 0 ? 0 : vis.length - 1) : clamp(pos + dir, 0, vis.length - 1);
    selectItem(vis[pos]);
    $('reviewList').querySelector(`[data-idx="${vis[pos]}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
      state.selected = next ?? (vis.length ? vis[vis.length - 1] : -1);
    }
    renderReview();
    showToast('Page removed', true);
  }

  function undo() {
    const it = state.undoStack.pop();
    if (!it) return;
    it.deleted = false;
    const i = state.deletedStamps.findIndex((s) => Math.abs(s.t0 - it.tStart) <= 1 && Math.abs(s.t1 - it.tEnd) <= 1);
    if (i >= 0) state.deletedStamps.splice(i, 1);
    hideToast();
    renderReview();
  }

  function seekToSource(t) {
    if (!state.videoSet) return;
    setSelectMode(false);
    showStep(2);
    try { video.currentTime = t; } catch { /* not seekable yet */ }
    video.pause();
  }

  let toastTimer = 0;
  function showToast(msg, undoable) {
    $('toastMsg').textContent = msg;
    $('toastUndo').hidden = !undoable;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').hidden = true;
  }
  $('toastUndo').addEventListener('click', undo);

  $('titleInput').addEventListener('input', () => { state.title = $('titleInput').value; });
  // Built from the shared list, so the preview, the PNG and the PDF always
  // offer exactly the same looks. Each button gets its listener as it is
  // created — the markup ships empty, so querying for buttons at start-up
  // would find none.
  function buildLookSeg() {
    const seg = $('lookSeg');
    seg.textContent = '';
    for (const look of LOOKS) {
      const b = el('button', null, look.label);
      b.type = 'button';
      b.dataset.look = look.id;
      b.title = look.hint;
      b.setAttribute('aria-pressed', String(look.id === state.look));
      b.addEventListener('click', () => {
        state.look = look.id;
        store.set('vtt.look', state.look);
        renderReview();
      });
      seg.appendChild(b);
    }
  }
  $('paperSelect').addEventListener('change', () => {
    state.paper = $('paperSelect').value === 'a4' ? 'a4' : 'letter';
    store.set('vtt.paper', state.paper);
  });

  function updateSensSeg() {
    for (const b of $('sensSeg').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Math.abs(parseFloat(b.dataset.sens) - state.sensitivity) < 0.01));
    }
  }
  for (const b of $('sensSeg').querySelectorAll('button')) {
    b.addEventListener('click', () => startAnalyze(parseFloat(b.dataset.sens), true));
  }
  $('backToRegion').addEventListener('click', () => { showStep(2); setSelectMode(true); });
  $('diagAdjust').addEventListener('click', () => { showStep(2); setSelectMode(true); });
  $('diagMore').addEventListener('click', () => startAnalyze(0.75, true));
  $('diagTimed').addEventListener('click', () => startAnalyze(state.sensitivity, true, true));

  // ---------- exports ----------

  // Sora first so the printed header is set in the same face as the interface
  // that produced it, then the CJK stack that was already here: Sora carries no
  // Korean or Japanese glyphs and a great many of these song titles do.
  const FONT = 'Sora, -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Apple SD Gothic Neo", "Malgun Gothic", "Yu Gothic", "Noto Sans CJK JP", sans-serif';

  function ellipsize(ctx, s, maxW) {
    if (ctx.measureText(s).width <= maxW) return s;
    let t = s;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  }

  // Wraps any script: prefers breaking at spaces, falls back to characters (CJK).
  function wrapLines(ctx, text, maxW, maxLines) {
    const chars = Array.from(text);
    const lines = [];
    let line = '', i = 0;
    while (i < chars.length) {
      const test = line + chars[i];
      if (!line || ctx.measureText(test).width <= maxW) { line = test; i++; continue; }
      if (lines.length === maxLines - 1) break;
      const sp = line.lastIndexOf(' ');
      if (sp > line.length * 0.4) { lines.push(line.slice(0, sp)); line = line.slice(sp + 1); }
      else { lines.push(line); line = ''; }
    }
    lines.push(i < chars.length ? ellipsize(ctx, line + chars.slice(i).join(''), maxW) : line);
    return lines.map((l) => l.trim()).filter(Boolean);
  }

  // The songsheet header (thumbnail, title, channel, link), drawn in the brand
  // face over a system stack deep enough that any script still renders; the PDF
  // embeds it as an image.
  // The brand mark, as paths. The header is a canvas and cannot take the SVG
  // that index.html uses, so the six lengths are written out again here — same
  // 24-unit grid, same 2.1 stroke, same taper into a play triangle. If the mark
  // ever changes, this is the second of the two places that has to know.
  const MARK_LINES = [[12, 4.2], [17, 7.7], [21, 11.2], [21, 14.7], [17, 18.2], [12, 21.7]];
  const MARK_STROKE = 2.1;
  // Round caps put half a stroke of ink beyond every endpoint, so the box the
  // mark actually occupies is not the box its coordinates describe. Laying it
  // out by the ink rather than by the grid is what stops it sitting visibly
  // high and left of whatever it is aligned with.
  const MARK_INK = {
    x0: 4 - MARK_STROKE / 2,
    y0: 4.2 - MARK_STROKE / 2,
    w: 21 - 4 + MARK_STROKE,
    h: 21.7 - 4.2 + MARK_STROKE,
  };
  const markInkWidth = (inkH) => (inkH * MARK_INK.w) / MARK_INK.h;

  function drawMark(ctx, x, y, inkH, colour) {
    const u = inkH / MARK_INK.h;
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = MARK_STROKE * u;
    ctx.lineCap = 'round';
    for (const [to, ly] of MARK_LINES) {
      ctx.beginPath();
      ctx.moveTo(x + (4 - MARK_INK.x0) * u, y + (ly - MARK_INK.y0) * u);
      ctx.lineTo(x + (to - MARK_INK.x0) * u, y + (ly - MARK_INK.y0) * u);
      ctx.stroke();
    }
    ctx.restore();
  }

  async function headerCanvas(W, pages, look = null) {
    // Canvas silently falls back to the next family in the stack for a face it
    // does not yet have, and an export triggered before the webfont arrived
    // would be set in the system sans with no sign anything was wrong.
    try { await document.fonts?.ready; } catch { /* no font API */ }
    const meta = state.meta || {};
    // The header shares the sheet with the pages, so it takes the look's
    // colours too — otherwise a dark songsheet gets a white slab across the top.
    const tinted = look && !isOriginal(look);
    const paperC = tinted ? paperRgb(look) : [255, 255, 255];
    const inkC = tinted ? inkRgb(look) : [22, 20, 15];
    const title = (state.title || meta.title || 'Untitled').trim();
    const thumb = meta.thumb ? await loadImage('/thumb.jpg?v=' + state.thumbVersion).catch(() => null) : null;
    const th = Math.round(W * 0.1);
    const tw = thumb ? Math.round((th * thumb.naturalWidth) / thumb.naturalHeight) : 0;
    const tx = thumb ? tw + Math.round(W * 0.02) : 0;
    const titleSize = Math.round(W * 0.027), subSize = Math.round(W * 0.015);
    const measure = document.createElement('canvas').getContext('2d');
    // A quiet lockup in the top right. The songsheet leaves the app and ends up
    // on a music stand or in someone else's hands, and this is the only thing
    // on it that says what made it. Ink rather than accent, because the look
    // this is printed in is black on white and an orange mark prints grey.
    const markH = Math.round(W * 0.03);
    const markW = Math.round(markInkWidth(markH));
    const wordSize = Math.round(W * 0.0165);
    const gap = Math.round(W * 0.008);
    measure.font = `700 ${wordSize}px ${FONT}`;
    const lockupW = markW + gap + Math.ceil(measure.measureText('VidToTab').width);
    // The title wraps before the lockup rather than running underneath it.
    const textW = W - tx - lockupW - Math.round(W * 0.03);
    measure.font = `700 ${titleSize}px ${FONT}`;
    const lines = wrapLines(measure, title, textW, 2);
    const sub = [meta.channel, meta.duration ? fmtTime(meta.duration) : '', pages ? `${pages} page${pages === 1 ? '' : 's'}` : ''].filter(Boolean).join('  ·  ');
    const lineH = Math.round(titleSize * 1.2), subH = Math.round(subSize * 1.65);
    const textH = lines.length * lineH + Math.round(subSize * 0.4) + (sub ? subH : 0) + (meta.url ? subH : 0);
    const H = Math.max(th, textH) + Math.round(W * 0.018);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = rgbCss(paperC);
    ctx.fillRect(0, 0, W, H);
    if (thumb) {
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(0, 0, tw, th, Math.round(W * 0.005));
      else ctx.rect(0, 0, tw, th);
      ctx.clip();
      ctx.drawImage(thumb, 0, 0, tw, th);
      ctx.restore();
    }
    ctx.textBaseline = 'top';
    let y = 0;
    ctx.fillStyle = rgbCss(inkC);
    ctx.font = `700 ${titleSize}px ${FONT}`;
    for (const l of lines) { ctx.fillText(l, tx, y); y += lineH; }
    y += Math.round(subSize * 0.4);
    ctx.font = `500 ${subSize}px ${FONT}`;
    if (sub) { ctx.fillStyle = rgbCss(mixRgb(paperC, inkC, 0.55)); ctx.fillText(ellipsize(ctx, sub, textW), tx, y); y += subH; }
    // The link keeps the accent colour: it reads on cream and on near-black.
    if (meta.url) { ctx.fillStyle = '#c2410c'; ctx.fillText(ellipsize(ctx, meta.url, textW), tx, y); }
    // Last, so nothing can land on top of it. Sat on the title's own cap line
    // rather than the top of the canvas, where it would float.
    const lockupY = Math.round(titleSize * 0.22);
    drawMark(ctx, W - lockupW, lockupY, markH, rgbCss(inkC));
    ctx.fillStyle = rgbCss(inkC);
    ctx.font = `700 ${wordSize}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('VidToTab', W - lockupW + markW + gap, lockupY + markH / 2);
    ctx.textBaseline = 'top';

    ctx.fillStyle = rgbCss(mixRgb(paperC, inkC, 0.12));
    ctx.fillRect(0, H - 3, W, 3);
    return c;
  }

  // Items, not filenames: the PDF still needs the server-side name when the
  // pages are live captures, while the PNG compositor and a saved songsheet
  // only ever have a URL. Returning strings could not serve both.
  const visibleItems = () => state.items.filter((it) => !it.deleted);
  const visibleSrc = (it) => (isOriginal(lookById(state.look)) ? it.srcColor : it.src);
  const exportBase = () => fileSafe(state.title || state.meta?.title);

  async function busy(btn, label, fn) {
    const html = btn.innerHTML;
    btn.disabled = true;
    // Page-turn rather than a frozen label. Exporting recolours and re-encodes
    // every page, which on a twenty-page songsheet is long enough that a button
    // that only changed its text reads as one that stopped working. hide()
    // resolves at the loop's own seam, so the button comes back after a
    // completed turn instead of half way through one.
    const loader = createLoader('pages', { label });
    btn.textContent = '';
    btn.append(loader.el);
    loader.show();
    try { await fn(); } finally { await loader.hide(); btn.innerHTML = html; btn.disabled = false; }
  }

  $('exportPdf').addEventListener('click', () => busy($('exportPdf'), 'Building PDF…', async () => {
    const files = visibleItems();
    if (!files.length) return;
    try {
      const look = lookById(state.look);
      const header = await headerCanvas(1800, files.length, look);
      // Print and Original are the stored pixels, so only their names travel.
      // A recoloured look sends the bytes the preview showed, which is what
      // makes the PDF match the screen instead of merely resembling it.
      const recolour = !isIdentity(look) && !isOriginal(look);
      const items = [];
      for (const it of files) {
        // A page from the library has no file on the server — the work folder
        // was wiped long ago — so it always travels as bytes, whatever the look.
        const asBytes = recolour || it.stored;
        items.push(asBytes
          ? { png: it.png, pngData: (await recolouredCanvas(visibleSrc(it), look)).toDataURL('image/png') }
          : { png: isOriginal(look) ? it.pngColor : it.png });
      }
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: state.title || state.meta?.title || 'VidToTab',
          url: state.meta?.url || '',
          paper: state.paper,
          // So the PDF sheet itself carries the look, not just the pages on it.
          paperRgb: isOriginal(look) ? null : paperRgb(look),
          headerPng: header.toDataURL('image/png'),
          items,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      downloadBlob(await res.blob(), exportBase() + '.pdf');
      showToast('PDF downloaded', false);
    } catch (err) {
      showError('PDF export failed: ' + err.message);
    }
  }));

  $('exportPng').addEventListener('click', () => busy($('exportPng'), 'Building…', async () => {
    const files = visibleItems();
    if (!files.length) return;
    try {
      const look = lookById(state.look);
      const plain = isIdentity(look) || isOriginal(look);
      const imgs = await Promise.all(files.map((it) => (plain ? loadImage(visibleSrc(it)) : recolouredCanvas(it.src, look))));
      const pad = 56, gap = 22;
      const W = Math.max(1400, ...imgs.map(srcW)) + 2 * pad;
      const inner = W - 2 * pad;
      const header = await headerCanvas(inner, imgs.length, look);
      const heights = imgs.map((i) => Math.round((srcH(i) * inner) / srcW(i)));
      const H = pad + header.height + 30 + heights.reduce((s, h) => s + h + gap, 0) - gap + pad;
      const k = Math.min(1, 32000 / H); // browsers cap canvas height around 32k px
      const c = document.createElement('canvas');
      c.width = Math.round(W * k);
      c.height = Math.round(H * k);
      const ctx = c.getContext('2d');
      ctx.scale(k, k);
      // The sheet behind the pages follows the look too, or a dark songsheet
      // exports as dark pages floating on white with white gaps between them.
      ctx.fillStyle = isOriginal(look) ? '#ffffff' : rgbCss(paperRgb(look));
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(header, pad, pad);
      let y = pad + header.height + 30;
      imgs.forEach((img, i) => {
        ctx.drawImage(img, pad, y, inner, heights[i]);
        y += heights[i] + gap;
      });
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('The image is too large for this browser.');
      downloadBlob(blob, exportBase() + '.png');
      showToast('PNG downloaded', false);
    } catch (err) {
      showError('PNG export failed: ' + err.message);
    }
  }));

  // ---------- keyboard ----------

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) return;
    // Practice mode takes keys first and unconditionally: the guards below skip
    // Space over a focused button, which would activate that button instead of
    // turning the page — and Space is what a page-turner pedal sends.
    if (state.practice >= 0) { practiceKeys(e); return; }
    const t = e.target;
    if (t instanceof Element) {
      if (t.matches('input, textarea, select')) return;
      if ((e.key === 'Enter' || e.key === ' ') && t.matches('button, a, summary')) return;
    }
    if (e.key === 'Escape' && state.selectMode) { setSelectMode(false); return; }
    if (state.step === 2) step2Keys(e);
    else if (state.step === 4) step4Keys(e);
  });

  function step2Keys(e) {
    if (!state.videoSet) return;
    const k = e.key;
    // With no box there is nothing to drag, and dragging was the only way to
    // make one — so detection failing left the keyboard with no route at all.
    // B makes a centred default that the arrow keys below then move and resize.
    if (k === 'b' || k === 'B') {
      e.preventDefault();
      if (!state.rect && vw() && vh()) {
        const w = Math.round(vw() * 0.8);
        const h = Math.round(vh() * 0.25);
        setRect({ x: Math.round((vw() - w) / 2), y: Math.round((vh() - h) / 2), w, h }, 'user');
      }
      setSelectMode(true);
      return;
    }
    const arrow = k.startsWith('Arrow');
    if (state.selectMode && state.rect && arrow) {
      e.preventDefault();
      const d = e.altKey ? 10 : 2;
      const r = { ...state.rect };
      if (e.shiftKey) {
        if (k === 'ArrowRight') r.w += d;
        if (k === 'ArrowLeft') r.w -= d;
        if (k === 'ArrowDown') r.h += d;
        if (k === 'ArrowUp') r.h -= d;
      } else {
        if (k === 'ArrowRight') r.x += d;
        if (k === 'ArrowLeft') r.x -= d;
        if (k === 'ArrowDown') r.y += d;
        if (k === 'ArrowUp') r.y -= d;
      }
      setRect(r, 'user');
      return;
    }
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && video.duration) {
      e.preventDefault();
      video.currentTime = clamp(video.currentTime + (k === 'ArrowRight' ? 5 : -5), 0, video.duration);
    } else if ((k === ',' || k === '.') && video.paused && video.duration) {
      e.preventDefault();
      const fps = state.meta?.fps || 30;
      video.currentTime = clamp(video.currentTime + (k === '.' ? 1 : -1) / fps, 0, video.duration);
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
      case 'p': case 'P':
        // The Practice button offers this shortcut, so it has to exist.
        e.preventDefault();
        openPractice();
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

  // ---------- server events ----------

  function onDone(captures) {
    state.job = 'done';
    setProc('render', 100, '');
    buildReview(Array.isArray(captures) ? captures : state.captures);
    showStep(4);
    // Save straight away: the next video wipes the work folder, and until now
    // that is exactly when a finished songsheet disappeared.
    // Kept so that starting another video can wait for it: the save reads each
    // page back from /captures/, and the server deletes that folder the moment a
    // new video arrives.
    sheetSave = saveCurrentSheet()
      .catch(() => { /* reported inside */ })
      .finally(() => { sheetSave = null; });
  }

  function backToSource() {
    state.job = 'idle';
    $('dlProgress').hidden = true;
    $('sourceCard').hidden = !state.meta;
    $('how').hidden = Boolean(state.meta);
    renderLibrary();
    showStep(1);
  }

  function onErrorEvent(ev) {
    if (state.job === 'downloading') {
      showError(ev.msg || 'Something went wrong.', ev.detail, { escape: true });
      state.meta = null;
      backToSource();
      return;
    }
    showError(ev.msg || 'The scan failed.', ev.detail);
    if (state.job === 'analyzing') {
      if (ev.captures?.length) onDone(ev.captures);
      else { state.job = 'ready'; showStep(2); }
    }
  }

  function onCancelled(ev) {
    if (state.job === 'downloading') {
      state.meta = null;
      backToSource();
    } else if (state.job === 'analyzing') {
      if (ev.captures?.length) onDone(ev.captures);
      else { state.job = 'ready'; showStep(2); }
    }
  }

  function applySnapshot(ev) {
    if (typeof ev.runId === 'number') state.runId = Math.max(state.runId, ev.runId);
    // Warnings come back with the snapshot so a reload does not silently drop
    // the reason a scan produced odd results.
    if (Array.isArray(ev.warnings)) { state.warnings = ev.warnings.slice(); renderWarnings(); }
    if (ev.lastAnalyze) {
      state.lastAnalyze = ev.lastAnalyze;
      state.sensitivity = ev.lastAnalyze.sensitivity ?? state.sensitivity;
      updateSensSeg();
    }
    const first = !state.snapshotApplied;
    state.snapshotApplied = true;
    if (ev.meta) setMeta(ev.meta);
    if (first) {
      switch (ev.job) {
        case 'downloading':
          state.job = 'downloading';
          setDlProgress(null, 'Working…');
          showStep(1);
          break;
        case 'ready':
          onDownloaded();
          break;
        case 'analyzing':
          state.job = 'analyzing';
          videoReady();
          state.maxStep = 3;
          resetProcessing();
          for (const c of ev.captures || []) addLiveCapture(c);
          showStep(3);
          break;
        case 'done':
          state.job = 'done';
          videoReady();
          buildReview(ev.captures || []);
          showStep(4);
          break;
        default:
          showStep(1);
      }
      return;
    }
    // Reconnected (sleep, network blip): reconcile any transition we missed.
    if (ev.job === 'done' && state.job !== 'done') onDone(ev.captures || state.captures);
    else if (ev.job === 'ready' && state.job === 'downloading') onDownloaded();
    else if (ev.job === 'ready' && state.job === 'analyzing') { state.job = 'ready'; if (state.step === 3) showStep(2); }
    else if (ev.job === 'idle' && state.job === 'downloading') { state.meta = null; backToSource(); }
  }

  const RUN_PHASES = new Set(['analyzing', 'analyze', 'composite', 'capture', 'warning', 'done', 'error', 'cancelled']);

  function handleEvent(ev) {
    // Ignore events about a video we have already moved on from. Pasting a
    // second link while the first was still downloading used to let the old
    // flow's events drive the UI back to the start screen.
    if (typeof ev.jobId === 'number') {
      if (state.jobId !== null && ev.jobId < state.jobId) return;
      if (ev.jobId > (state.jobId ?? -1)) state.jobId = ev.jobId;
      // A reload rebuilds the review from the server's snapshot but not the
      // library record it belongs to, so the next save wrote a second songsheet
      // for the same scan instead of updating the first. The binding is
      // remembered against the job it was made for, so only that same job can
      // adopt it back — a later scan gets a new id, as it should.
      if (state.sheetId === null && state.jobId !== null) {
        try {
          const held = JSON.parse(store.get('vtt.sheet', 'null'));
          if (held && held.id && held.jobId === state.jobId) state.sheetId = held.id;
        } catch { /* nothing remembered, or unreadable */ }
      }
    }
    if (RUN_PHASES.has(ev.phase) && typeof ev.runId === 'number' && ev.runId < state.runId) return; // stale run
    switch (ev.phase) {
      case 'state': applySnapshot(ev); break;
      case 'meta': setMeta(ev.meta); break;
      case 'download':
        state.job = 'downloading';
        setDlProgress(ev.pct, ev.msg);
        break;
      case 'downloaded': onDownloaded(); break;
      case 'suggestion': onSuggestion(ev.suggestion); break;
      case 'analyzing':
        state.runId = Math.max(state.runId, ev.runId || 0);
        if (ev.lastAnalyze) state.lastAnalyze = ev.lastAnalyze;
        if (state.job !== 'analyzing') {
          state.job = 'analyzing';
          resetProcessing();
          showStep(3);
        }
        break;
      case 'analyze':
      case 'composite': onProgress(ev); break;
      case 'capture': addLiveCapture(ev.capture); break;
      case 'warning': addWarning(ev.msg); break;
      case 'done': onDone(ev.captures); break;
      case 'error': onErrorEvent(ev); break;
      case 'cancelled': onCancelled(ev); break;
    }
  }

  function connectSSE() {
    const es = new EventSource('/api/events');
    let lostTimer = null;
    let lost = false;
    es.onmessage = (e) => {
      if (lostTimer) { clearTimeout(lostTimer); lostTimer = null; }
      if (lost) { lost = false; hideError(); }
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      handleEvent(ev);
    };
    // Without this the UI sits on "Scanning… 42%" for ever after the server
    // stops (crash, quit, machine asleep). EventSource retries on its own, so
    // only say something once it has really been failing for a few seconds.
    es.onerror = () => {
      if (lost || lostTimer) return;
      lostTimer = setTimeout(() => {
        lostTimer = null;
        if (es.readyState !== EventSource.OPEN) {
          lost = true;
          showError('Lost connection to VidToTab — reconnecting…');
        }
      }, 5000);
    };
    // EventSource reconnects by itself; the server re-sends a state snapshot.
  }

  // ---------- practice view ----------

  // A full-screen page at a time, for playing along. Arrows, space and
  // PageUp/PageDown turn pages — the last pair is what most Bluetooth
  // page-turner pedals send, so a pedal works without any extra support.
  let wakeLock = null;

  async function holdScreenAwake() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  }
  function releaseScreen() {
    try { wakeLock?.release(); } catch { /* already gone */ }
    wakeLock = null;
  }

  function showPracticePage(i) {
    const pages = visibleItems();
    if (!pages.length) return;
    const n = clamp(i, 0, pages.length - 1);
    state.practice = n;
    const it = pages[n];
    const img = $('practicePage');
    img.src = isOriginal(lookById(state.look)) ? it.srcColor : it.src;
    img.alt = `Page ${n + 1} of ${pages.length}, ${fmtTime(it.tStart)} to ${fmtTime(it.tEnd)}`;
    $('practicePos').textContent = `Page ${n + 1} of ${pages.length}  ·  ${fmtTime(it.tStart)}`;
  }

  function openPractice() {
    const pages = visibleItems();
    if (!pages.length) return;
    $('practice').hidden = false;
    showPracticePage(state.selected >= 0 ? visibleIndices().indexOf(state.selected) : 0);
    holdScreenAwake();
  }

  function closePractice() {
    state.practice = -1;
    $('practice').hidden = true;
    releaseScreen();
    $('practiceBtn').focus();
  }

  function practiceKeys(e) {
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); closePractice(); return; }
    // Backspace is deliberately not a page-turn key: it deletes a page in the
    // review list one Esc away, and a key that means two different things
    // depending on an invisible mode is a mistake waiting to happen.
    const forward = k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown' || k === 'Enter';
    const back = k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp';
    if (forward || back) {
      e.preventDefault();
      showPracticePage(state.practice + (forward ? 1 : -1));
    }
  }

  $('practiceBtn').addEventListener('click', openPractice);
  $('practiceBack').addEventListener('click', closePractice);
  $('practiceNext').addEventListener('click', () => showPracticePage(state.practice + 1));
  $('practicePrev').addEventListener('click', () => showPracticePage(state.practice - 1));
  // A phone that locks its screen drops the wake lock; take it again on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.practice >= 0) holdScreenAwake();
  });

  // ---------- songsheet library ----------

  // Every finished scan is kept here. The pages are stored as image blobs
  // rather than links, because the server deletes the work folder as soon as
  // another video is loaded — a saved sheet that kept links would open empty.
  // fetch does not reject on 404 — it resolves with ok:false, and .blob() on
  // that succeeds and hands back the error body. So a capture the server had
  // already deleted came back as a small non-null blob, the completeness check
  // counted it a page, and the songsheet was stored with an error body where the
  // image should be. Worse than the dropped page it was meant to catch, and
  // invisible until the songsheet was opened again.
  async function grabBlob(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const b = await r.blob();
      return b.size > 0 ? b : null;
    } catch {
      return null; // network failure, or a blob: URL already revoked
    }
  }

  async function saveCurrentSheet() {
    if (!hasStorage() || !state.items.length) return;
    // Bind the record, and everything that describes it, before the first
    // await. This fetches a blob per page, and the guard in openSheet does not
    // cover that window: onDone sets the job to 'done' and *then* calls this, so
    // the scan is no longer "busy" while it is still saving. Opening a stored
    // songsheet in between used to repoint state.sheetId — and every other field
    // was read at the end too, so the scan's pages landed in whatever had just
    // been opened, under that songsheet's title.
    const items = state.items;
    const target = {
      id: state.sheetId || newId(),
      jobId: state.jobId,
      title: state.title || state.meta?.title || 'Untitled songsheet',
      url: state.meta?.url || '',
      channel: state.meta?.channel || '',
      duration: state.meta?.duration || 0,
      recipe: state.lastAnalyze || {},
      look: state.look,
      paper: state.paper,
      thumbUrl: state.meta?.thumb ? '/thumb.jpg?v=' + state.thumbVersion : null,
    };
    const pages = [];
    for (const it of items) {
      if (it.deleted) continue;
      // Works for both a live capture (/captures/…) and a page already held as
      // a blob, so re-saving an opened songsheet needs no special case.
      const clean = await grabBlob(it.src);
      const color = it.srcColor && it.srcColor !== it.src ? await grabBlob(it.srcColor) : null;
      if (!clean) continue;
      pages.push({ tStart: it.tStart, tEnd: it.tEnd, alsoAt: it.alsoAt, w: it.w, h: it.h, clean, color });
    }
    // A page that could not be read back is not a page to quietly leave out.
    // These live in the server's work folder, which a new video deletes, so a
    // save racing one dropped whatever had already gone and stored a songsheet
    // with fewer pages than the scan found — silently, looking like success.
    const wanted = items.filter((it) => !it.deleted).length;
    if (pages.length !== wanted) {
      addWarning(`This songsheet was not saved: ${wanted - pages.length} of ${wanted} pages could not be read back. It is still on screen — export it, or scan again.`);
      return;
    }
    if (!pages.length) return;
    // Same trap, and the thumbnail is optional — a missing one must leave the
    // songsheet saveable rather than storing an error body as its picture.
    const thumb = target.thumbUrl ? await grabBlob(target.thumbUrl) : null;
    // Only claim the id for what is on screen if what is on screen is still
    // this scan. If something else was opened meanwhile, this saves as its own
    // record and leaves their view alone.
    if (state.items === items) state.sheetId = target.id;
    store.set('vtt.sheet', JSON.stringify({ id: target.id, jobId: target.jobId }));
    try {
      await saveSheet({
        id: target.id,
        title: target.title,
        url: target.url,
        channel: target.channel,
        duration: target.duration,
        recipe: target.recipe,
        look: target.look,
        paper: target.paper,
      }, pages, thumb);
      await requestPersistence();
      renderLibrary(); // so the home screen already shows it when you go back
    } catch (err) {
      addWarning('Could not save this songsheet: ' + err.message);
    }
  }

  // The sidebar's copy of the same records. Different job: the grid on the home
  // screen is for browsing and removing, this is for switching songsheets from
  // wherever you are — which is the whole reason the app view exists.
  function renderSideList(sheets) {
    const host = $('sideList');
    host.textContent = '';
    $('sideListLabel').hidden = sheets.length === 0;
    $('sideEmpty').hidden = sheets.length > 0;
    for (const s of sheets) {
      const b = el('button', 'side-item');
      b.type = 'button';
      b.dataset.sheet = s.id;
      b.title = s.title;
      const img = el('img', 'side-thumb');
      img.alt = '';
      img.loading = 'lazy';
      if (s.thumb) {
        const u = URL.createObjectURL(s.thumb);
        img.src = u;
        img.addEventListener('load', () => URL.revokeObjectURL(u), { once: true });
      }
      b.appendChild(img);
      const text = el('span', 'side-text');
      text.appendChild(el('span', 'side-name', s.title));
      text.appendChild(el('span', 'side-sub', `${s.pageCount} page${s.pageCount === 1 ? '' : 's'}`));
      b.appendChild(text);
      b.addEventListener('click', () => openSheet(s.id));
      const li = el('li');
      li.appendChild(b);
      host.appendChild(li);
    }
    syncSidebar();
  }

  async function renderLibrary() {
    const section = $('librarySection');
    if (!hasStorage()) { section.hidden = true; renderSideList([]); return; }
    let sheets = [];
    try { sheets = await listSheets(); } catch { sheets = []; }
    renderSideList(sheets);
    const host = $('libraryGrid');
    host.textContent = '';
    $('libCount').textContent = sheets.length ? `${sheets.length} saved` : '';
    $('libNote').textContent = sheets.length
      ? 'Kept in this browser. Export a PDF to keep a copy anywhere else.' : '';
    // No need to check whether a video is loaded: this section lives inside
    // step 1, so it is already only visible on the home screen. Hiding it
    // whenever a video was loaded meant it disappeared after the first scan —
    // exactly when someone has songsheets worth going back to.
    section.hidden = sheets.length === 0;
    for (const s of sheets) {
      const card = el('button', 'lib-card');
      card.type = 'button';
      const img = el('img', 'lib-thumb');
      img.alt = '';
      img.loading = 'lazy';
      if (s.thumb) {
        const u = URL.createObjectURL(s.thumb);
        img.src = u;
        img.addEventListener('load', () => URL.revokeObjectURL(u), { once: true });
      }
      card.appendChild(img);
      const body = el('div', 'lib-body');
      body.appendChild(el('div', 'lib-name', s.title));
      body.appendChild(el('div', 'lib-sub',
        [`${s.pageCount} page${s.pageCount === 1 ? '' : 's'}`, s.channel].filter(Boolean).join(' · ')));
      card.appendChild(body);
      const del = el('button', 'lib-del', '×');
      del.type = 'button';
      del.title = 'Remove from your songsheets';
      del.setAttribute('aria-label', 'Remove ' + s.title);
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await deleteSheet(s.id); showToast('Songsheet removed', false); } catch { /* already gone */ }
        renderLibrary();
      });
      card.appendChild(del);
      card.addEventListener('click', () => openSheet(s.id));
      host.appendChild(card);
    }
  }

  // A scan in flight owns the songsheet on screen. Opening a stored one during
  // it pointed state.sheetId at that stored record, and onDone then saved the
  // scan's pages straight over it — the saved songsheet was replaced by a
  // different video's, with nothing said. The library grid could already do
  // this from step 1, which is never disabled during a scan; the sidebar made
  // it reachable from every step, which is how it came to light.
  const scanBusy = () => state.job === 'downloading' || state.job === 'analyzing';

  async function openSheet(id) {
    if (scanBusy()) {
      showToast('Finish or cancel the scan first — opening a songsheet now would save the scan over it.');
      return;
    }
    let sheet = null;
    try { sheet = await getSheet(id); } catch { /* unreadable */ }
    if (!sheet || !sheet.pages?.length) { showError('That songsheet could not be opened.'); return; }
    state.sheetId = sheet.id;
    // No video is loaded for a saved sheet, so the source is metadata only.
    state.meta = { title: sheet.title, url: sheet.url, channel: sheet.channel, duration: sheet.duration, thumb: false, ready: false, width: 0, height: 0, fps: 0 };
    state.title = sheet.title;
    state.look = lookById(sheet.look).id;
    state.paper = sheet.paper === 'a4' ? 'a4' : 'letter';
    state.lastAnalyze = sheet.recipe?.rect ? sheet.recipe : null;
    state.deletedStamps = [];
    state.videoSet = false;
    state.job = 'done';
    state.maxStep = 4;
    state.fromLibrary = true;
    buildLookSeg();
    $('paperSelect').value = state.paper;
    buildReview(sheet.pages);
    $('librarySection').hidden = true;
    showStep(4);
  }

  // ---------- init ----------

  $('paperSelect').value = state.paper;
  buildLookSeg();
  // The attribute is already right (set inline, before paint); this catches the
  // button up with it. No write-back: nothing was chosen yet.
  setView(document.body.dataset.view, false);
  renderLibrary();

  // ?url=… lets a bookmark button, a shared link or (later) a vidtotab:// deep
  // link hand a video straight over. Routed through the same form as every
  // other entry, and the query is cleared so a reload does not start it again.
  (() => {
    let incoming = null;
    try { incoming = new URLSearchParams(location.search).get('url'); } catch { /* no search */ }
    if (!looksLikeLink(incoming)) return;
    try { history.replaceState(null, '', location.pathname); } catch { /* not allowed */ }
    loadLink(incoming);
  })();
  updateSensSeg();
  checkPreflight();
  connectSSE();
  renderStepper();
})();
