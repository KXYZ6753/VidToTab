// VidToTab server — local single-user app. node:http, no framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { runPipeline, cancelPipeline } from './pipeline/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const WORK = path.join(ROOT, 'work');
const VIDEO = path.join(WORK, 'video.mp4');
const THUMB = path.join(WORK, 'thumb.jpg');
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_CAP = 4 * 2 ** 30; // 4 GB
const YT_FMT = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
};

fs.mkdirSync(WORK, { recursive: true });

const have = (cmd, arg) => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const preflight = { ytdlp: have('yt-dlp', '--version'), ffmpeg: have('ffmpeg', '-version') };

// ---------------------------------------------------------------- job state

// ponytail: single in-memory job, single user
let job = freshJob('idle', null);

function freshJob(phase, meta) {
  // phase: idle | downloading | ready | analyzing | done
  return { phase, proc: null, cancelled: false, meta, captures: [], flow: null, analyze: null };
}

// Kill the child's whole process group (see detached spawn in runProc).
function killProc(p) {
  try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} }
}

async function stopCurrent() {
  job.cancelled = true;
  if (job.proc) killProc(job.proc);
  try { cancelPipeline(); } catch {}
  await Promise.allSettled([job.flow, job.analyze].filter(Boolean));
}

function resetWork() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
}

// Flows capture `my = job` at start; after every await they must bail if the
// job was superseded (identity changed) or cancelled — otherwise a stale flow
// would mutate the new job's state.
function bail(my) {
  if (my !== job) return true;
  if (my.cancelled) {
    my.phase = 'idle';
    broadcast({ phase: 'cancelled' });
    return true;
  }
  return false;
}

function flowError(my, msg, detail) {
  if (my !== job) return;
  my.phase = 'idle';
  const ev = { phase: 'error', msg };
  if (detail) ev.detail = String(detail).slice(-1000);
  broadcast(ev);
}

// ---------------------------------------------------------------- SSE hub

const sseClients = new Set();

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const snap = { phase: 'state', job: job.phase };
  if (job.meta) snap.meta = job.meta;
  if (job.captures.length) snap.captures = job.captures;
  res.write(`data: ${JSON.stringify(snap)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of sseClients) {
    try { c.write(line); } catch { sseClients.delete(c); }
  }
}

// ---------------------------------------------------------------- children

function runProc(my, cmd, args, onLine) {
  return new Promise(resolve => {
    let out = '', err = '';
    let p;
    try {
      // detached: own process group, so killProc can take out grandchildren
      // too (yt-dlp spawns ffmpeg for merges/HLS; SIGKILL can't be relayed)
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return resolve({ code: -1, out, err: String(e) });
    }
    my.proc = p;
    if (onLine) lineSplit(p.stdout, onLine);
    else p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.on('error', e => { my.proc = null; resolve({ code: -1, out, err: err + String(e) }); });
    p.on('close', code => { my.proc = null; resolve({ code, out, err }); });
  });
}

const run = (cmd, args) => runProc({}, cmd, args); // untracked (not cancellable)

function lineSplit(stream, fn) {
  let buf = '';
  stream.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      fn(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
  });
}

async function probe(file) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) return null;
  let j;
  try { j = JSON.parse(r.out); } catch { return null; }
  const v = (j.streams || []).find(s => s.codec_type === 'video');
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  return {
    duration: Number(j.format?.duration) || 0,
    width: v?.width || 0,
    height: v?.height || 0,
    vcodec: v?.codec_name || '',
    acodec: a?.codec_name || '',
    container: j.format?.format_name || '',
  };
}

// ---------------------------------------------------------------- flows

async function urlFlow(my, url) {
  const info = await runProc(my, 'yt-dlp', ['-j', '--no-playlist', '--', url]);
  if (bail(my)) return;
  if (info.code !== 0) return flowError(my, 'could not read video info', info.err);
  let j;
  try { j = JSON.parse(info.out); } catch { return flowError(my, 'unexpected yt-dlp output', info.out.slice(0, 300)); }
  my.meta = {
    title: j.title || url,
    url: j.webpage_url || url,
    duration: Number(j.duration) || 0,
    width: j.width || 0,
    height: j.height || 0,
    thumb: false,
    ready: false,
  };
  if (j.thumbnail) await fetchThumb(my, j.thumbnail);
  if (bail(my)) return;
  broadcast({ phase: 'meta', meta: my.meta });

  let last = -1;
  const dl = await runProc(my, 'yt-dlp',
    ['--newline', '--no-playlist', '-f', YT_FMT, '--merge-output-format', 'mp4', '-o', VIDEO, '--', url],
    line => {
      const m = /^\[download\]\s+([\d.]+)%/.exec(line);
      if (m) {
        const pct = Number(m[1]);
        if (pct !== last) { last = pct; broadcast({ phase: 'download', pct, msg: line }); }
      }
    });
  if (bail(my)) return;
  if (dl.code !== 0) return flowError(my, 'download failed', dl.err);
  await finishVideo(my);
}

async function fetchThumb(my, turl) {
  try {
    const r = await fetch(turl, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const src = path.join(WORK, 'thumb_src');
    fs.writeFileSync(src, Buffer.from(await r.arrayBuffer()));
    // normalize to jpeg (yt thumbnails are often webp) so pdf-lib can embed it
    const c = await run('ffmpeg', ['-y', '-i', src, '-frames:v', '1', '-q:v', '3', THUMB]);
    fs.rmSync(src, { force: true });
    if (c.code === 0 && my.meta) my.meta.thumb = true;
  } catch { /* thumbnail is optional */ }
}

async function fileFlow(my) {
  const src = path.join(WORK, 'upload.bin');
  const p = await probe(src);
  if (bail(my)) return;
  if (!p || !p.width) return flowError(my, 'file is not a readable video');
  const playable = p.container.includes('mp4') && p.vcodec === 'h264'
    && (!p.acodec || p.acodec === 'aac' || p.acodec === 'mp3');
  if (playable) {
    fs.renameSync(src, VIDEO);
  } else {
    // lossless remux first; full transcode only if the mp4 container rejects the streams
    let r = await convert(my, src, ['-c', 'copy'], p.duration, 'remuxing');
    if (bail(my)) return;
    if (r.code !== 0) {
      r = await convert(my, src,
        ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
        p.duration, 'transcoding');
      if (bail(my)) return;
      if (r.code !== 0) return flowError(my, 'could not convert file to mp4', r.err);
    }
    fs.rmSync(src, { force: true });
  }
  await finishVideo(my);
}

function convert(my, src, codecArgs, duration, label) {
  let last = -1;
  return runProc(my, 'ffmpeg',
    ['-y', '-i', src, ...codecArgs, '-movflags', '+faststart', '-nostats', '-progress', 'pipe:1', VIDEO],
    line => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && duration > 0) {
        const pct = Math.min(100, Math.round(Number(m[1]) / 1e4 / duration));
        if (pct !== last) { last = pct; broadcast({ phase: 'download', pct, msg: label }); }
      }
    });
}

async function finishVideo(my) {
  const p = await probe(VIDEO);
  if (bail(my)) return;
  if (!p || !p.width) return flowError(my, 'output video unreadable');
  if (!fs.existsSync(THUMB)) {
    await run('ffmpeg', ['-y', '-ss', String(Math.min(3, p.duration / 2 || 0)),
      '-i', VIDEO, '-frames:v', '1', '-q:v', '3', THUMB]);
    if (bail(my)) return;
  }
  Object.assign(my.meta, {
    duration: p.duration || my.meta.duration,
    width: p.width,
    height: p.height,
    thumb: fs.existsSync(THUMB),
    ready: true,
  });
  my.phase = 'ready';
  broadcast({ phase: 'meta', meta: my.meta });
  broadcast({ phase: 'downloaded' });
}

// ---------------------------------------------------------------- handlers

async function postUrl(req, res) {
  const body = await readJson(req).catch(() => null);
  let url;
  try { url = new URL(String(body?.url ?? '')); } catch { /* invalid */ }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return sendJson(res, 400, { error: 'invalid http(s) URL' });
  }
  if (!preflight.ytdlp) return sendJson(res, 500, { error: 'yt-dlp not installed (brew install yt-dlp)' });
  await stopCurrent();
  resetWork();
  job = freshJob('downloading', null);
  sendJson(res, 202, { ok: true });
  job.flow = urlFlow(job, url.href);
}

async function putFile(req, res, u) {
  if (!preflight.ffmpeg) return sendJson(res, 500, { error: 'ffmpeg not installed (brew install ffmpeg)' });
  if (Number(req.headers['content-length']) > UPLOAD_CAP) {
    return sendJson(res, 413, { error: 'file too large (4 GB max)' });
  }
  const name = path.basename(u.searchParams.get('name') || 'video');
  await stopCurrent();
  resetWork();
  job = freshJob('downloading', {
    title: name.replace(/\.[^.]+$/, '') || name,
    url: '',
    duration: 0,
    width: 0,
    height: 0,
    thumb: false,
    ready: false,
  });
  const my = job;
  broadcast({ phase: 'meta', meta: my.meta });
  const src = path.join(WORK, 'upload.bin');
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(src);
      // pipe() doesn't destroy ws when the source errors — an aborted upload
      // would leak the fd (and pin the partial file's disk after resetWork)
      const fail = e => { ws.destroy(); reject(e); };
      let n = 0;
      req.on('data', d => {
        n += d.length;
        if (n > UPLOAD_CAP) { fail(new Error('too large')); req.destroy(); }
      });
      req.on('error', fail);
      ws.on('error', fail);
      ws.on('finish', resolve);
      req.pipe(ws);
    });
  } catch (e) {
    if (my === job) my.phase = 'idle';
    if (!res.headersSent) {
      sendJson(res, e.message === 'too large' ? 413 : 500, { error: 'upload failed: ' + e.message });
    }
    return;
  }
  sendJson(res, 202, { ok: true });
  my.flow = fileFlow(my);
}

async function postAnalyze(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'invalid JSON body' });
  const meta = job.meta;
  if (!meta?.ready || !fs.existsSync(VIDEO)) return sendJson(res, 409, { error: 'no video ready' });
  const crop = clampRect(body.rect, meta.width, meta.height);
  if (!crop) return sendJson(res, 400, { error: 'invalid rect' });
  let startTime = Number(body.startTime);
  if (!Number.isFinite(startTime) || startTime < 0) startTime = 0;
  if (meta.duration) startTime = Math.min(startTime, meta.duration);
  let sensitivity = Number(body.sensitivity);
  if (!Number.isFinite(sensitivity)) sensitivity = 0.5;
  sensitivity = Math.max(0, Math.min(1, sensitivity));

  if (job.phase === 'analyzing') { // supersede the running analysis (e.g. sensitivity re-run)
    try { cancelPipeline(); } catch {}
    await job.analyze;
  }
  const my = job;
  my.phase = 'analyzing';
  my.captures = [];
  sendJson(res, 202, { ok: true });
  my.analyze = runPipeline(VIDEO, { crop, startTime, sensitivity, workDir: WORK }, ev => {
    if (my !== job) return;
    if (ev.phase === 'capture') my.captures.push(ev.capture);
    broadcast(ev);
  }).then(captures => {
    if (my !== job) return;
    my.captures = captures;
    my.phase = 'done';
    broadcast({ phase: 'done', captures });
  }, err => {
    if (my !== job) return;
    my.phase = 'ready';
    if (err?.cancelled) return broadcast({ phase: 'cancelled' });
    const ev = { phase: 'error', msg: err?.userMsg || err?.message || 'analysis failed' };
    if (err?.detail) ev.detail = String(err.detail).slice(-1000);
    broadcast(ev);
  });
}

// Round to even integers, clamp inside the video frame. null if unusable.
function clampRect(r, vw, vh) {
  if (!r || typeof r !== 'object' || vw < 2 || vh < 2) return null;
  let x = Math.floor(Number(r.x));
  let y = Math.floor(Number(r.y));
  let w = Math.floor(Number(r.w));
  let h = Math.floor(Number(r.h));
  if (![x, y, w, h].every(Number.isFinite)) return null;
  x = Math.max(0, Math.min(x, vw - 2)); x -= x % 2;
  y = Math.max(0, Math.min(y, vh - 2)); y -= y % 2;
  w = Math.max(2, Math.min(w, vw - x)); w -= w % 2;
  h = Math.max(2, Math.min(h, vh - y)); h -= h % 2;
  if (w < 2 || h < 2) return null;
  return { x, y, w, h };
}

function postCancel(req, res) {
  if (job.phase === 'downloading') {
    job.cancelled = true; // download flow bails and broadcasts 'cancelled'
    if (job.proc) killProc(job.proc);
  } else if (job.phase === 'analyzing') {
    try { cancelPipeline(); } catch {} // pipeline rejects with .cancelled → handler broadcasts
  }
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- export

const PAGE_W = 612, PAGE_H = 792, MARGIN = 36, CONTENT_W = 540; // US Letter, pt

async function postExport(req, res) {
  const body = await readJson(req).catch(() => null);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return sendJson(res, 400, { error: 'items required' });
  const files = [];
  for (const it of items) {
    const name = path.basename(String(it?.png || '')); // trust only basename
    const f = path.join(WORK, name);
    if (!name.endsWith('.png') || !fs.existsSync(f)) {
      return sendJson(res, 400, { error: 'missing capture: ' + name });
    }
    files.push(f);
  }
  const title = String(body.title || job.meta?.title || 'VidToTab export');
  const srcUrl = String(body.url ?? job.meta?.url ?? '');
  const bytes = await buildPdf(title, srcUrl, files);
  const safe = title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'vidtotab';
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': bytes.length,
    'Content-Disposition': `attachment; filename="${safe}.pdf"`,
  });
  res.end(Buffer.from(bytes));
}

async function buildPdf(title, srcUrl, files) {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  // header: thumbnail beside wrapped title, source url below in gray
  let textX = MARGIN;
  let thumbBottom = y;
  if (fs.existsSync(THUMB)) {
    try {
      // new Uint8Array copy: pdf-lib reads data.buffer directly, and a Node
      // Buffer is an offset view into a shared pool — passing it raw corrupts
      const img = await doc.embedJpg(new Uint8Array(fs.readFileSync(THUMB)));
      const th = 90, tw = img.width * (th / img.height);
      page.drawImage(img, { x: MARGIN, y: y - th, width: tw, height: th });
      textX = MARGIN + tw + 12;
      thumbBottom = y - th;
    } catch { /* not a jpeg — skip */ }
  }
  let ty = y;
  for (const line of wrapText(winAnsi(title), bold, 16, PAGE_W - MARGIN - textX)) {
    ty -= 20;
    page.drawText(line, { x: textX, y: ty, size: 16, font: bold });
  }
  if (srcUrl) {
    ty -= 14;
    page.drawText(winAnsi(srcUrl).slice(0, 120), {
      x: textX, y: ty, size: 9, font: helv, color: rgb(0.45, 0.45, 0.45),
    });
  }
  y = Math.min(thumbBottom, ty) - 18;

  for (const f of files) {
    const img = await doc.embedPng(new Uint8Array(fs.readFileSync(f)));
    let w = CONTENT_W;
    let h = img.height * (CONTENT_W / img.width);
    const maxH = PAGE_H - 2 * MARGIN;
    if (h > maxH) { h = maxH; w = img.width * (h / img.height); } // never split a capture
    if (y - h < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
    page.drawImage(img, { x: MARGIN, y: y - h, width: w, height: h });
    y -= h + 12;
  }
  return doc.save();
}

function wrapText(text, font, size, maxW) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return ['Untitled'];
  const lines = [];
  let line = '';
  for (const wd of words) {
    const t = line ? line + ' ' + wd : wd;
    if (!line || font.widthOfTextAtSize(t, size) <= maxW) line = t;
    else { lines.push(line); line = wd; }
  }
  lines.push(line);
  return lines.slice(0, 3);
}

// Standard 14 fonts only encode WinAnsi; strip anything else (emoji in titles).
function winAnsi(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '')
    .trim();
}

// ---------------------------------------------------------------- files

// pipe() never destroys the source on client abort — an aborted request would
// leak the fd forever (and pin deleted inodes after resetWork). Always sendStream.
function sendStream(res, rs) {
  res.on('close', () => rs.destroy());
  rs.on('error', () => { try { res.destroy(); } catch {} });
  rs.pipe(res);
}

function serveFile(res, file, mime) {
  let st;
  try { st = fs.statSync(file); } catch { return sendJson(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size });
  sendStream(res, fs.createReadStream(file));
}

function serveCapture(res, pathname) {
  let name;
  try { name = path.basename(decodeURIComponent(pathname.slice('/captures/'.length))); }
  catch { return sendJson(res, 400, { error: 'bad path' }); }
  serveFile(res, path.join(WORK, name), MIME[path.extname(name).toLowerCase()] || 'application/octet-stream');
}

function serveStaticPublic(res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); }
  catch { return sendJson(res, 400, { error: 'bad path' }); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 404, { error: 'not found' });
  serveFile(res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

function serveVideo(req, res) {
  let st;
  try { st = fs.statSync(VIDEO); } catch { return sendJson(res, 404, { error: 'no video' }); }
  const size = st.size;
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    sendStream(res, fs.createReadStream(VIDEO));
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  let start, end;
  if (m[1] === '') { // suffix range: last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
  });
  sendStream(res, fs.createReadStream(VIDEO, { start, end }));
}

// ---------------------------------------------------------------- http plumbing

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', d => {
      n += d.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); }
      else chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function route(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${u.pathname}`;
  if (key === 'GET /api/events') return sse(req, res);
  if (key === 'GET /api/preflight') {
    preflight.ytdlp = have('yt-dlp', '--version'); // recompute: user may have just installed
    preflight.ffmpeg = have('ffmpeg', '-version');
    return sendJson(res, 200, { ok: preflight.ytdlp && preflight.ffmpeg, ...preflight });
  }
  if (key === 'GET /api/meta') return job.meta ? sendJson(res, 200, job.meta) : sendJson(res, 404, { error: 'no video' });
  if (key === 'GET /api/video') return serveVideo(req, res);
  if (key === 'GET /thumb.jpg') return serveFile(res, THUMB, 'image/jpeg');
  if (req.method === 'GET' && u.pathname.startsWith('/captures/')) return serveCapture(res, u.pathname);
  if (key === 'POST /api/video/url') return postUrl(req, res);
  if (key === 'PUT /api/video/file') return putFile(req, res, u);
  if (key === 'POST /api/analyze') return postAnalyze(req, res);
  if (key === 'POST /api/cancel') return postCancel(req, res);
  if (key === 'POST /api/export') return postExport(req, res);
  if (req.method === 'GET') return serveStaticPublic(res, u.pathname);
  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(e => {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  });
});
server.requestTimeout = 0; // default 300s would kill multi-GB uploads

// Detached children survive Ctrl-C on the server; sweep them on the way out.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (job.proc) killProc(job.proc);
    try { cancelPipeline(); } catch {}
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`VidToTab running at http://localhost:${PORT}`);
  if (!preflight.ytdlp || !preflight.ffmpeg) {
    const missing = [!preflight.ytdlp && 'yt-dlp', !preflight.ffmpeg && 'ffmpeg'].filter(Boolean).join(' ');
    console.error(`missing tools: ${missing} — brew install ${missing}`);
  }
});
