// Pass 2 renderers: a page's sample frames (full-res rgb24) become
//   clean — gray, black ink on white paper: dark panels inverted, highlights
//           and cursors gone (print default);
//   color  — the original look with tinted samples (measure highlights,
//            cursor bars, notes recolored as they're played) rejected per pixel.
import { pathToFileURL } from 'node:url';
import { dilate3, inkPlane, localGain, morph, removeSmall, topHat } from './ink.js';

// Up to K indices spread evenly over the candidate list (time order).
export function pickSampleFrames(candidates, K = 11) {
  if (candidates.length <= K) return [...candidates];
  const out = new Set();
  for (let i = 0; i < K; i++) out.add(candidates[Math.round((i * (candidates.length - 1)) / (K - 1))]);
  return [...out].sort((a, b) => a - b);
}

// Per-pixel median across equal-length buffers (kept for fallbacks/tests).
export function medianComposite(frames) {
  const K = frames.length;
  if (K <= 2) return Uint8Array.from(frames[0]);
  const len = frames[0].length;
  const out = new Uint8Array(len);
  const vals = new Uint8Array(K);
  const mid = K >> 1;
  for (let i = 0; i < len; i++) {
    for (let k = 0; k < K; k++) vals[k] = frames[k][i];
    sortSmall(vals, K);
    out[i] = vals[mid];
  }
  return out;
}

function sortSmall(a, n) {
  for (let i = 1; i < n; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; }
    a[j + 1] = v;
  }
}

export function toGray(rgb) {
  const n = rgb.length / 3;
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) g[i] = (rgb[j] * 77 + rgb[j + 1] * 150 + rgb[j + 2] * 29) >> 8;
  return g;
}

// calib: {polarity, rH (half-res), dN, C, tau}.
export function renderClean(samples, w, h, calib) {
  const K = samples.length, n = w * h;
  const r = Math.max(2, 2 * calib.rH);
  const { C, tau } = calib;
  const tmp = new Uint8Array(n);
  const planes = samples.map((rgb) => {
    const th = topHat(inkPlane(rgb, w, h, calib.polarity), w, h, r, new Uint8Array(n), tmp);
    return localGain(th, w, h, r, C, new Uint8Array(n), tmp);
  });
  // 65th-percentile rank: a cursor or playhead crossing a pixel in a few
  // samples can't lift it; ink dimmed in a few samples can't erase it.
  const rankIdx = Math.floor(0.65 * (K - 1));
  const need = Math.ceil(0.6 * K);
  const gateT = 0.9 * tau;
  const vals = new Uint8Array(K);
  const v = new Uint8Array(n), gate = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let above = 0;
    for (let k = 0; k < K; k++) {
      const x = planes[k][i];
      vals[k] = x;
      if (x > gateT) above++;
    }
    sortSmall(vals, K);
    v[i] = vals[rankIdx];
    gate[i] = above >= need ? 1 : 0;
  }
  removeSmall(gate, w, h, Math.max(3, Math.round(0.02 * calib.dN * calib.dN)));
  const keep = dilate3(gate, w, h); // keep anti-aliased glyph edges
  const out = new Uint8Array(n).fill(255);
  const lo = 0.15 * C, span = 0.75 * C;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const a = Math.min(1, Math.max(0, (v[i] - lo) / span));
    out[i] = Math.round(255 * (1 - a ** 0.8));
  }
  return out;
}

export function renderColor(samples, w, h, calib) {
  const K = samples.length, n = w * h;
  if (K === 1) return { rgb: Uint8Array.from(samples[0]), tintedAll: 0 };
  const sats = samples.map((s) => {
    const o = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const r = s[j], g = s[j + 1], b = s[j + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      o[i] = mx - mn;
    }
    return o;
  });
  const satMin = new Uint8Array(n).fill(255);
  for (const s of sats) for (let i = 0; i < n; i++) if (s[i] < satMin[i]) satMin[i] = s[i];
  // Tinted = noticeably more saturated than this pixel's least saturated
  // sample. Closing joins glyph holes inside a highlight; the 2-px dilation
  // swallows 4:2:0 chroma bleed at its edges. Always-colored content (orange
  // chord names) has a high minimum and is never rejected.
  const rc = Math.max(1, Math.round(0.15 * calib.dN));
  const tmp = new Uint8Array(n);
  const tints = sats.map((s) => {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = s[i] - satMin[i] > 28 ? 1 : 0;
    const closed = morph(morph(m, w, h, rc, 'max', new Uint8Array(n), tmp), w, h, rc, 'min', new Uint8Array(n), tmp);
    return morph(closed, w, h, 2, 'max', new Uint8Array(n), tmp);
  });
  const lumas = samples.map(toGray);
  const out = new Uint8Array(3 * n);
  const idx = new Uint8Array(K);
  let tintedAll = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = 0; k < K; k++) if (!tints[k][i]) idx[m++] = k;
    let pick;
    if (m === 0) {
      tintedAll++;
      pick = 0;
      for (let k = 1; k < K; k++) if (sats[k][i] < sats[pick][i]) pick = k;
    } else {
      // median luma among untinted samples drops untinted transients (a white playhead)
      for (let a = 1; a < m; a++) {
        const key = idx[a], kv = lumas[key][i];
        let b = a - 1;
        while (b >= 0 && lumas[idx[b]][i] > kv) { idx[b + 1] = idx[b]; b--; }
        idx[b + 1] = key;
      }
      pick = idx[(m - 1) >> 1];
    }
    const j = 3 * i, s = samples[pick];
    out[j] = s[j];
    out[j + 1] = s[j + 1];
    out[j + 2] = s[j + 2];
  }
  return { rgb: out, tintedAll: tintedAll / n };
}

// ------------------------------------------------------------ self-check

async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const W = 200, H = 80, n = W * H;
  const calib = { polarity: 'dark', rH: 5, dN: 12, C: 210, tau: 80 };
  const bg = [22, 22, 26];
  const base = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) base.set(bg, 3 * i);
  const put = (f, x0, y0, x1, y1, c, a = 1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const j = 3 * (y * W + x);
        for (let k = 0; k < 3; k++) f[j + k] = Math.round(a * c[k] + (1 - a) * f[j + k]);
      }
    }
  };
  for (let i = 0; i < 6; i++) put(base, 10, 10 + 12 * i, 190, 12 + 12 * i, [160, 160, 160]);
  const glyphs = [[30, 6], [70, 30], [110, 42], [150, 66]];
  for (const [x, y] of glyphs) put(base, x, y, x + 4, y + 8, [235, 235, 235]);
  const clean = () => Uint8Array.from(base);

  // 11 samples: a blue measure highlight over x 20..90 in 6 of them (the case a
  // plain median fails), an orange cursor bar at a new x in every sample.
  const samples = [];
  for (let k = 0; k < 11; k++) {
    const f = clean();
    if (k < 6) put(f, 20, 2, 90, 78, [40, 110, 220], 0.45);
    put(f, 5 + k * 17, 0, 8 + k * 17, H, [255, 140, 0]);
    samples.push(f);
  }

  // 1. Clean print: white paper, dark glyphs and staff lines, no highlight
  //    or cursor residue.
  const cp = renderClean(samples, W, H, calib);
  assert.equal(cp[5 * W + 5], 255, 'margin must be paper white');
  assert.equal(cp[40 * W + 50], 255, 'highlight interior must be white');
  assert.ok(cp[34 * W + 72] < 90, `glyph under highlight must print dark (${cp[34 * W + 72]})`);
  assert.ok(cp[10 * W + 120] < 150, 'staff line must print');
  let residue = 0;
  for (let x = 0; x < W; x++) if (cp[50 * W + x] < 200 && !(x >= 110 && x < 114)) residue++;
  assert.ok(residue <= 2, `cursor residue on a glyph-free row: ${residue}`);

  // 2. Color: highlight and cursor rejected -> matches the clean frame.
  const { rgb } = renderColor(samples, W, H, calib);
  const ref = clean();
  let maxDiff = 0;
  for (let i = 0; i < rgb.length; i++) maxDiff = Math.max(maxDiff, Math.abs(rgb[i] - ref[i]));
  assert.ok(maxDiff <= 6, `color render must match the untinted page (maxDiff ${maxDiff})`);

  // 3. Always-orange chord text survives color rejection.
  const orange = samples.map((s) => { const f = Uint8Array.from(s); put(f, 150, 2, 170, 8, [250, 150, 30]); return f; });
  const oc = renderColor(orange, W, H, calib).rgb;
  const j = 3 * (4 * W + 160);
  assert.ok(oc[j] > 200 && oc[j + 2] < 80, 'persistent colored notation must stay colored');

  // 4. Light page polarity prints black on white too.
  const light = samples.map((s) => Uint8Array.from(s, (v) => 255 - v));
  const lp = renderClean(light, W, H, { ...calib, polarity: 'light' });
  assert.equal(lp[5 * W + 5], 255);
  assert.ok(lp[34 * W + 72] < 120);

  // 5. Sample picking and medians.
  assert.deepEqual(pickSampleFrames([1, 2, 3], 11), [1, 2, 3]);
  assert.equal(pickSampleFrames(Array.from({ length: 50 }, (_, i) => i), 11).length, 11);
  assert.deepEqual(Array.from(medianComposite([[1], [9], [5]])), [5]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
