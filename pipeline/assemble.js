// Assembly: collapse consecutive duplicate composites (temporal median erases
// moving highlights), emit one page per distinct screen, globally dedup exact
// repeats. The only comparison metric is diffFrac (changed-pixel count), not
// MAD: sparse tab content dilutes MAD toward zero even across a real page flip.
// ponytail: scroll matching/stitching removed — a scroll never produces a
// stable run to match, so we only capture on change and leave scrolling to the
// fixed-interval fallback.
import { pathToFileURL } from 'node:url';
import { medianComposite, toGray, diffFrac } from './composite.js';

export const DUP_FRAC = 0.012; // below: two composites are the same screen

// diffFrac between two same-size gray frames, skipping pixels the pass-1
// exclude mask marks (a webcam inset that always changes). maskHalf is half-res.
// maskHalf === null reduces to plain diffFrac (composite.js).
export function dupDiff(A, B, w, h, maskHalf = null, T = 24) {
  if (maskHalf === null) return diffFrac(A, B, T);
  const w2 = w >> 1;
  let sum = 0, n = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w, mrow = (y >> 1) * w2;
    for (let x = 0; x < w; x++) {
      if (maskHalf[mrow + (x >> 1)]) continue;
      sum += B[row + x] - A[row + x];
      n++;
    }
  }
  if (n === 0) return 1;
  const bias = Math.max(-16, Math.min(16, sum / n));
  let changed = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w, mrow = (y >> 1) * w2;
    for (let x = 0; x < w; x++) {
      if (maskHalf[mrow + (x >> 1)]) continue;
      if (Math.abs(B[row + x] - A[row + x] - bias) > T) changed++;
    }
  }
  return changed / n;
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
// Returns capture drafts: {type:'page', rgb, w, h, tStart, tEnd, alsoAt}.
// PNG writing is the caller's job.
export function assemble(composites, { w, h, maskHalf = null } = {}) {
  // Group consecutive near-duplicates; each group is one screen shown a while.
  const groups = [];
  for (const C of composites) {
    const g = groups[groups.length - 1];
    if (g && dupDiff(g[g.length - 1].gray, C.gray, w, h, maskHalf) < DUP_FRAC) g.push(C);
    else groups.push([C]);
  }

  // Resolve a group: median across >= 3 near-duplicates erases persistent
  // highlights; with fewer, keep the first.
  const drafts = groups.map((cs) => {
    const rgb = cs.length >= 3 ? medianComposite(cs.map((c) => c.rgb)) : cs[0].rgb;
    return {
      type: 'page',
      rgb,
      gray: cs.length >= 3 ? toGray(rgb) : cs[0].gray,
      w,
      h,
      tStart: cs[0].tStart,
      tEnd: cs[cs.length - 1].tEnd,
      alsoAt: [],
    };
  });

  // Global dedup: dHash prefilter, full-res diff-fraction confirm; repeats
  // recorded in alsoAt.
  const out = [];
  for (const d of drafts) {
    const hash = dHash(d.gray, w, h);
    let dup = null;
    for (const prior of out) {
      if (hamming(prior._hash, hash) > 6) continue;
      if (diffFrac(prior._gray, d.gray) < DUP_FRAC) { dup = prior; break; }
    }
    if (dup) {
      dup.alsoAt.push(d.tStart);
    } else {
      d._hash = hash;
      d._gray = d.gray;
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

  // Sparse tab page: shared staff lines + per-seed random ink marks. Two seeds
  // differ only in sparse marks — a real flip whose MAD is tiny but diffFrac is not.
  const sparsePage = (seed) => {
    let s = seed >>> 0 || 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const marks = Array.from({ length: 90 }, () => [Math.floor(rnd() * (W - 3)), Math.floor(rnd() * (H - 5))]);
    const g = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = y % 8 === 0 ? 140 : 255;
    for (const [mx, my] of marks) {
      for (let y = my; y < my + 4; y++) for (let x = mx; x < mx + 3; x++) g[y * W + x] = 0;
    }
    return g;
  };
  const grayToRgb = (g) => {
    const rgb = new Uint8Array(g.length * 3);
    for (let i = 0; i < g.length; i++) rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = g[i];
    return rgb;
  };
  const comp = (g, t0, t1) => ({ rgb: grayToRgb(g), gray: g, tStart: t0, tEnd: t1 });
  const withSquare = (g, sx, sy) => { // a moving highlight over an unchanged page
    const f = Uint8Array.from(g);
    for (let y = sy; y < sy + 8; y++) for (let x = sx; x < sx + 8; x++) f[y * W + x] = 200;
    return f;
  };

  const pageA = sparsePage(101), pageB = sparsePage(202);

  // 1. dupDiff: identical -> ~0, sparse flip -> above DUP_FRAC.
  assert.equal(dupDiff(pageA, Uint8Array.from(pageA), W, H), 0);
  assert.ok(dupDiff(pageA, pageB, W, H) > DUP_FRAC, 'sparse flip must not read as duplicate');

  // 2. Assembly: three highlighted views of page A collapse to ONE page whose
  //    median erased the moving square; page B is a distinct page; a later
  //    exact repeat of A is deduped into alsoAt, not re-emitted.
  const composites = [
    comp(withSquare(pageA, 10, 4), 0, 5),
    comp(withSquare(pageA, 60, 16), 5, 10),
    comp(withSquare(pageA, 90, 28), 10, 15),
    comp(pageB, 15, 20),
    comp(Uint8Array.from(pageA), 20, 25),
  ];
  const captures = assemble(composites, { w: W, h: H });
  assert.equal(captures.length, 2, 'expected page A + page B after dedup');
  assert.equal(captures[0].type, 'page');
  assert.equal(captures[0].tStart, 0);
  assert.equal(captures[0].tEnd, 15);
  assert.deepEqual(captures[0].alsoAt, [20], 'exact repeat recorded, not re-emitted');
  assert.deepEqual(captures[0].rgb, grayToRgb(pageA), 'dup-set median erased the moving highlight');
  assert.equal(captures[1].tStart, 15);
  assert.deepEqual(captures[1].alsoAt, []);

  // 3. Mask path: two identical pages plus a differing region that the exclude
  //    mask covers must still read as duplicate.
  const w2 = W >> 1, h2 = H >> 1;
  const mask = new Uint8Array(w2 * h2); // mask out the top-left 20x20 block
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) mask[y * w2 + x] = 1;
  const noisy = Uint8Array.from(pageA);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) noisy[y * W + x] = (x * 13 + y * 7) & 0xff;
  assert.ok(dupDiff(pageA, noisy, W, H) > DUP_FRAC, 'unmasked, the noisy block reads as change');
  assert.ok(dupDiff(pageA, noisy, W, H, mask) < DUP_FRAC, 'masked region must be ignored');

  // 4. dHash sanity: identical images collide, unrelated ones do not.
  assert.equal(hamming(dHash(pageA, W, H), dHash(Uint8Array.from(pageA), W, H)), 0);
  assert.ok(hamming(dHash(pageA, W, H), dHash(pageB, W, H)) > 6);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
