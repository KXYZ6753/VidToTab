// VidToTab server — local single-user app. node:http, no framework.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PDFDocument, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { runPipeline, cancelPipeline } from './pipeline/index.js';
import { detectRegion } from './pipeline/detect.js';
import { YT_BASE_ARGS, YT_DOWNLOAD_ARGS, noteClientSuccess, orderedClients } from './pipeline/config.js';
import { clearToolCache, toolPath } from './pipeline/tools.js';
import { ensureYtDlp } from './pipeline/ytdlp.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
// A packaged app runs from a read-only bundle and a container wants its state
// on a mounted volume, so the working folder is configurable. The default keeps
// a plain checkout self-contained, exactly as before.
const WORK = process.env.VIDTOTAB_WORK_DIR
  || (process.env.VIDTOTAB_DATA_DIR ? path.join(process.env.VIDTOTAB_DATA_DIR, 'work') : path.join(ROOT, 'work'));
const VIDEO = path.join(WORK, 'video.mp4');
const THUMB = path.join(WORK, 'thumb.jpg');
// An explicit PORT=0 asks the OS for any free port, which is how the desktop
// shell keeps two launches from fighting over a fixed one. `|| 3000` threw that
// away silently, because 0 is falsy.
const envPort = process.env.PORT?.trim();
const parsedPort = envPort ? Number(envPort) : NaN;
const PORT = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 3000;
const HOST = process.env.HOST || '127.0.0.1'; // loopback unless deliberately opened up
const UPLOAD_CAP = 4 * 2 ** 30; // 4 GB
const UPLOAD_STALL_MS = (Number(process.env.VIDTOTAB_UPLOAD_STALL_SEC) > 0
  ? Number(process.env.VIDTOTAB_UPLOAD_STALL_SEC) : 120) * 1000; // no bytes for this long and the upload is abandoned

// VIDTOTAB_MODE is a label and nothing more. What the server binds to is HOST,
// and what it enforces is VIDTOTAB_PUBLIC; keeping the three apart means a
// hosted deployment cannot lose its limits by mislabelling itself, and a local
// one cannot acquire limits behind the user's back.
const MODE = process.env.VIDTOTAB_MODE === 'web' ? 'web' : 'local';

const VERSION = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'); }
  catch { return '0.0.0'; }
})();

// A local instance is unlimited: it is the user's own machine, their own CPU
// and their own three-hour video, and none of that is the app's business. A
// public one is shared with strangers, so it gets caps — opt in with
// VIDTOTAB_PUBLIC=1. Every number is overridable; the defaults are what a small
// hosted instance can serve without falling over.
const LIMITS = (() => {
  const num = (name, fallback) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const maxMinutes = num('VIDTOTAB_MAX_MINUTES', 20);
  return {
    on: process.env.VIDTOTAB_PUBLIC === '1',
    uploadBytes: Math.min(UPLOAD_CAP, Math.round(num('VIDTOTAB_MAX_UPLOAD_MB', 512) * 2 ** 20)),
    maxMinutes,
    maxSeconds: maxMinutes * 60,
    rateMax: num('VIDTOTAB_RATE_LIMIT', 20),
    rateWindowMs: num('VIDTOTAB_RATE_WINDOW_SEC', 60) * 1000,
    // One at a time, and that is architecture rather than caution: this server
    // holds a single global job, and starting a second video calls
    // stopCurrent(). Allowing two does not buy concurrency — it lets the second
    // visitor destroy the first visitor's scan mid-analysis. It stays an env
    // knob because the tests set it, and because it becomes a real one the day
    // jobs are per-session.
    maxJobs: num('VIDTOTAB_MAX_JOBS', 1),
    // How long an instance stays claimed after its owner stops touching it.
    sessionIdleMs: num('VIDTOTAB_SESSION_IDLE_MIN', 15) * 60000,
    // X-Forwarded-For is whatever the client typed unless something in front
    // rewrites it, so it is read only when the operator says there is one.
    trustProxy: process.env.VIDTOTAB_TRUST_PROXY === '1',
  };
})();

const sizeLabel = (bytes) => (bytes >= 2 ** 30 ? `${+(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lengthLabel = (sec) => (sec >= 90 ? plural(Math.round(sec / 60), 'minute') : plural(Math.max(1, Math.round(sec)), 'second'));

// A public instance is not a free transcoding farm: every extra minute of video
// is real CPU, in the download, the conversion and then each analysis pass.
// Returns the message to show, or null when the video is fine (or the instance
// is local, where there is no limit at all).
function tooLongMsg(seconds) {
  if (!LIMITS.on || !(Number(seconds) > LIMITS.maxSeconds)) return null;
  return `That video is ${lengthLabel(Number(seconds))} long. This instance accepts videos up to `
    + `${lengthLabel(LIMITS.maxSeconds)} — trim it first, or run VidToTab on your own machine, where nothing is capped.`;
}

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
  const p = spawn(toolPath(cmd), [arg], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', () => resolve({ ok: false, out: '' }));
  p.on('close', code => resolve({ ok: code === 0, out: out.trim() }));
});

// yt-dlp goes stale quickly: YouTube changes something every few weeks and an
// old build starts failing in ways that look like broken links to the user.
// Its version is a date (2026.07.04), so age is readable straight off it.
function ytdlpAgeDays(version) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version || '');
  if (!m) return null;
  const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.max(0, Math.round((Date.now() - released) / 86400000));
}

const preflight = { ytdlp: false, ffmpeg: false, ytdlpVersion: '', ytdlpAgeDays: null, ytdlpStale: false };
async function checkTools() {
  const [yt, ff] = await Promise.all([have('yt-dlp', '--version'), have('ffmpeg', '-version')]);
  preflight.ytdlp = yt.ok;
  preflight.ffmpeg = ff.ok;
  preflight.ytdlpVersion = yt.ok ? yt.out.split('\n')[0] : '';
  preflight.ytdlpAgeDays = ytdlpAgeDays(preflight.ytdlpVersion);
  preflight.ytdlpStale = preflight.ytdlpAgeDays != null && preflight.ytdlpAgeDays > 60;
  return preflight;
}
await checkTools();

// A downloaded app has no Homebrew to fall back on, so it fetches yt-dlp into
// its own data folder. The resolver prefers that copy over anything on the
// system, so this also quietly replaces a stale one — which matters, because a
// yt-dlp a couple of months old fails in ways that read as broken links rather
// than as an out-of-date tool.
//
// Only when a data folder is configured: a plain checkout keeps using whatever
// the developer installed, and never downloads 37 MB behind their back.
if (process.env.VIDTOTAB_DATA_DIR && (!preflight.ytdlp || preflight.ytdlpStale)) {
  const why = preflight.ytdlp
    ? `yt-dlp ${preflight.ytdlpVersion} is ${preflight.ytdlpAgeDays} days old`
    : 'yt-dlp is not installed';
  console.log(`${why} — fetching a current one into the app's data folder`);
  ensureYtDlp({
    binDir: path.join(process.env.VIDTOTAB_DATA_DIR, 'bin'),
    force: preflight.ytdlpStale,
    onLog: (l) => console.log(l),
  })
    .then(async () => {
      clearToolCache(); // the old path is memoised; drop it or the new copy is ignored
      await checkTools();
    })
    .catch((e) => console.error(`could not install yt-dlp: ${e.message} — YouTube links will not work`));
}

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
    owner: null, // public instances only; see attachOwner
    touched: Date.now(), // last time the owner did anything; see takeoverRefused
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

// A job that failed without producing anything has no claim on the instance.
// Ownership outliving the request that created it is what let a stalled upload
// reserve a public instance for the whole idle window: putFile records the owner
// before it reads the body, so an upload that died — or was abandoned on
// purpose, cheaply, again and again — kept everyone else out for fifteen minutes
// having produced nothing. A job with pages in it is a different matter: that is
// someone's songsheet and it stays theirs.
function releaseIfEmpty(my) {
  if (my !== job || !job.owner || job.captures.length) return;
  job.owner = null;
  claim = { owner: null, at: 0 };
}

function flowError(my, msg, detail) {
  if (my !== job) return;
  my.phase = 'idle';
  releaseIfEmpty(my);
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
  // Someone else's job is not theirs to watch: a stranger gets an idle snapshot
  // rather than the title, warnings and page thumbnails of another visitor's video.
  const mine = ownsJob(req);
  const snap = { phase: 'state', jobId: job.id, job: mine ? job.phase : 'idle', runId: job.runId };
  if (mine) {
    if (job.meta) snap.meta = job.meta;
    if (job.captures.length) snap.captures = job.captures;
    if (job.lastAnalyze) snap.lastAnalyze = job.lastAnalyze;
    if (job.warnings.length) snap.warnings = job.warnings; // survive a reload
  }
  res.write(`data: ${JSON.stringify(snap)}\n\n`);
  res.vttOwner = req.vttOwner; // broadcast() filters on this
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

function broadcast(ev) {
  // Every event carries the job it belongs to, so a client that reconnects mid
  // switch can tell a late event about the old video from a current one.
  const line = `data: ${JSON.stringify({ jobId: job.id, ...ev })}\n\n`;
  for (const c of sseClients) {
    // Public: progress belongs to whoever started the job.
    if (LIMITS.on && job.owner && c.vttOwner !== job.owner) continue;
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
      p = spawn(toolPath(cmd), args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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

// yt-dlp merges video and audio with ffmpeg, which it goes looking for on PATH.
// A packaged app has no Homebrew on its PATH, so it would find nothing and fail
// at the merge — with the bundled ffmpeg sitting right there unused. Point it at
// ours whenever we know where ours is.
function ytFfmpegArgs() {
  const p = toolPath('ffmpeg');
  return path.isAbsolute(p) ? ['--ffmpeg-location', path.dirname(p)] : [];
}

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
  // Checked off yt-dlp's metadata, before a byte of it is downloaded.
  const tooLong = tooLongMsg(j.duration);
  if (tooLong) return flowError(my, tooLong);
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
  // Last client that actually worked goes first: the default client 403'd on 12
  // of 13 videos in one sitting, and each doomed first attempt costs seconds and
  // one more refused request against a service that is already rate-limiting.
  for (const [i, client] of orderedClients().entries()) {
    clearDownloads();
    if (i > 0) broadcast({ phase: 'download', pct: 0, msg: `YouTube refused the stream — retrying via the ${client.label}` });
    dl = await download(my, url, client.args);
    if (bail(my)) return;
    if (dl.code === 0 && findDownloaded()) { noteClientSuccess(client.label); break; }
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
    ['--newline', ...ytFfmpegArgs(), ...YT_DOWNLOAD_ARGS, ...extraArgs, '-o', path.join(WORK, 'video.%(ext)s'), '--', url],
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
  // "Sign in to confirm you're not a bot" is a temporary rate limit, not a
  // sign-in requirement. Calling it the latter told people to give up on a
  // video that usually works again within minutes.
  if (/confirm you'?re not a bot|not a bot/i.test(e)) {
    return 'YouTube is rate-limiting downloads from this computer right now. Wait a few minutes and try again, or download the video yourself and drop the file in.';
  }
  if (/confirm your age|age-restricted/i.test(e)) return 'That video is age-restricted, so it can’t be downloaded without signing in.';
  if (/members-only|join this channel/i.test(e)) return 'That video is for channel members only.';
  if (/Sign in/i.test(e)) return 'YouTube is asking this download to sign in. Try again in a few minutes, or drop the video file in instead.';
  // Every player client is tried before this surfaces, so a 403 here means they
  // all failed — "try again in a minute" was misleading on its own.
  if (/403|Forbidden/i.test(e)) {
    return 'YouTube refused the download on every route we try. Wait a few minutes, update yt-dlp, or download the video yourself and drop the file in.';
  }
  if (/resolve|getaddrinfo|Network is unreachable|timed out|Connection reset/i.test(e)) return 'Couldn’t reach YouTube — check your internet connection.';
  if (/No space left|ENOSPC/i.test(e)) return 'The disk is full — free up some space and try again.';
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
  const src = my.uploadPath || path.join(WORK, 'upload.bin');
  // An uploaded file only admits its length once it is here, so this is the
  // earliest the cap can be applied — but still before the expensive part.
  if (LIMITS.on) {
    const probed = await probe(src);
    if (bail(my)) return;
    const tooLong = tooLongMsg(probed?.duration || 0);
    if (tooLong) {
      fs.rmSync(src, { force: true }); // no reason to keep a file we refused
      return flowError(my, tooLong);
    }
  }
  const r = await toPlayableMp4(my, src);
  if (bail(my)) return;
  if (r) return flowError(my, r.msg, r.detail);
  await finishVideo(my);
}

const PLAY_V = new Set(['h264', 'hevc', 'av1', 'vp9']);
const PLAY_A = new Set(['', 'aac', 'mp3', 'opus']);

// Which encoder this particular ffmpeg can actually use.
//
// Asking for libx264 unconditionally was fine against a Homebrew build and
// broken in the packaged app: the builds shipped with it are LGPL and have no
// libx264 at all, so converting anything a browser would not already play
// failed with "Unknown encoder" and the video simply never became ready.
//
// h264 is preferred wherever it exists because everything plays it; vp9 is the
// fallback and is already in PLAY_V, so its output needs no second conversion.
const ENCODERS = [
  ['libx264', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']],
  ['h264_videotoolbox', ['-c:v', 'h264_videotoolbox', '-b:v', '5M', '-pix_fmt', 'yuv420p']],
  ['h264_nvenc', ['-c:v', 'h264_nvenc', '-b:v', '5M', '-pix_fmt', 'yuv420p']],
  ['h264_qsv', ['-c:v', 'h264_qsv', '-b:v', '5M', '-pix_fmt', 'yuv420p']],
  ['h264_amf', ['-c:v', 'h264_amf', '-b:v', '5M', '-pix_fmt', 'yuv420p']],
  ['libvpx-vp9', ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-pix_fmt', 'yuv420p']],
];
// Listing an encoder only proves it was compiled in — not that the hardware and
// driver behind it exist on this machine. The Windows and Linux builds ship
// h264_nvenc, h264_qsv and h264_amf compiled in regardless, so choosing from the
// list alone would pick nvenc on a machine with no NVIDIA card and fail at the
// moment someone tried to convert a video. Each candidate is made to encode two
// frames before it is trusted.
async function encoderWorks(args) {
  const raw = path.join(os.tmpdir(), 'vidtotab-encoder-probe.raw');
  try {
    if (!fs.existsSync(raw)) fs.writeFileSync(raw, Buffer.alloc(64 * 64 * 3, 16)); // 2 frames, yuv420p-sized below
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '10', '-i', raw,
      ...args, '-frames:v', '2', '-f', 'null', '-']);
    return r.code === 0;
  } catch {
    return false;
  }
}

let encoderArgs = null;
async function videoEncoderArgs() {
  if (encoderArgs) return encoderArgs;
  const listed = await run('ffmpeg', ['-hide_banner', '-encoders']);
  for (const [name, args] of ENCODERS) {
    if (!new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(listed.out)) continue;
    if (!(await encoderWorks(args))) {
      console.log(`${name} is compiled into this ffmpeg but not usable here — trying the next one`);
      continue;
    }
    console.log(`transcoding with ${name}`);
    encoderArgs = args;
    return encoderArgs;
  }
  console.error('no usable video encoder on this machine — converting an unplayable video will fail');
  encoderArgs = ENCODERS.at(-1)[1]; // vp9: software, no hardware to be missing
  return encoderArgs;
}

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
  let stale = false;
  if (PLAY_V.has(p.vcodec)) {
    r = await convert(my, tmp, ['-c:v', 'copy', ...(PLAY_A.has(p.acodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac'])], p.duration, 'Converting to mp4');
  }
  if (r.code !== 0 && !my.cancelled && my === job) {
    // Choosing an encoder runs real trial encodes, so it is slow in exactly the
    // way probe() above is, and the job can change while it happens. Without
    // re-checking, a cancelled video still starts a full transcode and a
    // superseded one writes VIDEO over whatever the new job just put there —
    // the very thing the comment at the top of this function is about.
    const enc = await videoEncoderArgs();
    if (my !== job || my.cancelled) stale = true;
    else r = await convert(my, tmp, [...enc, '-c:a', 'aac'], p.duration, 'Transcoding');
  }
  fs.rmSync(tmp, { force: true });
  if (stale) return { superseded: true, msg: 'The video changed.' };
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
  // YouTube sometimes 403s every stream for the default player client, and the
  // fallback client can be left offering nothing but a 360p progressive
  // rendition. Nothing rejects it — it satisfies height<=1080 — so a tab that
  // ends up a few dozen pixels tall silently becomes "this video only had two
  // pages". Record it on the source so it survives into every snapshot.
  const advertised = Number(my.meta.height) || 0;
  const lowRes = p.height > 0 && (p.height < 540 || (advertised >= 720 && p.height < advertised * 0.6))
    ? { height: p.height, advertised: advertised > p.height ? advertised : 0 }
    : null;
  Object.assign(my.meta, {
    duration: p.duration || my.meta.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    thumb: fs.existsSync(THUMB),
    ready: true,
    suggestion: null,
    lowRes,
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
  if (!takeClaim(req, res)) return;
  await stopCurrent();
  resetWork();
  job = freshJob('downloading', null);
  job.owner = req.vttOwner;
  claim = { owner: null, at: 0 }; // the job itself carries ownership now
  sendJson(res, 202, { ok: true });
  const my = job;
  // A synchronous fs throw inside the flow used to surface as an unhandled
  // rejection, which ends the process on Node 26.
  my.flow = urlFlow(my, url.href).catch((e) => flowError(my, 'Something went wrong.', e?.stack || String(e)));
}

async function putFile(req, res, u) {
  if (!preflight.ffmpeg) return sendJson(res, 500, { error: 'ffmpeg is not installed (brew install ffmpeg)' });
  // 4 GB locally; a public instance lowers it with VIDTOTAB_MAX_UPLOAD_MB.
  const cap = LIMITS.on ? LIMITS.uploadBytes : UPLOAD_CAP;
  const capMsg = `File too large (${sizeLabel(cap)} max).`;
  if (Number(req.headers['content-length']) > cap) {
    return sendJson(res, 413, { error: capMsg });
  }
  const name = path.basename(u.searchParams.get('name') || 'video');
  if (!takeClaim(req, res)) return;
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
  job.owner = req.vttOwner;
  claim = { owner: null, at: 0 }; // the job itself carries ownership now
  const my = job;
  broadcast({ phase: 'meta', meta: my.meta });
  // Per-job filename: with a shared upload.bin, dropping a second file made the
  // first upload's flow probe and rename the second one's partial file.
  const src = path.join(WORK, `upload-${my.id}.bin`);
  my.uploadPath = src;
  my.upload = req; // so stopCurrent can cut a superseded upload off
  // The same hold, by the other route: an upload that simply stops sending
  // would keep its heavy slot for as long as the socket stayed open. Inactivity
  // rather than total time, so a slow but progressing upload is left alone.
  req.setTimeout(UPLOAD_STALL_MS, () => req.destroy(new Error('upload stalled')));
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(src);
      // pipe() doesn't destroy ws when the source errors — an aborted upload
      // would leak the fd (and pin the partial file's disk after resetWork)
      const fail = e => { ws.destroy(); reject(e); };
      let n = 0;
      req.on('data', d => {
        n += d.length;
        // Pause rather than destroy. Destroying the request tears down the
        // socket, so the 413 below never arrives and the browser reports a
        // network error instead of saying the file is too big; pausing stops
        // us reading any more of it, and the response ends the connection.
        if (n > cap) { req.pause(); fail(new Error('too large')); }
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
    releaseIfEmpty(my); // a dead upload does not reserve the instance
    if (!res.headersSent) {
      // A chunked upload declares no length, so the cap is only reached part
      // way through — say the same useful thing the header check says, then
      // hang up so the rest of the file is never sent.
      if (e.message === 'too large') {
        res.setHeader('Connection', 'close');
        sendJson(res, 413, { error: capMsg });
        res.on('finish', () => req.destroy());
      } else sendJson(res, 500, { error: 'Upload failed: ' + e.message });
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
  let body = null;
  let tooLarge = false;
  try { body = await readJson(req, 64e6); }
  catch (e) { tooLarge = /too large/i.test(e?.message || ''); }
  if (tooLarge) {
    return sendJson(res, 413, { error: 'That export is too big to send. Remove some pages, or use the Print look, which needs no upload.' });
  }
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return sendJson(res, 400, { error: 'Nothing to export.' });
  const files = [];
  for (const it of items) {
    // A recoloured page (Dark, Sepia, a custom look) arrives as bytes, because
    // the browser already had to recolour it for the preview and sending those
    // exact pixels is what keeps the PDF identical to what was on screen.
    // Print and Original need no upload: the file on disk is already right.
    if (typeof it?.pngData === 'string' && it.pngData.startsWith('data:image/png;base64,')) {
      files.push(Buffer.from(it.pngData.slice('data:image/png;base64,'.length), 'base64'));
      continue;
    }
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
  // The look's paper colour, clamped: a dark songsheet should be dark to the
  // edge of the sheet rather than dark pages sitting on white.
  const tint = Array.isArray(body.paperRgb) && body.paperRgb.length === 3
    ? body.paperRgb.map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))))
    : null;
  const bytes = await buildPdf({ title, srcUrl, files, paper, header, paperRgb: tint });
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

async function buildPdf({ title, srcUrl, files, paper, header, paperRgb = null }) {
  const [PW, PH] = PAPER[paper];
  const CW = PW - 2 * MARGIN;
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('VidToTab');
  doc.setProducer('VidToTab');
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // Every sheet is painted before anything is drawn on it, so the look reaches
  // the margins as well as the pages.
  const sheet = paperRgb ? rgb(paperRgb[0] / 255, paperRgb[1] / 255, paperRgb[2] / 255) : null;
  const newPage = () => {
    const p = doc.addPage([PW, PH]);
    if (sheet) p.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: sheet });
    return p;
  };
  const pages = [newPage()];
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
    // Each entry is either a path on disk (Print and Original use the stored
    // capture untouched) or the recoloured bytes the browser already rendered
    // for the preview, so the PDF shows exactly what was on screen.
    const img = await doc.embedPng(new Uint8Array(Buffer.isBuffer(f) ? f : fs.readFileSync(f)));
    let w = CW;
    let h = img.height * (CW / img.width);
    const maxH = PH - 2 * MARGIN - 18;
    if (h > maxH) { h = maxH; w = img.width * (h / img.height); } // never split a capture
    if (y - h < MARGIN + 14) {
      page = newPage();
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

// A JSON body is tiny and should arrive at once. Waiting forever for one is not
// patience, it is a hole: heavy() takes its slot when the request is admitted
// and releases it only when the handler settles, so a connection that sent
// headers and never sent a body parked postUrl inside this function and held
// the slot. With one job at a time — the default — that single connection
// denied a public instance to everyone, needing no valid link and no repetition.
// requestTimeout is 0 so multi-GB uploads survive, which is exactly why nothing
// else reclaimed it.
const BODY_TIMEOUT_MS = (Number(process.env.VIDTOTAB_BODY_TIMEOUT_SEC) > 0
  ? Number(process.env.VIDTOTAB_BODY_TIMEOUT_SEC) : 20) * 1000;

function readJson(req, limit = 1e6, timeoutMs = BODY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('timed out waiting for the request body'));
    }, timeoutMs);
    const ok = (v) => { clearTimeout(timer); resolve(v); };
    const no = (e) => { clearTimeout(timer); reject(e); };
    req.on('data', d => {
      n += d.length;
      if (n > limit) { no(new Error('body too large')); req.destroy(); }
      else chunks.push(d);
    });
    req.on('end', () => {
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { no(new Error('invalid JSON')); }
    });
    req.on('error', no);
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
const hostsFor = (p) => new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
// Rebuilt once the OS assigns a port. PORT=0 asks for any free port — which is
// how the desktop shell avoids two launches fighting over a fixed one — and
// without rebuilding this, every request would arrive with the real port in its
// Host header, not match "…:0", and be refused.
let ALLOWED_HOSTS = hostsFor(PORT);

// A public instance serves strangers, and this server has exactly one job.
// With no notion of an owner, any visitor could act on the job another visitor
// started: /api/meta names their video, /thumb.jpg and /captures/ show it,
// /api/video streams the file they uploaded, and /api/cancel destroys their
// scan outright. The cross-site guard never helped here — it checks origins,
// not people, and two strangers on a public instance are both legitimate
// same-origin callers. A cookie minted on first contact ties a job to whoever
// started it. Local instances are untouched: LIMITS.on is off, and loopback
// already means one person.
const OWNER_COOKIE = 'vtt_owner';
const JOB_SCOPED = new Set([
  'GET /api/meta', 'GET /api/video', 'GET /thumb.jpg',
  'POST /api/cancel', 'POST /api/export', 'POST /api/detect', 'POST /api/analyze',
]);
const ownerCookie = (req) => (/(?:^|;\s*)vtt_owner=([a-f0-9]{32})/.exec(req.headers.cookie || '') || [])[1] || null;

function attachOwner(req, res) {
  if (!LIMITS.on) { req.vttOwner = null; return; }
  const existing = ownerCookie(req);
  if (existing) { req.vttOwner = existing; return; }
  req.vttOwner = crypto.randomBytes(16).toString('hex');
  // Lax, not Strict: arriving from a shared link is a top-level navigation, and
  // Strict would drop the cookie on exactly that first visit.
  res.setHeader('Set-Cookie', `${OWNER_COOKIE}=${req.vttOwner}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
}

// Check and claim in one synchronous step, immediately before the destructive
// part, and answer 503 if the instance is not available. Claiming at admission
// instead put the claim on the wrong side of the request body: the body is the
// client's to deliver, so a slow one held the instance against everyone else, a
// start that failed validation left a claim behind to expire on its own, and a
// client slower than the expiry reopened the very race the claim closed. Here
// it spans stopCurrent() alone, which is our own code.
function takeClaim(req, res) {
  const wait = takeoverRefused(req);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    sendJson(res, 503, {
      error: 'Someone else is using this instance right now. Their scan would be erased by starting another video — try again in a few minutes.',
    });
    return false;
  }
  if (LIMITS.on) claim = { owner: req.vttOwner, at: Date.now() };
  return true;
}

// True when there is nothing to protect — local, or no job started yet — or the
// caller is the one who started it.
function ownsJob(req) {
  if (!LIMITS.on || !job.owner) return true;
  return req.vttOwner === job.owner;
}

// Starting a video does not sit alongside the current one, it replaces it:
// stopCurrent() and resetWork() between them end the running job and delete
// every page it produced. Refusing strangers the job-scoped routes did nothing
// about that — the concurrency limit only covers work still in flight, so the
// moment the owner's scan finished, the next visitor's upload quietly erased
// the songsheet they were still reading. An instance stays theirs until they
// have actually been away. Returns the seconds to wait, or null if the caller
// may go ahead.
// A reservation taken the instant a start request is admitted. The check below
// reads job.owner, but postUrl and putFile then await — the request body, then
// stopCurrent() — before anything is deleted. Two start requests could both
// pass the check in that window, and the second would erase a job that had
// appeared in between, including one belonging to whoever won the first race.
// The claim is taken synchronously, so no second request can pass while one is
// mid-flight. It is dropped the moment the new job records its owner, and
// expires on its own if a start request dies before getting that far.
let claim = { owner: null, at: 0 };
// Only ever held across stopCurrent(), so this is a backstop for a start that
// throws in between, not a working timeout.
const CLAIM_MS = 10000;

function takeoverRefused(req) {
  if (!LIMITS.on) return null;
  const claimAge = Date.now() - claim.at;
  if (claim.owner && claim.owner !== req.vttOwner && claimAge < CLAIM_MS) {
    return Math.max(5, Math.ceil((CLAIM_MS - claimAge) / 1000));
  }
  if (!job.owner || job.owner === req.vttOwner) return null;
  const idleFor = Date.now() - (job.touched || 0);
  if (idleFor >= LIMITS.sessionIdleMs) return null; // abandoned; anyone may take over
  return Math.max(30, Math.ceil((LIMITS.sessionIdleMs - idleFor) / 1000));
}

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

// ------------------------------------------------- public limits (opt-in)
//
// None of this runs on a local instance. With VIDTOTAB_PUBLIC=1 the expensive
// routes get a per-IP rate limit and a cap on how many videos can be in flight
// at once, so one visitor cannot hold the whole box.

function clientIp(req) {
  if (LIMITS.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Fixed window, in memory: one process per container, so nothing to share and
// no dependency to add. Returns 0 when allowed, else seconds until the reset.
const rateHits = new Map();
function rateLimited(req) {
  const now = Date.now();
  // Cheap sweep: without it a busy instance keeps one entry per IP forever.
  if (rateHits.size > 5000) for (const [k, v] of rateHits) if (v.resetAt <= now) rateHits.delete(k);
  const ip = clientIp(req);
  const hit = rateHits.get(ip);
  if (!hit || hit.resetAt <= now) {
    rateHits.set(ip, { n: 1, resetAt: now + LIMITS.rateWindowMs });
    return 0;
  }
  hit.n++;
  return hit.n > LIMITS.rateMax ? Math.max(1, Math.ceil((hit.resetAt - now) / 1000)) : 0;
}

let heavyJobs = 0;

// Wraps the four routes that cost minutes of CPU: loading a video by link or
// by file, detection, and analysis. Everything else here is a file read.
async function heavy(req, res, fn) {
  if (!LIMITS.on) return fn(); // local: not even a counter in the way
  const retry = rateLimited(req);
  if (retry) {
    res.setHeader('Retry-After', String(retry));
    return sendJson(res, 429, { error: `Too many requests — wait ${retry}s and try again.` });
  }
  if (heavyJobs >= LIMITS.maxJobs) {
    res.setHeader('Retry-After', '30');
    return sendJson(res, 503, { error: 'The server is busy with other videos right now. Try again in a minute.' });
  }
  heavyJobs++;
  let released = false;
  const release = () => { if (!released) { released = true; heavyJobs--; } };
  try {
    await fn();
  } finally {
    // These handlers answer 202 and keep working: the download, the conversion
    // and the analysis all outlive the request that started them. Holding the
    // slot only until the response went out would count requests rather than
    // jobs, and let any number of transcodes run at once.
    Promise.allSettled([job.flow, job.analyze, job.detect].filter(Boolean)).then(release, release);
  }
}

// Deliberately dull, and deliberately the one route the cross-site guard does
// not cover (see route()): mode, whether limits are on, the version and how
// long this process has been up. No paths, no tool versions, no job state.
function health(res) {
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    ok: preflight.ffmpeg, // ffmpeg missing means this container cannot do its job
    mode: MODE,
    public: LIMITS.on,
    version: VERSION,
    uptimeSec: Math.round(process.uptime()),
  });
}

async function route(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${u.pathname}`;
  // Health is answered before the guard, on purpose. Load balancers and
  // container runtimes poll it with no Origin and whatever Host they please,
  // which is exactly the shape crossSiteReject refuses — on a local instance an
  // unrecognised Host is a 403, so /api/health would fail for precisely the
  // callers it exists for. Exempting it is safe because it reads nothing,
  // changes nothing, and tells everyone the same five facts; and since no CORS
  // header goes out with it, a page on another origin can send the request but
  // cannot read the reply.
  if (u.pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) return health(res);
  const bad = crossSiteReject(req);
  if (bad) return sendJson(res, bad.code, { error: bad.error });
  // Minted on first contact, so a visitor already holds one by the time they
  // open the event stream or start anything.
  attachOwner(req, res);
  if (!ownsJob(req) && (JOB_SCOPED.has(key) || u.pathname.startsWith('/captures/'))) {
    return sendJson(res, 403, { error: 'Someone else is using this instance right now.' });
  }
  // Any sign of the owner keeps the instance theirs.
  if (LIMITS.on && job.owner && req.vttOwner === job.owner) job.touched = Date.now();
  if (key === 'POST /api/video/url' || key === 'PUT /api/video/file') {
    const wait = takeoverRefused(req);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      return sendJson(res, 503, {
        error: 'Someone else is using this instance right now. Their scan would be erased by starting another video — try again in a few minutes.',
      });
    }
  }
  if (key === 'GET /api/events') return sse(req, res);
  if (key === 'GET /api/preflight') {
    await checkTools(); // recompute: user may have just installed
    return sendJson(res, 200, { ok: preflight.ytdlp && preflight.ffmpeg, ...preflight });
  }
  if (key === 'GET /api/meta') return job.meta ? sendJson(res, 200, job.meta) : sendJson(res, 404, { error: 'no video' });
  if (key === 'GET /api/video') return serveVideo(req, res);
  if (key === 'GET /thumb.jpg') return serveFile(res, THUMB, 'image/jpeg');
  if (req.method === 'GET' && u.pathname.startsWith('/captures/')) return serveCapture(res, u.pathname);
  if (key === 'POST /api/video/url') return heavy(req, res, () => postUrl(req, res));
  if (key === 'PUT /api/video/file') return heavy(req, res, () => putFile(req, res, u));
  if (key === 'POST /api/detect') return heavy(req, res, () => postDetect(req, res));
  if (key === 'POST /api/analyze') return heavy(req, res, () => postAnalyze(req, res));
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
  // The port actually bound, not the one requested: with PORT=0 the request is
  // 0 and the shell would be told to connect to port 0.
  const bound = server.address()?.port ?? PORT;
  ALLOWED_HOSTS = hostsFor(bound);
  console.log(`VidToTab running at http://${HOST}:${bound}`);
  console.log(`VIDTOTAB_LISTENING ${bound}`); // the desktop shell parses this
  if (LIMITS.on && LIMITS.maxJobs > 1) {
    console.error(`VIDTOTAB_MAX_JOBS=${LIMITS.maxJobs}: this server runs one job at a time, so a second `
      + 'visitor will supersede the first one\'s video mid-scan rather than run alongside it.');
  }
  if (MODE !== 'local' || LIMITS.on) {
    console.log(LIMITS.on
      ? `mode ${MODE}, public limits on: ${sizeLabel(LIMITS.uploadBytes)} upload, ${lengthLabel(LIMITS.maxSeconds)} of video, `
        + `${LIMITS.rateMax} heavy requests per ${Math.round(LIMITS.rateWindowMs / 1000)}s per IP, ${LIMITS.maxJobs} at a time`
      : `mode ${MODE}, public limits off (set VIDTOTAB_PUBLIC=1 to apply them)`);
  }
  if (!preflight.ytdlp || !preflight.ffmpeg) {
    const missing = [!preflight.ytdlp && 'yt-dlp', !preflight.ffmpeg && 'ffmpeg'].filter(Boolean).join(' ');
    console.error(`missing tools: ${missing} — brew install ${missing}`);
  }
});
