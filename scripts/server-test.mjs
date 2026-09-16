// Server-level regression tests (the pipeline's own checks live in test.mjs).
//
//   npm run test:server
//   SERVER=server.old.mjs npm run test:server   # point at another entry to prove a test bites
//
// Note: these drive the real upload flow, so they reset the work/ folder, the
// same way loading any new video does.
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolPath } from '../pipeline/tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'work');
const ENTRY = process.env.SERVER || 'server.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// In the OS temp directory, not the project root: the upload tests reset WORK,
// and a fixture written next to the source tree survives a failed run and shows
// up as an untracked file waiting to be committed by accident.
const SMALL = path.join(os.tmpdir(), 'vidtotab-server-test-small.mp4');
export const CLIP = { w: 320, h: 240, frames: 20, fps: 10 };

// Frames are piped in as rawvideo rather than generated with `-f lavfi`: the
// ffmpeg this app ships is built --disable-avdevice, so lavfi cannot be opened
// there at all, and a fixture that only builds on a developer's Homebrew copy
// tests the wrong ffmpeg.
function makeClip(dest, codecArgs) {
  const { w, h, frames: n, fps } = CLIP;
  const frame = w * h * 3;
  const buf = Buffer.alloc(frame * n);
  for (let i = 0; i < n; i++) buf.fill((20 + i * 10) & 0xff, i * frame, (i + 1) * frame);
  const r = spawnSync(toolPath('ffmpeg'), ['-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0',
    ...codecArgs, dest], { input: buf, stdio: ['pipe', 'ignore', 'pipe'] });
  if (r.status !== 0) throw new Error(`could not build the test clip: ${String(r.stderr).trim().slice(-300)}`);
  return dest;
}

// VP9 because the shipped builds are LGPL and have no libx264 — and because
// vp9 is already in the server's playable set, so this fixture needs no
// conversion and the upload tests measure only what they mean to.
function tinyVideo() {
  return makeClip(SMALL, ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-pix_fmt', 'yuv420p']);
}

async function startServer(port, env = {}) {
  const srv = spawn('node', [ENTRY], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300 && !log.includes('running at') && srv.exitCode === null; i++) await sleep(100);
  if (!log.includes('running at')) {
    srv.kill('SIGKILL');
    throw new Error(`server (${ENTRY}) never listened. exit=${srv.exitCode}\n${log.slice(-1200)}`);
  }
  return { srv, log: () => log };
}

function put(port, name, feed, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'PUT', path: '/api/video/file?name=' + encodeURIComponent(name), headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 120) })); });
    req.on('error', (e) => resolve({ status: 0, body: 'req error: ' + e.code }));
    feed(req);
  });
}

// node:http rather than fetch: fetch quietly drops a Host header set by the
// caller, and the Host header is the whole point of the checks that use this.
function get(port, p, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: b.slice(0, 200),
        setCookie: (res.headers['set-cookie'] || [])[0] || '',
      }));
    });
    req.on('error', (e) => resolve({ status: 0, body: 'req error: ' + e.code }));
    req.end();
  });
}

// The cross-site guard wants real JSON on a POST, so every one of these sends
// it — otherwise everything here would only ever prove the guard works.
async function post(port, p, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
  }).catch(() => null);
  return { status: r?.status ?? 0, retryAfter: r?.headers.get('retry-after') ?? null };
}

// Collects the server's events until it is stopped. Several tests can only see
// what they are testing here: the flows answer 202 and report what happened
// afterwards, over SSE.
function eventStream(port, headers = {}) {
  const seen = [];
  const req = http.request(
    { host: '127.0.0.1', port, path: '/api/events', headers: { accept: 'text/event-stream', ...headers } },
    (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(frame);
          if (m) { try { seen.push(JSON.parse(m[1])); } catch { /* ping */ } }
        }
      });
    });
  req.end();
  return { seen, stop: () => req.destroy() };
}

// A request that is supposed to be refused, with a deadline. The server has no
// request timeout on purpose — multi-GB uploads — so a cap that fails to bite
// leaves the caller waiting for a body that never comes. Without this the suite
// hangs there instead of reporting a failure, which is how it behaved the first
// time the upload cap was deliberately broken to check this test bites.
const refusedWithin = (ms, p) => Promise.race([p, sleep(ms).then(() => ({ status: 0, body: `nothing answered within ${ms}ms` }))]);

// Waits for an event the test cares about, rather than for a fixed time.
async function waitFor(seen, from, match, tries = 150) {
  for (let i = 0; i < tries; i++) {
    const hit = seen.slice(from).find(match);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};

// ---- 1. a second file dropped mid-upload must not corrupt or kill the server
// Regression: the first flow used to probe and rename the *second* upload's
// partial file (shared work/upload.bin), crashing the server with ENOENT.
async function uploadRace() {
  const port = await freePort();
  const { srv, log } = await startServer(port);
  try {
    const small = tinyVideo();
    const chunk = Buffer.alloc(1 << 20, 7);
    let stopA = false;
    const a = put(port, 'big-A.bin', async (req) => {
      for (let i = 0; i < 40 && !stopA; i++) { req.write(chunk); await sleep(60); }
      req.end();
    });
    await sleep(900);
    const b = await put(port, 'small-B.mp4', (req) => fs.createReadStream(small).pipe(req));
    stopA = true;
    await a;

    let meta = null;
    for (let i = 0; i < 150; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/api/meta`).catch(() => null);
      if (r?.ok) { meta = await r.json(); if (meta.ready) break; }
      await sleep(200);
    }
    const leftovers = fs.existsSync(WORK) ? fs.readdirSync(WORK).filter((f) => /^upload/.test(f)) : [];
    check('upload race: server survives', srv.exitCode === null, log().slice(-400));
    check('upload race: second video wins', !!meta?.ready && /small-B/.test(meta.title || ''), JSON.stringify(meta));
    check('upload race: b accepted', b.status === 202, String(b.status));
    check('upload race: no stranded upload files', leftovers.length === 0, leftovers.join(','));
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(SMALL, { force: true });
  }
}

// ---- 2. the local API must not be drivable by another page in the browser
async function crossSiteGuard() {
  const port = await freePort();
  const { srv } = await startServer(port);
  const code = async (p, opts = {}) => (await fetch(`http://127.0.0.1:${port}${p}`, opts).catch(() => ({ status: 0 }))).status;
  try {
    check('guard: same-origin GET allowed', await code('/') === 200);
    check('guard: JSON POST allowed', await code('/api/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) === 200);
    check('guard: POST without JSON content-type refused', await code('/api/cancel', { method: 'POST' }) === 415);
    check('guard: text/plain POST refused (CSRF shape)', await code('/api/video/url', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"url":"http://evil"}' }) === 415);
    check('guard: cross-site fetch refused', await code('/api/meta', { headers: { 'sec-fetch-site': 'cross-site' } }) === 403);
    check('guard: foreign Origin refused', await code('/api/meta', { headers: { origin: 'http://evil.test' } }) === 403);
    check('guard: work files not served', await code('/captures/frames.ink') === 404);
  } finally {
    srv.kill('SIGKILL');
  }
}

// ---- 3. loading a second video must not announce 'cancelled' for the first
// Regression: stopCurrent() set `cancelled` on the job that was still current,
// so the outgoing flow broadcast 'cancelled' and the UI fell back to the start
// screen for several seconds after a second video was loaded.
async function supersedeSilence() {
  const port = await freePort();
  const { srv } = await startServer(port);
  const { seen, stop } = eventStream(port);
  try {
    const small = tinyVideo();
    const chunk = Buffer.alloc(1 << 20, 3);
    let stopA = false;
    const a = put(port, 'first-A.bin', async (req) => {
      for (let i = 0; i < 40 && !stopA; i++) { req.write(chunk); await sleep(60); }
      req.end();
    });
    await sleep(900);
    await put(port, 'second-B.mp4', (req) => fs.createReadStream(small).pipe(req));
    stopA = true;
    await a;
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/api/meta`).catch(() => null);
      if (r?.ok && (await r.json()).ready) break;
      await sleep(200);
    }
    await sleep(300);

    const cancelled = seen.filter((e) => e.phase === 'cancelled');
    const ids = seen.map((e) => e.jobId).filter((n) => typeof n === 'number');
    check('supersede: no bogus cancelled event', cancelled.length === 0, JSON.stringify(cancelled));
    check('supersede: events carry a jobId', ids.length > 0);
    check('supersede: jobId never goes backwards', ids.every((n, i) => i === 0 || n >= ids[i - 1]), ids.join(','));
    check('supersede: second video got a new jobId', new Set(ids).size >= 2, ids.join(','));
  } finally {
    stop();
    srv.kill('SIGKILL');
    fs.rmSync(SMALL, { force: true });
  }
}

// A video the browser will not play has to be converted, not quietly
// abandoned. The transcode target used to be a hardcoded libx264, which is
// absent from the LGPL builds the app ships: conversion failed with "Unknown
// encoder", the video never became ready, and nothing in the interface said
// why. Nothing covered this path until it broke in CI.
async function transcodesUnplayable() {
  const port = await freePort();
  const { srv } = await startServer(port);
  const odd = path.join(os.tmpdir(), 'vidtotab-server-test-mpeg4.mp4');
  try {
    makeClip(odd, ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p']); // mpeg4 is not in PLAY_V
    await put(port, 'odd-codec.mp4', (req) => fs.createReadStream(odd).pipe(req));
    let meta = null;
    for (let i = 0; i < 250; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/api/meta`).catch(() => null);
      if (r?.ok) { meta = await r.json(); if (meta.ready) break; }
      await sleep(200);
    }
    check('transcode: an unplayable codec is converted', !!meta?.ready, JSON.stringify(meta));
    check('transcode: the result keeps its dimensions',
      meta?.width === CLIP.w && meta?.height === CLIP.h, `${meta?.width}x${meta?.height}`);
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(odd, { force: true });
  }
}

// ---- 5. hosted mode: the health endpoint a load balancer or container
// runtime polls. It is the one route answered before the cross-site guard,
// because those callers send no Origin and whatever Host they please — the
// exact shape the guard refuses. So both halves of that are worth pinning: it
// has to answer them, and the guard has to go on refusing them everywhere else.
async function healthEndpoint() {
  const port = await freePort();
  const { srv } = await startServer(port);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    const j = await r.json().catch(() => null);
    check('health: 200 with a JSON body', r.status === 200 && !!j, String(r.status));
    check('health: the five documented fields and nothing else',
      Object.keys(j || {}).sort().join(',') === 'mode,ok,public,uptimeSec,version', JSON.stringify(j));
    check('health: a plain checkout is local, with no limits',
      j?.mode === 'local' && j?.public === false, JSON.stringify(j));
    check('health: carries the version and an uptime',
      j?.ok === true && /^\d+\.\d+\.\d+$/.test(j?.version || '') && Number.isFinite(j?.uptimeSec), JSON.stringify(j));

    const host = { host: 'health-check.internal' };
    const lb = await get(port, '/api/health', host);
    check('health: answers a caller with a foreign Host header', lb.status === 200, `${lb.status} ${lb.body}`);
    const other = await get(port, '/api/meta', host);
    check('health: the guard still refuses that Host everywhere else', other.status === 403, `${other.status} ${other.body}`);
  } finally {
    srv.kill('SIGKILL');
  }
}

// ---- 6. the limits are opt-in. Configured but without VIDTOTAB_PUBLIC=1 they
// must do nothing at all: a local instance is the user's own machine, and their
// own four-hour video is none of the app's business.
async function limitsOffByDefault() {
  const port = await freePort();
  const { srv } = await startServer(port, {
    VIDTOTAB_MAX_UPLOAD_MB: '1', VIDTOTAB_MAX_MINUTES: '0.01', VIDTOTAB_RATE_LIMIT: '1',
  });
  try {
    const big = await put(port, 'two-mb.bin', (req) => req.end(Buffer.alloc(2 << 20, 9)));
    check('limits off: a 2 MB upload passes a configured 1 MB cap', big.status === 202, `${big.status} ${big.body}`);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post(port, '/api/detect')).status);
    check('limits off: the heavy routes are not rationed', !codes.includes(429), codes.join(','));
  } finally {
    srv.kill('SIGKILL');
  }
}

// ---- 7. a public instance caps what it accepts: how big the file may be, and
// how long the video may run. Both refusals have to say what the limit is —
// a bare 413, or a video that simply never becomes ready, tells nobody anything.
async function publicCaps() {
  const port = await freePort();
  const { srv } = await startServer(port, {
    VIDTOTAB_PUBLIC: '1', VIDTOTAB_MAX_UPLOAD_MB: '1', VIDTOTAB_MAX_MINUTES: '0.01',
    VIDTOTAB_RATE_LIMIT: '50', VIDTOTAB_MAX_JOBS: '4',
  });
  // Public mode ties a job to whoever started it, so every request here has to
  // be the same visitor — including the event stream, which now only carries
  // events for the job's owner. A browser gets its cookie by loading the page.
  const cookie = ((await get(port, '/')).setCookie || '').split(';')[0];
  const { seen, stop } = eventStream(port, { cookie });
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    check('public: health reports the limits are on', h.public === true, JSON.stringify(h));

    // Declared up front, so it can be refused before a byte of the body is
    // read: 40 MB declared, 64 bytes sent, and the request left open. A server
    // that reads the header answers at once; one that does not waits forever.
    let held = null;
    const declared = await refusedWithin(8000, put(port, 'huge.mp4',
      (req) => { held = req; req.write(Buffer.alloc(64)); }, { 'content-length': '40000000', cookie }));
    held?.destroy();
    check('public: an oversized upload is refused from its Content-Length', declared.status === 413, `${declared.status} ${declared.body}`);
    check('public: and the refusal names the cap', /1 MB max/.test(declared.body), declared.body);

    // Chunked, so the size is only known as it arrives. The cap has to bite mid
    // stream — and the answer still has to reach the client, which is why the
    // request is paused rather than destroyed.
    const streamed = await refusedWithin(8000, put(port, 'chunked.mp4', async (req) => {
      for (let i = 0; i < 4 && !req.destroyed; i++) { req.write(Buffer.alloc(512 << 10, 9)); await sleep(30); }
      if (!req.destroyed) req.end();
    }, { cookie }));
    check('public: an oversized chunked upload is refused mid stream', streamed.status === 413, `${streamed.status} ${streamed.body}`);
    check('public: and that refusal names the cap too', /1 MB max/.test(streamed.body), streamed.body);

    // Length is only knowable once the file is here, so this one is reported on
    // the event stream rather than in the answer to the upload.
    const from = seen.length;
    const up = await put(port, 'two-seconds.mp4', (req) => fs.createReadStream(tinyVideo()).pipe(req), { cookie });
    check('public: an under-cap file is still accepted for upload', up.status === 202, `${up.status} ${up.body}`);
    const err = await waitFor(seen, from, (e) => e.phase === 'error');
    check('public: an over-long video is rejected', !!err, JSON.stringify(seen.slice(from).map((e) => e.phase)));
    check('public: and the rejection says what the limit is',
      /accepts videos up to/.test(err?.msg || ''), err?.msg || '(no message)');
    check('public: the rejected upload is not left on disk',
      !fs.readdirSync(WORK).some((f) => /^upload-/.test(f)), fs.readdirSync(WORK).join(','));
  } finally {
    stop();
    srv.kill('SIGKILL');
    fs.rmSync(SMALL, { force: true });
  }
}

// ---- 8. a public instance rations the expensive routes per IP, and says when
// to come back. Nothing rations the cheap ones: the page still has to load.
async function publicRateLimit() {
  const port = await freePort();
  const { srv } = await startServer(port, {
    VIDTOTAB_PUBLIC: '1', VIDTOTAB_RATE_LIMIT: '2', VIDTOTAB_RATE_WINDOW_SEC: '60',
  });
  try {
    const codes = [];
    let retryAfter = null;
    for (let i = 0; i < 4; i++) {
      const r = await post(port, '/api/detect');
      codes.push(r.status);
      if (r.status === 429 && !retryAfter) retryAfter = r.retryAfter;
    }
    // 409 is 'no video is ready yet' — the request was served, which is the point.
    check('rate limit: requests inside the window are served', codes.slice(0, 2).every((c) => c === 409), codes.join(','));
    check('rate limit: the ones over it get 429', codes.slice(2).every((c) => c === 429), codes.join(','));
    check('rate limit: the 429 carries Retry-After', Number(retryAfter) > 0, String(retryAfter));
    const cheap = [];
    for (let i = 0; i < 6; i++) cheap.push((await fetch(`http://127.0.0.1:${port}/api/meta`)).status);
    check('rate limit: cheap routes are left alone', !cheap.includes(429), cheap.join(','));
  } finally {
    srv.kill('SIGKILL');
  }
}

// ---- 9. and it only runs so many videos at once. The slot is held for as long
// as the work runs, not just until the 202 goes out.
async function publicConcurrency() {
  const port = await freePort();
  const { srv } = await startServer(port, {
    VIDTOTAB_PUBLIC: '1', VIDTOTAB_MAX_JOBS: '1', VIDTOTAB_RATE_LIMIT: '100',
  });
  try {
    // Same visitor throughout: a stranger calling /api/detect on someone else's
    // job is refused as a stranger (403) long before the concurrency limit is
    // reached, which would be testing the wrong thing.
    const cookie = ((await get(port, '/')).setCookie || '').split(';')[0];
    let stopA = false;
    const slow = put(port, 'slow.bin', async (req) => {
      for (let i = 0; i < 40 && !stopA && !req.destroyed; i++) { req.write(Buffer.alloc(1 << 18, 5)); await sleep(60); }
      if (!req.destroyed) req.end();
    }, { cookie });
    await sleep(500);
    const busy = await post(port, '/api/detect', { cookie });
    check('busy: a second heavy request is turned away', busy.status === 503, String(busy.status));
    check('busy: the 503 carries Retry-After', Number(busy.retryAfter) > 0, String(busy.retryAfter));
    stopA = true;
    await slow;
  } finally {
    srv.kill('SIGKILL');
  }
}

// A public instance serves strangers and holds exactly one job. Nothing tied a
// job to the visitor who started it, so anyone could read another person's
// video title, thumbnail and scanned pages — and cancel their scan outright.
// The cross-site guard never covered this: it checks origins, not people.
async function publicJobIsPrivate() {
  const port = await freePort();
  const { srv } = await startServer(port, { VIDTOTAB_PUBLIC: '1', VIDTOTAB_RATE_LIMIT: '200' });
  try {
    // A browser first contact is the page itself; /api/health deliberately
    // answers before the guard so a load balancer can reach it, and it must not
    // mint a cookie for every poll.
    const hello = await get(port, '/');
    const cookie = (hello.setCookie || '').split(';')[0];
    check('owner: a public instance issues an owner cookie', /^vtt_owner=[0-9a-f]{32}$/.test(cookie), hello.setCookie);

    const clip = tinyVideo();
    await put(port, 'ownerA.mp4', (req) => fs.createReadStream(clip).pipe(req), { cookie });
    let mine = null;
    for (let i = 0; i < 100; i++) {
      const r = await get(port, '/api/meta', { cookie });
      if (r.status === 200) { mine = r; break; }
      await sleep(100);
    }
    check('owner: the visitor who started it can read it', mine?.status === 200 && /ownerA/.test(mine.body), JSON.stringify(mine));

    // A second visitor, carrying no cookie of their own.
    const meta = await get(port, '/api/meta');
    const thumb = await get(port, '/thumb.jpg');
    const cap = await get(port, '/captures/page-1.png');
    const cancel = await post(port, '/api/cancel');
    check('owner: a stranger cannot read the video', meta.status === 403, `${meta.status} ${meta.body}`);
    check('owner: a stranger cannot fetch the thumbnail', thumb.status === 403, String(thumb.status));
    check('owner: a stranger cannot fetch the scanned pages', cap.status === 403, String(cap.status));
    check('owner: a stranger cannot cancel the scan', cancel.status === 403, String(cancel.status));

    // The snapshot the event stream opens with is its own leak path: it used to
    // carry the title, warnings and page list of whatever job was running.
    const peek = eventStream(port); // no cookie: a stranger
    await sleep(400);
    const snap = peek.seen[0] || {};
    peek.stop();
    check('owner: a stranger'+String.fromCharCode(39)+'s event stream shows them nothing',
      !snap.meta && !snap.captures && snap.job === 'idle', JSON.stringify(snap));

    const after = await get(port, '/api/meta', { cookie });
    check('owner: the job survived the stranger', after.status === 200, String(after.status));
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(SMALL, { force: true });
  }
}

// Locally there is one user by definition, so none of that machinery appears.
async function localNeedsNoOwner() {
  const port = await freePort();
  const { srv } = await startServer(port);
  try {
    const r = await get(port, '/');
    check('owner: a local instance sets no cookie', !r.setCookie, r.setCookie);
    const meta = await get(port, '/api/meta');
    check('owner: local reads are not gated', meta.status !== 403, String(meta.status));
  } finally {
    srv.kill('SIGKILL');
  }
}

// Refusing a stranger the job-scoped routes is not the same protection as
// refusing them the right to start a video: starting one replaces whatever is
// there, deleting the pages the owner may still be reading.
async function strangerCannotEraseTheJob() {
  const port = await freePort();
  const { srv } = await startServer(port, {
    VIDTOTAB_PUBLIC: '1', VIDTOTAB_RATE_LIMIT: '200', VIDTOTAB_SESSION_IDLE_MIN: '0.03', // ~1.8s
  });
  const ready = async (cookie) => {
    for (let i = 0; i < 120; i++) {
      const r = await get(port, '/api/meta', { cookie });
      if (r.status === 200 && /"ready":true/.test(r.body)) return true;
      await sleep(100);
    }
    return false;
  };
  try {
    const cookie = ((await get(port, '/')).setCookie || '').split(';')[0];
    const stranger = 'vtt_owner=' + 'f'.repeat(32);
    const clip = tinyVideo();

    await put(port, 'ownerA.mp4', (req) => fs.createReadStream(clip).pipe(req), { cookie });
    check('takeover: the owner\'s video became ready', await ready(cookie));

    // The heavy slot is free now, so only ownership stands between a stranger
    // and the delete.
    const steal = await put(port, 'stranger.mp4', (req) => fs.createReadStream(clip).pipe(req), { cookie: stranger });
    check('takeover: a stranger cannot start a video over someone else\'s', steal.status === 503, `${steal.status} ${steal.body}`);
    const still = await get(port, '/api/meta', { cookie });
    check('takeover: the owner\'s video survived the attempt', /ownerA/.test(still.body), still.body);

    const own = await put(port, 'ownerB.mp4', (req) => fs.createReadStream(clip).pipe(req), { cookie });
    check('takeover: the owner may replace their own video', own.status === 202, `${own.status} ${own.body}`);
    await ready(cookie);

    // Left alone past the idle window, the instance is anyone's again —
    // otherwise one abandoned tab would lock a public instance forever.
    await sleep(2200);
    const later = await put(port, 'later.mp4', (req) => fs.createReadStream(clip).pipe(req), { cookie: stranger });
    check('takeover: an abandoned instance can be claimed', later.status === 202, `${later.status} ${later.body}`);
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(SMALL, { force: true });
  }
}

await strangerCannotEraseTheJob();
await publicJobIsPrivate();
await localNeedsNoOwner();
await uploadRace();
await supersedeSilence();
await crossSiteGuard();
await transcodesUnplayable();
await healthEndpoint();
await limitsOffByDefault();
await publicCaps();
await publicRateLimit();
await publicConcurrency();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} server checks passed`);
process.exit(failed.length ? 1 : 0);
