// Follow-along, end to end, in a real browser with a microphone that plays a
// synthesized guitar:
//
//   node scripts/listen-e2e.mjs [--keep]
//
// A two-page songsheet is stored with its notes already fixed (so this does
// not depend on the tab reader), the practice view is opened in Listen mode,
// and Chrome's fake capture device plays the song — one wrong note in it.
// Passing means: nothing moves in the silence before the first note, the
// wrong note is called out and not accepted, every event is heard in order,
// the page turns by itself, and the end is reported.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synth, writeWav } from './guitar-synth.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// --play: the same, with the songsheet set to Play along and its clock never
// started — someone who switched modes and just plays. Pages must still turn.
const MODE = process.argv.includes('--play') ? 'play' : 'wait';
const OUT = path.join(ROOT, '.cache', MODE === 'play' ? 'listen-e2e-play' : 'listen-e2e');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[listen-e2e]', ...a);

// ---------------------------------------------------------------- the song
// Page 1: E2, A2, then a C chord. Page 2: D3 G3 B3 E4 — G3 and E4 are still
// ringing from the chord, so they have to be played again to count.
const SR = 48000;
const START = 2.5; // silence first: nothing may be accepted in it
const GAP = 1.2;
const PAGES = [
  [[[6, 0]], [[5, 0]], [[5, 3], [4, 2], [3, 0], [2, 1], [1, 0]]],
  [[[4, 0]], [[3, 0]], [[2, 0]], [[1, 0]]],
];
const TUNING = [64, 59, 55, 50, 45, 40];
const midi = ([s, f]) => TUNING[s - 1] + f;
const played = [];
let t = START;
PAGES[0].forEach((ev, i) => {
  played.push({ t, notes: ev.map((n) => ({ midi: midi(n), string: n[0] })), strumMs: ev.length > 1 ? 30 : 0 });
  t += GAP;
  // Between E2 and A2, a wrong note: F2 where A2 is expected.
  if (i === 0) { played.push({ t, notes: [{ midi: 41, string: 6 }] }); t += GAP; }
});
// No pause at the page turn: the next page's first note comes 0.2 s after
// the chord, as it does when someone plays straight through. The page must
// still turn — it once waited for a quiet moment that never came.
t -= GAP - 0.2;
for (const ev of PAGES[1]) { played.push({ t, notes: ev.map((n) => ({ midi: midi(n), string: n[0] })) }); t += GAP; }
const DURATION = t + 1.5;
const TOTAL_EVENTS = PAGES.flat().length;
const TOTAL_NOTES = PAGES.flat(2).length;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const WAV = path.join(OUT, 'song.wav');
writeWav(WAV, synth({ sampleRate: SR, duration: DURATION, events: played, seed: 7 }), SR);
log(`song: ${played.length} plucks over ${DURATION.toFixed(1)} s → ${path.relative(ROOT, WAV)}`);

// ---------------------------------------------------------------- server + Chrome
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const c = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = c.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Chromium found. Set CHROME_PATH.');
  return found;
}

const children = [];
const cleanup = () => { for (const c of children) try { c.kill(); } catch { /* gone */ } };
process.on('exit', cleanup);

const port = await freePort();
const appUrl = `http://127.0.0.1:${port}/`;
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(srv);
await Promise.race([
  new Promise((r) => srv.stdout.on('data', (d) => { if (String(d).includes('running at')) r(); })),
  sleep(20000).then(() => { throw new Error('server did not start within 20s'); }),
]);

const debugPort = await freePort();
children.push(spawn(findChrome(), [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(OUT, 'profile')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}%noloop`,
  // The audio service reads the file itself, and is sandboxed away from the
  // disk on macOS and Windows unless told otherwise.
  ...(process.platform === 'linux' ? [] : ['--disable-features=AudioServiceSandbox']),
  'about:blank'], { stdio: 'ignore' }));

let target;
for (let i = 0; i < 120 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((x) => x.type === 'page'); } catch { /* not up */ }
  if (!target) await sleep(250);
}
if (!target) throw new Error('No debuggable page found');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    if (await js(expr)) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
};

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); };

try {
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // Granted up front, as a person who allowed it before would have: the
  // microphone opens as soon as Listen is chosen, and the devices have names.
  await send('Browser.grantPermissions', { origin: appUrl.slice(0, -1), permissions: ['audioCapture'] });
  await send('Page.enable');
  await send('Page.navigate', { url: appUrl });
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('practiceBtn')`, 20000, 'app loaded');

  // A named fake device: "default" resolves to the machine's real microphone
  // on macOS even with fake devices on, and can hang there.
  const fakeId = await js(`navigator.mediaDevices.enumerateDevices().then((all) => (all.find((d) => d.kind === 'audioinput' && /^Fake Audio Input \\d/.test(d.label)) || {}).deviceId || '')`);
  log(fakeId ? 'using the named fake microphone' : 'no named fake microphone listed; using the default');

  // The songsheet: two drawn pages, their notes stored as already fixed.
  const pages = JSON.stringify(PAGES);
  await js(`(async () => {
    const { saveSheet, updateSheet } = await import('/lib/library.js');
    const { toStored, FLAG } = await import('/shared/transcript.js');
    const { sha1 } = await import('/shared/sha1.js');
    const PAGES = ${pages};
    const W = 900, H = 260, ys = [60, 84, 108, 132, 156, 180];
    const transcript = { v: 1, pages: {} };
    const stored = [];
    for (const [k, events] of PAGES.entries()) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
      x.strokeStyle = '#666'; x.lineWidth = 2;
      for (const y of ys) { x.beginPath(); x.moveTo(30, y); x.lineTo(870, y); x.stroke(); }
      x.font = 'bold 20px Helvetica'; x.textAlign = 'center'; x.textBaseline = 'middle';
      const reading = { found: true, w: W, h: H, systems: [{ lines: ys, events: [] }] };
      events.forEach((ev, i) => {
        const cx = 120 + i * 200;
        const notes = ev.map(([string, fret]) => {
          const cy = ys[string - 1];
          x.fillStyle = '#fff'; x.fillRect(cx - 9, cy - 11, 18, 22);
          x.fillStyle = '#000'; x.fillText(String(fret), cx, cy);
          return { string, fret, tech: [], box: { x: cx - 7, y: cy - 10, w: 14, h: 20 }, flags: FLAG.SET, conf: 1 };
        });
        reading.systems[0].events.push({ xc: cx, notes });
      });
      const clean = await new Promise((r) => c.toBlob(r, 'image/png'));
      transcript.pages[await sha1(clean)] = toStored(reading, { model: 'e2e' });
      stored.push({ tStart: k * 10, tEnd: k * 10 + 10, w: W, h: H, clean, color: null });
    }
    await saveSheet({ id: 'listen-e2e', title: 'Listen e2e', url: '', channel: '', duration: 20, recipe: {}, look: 'print', paper: 'letter' }, stored, null);
    await updateSheet('listen-e2e', { transcript, listen: { mode: ${JSON.stringify(MODE)} } });
    localStorage.setItem('vtt.prFollow', 'listen');
    localStorage.setItem('vtt.prLayout', 'scroll');
    localStorage.setItem('vtt.micDevice', ${JSON.stringify(fakeId)});
  })()`);
  await send('Page.reload');
  await waitFor(`!!document.querySelector('.side-item[data-sheet="listen-e2e"]')`, 20000, 'songsheet listed');
  await js(`document.querySelector('.side-item[data-sheet="listen-e2e"]').click()`);
  await waitFor(`!document.getElementById('step4').hidden`, 10000, 'songsheet opened');

  // What goes to and from the listening worker, for the timeline: the level
  // meter's latest only, everything else in order.
  await js(`window.__worker = []; window.__level = null;
    const W = window.Worker;
    window.Worker = class extends W {
      constructor(...a) {
        super(...a);
        const t0 = performance.now();
        this.addEventListener('message', (e) => { const d = e.data || {}; if (d.type === 'level') window.__level = d; else window.__worker.push({ t: (performance.now() - t0) / 1000, in: d }); });
        const post = this.postMessage.bind(this);
        this.postMessage = (m, tr) => { window.__worker.push({ t: (performance.now() - t0) / 1000, out: m.type, method: m.method, args: m.method === 'setTargets' ? m.args[0].length + ' targets' : m.args }); return post(m, tr); };
      }
    }; true`);
  // Watch the page from here on: what the notes are doing and what is said.
  await js(`window.__seen = []; window.__t0 = performance.now();
    setInterval(() => {
      const heard = document.querySelectorAll('#practice .ls-note.heard').length;
      const msg = document.getElementById('listenMsg').hidden ? '' : document.getElementById('listenMsg').textContent;
      const cur = [...document.querySelectorAll('#practice .pr-row')].findIndex((r) => r.hasAttribute('data-current'));
      const last = window.__seen[window.__seen.length - 1];
      if (!last || last.heard !== heard || last.msg !== msg || last.cur !== cur) window.__seen.push({ t: (performance.now() - window.__t0) / 1000, heard, msg, cur });
    }, 50); true`);
  await js(`document.getElementById('practiceBtn').click(); true`);
  // First time in Listen on this songsheet: it asks for tuning and capo
  // before listening. Save closes it (into the microphone button) for good.
  await waitFor(`document.getElementById('listenFirst').open`, 10000, 'the tuning window');
  check('the first time, it asks for tuning and capo', await js(`document.getElementById('lfTuning').value + ' ' + document.getElementById('lfCapo').value`) === 'standard 0');
  await js(`document.getElementById('lfSave').click(); true`);
  await waitFor(`!document.getElementById('listenFirst').open`, 5000, 'the tuning window to close');
  await waitFor(`document.querySelectorAll('#practice .ls-note').length === ${TOTAL_NOTES}`, 15000, 'every note drawn on the cards');
  check('the stored notes are drawn on both cards', true);
  await waitFor(`/^Listening with/.test(document.getElementById('lsMicState').textContent)`, 15000, 'microphone open');
  const state = await js(`document.getElementById('lsMicState').textContent`);
  check('the microphone opens with the engine running', !/did not start/.test(state), state);

  await sleep((DURATION + 2) * 1000);
  const seen = await js('window.__seen');
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ seen, worker: await js('window.__worker'), level: await js('window.__level') }, null, 2));
  const openAt = seen.find((s) => s.msg === '' && s.cur >= 0)?.t ?? 0;
  const firstHeard = seen.find((s) => s.heard > 0);
  const final = seen[seen.length - 1] || {};
  check('nothing is accepted in the silence before the first note', !firstHeard || firstHeard.t - openAt > START - 0.4, firstHeard ? `first at ${firstHeard.t.toFixed(2)} s` : 'none heard');
  check('the wrong note is called out', seen.some((s) => /^Heard F2/.test(s.msg)), seen.map((s) => s.msg).filter(Boolean).join(' | ').slice(0, 200));
  check(`every note is heard (${TOTAL_NOTES})`, final.heard === TOTAL_NOTES, `${final.heard} heard`);
  check('the page turns by itself', seen.some((s) => s.cur === 1));
  check('the end is reported', new RegExp(`${TOTAL_EVENTS} of ${TOTAL_EVENTS} heard`).test(final.msg || ''), final.msg);
  // In order: the count of heard notes only ever goes up.
  check('notes are heard in order, never un-heard', seen.every((s, i) => i === 0 || s.heard >= seen[i - 1].heard));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'end.png'), Buffer.from(shot.data, 'base64'));

  // Fixing a note by keyboard alone, and the fix surviving a reload. The
  // first note of page 1 (open low E) becomes fret 3.
  const key = (k) => js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })); true`);
  await key('Escape'); // leave practice
  await waitFor(`document.getElementById('practice').hidden`, 5000, 'practice closed');
  await key('e');
  await waitFor(`!document.getElementById('tabEdit').hidden && document.querySelectorAll('#tabEdit .te-note').length === ${PAGES[0].flat().length}`, 10000, 'editor open on page 1');
  await key('ArrowRight');
  await key('3');
  const label = await js(`document.querySelector('#tabEdit .te-note.selected .te-label')?.textContent`);
  check('a fret can be changed from the keyboard', label === '3', `selected note reads ${label}`);
  await sleep(1500); // the save waits for a pause in editing
  await key('Escape');
  await key('Escape');
  await waitFor(`document.getElementById('tabEdit').hidden`, 5000, 'editor closed');
  await send('Page.reload');
  await waitFor(`!!document.querySelector('.side-item[data-sheet="listen-e2e"]')`, 20000, 'songsheet listed again');
  const stored = await js(`import('/lib/library.js').then(({ getSheet }) => getSheet('listen-e2e')).then((s) => Object.values(s.transcript?.pages || {}).map((p) => p.systems[0].events[0].n[0][1]))`);
  check('the fix is stored with the songsheet', Array.isArray(stored) && stored.includes(3), JSON.stringify(stored));
  const confirmed = await js(`import('/lib/library.js').then(({ getSheet }) => getSheet('listen-e2e')).then((s) => s.listen?.confirmed === true)`);
  check('the tuning is stored as confirmed, so it is not asked again', confirmed === true);
  await js(`document.querySelector('.side-item[data-sheet="listen-e2e"]').click()`);
  await waitFor(`!document.getElementById('step4').hidden`, 10000, 'songsheet reopened');
  await key('e');
  await waitFor(`document.querySelectorAll('#tabEdit .te-note').length === ${PAGES[0].flat().length}`, 10000, 'editor reopened');
  const first = await js(`[...document.querySelectorAll('#tabEdit .te-note .te-label')].map((l) => l.textContent).join(' ')`);
  check('the fix is there after reopening', first.split(' ')[0] === '3', first);
} catch (err) {
  const where = await js(`JSON.stringify({ msg: document.getElementById('listenMsg')?.textContent, chips: [...document.querySelectorAll('.ls-chip')].map((c) => c.textContent), notes: document.querySelectorAll('#practice .ls-note').length, mic: document.getElementById('lsMicState')?.textContent })`).catch(() => '');
  check('the flow ran', false, `${err.message} ${where}`);
}

check('no errors in the page', problems.length === 0, problems.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed — timeline and screenshot in ${path.relative(ROOT, OUT)}`);
cleanup();
process.exit(failed ? 1 : 0);
