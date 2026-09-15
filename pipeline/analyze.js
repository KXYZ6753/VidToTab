// Pass 1 over the ink cache (half-res, top-hat, gain-normalized planes):
// temporal majority filter, static + hot exclusion, pair classification, run
// segmentation, change-point refinement, and per-run representative masks.
// Pure JS over a re-iterable frame source; no decoding happens here.
//
// Measured on the target videos: after the majority filter a screen that is
// holding still changes by <= 1% of its ink with <= ~20 changed pixels in any
// glyph-sized window, while real page flips — even ones that only swap a few
// fret numbers — change 7-90% of the ink or put 100+ changed pixels in one
// window. The thresholds below sit in that gap.
import { pathToFileURL } from 'node:url';
import { cellSig, countOnes, dilate3, maxWindow2x2, morph } from './ink.js';

export const FPS = 4;
const MAJ = 7; // majority window (frames); ink must persist >= 4 of 7 (1 s at 4 fps)

const lerp = (a, b, t) => a + (b - a) * t;

export function knobs(sensitivity = 0.5) {
  const s = Math.min(1, Math.max(0, Number(sensitivity) || 0));
  return {
    ratioT: lerp(0.25, 0.08, s),       // pair: changed ink / ink above this = new screen
    minorRatio: lerp(0.06, 0.025, s),  // ...or above this AND a glyph-sized local change
    cellK: lerp(0.35, 0.15, s),        // glyph-sized: changed px in a 2x2 cell window, x dH^2
    minRunS: lerp(1.25, 0.5, s),       // shortest screen kept, seconds
    cpT: lerp(0.5, 0.3, s),            // in-run change-point threshold (cell signatures)
    pageRatioT: lerp(0.12, 0.04, s),   // runs showing the same screen differ by less
  };
}

export function pct(values, q) {
  if (values.length === 0) return 0;
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

// pairs: [{cls, weak}], pair i connects frames i and i+1.
// Returns runs as inclusive frame-index ranges {startF, endF, nFrames}.
export function segmentRuns(pairs, { minRunS, fps = FPS }) {
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
      // A lone weak transition inside a run is forgiven as a hiccup; a strong
      // one — or a second weak one — closes the run.
      if (pairs[i].weak && pending < 0) {
        pending = i;
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

// Split runs that hide a gradual change (cross-fades, slow reveals): compare
// cell signatures `lag` frames apart; a clear peak splits at its centre.
export function refineRuns(runs, sigs, { cpT, floor, lag = 8, minFrames = 4 }) {
  const dist = (a, b) => {
    let s = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      s += Math.abs(a[i] - b[i]);
      na += a[i];
      nb += b[i];
    }
    return s / Math.max(na, nb, floor, 1);
  };
  const out = [];
  const rec = (r) => {
    const L = Math.min(lag, Math.floor(r.nFrames / 3));
    if (L >= 3) {
      let best = -1, bestD = 0;
      for (let t = r.startF; t + L <= r.endF; t++) {
        const d = dist(sigs[t], sigs[t + L]);
        if (d > bestD) { bestD = d; best = t; }
      }
      if (bestD > cpT) {
        const cut = best + Math.ceil(L / 2);
        if (cut - r.startF >= minFrames && r.endF - cut + 1 >= minFrames) {
          rec({ startF: r.startF, endF: cut - 1, nFrames: cut - r.startF });
          rec({ startF: cut, endF: r.endF, nFrames: r.endF - cut + 1 });
          return;
        }
      }
    }
    out.push(r);
  };
  for (const r of runs) rec(r);
  return out;
}

// Centered MAJ-frame majority of binary ink masks; the first and last frames
// are replicated at the edges so every frame gets a full window. Removes ink
// present for fewer than half the window — cursor bars, playheads, flicker —
// while an instant page change still lands in a single step. Also yields the
// raw center plane.
async function* majoritySweep(makeFrames, P, tau) {
  const half = MAJ >> 1, need = half + 1;
  const ring = [], raws = [];
  const count = new Uint8Array(P);
  const push = (m, g) => {
    ring.push(m);
    raws.push(g);
    for (let i = 0; i < P; i++) count[i] += m[i];
    if (ring.length > MAJ) {
      const o = ring.shift();
      raws.shift();
      for (let i = 0; i < P; i++) count[i] -= o[i];
    }
  };
  let t = 0, last = null, lastRaw = null;
  const emit = () => {
    const full = new Uint8Array(P);
    for (let i = 0; i < P; i++) full[i] = count[i] >= need ? 1 : 0;
    return { t: t++, full, raw: raws[half] };
  };
  for await (const g of makeFrames()) {
    const m = new Uint8Array(P);
    for (let i = 0; i < P; i++) m[i] = g[i] > tau ? 1 : 0;
    if (last === null) for (let k = 0; k < half; k++) push(m, g);
    push(m, g);
    last = m;
    lastRaw = g;
    if (ring.length === MAJ) yield emit();
  }
  if (last === null) return;
  for (let k = 0; k < half; k++) {
    push(last, lastRaw);
    if (ring.length === MAJ) yield emit();
  }
}

// Staff coverage of a mask: share of calibrated staff lines inked across
// >= 35% of their extent (dashed lines, knocked-out digits). Intro, outro and
// ad screens don't show the staff.
export function staffCoverage(mask, w, h, staff) {
  if (!staff || !staff.rows?.length) return 1;
  const x0 = Math.max(0, Math.round(staff.x0)), x1 = Math.min(w - 1, Math.round(staff.x1));
  let present = 0;
  for (const yr of staff.rows) {
    const yc = Math.round(yr);
    let hit = 0;
    for (let x = x0; x <= x1; x++) {
      for (let y = Math.max(0, yc - 1); y <= Math.min(h - 1, yc + 1); y++) {
        if (mask[y * w + x]) { hit++; break; }
      }
    }
    if (hit >= 0.35 * (x1 - x0 + 1)) present++;
  }
  return present / staff.rows.length;
}

// makeFrames(): fresh async iterable of half-res ink planes (distinct buffers).
// calib: {tau, dH, staff}. Returns runs carrying their representative masks.
export async function inkPass1(makeFrames, w2, h2, { frameCount, calib, sensitivity = 0.5, onPct = () => {} }) {
  const P = w2 * h2;
  const { tau, dH } = calib;
  const k = knobs(sensitivity);
  const glyph = Math.max(4, 0.15 * dH * dH); // ink of one fret number, half-res px
  const cell = Math.max(4, Math.round(dH));
  const cw = Math.ceil(w2 / cell), ch = Math.ceil(h2 / cell);
  const cellOf = new Uint32Array(P);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) cellOf[y * w2 + x] = Math.floor(y / cell) * cw + Math.floor(x / cell);
  // Floor: at tiny scales (360p sources) a few shifting glyph-edge pixels would
  // otherwise read as a swapped fret number.
  const cellT = Math.max(24, k.cellK * dH * dH);
  const N = Math.max(1, frameCount);

  // ---- sweep A: raw ink counts -> present frames, static mask
  const inkCount = [];
  const inkFreq = new Uint16Array(P);
  for await (const g of makeFrames()) {
    let c = 0;
    for (let i = 0; i < P; i++) {
      if (g[i] > tau) { c++; inkFreq[i]++; }
    }
    inkCount.push(c);
    if (inkCount.length % 50 === 0) onPct(0.15 * inkCount.length / N);
  }
  const n = inkCount.length;
  if (n === 0) return { runs: [], excl: new Uint8Array(P), hotFrac: 0, staticFrac: 0, inkFloor: 0, glyph, pairs: [], frames: 0 };
  const p60 = pct(inkCount, 0.6);
  const present = inkCount.map((c) => c > 0 && c >= 0.3 * p60);
  const nPresent = present.filter(Boolean).length;
  const staticMask = new Uint8Array(P);
  if (nPresent >= 8) for (let i = 0; i < P; i++) staticMask[i] = inkFreq[i] >= 0.85 * nPresent ? 1 : 0;
  const staticN = countOnes(staticMask);
  const floorProv = Math.max(8 * glyph, 0.25 * (pct(inkCount.filter((_, t) => present[t]), 0.5) - staticN));

  // ---- sweep B: majority-filtered content masks -> pair metrics + signatures
  const counts = new Uint32Array(cw * ch);
  const sweepB = async (excl, collectFlips, base, span) => {
    const pairs = [];
    const contentInk = new Array(n).fill(0);
    const sigs = new Array(n);
    const flips = collectFlips ? new Uint16Array(P) : null;
    let nStable = 0, prev = null, prevDil = null;
    const tmp = new Uint8Array(P);
    for await (const { t, full } of majoritySweep(makeFrames, P, tau)) {
      const c = full;
      for (let i = 0; i < P; i++) if (excl[i]) c[i] = 0;
      const dil = dilate3(c, w2, h2, new Uint8Array(P), tmp);
      contentInk[t] = countOnes(c);
      sigs[t] = cellSig(c, w2, h2, cell);
      if (prev !== null) {
        // changed ink with 1-px tolerance, and where it concentrates
        counts.fill(0);
        let changed = 0;
        for (let i = 0; i < P; i++) {
          if ((prev[i] && !dil[i]) || (c[i] && !prevDil[i])) {
            changed++;
            counts[cellOf[i]]++;
          }
        }
        const d = { changed, inkA: contentInk[t - 1], inkB: contentInk[t], local: changed ? maxWindow2x2(counts, cw, ch) : 0 };
        pairs.push(d);
        if (flips !== null && changed <= k.minorRatio * Math.max(d.inkA, d.inkB, floorProv)) {
          nStable++;
          for (let i = 0; i < P; i++) flips[i] += prev[i] ^ c[i];
        }
      }
      prev = c;
      prevDil = dil;
      if (t % 50 === 0) onPct(base + span * t / N);
    }
    return { pairs, contentInk, sigs, flips, nStable };
  };

  let excl = staticMask;
  let B = await sweepB(staticMask, true, 0.15, 0.3);
  // Hot pixels keep flipping while the screen is otherwise stable: live video
  // or texture behind an overlay. Cursors are already gone (majority filter).
  let hot = new Uint8Array(P);
  const hotT = Math.max(8, 0.15 * B.nStable);
  for (let i = 0; i < P; i++) hot[i] = B.flips[i] >= hotT ? 1 : 0;
  hot = morph(hot, w2, h2, 2, 'max');
  const hotFrac = countOnes(hot) / P;
  if (hotFrac > 0.002) {
    excl = new Uint8Array(P);
    for (let i = 0; i < P; i++) excl[i] = staticMask[i] | hot[i];
    B = await sweepB(excl, false, 0.45, 0.3);
  }

  const presentContent = B.contentInk.filter((_, t) => present[t]);
  const inkFloor = Math.max(8 * glyph, 0.25 * pct(presentContent.length ? presentContent : B.contentInk, 0.5));
  const pairs = B.pairs.map((d) => {
    const ref = Math.max(d.inkA, d.inkB, inkFloor);
    const ratio = d.changed / ref;
    let cls = 'STABLE';
    if (d.changed <= Math.max(2, 0.002 * ref)) cls = 'IDENTICAL';
    else if (ratio > k.ratioT || (ratio > k.minorRatio && d.local >= cellT)) cls = 'TRANSITION';
    return { cls, ratio, local: d.local, weak: false };
  });
  let runs = segmentRuns(pairs, { minRunS: k.minRunS });
  runs = refineRuns(runs, B.sigs, { cpT: k.cpT, floor: inkFloor });

  // ---- sweep C: representative masks per run (majority over interior frames)
  // plus staff visibility read from the raw planes at a lower threshold (faint
  // panel staff lines can sit right at tau).
  const interior = (r) => (r.nFrames >= 8 ? [r.startF + 2, r.endF - 2] : r.nFrames >= 5 ? [r.startF + 1, r.endF - 1] : [r.startF, r.endF]);
  const staffT = 0.6 * tau;
  let ri = 0, acc = null, staffAcc = null;
  for await (const { t, full, raw } of majoritySweep(makeFrames, P, tau)) {
    while (ri < runs.length && t > interior(runs[ri])[1]) ri++;
    if (ri >= runs.length) break;
    const r = runs[ri];
    const [a, b] = interior(r);
    if (t < a) continue;
    if (acc === null) {
      acc = new Uint16Array(P);
      staffAcc = new Uint16Array(P);
    }
    for (let i = 0; i < P; i++) {
      acc[i] += full[i];
      if (raw[i] > staffT) staffAcc[i]++;
    }
    if (t === b) {
      const len = b - a + 1;
      const content = new Uint8Array(P), faint = new Uint8Array(P);
      for (let i = 0; i < P; i++) {
        content[i] = (2 * acc[i] >= len ? 1 : 0) & (excl[i] ^ 1);
        faint[i] = 2 * staffAcc[i] >= len ? 1 : 0;
      }
      Object.assign(r, {
        interior: [a, b],
        content,
        ink: countOnes(content),
        sig: cellSig(content, w2, h2, cell),
        staff: staffCoverage(faint, w2, h2, calib.staff),
      });
      acc = null;
      staffAcc = null;
      ri++;
    }
    if (t % 50 === 0) onPct(0.75 + 0.25 * t / N);
  }
  onPct(1);
  runs = runs.filter((r) => r.content);
  return {
    runs,
    excl,
    hotFrac,
    staticFrac: staticN / P,
    inkFloor,
    glyph,
    pairs,
    nPresent,
    frames: n,
  };
}

// ------------------------------------------------------------ self-check

async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const W = 160, H = 60, P = W * H;
  const dH = 10;
  const staffRows = [5, 15, 25, 35, 45, 55];
  const calib = { tau: 80, dH, staff: { rows: staffRows, x0: 4, x1: 155 } };
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const stamp = (g, x, y, v = 220) => { for (let yy = y; yy < y + 6; yy++) for (let xx = x; xx < x + 4; xx++) g[yy * W + xx] = v; };
  const page = (s, count = 24) => {
    seed = s;
    const g = new Uint8Array(P);
    for (const y of staffRows) for (let x = 4; x < 156; x++) g[y * W + x] = 150;
    const digits = [];
    for (let i = 0; i < count; i++) {
      const x = 8 + Math.floor(rnd() * 140), y = staffRows[Math.floor(rnd() * 6)] - 3;
      digits.push([x, y]);
      stamp(g, x, y);
    }
    return { g, digits };
  };
  const feed = (frames) => () => (async function* () { for (const f of frames) yield Uint8Array.from(f); })();
  const withBar = (g, x, width = 2) => {
    const f = Uint8Array.from(g);
    for (let y = 0; y < H; y++) for (let xx = x; xx < Math.min(W, x + width); xx++) f[y * W + xx] = 230;
    return f;
  };
  const pass = (frames, sens = 0.5) => inkPass1(feed(frames), W, H, { frameCount: frames.length, calib, sensitivity: sens });

  const A = page(11).g, B = page(22).g;

  // 1. Two screens under a fast sweeping cursor bar -> exactly two runs.
  let frames = [];
  for (let i = 0; i < 48; i++) frames.push(withBar(i < 24 ? A : B, (i * 13) % W));
  let r = await pass(frames);
  assert.equal(r.runs.length, 2, 'fast cursor: two screens');
  assert.ok(Math.abs(r.runs[1].startF - 24) <= 1);

  // 2. Slow cursor that sits on each column for 3 frames -> still two runs.
  frames = [];
  for (let i = 0; i < 64; i++) frames.push(withBar(i < 32 ? A : B, Math.floor(i / 3) * 4 % W, 4));
  r = await pass(frames);
  assert.equal(r.runs.length, 2, 'slow cursor must not split or merge screens');

  // 3. Flickering texture in a corner (live video behind an overlay) over one
  //    screen -> one run, and the flicker gets excluded as hot.
  frames = [];
  for (let i = 0; i < 40; i++) {
    const f = Uint8Array.from(A);
    for (let y = 0; y < 20; y++) for (let x = 120; x < 160; x++) f[y * W + x] = rnd() < 0.5 ? 200 : 0;
    frames.push(f);
  }
  r = await pass(frames);
  assert.equal(r.runs.length, 1, 'flicker must not split the screen');
  assert.ok(r.hotFrac > 0.02, `flicker should be excluded (hotFrac ${r.hotFrac})`);

  // 4. Same layout, three fret numbers swapped in place ("3" -> "0"): a new screen.
  const base = page(33, 24);
  const swapped = Uint8Array.from(base.g);
  for (const [x, y] of base.digits.slice(0, 3)) {
    for (let yy = y + 2; yy < y + 4; yy++) for (let xx = x + 1; xx < x + 3; xx++) swapped[yy * W + xx] = 0; // hollow it out
  }
  for (const [x, y] of base.digits.slice(3, 6)) stamp(swapped, x + 5, y); // widen neighbours
  frames = [];
  for (let i = 0; i < 40; i++) frames.push(i < 20 ? base.g : swapped);
  r = await pass(frames);
  assert.equal(r.runs.length, 2, 'a few fret numbers changing in place is a new screen');

  // 5. Sensitivity doesn't break the basic flip.
  frames = [];
  for (let i = 0; i < 40; i++) frames.push(i < 20 ? A : B);
  for (const s of [0, 0.25, 0.75, 1]) assert.equal((await pass(frames, s)).runs.length, 2, `sens ${s}`);

  // 6. Cross-fade over 8 frames (ink fades out / in) -> two runs, not one.
  frames = [];
  for (let i = 0; i < 48; i++) {
    const a = Math.min(1, Math.max(0, (i - 20) / 8));
    const f = new Uint8Array(P);
    for (let p = 0; p < P; p++) f[p] = Math.round((1 - a) * A[p] + a * B[p]);
    frames.push(f);
  }
  r = await pass(frames);
  assert.equal(r.runs.length, 2, 'cross-fade must split');

  // 7. A screen without the staff (intro card) reports low staff coverage; a
  //    faint staff (just under tau) still counts.
  const intro = new Uint8Array(P);
  for (let y = 25; y < 32; y++) for (let x = 40; x < 120; x++) intro[y * W + x] = (x % 6 < 3) ? 220 : 0;
  const faint = Uint8Array.from(A);
  for (const y of staffRows) for (let x = 4; x < 156; x++) if (faint[y * W + x] === 150) faint[y * W + x] = 70;
  frames = [];
  for (let i = 0; i < 40; i++) frames.push(i < 16 ? intro : faint);
  r = await pass(frames);
  assert.equal(r.runs.length, 2);
  assert.ok(r.runs[0].staff < 0.5 && r.runs[1].staff >= 0.8, `staff coverage ${r.runs.map((x) => x.staff)}`);

  // 8. Grace logic: a lone weak transition is forgiven, a strong one splits.
  const st = { cls: 'STABLE', weak: false };
  const seq = (mid) => [st, st, st, st, st, mid, st, st, st, st, st];
  assert.equal(segmentRuns(seq({ cls: 'TRANSITION', weak: false }), { minRunS: 0.75 }).length, 2);
  assert.equal(segmentRuns(seq({ cls: 'TRANSITION', weak: true }), { minRunS: 0.75 }).length, 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
