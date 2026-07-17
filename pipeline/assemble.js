// Assembly: flip/scroll/duplicate classification (1-D NCC candidates + 2-D
// diff-fraction verification), strip stitching, duplicate-set median, dHash
// global dedup. All 2-D comparisons use diffFrac (changed-pixel count), not
// MAD: sparse tab content dilutes MAD toward zero even across a page flip.
import { pathToFileURL } from 'node:url';
import { medianComposite, toGray, diffFrac } from './composite.js';

export const DUP_FRAC = 0.012;   // below: images are the same content
export const SCROLL_FRAC = 0.02; // below (at dy>2): a trustworthy scroll match
const MAX_STRIP_H = 65000;
const NCC_MIN_DY = -8;

// Horizontal gradient energy per row: immune to lighting, structured by glyphs.
export function rowGradProfile(gray, w, h) {
  const G = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x < w - 1; x++) s += Math.abs(gray[row + x + 1] - gray[row + x]);
    G[y] = s / w;
  }
  return G;
}

// Candidate dy offsets (B[y] ~ A[y+dy]): top-3 NCC local maxima > 0.5, plus dy=0.
export function nccCandidates(GA, GB, h, minOverlap) {
  const lo = NCC_MIN_DY, hi = h - minOverlap;
  if (hi < lo) return [{ dy: 0, score: 0 }];
  const sc = new Float64Array(hi - lo + 1).fill(-1);
  for (let dy = lo; dy <= hi; dy++) {
    const y0 = Math.max(0, -dy), y1 = h - 1 - Math.max(0, dy);
    const n = y1 - y0 + 1;
    if (n < minOverlap) continue;
    let ma = 0, mb = 0;
    for (let y = y0; y <= y1; y++) { ma += GA[y + dy]; mb += GB[y]; }
    ma /= n;
    mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let y = y0; y <= y1; y++) {
      const a = GA[y + dy] - ma, b = GB[y] - mb;
      sab += a * b;
      saa += a * a;
      sbb += b * b;
    }
    sc[dy - lo] = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
  }
  const cands = [];
  for (let i = 0; i < sc.length; i++) {
    if (sc[i] > 0.5
      && (i === 0 || sc[i] >= sc[i - 1])
      && (i === sc.length - 1 || sc[i] > sc[i + 1])) {
      cands.push({ dy: i + lo, score: sc[i] });
    }
  }
  cands.sort((p, q) => q.score - p.score);
  const out = cands.slice(0, 3);
  if (!out.some((c) => c.dy === 0)) out.push({ dy: 0, score: sc[-lo] ?? 0 });
  return out;
}

// Changed-pixel fraction between B and A shifted by dy, over their overlap.
// Full resolution and native-pixel dy: quarter-res verification both dilutes
// sparse glyphs and rounds odd offsets into misalignment. Global luma bias is
// removed first (autoexposure drift between runs). maskHalf is the half-res
// pass-1 exclude mask; a pixel masked at either aligned position is skipped.
export function diffFracAtOffset(A, B, w, h, dy, maskHalf = null, T = 24) {
  const y0 = Math.max(0, -dy), y1 = h - 1 - Math.max(0, dy);
  if (y1 < y0) return 1;
  const w2 = w >> 1;
  const masked = maskHalf === null
    ? null
    : (x, y) => maskHalf[(y >> 1) * w2 + (x >> 1)] || maskHalf[((y + dy) >> 1) * w2 + (x >> 1)];
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    const ra = (y + dy) * w, rb = y * w;
    for (let x = 0; x < w; x++) {
      if (masked !== null && masked(x, y)) continue;
      sum += B[rb + x] - A[ra + x];
      n++;
    }
  }
  if (n === 0) return 1;
  const bias = Math.max(-16, Math.min(16, sum / n));
  let changed = 0;
  for (let y = y0; y <= y1; y++) {
    const ra = (y + dy) * w, rb = y * w;
    for (let x = 0; x < w; x++) {
      if (masked !== null && masked(x, y)) continue;
      if (Math.abs(B[rb + x] - A[ra + x] - bias) > T) changed++;
    }
  }
  return changed / n;
}

// A, B: {gray, ...} full-res composites of identical w x h.
export function classifyAdvance(A, B, { w, h, minOverlap, maskHalf = null }) {
  const cands = nccCandidates(rowGradProfile(A.gray, w, h), rowGradProfile(B.gray, w, h), h, minOverlap);
  let best = null;
  for (const c of cands) {
    if (Math.abs(c.dy) >= h) continue;
    const f = diffFracAtOffset(A.gray, B.gray, w, h, c.dy, maskHalf);
    if (best === null || f < best.frac) best = { dy: c.dy, frac: f };
  }
  if (best === null) return { type: 'PAGE_FLIP', dy: 0, frac: 1 };
  if (Math.abs(best.dy) <= 2 && best.frac < DUP_FRAC) return { type: 'DUPLICATE', dy: best.dy, frac: best.frac };
  if (best.dy > 2 && best.frac < SCROLL_FRAC && h - best.dy >= minOverlap) {
    return { type: 'SCROLL', dy: best.dy, frac: best.frac };
  }
  return { type: 'PAGE_FLIP', dy: best.dy, frac: best.frac };
}

// 64-bit dHash: 9x8 box downscale, horizontal gradient sign. Returns [lo32, hi32].
export function dHash(gray, w, h) {
  const gw = 9, gh = 8;
  const vals = new Float64Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy * h) / gh), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * w) / gw), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / gw));
      let s = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) s += gray[row + x];
      }
      vals[gy * gw + gx] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  let a = 0, b = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const bit = vals[gy * gw + gx + 1] > vals[gy * gw + gx] ? 1 : 0;
      const i = gy * 8 + gx;
      if (i < 32) a = ((a << 1) | bit) >>> 0;
      else b = ((b << 1) | bit) >>> 0;
    }
  }
  return [a, b];
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

export function hamming(h1, h2) {
  return popcount((h1[0] ^ h2[0]) >>> 0) + popcount((h1[1] ^ h2[1]) >>> 0);
}

// composites: time-ordered [{rgb, gray, tStart, tEnd}], all w x h.
// maskHalf: optional half-res exclude mask from pass 1.
// Returns capture drafts: {type:'page'|'strip', rgb, w, h, tStart, tEnd, alsoAt,
// parts?: [{rgb, w, h, dy, tStart, tEnd}]}. PNG writing is the caller's job.
export function assemble(composites, { w, h, maskHalf = null } = {}) {
  const minOverlap = Math.max(24, Math.round(0.12 * h));

  // Segment into strips; each slot is a duplicate-set at one scroll offset.
  const segments = [];
  let seg = null;
  for (const C of composites) {
    if (seg === null) {
      seg = [{ comps: [C], offset: 0 }];
      continue;
    }
    const lastSlot = seg[seg.length - 1];
    const ref = lastSlot.comps[lastSlot.comps.length - 1];
    const adv = classifyAdvance(ref, C, { w, h, minOverlap, maskHalf });
    if (adv.type === 'DUPLICATE') {
      lastSlot.comps.push(C);
    } else if (adv.type === 'SCROLL' && lastSlot.offset + adv.dy + h <= MAX_STRIP_H) {
      seg.push({ comps: [C], offset: lastSlot.offset + adv.dy });
    } else {
      segments.push(seg);
      seg = [{ comps: [C], offset: 0 }];
    }
  }
  if (seg !== null) segments.push(seg);

  // Resolve a duplicate-set: median across >= 3 near-duplicates erases
  // persistent highlights; with 2 keep the first.
  const resolveSlot = (slot) => {
    const cs = slot.comps;
    const rgb = cs.length >= 3 ? medianComposite(cs.map((c) => c.rgb)) : cs[0].rgb;
    return {
      rgb,
      gray: cs.length >= 3 ? toGray(rgb) : cs[0].gray,
      dy: slot.offset,
      tStart: cs[0].tStart,
      tEnd: cs[cs.length - 1].tEnd,
    };
  };

  const drafts = [];
  for (const slots of segments) {
    const parts = slots.map(resolveSlot);
    if (parts.length === 1) {
      const p = parts[0];
      drafts.push({ type: 'page', rgb: p.rgb, gray: p.gray, w, h, tStart: p.tStart, tEnd: p.tEnd, alsoAt: [] });
    } else {
      const stripH = parts[parts.length - 1].dy + h;
      const rgb = new Uint8Array(3 * w * stripH);
      // later pastes overwrite the overlap: every region comes from one composite
      for (const p of parts) rgb.set(p.rgb, 3 * w * p.dy);
      drafts.push({
        type: 'strip',
        rgb,
        w,
        h: stripH,
        tStart: parts[0].tStart,
        tEnd: parts[parts.length - 1].tEnd,
        parts: parts.map((p) => ({ rgb: p.rgb, w, h, dy: p.dy, tStart: p.tStart, tEnd: p.tEnd })),
        alsoAt: [],
      });
    }
  }

  // Global dedup: dHash prefilter, full-res diff-fraction confirm; repeats
  // recorded in alsoAt.
  const out = [];
  for (const d of drafts) {
    const gray = d.gray ?? toGray(d.rgb);
    const hash = dHash(gray, d.w, d.h);
    let dup = null;
    for (const prior of out) {
      if (prior.w !== d.w || prior.h !== d.h) continue;
      if (hamming(prior._hash, hash) > 6) continue;
      if (diffFrac(prior._gray, gray) < DUP_FRAC) { dup = prior; break; }
    }
    if (dup) {
      dup.alsoAt.push(d.tStart);
    } else {
      d._hash = hash;
      d._gray = gray;
      out.push(d);
    }
  }
  for (const d of out) {
    delete d._hash;
    delete d._gray;
    delete d.gray;
  }
  return out;
}

async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const W = 120, H = 200;

  // Virtual infinite tab page: 6-line staves (8px line spacing, 60px systems),
  // glyph marks at per-line pseudo-random x. Gives the 1-D profile a genuine
  // staff-periodicity alias while 2-D content differs between systems.
  const markCache = new Map();
  const marksFor = (sys, line) => {
    const key = sys * 16 + line;
    let m = markCache.get(key);
    if (!m) {
      let s = ((key + 1) * 2654435761) >>> 0 || 1;
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      m = Array.from({ length: 8 }, () => 2 + Math.floor(rnd() * (W - 6)));
      markCache.set(key, m);
    }
    return m;
  };
  const pix = (x, y) => {
    const sys = Math.floor(y / 60), inSys = y - sys * 60;
    if (inSys % 8 === 0 && inSys / 8 < 6) {
      for (const mx of marksFor(sys, inSys / 8)) if (x >= mx && x < mx + 2) return 20;
      return 120;
    }
    return 235;
  };
  const renderGray = (y0, hh = H) => {
    const g = new Uint8Array(W * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < W; x++) g[y * W + x] = pix(x, y0 + y);
    return g;
  };
  const grayToRgb = (g) => {
    const rgb = new Uint8Array(g.length * 3);
    for (let i = 0; i < g.length; i++) rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = g[i];
    return rgb;
  };
  const comp = (g, t0, t1) => ({ rgb: grayToRgb(g), gray: g, tStart: t0, tEnd: t1 });
  const randGray = (seed) => {
    let s = seed >>> 0 || 1;
    const g = new Uint8Array(W * H);
    for (let i = 0; i < g.length; i++) g[i] = ((s = (s * 1664525 + 1013904223) >>> 0) >>> 8) & 0xff;
    return g;
  };

  const baseG = renderGray(0);        // rows 0..199
  const scrollG = renderGray(40);     // rows 40..239: true dy = 40
  const minOverlap = Math.max(24, Math.round(0.12 * H));

  // 1. The staff-line alias must genuinely exist in the 1-D candidates...
  const GA = rowGradProfile(baseG, W, H);
  const GB = rowGradProfile(scrollG, W, H);
  const cands = nccCandidates(GA, GB, H, minOverlap);
  assert.ok(cands.some((c) => c.dy === 40), 'true offset must be a candidate');
  assert.ok(cands.some((c) => c.dy !== 40 && c.dy > 2 && c.score > 0.5),
    'staff periodicity must produce a rival 1-D candidate (the trap is real)');

  // ...and 2-D MAD verification must reject it.
  let adv = classifyAdvance({ gray: baseG }, { gray: scrollG }, { w: W, h: H, minOverlap });
  assert.equal(adv.type, 'SCROLL');
  assert.equal(adv.dy, 40);

  // 2. Unrelated content -> PAGE_FLIP; identical -> DUPLICATE.
  const noiseG = randGray(7);
  adv = classifyAdvance({ gray: baseG }, { gray: noiseG }, { w: W, h: H, minOverlap });
  assert.equal(adv.type, 'PAGE_FLIP');
  adv = classifyAdvance({ gray: baseG }, { gray: Uint8Array.from(baseG) }, { w: W, h: H, minOverlap });
  assert.equal(adv.type, 'DUPLICATE');

  // 2b. Sparse-content regression (the MAD trap): two mostly-white pages that
  // share identical staff lines and differ ONLY in sparse marks are a flip —
  // their mean abs diff is tiny, but the changed-pixel fraction is not.
  const sparsePage = (seed, y0 = 0) => {
    let s = seed >>> 0 || 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const marks = Array.from({ length: 90 }, () => [Math.floor(rnd() * (W - 3)), Math.floor(rnd() * (H + 60 - 5))]);
    const g = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const gy = y + y0;
      for (let x = 0; x < W; x++) g[y * W + x] = gy % 8 === 0 ? 140 : 255; // shared staff lines
    }
    for (const [mx, my] of marks) {
      if (my < y0 || my + 4 > y0 + H) continue;
      for (let y = my - y0; y < my - y0 + 4; y++) for (let x = mx; x < mx + 3; x++) g[y * W + x] = 0;
    }
    return g;
  };
  const sparseA = sparsePage(101), sparseB = sparsePage(202);
  adv = classifyAdvance({ gray: sparseA }, { gray: sparseB }, { w: W, h: H, minOverlap });
  assert.equal(adv.type, 'PAGE_FLIP', 'sparse flip must not read as duplicate/scroll');
  adv = classifyAdvance({ gray: sparsePage(101) }, { gray: sparsePage(101, 40) }, { w: W, h: H, minOverlap });
  assert.equal(adv.type, 'SCROLL', 'sparse scroll must still match');
  assert.equal(adv.dy, 40);

  // 3. Full assembly: dup-set median erases moving highlight, scroll stitches,
  //    flip splits, identical strip is globally deduped.
  const withSquare = (g, sx, sy) => {
    const f = Uint8Array.from(g);
    for (let y = sy; y < sy + 8; y++) for (let x = sx; x < sx + 8; x++) f[y * W + x] = 255;
    return f;
  };
  const composites = [
    comp(withSquare(baseG, 10, 4), 0, 5),
    comp(withSquare(baseG, 60, 16), 5, 10),
    comp(withSquare(baseG, 90, 28), 10, 15),
    comp(scrollG, 15, 20),
    comp(noiseG, 20, 25),
    comp(Uint8Array.from(baseG), 25, 30),
    comp(Uint8Array.from(scrollG), 30, 35),
  ];
  const captures = assemble(composites, { w: W, h: H });
  assert.equal(captures.length, 2, 'expected strip + noise page after dedup');

  const strip = captures[0];
  assert.equal(strip.type, 'strip');
  assert.equal(strip.h, 240);
  assert.equal(strip.parts.length, 2);
  assert.equal(strip.parts[0].dy, 0);
  assert.equal(strip.parts[1].dy, 40);
  assert.equal(strip.tStart, 0);
  assert.equal(strip.tEnd, 20);
  // dup-set median erased all three highlight squares; seam invisible by construction
  assert.deepEqual(strip.rgb, grayToRgb(renderGray(0, 240)));
  assert.deepEqual(strip.alsoAt, [25], 'repeat strip must be recorded, not re-emitted');

  assert.equal(captures[1].type, 'page');
  assert.equal(captures[1].tStart, 20);
  assert.deepEqual(captures[1].alsoAt, []);

  // 4. dHash sanity: identical images collide, unrelated ones do not.
  assert.equal(hamming(dHash(baseG, W, H), dHash(Uint8Array.from(baseG), W, H)), 0);
  assert.ok(hamming(dHash(baseG, W, H), dHash(noiseG, W, H)) > 6);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
