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

async function startServer(port) {
  const srv = spawn('node', [ENTRY], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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

function put(port, name, feed) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'PUT', path: '/api/video/file?name=' + encodeURIComponent(name) },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 120) })); });
    req.on('error', (e) => resolve({ status: 0, body: 'req error: ' + e.code }));
    feed(req);
  });
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
  const seen = [];
  const stream = http.request(
    { host: '127.0.0.1', port, path: '/api/events', headers: { accept: 'text/event-stream' } },
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
  stream.end();
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
    stream.destroy();
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

await uploadRace();
await supersedeSilence();
await crossSiteGuard();
await transcodesUnplayable();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} server checks passed`);
process.exit(failed.length ? 1 : 0);
