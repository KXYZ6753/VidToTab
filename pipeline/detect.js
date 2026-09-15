// Tab-region detection and per-crop calibration.
//
// Staff lines are the one feature every target style shares: thin, bright in
// ink space, horizontal, evenly spaced, and static across the video while fret
// numbers, cursors and the guitarist change around them. We sample keyframes
// across the video, keep line pixels that persist, group evenly spaced line
// rows into staff systems, then grow the best system's box to cover its
// notation (chord names above, rhythm/pick marks below) without swallowing
// live video. Guitar strings fail the tests: slanted rows never form long
// single-row runs, and the guitar moves.
import { pathToFileURL } from 'node:url';
import { grabFramesAt, probeVideo } from './ffmpeg.js';
import { inkHalf, topHat, quantile8 } from './ink.js';

const POLARITIES = ['dark', 'light'];
const MAX_SAMPLE_W = 1920; // larger sources are area-scaled for sampling

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const median = (a) => {
  if (a.length === 0) return 0;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function spreadTimes(t0, t1, count, lo = 0, hi = 1) {
  const span = Math.max(0, t1 - t0);
  if (count <= 1) return [t0 + span * (lo + hi) / 2];
  return Array.from({ length: count }, (_, i) => t0 + span * (lo + ((hi - lo) * i) / (count - 1)));
}

// ------------------------------------------------------------ line finding

// Thin bright horizontal structure: brighter than the rows 2-3 px above AND
// below. Catches 1-3 px lines; thick bars and blobs fail. The contrast floor is
// low on purpose — vvxo panels draw staff lines only ~25-60 levels above the
// panel while the video above hits 255; persistence across samples and long
// single-row runs are what reject noise.
export function linePixels(e, w, h, out = new Uint8Array(w * h)) {
  out.fill(0);
  const T = Math.max(12, 0.08 * quantile8(e, 0.99, null, 7));
  for (let y = 3; y < h - 3; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const v = e[r + x];
      if (v < T) continue;
      const a = e[r - 2 * w + x], b = e[r - 3 * w + x], c = e[r + 2 * w + x], d = e[r + 3 * w + x];
      let m = a > b ? a : b;
      if (c > m) m = c;
      if (d > m) m = d;
      if (v - m >= T) out[r + x] = 1;
    }
  }
  return out;
}

// Longest run in one row of values >= minVal, bridging gaps <= gap (dashed
// staff lines, digits knocking lines out). Runs must be >= 50% filled.
function longestRun(arr, off, w, minVal, gap) {
  let best = null, s = -1, last = -1, filled = 0;
  const close = () => {
    if (s < 0) return;
    const len = last - s + 1;
    if (filled >= 0.5 * len && (best === null || len > best.len)) best = { x0: s, x1: last, len };
  };
  for (let x = 0; x < w; x++) {
    if (arr[off + x] < minVal) continue;
    if (s >= 0 && x - last - 1 > gap) {
      close();
      s = -1;
    }
    if (s < 0) {
      s = x;
      filled = 0;
    }
    last = x;
    filled++;
  }
  close();
  return best;
}

// Adjacent line rows (a 2-px line spans two rows) merge into one line.
function mergeRows(rows) {
  const lines = [];
  let g = null;
  const flush = () => {
    if (g === null) return;
    const main = g.rows.reduce((p, q) => (q.len > p.len ? q : p));
    const wsum = g.rows.reduce((s, r) => s + r.len, 0);
    lines.push({ y: g.rows.reduce((s, r) => s + r.y * r.len, 0) / wsum, x0: main.x0, x1: main.x1, len: main.len });
    g = null;
  };
  for (const r of rows) {
    if (g !== null && r.y - g.lastY <= 2 && r.x0 <= g.rows[0].x1 && r.x1 >= g.rows[0].x0) {
      g.rows.push(r);
      g.lastY = r.y;
    } else {
      flush();
      g = { rows: [r], lastY: r.y };
    }
  }
  flush();
  return lines;
}

// Every run of 4-7 consecutive lines with even spacing and matching extents.
function groupSystems(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    for (let n = 4; n <= 7 && i + n <= lines.length; n++) {
      const seq = lines.slice(i, i + n);
      const gaps = seq.slice(1).map((l, k) => l.y - seq[k].y);
      const d = median(gaps);
      if (d < 3 || d > 60) continue;
      const maxDev = Math.max(...gaps.map((g) => Math.abs(g - d)));
      const tol = Math.max(0.15 * d, 1.01);
      if (maxDev > tol) continue;
      const x0 = median(seq.map((l) => l.x0)), x1 = median(seq.map((l) => l.x1));
      const span = x1 - x0 + 1;
      const covers = (l) => Math.min(l.x1, x1) - Math.max(l.x0, x0) + 1 >= 0.7 * span;
      if (!seq.every(covers)) continue;
      out.push({ lines: seq, n, d, regularity: clamp(1 - maxDev / tol, 0, 1), x0, x1, y0: seq[0].y, y1: seq[n - 1].y, len: span });
    }
  }
  return out;
}

// planes: half-res ink planes of one polarity. Returns systems plus the
// per-sample line maps (reused for presence checks).
export function findStaffSystems(planes, w, h, { minPersist = 3, minLenFrac = 0.25, minLen = 20 } = {}) {
  const persist = new Uint8Array(w * h);
  const lineMaps = planes.map((e) => {
    const m = linePixels(e, w, h);
    for (let i = 0; i < m.length; i++) persist[i] += m[i];
    return m;
  });
  const lenMin = Math.max(minLen, Math.round(minLenFrac * w));
  const gap = Math.max(6, Math.round(0.03 * w));
  const rows = [];
  for (let y = 0; y < h; y++) {
    const run = longestRun(persist, y * w, w, minPersist, gap);
    if (run !== null && run.len >= lenMin) rows.push({ y, ...run });
  }
  const lines = mergeRows(rows);
  return { systems: groupSystems(lines), lines, lineMaps };
}

// Which samples actually show the system (>= 60% of its lines visible).
function systemPresence(sys, lineMaps, w, h) {
  const idx = [];
  const need = Math.ceil(0.6 * sys.n);
  lineMaps.forEach((m, k) => {
    let visible = 0;
    for (const l of sys.lines) {
      const yc = Math.round(l.y);
      let hit = 0;
      for (let x = Math.round(sys.x0); x <= Math.round(sys.x1); x++) {
        for (let y = Math.max(0, yc - 1); y <= Math.min(h - 1, yc + 1); y++) {
          if (m[y * w + x]) {
            hit++;
            break;
          }
        }
      }
      if (hit >= 0.5 * sys.len) visible++;
    }
    if (visible >= need) idx.push(k);
  });
  return idx;
}

function scoreSystem(sys, presentFrac, w, h) {
  const lineScore = { 4: 0.5, 5: 0.75, 6: 1, 7: 0.7 }[sys.n];
  const lenScore = clamp(sys.len / (0.5 * w), 0, 1);
  const bottom = (sys.y0 + sys.y1) / 2 > h / 2 ? 0.05 : 0;
  return Math.min(1, 0.35 * lineScore + 0.25 * presentFrac + 0.2 * sys.regularity + 0.2 * lenScore + bottom);
}

// Best system across both polarities for a set of rgb samples.
function bestSystem(frames, W, H, { minLenFrac, polarities = POLARITIES }) {
  const w2 = W >> 1, h2 = H >> 1;
  const valid = frames.filter(Boolean);
  const minPersist = Math.max(2, Math.round(0.3 * valid.length));
  let best = null;
  const planesBy = {};
  for (const polarity of polarities) {
    const planes = valid.map((f) => inkHalf(f, W, H, polarity));
    planesBy[polarity] = planes;
    const found = findStaffSystems(planes, w2, h2, { minPersist, minLenFrac });
    for (const sys of found.systems) {
      const presentIdx = systemPresence(sys, found.lineMaps, w2, h2);
      const score = scoreSystem(sys, presentIdx.length / valid.length, w2, h2);
      if (best === null || score > best.score) best = { ...sys, polarity, presentIdx, score, lines: sys.lines, allLines: found.lines };
    }
  }
  return { best, planesBy, valid, w2, h2 };
}

// ------------------------------------------------------------ contrast

// Staff/glyph contrast C from top-hat planes: the P90 top-hat value on the
// system's line rows and the P95 of clearly-inked pixels, whichever is higher.
function contrastFrom(ths, w, lines, x0, x1) {
  const lineHist = new Uint32Array(256), inkHist = new Uint32Array(256);
  for (const th of ths) {
    for (const l of lines) {
      const r = Math.round(l.y) * w;
      for (let x = Math.round(x0); x <= Math.round(x1); x++) lineHist[th[r + x]]++;
    }
    for (let i = 0; i < th.length; i += 3) if (th[i] > 48) inkHist[th[i]]++;
  }
  const q = (hist, p) => {
    let n = 0;
    for (const c of hist) n += c;
    if (n === 0) return 0;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc > p * (n - 1)) return v;
    }
    return 255;
  };
  return clamp(Math.max(q(lineHist, 0.9), q(inkHist, 0.95)), 64, 255);
}

// ------------------------------------------------------------ region detection

// frames: rgb24 samples (null = failed grab) of size W x H; times: their
// timestamps. Returns a suggestion in sample pixel space (the caller scales).
export function detectFromSamples(frames, W, H, times = []) {
  const { best, planesBy, valid, w2, h2 } = bestSystem(frames, W, H, { minLenFrac: 0.2 });
  const sampleTimes = times.filter((_, i) => frames[i]);
  if (best === null || valid.length < 3) return { crop: null, confidence: best ? best.score * 0.5 : 0 };

  const planes = planesBy[best.polarity];
  const d = best.d;
  const X0 = clamp(Math.floor(best.x0 - 0.6 * d), 0, w2 - 1);
  const X1 = clamp(Math.ceil(best.x1 + 0.6 * d), 0, w2 - 1);
  const rH = clamp(Math.round(0.9 * d), 2, 30);
  const use = best.presentIdx.length >= 3 ? best.presentIdx : planes.map((_, k) => k);
  const ths = use.map((k) => topHat(planes[k], w2, h2, rH));
  const C = contrastFrom(ths, w2, best.lines, best.x0, best.x1);
  const tau = 0.38 * C;

  // Row statistics over a band around the system, within its x-range:
  //   rowInk   = share of pixels inked in >= 2 samples (notation lives here)
  //   rowBg[k] = median large-scale background (the opening, e - topHat) of
  //              the row in sample k
  // A row belongs to the tab's panel while its background tracks the staff
  // band's background sample by sample. Live video above a panel doesn't
  // (fretboards full of thin static lines fooled an ink/motion test); a
  // translucent measure highlight shifts band and neighbours alike; page flips
  // don't register at all because the opening removes digits.
  const bandLo = clamp(Math.floor(best.y0 - 5 * d), 0, h2 - 1);
  const bandHi = clamp(Math.ceil(best.y1 + 7 * d), 0, h2 - 1);
  const bw = X1 - X0 + 1;
  const K = use.length;
  const rowInk = new Float64Array(h2);
  const rowBg = new Array(h2).fill(null);
  const meanBg = new Array(h2).fill(null); // per-pixel temporal mean of the opening
  const meanE = new Array(h2).fill(null);  // ... and of the ink plane itself
  const hist = new Uint32Array(256);
  const minInk = Math.min(2, K);
  for (let y = bandLo; y <= bandHi; y++) {
    let inked = 0;
    const mrow = new Float32Array(bw), erow = new Float32Array(bw);
    for (let x = X0; x <= X1; x++) {
      const p = y * w2 + x;
      let cnt = 0, s = 0, se = 0;
      for (let k = 0; k < K; k++) {
        const t = ths[k][p], e = planes[use[k]][p];
        if (t > tau) cnt++;
        s += e - t;
        se += e;
      }
      if (cnt >= minInk) inked++;
      mrow[x - X0] = s / K;
      erow[x - X0] = se / K;
    }
    meanBg[y] = mrow;
    meanE[y] = erow;
    rowInk[y] = inked / bw;
    const bg = new Uint8Array(K);
    for (let k = 0; k < K; k++) {
      hist.fill(0);
      const e = planes[use[k]], th = ths[k];
      for (let p = y * w2 + X0, end = y * w2 + X1; p <= end; p++) hist[e[p] - th[p]]++;
      let acc = 0, v = 0;
      for (; v < 255; v++) {
        acc += hist[v];
        if (2 * acc >= bw) break;
      }
      bg[k] = v;
    }
    rowBg[y] = bg;
  }
  const y0i = Math.round(best.y0), y1i = Math.round(best.y1);
  const bandBg = Array.from({ length: K }, (_, k) => median(
    Array.from({ length: y1i - y0i + 1 }, (_, i) => rowBg[y0i + i][k])));
  const foreign = (y) => {
    let off = 0;
    for (let k = 0; k < K; k++) if (Math.abs(rowBg[y][k] - bandBg[k]) > 20) off++;
    return off > 0.3 * K;
  };
  // Panel borders: a persistent line outside the staff spanning most of its
  // width, or a background step edge across most of the row (where a dark
  // panel meets the video above it — level alone can't tell a dark shirt
  // from the panel).
  const staffYs = best.lines.map((l) => l.y);
  const frameRow = (y) => best.allLines.some((l) => Math.abs(l.y - y) <= 1
    && !staffYs.some((sy) => Math.abs(sy - l.y) < 0.5 * d)
    && Math.min(l.x1, best.x1) - Math.max(l.x0, best.x0) >= 0.6 * best.len);
  const stepRow = (y, dir) => {
    const a = meanBg[y], b = meanBg[y - 2 * dir];
    if (!a || !b) return false;
    let n = 0;
    for (let i = 0; i < bw; i++) if (Math.abs(a[i] - b[i]) > 14) n++;
    return n > 0.5 * bw;
  };

  // Thick decorative borders (vvxo panels: a 3-6 px orange frame between the
  // chord names and the song title) are too thick for linePixels; test the
  // temporal-mean plane with a probe distance that clears them.
  const probe = Math.max(3, Math.round(0.35 * d));
  const borderRow = (y) => {
    if (staffYs.some((sy) => Math.abs(sy - y) < 0.6 * d)) return false;
    const a = meanE[y], up = meanE[y - probe], dn = meanE[y + probe];
    if (!a || !up || !dn) return false;
    let n = 0;
    for (let i = 0; i < bw; i++) {
      const hi = up[i] > dn[i] ? up[i] : dn[i], lo = up[i] < dn[i] ? up[i] : dn[i];
      if (a[i] - hi >= 25 || lo - a[i] >= 25) n++;
    }
    return n >= 0.6 * bw;
  };

  // Grow while rows stay panel-like, allowing notation gaps up to 2 line
  // spacings (rhythm stems -> pick-direction marks).
  const stops = {};
  const walk = (from, dir, limit) => {
    let edge = from, blank = 0, why = 'limit', at = limit;
    for (let y = from + dir; dir < 0 ? y >= limit : y <= limit; y += dir) {
      const reason = foreign(y) ? 'video' : frameRow(y) ? 'frame line' : stepRow(y, dir) ? 'panel edge' : borderRow(y) ? 'border' : null;
      if (reason) { why = reason; at = y; break; }
      if (rowInk[y] > 0.01) {
        edge = y;
        blank = 0;
      } else if (++blank > 2 * d) {
        why = 'blank';
        at = y;
        break;
      }
    }
    stops[dir < 0 ? 'top' : 'bottom'] = { why, at: 2 * at, edge: 2 * edge };
    return edge;
  };
  const top = walk(y0i, -1, Math.max(bandLo, Math.floor(best.y0 - 4 * d)));
  const bot = walk(y1i, 1, Math.min(bandHi, Math.ceil(best.y1 + 6 * d)));
  const Y0 = clamp(Math.floor(top - 0.3 * d), 0, h2 - 1);
  const Y1 = clamp(Math.ceil(bot + 0.3 * d), 0, h2 - 1);

  const even = (v) => v - (v % 2);
  const x = even(2 * X0), y = even(2 * Y0);
  const crop = { x, y, w: even(Math.min(W, 2 * (X1 + 1)) - x), h: even(Math.min(H, 2 * (Y1 + 1)) - y) };

  const present = best.presentIdx.map((k) => sampleTimes[k]).filter((t) => t != null);
  const first = best.presentIdx.length ? best.presentIdx[0] : 0;
  return {
    crop,
    confidence: Math.round(best.score * 100) / 100,
    polarity: best.polarity,
    dN: 2 * d,
    lines: best.n,
    tabRange: present.length ? [present[0], present[present.length - 1]] : null,
    stops, // why the box stopped growing (sample px) — diagnostics
    // Two samples back, not one. A single sample can miss the tab (a hand over
    // the neck, a title card), and starting just after it silently drops every
    // page in between — up to ~3 minutes on a long video sampled 20 times.
    startTime: first > 0 ? (sampleTimes[Math.max(0, first - 2)] ?? 0) : 0,
  };
}

export async function detectRegion(videoPath, { duration = null, width = 0, height = 0, count = 20 } = {}) {
  if (!duration || !width || !height) {
    const p = await probeVideo(videoPath);
    if (p === null) return null;
    duration ||= p.duration;
    width ||= p.width;
    height ||= p.height;
  }
  if (!duration || !width || !height) return null;
  const scale = width > MAX_SAMPLE_W ? MAX_SAMPLE_W / width : 1;
  const W = Math.round(width * scale) & ~1, H = Math.round(height * scale) & ~1;
  const vf = `scale=${W}:${H}:flags=area,format=rgb24`;
  const times = spreadTimes(0, duration, count, 0.04, 0.96);
  const frames = await grabFramesAt(videoPath, times, { vf, frameBytes: 3 * W * H });
  const s = detectFromSamples(frames, W, H, times);
  if (s.crop === null || scale === 1) return s;
  const even = (v) => v - (v % 2);
  const k = 1 / scale;
  s.crop = { x: even(Math.round(s.crop.x * k)), y: even(Math.round(s.crop.y * k)), w: even(Math.round(s.crop.w * k)), h: even(Math.round(s.crop.h * k)) };
  s.dN *= k;
  return s;
}

// ------------------------------------------------------------ calibration

// Per-crop parameters for the pipeline, from rgb samples of the crop itself.
// All half-res units: dH line spacing, rH top-hat radius, C contrast, tau
// ink threshold.
// polarity: optional hint (from full-frame detection), used when the crop alone
// is ambiguous — no staff found, or only a weak one in the other polarity.
export function calibrateFromSamples(frames, w, h, { polarity: hint = null } = {}) {
  let found = bestSystem(frames, w, h, { minLenFrac: 0.25 });
  let forced = null;
  if (hint && (found.best === null || (found.best.score < 0.5 && found.best.polarity !== hint))) {
    found = bestSystem(frames, w, h, { minLenFrac: 0.25, polarities: [hint] });
    forced = hint;
  }
  const { best, planesBy, valid, w2, h2 } = found;
  let polarity;
  if (best !== null) {
    polarity = best.polarity;
  } else if (forced) {
    polarity = forced;
  } else {
    // no staff: polarity from median luma of the crop
    const hist = new Uint32Array(256);
    for (const f of valid) for (let j = 0; j < f.length; j += 30) hist[(f[j] * 77 + f[j + 1] * 150 + f[j + 2] * 29) >> 8]++;
    let n = 0, acc = 0, med = 0;
    for (const c of hist) n += c;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc > n / 2) { med = v; break; }
    }
    polarity = med < 110 ? 'dark' : 'light';
  }
  const dH = best !== null ? best.d : clamp(Math.round(h2 / 10), 3, 20);
  const rH = clamp(Math.round(0.9 * dH), 2, 30);
  const planes = planesBy[polarity];
  const ths = planes.map((e) => topHat(e, w2, h2, rH));
  const C = best !== null
    ? contrastFrom(ths, w2, best.lines, best.x0, best.x1)
    : contrastFrom(ths, w2, [], 0, -1);
  const staff = best === null ? null : {
    rows: best.lines.map((l) => Math.round(l.y * 10) / 10), x0: best.x0, x1: best.x1, lines: best.n,
  };
  return {
    polarity,
    dH: Math.round(dH * 100) / 100,
    dN: Math.round(2 * dH * 100) / 100,
    rH,
    C,
    tau: Math.round(0.38 * C),
    bg: quantile8(planes[0] ?? new Uint8Array(1), 0.5, null, 5),
    confidence: best === null ? 0 : Math.round(best.score * 100) / 100,
    staff,
  };
}

export async function calibrateCrop(videoPath, crop, { startTime = 0, endTime = null, duration = null, count = 8, polarity = null } = {}) {
  const end = endTime ?? duration ?? (await probeVideo(videoPath))?.duration ?? startTime + 60;
  const times = spreadTimes(startTime, end, count, 0.1, 0.9);
  const { x, y, w, h } = crop;
  const frames = await grabFramesAt(videoPath, times, { vf: `crop=${w}:${h}:${x}:${y},format=rgb24`, frameBytes: 3 * w * h });
  return calibrateFromSamples(frames, w, h, { polarity });
}

// ------------------------------------------------------------ self-check

async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const W = 480, H = 270, N = 12;
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const frame = (bg) => {
    const f = new Uint8Array(W * H * 3);
    for (let i = 0; i < f.length; i += 3) { f[i] = bg[0]; f[i + 1] = bg[1]; f[i + 2] = bg[2]; }
    return f;
  };
  const rect = (f, x0, y0, x1, y1, c, a = 1) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const j = 3 * (y * W + x);
        for (let k = 0; k < 3; k++) f[j + k] = Math.round(a * c[k] + (1 - a) * f[j + k]);
      }
    }
  };
  // "live video": a smooth gradient with large bright discs that move per sample
  const video = (f, k, y0, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const j = 3 * (y * W + x);
        let v = 40 + (x * 60) / W;
        for (let b = 0; b < 3; b++) {
          const cx = 60 + b * 150 + 25 * Math.sin(k * 1.7 + b), cy = y0 + 40 + 20 * Math.cos(k * 1.3 + b);
          if ((x - cx) ** 2 + (y - cy) ** 2 < 30 ** 2) v = 190;
        }
        f[j] = v; f[j + 1] = v * 0.8; f[j + 2] = v * 0.6;
      }
    }
  };
  const staffPage = (f, k, { y0, x0, x1, gap, ink, polarity, highlight }) => {
    for (let i = 0; i < 6; i++) rect(f, x0, y0 + i * gap, x1, y0 + i * gap + 2, polarity === 'dark' ? [200, 200, 200] : [40, 40, 40]);
    seed = 1000 + Math.floor(k / 3); // a new page every 3 samples
    for (let i = 0; i < 14; i++) {
      const x = x0 + 10 + Math.floor(rnd() * (x1 - x0 - 20)), line = Math.floor(rnd() * 6);
      rect(f, x, y0 + line * gap - 3, x + 4, y0 + line * gap + 4, ink);
    }
    const cx = x0 + 20 + Math.floor(rnd() * (x1 - x0 - 60));
    rect(f, cx, y0 - 18, cx + 8, y0 - 8, ink); // chord name above the staff
    if (highlight && k % 2) rect(f, x0 + 40, y0 - 14, x0 + 120, y0 + 5 * gap + 6, [40, 110, 220], 0.5);
  };

  // 1. Dark tab panel under live video, blue measure highlight, page flips.
  const panel = [];
  for (let k = 0; k < N; k++) {
    const f = frame([18, 18, 22]);
    video(f, k, 0, 160);
    staffPage(f, k, { y0: 190, x0: 60, x1: 420, gap: 8, ink: [240, 240, 240], polarity: 'dark', highlight: true });
    panel.push(f);
  }
  const times = spreadTimes(0, 100, N, 0.04, 0.96);
  let s = detectFromSamples(panel, W, H, times);
  assert.ok(s.crop, 'dark panel staff must be found');
  assert.equal(s.polarity, 'dark');
  assert.equal(s.lines, 6);
  assert.ok(s.confidence > 0.8, `confidence ${s.confidence}`);
  assert.ok(s.crop.x >= 44 && s.crop.x <= 62, `x ${s.crop.x}`);
  assert.ok(s.crop.x + s.crop.w >= 418 && s.crop.x + s.crop.w <= 440, `x1 ${s.crop.x + s.crop.w}`);
  assert.ok(s.crop.y >= 158 && s.crop.y <= 174, `y ${s.crop.y} (chord names in, video out)`);
  assert.ok(s.crop.y + s.crop.h >= 232 && s.crop.y + s.crop.h <= 262, `y1 ${s.crop.y + s.crop.h}`);

  // 2. Calibration on that crop: dark polarity, half-res spacing ~4.
  const cw = 380, ch = 90, cx0 = 50, cy0 = 164;
  const crops = panel.map((f) => {
    const out = new Uint8Array(cw * ch * 3);
    for (let y = 0; y < ch; y++) out.set(f.subarray(3 * ((cy0 + y) * W + cx0), 3 * ((cy0 + y) * W + cx0 + cw)), 3 * y * cw);
    return out;
  });
  const cal = calibrateFromSamples(crops, cw, ch);
  assert.equal(cal.polarity, 'dark');
  assert.ok(Math.abs(cal.dH - 4) <= 0.5, `dH ${cal.dH}`);
  assert.ok(cal.tau >= 40 && cal.tau <= 100, `tau ${cal.tau}`);
  assert.ok(cal.staff && cal.staff.lines === 6);

  // 3. Light page (black notes on white) between two video bands.
  const light = [];
  for (let k = 0; k < N; k++) {
    const f = frame([250, 250, 248]);
    video(f, k, 0, 70);
    video(f, k, 170, 270);
    staffPage(f, k, { y0: 100, x0: 20, x1: 460, gap: 8, ink: [20, 20, 20], polarity: 'light', highlight: false });
    light.push(f);
  }
  s = detectFromSamples(light, W, H, times);
  assert.ok(s.crop, 'light page staff must be found');
  assert.equal(s.polarity, 'light');
  assert.ok(s.crop.y >= 70 && s.crop.y + s.crop.h <= 170, `light crop ${JSON.stringify(s.crop)}`);

  // 4. Decoy: six slanted, slightly moving guitar strings and no tab.
  const strings = [];
  for (let k = 0; k < N; k++) {
    const f = frame([30, 25, 20]);
    video(f, k, 0, 270);
    for (let i = 0; i < 6; i++) {
      for (let x = 40; x < 460; x++) {
        const y = Math.round(120 + i * 8 + (x - 40) * 0.075 + (k % 3));
        rect(f, x, y, x + 1, y + 2, [220, 220, 210]);
      }
    }
    strings.push(f);
  }
  s = detectFromSamples(strings, W, H, times);
  assert.ok(s.crop === null || s.confidence < 0.5, `strings must not look like tab (${JSON.stringify(s)})`);

  // 5. Nothing tab-like at all.
  const empty = [];
  for (let k = 0; k < N; k++) {
    const f = frame([20, 20, 20]);
    video(f, k, 0, 270);
    empty.push(f);
  }
  s = detectFromSamples(empty, W, H, times);
  assert.ok(s.crop === null || s.confidence < 0.3);

  // 6. Tab present only in later samples -> startTime suggestion skips intro.
  const intro = panel.map((f, k) => (k < 3 ? empty[k] : f));
  s = detectFromSamples(intro, W, H, times);
  assert.ok(s.crop);
  assert.ok(s.startTime > 0 && s.startTime < times[3], `startTime ${s.startTime}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
