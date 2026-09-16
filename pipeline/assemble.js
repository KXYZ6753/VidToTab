// Page assembly over pass-1 runs: merge consecutive runs that show the same
// screen, fold later repeats into alsoAt, drop runs that aren't tab (no staff,
// near-empty). Works on run masks only — nothing is decoded or rendered here.
import { pathToFileURL } from 'node:url';
import { dilate3, maxWindow2x2 } from './ink.js';
import { pct } from './analyze.js';

// Same screen? Changed ink with 1-px tolerance must be small overall AND
// nowhere concentrated: a glyph-sized cluster of change (one swapped fret
// number) marks a different screen even when the rest is identical.
// rows: optional [y0, y1] band to compare (the staff band — see assemblePages).
// oneWay: only count ink of A missing from B ("A is contained in B").
export function samePage(A, B, w, h, { inkFloor = 0, ratioT, cellT, cell, tol = 1, rows = null, oneWay = false }) {
  const dilA = tol ? dilate3(A, w, h) : A, dilB = tol ? dilate3(B, w, h) : B;
  const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
  const counts = new Uint32Array(cw * ch);
  const y0 = rows ? Math.max(0, rows[0]) : 0, y1 = rows ? Math.min(h - 1, rows[1]) : h - 1;
  let changed = 0, na = 0, nb = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * w, crow = Math.floor(y / cell) * cw;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const a = A[i], b = B[i];
      na += a;
      nb += b;
      if ((a && !dilB[i]) || (!oneWay && b && !dilA[i])) {
        changed++;
        counts[crow + Math.floor(x / cell)]++;
      }
    }
  }
  const ratio = changed / Math.max(na, oneWay ? 0 : nb, inkFloor, 1);
  const local = maxWindow2x2(counts, cw, ch);
  return { same: ratio < ratioT && local < cellT, ratio, local };
}

function sigDistance(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += Math.abs(a[i] - b[i]);
    na += a[i];
    nb += b[i];
  }
  return s / Math.max(na, nb, 1);
}

// runs: pass-1 runs with {startF, endF, nFrames, interior, content, ink, sig, staff}.
// Returns { pages: [{tStart, tEnd, alsoAt, runs, repeats, candidates}], dropped }.
export function assemblePages(runs, { w, h, knobs, inkFloor, dH, fps, startTime = 0, hasStaff = false, staff = null }) {
  // Screens are compared inside the staff band only (top line - 1 spacing to
  // bottom line + 1): fret numbers always differ there when pages differ,
  // while live video drifting above or below the staff (a guitar body, a
  // sleeve) and section labels ("Inter", "Outro") don't split repeats.
  const rows = staff?.rows?.length
    ? [Math.floor(Math.min(...staff.rows) - dH), Math.ceil(Math.max(...staff.rows) + dH)]
    : null;
  // Same glyph-cluster threshold (and floor) as pass-1 pair classification.
  const opts = { inkFloor, ratioT: knobs.pageRatioT, cellT: Math.max(knobs.cellFloor ?? 24, knobs.cellK * dH * dH), cell: Math.max(4, Math.round(dH)), rows };
  const same = (a, b) => samePage(a.content, b.content, w, h, opts).same;
  const dropped = { noStaff: 0, empty: 0 };

  // Not tab: calibrated staff invisible, or next to no notation.
  let kept = runs.filter((r) => {
    if (hasStaff && r.staff < 0.6) { dropped.noStaff++; return false; }
    return true;
  });
  const p75 = pct(kept.map((r) => r.ink), 0.75);
  kept = kept.filter((r) => {
    if (r.ink < Math.max(inkFloor * 0.25, 0.15 * p75)) { dropped.empty++; return false; }
    return true;
  });

  // Consecutive runs of the same screen (a repeat back-to-back, a spurious
  // split) collapse into one group, compared against the group's longest run
  // so slow drift can't chain distinct screens together.
  const groups = [];
  for (const r of kept) {
    const g = groups[groups.length - 1];
    if (g && same(g.anchor, r)) {
      g.runs.push(r);
      if (r.nFrames > g.anchor.nFrames) g.anchor = r;
    } else {
      groups.push({ runs: [r], anchor: r });
    }
  }

  // A later group showing an earlier screen is a repeat, not a new page.
  const pages = [];
  for (const g of groups) {
    const a = g.anchor;
    let dup = null;
    for (const p of pages) {
      const b = p.anchor;
      if (Math.abs(a.ink - b.ink) > 0.35 * Math.max(a.ink, b.ink)) continue;
      if (sigDistance(a.sig, b.sig) > 0.8) continue;
      if (same(b, a)) { dup = p; break; }
    }
    if (dup) dup.repeats.push(g);
    else pages.push({ ...g, repeats: [] });
  }

  const tOf = (f) => Math.round((startTime + f / fps) * 100) / 100;
  const framesOf = (gs) => {
    const out = [];
    for (const g of gs) for (const r of g.runs) for (let f = r.interior[0]; f <= r.interior[1]; f++) out.push(f);
    return out;
  };
  for (const p of pages) {
    p.tStart = tOf(p.runs[0].startF);
    p.tEnd = tOf(p.runs[p.runs.length - 1].endF + 1);
    p.alsoAt = p.repeats.map((g) => tOf(g.runs[0].startF));
    // Samples come from the anchor run (the fullest view of the screen), topped
    // up from the rest of its first appearance, then from repeats.
    let cands = framesOf([{ runs: [p.anchor] }]);
    if (cands.length < 7) cands = [...new Set([...cands, ...framesOf([p])])];
    if (cands.length < 7) cands = [...new Set([...cands, ...framesOf(p.repeats)])];
    p.candidates = cands.sort((x, y) => x - y);
  }
  return { pages, dropped };
}

// ------------------------------------------------------------ self-check

async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const { knobs } = await import('./analyze.js');
  const { cellSig, countOnes } = await import('./ink.js');
  // dH 8 with 4x6 digits: a swapped digit is ~0.4 dH^2 of change, like the
  // real glyph swaps measured on the target videos (0.3-0.7 dH^2).
  const W = 160, H = 60, dH = 8;
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const digit = (m, x, y, v = 1) => { for (let yy = y; yy < y + 6; yy++) for (let xx = x; xx < x + 4; xx++) m[yy * W + xx] = v; };
  const page = (s) => {
    seed = s;
    const m = new Uint8Array(W * H);
    const at = [];
    for (let i = 0; i < 24; i++) {
      const x = 8 + Math.floor(rnd() * 140), y = 2 + 10 * Math.floor(rnd() * 5);
      at.push([x, y]);
      digit(m, x, y);
    }
    return { m, at };
  };
  let nextF = 0;
  const run = (m, n = 16, staff = 1) => {
    const r = { startF: nextF, endF: nextF + n - 1, nFrames: n, interior: [nextF + 2, nextF + n - 3], content: m, ink: countOnes(m), sig: cellSig(m, W, H, dH), staff };
    nextF += n + 2;
    return r;
  };
  const k = knobs(0.5);
  const ctx = { w: W, h: H, knobs: k, inkFloor: 60, dH, fps: 4, hasStaff: true };
  const opts = { inkFloor: 60, ratioT: k.pageRatioT, cellT: k.cellK * dH * dH, cell: dH };

  const A = page(1), B = page(2);
  // 1. samePage: identical and 1-px shifted -> same; one digit moved -> different.
  const shifted = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) shifted[y * W + x] = A.m[y * W + x - 1];
  assert.ok(samePage(A.m, Uint8Array.from(A.m), W, H, opts).same);
  assert.ok(samePage(A.m, shifted, W, H, opts).same, '1-px jitter is the same screen');
  const oneDigit = Uint8Array.from(A.m);
  digit(oneDigit, A.at[0][0], A.at[0][1], 0);
  digit(oneDigit, 150, 44);
  assert.ok(!samePage(A.m, oneDigit, W, H, opts).same, 'a moved fret number is a different screen');
  assert.ok(!samePage(A.m, B.m, W, H, opts).same);

  // 2. Assembly: A, A (spurious split), B, intro-without-staff, A again ->
  //    pages A (alsoAt the repeat) and B; the no-staff run is dropped.
  nextF = 0;
  const runs = [run(A.m), run(Uint8Array.from(A.m), 10), run(B.m), run(page(9).m, 16, 0.1), run(Uint8Array.from(A.m))];
  const { pages, dropped } = assemblePages(runs, ctx);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].runs.length, 2, 'back-to-back runs of one screen merge');
  assert.equal(pages[0].alsoAt.length, 1);
  assert.equal(pages[0].alsoAt[0], runs[4].startF / 4);
  assert.equal(dropped.noStaff, 1);
  assert.ok(pages[0].candidates.length >= 7);
  assert.equal(pages[1].tStart, runs[2].startF / 4);

  // 3. Staff band: identical notes, different junk above the staff (a guitar
  //    edge drifting in the crop) -> same screen. A screen that gains a chord
  //    stays a separate page: at small scales "gained notes" is too easy to
  //    confuse with a different sparse page, and losing notes is worse than a
  //    removable near-duplicate.
  const bandCtx = { ...ctx, staff: { rows: [14, 24, 34, 44] } };
  const junk = Uint8Array.from(A.m);
  for (let y = 0; y < 4; y++) for (let x = 60; x < 72; x++) junk[y * W + x] = 1;
  nextF = 0;
  let res = assemblePages([run(A.m), run(page(5).m), run(junk)], bandCtx);
  assert.equal(res.pages.length, 2);
  assert.equal(res.pages[0].alsoAt.length, 1, 'junk above the staff must not split a repeat');
  // 4. Drift can't chain: A -> A' (1 digit) -> A'' (2 digits) stay 3 pages.
  const A1 = Uint8Array.from(A.m); digit(A1, A.at[1][0], A.at[1][1], 0); digit(A1, 20, 52);
  const A2 = Uint8Array.from(A1); digit(A2, A.at[2][0], A.at[2][1], 0); digit(A2, 60, 52);
  nextF = 0;
  const drift = assemblePages([run(A.m), run(A1), run(A2)], ctx);
  assert.equal(drift.pages.length, 3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
