// Launches the desktop shell for real and checks the things that only break
// once the app is packaged or closed: that the shell starts the server at all,
// that the page is served, and that quitting leaves nothing running.
//
// The orphan check is the point. A server that outlives its window keeps the
// work folder and the port, so the next launch either fails to bind or quietly
// talks to a stale process — and the user sees an app that "did not close".

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const START_TIMEOUT_MS = 60000;

// `--packaged` runs the same checks against a built app. That is where the
// paths differ: the server lives in resources/app rather than beside this
// script, and it needs its own package.json to be read as ESM at all. Neither
// of those can fail in development, so only this mode can catch them.
const packaged = process.argv.includes('--packaged');

function packagedBinary() {
  return [
    'dist/mac-arm64/VidToTab.app/Contents/MacOS/VidToTab',
    'dist/mac/VidToTab.app/Contents/MacOS/VidToTab',
    'dist/linux-unpacked/vidtotab',
    'dist/linux-arm64-unpacked/vidtotab',
    'dist/win-unpacked/VidToTab.exe',
  ].map((p) => path.join(ROOT, p)).find((p) => existsSync(p));
}

const BIN = packaged ? packagedBinary() : path.join(ROOT, 'node_modules', '.bin', 'electron');
const ARGS = packaged ? [] : ['.'];

if (!BIN) {
  console.error('no packaged app found — run: npm run pack');
  process.exit(1);
}
if (!existsSync(BIN)) {
  console.error('electron is not installed — run: npm install');
  process.exit(1);
}
console.log(`target: ${packaged ? 'packaged' : 'development'} (${path.relative(ROOT, BIN)})\n`);

const checks = [];
const check = (label, ok) => { checks.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); };

const child = spawn(BIN, ARGS, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

let port;
try {
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line within ${START_TIMEOUT_MS / 1000}s`)), START_TIMEOUT_MS);
    const poll = setInterval(() => {
      const m = out.match(/VIDTOTAB_LISTENING (\d+)/);
      if (!m) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(Number(m[1]));
    }, 200);
    child.once('exit', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`electron exited with ${code} before the server started`));
    });
  });
} catch (e) {
  console.error('FAIL:', e.message);
  console.error(out.slice(-2000));
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(1);
}

const probe = () => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on('error', (e) => resolve('err:' + e.code));
  req.on('timeout', () => { req.destroy(); resolve('timeout'); });
  req.end();
});

check(`the shell started the server (port ${port})`, port > 0);
check('the app page is served', (await probe()) === 200);

child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 4000));
const after = await probe();
check(`no orphan server after quit (${after})`, String(after).startsWith('err:'));
check('the app process exited', child.exitCode !== null || child.signalCode !== null);

const failed = checks.filter((ok) => !ok).length;
if (failed) console.error('\n--- app output ---\n' + out.slice(-1500));
console.log(failed ? `\n${failed} of ${checks.length} app checks FAILED` : `\n${checks.length}/${checks.length} app checks passed`);
process.exit(failed ? 1 : 0);
