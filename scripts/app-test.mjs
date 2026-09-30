// Launches the desktop shell for real and checks the things that only break
// once the app is packaged or closed: that the shell starts the server at all,
// that the page is served, and that quitting leaves nothing running.
//
// The orphan check is the point. A server that outlives its window keeps the
// work folder and the port, so the next launch either fails to bind or quietly
// talks to a stale process — and the user sees an app that "did not close".
//
// In between, it drives the window over the DevTools protocol and checks what
// only the real shell can do: the songsheet library writing actual folders
// through the preload bridge, the library screen showing them, an edit on the
// songsheet step saving itself back to disk, the microphone reaching the
// listening worker past the shell's permission handler (a fake capture device
// playing a generated WAV), and the update check finding a newer release and
// downloading it — against a fake GitHub on loopback, so nothing here depends
// on the network, a real microphone or what is really published. The app
// runs on a profile, library and downloads folder of its own, so none of this
// touches a real install.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// ---------------------------------------------------------------- fake GitHub

// One release, far in the future, with an installer for every platform named
// the way GitHub names them. The payload is random, and its digest is the real
// SHA-256 of it, so the shell's checksum check has something to check.
const payload = crypto.randomBytes(300 * 1024);
const digest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
const feedPort = await freePort();
const feedBase = `http://127.0.0.1:${feedPort}`;
const assetNames = ['VidToTab-99.0.0-arm64.dmg', 'VidToTab-99.0.0.dmg', 'VidToTab.Setup.99.0.0.exe',
  'vidtotab_99.0.0_amd64.deb', 'vidtotab_99.0.0_arm64.deb', 'VidToTab-99.0.0.AppImage'];
const feed = http.createServer((req, res) => {
  if (req.url === '/latest') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: 'v99.0.0', name: 'VidToTab v99.0.0', draft: false, prerelease: false,
      html_url: 'https://github.com/KXYZ6753/VidToTab/releases/tag/v99.0.0', body: 'test release',
      assets: assetNames.map((name) => ({ name, size: payload.length, digest, browser_download_url: `${feedBase}/files/${name}` })),
    }));
    return;
  }
  if (req.url.startsWith('/files/')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
    res.end(payload);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => feed.listen(feedPort, '127.0.0.1', r));

const scratch = mkdtempSync(path.join(os.tmpdir(), 'vtt-app-test-'));
const LIBRARY = path.join(scratch, 'library');
const DOWNLOADS = path.join(scratch, 'downloads');
const cdpPort = await freePort();

// ---------------------------------------------------------------- fake microphone

// What the shell's fake microphone plays: a second of silence, then two of an
// open A string (110 Hz), as 48 kHz 16-bit mono. A sawtooth rather than a sine
// because a string is all harmonics; the short fades keep the edges from
// clicking. The silence first means a meter reading above zero can only have
// come from the file, not from a device that makes up its own noise.
function toneWav(file, rate = 48000) {
  const silent = rate;
  const tone = 2 * rate;
  const n = silent + tone;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);        // fmt chunk size
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);  // byte rate
  buf.writeUInt16LE(2, 32);         // block align
  buf.writeUInt16LE(16, 34);        // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  const fade = Math.round(rate * 0.01);
  for (let i = 0; i < tone; i++) {
    const phase = (110 * i / rate) % 1;
    const env = Math.min(1, i / fade, (tone - 1 - i) / fade);
    buf.writeInt16LE(Math.round((2 * phase - 1) * 0.5 * env * 32767), 44 + (silent + i) * 2);
  }
  writeFileSync(file, buf);
  return file;
}
const FAKE_MIC = toneWav(path.join(scratch, 'fake-mic.wav'));

const child = spawn(BIN, ARGS, {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    VIDTOTAB_USER_DATA: path.join(scratch, 'profile'),
    VIDTOTAB_LIBRARY_DIR: LIBRARY,
    VIDTOTAB_DOWNLOAD_DIR: DOWNLOADS,
    VIDTOTAB_UPDATE_FEED: `${feedBase}/latest`,
    // The launch check is timer-driven; the test asks when it is ready to.
    VIDTOTAB_NO_UPDATE_CHECK: '1',
    VIDTOTAB_CDP_PORT: String(cdpPort),
    VIDTOTAB_FAKE_MIC: FAKE_MIC,
  },
});
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

// ---------------------------------------------------------------- the window

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws = null;
let quitEdit = null;
let quitAsked = false;
try {
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${port}/`));
    } catch { /* not up yet */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('the window never loaded the app page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, label, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await js(expression).catch(() => false)) return true;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const sheetJson = (folder) => JSON.parse(readFileSync(path.join(LIBRARY, folder, 'sheet.json'), 'utf8'));

  // The app page itself, not the "Starting…" page the shell shows first: that
  // one has the bridge too (the shell refuses it), and DevTools can already
  // list the app's address for it while the navigation is still pending.
  const appReady = `location.href.startsWith('http://127.0.0.1:${port}/') && document.readyState === 'complete' && !!document.getElementById('libraryView') && !!window.vidtotab?.library && !document.documentElement.dataset.splash`;
  await waitFor(appReady, 'the app to finish opening', 60000);

  const info = await js(`window.vidtotab.library.info()`);
  check('the library folder is the one the shell was given', path.resolve(info.dir) === path.resolve(LIBRARY));

  // Upgrading from 0.2, which kept songsheets in IndexedDB: put one there the
  // way 0.2 did, forget that the copy was ever made, and reload. It has to
  // arrive in the folder with its date and thumbnail — and stay in IndexedDB.
  const PNG0 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  await js(`new Promise((resolve, reject) => {
    const req = indexedDB.open('vidtotab', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('sheets', { keyPath: 'id' }).createIndex('savedAt', 'savedAt');
      req.result.createObjectStore('pages', { keyPath: 'key' }).createIndex('sheetId', 'sheetId');
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const png = new Blob([Uint8Array.from(atob('${PNG0}'), (c) => c.charCodeAt(0))], { type: 'image/png' });
      const tx = db.transaction(['sheets', 'pages'], 'readwrite');
      tx.objectStore('sheets').put({ id: 'old-00000001', title: 'From Version Two', url: '', channel: 'ch', duration: 60, pageCount: 1,
        recipe: { rect: null, startTime: 0, sensitivity: 0.5 }, look: 'print', paper: 'letter', savedAt: 1700000000000, updatedAt: 1700000000000,
        thumb: new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' }) });
      tx.objectStore('pages').put({ key: 'old-00000001:0000', sheetId: 'old-00000001', index: 0, tStart: 0, tEnd: 5, alsoAt: [], w: 1, h: 1, clean: png, color: null });
      tx.oncomplete = () => { db.close(); localStorage.removeItem('vtt.libMigrated'); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  })`);
  await send('Page.reload');
  await sleep(500);
  await waitFor(appReady, 'the reload');
  let migrated = false;
  for (let i = 0; i < 60 && !migrated; i++) {
    await sleep(150);
    migrated = existsSync(path.join(LIBRARY, 'From Version Two', 'sheet.json'));
  }
  check('a songsheet from 0.2 is copied into the folder on the first launch', migrated);
  check('…keeping its dates and its thumbnail', migrated
    && sheetJson('From Version Two').savedAt === 1700000000000
    && sheetJson('From Version Two').updatedAt === 1700000000000
    && existsSync(path.join(LIBRARY, 'From Version Two', 'thumb.jpg')));
  check('…and the copy in the browser store is left alone', await js(`new Promise((r) => {
    const req = indexedDB.open('vidtotab', 1);
    req.onsuccess = () => { const g = req.result.transaction('sheets').objectStore('sheets').get('old-00000001'); g.onsuccess = () => { r(!!g.result); req.result.close(); }; };
    req.onerror = () => r(false);
  })`));

  // A real (1×1) PNG, saved through the bridge exactly as a finished scan is.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  await js(`(async () => {
    const bytes = Uint8Array.from(atob('${PNG}'), (c) => c.charCodeAt(0));
    const page = (n) => ({ tStart: n * 10, tEnd: n * 10 + 9, alsoAt: [], w: 1, h: 1, clean: bytes, color: null });
    return window.vidtotab.library.save({ id: 'test-00000001', title: 'Test: Song?', url: 'https://example.test/v' }, [page(1), page(2)], null);
  })()`);
  const folder = 'Test Song';
  check('saving writes a folder named after the title', existsSync(path.join(LIBRARY, folder, 'sheet.json')));
  // Both test pages are the same image, and a page file is named after its
  // content, so they share one file; what matters is that sheet.json lists two
  // pages and every file it lists is there.
  const listed = sheetJson(folder).pages.map((p) => p.file);
  check('…listing every page, each file present', listed.length === 2 && listed.every((f) => /^page-\d{3}-[0-9a-f]{8}\.png$/.test(f) && existsSync(path.join(LIBRARY, folder, f))));

  await js(`window.vidtotab.library.update('test-00000001', { title: 'Renamed Song', notes: 'capo 2' })`);
  check('renaming moves the folder with the title', existsSync(path.join(LIBRARY, 'Renamed Song', 'sheet.json')) && !existsSync(path.join(LIBRARY, folder)));
  check('…and keeps the notes in sheet.json', sheetJson('Renamed Song').notes === 'capo 2');

  // The library screen, from the sidebar, over that folder.
  await js(`(document.getElementById('sideNew').click(), true)`);
  await waitFor(`!document.getElementById('sideLibrary').hidden`, 'the Library button in the sidebar');
  await js(`(document.getElementById('sideLibrary').click(), true)`);
  await waitFor(`!document.getElementById('libraryView').hidden && document.querySelectorAll('#lvGrid .lv-card').length === 2`, 'the library screen');
  check('the library screen lists both songsheets', (await js(`document.getElementById('lvGrid').textContent`)).includes('Renamed Song'));

  // Opening it, and editing it on the songsheet step: the edit saves itself.
  await js(`([...document.querySelectorAll('#lvGrid .lv-card')].find((c) => c.textContent.includes('Renamed Song')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true)`);
  await waitFor(`!document.getElementById('step4').hidden && document.getElementById('libraryView').hidden`, 'the songsheet to open');
  await js(`(() => { const t = document.getElementById('titleInput'); t.value = 'Edited On Step Four'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  let saved = false;
  for (let i = 0; i < 40 && !saved; i++) {
    await sleep(150);
    saved = existsSync(path.join(LIBRARY, 'Edited On Step Four', 'sheet.json'));
  }
  check('an edit on the songsheet step is saved back to the folder', saved);
  check('…without losing what the library knew about it', saved && sheetJson('Edited On Step Four').notes === 'capo 2');

  // The microphone, for following along. The shell plays the WAV above as a
  // fake capture device but does not fake the permission prompt, so these go
  // through the real permission handler: our page may have the microphone,
  // nobody may have the camera, and what the microphone hears reaches the
  // listening worker as a level above zero.
  //
  // A named fake device, never the "default" entry: Chromium resolves that one
  // against the computer's real default microphone even with fake devices on,
  // and on a Mac that can sit in CoreAudio indefinitely (waiting on the system
  // for whatever launched the test). Every step is also bounded in the page, so
  // a microphone that never answers fails a check instead of hanging the run.
  const within = (ms, what) => `new Promise((_, no) => setTimeout(() => no(new Error('${what}: no answer in ${ms / 1000}s')), ${ms}))`;
  const fakeId = await js(`navigator.mediaDevices.enumerateDevices().then((all) => {
    const d = all.find((x) => x.kind === 'audioinput' && /^Fake Audio Input \\d/.test(x.label));
    return d ? d.deviceId : null;
  })`);
  check('the page sees the (fake) microphones by name', typeof fakeId === 'string' && fakeId.length > 0);
  const deviceArg = JSON.stringify(fakeId ? { exact: fakeId } : undefined);
  const mic = await js(`Promise.race([navigator.mediaDevices.getUserMedia({ audio: { deviceId: ${deviceArg} } }), ${within(10000, 'getUserMedia')}]).then((s) => {
    const t = s.getAudioTracks()[0];
    const r = { live: t?.readyState === 'live', label: t?.label || '' };
    s.getTracks().forEach((x) => x.stop());
    return r;
  }, (e) => ({ error: e.name + ': ' + e.message }))`);
  check(`the page can open the microphone (${mic.error || mic.label || 'no label'})`, mic.live === true);
  const cam = await js(`Promise.race([navigator.mediaDevices.getUserMedia({ video: true }), ${within(10000, 'getUserMedia')}])
    .then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name)`);
  check(`…but not the camera (${cam})`, cam === 'NotAllowedError');
  const micStatus = await js(`window.vidtotab.mic.status()`);
  check(`the shell reports what the system allows (${micStatus})`, typeof micStatus === 'string' && micStatus.length > 0);
  const heard = await js(`(async () => {
    try {
      const { openMic } = await import('/listen-audio.js');
      const s = await Promise.race([openMic({ deviceId: ${JSON.stringify(fakeId)} }), ${within(10000, 'openMic')}]);
      window.__vttTestMic = s;
      const ready = await Promise.race([s.ready, new Promise((r) => setTimeout(() => r(null), 5000))]);
      const level = await new Promise((resolve) => {
        const timer = setTimeout(() => { off(); resolve(null); }, 5000);
        const off = s.on('level', (m) => { if (m.rms > 0) { clearTimeout(timer); off(); resolve(m); } });
      });
      return { level, rate: s.sampleRate, engine: ready ? ready.engine : null };
    } catch (e) {
      return { error: (e.code ? e.code + ': ' : '') + e.message };
    }
  })()`);
  check(`the listening worker hears the microphone (${heard.error
    || `rms ${heard.level ? heard.level.rms.toFixed(3) : 'none'} at ${heard.rate} Hz, engine ${heard.engine ? 'loaded' : 'not loaded'}`})`,
  !heard.error && heard.level?.rms > 0);
  const afterClose = await js(`(async () => {
    const s = window.__vttTestMic;
    if (!s) return 'never opened';
    await Promise.race([s.close(), ${within(5000, 'close')}]);
    delete window.__vttTestMic;
    return s.track.readyState;
  })().catch((e) => e.message)`);
  check(`closing it stops the microphone (${afterClose})`, afterClose === 'ended');
  const wake = await js(`Promise.race([navigator.wakeLock.request('screen'), ${within(5000, 'wakeLock')}])
    .then(async (l) => { const held = !l.released; await l.release(); return held ? 'held' : 'released'; }, (e) => e.name + ': ' + e.message)`);
  check(`the screen wake lock is still granted (${wake})`, wake === 'held');

  // Updates: the version in the top bar opens the check, the check finds
  // 99.0.0, and Download fetches this platform's installer and verifies it.
  await js(`(document.getElementById('appVersion').click(), true)`);
  await waitFor(`!document.getElementById('updateBanner').hidden`, 'the update banner');
  const title = await js(`document.getElementById('updTitle').textContent`);
  check(`the update check finds the newer release ("${title}")`, /99\.0\.0 is available/.test(title));
  await js(`(document.getElementById('aboutDialog').close(), [...document.querySelectorAll('#updActions button')].find((b) => /^Download/.test(b.textContent)).click(), true)`);
  await waitFor(`/is downloaded/.test(document.getElementById('updTitle').textContent)`, 'the download to finish', 30000);
  const got = readdirSync(DOWNLOADS);
  check(`the installer for this platform is downloaded (${got.join(', ')})`, got.length === 1 && readFileSync(path.join(DOWNLOADS, got[0])).equals(payload));

  // Last: an edit made a moment before quitting, well inside the autosave's
  // wait. The shell has to let the page write it before the window goes.
  await js(`(() => { const t = document.getElementById('titleInput'); t.value = 'Typed Just Before Quitting'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  quitEdit = path.join(LIBRARY, 'Typed Just Before Quitting', 'sheet.json');
  // Quit the way the app does — the menu, "Install and close" — rather than by
  // signal: on Windows a signal from Node is TerminateProcess, which no
  // program gets to finish anything after.
  await js(`window.vidtotab.updates.quit()`);
  quitAsked = true;
} catch (e) {
  check(`driving the window: ${e.message}`, false);
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  feed.close();
}

const running = () => child.exitCode === null && child.signalCode === null;
if (quitAsked && running()) {
  await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 10000))]);
}
if (running()) child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 4000));
if (quitEdit) check('an edit made just before quitting is saved on the way out', existsSync(quitEdit));
const after = await probe();
check(`no orphan server after quit (${after})`, String(after).startsWith('err:'));
check('the app process exited', child.exitCode !== null || child.signalCode !== null);

try { rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* scratch in tmp */ }

const failed = checks.filter((ok) => !ok).length;
if (failed) console.error('\n--- app output ---\n' + out.slice(-1500));
console.log(failed ? `\n${failed} of ${checks.length} app checks FAILED` : `\n${checks.length}/${checks.length} app checks passed`);
process.exit(failed ? 1 : 0);
