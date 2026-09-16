// Browser end-to-end test: drives a real browser through the whole VidToTab flow over CDP.
//
//   npm run e2e                        file upload flow against `node server.js`
//   npm run e2e -- --url <youtube>     paste-a-link flow instead of a file
//   npm run e2e -- --app <binary>      drive a packaged app instead of starting the server
//   npm run e2e -- --keep              keep screenshots and downloads
//
// Screenshots, downloads and a log land in .e2e/ (or $E2E_OUT). Exits non-zero on failure.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const flag = (name) => argv.includes(name);

const OUT = process.env.E2E_OUT || path.join(ROOT, '.e2e');
const VIDEO = process.env.E2E_VIDEO || path.join(ROOT, '.cache/eval/yT9gKKwBeVw/video.mp4');
const YT_URL = arg('--url');
const APP_BIN = arg('--app');
const KEEP = flag('--keep');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
         '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Chromium found. Set CHROME_PATH.');
  return found;
}

if (!YT_URL && !fs.existsSync(VIDEO)) {
  console.error(`Test video missing: ${VIDEO}\nRun \`npm run eval\` once to download it, or pass E2E_VIDEO=/path/to/video.mp4, or use --url <youtube link>.`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'downloads'), { recursive: true });

// ---------------------------------------------------------------- app + browser
const children = [];
let appUrl, debugPort;

if (APP_BIN) {
  // Packaged app: it starts its own server and exposes CDP when VIDTOTAB_CDP_PORT is set.
  debugPort = await freePort();
  const app = spawn(APP_BIN, [], { env: { ...process.env, VIDTOTAB_CDP_PORT: String(debugPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(app);
  app.stdout.on('data', (d) => process.stdout.write('[app] ' + d));
  app.stderr.on('data', (d) => process.stderr.write('[app] ' + d));
} else {
  const port = Number(process.env.PORT) || await freePort();
  appUrl = `http://127.0.0.1:${port}/`;
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(srv);
  const srvLog = fs.createWriteStream(path.join(OUT, 'server.log'));
  srv.stdout.on('data', (d) => srvLog.write(d));
  srv.stderr.on('data', (d) => { srvLog.write(d); process.stderr.write('[srv] ' + d); });
  await Promise.race([
    new Promise((r) => srv.stdout.on('data', (d) => { if (String(d).includes('running at')) r(); })),
    sleep(20000).then(() => { throw new Error('server did not start within 20s'); }),
  ]);

  debugPort = await freePort();
  children.push(spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' }));
}

let target;
for (let i = 0; i < 120; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && (!APP_BIN || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(t.url)));
    if (target) break;
  } catch { /* not up yet */ }
  await sleep(250);
}
if (!target) throw new Error('No debuggable page found');
if (APP_BIN) appUrl = target.url;

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  } else if (msg.method) for (const l of listeners) l(msg);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const waitFor = async (expr, ms = 120000, label = expr) => {
  const t0 = Date.now();
  for (;;) {
    if (await evalJs(expr)) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
};
const shot = async (name, full = false) => {
  let clip;
  if (full) {
    const m = await send('Page.getLayoutMetrics');
    clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 5000), scale: 1 };
  }
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  log('shot', name);
};

const problems = [];
listeners.push((m) => {
  if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
});

const downloads = () => fs.readdirSync(path.join(OUT, 'downloads')).filter((f) => !f.endsWith('.crdownload'));
let failure = null;

// ---------------------------------------------------------------- the flow
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('DOM.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(OUT, 'downloads'), eventsEnabled: true })
    .catch(() => send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(OUT, 'downloads') }));
  const desktop = () => send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const scheme = (v) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
  await desktop(); await scheme('light');
  await send('Page.navigate', { url: appUrl });
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('urlForm')`, 20000, 'app loaded');
  await sleep(600);
  await shot('1-source-light');

  // The yt-dlp staleness notice is built in JS, so a wrong helper would render
  // nothing at all rather than fail. Assert against what the server reports, so
  // this still passes on a machine with an up-to-date yt-dlp.
  const pref = JSON.parse(await evalJs(`fetch('/api/preflight').then(r => r.json()).then(JSON.stringify)`) || '{}');
  if (pref.ytdlpStale) {
    const shown = await evalJs(`[...document.querySelectorAll('.banner.warn p')].some((p) => /yt-dlp is \\d+ days old/.test(p.textContent))`);
    if (!shown) problems.push('yt-dlp reports stale but no staleness banner was rendered');
    else log(`stale banner shown (yt-dlp ${pref.ytdlpVersion}, ${pref.ytdlpAgeDays} days)`);
  } else {
    log(`yt-dlp current (${pref.ytdlpVersion || '?'}) — no staleness banner expected`);
  }

  // The one-click entry points are pure wiring, which is the kind of thing that
  // looks right and silently does nothing: a too-eager guard swallows every
  // paste, and ?url= can fire before the form exists. Checked without network
  // by watching where the link lands rather than whether it downloads.
  // Submission is blocked for the duration: these entry points end in a real
  // POST, and letting a probe start a download of example.test would reset the
  // app and wreck every later step. Capturing the submit event also proves the
  // link reached the form, which is stronger than reading the input afterwards
  // — that would race requestSubmit().
  const probeEntry = async (label, script) => {
    const got = await evalJs(`new Promise((resolve) => {
      const form = document.getElementById('urlForm');
      const input = document.getElementById('urlInput');
      const before = input.value;
      const onSubmit = (e) => { e.preventDefault(); e.stopImmediatePropagation(); finish(input.value); };
      const timer = setTimeout(() => finish(input.value || '(no submit)'), 1200);
      function finish(v) {
        clearTimeout(timer);
        form.removeEventListener('submit', onSubmit, true);
        input.value = before;
        resolve(String(v));
      }
      form.addEventListener('submit', onSubmit, true);
      ${script}
    })`);
    log(`${label} ->`, got || '(nothing)');
    return String(got);
  };

  const pasted = await probeEntry('paste a link anywhere', `
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://example.test/watch?v=paste-probe');
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));`);
  if (!pasted.includes('paste-probe')) problems.push(`pasting a link anywhere did not reach the URL form (got "${pasted}")`);

  const dropped = await probeEntry('drop a link', `
      const dt = new DataTransfer();
      dt.setData('text/uri-list', 'https://example.test/watch?v=drop-probe');
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));`);
  if (!dropped.includes('drop-probe')) problems.push(`dropping a link did not reach the URL form (got "${dropped}")`);

  if (YT_URL) {
    log('source: youtube link', YT_URL);
    await evalJs(`(() => {
      const f = document.getElementById('urlForm');
      const i = f.querySelector('input[type=url], input[type=text], input');
      i.value = ${JSON.stringify(YT_URL)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`);
    await waitFor(`!document.getElementById('sourceCard').hidden`, 30000, 'source card');
    await shot('1b-downloading-light');
    await waitFor(`!document.getElementById('step2').hidden`, 420000, 'step 2 (download + detect)');
  } else {
    log('source: file upload', VIDEO);
    const doc = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { nodeId, files: [VIDEO] });
    await waitFor(`!document.getElementById('sourceCard').hidden`, 10000, 'source card');
    await sleep(300);
    await shot('1b-uploading-light');
    await waitFor(`!document.getElementById('step2').hidden`, 120000, 'step 2');
  }

  await waitFor(`/is-(found|none|low)/.test(document.getElementById('detectStatus').className)`, 60000, 'detection');
  await waitFor(`document.getElementById('video').readyState >= 2`, 20000, 'video frame');
  await sleep(1200);
  log('detect:', await evalJs(`document.getElementById('detectTitle').textContent`));
  await shot('2-region-light');
  await evalJs(`document.getElementById('adjustBtn').click()`);
  await sleep(400);
  await shot('2b-adjust-light');
  await evalJs(`document.getElementById('adjustBtn').click()`);

  // Accessibility wiring, which is the kind that looks finished while doing
  // nothing: focus can fail to move (a hidden section cannot take focus, so the
  // order of hiding and focusing matters), a progressbar can carry no value,
  // and a "draw a box" key can be bound but never create one.
  const focusAfterStep = await evalJs(`(() => {
    document.querySelector('#stepper [data-step="1"]').click();
    const a = document.activeElement;
    return a ? (a.id || a.tagName) : 'none';
  })()`);
  log('focus after changing step ->', focusAfterStep);
  if (focusAfterStep !== 'step1') problems.push(`focus did not follow the step change (landed on ${focusAfterStep})`);
  await evalJs(`document.querySelector('#stepper [data-step="2"]').click()`);
  await sleep(400);

  // Detection already found a box here, so asking "is there a box afterwards"
  // would pass whether or not b did anything — it did, in an earlier run, and
  // proved nothing. Check the observable effect instead: b enters box editing.
  // Escape first so the starting state is known rather than assumed.
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(250);
  const beforeB = await evalJs(`document.getElementById('adjustBtn').textContent.trim()`);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))`);
  await sleep(350);
  const afterB = await evalJs(`document.getElementById('adjustBtn').textContent.trim()`);
  log(`b key: adjust button "${beforeB}" -> "${afterB}"`);
  if (beforeB === 'Done') problems.push('could not reach a known state before testing the b key');
  if (afterB !== 'Done') problems.push(`the b key did not enter box editing (button reads "${afterB}")`);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(250);

  await evalJs(`document.getElementById('analyzeBtn').click()`);
  await waitFor(`!document.getElementById('step3').hidden`, 20000, 'step 3');
  await sleep(2500);
  await shot('3-scan-light');
  await waitFor(`!document.getElementById('step4').hidden`, 300000, 'step 4');
  await sleep(1500);
  const pages = await evalJs(`document.getElementById('rvCount').textContent`);
  log('review:', pages, '| title:', await evalJs(`document.getElementById('titleInput').value`));

  // Checked here, where rows actually exist. An earlier attempt ran this before
  // any scan had finished, found nothing, and asserted nothing.
  const rowA11y = await evalJs(`(() => {
    const r = document.querySelector('.sheet-item');
    if (!r) return 'none';
    return r.tabIndex + ':' + r.getAttribute('role') + ':' + ((r.getAttribute('aria-label') || '').slice(0, 6));
  })()`);
  log('review row keyboard reachability ->', rowA11y);
  if (!/^0:button:Page/.test(String(rowA11y))) problems.push(`review rows are not keyboard reachable (${rowA11y})`);
  if (!/[1-9]/.test(pages)) throw new Error(`no pages captured: ${pages}`);
  await shot('4-review-light');
  await shot('4-review-light-full', true);

  // Practice mode is wiring again: it could open showing a blank image, or the
  // key interception could swallow every key without turning a page, and a
  // screenshot would look right either way. Check the page actually resolves
  // and that a keypress moves it.
  await evalJs(`document.getElementById('practiceBtn').click()`);
  await sleep(700);
  const pracOpen = await evalJs(`!document.getElementById('practice').hidden`);
  const pracFirst = await evalJs(`document.getElementById('practicePos').textContent`);
  const pracLoaded = await evalJs(`(() => { const i = document.getElementById('practicePage'); return !!i && i.complete && i.naturalWidth > 0; })()`);
  log(`practice: open=${pracOpen}, "${pracFirst}", image decoded=${pracLoaded}`);
  if (!pracOpen) problems.push('the practice view did not open');
  if (!pracLoaded) problems.push('the practice view opened with no readable page');

  // Space is what a page-turner pedal sends, and it is the key most likely to
  // be stolen by a focused button.
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))`);
  await sleep(500);
  const pracSecond = await evalJs(`document.getElementById('practicePos').textContent`);
  log('practice after space ->', pracSecond);
  if (pracSecond === pracFirst) problems.push(`space did not turn the page (still "${pracSecond}")`);
  await shot('7-practice');

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(400);
  const pracClosed = await evalJs(`document.getElementById('practice').hidden`);
  if (!pracClosed) problems.push('Escape did not leave the practice view');

  const lookIds = await evalJs(`[...document.querySelectorAll('#lookSeg button')].map((b) => b.dataset.look).join(',')`);
  log('looks offered:', lookIds);
  if (!/print/.test(lookIds || '')) problems.push(`look buttons missing or unnamed: ${lookIds}`);

  await evalJs(`document.querySelector('#lookSeg [data-look=color]').click()`);
  await sleep(1200);
  await shot('4b-review-original-light');

  // Dark recolours the stored greyscale page in the browser, so the preview
  // image must become a data: URL and the paper behind it must go dark. A look
  // that silently fell back to the plain render would still look plausible.
  await evalJs(`document.querySelector('#lookSeg [data-look=dark]').click()`);
  await sleep(1500);
  const darkImg = await evalJs(`(document.querySelector('.sheet-item img')?.src || '').slice(0, 15)`);
  const darkPaper = await evalJs(`getComputedStyle(document.querySelector('.sheet-item .paper')).backgroundColor`);
  log('dark look: img src', darkImg, '| paper', darkPaper);
  if (!String(darkImg).startsWith('data:image')) problems.push(`dark look did not recolour the preview (src ${darkImg})`);
  if (!/17,\s*17,\s*19/.test(String(darkPaper))) problems.push(`dark look paper colour wrong: ${darkPaper}`);
  await shot('4e-review-dark-look');

  await evalJs(`document.querySelector('#lookSeg [data-look=print]').click()`);

  // delete + undo
  const n0 = await evalJs(`document.querySelectorAll('.sheet-item').length`);
  await evalJs(`document.querySelector('.sheet-item .icon-btn').click()`);
  await sleep(300);
  const n1 = await evalJs(`document.querySelectorAll('.sheet-item').length`);
  if (n1 !== n0 - 1) throw new Error(`delete did not remove a page (${n0} -> ${n1})`);
  await shot('4c-deleted-toast');
  await evalJs(`document.getElementById('toastUndo').click()`);
  await sleep(200);
  const n2 = await evalJs(`document.querySelectorAll('.sheet-item').length`);
  if (n2 !== n0) throw new Error(`undo did not restore the page (${n1} -> ${n2})`);
  log('delete/undo ok:', `${n0} -> ${n1} -> ${n2}`);

  // title with non-Latin characters, then both exports
  await evalJs(`(() => { const i = document.getElementById('titleInput'); i.value = 'Crossing Field 「クロスファイア」 테스트'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evalJs(`document.getElementById('exportPdf').click()`);
  for (let i = 0; i < 120 && !downloads().some((f) => f.endsWith('.pdf')); i++) await sleep(250);
  if (!downloads().some((f) => f.endsWith('.pdf'))) throw new Error('PDF export produced no download');
  await evalJs(`document.getElementById('exportPng').click()`);
  for (let i = 0; i < 120 && !downloads().some((f) => f.endsWith('.png')); i++) await sleep(250);
  if (!downloads().some((f) => f.endsWith('.png'))) throw new Error('PNG export produced no download');
  log('downloads:', downloads());

  // The Dark look has to reach the exported file, not just the screen. Every
  // check above would still pass if the pages were dark tiles on a white sheet,
  // so sample the corner of what actually landed on disk.
  // The download name comes from the title, so Chrome overwrites the previous
  // file rather than adding one. "The dark export arrived" therefore means a
  // newer timestamp, not a new filename — matching on the name reported a
  // failure here while the export had actually worked.
  const pngPath = () => {
    const f = downloads().find((n) => n.endsWith('.png'));
    return f ? path.join(OUT, 'downloads', f) : null;
  };
  const beforePng = pngPath();
  const beforeMtime = beforePng ? fs.statSync(beforePng).mtimeMs : 0;
  await evalJs(`document.querySelector('#lookSeg [data-look=dark]').click()`);
  await sleep(1200);
  await evalJs(`document.getElementById('exportPng').click()`);
  let darkPath = null;
  for (let i = 0; i < 160 && !darkPath; i++) {
    const p = pngPath();
    if (p && fs.statSync(p).mtimeMs > beforeMtime) darkPath = p;
    else await sleep(250);
  }
  if (!darkPath) {
    problems.push('dark PNG export produced no download');
  } else {
    await sleep(800); // let the browser finish writing before sampling it
    const raw = execSync(
      `ffmpeg -v error -i ${JSON.stringify(darkPath)} -vf "crop=8:8:0:0,format=rgb24" -f rawvideo -`,
      { maxBuffer: 1 << 20 });
    const [r, g, b] = [raw[0], raw[1], raw[2]];
    log(`dark PNG corner pixel: rgb(${r}, ${g}, ${b})`);
    if (r > 60 || g > 60 || b > 60) problems.push(`dark export has a light background: rgb(${r}, ${g}, ${b})`);
  }
  await evalJs(`document.querySelector('#lookSeg [data-look=print]').click()`);

  // dark scheme and the earlier steps
  await scheme('dark');
  await sleep(400);
  await shot('4d-review-dark');
  await evalJs(`document.querySelector('#stepper [data-step="2"]').click()`);
  await sleep(700);
  await shot('2c-region-dark');
  await evalJs(`document.querySelector('#stepper [data-step="1"]').click()`);
  await sleep(400);
  await shot('1c-source-dark');

  // phone width: nothing may overflow horizontally
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await scheme('light');
  for (const [step, name] of [['1', '5-phone-source'], ['4', '5b-phone-review'], ['2', '5c-phone-region']]) {
    await evalJs(`document.querySelector('#stepper [data-step="${step}"]').click()`);
    await sleep(700);
    const over = await evalJs(`document.documentElement.scrollWidth - innerWidth`);
    log(`phone overflow step ${step}: ${over}px`);
    if (over > 1) problems.push(`horizontal overflow on step ${step}: ${over}px`);
    await shot(name);
  }

  // reload mid-review: state comes back, and a re-scan does not need the box redrawn
  await desktop();
  await send('Page.reload');
  await waitFor(`!document.getElementById('step4').hidden`, 30000, 'review after reload');
  log('after reload:', await evalJs(`document.getElementById('rvCount').textContent`));
  await evalJs(`document.querySelector('#sensSeg [data-sens="0.75"]').click()`);
  await waitFor(`!document.getElementById('step3').hidden || !document.getElementById('step4').hidden`, 20000, 'rescan started');
  await waitFor(`!document.getElementById('step4').hidden && document.getElementById('stepper').querySelector('[data-step="3"]').disabled`, 300000, 'rescan done');
  log('after rescan at 0.75:', await evalJs(`document.getElementById('rvCount').textContent`));

  // The songsheet library exists for one scenario: loading another video used to
  // destroy the finished songsheet, because the server wipes the work folder.
  // Kept last, because it deliberately loads a second video and reopens a stored
  // sheet — states the earlier checks do not expect.
  await sleep(1500); // let the save settle
  // Ask the database directly, so "nothing on screen" can be told apart from
  // "nothing was ever stored" — those need completely different fixes. The
  // re-scan above finished with a second save, so a correct run still has one
  // record: re-scanning must update a songsheet, not duplicate it.
  const storedCount = await evalJs(`new Promise((resolve) => {
    const req = indexedDB.open('vidtotab');
    req.onerror = () => resolve('open-error');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sheets')) return resolve('no-store');
      const tx = db.transaction('sheets', 'readonly');
      const c = tx.objectStore('sheets').count();
      c.onsuccess = () => resolve(String(c.result));
      c.onerror = () => resolve('count-error');
    };
  })`);
  log('songsheets in IndexedDB:', storedCount);
  if (storedCount !== '1') problems.push(`expected exactly 1 stored songsheet, database reports ${storedCount}`);

  await evalJs(`document.querySelector('#stepper [data-step="1"]').click()`);
  await sleep(800);
  const libShown = await evalJs(`!document.getElementById('librarySection').hidden`);
  const libCount = await evalJs(`document.querySelectorAll('#libraryGrid .lib-card').length`);
  const libTitle = await evalJs(`document.querySelector('#libraryGrid .lib-name')?.textContent || ''`);
  log(`library on the home screen: ${libCount} card(s), shown=${libShown}, first="${libTitle}"`);
  if (libCount < 1) problems.push('a finished songsheet did not appear in the library');
  if (!libShown) problems.push('the library section stayed hidden although a songsheet was saved');
  await shot('6-library');

  // Load a second video — the moment that used to lose everything.
  const doc2 = await send('DOM.getDocument');
  const { nodeId: fileNode2 } = await send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { nodeId: fileNode2, files: [VIDEO] });
  await waitFor(`!document.getElementById('step2').hidden`, 180000, 'second video ready');
  await evalJs(`document.querySelector('#stepper [data-step="1"]').click()`);
  await sleep(800);
  const afterCount = await evalJs(`document.querySelectorAll('#libraryGrid .lib-card').length`);
  log(`library after loading a second video: ${afterCount} card(s), was ${libCount}`);
  if (afterCount < libCount) problems.push(`library lost songsheets when a new video was loaded: ${libCount} -> ${afterCount}`);

  // Reopening must show real pages, not empty frames: the images have to be
  // stored blobs, not links to files the server deleted when the second video
  // arrived. That is the whole point of the feature.
  if (afterCount > 0) {
    await evalJs(`document.querySelector('#libraryGrid .lib-card').click()`);
    await waitFor(`!document.getElementById('step4').hidden`, 20000, 'saved songsheet opens');
    await sleep(1500);
    const reopened = await evalJs(`document.querySelectorAll('.sheet-item').length`);
    const firstSrc = await evalJs(`(document.querySelector('.sheet-item img')?.src || '').slice(0, 5)`);
    const firstLoaded = await evalJs(`(() => { const i = document.querySelector('.sheet-item img'); return i ? (i.complete && i.naturalWidth > 0) : false; })()`);
    log(`reopened songsheet: ${reopened} page(s), src starts "${firstSrc}", image decoded=${firstLoaded}`);
    if (reopened < 1) problems.push('a saved songsheet reopened with no pages');
    if (firstSrc !== 'blob:') problems.push(`saved pages are not blob-backed (src starts "${firstSrc}")`);
    if (!firstLoaded) problems.push('a saved page did not decode — the stored blob is unusable');

    // A stored songsheet has no video behind it, so the steps that need one must
    // stay shut — reaching them showed an empty video stage, which reads as
    // broken rather than as "there is nothing here".
    const stepState = await evalJs(`[...document.querySelectorAll('#stepper button')]
      .map((b) => b.dataset.step + (b.disabled ? ':off' : ':on')).join(' ')`);
    log('stepper with a stored songsheet open:', stepState);
    if (!/2:off/.test(stepState) || !/3:off/.test(stepState)) {
      problems.push(`steps needing a video should be disabled for a stored songsheet: ${stepState}`);
    }
    if (!/4:on/.test(stepState)) problems.push(`the songsheet step should stay reachable: ${stepState}`);
    await shot('6b-library-reopened');

    // ...and that flag must clear when a real video arrives, or the steps stay
    // dead for the rest of the session.
    const doc3 = await send('DOM.getDocument');
    const { nodeId: fileNode3 } = await send('DOM.querySelector', { nodeId: doc3.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { nodeId: fileNode3, files: [VIDEO] });
    await waitFor(`!document.getElementById('step2').hidden`, 180000, 'video after a stored songsheet');
    const stepsBack = await evalJs(`[...document.querySelectorAll('#stepper button')]
      .map((b) => b.dataset.step + (b.disabled ? ':off' : ':on')).join(' ')`);
    log('stepper after loading a video again:', stepsBack);
    if (!/2:on/.test(stepsBack)) problems.push(`the tab-area step stayed disabled after loading a video: ${stepsBack}`);
  }

  // ---------------------------------------------------------------- app view
  // Two front doors onto one document, which is exactly the shape of thing that
  // can ship as dead CSS: a class flips, nothing moves. So every check below
  // reads computed styles and real behaviour, never a class name.
  //
  // #how is also hidden by the app's own `hidden` attribute whenever a video is
  // loaded, so asking for its display would answer "none" in both views and
  // prove nothing. Lift the attribute for the measurement and put it back — the
  // question is what the view's stylesheet does, not what the app did.
  await desktop();
  await scheme('light');
  await evalJs(`document.querySelector('#stepper [data-step="1"]').click()`);
  await sleep(500);
  const viewState = () => evalJs(`(() => {
    const disp = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).display : 'missing'; };
    const how = document.getElementById('how');
    const was = how.hidden;
    how.hidden = false;
    const howDisp = getComputedStyle(how).display;
    how.hidden = was;
    return [document.body.dataset.view, disp('#sidebar'), disp('.hero h1'), disp('.lede'), howDisp,
      document.getElementById('viewToggleLabel').textContent.trim(),
      Math.round(document.getElementById('sidebar').getBoundingClientRect().width)].join('|');
  })()`);

  const [hView, hSide, hH1, hLede, hHow, hLabel] = String(await viewState()).split('|');
  log(`home view -> data-view=${hView} sidebar=${hSide} h1=${hH1} lede=${hLede} how=${hHow} button="${hLabel}"`);
  if (hView !== 'home') problems.push(`the web build should open on the landing page (data-view=${hView})`);
  if (hSide !== 'none') problems.push(`the sidebar is on screen in home view (display ${hSide})`);
  if (hH1 === 'none') problems.push('the landing headline is hidden in home view');
  if (hLede === 'none') problems.push('the landing subheading is hidden in home view');
  if (hHow === 'none') problems.push('the explainer is hidden in home view');
  if (hLabel !== 'Open the app') problems.push(`the toggle does not offer the app view (reads "${hLabel}")`);

  await evalJs(`document.getElementById('viewToggle').click()`);
  await sleep(500);
  const [aView, aSide, aH1, aLede, aHow, aLabel, aWidth] = String(await viewState()).split('|');
  log(`app view -> data-view=${aView} sidebar=${aSide} (${aWidth}px) h1=${aH1} lede=${aLede} how=${aHow} button="${aLabel}"`);
  if (aView !== 'app') problems.push(`the toggle did not enter the app view (data-view=${aView})`);
  if (aSide === 'none') problems.push('the app view has no sidebar');
  if (aH1 !== 'none') problems.push('the marketing headline is still on screen in the app view');
  if (aLede !== 'none') problems.push('the marketing subheading is still on screen in the app view');
  if (aHow !== 'none') problems.push('the explainer is still on screen in the app view');
  if (aLabel !== 'Home') problems.push(`the toggle does not offer the way back (reads "${aLabel}")`);
  if (Number(aWidth) < 180 || Number(aWidth) > 300) problems.push(`the sidebar is not a narrow column: ${aWidth}px`);
  await shot('8-app-view');
  await scheme('dark');
  await sleep(400);
  await shot('8d-app-view-dark');
  await scheme('light');
  await sleep(300);

  // The point of the sidebar: a saved songsheet is reachable from anywhere,
  // instead of only from step 1. Proving that means starting somewhere else —
  // step 4 has to be shut before the click, or "it is open afterwards" is true
  // either way.
  const sideRows = await evalJs(`document.querySelectorAll('#sideList .side-item').length`);
  const sideName = await evalJs(`document.querySelector('#sideList .side-name')?.textContent || ''`);
  const sideEmptyShown = await evalJs(`!document.getElementById('sideEmpty').hidden`);
  log(`sidebar: ${sideRows} songsheet(s), first "${sideName}", empty note shown=${sideEmptyShown}`);
  if (sideRows < 1) problems.push('the sidebar lists no songsheet although one is saved');
  if (!sideName) problems.push('a sidebar songsheet has no title');
  if (sideEmptyShown) problems.push('the sidebar shows its empty note with songsheets in the list');

  const beforeOpen = await evalJs(`document.getElementById('step4').hidden ? 'shut' : 'already open'`);
  if (beforeOpen !== 'shut') problems.push(`cannot prove the sidebar opens a songsheet: step 4 was ${beforeOpen}`);
  await evalJs(`document.querySelector('#sideList .side-item').click()`);
  await waitFor(`!document.getElementById('step4').hidden`, 20000, 'songsheet opened from the sidebar');
  await sleep(1500);
  const openedPages = await evalJs(`document.querySelectorAll('#reviewList .sheet-item').length`);
  const openedCurrent = await evalJs(`(document.querySelector('#sideList .side-item[aria-current="true"] .side-name') || {}).textContent || 'none'`);
  const practiceOff = await evalJs(`document.getElementById('sidePractice').disabled`);
  log(`sidebar opened "${sideName}": ${openedPages} page(s), marked current="${openedCurrent}", practice disabled=${practiceOff}`);
  if (openedPages < 1) problems.push('the sidebar opened a songsheet with no pages');
  if (openedCurrent !== sideName) problems.push(`the open songsheet is not marked in the sidebar (marked "${openedCurrent}")`);
  if (practiceOff) problems.push('sidebar Practice stayed disabled with a songsheet open');

  // Phone width, app view: the sidebar has to fall under the workspace rather
  // than push it off the side.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  for (const [step, name] of [['4', '8b-phone-app-review'], ['1', '8c-phone-app-source']]) {
    await evalJs(`document.querySelector('#stepper [data-step="${step}"]').click()`);
    await sleep(700);
    const over = await evalJs(`document.documentElement.scrollWidth - innerWidth`);
    log(`app view phone overflow step ${step}: ${over}px`);
    if (over > 1) problems.push(`horizontal overflow in the app view on step ${step}: ${over}px`);
    await shot(name);
  }
  const stackedBelow = await evalJs(`(() => {
    const s = document.getElementById('sidebar').getBoundingClientRect();
    const m = document.querySelector('main').getBoundingClientRect();
    return (s.top >= m.top + m.height - 2) ? 'below' : 'beside';
  })()`);
  log('sidebar at phone width sits', stackedBelow, 'the workspace');
  if (stackedBelow !== 'below') problems.push(`the sidebar did not collapse under the workspace at phone width (${stackedBelow})`);

  // "New scan" has to put the songsheet down, not just change step: leaving it
  // loaded is how a stored sheet's title ends up on the source card as though a
  // video were ready.
  await desktop();
  await sleep(400);
  await evalJs(`document.getElementById('sideNew').click()`);
  await sleep(700);
  const afterNew = await evalJs(`[
    document.getElementById('step1').hidden ? 'not-step1' : 'step1',
    document.getElementById('sidePractice').disabled,
    document.getElementById('sidePracticeWhy').hidden,
    document.querySelectorAll('#reviewList .sheet-item').length,
    document.querySelectorAll('#sideList .side-item[aria-current="true"]').length].join('|')`);
  const [nStep, nPracticeOff, nWhyHidden, nRows, nCurrent] = String(afterNew).split('|');
  log(`after "New scan" -> ${nStep}, practice disabled=${nPracticeOff}, reason hidden=${nWhyHidden}, ${nRows} page rows, ${nCurrent} marked current`);
  if (nStep !== 'step1') problems.push(`"New scan" did not go back to the first step (${nStep})`);
  if (nRows !== '0') problems.push(`"New scan" left ${nRows} page(s) of the old songsheet loaded`);
  if (nCurrent !== '0') problems.push('"New scan" left a songsheet marked open in the sidebar');
  if (nPracticeOff !== 'true') problems.push('sidebar Practice stayed enabled with no songsheet open');
  if (nWhyHidden !== 'false') problems.push('sidebar Practice is disabled without saying why');

  // ...and back. The landing page has to come back whole, not as a stripped app
  // view wearing its name.
  await evalJs(`document.getElementById('viewToggle').click()`);
  await sleep(500);
  const [bView, bSide, bH1, bLede, bHow, bLabel] = String(await viewState()).split('|');
  log(`back home -> data-view=${bView} sidebar=${bSide} h1=${bH1} lede=${bLede} how=${bHow} button="${bLabel}"`);
  if (bView !== 'home') problems.push(`the toggle did not return to the landing page (data-view=${bView})`);
  if (bSide !== 'none') problems.push(`the sidebar stayed on screen after returning home (display ${bSide})`);
  if (bH1 === 'none' || bLede === 'none' || bHow === 'none') {
    problems.push(`the landing page came back stripped (h1=${bH1} lede=${bLede} how=${bHow})`);
  }
  if (bLabel !== 'Open the app') problems.push(`the toggle did not reset its label (reads "${bLabel}")`);

  // The choice has to outlive the tab. Checked after a real reload rather than
  // by reading localStorage, because writing the key and never reading it back
  // would pass that weaker test.
  await evalJs(`document.getElementById('viewToggle').click()`);
  await sleep(400);
  await send('Page.reload');
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('viewToggle')`, 20000, 'reload in app view');
  await sleep(700);
  const reloadView = await evalJs(`document.body.dataset.view`);
  const reloadLabel = await evalJs(`document.getElementById('viewToggleLabel').textContent.trim()`);
  const reloadSide = await evalJs(`getComputedStyle(document.getElementById('sidebar')).display`);
  log(`after reload -> data-view=${reloadView}, button="${reloadLabel}", sidebar=${reloadSide}`);
  if (reloadView !== 'app') problems.push(`the app view did not survive a reload (data-view=${reloadView})`);
  if (reloadLabel !== 'Home') problems.push(`the toggle came back out of step with the view (reads "${reloadLabel}")`);
  if (reloadSide === 'none') problems.push('the app view came back after a reload with no sidebar');

  // A downloaded app should not show a landing page every launch — and the web
  // build must not be dragged along with it. Both halves are checked by faking
  // the preload bridge the desktop build injects, with the remembered choice
  // cleared so the default is what decides.
  const forgetView = `(() => { try { localStorage.removeItem('vtt.view'); } catch { /* no storage */ } return 'ok'; })()`;
  await evalJs(forgetView);
  const { identifier: shellScript } = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.vidtotab = { shell: 'desktop', platform: 'darwin' };`,
  });
  await send('Page.reload');
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('viewToggle')`, 20000, 'reload as the desktop app');
  await sleep(600);
  const desktopDefault = await evalJs(`document.body.dataset.view + '/' + (window.vidtotab ? window.vidtotab.shell : 'no-bridge')`);
  log('desktop shell, nothing remembered ->', desktopDefault);
  if (desktopDefault !== 'app/desktop') problems.push(`the desktop app should start in the app view (got ${desktopDefault})`);

  await evalJs(forgetView);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: shellScript });
  await send('Page.reload');
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('viewToggle')`, 20000, 'reload as the web build');
  await sleep(600);
  const webDefault = await evalJs(`document.body.dataset.view + '/' + (window.vidtotab ? window.vidtotab.shell : 'no-bridge')`);
  log('web build, nothing remembered ->', webDefault);
  if (webDefault !== 'home/no-bridge') problems.push(`the web build should still open on the landing page (got ${webDefault})`);
} catch (e) {
  failure = e;
  log('E2E FAILED:', e.message);
  await shot('zz-failure').catch(() => {});
} finally {
  log('page problems:', problems.length ? problems : 'none');
  try { ws.close(); } catch { /* already closed */ }
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  const ok = !failure && problems.length === 0;
  log(ok ? 'E2E PASSED' : 'E2E FAILED', `— output in ${OUT}`);
  if (ok && !KEEP) fs.rmSync(path.join(OUT, 'profile'), { recursive: true, force: true });
  setTimeout(() => process.exit(ok ? 0 : 1), 500);
}
