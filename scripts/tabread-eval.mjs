// How well the tab reader reads real pages, against the adjudicated truth.
//
//   node scripts/tabread-eval.mjs [--video id] [--lovo] [--show-holdout]
//                                 [--model file] [--no-adapt] [--dev-only] [--synth]
//
//   Staff: findStaves on every cached page against the calibration's lines.
//   Notes: every truth page (scripts/tabread-truth/<video>/<page>.json) read
//   with the model, its events aligned to the truth's in order (edit distance;
//   pair cost 1 − |shared (string, fret)| / larger size, skip 0.6), then note
//   precision / recall / F1 on (string, fret), what went wrong with each miss,
//   techniques on the notes read right, chord grouping, clean pages, how many
//   errors a low confidence flags, and time per page. Dev videos in detail;
//   hold-outs as one aggregate unless --show-holdout.
//   --lovo retrains without each dev video's real glyphs in turn and reads that
//   video with the model that never saw it (honest per-video numbers);
//   --lovo-par n trainings at once (3), --lovo-epochs (15).
//   A table goes to stdout and everything to .cache/tabread/eval-<time>.json.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTruth, pagesOf, videosWithPages, alignEvents } from './tabread-truth.mjs';
import { readPage, adaptSheet } from '../public/shared/tabread.js';
import { findStaves, inkPlane } from '../public/shared/staff.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRUTH = path.join(ROOT, 'scripts', 'tabread-truth');
const OUT = path.join(ROOT, '.cache', 'tabread');
const MODEL = path.join(ROOT, 'public', 'shared', 'tabread-model.js');
export const DEV = ['yT9gKKwBeVw', '0YXjZDR5V-4', 'Fv3pCR1Btjk', 'MENRbBUBYd4', '73HxHE5e2yY', 'tabsheet-styx'];
const FFMPEG = process.env.VIDTOTAB_FFMPEG || 'ffmpeg';

export function holdouts() {
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'eval-set.json'), 'utf8'));
  return set.videos.filter((v) => v.holdout).map((v) => v.id);
}

// A cached page as ImageData-like RGBA, decoded by ffmpeg.
export function decodePage(p) {
  const data = execFileSync(FFMPEG, ['-v', 'error', '-i', p.file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
  return { data, width: p.w, height: p.h };
}

// Truth pages of a video, each with its cached page (matched by pixels, then id).
export function truthPages(video) {
  const dir = path.join(TRUTH, video);
  if (!fs.existsSync(dir)) return [];
  const pages = pagesOf(video);
  return fs.readdirSync(dir).filter((f) => /^cap-\d+\.json$/.test(f)).sort().map((f) => {
    const truth = loadTruth(path.join(dir, f));
    const page = pages.find((p) => p.sha1 === truth.sha1) || pages.find((p) => p.id === truth.page);
    return { video, id: truth.page, truth, page };
  }).filter((t) => t.page);
}

// A model module from any path (its "./tabread.js" import pointed at the real one).
export async function loadModel(file = MODEL) {
  const src = fs.readFileSync(file, 'utf8').replace("from './tabread.js'", `from '${pathToFileURL(path.join(ROOT, 'public', 'shared', 'tabread.js')).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

// ---------------------------------------------------------------- scoring

const key = (n) => `${n.string}:${n.fret === null ? 'x' : n.fret}`;
const TECH_SCORED = ['h', 'p', 's', '/', '\\', 'b', 'r', '~', 'ghost', 'harm', 'grace'];

export function scorePage(result, truth) {
  const tEvents = truth.parsed.flat().filter((e) => !e.bar).map((e) => ({ notes: e.notes }));
  const rEvents = result.found ? result.systems.flatMap((s) => s.events).map((e) => ({ notes: e.notes.map((n) => ({ ...n, tech: n.tech || [] })) })) : [];
  const pairs = alignEvents(rEvents, tEvents);
  const st = {
    tp: 0, fp: 0, fn: 0, wrongString: 0, wrongFret: 0, missed: 0, extra: 0, split: 0, merged: 0,
    techT: 0, techR: 0, techHit: 0, chords: 0, chordsExact: 0, notes: [], errors: [],
  };
  // Per pair: which truth notes went unmatched and which reader notes.
  const info = pairs.map(([ri, ti]) => {
    const r = ri === null ? [] : rEvents[ri].notes;
    const t = ti === null ? [] : tEvents[ti].notes;
    const unsureStrings = new Set(t.filter((n) => n.unsure).map((n) => n.string));
    const tS = t.filter((n) => !n.unsure);
    const rS = r.filter((n) => !unsureStrings.has(n.string));
    const tKeys = new Set(tS.map(key));
    const rKeys = new Set(rS.map(key));
    const fnNotes = tS.filter((n) => !rKeys.has(key(n)));
    const fpNotes = rS.filter((n) => !tKeys.has(key(n)));
    const tpNotes = rS.filter((n) => tKeys.has(key(n)));
    return { ri, ti, tS, rS, fnNotes, fpNotes, tpNotes };
  });
  const errOf = new Map(); // reader note → error kind
  for (let i = 0; i < info.length; i++) {
    const p = info[i];
    // Grouping errors: an unpaired event whose notes are what a neighbouring pair lacks.
    if (p.ti === null && p.rS.length) {
      const nb = [info[i - 1], info[i + 1]].find((q) => q && q.ri !== null && q.ti !== null && p.rS.every((n) => q.fnNotes.some((m) => key(m) === key(n))));
      if (nb) {
        for (const n of p.rS) { errOf.set(n, 'split'); st.split++; }
        nb.fnNotes = nb.fnNotes.filter((m) => !p.rS.some((n) => key(n) === key(m)));
        st.fp += p.rS.length;
        st.fn += p.rS.length;
        p.rS = [];
        continue;
      }
    }
    if (p.ri === null && p.tS.length) {
      const nb = [info[i - 1], info[i + 1]].find((q) => q && q.ri !== null && q.ti !== null && p.tS.every((m) => q.fpNotes.some((n) => key(m) === key(n))));
      if (nb) {
        for (const m of p.tS) {
          const n = nb.fpNotes.find((x) => key(x) === key(m));
          errOf.set(n, 'merged');
          st.merged++;
        }
        nb.fpNotes = nb.fpNotes.filter((n) => !p.tS.some((m) => key(n) === key(m)));
        st.fp += p.tS.length;
        st.fn += p.tS.length;
        p.tS = [];
        continue;
      }
    }
  }
  for (const p of info) {
    if (p.ri === null) { st.fn += p.tS.length; st.missed += p.tS.length; for (const m of p.tS) st.errors.push({ kind: 'missed', truth: key(m) }); continue; }
    if (p.ti === null) { st.fp += p.rS.length; st.extra += p.rS.length; for (const n of p.rS) { errOf.set(n, 'extra'); st.errors.push({ kind: 'extra', read: key(n), conf: n.conf }); } continue; }
    st.tp += p.tpNotes.length;
    for (const n of p.tpNotes) {
      const m = p.tS.find((x) => key(x) === key(n));
      const tt = new Set(m.tech.filter((t) => TECH_SCORED.includes(t)));
      const rt = new Set(n.tech.filter((t) => TECH_SCORED.includes(t)));
      st.techT += tt.size;
      st.techR += rt.size;
      for (const t of rt) if (tt.has(t)) st.techHit++;
    }
    let fn = [...p.fnNotes];
    let fp = [...p.fpNotes];
    // Same string, different fret: read wrong.
    for (const m of [...fn]) {
      const n = fp.find((x) => x.string === m.string);
      if (!n) continue;
      st.wrongFret++; st.fn++; st.fp++;
      errOf.set(n, 'misread');
      st.errors.push({ kind: 'misread', truth: key(m), read: key(n), conf: n.conf });
      fn = fn.filter((x) => x !== m); fp = fp.filter((x) => x !== n);
    }
    // Same fret, different string.
    for (const m of [...fn]) {
      const n = fp.find((x) => x.fret === m.fret);
      if (!n) continue;
      st.wrongString++; st.fn++; st.fp++;
      errOf.set(n, 'wrongString');
      st.errors.push({ kind: 'wrongString', truth: key(m), read: key(n), conf: n.conf });
      fn = fn.filter((x) => x !== m); fp = fp.filter((x) => x !== n);
    }
    for (const m of fn) { st.fn++; st.missed++; st.errors.push({ kind: 'missed', truth: key(m) }); }
    for (const n of fp) { st.fp++; st.extra++; errOf.set(n, 'extra'); st.errors.push({ kind: 'extra', read: key(n), conf: n.conf }); }
  }
  // Chords: a truth event with two or more notes, read as exactly its strings in one event.
  for (const p of info) {
    if (p.ti === null) continue;
    const t = tEvents[p.ti].notes.filter((n) => !n.unsure);
    if (t.length < 2) continue;
    st.chords++;
    if (p.ri !== null) {
      const rs = new Set(rEvents[p.ri].notes.map((n) => n.string));
      const ts = new Set(tEvents[p.ti].notes.map((n) => n.string));
      if (rs.size === ts.size && [...ts].every((x) => rs.has(x))) st.chordsExact++;
    }
  }
  for (const e of rEvents) for (const n of e.notes) st.notes.push({ conf: n.conf, err: errOf.has(n) });
  // Barlines: the truth's "|" events against the reader's, the staff's opening line not counted.
  st.barsT = truth.parsed.flat().filter((e) => e.bar).length;
  st.barsR = result.found ? result.systems.reduce((a, s) => a + s.barlines.filter((x) => x > s.x0 + 0.5 * s.spacing).length, 0) : 0;
  return st;
}

function sum(stats) {
  const t = { pages: 0, clean: 0, ms: 0, tp: 0, fp: 0, fn: 0, wrongString: 0, wrongFret: 0, missed: 0, extra: 0, split: 0, merged: 0, techT: 0, techR: 0, techHit: 0, chords: 0, chordsExact: 0, barsT: 0, barsR: 0, barsHit: 0, notes: [] };
  for (const s of stats) {
    t.pages++;
    if (s.fp === 0 && s.fn === 0) t.clean++;
    for (const k of Object.keys(t)) if (typeof s[k] === 'number' && k !== 'pages' && k !== 'clean') t[k] += s[k];
    t.barsHit += Math.min(s.barsT, s.barsR);
    t.notes.push(...s.notes);
  }
  const P = t.tp / Math.max(1, t.tp + t.fp);
  const R = t.tp / Math.max(1, t.tp + t.fn);
  t.P = P;
  t.R = R;
  t.F1 = (2 * P * R) / Math.max(1e-9, P + R);
  t.techP = t.techHit / Math.max(1, t.techR);
  t.techRec = t.techHit / Math.max(1, t.techT);
  t.chordAcc = t.chordsExact / Math.max(1, t.chords);
  t.cleanRate = t.clean / Math.max(1, t.pages);
  t.msPage = t.ms / Math.max(1, t.pages);
  t.flags = flagStats(t.notes, t.wrongFret + t.wrongString + t.missed + t.extra + t.split + t.merged);
  delete t.notes;
  return t;
}

// The largest confidence threshold that flags at most 10 % of notes, and the
// share of reading errors below it.
function flagStats(notes, allErrors) {
  if (!notes.length) return { threshold: 0, rate: 0, caught: 0, errors: 0, share: 0, shareAll: 0 };
  const sorted = notes.map((n) => n.conf).sort((a, b) => a - b);
  const maxFlag = Math.floor(0.1 * notes.length);
  let threshold = sorted[maxFlag] ?? 1;
  // Ties at the threshold would flag more than 10 %: flag strictly below it.
  const flagged = notes.filter((n) => n.conf < threshold);
  const errors = notes.filter((n) => n.err).length;
  const caught = flagged.filter((n) => n.err).length;
  threshold = Math.round(threshold * 1000) / 1000;
  return { threshold, rate: flagged.length / notes.length, caught, errors, share: caught / Math.max(1, errors), shareAll: caught / Math.max(1, allErrors) };
}

// ---------------------------------------------------------------- runs

// Staff finding on every cached page, against the calibration's six lines.
function staffCheck() {
  const out = { pages: 0, exact6: 0, maxErr: 0, perVideo: {}, lowRes: {} };
  const hold = new Set(holdouts());
  for (const video of videosWithPages()) {
    const pages = pagesOf(video);
    const v = { pages: 0, exact6: 0, maxErr: 0, found: 0 };
    for (const p of pages) {
      const img = decodePage(p);
      const st = findStaves({ ...img, ink: inkPlane(img) });
      v.pages++;
      if (st.systems.length) v.found++;
      if (!p.lines) continue;
      if (st.systems.length === 1) {
        v.exact6++;
        const s = st.systems[0];
        const err = Math.max(...s.lines.map((y, k) => Math.abs(y - p.lines[k]))) / s.spacing;
        v.maxErr = Math.max(v.maxErr, err);
      }
    }
    if (!pages.some((p) => p.lines)) { out.lowRes[video] = { pages: v.pages, found: v.found }; continue; }
    out.pages += v.pages;
    out.exact6 += v.exact6;
    out.maxErr = Math.max(out.maxErr, v.maxErr);
    out.perVideo[hold.has(video) ? `holdout-${Object.keys(out.perVideo).length}` : video] = v;
  }
  return out;
}

// A synthetic page's truth in the shape loadTruth gives; notes drawn within
// half a spacing of the page edge may be cut off and are not scored.
export function synthTruth(meta) {
  const s = meta.meta.spacing;
  return {
    parsed: meta.truth.map((evs) => [...evs].sort((a, b) => a.x - b.x).map((e) => ({
      bar: false,
      notes: e.notes.map((n) => ({ string: n.string, fret: n.fret, tech: n.tech, bendTo: n.bendTo, unsure: e.x < 0.5 * s || e.x > meta.w - 0.5 * s })),
    }))),
  };
}

async function readVideo(video, classify, { adapt = true } = {}) {
  const tps = truthPages(video);
  const results = new Map();
  const timing = new Map();
  // Every cached page of the video is read (a songsheet is adapted as a whole);
  // only the truth pages are scored.
  const all = adapt ? pagesOf(video) : tps.map((t) => t.page);
  const seen = new Set();
  const order = [];
  for (const p of all) {
    if (seen.has(p.sha1)) continue;
    seen.add(p.sha1);
    const img = decodePage(p);
    const t0 = performance.now();
    const r = readPage(img, { classify, keep: adapt });
    timing.set(p.sha1, performance.now() - t0);
    results.set(p.sha1, r);
    order.push(p.sha1);
  }
  const raw = tps.map((t) => ({ id: t.id, st: { ...scorePage(results.get(t.page.sha1), t.truth), ms: timing.get(t.page.sha1) } }));
  let adapted = null;
  if (adapt) {
    const list = order.map((h) => results.get(h));
    const out = adaptSheet(list);
    const byHash = new Map(order.map((h, i) => [h, out[i]]));
    adapted = tps.map((t) => ({ id: t.id, st: { ...scorePage(byHash.get(t.page.sha1), t.truth), ms: timing.get(t.page.sha1) } }));
  }
  return { raw, adapted, found: tps.map((t) => results.get(t.page.sha1).found) };
}

const pct = (x) => `${(100 * x).toFixed(1)}`;
function row(name, t) {
  const f = t.flags;
  return [name.padEnd(16), String(t.pages).padStart(3), pct(t.P).padStart(6), pct(t.R).padStart(6), pct(t.F1).padStart(6),
    String(t.wrongFret).padStart(4), String(t.wrongString).padStart(4), String(t.missed).padStart(4), String(t.extra).padStart(4), String(t.split + t.merged).padStart(4),
    (t.techT + t.techR ? `${pct(t.techP)}/${pct(t.techRec)}` : '-').padStart(11), (t.chords ? pct(t.chordAcc) : '-').padStart(6), pct(t.cleanRate).padStart(6),
    (f.errors ? `${pct(f.share)}@${pct(f.rate)}` : `-@${pct(f.rate)}`).padStart(11), t.msPage.toFixed(0).padStart(5)].join(' ');
}
const HEAD = ['set'.padEnd(16), 'pgs', '  prec', '   rec', '    F1', 'fret', 'strg', 'miss', 'xtra', 'grp', ' tech P/R  ', 'chord', ' clean', 'flag%@rate', '   ms'].join(' ');

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
  const flag = (name) => argv.includes(name);
  const only = arg('--video', null);
  const showHold = flag('--show-holdout');
  const adapt = !flag('--no-adapt');
  const modelFile = path.resolve(arg('--model', MODEL));
  const hold = holdouts();
  const report = { time: new Date().toISOString(), model: null, staff: null, videos: {}, lovo: null };

  if (!only) {
    report.staff = staffCheck();
    const s = report.staff;
    console.log(`staff: ${s.exact6}/${s.pages} pages give exactly one six-line system, worst line error ${s.maxErr.toFixed(3)} s; low-res: ${Object.entries(s.lowRes).map(([v, x]) => `${v} ${x.found}/${x.pages} found`).join(', ')}`);
  }

  const model = await loadModel(modelFile);
  report.model = { id: model.id, file: path.relative(ROOT, modelFile), bytes: fs.statSync(modelFile).size };
  console.log(`model ${model.id} (${(report.model.bytes / 1024).toFixed(1)} KB)`);

  const videos = [...DEV, ...(flag('--dev-only') ? [] : hold)].filter((v) => !only || v === only);
  const agg = { dev: [], devA: [], hold: [], holdA: [] };
  const lines = [];
  for (const video of videos) {
    const isHold = hold.includes(video);
    const tps = truthPages(video);
    if (!tps.length) {
      // No truth: it must not be read at all (the 358p video).
      const pages = pagesOf(video);
      const found = pages.map((p) => readPage(decodePage(p), { classify: model.classify }).found);
      report.videos[video] = { holdout: isHold, noTruth: true, found: found.filter(Boolean).length, pages: pages.length };
      console.log(`${isHold && !showHold ? 'a hold-out' : video} without truth: ${found.filter(Boolean).length}/${pages.length} pages found (must be 0)`);
      continue;
    }
    const r = await readVideo(video, model.classify, { adapt });
    const t = sum(r.raw.map((x) => x.st));
    const ta = r.adapted ? sum(r.adapted.map((x) => x.st)) : null;
    report.videos[video] = { holdout: isHold, raw: t, adapted: ta, pages: r.raw.map((x) => ({ id: x.id, tp: x.st.tp, fp: x.st.fp, fn: x.st.fn, errors: x.st.errors })) };
    (isHold ? agg.hold : agg.dev).push(...r.raw.map((x) => x.st));
    if (ta) (isHold ? agg.holdA : agg.devA).push(...r.adapted.map((x) => x.st));
    if (!isHold || showHold) {
      lines.push(row(video, t));
      if (ta) lines.push(row('  +adapt', ta));
    }
  }
  console.log(HEAD);
  for (const l of lines) console.log(l);
  const summary = {};
  for (const [k, v] of Object.entries(agg)) if (v.length) { summary[k] = sum(v); }
  if (summary.dev) console.log(row('DEV', summary.dev));
  if (summary.devA) console.log(row('DEV +adapt', summary.devA));
  if (summary.hold) console.log(row('HOLD-OUT', summary.hold));
  if (summary.holdA) console.log(row('HOLD-OUT +adapt', summary.holdA));
  report.summary = summary;

  // Floors: what this reader scores now, less a margin for noise. Raised when
  // it improves, never lowered to let a regression through.
  const FLOORS = { dev: 0.99, hold: 0.97 };
  for (const [k, floor] of Object.entries(FLOORS)) {
    if (summary[k] && summary[k].F1 < floor) {
      console.log(`${k === 'dev' ? 'DEV' : 'HOLD-OUT'} F1 ${(summary[k].F1 * 100).toFixed(1)} is below its floor ${(floor * 100).toFixed(0)}`);
      process.exitCode = 1;
    }
  }

  if (flag('--synth')) {
    // End to end on synthetic pages never trained on (tabread-synth.mjs --eval).
    const { loadSynthPage, synthSeeds, EVAL_PAGES } = await import('./tabread-synth.mjs');
    const byStyle = {};
    const all = [];
    let notFound = 0;
    for (const seed of synthSeeds(EVAL_PAGES)) {
      const { meta, img } = loadSynthPage(seed, EVAL_PAGES);
      const t0 = performance.now();
      const r = readPage(img, { classify: model.classify });
      const ms = performance.now() - t0;
      if (!r.found) { notFound++; continue; }
      const st = { ...scorePage(r, synthTruth(meta)), ms };
      all.push(st);
      (byStyle[meta.meta.style] ||= []).push(st);
    }
    console.log(`synthetic eval pages (${all.length} read, ${notFound} without a staff found):`);
    for (const [k, v] of Object.entries(byStyle)) console.log(row(`  ${k}`, sum(v)));
    report.synth = sum(all);
    console.log(row('SYNTH', report.synth));
  }

  if (flag('--lovo')) {
    // One model per dev video, trained without that video's real glyphs (in
    // parallel processes), each reading only the video it never saw.
    const tmp = path.join(OUT, 'lovo');
    fs.mkdirSync(tmp, { recursive: true });
    const devs = DEV.filter((v) => !only || v === only);
    const par = Number(arg('--lovo-par', 3));
    const epochs = arg('--lovo-epochs', '15');
    const { spawn } = await import('node:child_process');
    let next = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: Math.min(par, devs.length) }, async () => {
      for (;;) {
        const video = devs[next++];
        if (!video) return;
        const file = path.join(tmp, `model-${video}.js`);
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'tabread-train.mjs'), '--leave-out', video, '--epochs', epochs, '--out', file], { stdio: ['ignore', 'ignore', 'inherit'] });
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`training without ${video} failed`))));
        });
      }
    }));
    console.log(`\nleave-one-video-out (${devs.length} models, ${((Date.now() - t0) / 60000).toFixed(1)} min): each video read by a model trained without its real glyphs`);
    console.log(HEAD);
    const per = [];
    const perA = [];
    for (const video of devs) {
      const m = await loadModel(path.join(tmp, `model-${video}.js`));
      const r = await readVideo(video, m.classify, { adapt });
      per.push(...r.raw.map((x) => x.st));
      console.log(row(video, sum(r.raw.map((x) => x.st))));
      if (r.adapted) {
        perA.push(...r.adapted.map((x) => x.st));
        console.log(row('  +adapt', sum(r.adapted.map((x) => x.st))));
      }
    }
    report.lovo = { dev: sum(per), devA: perA.length ? sum(perA) : null };
    console.log(row('DEV (lovo)', report.lovo.dev));
    if (report.lovo.devA) console.log(row('DEV (lovo) +adapt', report.lovo.devA));
  }

  const f = report.summary.dev?.flags;
  if (f) console.log(`flag threshold (dev): conf < ${f.threshold} flags ${pct(f.rate)}% of notes and catches ${f.caught}/${f.errors} misread notes (${pct(f.share)}%; ${pct(f.shareAll)}% counting missed notes)`);
  if (!showHold) {
    // Hold-out detail stays out of stdout; the file keeps only the aggregate.
    for (const v of hold) if (report.videos[v]) report.videos[v] = { holdout: true, noTruth: report.videos[v].noTruth, found: report.videos[v].found };
  }
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`→ ${path.relative(ROOT, file)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
