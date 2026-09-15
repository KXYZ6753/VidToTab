// Pipeline orchestrator: pass 1 (decode -> frames.gray cache -> segmentation),
// pass 2 (per-run temporal medians), assembly, PNG + manifest output.
// Public API per contracts.md: runPipeline(videoPath, opts, onProgress), cancelPipeline().
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rawFrames, encodePng, probeDuration, killAllChildren } from './ffmpeg.js';
import { FPS, downsample2x, pass1 } from './analyze.js';
import { pickK, pickSampleTimes, medianComposite, splitHomogeneous, toGray } from './composite.js';
import { assemble } from './assemble.js';

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

async function run(videoPath, opts, onProgress, job) {
  validate(videoPath, opts);
  const { crop, startTime, endTime = null, sensitivity = 0.5, workDir } = opts;
  await mkdir(workDir, { recursive: true });
  const w = crop.w & ~1, h = crop.h & ~1; // server guarantees even; floor defensively
  const w2 = w >> 1, h2 = h >> 1;
  const grayPath = path.join(workDir, 'frames.gray');
  const metaPath = path.join(workDir, 'frames.json');
  const checkCancel = () => {
    if (job.cancelled) throw userErr('Cancelled');
  };

  // ---- pass 1: half-res gray cache (decode only when the cache doesn't match)
  const wanted = { w2, h2, fps: FPS, startTime, endTime, crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
  let cache = await loadCacheMeta(metaPath, grayPath, wanted);
  if (!cache) {
    cache = await decodeToCache(videoPath, wanted, { w, h, grayPath, metaPath }, onProgress, checkCancel);
  } else {
    onProgress({ phase: 'analyze', pct: 90, msg: 'using cached frames' });
  }
  const { frameCount } = cache;

  const makeFrames = () => grayFrameReader(grayPath, w2 * h2, frameCount, checkCancel);
  const p1 = await pass1(makeFrames, w2, h2, {
    sensitivity,
    frameCount,
    onPct: (f) => onProgress({ phase: 'analyze', pct: Math.min(100, 90 + 10 * f) }),
  });
  checkCancel();
  if (p1.webcamWarned) {
    onProgress({
      phase: 'warning',
      msg: 'Constantly-moving region detected (webcam?) — excluded from change detection; consider redrawing the crop.',
    });
  }
  onProgress({ phase: 'analyze', pct: 100 });

  if (p1.runs.length === 0) {
    onProgress({ phase: 'warning', msg: 'No stable frames found — falling back to fixed-interval captures every 4 s.' });
    return fallbackCaptures(videoPath, { crop, startTime, endTime, w, h, workDir }, onProgress, checkCancel);
  }

  // ---- pass 2: K-frame temporal median per run, homogeneity-split as needed
  const composites = [];
  for (let r = 0; r < p1.runs.length; r++) {
    checkCancel();
    const runSeg = p1.runs[r];
    const tS = startTime + runSeg.startF / FPS;
    const tE = startTime + runSeg.endF / FPS;
    const K = pickK(runSeg.nFrames);
    const times = pickSampleTimes(tS, tE, K, FPS);
    const frames = await grabRgbFrames(videoPath, times, crop, w, h);
    checkCancel();
    if (frames.length === 0) continue;
    const grays = frames.map(toGray);
    for (const [a, b] of splitHomogeneous(grays)) {
      composites.push({
        rgb: medianComposite(frames.slice(a, b + 1)),
        gray: medianComposite(grays.slice(a, b + 1)),
        tStart: a === 0 ? tS : times[a],
        tEnd: b === frames.length - 1 ? tE : times[b],
      });
    }
    onProgress({ phase: 'composite', pct: ((r + 1) / p1.runs.length) * 80 });
  }
  if (composites.length === 0) {
    onProgress({ phase: 'warning', msg: 'No composites could be extracted — falling back to fixed-interval captures.' });
    return fallbackCaptures(videoPath, { crop, startTime, endTime, w, h, workDir }, onProgress, checkCancel);
  }

  // ---- assembly + output
  onProgress({ phase: 'composite', pct: 80, msg: 'assembling' });
  const drafts = assemble(composites, { w, h, maskHalf: p1.excludeMask });
  // Run-unique filename prefix: a sensitivity re-run that gets cancelled
  // midway must not have overwritten the previous run's PNGs (the UI restores
  // the old capture list on cancel, and exports read these files by name).
  const runTag = Date.now().toString(36);
  const captures = [];
  for (let i = 0; i < drafts.length; i++) {
    checkCancel();
    const d = drafts[i];
    const id = `cap-${String(i).padStart(3, '0')}`;
    const png = `${runTag}-${id}.png`;
    await encodePng(d.rgb, d.w, d.h, path.join(workDir, png));
    const cap = { id, type: d.type, png, w: d.w, h: d.h, tStart: d.tStart, tEnd: d.tEnd, alsoAt: d.alsoAt };
    captures.push(cap);
    onProgress({ phase: 'capture', capture: cap });
    onProgress({ phase: 'composite', pct: 80 + ((i + 1) / drafts.length) * 20 });
  }
  await writeFile(path.join(workDir, 'manifest.json'), JSON.stringify({ captures }, null, 2));
  onProgress({ phase: 'composite', pct: 100 });
  return captures;
}

async function loadCacheMeta(metaPath, grayPath, wanted) {
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
  const c = meta?.crop;
  if (!c || meta.w2 !== wanted.w2 || meta.h2 !== wanted.h2 || meta.fps !== wanted.fps
    || meta.startTime !== wanted.startTime || (meta.endTime ?? null) !== wanted.endTime
    || c.x !== wanted.crop.x || c.y !== wanted.crop.y || c.w !== wanted.crop.w || c.h !== wanted.crop.h
    || !Number.isInteger(meta.frameCount) || meta.frameCount < 1) {
    return null;
  }
  try {
    const st = await stat(grayPath);
    if (st.size !== meta.frameCount * wanted.w2 * wanted.h2) return null;
  } catch {
    return null;
  }
  return meta;
}

async function decodeToCache(videoPath, wanted, { w, h, grayPath, metaPath }, onProgress, checkCancel) {
  const { startTime, endTime, crop, w2, h2 } = wanted;
  // Invalidate the old meta BEFORE truncating frames.gray: a cancel/crash
  // mid-decode must never leave a meta describing different pixels — if the
  // new decode has the same byte size, a later run would silently analyze the
  // wrong crop. Meta is re-written only after a complete decode.
  await rm(metaPath, { force: true });
  const end = endTime ?? await probeDuration(videoPath);
  const expected = end != null && end > startTime ? Math.max(1, (end - startTime) * FPS) : null;
  const vf = `crop=${w}:${h}:${crop.x}:${crop.y},fps=${FPS},format=gray`;
  const out = createWriteStream(grayPath);
  // Without a listener, an fs error (ENOSPC on a GB-scale cache) is an
  // unhandled 'error' event and kills the whole server process.
  let outErr = null;
  let wakeup = null;
  out.on('error', (e) => { outErr = e; if (wakeup) wakeup(); });
  let count = 0;
  try {
    for await (const frame of rawFrames(videoPath, { ss: startTime, to: endTime ?? undefined, vf, frameBytes: w * h })) {
      checkCancel();
      if (outErr) break;
      const half = downsample2x(frame, w, h);
      if (!out.write(Buffer.from(half.buffer, half.byteOffset, half.length))) {
        await new Promise((r) => { wakeup = r; out.once('drain', r); }); // error also wakes us
        wakeup = null;
      }
      count++;
      if (count % 25 === 0) {
        const pct = expected ? Math.min(89, (count / expected) * 90) : Math.min(89, count / 40);
        onProgress({ phase: 'analyze', pct, msg: `decoded ${count} frames` });
      }
    }
  } finally {
    await new Promise((r) => { out.once('close', r); out.end(); }); // 'close' fires on finish AND destroy
  }
  checkCancel();
  if (outErr) throw userErr(`Could not write frame cache: ${outErr.message}`);
  if (count === 0) throw userErr('No frames decoded — check the crop and start time');
  const meta = { ...wanted, frameCount: count };
  await writeFile(metaPath, JSON.stringify(meta)); // written last: no partial cache
  return meta;
}

async function* grayFrameReader(grayPath, frameBytes, frameCount, checkCancel) {
  const fh = await open(grayPath, 'r');
  try {
    for (let i = 0; i < frameCount; i++) {
      checkCancel();
      const buf = new Uint8Array(frameBytes); // fresh buffer: consumer keeps prev frame
      const { bytesRead } = await fh.read(buf, 0, frameBytes, i * frameBytes);
      if (bytesRead < frameBytes) return;
      yield buf;
    }
  } finally {
    await fh.close();
  }
}

async function grabRgbFrames(videoPath, times, crop, w, h) {
  const K = times.length;
  const frameBytes = 3 * w * h;
  const cropVf = `crop=${w}:${h}:${crop.x}:${crop.y}`;
  const frames = [];
  if (K === 1) {
    for await (const f of rawFrames(videoPath, { ss: times[0], vf: `${cropVf},format=rgb24`, frameBytes, maxFrames: 1 })) {
      frames.push(f);
    }
    return frames;
  }
  const span = Math.max(times[K - 1] - times[0] + 1 / FPS, 0.25);
  const rate = K / span;
  const vf = `${cropVf},fps=${rate},format=rgb24`;
  for await (const f of rawFrames(videoPath, { ss: times[0], t: span, vf, frameBytes, maxFrames: K })) {
    frames.push(f);
  }
  return frames;
}

// Zero stable runs: fixed-interval single-frame page captures every 4 s.
async function fallbackCaptures(videoPath, { crop, startTime, endTime, w, h, workDir }, onProgress, checkCancel) {
  const INTERVAL = 4;
  const end = endTime ?? await probeDuration(videoPath);
  const expected = end != null && end > startTime ? Math.ceil((end - startTime) / INTERVAL) : null;
  const vf = `crop=${w}:${h}:${crop.x}:${crop.y},fps=${1 / INTERVAL},format=rgb24`;
  const runTag = Date.now().toString(36); // see run(): never clobber a prior run's PNGs
  const captures = [];
  let i = 0;
  for await (const frame of rawFrames(videoPath, { ss: startTime, to: endTime ?? undefined, vf, frameBytes: 3 * w * h })) {
    checkCancel();
    const id = `cap-${String(i).padStart(3, '0')}`;
    const png = `${runTag}-${id}.png`;
    await encodePng(frame, w, h, path.join(workDir, png));
    const t = startTime + i * INTERVAL;
    const cap = { id, type: 'page', png, w, h, tStart: t, tEnd: t + INTERVAL, alsoAt: [] };
    captures.push(cap);
    onProgress({ phase: 'capture', capture: cap });
    const pct = expected ? Math.min(99, ((i + 1) / expected) * 100) : Math.min(95, (i + 1) * 5);
    onProgress({ phase: 'composite', pct });
    i++;
  }
  await writeFile(path.join(workDir, 'manifest.json'), JSON.stringify({ captures }, null, 2));
  onProgress({ phase: 'composite', pct: 100 });
  return captures;
}

// End-to-end self-check on a synthetic lossless video: two textured pages with a
// sweeping playhead bar -> exactly 2 clean page captures, cache reused on re-run,
// cancellation rejects with .cancelled.
async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const { mkdtemp, rm, stat: statP } = await import('node:fs/promises');
  const os = await import('node:os');
  const { spawn } = await import('node:child_process');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'vidtotab-index-'));
  try {
    const W = 128, H = 64, N = 40;
    const makePage = (seed) => {
      let s = seed >>> 0 || 1;
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const g = new Uint8Array(W * H);
      for (let by = 0; by < H; by += 8) {
        for (let bx = 0; bx < W; bx += 8) {
          const v = 20 + Math.floor(rnd() * 200);
          for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) g[y * W + x] = v;
        }
      }
      return g;
    };
    const toRgb = (g) => {
      const rgb = Buffer.alloc(g.length * 3);
      for (let i = 0; i < g.length; i++) { rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = g[i]; }
      return rgb;
    };
    const pageA = makePage(11), pageB = makePage(22);
    const videoPath = path.join(dir, 'test.mkv');
    await new Promise((resolve, reject) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
        '-c:v', 'ffv1', videoPath]; // ffv1: lossless, always built in
      const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'inherit'] });
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg encode exit ${code}`))));
      for (let i = 0; i < N; i++) {
        const g = Uint8Array.from(i < 20 ? pageA : pageB);
        const x = (i * 6) % (W - 2);
        for (let y = 0; y < H; y++) { g[y * W + x] = 230; g[y * W + x + 1] = 230; }
        child.stdin.write(toRgb(g));
      }
      child.stdin.end();
    });

    const workDir = path.join(dir, 'work');
    const opts = { crop: { x: 0, y: 0, w: W, h: H }, startTime: 0, sensitivity: 0.5, workDir };
    const events = [];
    const captures = await runPipeline(videoPath, opts, (ev) => events.push(ev));

    assert.equal(captures.length, 2, 'flip video must produce 2 captures');
    assert.ok(captures.every((c) => c.type === 'page'));
    assert.equal(captures[0].id, 'cap-000');
    assert.ok(captures[0].tStart <= 0.5 && Math.abs(captures[1].tStart - 5) <= 0.6);
    assert.ok(events.some((e) => e.phase === 'capture'));
    assert.ok(events.some((e) => e.phase === 'analyze' && e.pct === 100));

    // medians must have erased the sweeping bar: compare decoded PNGs to clean pages
    for (const [cap, page] of [[captures[0], pageA], [captures[1], pageB]]) {
      const pngPath = path.join(workDir, cap.png);
      const decoded = [];
      for await (const f of rawFrames(pngPath, { vf: 'format=rgb24', frameBytes: 3 * W * H })) decoded.push(f);
      assert.equal(decoded.length, 1);
      const expectRgb = toRgb(page);
      let maxDiff = 0;
      for (let i = 0; i < expectRgb.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(decoded[0][i] - expectRgb[i]));
      }
      assert.ok(maxDiff <= 4, `bar not erased / lossy pipeline (maxDiff=${maxDiff})`);
    }

    const manifest = JSON.parse(await readFile(path.join(workDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.captures.map((c) => c.id), captures.map((c) => c.id));

    // re-run must reuse frames.gray (fast sensitivity re-runs)
    const before = (await statP(path.join(workDir, 'frames.gray'))).mtimeMs;
    const again = await runPipeline(videoPath, opts, () => {});
    assert.equal(again.length, 2);
    assert.equal((await statP(path.join(workDir, 'frames.gray'))).mtimeMs, before, 'cache must be reused');

    // cancellation: reject with .cancelled === true
    const p = runPipeline(videoPath, { ...opts, workDir: path.join(dir, 'work2') }, () => {});
    cancelPipeline();
    await assert.rejects(p, (e) => e.cancelled === true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
