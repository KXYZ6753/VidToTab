// Pass 1: half-res pair metrics, pair classification, run segmentation,
// activity map + webcam-inset exclusion mask.
import { pathToFileURL } from 'node:url';

export const FPS = 4;
const COL_T = 0.45;

export function knobs(sensitivity = 0.5) {
  const s = Math.min(1, Math.max(0, Number(sensitivity) || 0));
  const lerp = (a, b, t) => a + (b - a) * t;
  return {
    noiseT: lerp(32, 16, s),
    pixT: lerp(0.10, 0.03, s),
    minRunS: lerp(1.25, 0.5, s),
  };
}

// 2x2 box downsample; odd trailing row/col dropped.
export function downsample2x(src, w, h) {
  const w2 = w >> 1, h2 = h >> 1;
  const out = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w, r1 = r0 + w;
    let o = y * w2;
    for (let x = 0; x < w2; x++) {
      const c = 2 * x;
      out[o + x] = (src[r0 + c] + src[r0 + c + 1] + src[r1 + c] + src[r1 + c + 1] + 2) >> 2;
    }
  }
  return out;
}

// Change metrics between consecutive half-res gray frames.
// Optionally bumps activity[p] per changed pixel and skips excludeMask pixels.
export function pairMetrics(gPrev, gCur, w2, h2, noiseT, excludeMask = null, activity = null) {
  const n = w2 * h2;
  let sumP = 0, sumC = 0, active = 0;
  for (let p = 0; p < n; p++) {
    if (excludeMask !== null && excludeMask[p]) continue;
    sumP += gPrev[p];
    sumC += gCur[p];
    active++;
  }
  if (active === 0) return { changedFrac: 0, changedColsFrac: 0, clusterCount: 0 };
  // global luma bias: cancels autoexposure pumping
  const bias = Math.max(-16, Math.min(16, (sumC - sumP) / active));
  const colChanged = new Uint16Array(w2);
  let changed = 0;
  for (let y = 0; y < h2; y++) {
    const row = y * w2;
    for (let x = 0; x < w2; x++) {
      const p = row + x;
      if (excludeMask !== null && excludeMask[p]) continue;
      const d = Math.abs(gCur[p] - gPrev[p] - bias);
      if (d > noiseT) {
        changed++;
        colChanged[x]++;
        if (activity !== null) activity[p]++;
      }
    }
  }
  const colThresh = 0.05 * h2;
  let changedCols = 0, clusterCount = 0, gap = 3;
  for (let x = 0; x < w2; x++) {
    if (colChanged[x] > colThresh) {
      changedCols++;
      if (gap > 2) clusterCount++; // gaps <= 2 columns are bridged into one cluster
      gap = 0;
    } else {
      gap++;
    }
  }
  return {
    changedFrac: changed / active,
    changedColsFrac: changedCols / w2,
    clusterCount,
  };
}

export function classifyPair(m, pixT) {
  if (m.changedFrac < 0.001) return 'IDENTICAL';
  if (m.changedFrac <= pixT && (m.changedColsFrac <= COL_T || m.clusterCount <= 4)) return 'STABLE';
  return 'TRANSITION';
}

// pairs: [{cls, changedFrac, changedColsFrac}], pair i connects frames i and i+1.
// Returns runs as inclusive frame-index ranges {startF, endF, nFrames}.
export function segmentRuns(pairs, { pixT, minRunS, fps = FPS }) {
  const runs = [];
  const minFrames = Math.max(3, minRunS * fps);
  const close = (sPair, ePair) => {
    const startF = sPair, endF = ePair + 1;
    const nFrames = endF - startF + 1;
    if (nFrames >= minFrames) runs.push({ startF, endF, nFrames });
  };
  let state = 'SEEKING', runStart = -1, pending = -1, nonTrans = 0;
  for (let i = 0; i < pairs.length; i++) {
    const c = pairs[i].cls;
    if (state === 'SEEKING') {
      if (c !== 'TRANSITION') {
        nonTrans++;
        if (nonTrans >= 2) { state = 'IN_RUN'; runStart = i - 1; pending = -1; }
      } else {
        nonTrans = 0;
      }
    } else if (c === 'TRANSITION') {
      // A hiccup is forgivable only if it also LOOKS like noise: low column
      // spread. An instant page flip on sparse tab content yields exactly one
      // TRANSITION pair with small changedFrac — but its column spread is wide,
      // and forgiving it would silently merge two pages into one run.
      const weak = pairs[i].changedFrac < 1.5 * pixT && (pairs[i].changedColsFrac ?? 1) <= COL_T;
      if (weak && pending < 0) {
        pending = i; // one-pair grace for compression hiccups
      } else {
        close(runStart, pending >= 0 ? pending - 1 : i - 1);
        state = 'SEEKING';
        nonTrans = 0;
        pending = -1;
      }
    } else {
      pending = -1;
    }
  }
  if (state === 'IN_RUN') close(runStart, pending >= 0 ? pending - 1 : pairs.length - 1);
  return runs;
}

// Webcam-inset detector over the accumulated activity map.
// Returns { mask, bbox } (half-res Uint8Array, 1 = excluded) or null.
export function detectHotRegion(activity, pairCount, w2, h2) {
  const n = w2 * h2;
  const thresh = 0.5 * pairCount;
  let hotCount = 0, minX = w2, maxX = -1, minY = h2, maxY = -1;
  for (let y = 0; y < h2; y++) {
    const row = y * w2;
    for (let x = 0; x < w2; x++) {
      if (activity[row + x] > thresh) {
        hotCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const hotFrac = hotCount / n;
  if (!(hotFrac > 0.02 && hotFrac < 0.45)) return null;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  if (hotCount / (bw * bh) <= 0.5) return null;
  if (bw <= 0.10 * w2 || bh <= 0.10 * h2) return null;
  const x0 = Math.max(0, minX - 4), x1 = Math.min(w2 - 1, maxX + 4);
  const y0 = Math.max(0, minY - 4), y1 = Math.min(h2 - 1, maxY + 4);
  const mask = new Uint8Array(n);
  for (let y = y0; y <= y1; y++) mask.fill(1, y * w2 + x0, y * w2 + x1 + 1);
  return { mask, bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

// Full pass-1 driver over a re-iterable half-res gray frame source.
// makeFrames() must return a fresh (async) iterable each call; frames must be
// distinct buffers (the previous frame is held across iterations).
export async function pass1(makeFrames, w2, h2, { sensitivity = 0.5, frameCount = null, onPct = () => {} } = {}) {
  const { noiseT, pixT, minRunS } = knobs(sensitivity);

  async function sweep(mask, collectActivity) {
    const activity = collectActivity ? new Uint16Array(w2 * h2) : null;
    const pairs = [];
    let prev = null, i = 0;
    for await (const g of makeFrames()) {
      if (prev !== null) {
        const m = pairMetrics(prev, g, w2, h2, noiseT, mask, activity);
        pairs.push({ cls: classifyPair(m, pixT), changedFrac: m.changedFrac, changedColsFrac: m.changedColsFrac });
      }
      prev = g;
      i++;
      if (frameCount && i % 50 === 0) onPct(i / frameCount);
    }
    return { pairs, activity, frames: i };
  }

  let excludeMask = null, webcamWarned = false;
  let { pairs, activity, frames } = await sweep(null, true);
  if (pairs.length > 0) {
    const hot = detectHotRegion(activity, pairs.length, w2, h2);
    if (hot) {
      excludeMask = hot.mask;
      webcamWarned = true;
      ({ pairs } = await sweep(excludeMask, false));
    }
  }
  const runs = segmentRuns(pairs, { pixT, minRunS });
  return { runs, excludeMask, webcamWarned, frames };
}

async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const W = 128, H = 64;
  const lcg = (seed) => {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  };
  const randFrame = (seed, lo, hi) => {
    const r = lcg(seed);
    const f = new Uint8Array(W * H);
    for (let i = 0; i < f.length; i++) f[i] = lo + Math.floor(r() * (hi - lo));
    return f;
  };
  const paintBar = (bg, x) => {
    const f = Uint8Array.from(bg);
    for (let y = 0; y < H; y++) { f[y * W + x] = 230; f[y * W + x + 1] = 230; }
    return f;
  };
  const feed = (fullFrames) => () => fullFrames.map((f) => downsample2x(f, W, H));

  // 1. Moving bar over static texture -> exactly 1 run spanning everything.
  const bg = randFrame(42, 20, 120);
  const barFrames = [];
  for (let i = 0; i < 40; i++) barFrames.push(paintBar(bg, (i * 6) % (W - 2)));
  let res = await pass1(feed(barFrames), W >> 1, H >> 1, { sensitivity: 0.5 });
  assert.equal(res.runs.length, 1, 'moving bar must be one stable run');
  assert.equal(res.runs[0].startF, 0);
  assert.equal(res.runs[0].endF, 39);
  assert.equal(res.excludeMask, null);

  // 2. Page flip: 20 frames A, 20 frames B -> 2 runs split at the flip.
  const A = randFrame(1, 0, 255), B = randFrame(2, 0, 255);
  const flipFrames = [];
  for (let i = 0; i < 40; i++) flipFrames.push(i < 20 ? A : B);
  res = await pass1(feed(flipFrames), W >> 1, H >> 1, { sensitivity: 0.5 });
  assert.equal(res.runs.length, 2, 'page flip must give two runs');
  assert.equal(res.runs[0].startF, 0);
  assert.equal(res.runs[0].endF, 19);
  assert.equal(res.runs[1].startF, 20);
  assert.equal(res.runs[1].endF, 39);

  // 3. Webcam inset: random block every frame -> mask found, rest is one run.
  const camFrames = [];
  for (let i = 0; i < 24; i++) {
    const f = Uint8Array.from(bg);
    const r = lcg(100 + i);
    for (let y = 10; y < 30; y++) {
      for (let x = 20; x < 60; x++) f[y * W + x] = Math.floor(r() * 256);
    }
    camFrames.push(f);
  }
  res = await pass1(feed(camFrames), W >> 1, H >> 1, { sensitivity: 0.5 });
  assert.ok(res.excludeMask !== null, 'webcam block must produce an exclude mask');
  assert.ok(res.webcamWarned);
  assert.equal(res.runs.length, 1, 'masked webcam video must be one stable run');

  // 4. Grace-pair regression (sparse-flip trap): a lone weak-changedFrac
  //    TRANSITION with WIDE column spread is a real flip and must close the
  //    run; the same pair with narrow spread is a hiccup and must be forgiven.
  const st = { cls: 'STABLE', changedFrac: 0.01, changedColsFrac: 0.02 };
  const seq = (mid) => [st, st, st, st, st, mid, st, st, st, st, st];
  const opts = { pixT: 0.065, minRunS: 0.75 };
  let runs = segmentRuns(seq({ cls: 'TRANSITION', changedFrac: 0.08, changedColsFrac: 0.56 }), opts);
  assert.equal(runs.length, 2, 'weak-but-wide transition must split the run');
  runs = segmentRuns(seq({ cls: 'TRANSITION', changedFrac: 0.08, changedColsFrac: 0.10 }), opts);
  assert.equal(runs.length, 1, 'weak-and-narrow hiccup must be forgiven');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
