// Real glyphs for training, labelled from the adjudicated truth.
//
//   node scripts/tabread-harvest.mjs [--model file] [--video id]
//
// Dev videos only; the hold-outs (eval-set.json "holdout": true) are refused.
// Each truth page is cut with the reader's own segmentPage and classified with
// the current model; then, string by string, the glyphs left to right are
// aligned to what the truth says is written there (a note's digits, its
// technique letters, brackets, x) by dynamic programming over the model's
// probabilities. A string's labels are kept only when the alignment is clean:
// every digit placed, two-digit frets side by side, the notes of each chord
// lined up across strings and the truth's order kept along the staff. Glyphs
// on a clean string that the truth has no mark for are "other".
// → .cache/tabread/real/glyphs.{bin,json}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPage, CLASSES } from '../public/shared/tabread.js';
import { DEV, holdouts, truthPages, decodePage, loadModel } from './tabread-eval.mjs';
import { saveSamples, DATA } from './tabread-train.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What a note looks like written on its string, as classifier labels.
export function tokensOf(n) {
  const t = n.tech || [];
  const toks = [];
  const lead = t.find((x) => ['h', 'p', 's', '/', '\\'].includes(x));
  if (lead) toks.push({ c: lead, soft: true });
  if (t.includes('ghost')) toks.push({ c: '(', soft: true });
  if (t.includes('harm')) toks.push({ c: '<', soft: true });
  if (n.fret === null) toks.push({ c: 'x', note: true });
  else for (const d of String(n.fret)) toks.push({ c: d, note: true, digit: true, grace: t.includes('grace') });
  if (t.includes('ghost')) toks.push({ c: ')', soft: true });
  if (t.includes('harm')) toks.push({ c: '>', soft: true });
  if (t.includes('b') || t.includes('r')) {
    toks.push({ c: t.includes('b') ? 'b' : 'r', soft: true });
    if (n.bendTo !== null && n.bendTo !== undefined) for (const d of String(n.bendTo)) toks.push({ c: d, soft: true, bend: true });
  }
  if (t.includes('~')) toks.push({ c: '~', soft: true });
  return toks;
}

// Align glyphs (left to right) to tokens: match costs −log p, an unmatched
// glyph costs −log p(other), a skipped token 6 (a note mark) or 2.5 (a
// technique mark, which some styles draw off the line or not at all).
export function alignString(glyphs, toks) {
  const ci = (c) => CLASSES.indexOf(c);
  const other = ci('other');
  const n = glyphs.length;
  const m = toks.length;
  const lp = (g, c) => -Math.log(Math.max(1e-4, g.probs ? g.probs[c] : (g.label === CLASSES[c] ? g.conf : (1 - g.conf) / (CLASSES.length - 1))));
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const B = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  D[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity;
      let how = 0;
      if (i > 0 && j > 0) { const c = D[i - 1][j - 1] + lp(glyphs[i - 1], ci(toks[j - 1].c)); if (c < best) { best = c; how = 1; } }
      if (i > 0) { const c = D[i - 1][j] + lp(glyphs[i - 1], other); if (c < best) { best = c; how = 2; } }
      if (j > 0) { const c = D[i][j - 1] + (toks[j - 1].soft ? 2.5 : 6); if (c < best) { best = c; how = 3; } }
      D[i][j] = best;
      B[i][j] = how;
    }
  }
  const match = new Array(m).fill(null);
  const glyphTok = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const how = B[i][j];
    if (how === 1) { match[j - 1] = i - 1; glyphTok[i - 1] = j - 1; i--; j--; }
    else if (how === 2) i--;
    else j--;
  }
  return { match, glyphTok, cost: D[n][m] };
}

export async function harvest({ modelFile, only = null, log = console.log } = {}) {
  const hold = new Set(holdouts());
  if (only && hold.has(only)) throw new Error(`${only} is a hold-out video: its glyphs are never harvested`);
  const model = await loadModel(modelFile);
  const crops = [];
  const feats = [];
  const labels = [];
  const groups = [];
  const groupNames = [];
  const stats = { strings: 0, clean: 0, glyphs: 0, notes: 0, disagree: 0 };
  const counts = {};
  for (const video of DEV) {
    if (hold.has(video)) throw new Error(`${video} is listed as dev and hold-out`);
    if (only && video !== only) continue;
    for (const tp of truthPages(video)) {
      const img = decodePage(tp.page);
      const res = readPage(img, { classify: model.classify, keep: true });
      if (!res.found) continue;
      const truthSys = tp.truth.parsed;
      // One system per page on every dev page; pair them in order.
      res.systems.forEach((sys, si) => {
        const events = (truthSys[si] || []).filter((e) => !e.bar);
        if (!events.length && truthSys.length <= si) return;
        const s = sys.spacing;
        const medH = sys.medH || 0.7 * s;
        const perString = {};
        const notePos = new Map(); // `${event}/${string}` → x of the note's digits
        for (let k = 1; k <= 6; k++) {
          stats.strings++;
          const glyphs = sys.glyphs.filter((g) => g.string === k).sort((a, b) => a.x0 - b.x0);
          const toks = [];
          events.forEach((e, ei) => {
            const n = e.notes.find((x) => x.string === k);
            if (!n) return;
            for (const t of tokensOf(n)) toks.push({ ...t, ev: ei, unsure: n.unsure });
          });
          const { match, glyphTok } = alignString(glyphs, toks);
          let clean = !toks.some((t) => t.unsure);
          for (let j = 0; j < toks.length && clean; j++) {
            const t = toks[j];
            if (match[j] === null) { if (!t.soft) clean = false; continue; }
            const g = glyphs[match[j]];
            // A note mark must be a whole character, not a sliver of one.
            if (t.note && !t.grace && g.h < 0.6 * medH) clean = false;
            // Two digits of one fret sit side by side.
            if (t.digit && j > 0 && toks[j - 1].digit && toks[j - 1].ev === t.ev && match[j - 1] !== null) {
              const a = glyphs[match[j - 1]];
              if (g.x0 - a.x1 - 1 > 0.35 * s || match[j] !== match[j - 1] + 1) clean = false;
            }
          }
          if (clean) {
            // Where each note sits, for the checks across strings.
            for (let j = 0; j < toks.length; j++) {
              if (!toks[j].note || match[j] === null) continue;
              const g = glyphs[match[j]];
              const k2 = `${toks[j].ev}/${k}`;
              const cur = notePos.get(k2);
              notePos.set(k2, cur ? { x0: Math.min(cur.x0, g.x0), x1: Math.max(cur.x1, g.x1) } : { x0: g.x0, x1: g.x1 });
            }
          }
          perString[k] = { glyphs, toks, glyphTok, clean };
        }
        // Chords line up; events keep their order along the staff.
        const bad = new Set();
        const centre = (p) => (p.x0 + p.x1) / 2;
        const byEvent = new Map();
        for (const [k2, p] of notePos) {
          const [ev, k] = k2.split('/').map(Number);
          if (!byEvent.has(ev)) byEvent.set(ev, []);
          byEvent.get(ev).push({ k, p });
        }
        for (const [, list] of byEvent) {
          const xs = list.map((o) => centre(o.p));
          if (Math.max(...xs) - Math.min(...xs) > 0.7 * s) for (const o of list) bad.add(o.k);
        }
        const evs = [...byEvent.keys()].sort((a, b) => a - b);
        for (let a = 0; a < evs.length; a++) {
          for (let b = a + 1; b < evs.length; b++) {
            for (const oa of byEvent.get(evs[a])) {
              for (const ob of byEvent.get(evs[b])) {
                if (centre(ob.p) < centre(oa.p) - 0.3 * s) { bad.add(oa.k); bad.add(ob.k); }
              }
            }
          }
        }
        const gname = `${video}/${tp.id}`;
        let gi = groupNames.indexOf(gname);
        if (gi < 0) { gi = groupNames.length; groupNames.push(gname); }
        for (let k = 1; k <= 6; k++) {
          const ps = perString[k];
          if (!ps.clean || bad.has(k)) continue;
          stats.clean++;
          ps.glyphs.forEach((g, i) => {
            const j = ps.glyphTok[i];
            const lab = j === null ? 'other' : ps.toks[j].c;
            const c = CLASSES.indexOf(lab);
            if (c < 0) return;
            crops.push(g.crop);
            feats.push(g.feats);
            labels.push(c);
            groups.push(gi);
            counts[lab] = (counts[lab] || 0) + 1;
            stats.glyphs++;
            if (g.label !== lab) stats.disagree++;
          });
          stats.notes += ps.toks.filter((t) => t.note).length;
        }
      });
    }
  }
  saveSamples(path.join(DATA, 'real', 'glyphs'), { crops, feats, labels, groups, groupNames, source: 'real dev glyphs' });
  log(`${stats.clean}/${stats.strings} strings aligned cleanly → ${stats.glyphs} glyphs (${stats.notes} note marks), the model disagreed on ${stats.disagree}`);
  log(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
  await harvest({ modelFile: path.resolve(arg('--model', path.join(ROOT, 'public', 'shared', 'tabread-model.js'))), only: arg('--video', null) });
}
