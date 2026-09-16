// Pipeline orchestrator.
//   calibrate  keyframe samples of the crop -> polarity, staff spacing, contrast
//   decode     ffmpeg fps=4 + crop -> half-res top-hat ink planes -> frames.ink
//   pass 1     majority-filtered ink masks -> runs -> pages (analyze, assemble)
//   pass 2     one sequential decode of the sample frames -> clean + color PNGs
// Public API: runPipeline(videoPath, opts, onProgress), cancelPipeline().
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodePng, killAllChildren, probeVideo, rawFrames } from './ffmpeg.js';
import { FPS, inkPass1, knobs } from './analyze.js';
import { assemblePages } from './assemble.js';
import { pickSampleFrames, renderClean, renderColor } from './composite.js';
import { calibrateCrop } from './detect.js';
import { inkHalf, localGain, suppressTintedBars, topHat } from './ink.js';

const CACHE_VERSION = 3;
const K_SAMPLES = 11;
const FALLBACK_INTERVAL = 4;

let current = null;

export function cancelPipeline() {
  if (current) current.cancelled = true;
  killAllChildren();
}

export async function runPipeline(videoPath, opts, onProgress = () => {}) {
  const job = { cancelled: false };
  current = job;
  try {
    return await run(videoPath, opts, onProgress, job);
  } catch (e) {
    if (job.cancelled) e.cancelled = true;
    throw e;
  } finally {
    if (current === job) current = null;
  }
}

function userErr(msg) {
  const e = new Error(msg);
  e.userMsg = msg;
  return e;
}

function validate(videoPath, opts) {
  if (typeof videoPath !== 'string' || videoPath === '') throw userErr('Missing video path');
  const { crop, startTime, endTime, workDir } = opts ?? {};
  if (!crop || ![crop.x, crop.y, crop.w, crop.h].every(Number.isInteger)
    || crop.x < 0 || crop.y < 0 || crop.w < 16 || crop.h < 16) {
    throw userErr('Invalid crop rectangle');
  }
  if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime < 0) {
    throw userErr('Invalid start time');
  }
  if (endTime != null && (typeof endTime !== 'number' || endTime <= startTime)) {
    throw userErr('Invalid end time');
  }
  if (typeof workDir !== 'string' || !path.isAbsolute(workDir)) {
    throw userErr('workDir must be an absolute path');
  }
}

const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function run(videoPath, opts, onProgress, job) {
  validate(videoPath, opts);
  const { crop, startTime, endTime = null, sensitivity = 0.5, workDir, polarity = null, allowFallback = false } = opts;
  await mkdir(workDir, { recursive: true });
  const w = crop.w & ~1, h = crop.h & ~1; // server guarantees even; floor defensively
  const w2 = w >> 1, h2 = h >> 1;
  const inkPath = path.join(workDir, 'frames.ink');
  const metaPath = path.join(workDir, 'frames.json');
  const checkCancel = () => {
    if (job.cancelled) throw userErr('Cancelled');
  };
  const st = await stat(videoPath).catch(() => null);
  if (st === null) throw userErr('The video file is missing');

  // ---- calibrate + decode (skipped when the cache matches: sensitivity re-runs)
  const wanted = {
    version: CACHE_VERSION, w2, h2, fps: FPS, startTime, endTime,
    crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
    video: { size: st.size, mtimeMs: Math.round(st.mtimeMs) },
  };
  let cache = await loadCacheMeta(metaPath, inkPath, wanted);
  if (cache === null) {
    onProgress({ phase: 'analyze', pct: 0, msg: 'calibrating' });
    const info = await probeVideo(videoPath);
    const calib = await calibrateCrop(videoPath, { x: crop.x, y: crop.y, w, h },
      { startTime, endTime, duration: info?.duration ?? null, polarity });
    checkCancel();
    cache = await decodeToCache(videoPath, wanted, calib, { w, h, inkPath, metaPath, duration: info?.duration ?? null },
      onProgress, checkCancel);
  } else {
    onProgress({ phase: 'analyze', pct: 90, msg: 'using cached frames' });
  }
  const { frameCount, calib } = cache;

  // ---- pass 1
  const makeFrames = () => inkFrameReader(inkPath, w2 * h2, frameCount, checkCancel);
  const p1 = await inkPass1(makeFrames, w2, h2, {
    frameCount, calib, sensitivity,
    onPct: (f) => onProgress({ phase: 'analyze', pct: Math.min(99, 90 + 10 * f), msg: 'finding screens' }),
  });
  checkCancel();
  if (p1.hotFrac > 0.6) {
    onProgress({ phase: 'warning', msg: 'Most of this region is moving video, not tab — adjust the region if the results look wrong.' });
  }
  onProgress({ phase: 'analyze', pct: 100 });

  const { pages, dropped } = assemblePages(p1.runs, {
    w: w2, h: h2, knobs: knobs(sensitivity), inkFloor: p1.inkFloor, dH: calib.dH, fps: FPS, startTime,
    hasStaff: Boolean(calib.staff), staff: calib.staff,
  });
  const debug = {
    calib, frames: p1.frames, runs: p1.runs.length, hotFrac: round3(p1.hotFrac), staticFrac: round3(p1.staticFrac), zoneFrac: round3(p1.zoneFrac ?? 0), dropped,
  };
  const ctx = { crop, w, h, startTime, endTime, workDir, calib, debug };
  if (pages.length === 0) {
    // Say so rather than inventing pages. A video with no tab on screen used to
    // become one "page" every 4 s — about 150 of them for a 10-minute cover,
    // each costing two ffmpeg processes — which reads as a working scan and
    // buries the real answer. The timed capture is now an explicit choice.
    if (!allowFallback) {
      onProgress({
        phase: 'warning',
        msg: p1.runs.length
          ? 'No tab screens were recognised in this area. Check that the box covers the tab, or try More pages.'
          : 'Nothing in this area holds still long enough to be a tab screen. Check that the box covers the tab.',
      });
      await writeFile(path.join(workDir, 'manifest.json'), JSON.stringify({ captures: [], debug: { ...debug, noPages: true } }, null, 2));
      return [];
    }
    onProgress({
      phase: 'warning',
      msg: p1.runs.length
        ? 'No tab screens recognised in this region — showing a capture every 4 s instead.'
        : 'The tab never holds still in this region — showing a capture every 4 s instead.',
    });
    return fallbackCaptures(videoPath, ctx, onProgress, checkCancel);
  }
  return renderPages(videoPath, pages, ctx, onProgress, checkCancel);
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---- pass 2: decode once, collect each page's sample frames, render as each
// page completes (captures stream to the UI; memory stays bounded).
async function renderPages(videoPath, pages, { crop, w, h, startTime, endTime, workDir, calib, debug }, onProgress, checkCancel) {
  const plan = pages.map((page) => ({ page, frames: pickSampleFrames(page.candidates, K_SAMPLES), samples: [] }));
  const users = new Map();
  plan.forEach((p, i) => {
    for (const f of p.frames) {
      if (!users.has(f)) users.set(f, []);
      users.get(f).push(i);
    }
  });
  const lastNeeded = Math.max(...users.keys());
  const remaining = plan.map((p) => p.frames.length);
  // Run-unique filename prefix: a sensitivity re-run that gets cancelled
  // midway must not overwrite the previous run's PNGs (the UI keeps showing
  // them, and exports read these files by name).
  const runTag = Date.now().toString(36);
  const captures = [];

  const finish = async (i) => {
    const p = plan[i];
    const samples = p.samples;
    p.samples = null;
    if (!samples || samples.length === 0) return;
    const clean = renderClean(samples, w, h, calib);
    const color = renderColor(samples, w, h, calib);
    const id = `cap-${String(i).padStart(3, '0')}`;
    const png = `${runTag}-${id}.png`, pngColor = `${runTag}-${id}-color.png`;
    await encodePng(clean, w, h, path.join(workDir, png), 'gray');
    await encodePng(color.rgb, w, h, path.join(workDir, pngColor));
    const cap = {
      id, type: 'page', png, pngColor, w, h,
      tStart: p.page.tStart, tEnd: p.page.tEnd, alsoAt: p.page.alsoAt, samples: samples.length,
    };
    captures.push(cap);
    onProgress({ phase: 'capture', capture: cap });
  };

  // Identical input seek + filter chain as the decode pass, so frame t here is
  // exactly pass-1 frame t.
  const vf = `fps=${FPS},crop=${w}:${h}:${crop.x}:${crop.y},format=rgb24`;
  let t = 0;
  for await (const frame of rawFrames(videoPath, { ss: startTime, to: endTime ?? undefined, vf, frameBytes: 3 * w * h, maxFrames: lastNeeded + 1 })) {
    checkCancel();
    const us = users.get(t);
    if (us) {
      for (const i of us) {
        plan[i].samples.push(frame);
        if (--remaining[i] === 0) await finish(i);
      }
    }
    if (t % 20 === 0) {
      onProgress({ phase: 'composite', pct: Math.min(99, (100 * t) / (lastNeeded + 1)), msg: `${captures.length} of ${plan.length} pages rendered` });
    }
    t++;
  }
  for (let i = 0; i < plan.length; i++) if (plan[i].samples !== null) await finish(i); // decode came up short
  checkCancel();
  captures.sort((a, b) => a.tStart - b.tStart);
  await writeFile(path.join(workDir, 'manifest.json'), JSON.stringify({ captures, debug }, null, 2));
  onProgress({ phase: 'composite', pct: 100 });
  return captures;
}

async function loadCacheMeta(metaPath, inkPath, wanted) {
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
  for (const key of ['version', 'w2', 'h2', 'fps', 'startTime', 'endTime', 'crop', 'video']) {
    if (JSON.stringify(meta?.[key] ?? null) !== JSON.stringify(wanted[key] ?? null)) return null;
  }
  if (!Number.isInteger(meta.frameCount) || meta.frameCount < 1 || !meta.calib) return null;
  try {
    const st = await stat(inkPath);
    if (st.size !== meta.frameCount * wanted.w2 * wanted.h2) return null;
  } catch {
    return null;
  }
  return meta;
}

async function decodeToCache(videoPath, wanted, calib, { w, h, inkPath, metaPath, duration }, onProgress, checkCancel) {
  const { startTime, endTime, crop, w2, h2 } = wanted;
  // Invalidate the old meta BEFORE truncating the cache: a cancel/crash
  // mid-decode must never leave a meta describing different pixels. Meta is
  // re-written only after a complete decode.
  await rm(metaPath, { force: true });
  await rm(path.join(path.dirname(inkPath), 'frames.gray'), { force: true }); // v1 cache
  const end = endTime ?? duration;
  const expected = end != null && end > startTime ? Math.max(1, (end - startTime) * FPS) : null;
  const vf = `fps=${FPS},crop=${w}:${h}:${crop.x}:${crop.y},format=rgb24`;
  const P = w2 * h2;
  const e = new Uint8Array(P), th = new Uint8Array(P), tmp = new Uint8Array(P);
  const out = createWriteStream(inkPath);
  // Without a listener, an fs error (ENOSPC) is an unhandled 'error' event and
  // kills the whole server process.
  let outErr = null, wakeup = null;
  out.on('error', (err) => { outErr = err; if (wakeup) wakeup(); });
  let count = 0;
  try {
    for await (const frame of rawFrames(videoPath, { ss: startTime, to: endTime ?? undefined, vf, frameBytes: 3 * w * h })) {
      checkCancel();
      if (outErr) break;
      inkHalf(frame, w, h, calib.polarity, e);
      topHat(e, w2, h2, calib.rH, th, tmp);
      const g = localGain(th, w2, h2, calib.rH, calib.C, new Uint8Array(P), tmp); // fresh: write() is async
      suppressTintedBars(g, frame, w, h, 2, calib.dH); // parked cursors, clipped highlight slivers
      if (!out.write(g)) {
        await new Promise((r) => { wakeup = r; out.once('drain', r); }); // error also wakes us
        wakeup = null;
      }
      count++;
      if (count % 25 === 0) {
        const pct = expected ? Math.min(89, (count / expected) * 89) : Math.min(89, count / 40);
        onProgress({ phase: 'analyze', pct, msg: `scanned ${fmtT(count / FPS)}` });
      }
    }
  } finally {
    // An errored stream has already auto-destroyed and emitted 'close';
    // waiting for another one would hang the job in "analyzing" forever.
    if (!out.closed) await new Promise((r) => { out.once('close', r); out.end(); });
  }
  checkCancel();
  if (outErr) throw userErr(`Could not write frame cache: ${outErr.message}`);
  if (count === 0) throw userErr('No frames decoded — check the crop and start time');
  const meta = { ...wanted, frameCount: count, calib };
  await writeFile(metaPath, JSON.stringify(meta)); // written last: no partial cache
  return meta;
}

async function* inkFrameReader(inkPath, frameBytes, frameCount, checkCancel) {
  const fh = await open(inkPath, 'r');
  try {
    for (let i = 0; i < frameCount; i++) {
      checkCancel();
      const buf = new Uint8Array(frameBytes); // fresh buffer: consumers keep frames
      const { bytesRead } = await fh.read(buf, 0, frameBytes, i * frameBytes);
      if (bytesRead < frameBytes) return;
      yield buf;
    }
  } finally {
    await fh.close();
  }
}

// No usable screens: fixed-interval single-frame captures, still rendered
// through both looks so review and export behave the same.
async function fallbackCaptures(videoPath, { crop, startTime, endTime, w, h, workDir, calib, debug }, onProgress, checkCancel) {
  const end = endTime ?? (await probeVideo(videoPath))?.duration ?? null;
  const expected = end != null && end > startTime ? Math.ceil((end - startTime) / FALLBACK_INTERVAL) : null;
  const vf = `crop=${w}:${h}:${crop.x}:${crop.y},fps=${1 / FALLBACK_INTERVAL},format=rgb24`;
  const runTag = Date.now().toString(36); // see renderPages(): never clobber a prior run's PNGs
  const captures = [];
  let i = 0;
  for await (const frame of rawFrames(videoPath, { ss: startTime, to: endTime ?? undefined, vf, frameBytes: 3 * w * h })) {
    checkCancel();
    const id = `cap-${String(i).padStart(3, '0')}`;
    const png = `${runTag}-${id}.png`, pngColor = `${runTag}-${id}-color.png`;
    await encodePng(renderClean([frame], w, h, calib), w, h, path.join(workDir, png), 'gray');
    await encodePng(frame, w, h, path.join(workDir, pngColor));
    const t = startTime + i * FALLBACK_INTERVAL;
    const cap = { id, type: 'page', png, pngColor, w, h, tStart: t, tEnd: t + FALLBACK_INTERVAL, alsoAt: [], samples: 1 };
    captures.push(cap);
    onProgress({ phase: 'capture', capture: cap });
    const pct = expected ? Math.min(99, ((i + 1) / expected) * 100) : Math.min(95, (i + 1) * 5);
    onProgress({ phase: 'composite', pct });
    i++;
  }
  await writeFile(path.join(workDir, 'manifest.json'), JSON.stringify({ captures, debug: { ...debug, fallback: true } }, null, 2));
  onProgress({ phase: 'composite', pct: 100 });
  return captures;
}

// ------------------------------------------------------------ self-check
// End-to-end on a synthetic lossless video in the vvxo style: dark panel,
// six staff lines, three screens shown A B C A, a translucent blue measure
// highlight jumping every second and an orange cursor sweeping every frame.
async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const { mkdtemp, rm: rmP, stat: statP, utimes } = await import('node:fs/promises');
  const os = await import('node:os');
  const { spawn } = await import('node:child_process');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'vidtotab-index-'));
  try {
    const W = 320, H = 120, PER = 16;
    const rows = [30, 42, 54, 66, 78, 90];
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const digitsFor = (s) => {
      seed = s;
      return Array.from({ length: 16 }, () => [24 + Math.floor(rnd() * 270), rows[Math.floor(rnd() * 6)] - 4]);
    };
    const screens = [digitsFor(11), digitsFor(22), digitsFor(33)];
    const order = [0, 1, 2, 0];
    const frame = (si, k) => {
      const f = Buffer.alloc(W * H * 3);
      for (let i = 0; i < W * H; i++) { f[3 * i] = 20; f[3 * i + 1] = 20; f[3 * i + 2] = 24; }
      const put = (x0, y0, x1, y1, c, a = 1) => {
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const j = 3 * (y * W + x);
            for (let ch = 0; ch < 3; ch++) f[j + ch] = Math.round(a * c[ch] + (1 - a) * f[j + ch]);
          }
        }
      };
      for (const y of rows) put(20, y, 300, y + 2, [170, 170, 170]);
      for (const [x, y] of screens[si]) put(x, y, x + 5, y + 9, [235, 235, 235]);
      const m = Math.floor(k / 4) % 4;
      put(20 + 70 * m, 20, 90 + 70 * m, 100, [40, 110, 220], 0.45);
      const cx = 20 + ((k * 17) % 277);
      put(cx, 18, cx + 3, 102, [255, 140, 0]);
      return f;
    };
    const videoPath = path.join(dir, 'test.mkv');
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
        '-c:v', 'ffv1', videoPath], { stdio: ['pipe', 'ignore', 'inherit'] }); // ffv1: lossless, intra-only
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg encode exit ${code}`))));
      for (const si of order) for (let k = 0; k < PER; k++) child.stdin.write(frame(si, k));
      child.stdin.end();
    });

    const workDir = path.join(dir, 'work');
    const opts = { crop: { x: 0, y: 0, w: W, h: H }, startTime: 0, sensitivity: 0.5, workDir };
    const events = [];
    const captures = await runPipeline(videoPath, opts, (ev) => events.push(ev));
    const manifest0 = JSON.parse(await readFile(path.join(workDir, 'manifest.json'), 'utf8'));
    assert.equal(captures.length, 3, `expected 3 screens, got ${JSON.stringify(captures.map((c) => [c.tStart, c.tEnd, c.alsoAt]))} ${JSON.stringify(manifest0.debug)}`);
    captures.forEach((c, i) => assert.ok(Math.abs(c.tStart - 4 * i) <= 1, `capture ${i} tStart ${c.tStart}`));
    assert.equal(captures[0].alsoAt.length, 1, 'the repeat of screen A must be folded into alsoAt');
    assert.ok(Math.abs(captures[0].alsoAt[0] - 12) <= 1);
    assert.ok(events.some((e) => e.phase === 'capture') && events.some((e) => e.phase === 'analyze' && e.pct === 100));

    const decode = async (file, fmt, bpp) => {
      for await (const f of rawFrames(path.join(workDir, file), { vf: `format=${fmt}`, frameBytes: W * H * bpp })) return f;
      return null;
    };
    // Clean print: row 48 lies between staff lines and clear of digits, but the
    // highlight and cursor cross it — it must come out paper white.
    const clean = await decode(captures[0].png, 'gray', 1);
    let dirty = 0;
    for (let x = 0; x < W; x++) if (clean[48 * W + x] < 230) dirty++;
    assert.ok(dirty <= 3, `highlight/cursor residue in clean print: ${dirty}px`);
    assert.equal(clean[5 * W + 5], 255);
    const [dx, dy] = screens[0][0];
    assert.ok(clean[(dy + 4) * W + dx + 2] < 110, 'digits must print dark');
    assert.ok(clean[30 * W + 150] < 170 || clean[31 * W + 150] < 170, 'staff lines must print');
    // Color: the same row keeps the panel color, no blue or orange left.
    const color = await decode(captures[0].pngColor, 'rgb24', 3);
    let tinted = 0;
    for (let x = 0; x < W; x++) {
      const j = 3 * (48 * W + x);
      if (Math.max(color[j], color[j + 1], color[j + 2]) - Math.min(color[j], color[j + 1], color[j + 2]) > 40) tinted++;
    }
    assert.ok(tinted <= 3, `highlight/cursor residue in color render: ${tinted}px`);

    const manifest = JSON.parse(await readFile(path.join(workDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.captures.map((c) => c.id), captures.map((c) => c.id));

    // Re-run at another sensitivity reuses frames.ink; touching the video invalidates it.
    const inkFile = path.join(workDir, 'frames.ink');
    const before = (await statP(inkFile)).mtimeMs;
    const again = await runPipeline(videoPath, { ...opts, sensitivity: 0.25 }, () => {});
    assert.equal(again.length, 3);
    assert.equal((await statP(inkFile)).mtimeMs, before, 'cache must be reused');
    const later = new Date(Date.now() + 5000);
    await utimes(videoPath, later, later);
    await runPipeline(videoPath, opts, () => {});
    assert.notEqual((await statP(inkFile)).mtimeMs, before, 'changed video must invalidate the cache');

    // Cancellation rejects with .cancelled.
    const p = runPipeline(videoPath, { ...opts, workDir: path.join(dir, 'work2') }, () => {});
    cancelPipeline();
    await assert.rejects(p, (e) => e.cancelled === true);

    // A region with no tab says so instead of inventing pages. Capturing on a
    // timer regardless turned a video with no tab on screen into one "page"
    // every 4 s — about 150 of them for a 10-minute cover — which reads as a
    // successful scan. The timed capture now happens only when asked for.
    const blank = path.join(dir, 'blank.mkv');
    await new Promise((resolve, reject) => {
      const c = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'color=c=black:s=320x120:d=6:r=10', '-c:v', 'ffv1', blank], { stdio: 'ignore' });
      c.once('error', reject);
      c.once('close', (code) => (code === 0 ? resolve() : reject(new Error('blank encode failed'))));
    });
    const blankOpts = { crop: { x: 0, y: 0, w: 320, h: 120 }, startTime: 0, sensitivity: 0.5 };
    const blankWarnings = [];
    const none = await runPipeline(blank, { ...blankOpts, workDir: path.join(dir, 'blankA') },
      (ev) => { if (ev.phase === 'warning') blankWarnings.push(ev.msg); });
    assert.equal(none.length, 0, 'a region with no tab must report nothing, not invent pages');
    const blankManifest = JSON.parse(await readFile(path.join(dir, 'blankA', 'manifest.json'), 'utf8'));
    assert.equal(blankManifest.captures.length, 0, 'the manifest must still be written, with no captures');
    assert.equal(blankManifest.debug.noPages, true);
    assert.ok(blankWarnings.some((m) => /no tab screens were recognised/i.test(m)),
      `expected a "no tab screens" warning, got: ${blankWarnings.join(' | ') || '(none)'}`);
    const timed = await runPipeline(blank, { ...blankOpts, workDir: path.join(dir, 'blankB'), allowFallback: true }, () => {});
    assert.ok(timed.length > 0, 'allowFallback must still give a timed capture when it is asked for');
  } finally {
    await rmP(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
