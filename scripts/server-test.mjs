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
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'work');
const ENTRY = process.env.SERVER || 'server.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const SMALL = path.join(WORK, '..', '.e2e-small.mp4');
function tinyVideo() {
  execSync(`ffmpeg -y -v error -f lavfi -i testsrc=size=320x240:rate=10:duration=2 -pix_fmt yuv420p ${JSON.stringify(SMALL)}`);
  return SMALL;
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

await uploadRace();
await crossSiteGuard();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} server checks passed`);
process.exit(failed.length ? 1 : 0);
