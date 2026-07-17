// Pass 2: sample-time selection, per-pixel temporal median, run-homogeneity split.
import { pathToFileURL } from 'node:url';

export const K_MEDIAN = 7;

export function oddFloor(n) {
  n = Math.floor(n);
  return n % 2 === 0 ? n - 1 : n;
}

export function pickK(nFrames) {
  return Math.max(1, Math.min(K_MEDIAN, oddFloor(nFrames - 2)));
}

// K timestamps evenly spread across [tStart + 1/fps, tEnd - 1/fps].
export function pickSampleTimes(tStart, tEnd, K, fps = 4) {
  const a = tStart + 1 / fps, b = tEnd - 1 / fps;
  if (K <= 1 || b <= a) return [(tStart + tEnd) / 2];
  const times = [];
  for (let i = 0; i < K; i++) times.push(a + (i * (b - a)) / (K - 1));
  return times;
}

// Per-index median across equal-length buffers (rgb or gray alike).
// K==1/2 -> first frame as-is (short run: accept a possible playhead bar).
export function medianComposite(frames) {
  const K = frames.length;
  if (K <= 2) return Uint8Array.from(frames[0]);
  const len = frames[0].length;
  const out = new Uint8Array(len);
  const vals = new Uint8Array(K);
  const mid = K >> 1;
  for (let i = 0; i < len; i++) {
    for (let k = 0; k < K; k++) vals[k] = frames[k][i];
    for (let a = 1; a < K; a++) { // insertion sort: K <= 7
      const v = vals[a];
      let b = a - 1;
      while (b >= 0 && vals[b] > v) { vals[b + 1] = vals[b]; b--; }
      vals[b + 1] = v;
    }
    out[i] = vals[mid];
  }
  return out;
}

export function toGray(rgb) {
  const n = rgb.length / 3;
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    g[i] = (rgb[j] * 77 + rgb[j + 1] * 150 + rgb[j + 2] * 29) >> 8;
  }
  return g;
}

export function mad(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// Fraction of pixels differing by more than T after global-luma-bias removal.
// Sparse-content safe: a page flip on a mostly-white tab moves FEW pixels but
// each moves a LOT — raw MAD dilutes toward zero on such content, a count
// does not. This is the one comparison metric used pipeline-wide.
export function diffFrac(a, b, T = 24) {
  const n = a.length;
  if (n === 0) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += b[i] - a[i];
  const bias = Math.max(-16, Math.min(16, sum / n));
  let changed = 0;
  for (let i = 0; i < n; i++) if (Math.abs(b[i] - a[i] - bias) > T) changed++;
  return changed / n;
}

// Run-homogeneity safety net: median of first ceil(n/2) vs last ceil(n/2) gray
// frames; if they disagree the run hid a scroll -> split at midpoint, recurse.
// Halves must keep >= 3 frames, so only n >= 6 can split.
// Returns inclusive [start, end] index ranges partitioning frames[].
export function splitHomogeneous(grayFrames, threshold = 0.02) {
  const ranges = [];
  const rec = (s, e) => {
    const n = e - s + 1;
    if (n >= 6) {
      const half = Math.ceil(n / 2);
      const a = medianComposite(grayFrames.slice(s, s + half));
      const b = medianComposite(grayFrames.slice(e + 1 - half, e + 1));
      if (diffFrac(a, b) > threshold) {
        const m = s + (n >> 1);
        rec(s, m - 1);
        rec(m, e);
        return;
      }
    }
    ranges.push([s, e]);
  };
  if (grayFrames.length > 0) rec(0, grayFrames.length - 1);
  return ranges;
}

async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const W = 60, H = 40;

  // 1. Median erases a moving bar: 7 frames, red bar at non-overlapping x each.
  const bg = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    bg[3 * i] = bg[3 * i + 1] = bg[3 * i + 2] = 40 + ((i * 37) % 160);
  }
  const frames = [];
  for (let k = 0; k < 7; k++) {
    const f = Uint8Array.from(bg);
    for (let y = 0; y < H; y++) {
      for (let x = 6 * k; x < 6 * k + 3; x++) {
        f[3 * (y * W + x)] = 255;
        f[3 * (y * W + x) + 1] = 0;
        f[3 * (y * W + x) + 2] = 0;
      }
    }
    frames.push(f);
  }
  assert.deepEqual(medianComposite(frames), bg, 'median must erase the moving bar exactly');

  // 2. Homogeneity split: 3 frames of A then 4 of B -> two ranges at the midpoint.
  const gA = new Uint8Array(W * H).fill(10);
  const gB = new Uint8Array(W * H).fill(200);
  const ranges = splitHomogeneous([gA, gA, gA, gB, gB, gB, gB]);
  assert.deepEqual(ranges, [[0, 2], [3, 6]]);

  // 3. Homogeneous run stays whole.
  assert.deepEqual(splitHomogeneous([gA, gA, gA, gA, gA, gA, gA]), [[0, 6]]);

  // 4. K selection edges.
  assert.equal(pickK(3), 1);
  assert.equal(pickK(7), 5);
  assert.equal(pickK(9), 7);
  assert.equal(pickK(100), 7);
  assert.equal(pickSampleTimes(0, 10, 1).length, 1);
  const ts = pickSampleTimes(0, 10, 7, 4);
  assert.equal(ts.length, 7);
  assert.ok(Math.abs(ts[0] - 0.25) < 1e-9 && Math.abs(ts[6] - 9.75) < 1e-9);

  // 5. gray/mad basics.
  const g = toGray(Uint8Array.from([255, 255, 255, 0, 0, 0]));
  assert.ok(g[0] >= 253 && g[1] === 0);
  assert.equal(mad(gA, gA), 0);

  // 6. diffFrac: sparse change counts, uniform luma drift does not.
  const white = new Uint8Array(1000).fill(255);
  const sparse = Uint8Array.from(white);
  for (let i = 0; i < 30; i++) sparse[i * 33] = 0; // 3% of pixels flip to ink
  assert.equal(diffFrac(white, white), 0);
  assert.ok(diffFrac(white, sparse) > 0.025, 'sparse flip must register');
  const drifted = white.map((v) => v - 12); // autoexposure-style global shift
  assert.equal(diffFrac(white, Uint8Array.from(drifted)), 0, 'bias must be normalized away');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
