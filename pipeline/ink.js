// Ink channel + morphology + mask metrics. Pure functions, no I/O.
//
// "Ink" is glyph intensity with polarity normalized so notation is always
// bright on dark: dark panels (white notes) use luma, light pages (black notes)
// use 255 - luma. Deliberately NOT chroma-rejecting: vvxo videos recolor
// played notes white -> orange, and min(R,G,B) would erase them. Colored
// overlays are handled structurally instead:
//   - a white top-hat (plane minus its morphological opening) deletes every
//     bright structure wider than the structuring element — translucent
//     measure highlights, guitar bodies, hands — keeping digits, staff lines,
//     chord dots;
//   - thin moving things (cursor bars, playheads) are removed temporally by
//     the pipeline's majority filter and rank compositing.
// Comparisons are changed-pixel counts on binary ink masks, normalized by ink,
// never MAD: sparse tab content dilutes MAD to nothing.
import { pathToFileURL } from 'node:url';

const luma = (r, g, b) => (r * 77 + g * 150 + b * 29) >> 8;

// Full-resolution ink plane.
export function inkPlane(rgb, w, h, polarity, out = new Uint8Array(w * h)) {
  const n = w * h;
  const flip = polarity === 'light' ? 255 : 0;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const y = luma(rgb[j], rgb[j + 1], rgb[j + 2]);
    out[i] = flip ? 255 - y : y;
  }
  return out;
}

// Half-resolution ink plane via 2x2 MAX-pool (a box filter would halve the
// contrast of 1-px strokes and staff lines). Odd trailing row/col dropped.
export function inkHalf(rgb, w, h, polarity, out = new Uint8Array((w >> 1) * (h >> 1))) {
  const w2 = w >> 1, h2 = h >> 1;
  const light = polarity === 'light';
  const px = (j) => {
    const y = luma(rgb[j], rgb[j + 1], rgb[j + 2]);
    return light ? 255 - y : y;
  };
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w, r1 = r0 + w;
    const o = y * w2;
    for (let x = 0; x < w2; x++) {
      const c = 2 * x;
      let m = px(3 * (r0 + c));
      let v = px(3 * (r0 + c + 1)); if (v > m) m = v;
      v = px(3 * (r1 + c)); if (v > m) m = v;
      v = px(3 * (r1 + c + 1)); if (v > m) m = v;
      out[o + x] = m;
    }
  }
  return out;
}

// Square-window min ('min' = erosion) or max ('max' = dilation) filter of
// radius r, separable van Herk / Gil-Werman: O(n) regardless of r. Pixels
// outside the image never win (padded with the identity value).
export function morph(src, w, h, r, op, out = new Uint8Array(w * h), tmp = new Uint8Array(w * h)) {
  const n = w * h;
  if (r <= 0) {
    out.set(src.subarray(0, n));
    return out;
  }
  const k = 2 * r + 1;
  const N = Math.ceil((Math.max(w, h) + 2 * r) / k) * k;
  const line = new Uint8Array(N), g = new Uint8Array(N), hh = new Uint8Array(N);
  const isMin = op === 'min';
  const pass = isMin ? pass1dMin : pass1dMax;
  for (let y = 0; y < h; y++) pass(src, y * w, 1, w, tmp, r, k, line, g, hh);
  for (let x = 0; x < w; x++) pass(tmp, x, w, h, out, r, k, line, g, hh);
  return out;
}

function pass1dMin(s, off, stride, n, d, r, k, line, g, hh) {
  const NN = Math.ceil((n + 2 * r) / k) * k;
  line.fill(255, 0, NN);
  for (let i = 0; i < n; i++) line[r + i] = s[off + i * stride];
  for (let i = 0; i < NN; i++) {
    const v = line[i];
    g[i] = i % k === 0 || v < g[i - 1] ? v : g[i - 1];
  }
  for (let i = NN - 1; i >= 0; i--) {
    const v = line[i];
    hh[i] = i % k === k - 1 || v < hh[i + 1] ? v : hh[i + 1];
  }
  const r2 = 2 * r;
  for (let i = 0; i < n; i++) {
    const a = hh[i], b = g[i + r2];
    d[off + i * stride] = a < b ? a : b;
  }
}

function pass1dMax(s, off, stride, n, d, r, k, line, g, hh) {
  const NN = Math.ceil((n + 2 * r) / k) * k;
  line.fill(0, 0, NN);
  for (let i = 0; i < n; i++) line[r + i] = s[off + i * stride];
  for (let i = 0; i < NN; i++) {
    const v = line[i];
    g[i] = i % k === 0 || v > g[i - 1] ? v : g[i - 1];
  }
  for (let i = NN - 1; i >= 0; i--) {
    const v = line[i];
    hh[i] = i % k === k - 1 || v > hh[i + 1] ? v : hh[i + 1];
  }
  const r2 = 2 * r;
  for (let i = 0; i < n; i++) {
    const a = hh[i], b = g[i + r2];
    d[off + i * stride] = a > b ? a : b;
  }
}

// White top-hat: src - opening(src). Opening is anti-extensive, so the result
// is never negative.
export function topHat(src, w, h, r, out = new Uint8Array(w * h), tmp = new Uint8Array(w * h)) {
  const eroded = morph(src, w, h, r, 'min', new Uint8Array(w * h), tmp);
  morph(eroded, w, h, r, 'max', out, tmp);
  for (let i = 0, n = w * h; i < n; i++) out[i] = src[i] - out[i];
  return out;
}

// Local contrast normalization of a top-hat plane. A translucent highlight at
// opacity a scales glyph contrast by (1 - a) in every channel; rescaling each
// pixel by the brightest ink within r restores it. The 0.75*C floor caps the
// gain at 1.33x so faint video texture behind overlays isn't lifted into ink.
export function localGain(th, w, h, r, C, out = new Uint8Array(w * h), tmp = new Uint8Array(w * h)) {
  const peak = morph(th, w, h, r, 'max', new Uint8Array(w * h), tmp);
  const floor = 0.75 * C;
  for (let i = 0, n = w * h; i < n; i++) {
    const p = peak[i] > floor ? peak[i] : floor;
    const v = (th[i] * C) / p;
    out[i] = v > 255 ? 255 : v;
  }
  return out;
}

// Binary mask (0/1) of src > tau.
export function threshold(src, tau, out = new Uint8Array(src.length)) {
  for (let i = 0; i < src.length; i++) out[i] = src[i] > tau ? 1 : 0;
  return out;
}

// 3x3 binary dilation (1-px jitter tolerance).
export function dilate3(mask, w, h, out = new Uint8Array(w * h), tmp) {
  return morph(mask, w, h, 1, 'max', out, tmp);
}

// mask AND NOT excl, as a new mask.
export function andNot(mask, excl) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] & (excl[i] ^ 1);
  return out;
}

export function countOnes(mask, excl = null) {
  let n = 0;
  if (excl === null) {
    for (let i = 0; i < mask.length; i++) n += mask[i];
  } else {
    for (let i = 0; i < mask.length; i++) if (!excl[i]) n += mask[i];
  }
  return n;
}

// Symmetric changed-ink between binary masks A and B with 1-px tolerance:
// changed = |A \ dil(B)| + |B \ dil(A)|, skipping excl pixels. Also reports
// how the change spreads over vertical bins `bin` px wide — a page flip changes
// most content-bearing bins, a chord box or a single note changes few.
// Bins count as content when they hold >= binInk ink pixels (A or B), and as
// changed when they hold >= binChange changed pixels. Empty crop area never
// enters any count, so results don't depend on how loosely the box was drawn.
// Exclusion is applied BEFORE dilation: excluded chrome (a static staff line)
// must not grant jitter tolerance to real changes next to it. Callers passing
// precomputed dilA/dilB must have dilated the already-excluded masks.
export function inkDiff(A, B, w, h, {
  excl = null, dilA = null, dilB = null, bin = 8, binInk = 1, binChange = 1,
} = {}) {
  if (excl !== null && (dilA === null || dilB === null)) {
    A = andNot(A, excl);
    B = andNot(B, excl);
  }
  dilA ??= dilate3(A, w, h);
  dilB ??= dilate3(B, w, h);
  const nb = Math.ceil(w / bin);
  const binCh = new Uint32Array(nb), binInkN = new Uint32Array(nb);
  let changed = 0, inkA = 0, inkB = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      const a = A[p], b = B[p];
      if ((a | b) === 0) continue;
      if (excl !== null && excl[p]) continue;
      const bi = (x / bin) | 0;
      inkA += a;
      inkB += b;
      binInkN[bi]++;
      if ((a && !dilB[p]) || (b && !dilA[p])) {
        changed++;
        binCh[bi]++;
      }
    }
  }
  let binsContent = 0, binsChanged = 0, clusters = 0, gap = 2;
  for (let i = 0; i < nb; i++) {
    if (binInkN[i] >= binInk) binsContent++;
    if (binCh[i] >= binChange) {
      binsChanged++;
      if (gap > 1) clusters++; // a 1-bin gap is bridged into the same cluster
      gap = 0;
    } else {
      gap++;
    }
  }
  return { changed, inkA, inkB, binsContent, binsChanged, clusters };
}

// 8-connected components of a binary mask. labels: 0 = background, 1..count.
// areas[label] = pixel count; bbox[label] = [x0, y0, x1, y1].
export function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const parent = [0];
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra > rb ? ra : rb] = ra > rb ? rb : ra;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (!mask[p]) continue;
      let m = 0;
      const nb = (q) => {
        const l = labels[q];
        if (l === 0) return;
        if (m === 0) m = l;
        else union(m, l);
      };
      if (x > 0) nb(p - 1);
      if (y > 0) {
        if (x > 0) nb(p - w - 1);
        nb(p - w);
        if (x < w - 1) nb(p - w + 1);
      }
      if (m === 0) {
        m = parent.length;
        parent.push(m);
      }
      labels[p] = m;
    }
  }
  const remap = new Int32Array(parent.length);
  let count = 0;
  for (let l = 1; l < parent.length; l++) {
    const root = find(l);
    if (remap[root] === 0) remap[root] = ++count;
    remap[l] = remap[root];
  }
  const areas = new Array(count + 1).fill(0);
  const bbox = Array.from({ length: count + 1 }, () => [w, h, -1, -1]);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (labels[p] === 0) continue;
      const l = remap[labels[p]];
      labels[p] = l;
      areas[l]++;
      const b = bbox[l];
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  return { labels, areas, bbox, count };
}

// Zero out components smaller than minArea (in place). Returns the mask.
export function removeSmall(mask, w, h, minArea) {
  if (minArea <= 1) return mask;
  const { labels, areas } = components(mask, w, h);
  for (let i = 0; i < mask.length; i++) if (mask[i] && areas[labels[i]] < minArea) mask[i] = 0;
  return mask;
}

// Drop components that can't be notation from a comparison mask: anything
// spanning >= 2.5 line spacings wide AND >= 1.5 tall (edges and curves of live
// video behind an overlay — a guitar body, a sleeve, a hand), or a huge blob.
// Fret numbers, chord names, slides, ties and arpeggio marks are smaller in at
// least one dimension; beamed stem groups may go too, which only costs rhythm
// detail in screen comparisons. Use on masks with static staff lines already
// removed (lines would join everything into one component).
export function dropNonGlyph(mask, w, h, d) {
  const { labels, bbox, areas, count } = components(mask, w, h);
  const kill = new Uint8Array(count + 1);
  let killed = 0;
  for (let l = 1; l <= count; l++) {
    const bw = bbox[l][2] - bbox[l][0] + 1, bh = bbox[l][3] - bbox[l][1] + 1;
    if ((bw >= 2.5 * d && bh >= 1.5 * d) || areas[l] >= 6 * d * d) {
      kill[l] = 1;
      killed++;
    }
  }
  if (killed) for (let i = 0; i < mask.length; i++) if (kill[labels[i]]) mask[i] = 0;
  return killed;
}

// Ink count per cell x cell block (coarse page signature).
export function cellSig(mask, w, h, cell, out = null) {
  const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
  out ??= new Uint16Array(cw * ch);
  out.fill(0);
  for (let y = 0; y < h; y++) {
    const row = y * w, crow = ((y / cell) | 0) * cw;
    for (let x = 0; x < w; x++) if (mask[row + x]) out[crow + ((x / cell) | 0)]++;
  }
  return out;
}

// Zero playback-cursor bars in an ink plane: tall, narrow, densely tinted
// vertical bands (a cursor that pauses at the end of the staff survives the
// temporal filters) and slivers of a measure highlight clipped by the crop.
// Found per column rather than per connected component — digits and staff
// lines crossing a cursor chop it into short pieces. Stacks of colored notes
// (recolored as played) are strokes, not filled bands, and stay. Only tinted
// pixels (and their 1-px chroma fringe) are zeroed, so white digits under a
// translucent cursor survive. plane is (w/scale) x (h/scale); rgb is the
// full-res crop; d is the line spacing in plane pixels. Returns bars removed.
export function suppressTintedBars(plane, rgb, w, h, scale, d) {
  const pw = Math.floor(w / scale), ph = Math.floor(h / scale);
  const tint = new Uint8Array(pw * ph);
  const col = new Uint32Array(pw);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let s = 0;
      for (let dy = 0; dy < scale; dy++) {
        let j = 3 * ((y * scale + dy) * w + x * scale);
        for (let dx = 0; dx < scale; dx++, j += 3) {
          const r = rgb[j], g = rgb[j + 1], b = rgb[j + 2];
          const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
          const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
          if (mx - mn > s) s = mx - mn;
        }
      }
      if (s > 70) {
        tint[y * pw + x] = 1;
        col[x]++;
      }
    }
  }
  // A cursor is a filled band at least ~0.4 line spacings wide; the edge
  // columns of stacked "0"s look like dashed lines but are 1-2 px wide.
  const minH = 2.5 * d, maxW = Math.ceil(1.5 * d), minW = Math.max(3, Math.round(0.4 * d));
  let killed = 0;
  for (let x0 = 0; x0 < pw;) {
    if (col[x0] < minH) { x0++; continue; }
    let x1 = x0;
    while (x1 + 1 < pw && col[x1 + 1] >= minH) x1++;
    const bw = x1 - x0 + 1;
    if (bw >= minW && bw <= maxW) {
      let y0 = -1, y1 = -1;
      for (let y = 0; y < ph; y++) {
        let c = 0;
        for (let x = x0; x <= x1; x++) c += tint[y * pw + x];
        if (2 * c >= bw) {
          if (y0 < 0) y0 = y;
          y1 = y;
        }
      }
      if (y0 >= 0 && y1 - y0 + 1 >= minH) {
        let inside = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) inside += tint[y * pw + x];
        if (inside >= 0.55 * bw * (y1 - y0 + 1)) {
          const xa = Math.max(0, x0 - 2), xb = Math.min(pw - 1, x1 + 2);
          for (let y = y0; y <= y1; y++) {
            const row = y * pw;
            for (let x = xa; x <= xb; x++) {
              if (tint[row + x] || (x > 0 && tint[row + x - 1]) || (x + 1 < pw && tint[row + x + 1])) plane[row + x] = 0;
            }
          }
          killed++;
        }
      }
    }
    x0 = x1 + 1;
  }
  return killed;
}

// Largest sum over any 2x2 window of a cw x ch count grid (a glyph-sized change
// straddling cell borders still lands in one window).
export function maxWindow2x2(counts, cw, ch) {
  let m = 0;
  const xs = Math.max(1, cw - 1), ys = Math.max(1, ch - 1);
  for (let y = 0; y < ys; y++) {
    for (let x = 0; x < xs; x++) {
      let s = counts[y * cw + x];
      if (x + 1 < cw) s += counts[y * cw + x + 1];
      if (y + 1 < ch) {
        s += counts[(y + 1) * cw + x];
        if (x + 1 < cw) s += counts[(y + 1) * cw + x + 1];
      }
      if (s > m) m = s;
    }
  }
  return m;
}

// q-quantile (0..1) of Uint8 data via histogram; mask restricts the sample.
export function quantile8(src, q, mask = null, step = 1) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < src.length; i += step) {
    if (mask !== null && !mask[i]) continue;
    hist[src[i]]++;
    n++;
  }
  if (n === 0) return 0;
  const target = q * (n - 1);
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > target) return v;
  }
  return 255;
}

async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  // 1. VHGW morph == naive window min/max, all edge cases.
  const naive = (src, w, h, r, op) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = op === 'min' ? 255 : 0;
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
            const s = src[yy * w + xx];
            v = op === 'min' ? Math.min(v, s) : Math.max(v, s);
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  for (const [w, h] of [[1, 1], [5, 3], [17, 9], [40, 23]]) {
    const src = Uint8Array.from({ length: w * h }, () => Math.floor(rnd() * 256));
    for (const r of [1, 2, 4, 7]) {
      for (const op of ['min', 'max']) {
        assert.deepEqual(morph(src, w, h, r, op), naive(src, w, h, r, op), `morph ${op} ${w}x${h} r${r}`);
      }
      const th = topHat(src, w, h, r);
      const open = naive(naive(src, w, h, r, 'min'), w, h, r, 'max');
      assert.deepEqual(th, Uint8Array.from(src, (v, i) => v - open[i]), `topHat ${w}x${h} r${r}`);
    }
  }

  // 2. Polarity: notation is bright in ink space either way, and notes that
  //    get recolored when played (white -> orange) stay well above the panel.
  const px = (...c) => Uint8Array.from(c);
  assert.ok(inkPlane(px(240, 240, 240), 1, 1, 'dark')[0] >= 238);
  assert.ok(inkPlane(px(255, 140, 0), 1, 1, 'dark')[0] > 140, 'orange notes must stay ink');
  assert.ok(inkPlane(px(10, 10, 10), 1, 1, 'light')[0] >= 244);
  assert.ok(inkPlane(px(250, 250, 250), 1, 1, 'light')[0] <= 6);

  // 3. Max-pool keeps a 1-px line on an odd row.
  {
    const W = 16, H = 16;
    const rgb = new Uint8Array(W * H * 3).fill(15);
    for (let x = 0; x < W; x++) rgb.fill(230, 3 * (7 * W + x), 3 * (7 * W + x) + 3);
    const half = inkHalf(rgb, W, H, 'dark');
    for (let x = 0; x < 8; x++) assert.equal(half[3 * 8 + x], 230);
  }

  // 4. Measure highlight: white strokes on a dark panel, a translucent blue
  //    block (alpha 0.6) over part of them. After inkHalf -> topHat -> gain,
  //    every stroke clears the ink threshold and the block interior doesn't.
  {
    const W = 240, H = 90, bg = 20;
    const rgb = new Uint8Array(W * H * 3).fill(bg);
    const strokes = [];
    for (let i = 0; i < 10; i++) strokes.push([12 + i * 22, 30 + (i % 3) * 12]);
    for (const [sx, sy] of strokes) {
      for (let y = sy; y < sy + 12; y++) {
        for (let x = sx; x < sx + 3; x++) rgb.fill(240, 3 * (y * W + x), 3 * (y * W + x) + 3);
      }
    }
    const blue = [40, 110, 220], a = 0.6;
    for (let y = 6; y < 84; y++) {
      for (let x = 50; x < 150; x++) {
        const j = 3 * (y * W + x);
        for (let c = 0; c < 3; c++) rgb[j + c] = Math.round(a * blue[c] + (1 - a) * rgb[j + c]);
      }
    }
    const w2 = W >> 1, h2 = H >> 1;
    const e = inkHalf(rgb, W, H, 'dark');
    const th = topHat(e, w2, h2, 5);
    const C = 220;
    const g = localGain(th, w2, h2, 15, C);
    const tau = 0.38 * C;
    for (const [sx, sy] of strokes) {
      assert.ok(g[((sy + 6) >> 1) * w2 + ((sx + 1) >> 1)] > tau, `stroke at ${sx} lost under highlight`);
    }
    for (const [x, y] of [[60, 12], [140, 80], [100, 14]]) {
      assert.ok(g[(y >> 1) * w2 + (x >> 1)] < 0.1 * C, `highlight interior survived at ${x},${y}`);
    }
  }

  // 5. inkDiff: a 1-px shift is ~unchanged, an unrelated sparse page is all
  //    change, and padding the crop with 3x empty area changes nothing.
  {
    const W = 120, H = 60;
    const page = (s) => {
      seed = s;
      const m = new Uint8Array(W * H);
      for (let i = 0; i < 40; i++) {
        const x0 = 2 + Math.floor(rnd() * (W - 8)), y0 = 2 + Math.floor(rnd() * (H - 8));
        for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 2; x++) m[y * W + x] = 1;
      }
      return m;
    };
    const A = page(7), B = page(99);
    const shifted = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) shifted[y * W + x] = A[y * W + x - 1];
    const ratio = (d) => d.changed / Math.max(d.inkA, d.inkB);
    assert.ok(ratio(inkDiff(A, shifted, W, H)) < 0.05, '1-px shift must read as same');
    const flip = inkDiff(A, B, W, H, { bin: 6 });
    assert.ok(ratio(flip) >= 1, 'sparse flip must read as change');

    const pad = (m) => {
      const out = new Uint8Array(4 * W * H);
      for (let y = 0; y < H; y++) out.set(m.subarray(y * W, (y + 1) * W), y * 4 * W + W);
      return out;
    };
    const flipPad = inkDiff(pad(A), pad(B), 4 * W, H, { bin: 6 });
    assert.equal(flipPad.changed, flip.changed);
    assert.equal(flipPad.inkA, flip.inkA);
    assert.equal(flipPad.binsChanged / flipPad.binsContent, flip.binsChanged / flip.binsContent,
      'bin spread must not depend on empty crop area');

    // exclusion removes static chrome from every count
    const chrome = Uint8Array.from(A);
    for (let x = 0; x < W; x++) chrome[30 * W + x] = 1;
    const excl = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) excl[30 * W + x] = 1;
    assert.deepEqual(inkDiff(chrome, B, W, H, { bin: 6, excl }), inkDiff(A, B, W, H, { bin: 6, excl }));
  }

  // 6. components: diagonal pixels join under 8-connectivity; areas and
  //    removeSmall are exact.
  {
    const W = 8, H = 6;
    const m = new Uint8Array(W * H);
    for (const [x, y] of [[0, 0], [1, 1], [2, 2], [6, 0], [6, 1], [7, 1], [4, 5]]) m[y * W + x] = 1;
    const c = components(m, W, H);
    assert.equal(c.count, 3);
    assert.deepEqual(c.areas.slice(1).sort(), [1, 3, 3]);
    removeSmall(m, W, H, 2);
    assert.equal(countOnes(m), 6);
  }

  // 7. Cursor bars: a filled orange bar chopped by white digits and gray
  //    lines is removed (digits stay); a column of orange strokes is kept.
  {
    const W = 120, H = 80, d = 8;
    const rgb = new Uint8Array(W * H * 3).fill(30);
    const put = (x0, y0, x1, y1, c) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgb.set(c, 3 * (y * W + x)); };
    put(40, 4, 50, 76, [220, 120, 40]);                      // cursor bar, 10 px wide
    for (let y = 10; y < 76; y += 12) put(0, y, W, y + 1, [150, 150, 150]); // staff lines cross it
    put(42, 30, 48, 40, [240, 240, 240]);                    // a white digit under the cursor
    const orange = [250, 140, 30];
    for (let y = 6; y < 72; y += 11) { // a stack of orange "0"s
      put(88, y, 94, y + 1, orange); put(88, y + 8, 94, y + 9, orange);
      put(88, y, 89, y + 9, orange); put(93, y, 94, y + 9, orange);
    }
    const plane = new Uint8Array(W * H).fill(200);
    assert.equal(suppressTintedBars(plane, rgb, W, H, 1, d), 1);
    assert.equal(plane[20 * W + 44], 0, "cursor pixels removed");
    assert.equal(plane[35 * W + 45], 200, "white digit under the cursor kept");
    assert.equal(plane[10 * W + 88], 200, "orange note stack kept");
  }

  // 8. dropNonGlyph: a long curved edge goes, digits and a hammer-on run stay.
  {
    const W = 120, H = 60, d = 8;
    const m = new Uint8Array(W * H);
    for (let x = 10; x < 70; x++) { const y = Math.round(10 + 12 * Math.sin((x - 10) / 19)); m[y * W + x] = 1; m[(y + 1) * W + x] = 1; }
    for (const x0 of [80, 90, 100]) for (let y = 40; y < 48; y++) { m[y * W + x0] = 1; m[y * W + x0 + 4] = 1; }
    for (let x = 20; x < 44; x++) m[45 * W + x] = 1; // "0h2h4" style run: wide but short
    assert.equal(dropNonGlyph(m, W, H, d), 1);
    assert.equal(m[45 * W + 30], 1);
    assert.equal(m[44 * W + 84], 1);
  }

  // 9. quantile8 / cellSig basics.
  assert.equal(quantile8(Uint8Array.from([0, 10, 20, 30, 40]), 0.5), 20);
  assert.deepEqual(Array.from(cellSig(Uint8Array.from([1, 1, 0, 1]), 2, 2, 1)), [1, 1, 0, 1]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
