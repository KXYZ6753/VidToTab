// VidToTab server — local single-user app. node:http, no framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PDFDocument, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { runPipeline, cancelPipeline } from './pipeline/index.js';
import { detectRegion } from './pipeline/detect.js';
import { YT_BASE_ARGS, YT_DOWNLOAD_ARGS, YT_CLIENT_FALLBACKS } from './pipeline/config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const WORK = path.join(ROOT, 'work');
const VIDEO = path.join(WORK, 'video.mp4');
const THUMB = path.join(WORK, 'thumb.jpg');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // loopback unless deliberately opened up
const UPLOAD_CAP = 4 * 2 ** 30; // 4 GB

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

// Async tool checks: a spawnSync here stalls SSE and video range requests.
const have = (cmd, arg) => new Promise(resolve => {
  const p = spawn(cmd, [arg], { stdio: 'ignore' });
  p.on('error', () => resolve(false));
  p.on('close', code => resolve(code === 0));
});
const preflight = { ytdlp: false, ffmpeg: false };
async function checkTools() {
  [preflight.ytdlp, preflight.ffmpeg] = await Promise.all([have('yt-dlp', '--version'), have('ffmpeg', '-version')]);
  return preflight;
}
await checkTools();

// ---------------------------------------------------------------- job state

// Single in-memory job, single user.
// jobCounter has to be initialised before the first freshJob() call below,
// otherwise that call reads it inside its temporal dead zone.
let jobCounter = 0;
let runCounter = 0;
let job = freshJob('idle', null);

function freshJob(phase, meta) {
  // phase: idle | downloading | ready | analyzing | done
  return {
    id: ++jobCounter, phase, proc: null, cancelled: false, superseded: false, meta,
    captures: [], prevCaptures: [], warnings: [],
    flow: null, analyze: null, detect: null, upload: null, uploadPath: null, runId: 0, lastAnalyze: null,
  };
}

// Kill the child's whole process group (see detached spawn in runProc).
function killProc(p) {
  try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} }
}

async function stopCurrent() {
  job.cancelled = true;
  // Superseded (a new video is loading) rather than cancelled by the user: the
  // old flow must not announce 'cancelled', or the UI drops out of the new
  // video's screen until its first event arrives seconds later.
  job.superseded = true;
  job.runId = -1; // silence any analysis still settling
  if (job.proc) killProc(job.proc);
  // An upload in flight has no process to kill: without destroying the request
  // it keeps streaming gigabytes into a file resetWork already deleted, and
  // then hands the *next* job's upload to a stale flow.
  try { job.upload?.destroy(); } catch { /* already closed */ }
  try { cancelPipeline(); } catch {}
  await Promise.allSettled([job.flow, job.analyze, job.detect].filter(Boolean));
}

function resetWork() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
}

// Flows capture `my = job` at start; after every await they must bail if the
// job was superseded (identity changed) or cancelled — otherwise a stale flow
// would mutate the new job's state.
function bail(my) {
  if (my !== job || my.superseded) return true;
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
  if (detail) ev.detail = String(detail).slice(-1500);
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
  const snap = { phase: 'state', jobId: job.id, job: job.phase, runId: job.runId };
  if (job.meta) snap.meta = job.meta;
  if (job.captures.length) snap.captures = job.captures;
  if (job.lastAnalyze) snap.lastAnalyze = job.lastAnalyze;
  if (job.warnings.length) snap.warnings = job.warnings; // survive a reload
  res.write(`data: ${JSON.stringify(snap)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

function broadcast(ev) {
  // Every event carries the job it belongs to, so a client that reconnects mid
  // switch can tell a late event about the old video from a current one.
  const line = `data: ${JSON.stringify({ jobId: job.id, ...ev })}\n\n`;
  for (const c of sseClients) {
    try { c.write(line); } catch { sseClients.delete(c); }
  }
}

// Comment pings keep idle connections from being reaped by sleep-happy stacks.
setInterval(() => {
  for (const c of sseClients) {
    try { c.write(':\n\n'); } catch { sseClients.delete(c); }
  }
}, 30000).unref();

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
  const rate = (s) => {
    const [n, d] = String(s || '').split('/').map(Number);
    return n > 0 && d > 0 ? n / d : 0;
  };
  // ffmpeg applies the display matrix when it decodes, and so does the browser,
  // so report the size as displayed. Without this a portrait phone video is
  // measured 1080x1920 while every decoded frame arrives 1920x1080, and the tab
  // box is drawn in the wrong coordinate space. Current ffmpeg no longer writes
  // the legacy `rotate` tag — the angle only shows up as Display Matrix side
  // data — but the tag is still read here for files made by older tools.
  const rotation = Math.abs(Number(
    (v?.side_data_list || []).find((d) => d.rotation != null)?.rotation ?? v?.tags?.rotate ?? 0,
  ) % 180);
  const swap = rotation === 90;
  const vw = v?.width || 0, vh = v?.height || 0;
  return {
    duration: Number(j.format?.duration) || 0,
    width: swap ? vh : vw,
    height: swap ? vw : vh,
    rotation,
    fps: Math.round((rate(v?.avg_frame_rate) || rate(v?.r_frame_rate)) * 100) / 100,
    vcodec: v?.codec_name || '',
    acodec: a?.codec_name || '',
    container: j.format?.format_name || '',
  };
}

// ---------------------------------------------------------------- flows

async function urlFlow(my, url) {
  const info = await runProc(my, 'yt-dlp', ['-j', ...YT_BASE_ARGS, '--', url]);
  if (bail(my)) return;
  if (info.code !== 0) return flowError(my, friendlyYtError(info.err, 'Could not read that link.'), info.err);
  let j;
  // A playlist link prints one JSON object per line, which used to fail the
  // parse and report "Unexpected response" for a link that is simply the wrong
  // kind. Read the first object and say what to do instead.
  try { j = JSON.parse(info.out.trim().split('\n')[0] || '{}'); }
  catch { return flowError(my, 'Unexpected response from yt-dlp.', info.out.slice(0, 300)); }
  if (j._type === 'playlist' || j.entries) {
    return flowError(my, 'That link is a playlist. Open one video from it and paste that link instead.');
  }
  // A live stream never finishes: yt-dlp would keep recording until cancelled.
  if (j.is_live) {
    return flowError(my, 'That video is live right now. Try again once the stream has ended.');
  }
  my.meta = {
    title: j.title || url,
    url: j.webpage_url || url,
    channel: j.channel || j.uploader || '',
    duration: Number(j.duration) || 0,
    width: j.width || 0,
    height: j.height || 0,
    fps: 0,
    thumb: false,
    ready: false,
  };
  if (j.thumbnail) await fetchThumb(my, j.thumbnail);
  if (bail(my)) return;
  broadcast({ phase: 'meta', meta: my.meta });

  // YouTube intermittently answers 403 on media requests for some player
  // clients; a fresh yt-dlp run through another client usually succeeds.
  let dl = null;
  for (const [i, client] of YT_CLIENT_FALLBACKS.entries()) {
    clearDownloads();
    if (i > 0) broadcast({ phase: 'download', pct: 0, msg: `YouTube refused the stream — retrying via the ${client.label}` });
    dl = await download(my, url, client.args);
    if (bail(my)) return;
    if (dl.code === 0 && findDownloaded()) break;
    if (!/403|Forbidden|Unable to download video data|Requested format is not available|page needs to be reloaded/i.test(dl.err)) break;
  }
  if (dl.code !== 0) return flowError(my, friendlyYtError(dl.err, 'The download failed.'), dl.err);
  const got = findDownloaded();
  if (!got) return flowError(my, 'The download finished but produced no video file.', dl.err);
  const r = await toPlayableMp4(my, got);
  if (bail(my)) return;
  if (r) return flowError(my, r.msg, r.detail);
  await finishVideo(my);
}

function download(my, url, extraArgs) {
  let stage = 0, last = -1;
  return runProc(my, 'yt-dlp',
    ['--newline', ...YT_DOWNLOAD_ARGS, ...extraArgs, '-o', path.join(WORK, 'video.%(ext)s'), '--', url],
    line => {
      if (line.startsWith('[download] Destination:')) stage++;
      if (line.startsWith('[Merger]') || line.startsWith('[VideoRemuxer]')) {
        broadcast({ phase: 'download', pct: 100, msg: 'Finishing up' });
        return;
      }
      const m = /^\[download\]\s+([\d.]+)%/.exec(line);
      if (!m) return;
      // video stream first (most of the bytes), then audio
      const p = Number(m[1]);
      const pct = Math.round(stage <= 1 ? p * 0.9 : 90 + p * 0.1);
      if (pct !== last) {
        last = pct;
        broadcast({ phase: 'download', pct, msg: stage <= 1 ? 'Downloading video' : 'Downloading audio' });
      }
    });
}

function friendlyYtError(err, fallback) {
  const e = String(err || '');
  if (/Unsupported URL|is not a valid URL/i.test(e)) return 'That link isn’t a video page yt-dlp can read.';
  if (/Private video|Video unavailable|This video is unavailable/i.test(e)) return 'That video is private or unavailable.';
  if (/confirm your age|Sign in/i.test(e)) return 'YouTube requires sign-in for this video, so it can’t be downloaded here.';
  if (/403|Forbidden/i.test(e)) return 'YouTube blocked the download. Try again in a minute — or update yt-dlp (brew upgrade yt-dlp).';
  if (/resolve|getaddrinfo|Network is unreachable|timed out/i.test(e)) return 'Couldn’t reach YouTube — check your internet connection.';
  return fallback;
}

const DOWNLOADED = /^video\.(mp4|webm|mkv|mov|m4v)$/;
function findDownloaded() {
  if (fs.existsSync(VIDEO)) return VIDEO;
  const f = fs.readdirSync(WORK).find(n => DOWNLOADED.test(n));
  return f ? path.join(WORK, f) : null;
}
function clearDownloads() {
  for (const f of fs.readdirSync(WORK)) if (f.startsWith('video.')) fs.rmSync(path.join(WORK, f), { force: true });
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
  const r = await toPlayableMp4(my, my.uploadPath || path.join(WORK, 'upload.bin'));
  if (bail(my)) return;
  if (r) return flowError(my, r.msg, r.detail);
  await finishVideo(my);
}

const PLAY_V = new Set(['h264', 'hevc', 'av1', 'vp9']);
const PLAY_A = new Set(['', 'aac', 'mp3', 'opus']);

// Leave a browser-playable mp4 at VIDEO: rename when already fine, else copy
// the video stream into mp4 (re-encoding only audio if needed), else fully
// transcode. Returns null on success or {msg, detail}.
async function toPlayableMp4(my, src) {
  const p = await probe(src);
  // Probing is slow enough for the job to change underneath us; writing VIDEO
  // now would clobber whatever the new job just put there. Callers check
  // bail(my) before they look at this return value.
  if (my !== job || my.cancelled) return { superseded: true, msg: 'The video changed.' };
  if (!p || !p.width) return { msg: 'That file isn’t a readable video.' };
  const playable = p.container.includes('mp4') && PLAY_V.has(p.vcodec) && PLAY_A.has(p.acodec);
  if (playable) {
    if (src !== VIDEO) fs.renameSync(src, VIDEO);
    return null;
  }
  const tmp = path.join(WORK, 'source.bin');
  fs.renameSync(src, tmp);
  let r = { code: -1, err: '' };
  if (PLAY_V.has(p.vcodec)) {
    r = await convert(my, tmp, ['-c:v', 'copy', ...(PLAY_A.has(p.acodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac'])], p.duration, 'Converting to mp4');
  }
  if (r.code !== 0 && !my.cancelled && my === job) {
    r = await convert(my, tmp,
      ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
      p.duration, 'Transcoding');
  }
  fs.rmSync(tmp, { force: true });
  return r.code === 0 ? null : { msg: 'Could not convert the video to a playable mp4.', detail: r.err };
}

function convert(my, src, codecArgs, duration, label) {
  let last = -1;
  return runProc(my, 'ffmpeg',
    ['-y', '-i', src, '-sn', '-dn', ...codecArgs, '-movflags', '+faststart', '-nostats', '-progress', 'pipe:1', VIDEO],
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
  if (!p || !p.width) return flowError(my, 'The downloaded video is unreadable.');
  if (!fs.existsSync(THUMB)) {
    await run('ffmpeg', ['-y', '-ss', String(Math.min(3, p.duration / 2 || 0)),
      '-i', VIDEO, '-frames:v', '1', '-q:v', '3', THUMB]);
    if (bail(my)) return;
  }
  Object.assign(my.meta, {
    duration: p.duration || my.meta.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    thumb: fs.existsSync(THUMB),
    ready: true,
    suggestion: null,
  });
  my.phase = 'ready';
  broadcast({ phase: 'meta', meta: my.meta });
  broadcast({ phase: 'downloaded' });
  my.detect = suggestRegion(my);
}

// Find the tab area in the background; the UI pre-draws it for confirmation.
async function suggestRegion(my, count) {
  let s = null;
  try {
    s = await detectRegion(VIDEO, { duration: my.meta.duration, width: my.meta.width, height: my.meta.height, count });
  } catch { /* detection is best-effort */ }
  if (my !== job) return null;
  my.meta.suggestion = s?.crop
    ? { crop: s.crop, confidence: s.confidence, polarity: s.polarity, startTime: s.startTime, tabRange: s.tabRange }
    : { crop: null, confidence: s?.confidence ?? 0 };
  broadcast({ phase: 'suggestion', suggestion: my.meta.suggestion });
  return my.meta.suggestion;
}

// ---------------------------------------------------------------- handlers

async function postUrl(req, res) {
  const body = await readJson(req).catch(() => null);
  let url;
  try { url = new URL(String(body?.url ?? '').trim()); } catch { /* invalid */ }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return sendJson(res, 400, { error: 'Paste a full http(s) link.' });
  }
  if (!preflight.ytdlp) return sendJson(res, 500, { error: 'yt-dlp is not installed (brew install yt-dlp)' });
  await stopCurrent();
  resetWork();
  job = freshJob('downloading', null);
  sendJson(res, 202, { ok: true });
  const my = job;
  // A synchronous fs throw inside the flow used to surface as an unhandled
  // rejection, which ends the process on Node 26.
  my.flow = urlFlow(my, url.href).catch((e) => flowError(my, 'Something went wrong.', e?.stack || String(e)));
}

async function putFile(req, res, u) {
  if (!preflight.ffmpeg) return sendJson(res, 500, { error: 'ffmpeg is not installed (brew install ffmpeg)' });
  if (Number(req.headers['content-length']) > UPLOAD_CAP) {
    return sendJson(res, 413, { error: 'File too large (4 GB max).' });
  }
  const name = path.basename(u.searchParams.get('name') || 'video');
  await stopCurrent();
  resetWork();
  job = freshJob('downloading', {
    title: name.replace(/\.[^.]+$/, '') || name,
    url: '',
    channel: '',
    duration: 0,
    width: 0,
    height: 0,
    fps: 0,
    thumb: false,
    ready: false,
  });
  const my = job;
  broadcast({ phase: 'meta', meta: my.meta });
  // Per-job filename: with a shared upload.bin, dropping a second file made the
  // first upload's flow probe and rename the second one's partial file.
  const src = path.join(WORK, `upload-${my.id}.bin`);
  my.uploadPath = src;
  my.upload = req; // so stopCurrent can cut a superseded upload off
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
    my.upload = null;
    fs.rmSync(src, { force: true });
    if (my === job) my.phase = 'idle';
    if (!res.headersSent) {
      sendJson(res, e.message === 'too large' ? 413 : 500, { error: 'Upload failed: ' + e.message });
    }
    return;
  }
  my.upload = null;
  // Superseded while the bytes were still arriving: leave the new job alone.
  if (my !== job || my.cancelled) {
    fs.rmSync(src, { force: true });
    if (!res.headersSent) sendJson(res, 409, { error: 'Replaced by a newer video.' });
    return;
  }
  sendJson(res, 202, { ok: true });
  my.flow = fileFlow(my).catch((e) => flowError(my, 'Something went wrong.', e?.stack || String(e)));
}

async function postDetect(req, res) {
  const meta = job.meta;
  if (!meta?.ready || !fs.existsSync(VIDEO)) return sendJson(res, 409, { error: 'No video is ready yet.' });
  const my = job;
  if (my.detect) await my.detect.catch(() => {});
  my.detect = suggestRegion(my, 28); // a denser sample than the automatic pass
  const s = await my.detect;
  if (my !== job) return sendJson(res, 409, { error: 'The video changed.' });
  sendJson(res, 200, { suggestion: s });
}

async function postAnalyze(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'invalid JSON body' });
  const meta = job.meta;
  if (!meta?.ready || !fs.existsSync(VIDEO)) return sendJson(res, 409, { error: 'No video is ready yet.' });
  const crop = clampRect(body.rect, meta.width, meta.height);
  if (!crop || crop.w < 16 || crop.h < 16) return sendJson(res, 400, { error: 'The selected region is too small.' });
  let startTime = Number(body.startTime);
  if (!Number.isFinite(startTime) || startTime < 0) startTime = 0;
  if (meta.duration && startTime > meta.duration - 1) {
    return sendJson(res, 400, { error: 'The start time is at the very end of the video — seek earlier.' });
  }
  let sensitivity = Number(body.sensitivity);
  if (!Number.isFinite(sensitivity)) sensitivity = 0.5;
  sensitivity = Math.max(0, Math.min(1, sensitivity));

  const my = job;
  const runId = ++runCounter;
  const superseding = my.phase === 'analyzing';
  my.runId = runId; // silences the superseded run's handlers before they settle
  if (superseding) {
    try { cancelPipeline(); } catch {}
    await my.analyze?.catch(() => {});
    if (my !== job || my.runId !== runId) return sendJson(res, 409, { error: 'superseded' });
  } else if (my.captures.length) {
    my.prevCaptures = my.captures;
  }
  my.phase = 'analyzing';
  my.captures = [];
  my.warnings = [];
  my.lastAnalyze = { rect: crop, startTime, sensitivity };
  sendJson(res, 202, { ok: true, runId });
  broadcast({ phase: 'analyzing', runId, lastAnalyze: my.lastAnalyze });

  const polarity = meta.suggestion?.crop ? meta.suggestion.polarity : null;
  const mine = () => my === job && my.runId === runId;
  // allowFallback is opt-in: without it a region with no tab returns no pages
  // and says so, instead of inventing a capture every 4 seconds.
  const allowFallback = body.allowFallback === true;
  my.analyze = runPipeline(VIDEO, { crop, startTime, sensitivity, workDir: WORK, polarity, allowFallback }, ev => {
    if (!mine()) return;
    if (ev.phase === 'capture') my.captures.push(ev.capture);
    // Kept on the job: warnings were emitted during step 3 and lost the moment
    // the UI moved to step 4, so nobody ever read them.
    if (ev.phase === 'warning' && ev.msg) my.warnings.push(ev.msg);
    broadcast({ ...ev, runId });
  }).then(captures => {
    if (!mine()) return;
    my.captures = captures;
    my.prevCaptures = [];
    my.phase = 'done';
    broadcast({ phase: 'done', captures, runId });
  }, err => {
    if (!mine()) return;
    // A failed or cancelled re-run falls back to the previous results (their
    // PNGs are run-unique and still on disk).
    my.captures = my.prevCaptures;
    my.phase = my.captures.length ? 'done' : 'ready';
    if (err?.cancelled) return broadcast({ phase: 'cancelled', runId, captures: my.captures });
    const ev = { phase: 'error', runId, msg: err?.userMsg || err?.message || 'Analysis failed.', captures: my.captures };
    if (err?.detail || err?.stderr) ev.detail = String(err.detail || err.stderr).slice(-1500);
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

const PAPER = { letter: [612, 792], a4: [595.28, 841.89] }; // pt
const MARGIN = 36;

async function postExport(req, res) {
  const body = await readJson(req, 32e6).catch(() => null);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return sendJson(res, 400, { error: 'Nothing to export.' });
  const files = [];
  for (const it of items) {
    const name = path.basename(String(it?.png || '')); // trust only basename
    const f = path.join(WORK, name);
    if (!name.endsWith('.png') || !fs.existsSync(f)) {
      return sendJson(res, 400, { error: 'Missing capture: ' + name });
    }
    files.push(f);
  }
  const title = String(body.title || job.meta?.title || 'VidToTab export').slice(0, 300);
  const srcUrl = String(body.url ?? job.meta?.url ?? '');
  let header = null;
  if (typeof body.headerPng === 'string' && body.headerPng.startsWith('data:image/png;base64,')) {
    header = Buffer.from(body.headerPng.slice('data:image/png;base64,'.length), 'base64');
  }
  const paper = PAPER[body.paper] ? body.paper : 'letter';
  const bytes = await buildPdf({ title, srcUrl, files, paper, header });
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': bytes.length,
    'Content-Disposition': contentDisposition(fileSafe(title) + '.pdf'),
  });
  res.end(Buffer.from(bytes));
}

// Keep letters of every script; drop only what filesystems reject.
function fileSafe(title) {
  return String(title).normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 100) || 'vidtotab';
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function buildPdf({ title, srcUrl, files, paper, header }) {
  const [PW, PH] = PAPER[paper];
  const CW = PW - 2 * MARGIN;
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('VidToTab');
  doc.setProducer('VidToTab');
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = [doc.addPage([PW, PH])];
  let page = pages[0];
  let y = PH - MARGIN;

  // Header: the browser renders it (any script, system fonts) as a PNG; the
  // Standard-14 text header is only a fallback for API callers.
  let headerDone = false;
  if (header) {
    try {
      const img = await doc.embedPng(new Uint8Array(header));
      const h = img.height * (CW / img.width);
      page.drawImage(img, { x: MARGIN, y: y - h, width: CW, height: h });
      if (srcUrl) addLink(doc, page, srcUrl, [MARGIN, y - h, MARGIN + CW, y]);
      y -= h + 16;
      headerDone = true;
    } catch { /* malformed PNG — fall back to text */ }
  }
  if (!headerDone) {
    let textX = MARGIN;
    let thumbBottom = y;
    if (fs.existsSync(THUMB)) {
      try {
        // new Uint8Array copy: pdf-lib reads data.buffer directly, and a Node
        // Buffer is an offset view into a shared pool — passing it raw corrupts
        const img = await doc.embedJpg(new Uint8Array(fs.readFileSync(THUMB)));
        const th = 72, tw = img.width * (th / img.height);
        page.drawImage(img, { x: MARGIN, y: y - th, width: tw, height: th });
        textX = MARGIN + tw + 14;
        thumbBottom = y - th;
      } catch { /* not a jpeg — skip */ }
    }
    let ty = y;
    for (const line of wrapText(winAnsi(title), bold, 16, PW - MARGIN - textX)) {
      ty -= 20;
      page.drawText(line, { x: textX, y: ty, size: 16, font: bold, color: rgb(0.1, 0.1, 0.12) });
    }
    if (srcUrl) {
      ty -= 14;
      const shown = winAnsi(srcUrl).slice(0, 100);
      page.drawText(shown, { x: textX, y: ty, size: 9, font: helv, color: rgb(0.3, 0.35, 0.8) });
      addLink(doc, page, srcUrl, [textX, ty - 2, textX + helv.widthOfTextAtSize(shown, 9), ty + 9]);
    }
    y = Math.min(thumbBottom, ty) - 18;
  }

  for (const f of files) {
    const img = await doc.embedPng(new Uint8Array(fs.readFileSync(f)));
    let w = CW;
    let h = img.height * (CW / img.width);
    const maxH = PH - 2 * MARGIN - 18;
    if (h > maxH) { h = maxH; w = img.width * (h / img.height); } // never split a capture
    if (y - h < MARGIN + 14) {
      page = doc.addPage([PW, PH]);
      pages.push(page);
      y = PH - MARGIN;
    }
    page.drawImage(img, { x: MARGIN + (CW - w) / 2, y: y - h, width: w, height: h });
    y -= h + 10;
  }

  const footerTitle = winAnsi(title).slice(0, 90);
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const grey = rgb(0.55, 0.55, 0.58);
    p.drawText(label, { x: PW - MARGIN - helv.widthOfTextAtSize(label, 8), y: MARGIN / 2, size: 8, font: helv, color: grey });
    if (i > 0 && footerTitle) p.drawText(footerTitle, { x: MARGIN, y: MARGIN / 2, size: 8, font: helv, color: grey });
  });
  return doc.save();
}

function addLink(doc, page, url, [x0, y0, x1, y1]) {
  const annot = doc.context.register(doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x0, y0, x1, y1],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
  }));
  page.node.addAnnot(annot);
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

// Standard 14 fonts only encode WinAnsi; map what we can, strip the rest.
function winAnsi(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”「」『』]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[【［]/g, '[')
    .replace(/[】］]/g, ']')
    .replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '')
    .replace(/\s+/g, ' ')
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

function serveFile(res, file, mime, cache = 'no-cache') {
  let st;
  try { st = fs.statSync(file); } catch { return sendJson(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': cache });
  sendStream(res, fs.createReadStream(file));
}

const CAPTURE_EXT = new Set(['.png']);

function serveCapture(res, pathname) {
  let name;
  try { name = path.basename(decodeURIComponent(pathname.slice('/captures/'.length))); }
  catch { return sendJson(res, 400, { error: 'bad path' }); }
  // basename() already stops traversal, but without an extension check this
  // route still hands out everything else in the work folder — frames.ink,
  // video.mp4, the manifest. Captures are PNGs; nothing else is public.
  if (!CAPTURE_EXT.has(path.extname(name).toLowerCase())) return sendJson(res, 404, { error: 'not found' });
  // run-unique filenames never change content: cache hard
  serveFile(res, path.join(WORK, name), MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'max-age=31536000, immutable');
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

// Any page open in the browser can POST to a localhost server, and a
// DNS-rebinding page can read from one. Nothing here is authenticated, so lean
// on what the browser must tell us: the Host has to be our own loopback
// address, cross-site requests are refused, and a POST has to be real JSON —
// text/plain is the one body type that needs no CORS preflight.
// When HOST is deliberately set to a non-loopback address (the hosted build),
// the operator has opted in, so the Host and Origin checks step aside.
const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

function crossSiteReject(req) {
  if (LOOPBACK && !ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    return { code: 403, error: 'Unrecognised Host header.' };
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return { code: 403, error: 'Cross-site requests are not allowed.' };
  }
  const origin = req.headers.origin;
  if (origin) {
    let oh;
    try { oh = new URL(origin).host.toLowerCase(); }
    catch { return { code: 403, error: 'Bad Origin header.' }; }
    if (LOOPBACK && !ALLOWED_HOSTS.has(oh)) return { code: 403, error: 'Cross-origin requests are not allowed.' };
  }
  if (req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return { code: 415, error: 'Expected application/json.' };
  }
  return null;
}

async function route(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${u.pathname}`;
  const bad = crossSiteReject(req);
  if (bad) return sendJson(res, bad.code, { error: bad.error });
  if (key === 'GET /api/events') return sse(req, res);
  if (key === 'GET /api/preflight') {
    await checkTools(); // recompute: user may have just installed
    return sendJson(res, 200, { ok: preflight.ytdlp && preflight.ffmpeg, ...preflight });
  }
  if (key === 'GET /api/meta') return job.meta ? sendJson(res, 200, job.meta) : sendJson(res, 404, { error: 'no video' });
  if (key === 'GET /api/video') return serveVideo(req, res);
  if (key === 'GET /thumb.jpg') return serveFile(res, THUMB, 'image/jpeg');
  if (req.method === 'GET' && u.pathname.startsWith('/captures/')) return serveCapture(res, u.pathname);
  if (key === 'POST /api/video/url') return postUrl(req, res);
  if (key === 'PUT /api/video/file') return putFile(req, res, u);
  if (key === 'POST /api/detect') return postDetect(req, res);
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
// SIGHUP matters too: closing the terminal otherwise strands a running yt-dlp.
function shutdown() {
  if (job.proc) killProc(job.proc);
  try { cancelPipeline(); } catch { /* nothing running */ }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { shutdown(); process.exit(0); });
}

// Node exits on an unhandled rejection, which used to take down the whole
// server (losing the job and stranding a detached yt-dlp) over one failed
// fs call inside a flow. Report it to the UI and keep serving instead.
process.on('unhandledRejection', (e) => {
  console.error('unhandled rejection:', e?.stack || e);
  flowError(job, 'Something went wrong.', e?.stack || String(e));
});
process.on('uncaughtException', (e) => {
  console.error('uncaught exception:', e?.stack || e);
  shutdown();
  flowError(job, 'Something went wrong.', e?.stack || String(e));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — VidToTab may already be running. Set PORT to pick another.`);
    process.exit(1);
  }
  throw e;
});

// Loopback only: binding every interface put the API, the video and the work
// folder on whatever network this machine joins. LAN sharing is a separate,
// explicit listener (see the phone-viewing feature), never the default.
server.listen(PORT, HOST, () => {
  console.log(`VidToTab running at http://${HOST}:${PORT}`);
  console.log(`VIDTOTAB_LISTENING ${PORT}`); // the desktop shell parses this
  if (!preflight.ytdlp || !preflight.ffmpeg) {
    const missing = [!preflight.ytdlp && 'yt-dlp', !preflight.ffmpeg && 'ffmpeg'].filter(Boolean).join(' ');
    console.error(`missing tools: ${missing} — brew install ${missing}`);
  }
});
