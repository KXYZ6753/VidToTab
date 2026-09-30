// Ground truth for the tab reader: what every note on a page actually is.
//
//   node scripts/tabread-truth.mjs --crops [--video id] [--pages 6]
//       Picks pages from each cached eval video, writes them at 2x with a
//       coloured tick on each of the six string lines, and lists them in
//       .cache/tabread/truth-crops/manifest.json. These are what the people
//       (or agents) transcribing a page look at.
//   node scripts/tabread-truth.mjs --diff [--video id]
//       Compares two independent transcriptions of each page (<page>.A.json and
//       <page>.B.json) and lists every event where they disagree, so a third
//       reader only has to settle those.
//   node scripts/tabread-truth.mjs --promote
//       Makes each page both transcribers read identically final truth.
//   node scripts/tabread-truth.mjs --check
//       Parses every final transcription and reports anything malformed.
//   node scripts/tabread-truth.mjs --validate <file>
//       Parses one transcription and summarises it.
//
// A transcription lives in scripts/tabread-truth/<video>/<page>.json and holds
// systems of events, left to right. An event is the notes played together —
// digits stacked on the same vertical — written as space-separated notes, or
// "|" for a barline. A note is <string>:<fret>, string 1 being the top line
// (high e) and 6 the bottom (low E), with the technique marks written inline:
//
//   3:5      fret 5 on the G string          6:x     muted (x on the line)
//   1:h7     hammered on to 7                1:p5    pulled off to 5
//   2:/9     slid up into 9                  2:\4    slid down into 4
//   3:7b9    bent from 7 to 9 (r = release)  4:5~    vibrato
//   5:(5)    ghost / bracketed               1:<12>  natural harmonic
//   2:g3     grace note (small digit)        1:7?    unsure — not scored
//
// The page is identified by its start time in the video as well as its file,
// so a re-run of the pipeline that renders the pages again still matches.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'eval');
const CROPS = path.join(ROOT, '.cache', 'tabread', 'truth-crops');
const TRUTH = path.join(ROOT, 'scripts', 'tabread-truth');
const FFMPEG = process.env.VIDTOTAB_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.VIDTOTAB_FFPROBE || 'ffprobe';

const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
const flag = (name) => argv.includes(name);

// The six string colours, top to bottom, as named to whoever transcribes.
export const TICKS = ['red', 'orange', 'yellow', 'lime', 'deepskyblue', 'magenta'];

// ---------------------------------------------------------------- grammar

// One note token → { string, fret, tech[], bendTo, unsure } or throws.
export function parseNote(tok) {
  const m = /^([1-6]):(.+)$/.exec(tok);
  if (!m) throw new Error(`not a note: "${tok}"`);
  const string = Number(m[1]);
  let s = m[2];
  const tech = [];
  let unsure = false;
  if (s.endsWith('?')) { unsure = true; s = s.slice(0, -1); }
  if (s.endsWith('~')) { tech.push('~'); s = s.slice(0, -1); }
  let bendTo = null;
  const bend = /^(.*\d)([br])(\d{1,2})$/.exec(s);
  if (bend) { tech.push(bend[2] === 'b' ? 'b' : 'r'); bendTo = Number(bend[3]); s = bend[1]; }
  const lead = /^([hps/\\])(.+)$/.exec(s);
  if (lead) { tech.push(lead[1]); s = lead[2]; }
  let fret;
  if (/^\(\d{1,2}\)$/.test(s)) { tech.push('ghost'); fret = Number(s.slice(1, -1)); }
  else if (/^<\d{1,2}>$/.test(s)) { tech.push('harm'); fret = Number(s.slice(1, -1)); }
  else if (/^g\d{1,2}$/.test(s)) { tech.push('grace'); fret = Number(s.slice(1)); }
  else if (/^[xX]$/.test(s)) { tech.push('x'); fret = null; }
  else if (/^\d{1,2}$/.test(s)) fret = Number(s);
  else throw new Error(`not a fret: "${tok}"`);
  if (fret !== null && fret > 24) throw new Error(`fret over 24: "${tok}"`);
  return { string, fret, tech, bendTo, unsure };
}

export function parseEvent(ev) {
  if (ev.trim() === '|') return { bar: true, notes: [] };
  const notes = ev.trim().split(/\s+/).map(parseNote);
  const seen = new Set();
  for (const n of notes) {
    if (seen.has(n.string)) throw new Error(`string ${n.string} twice in "${ev}"`);
    seen.add(n.string);
  }
  return { bar: false, notes };
}

export function loadTruth(file) {
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(t.systems)) throw new Error('no systems');
  return { ...t, parsed: t.systems.map((s) => (s.events || []).map(parseEvent)) };
}

// ---------------------------------------------------------------- pages

function latestRun(video) {
  const dir = path.join(CACHE, video);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const runs = fs.readdirSync(dir).filter((d) => d.startsWith('out-') && fs.existsSync(path.join(dir, d, 'captures-0.5.json')));
  if (!runs.length) return null;
  runs.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, runs[0]);
}

export function videosWithPages() {
  return fs.readdirSync(CACHE).filter((v) => latestRun(v)).sort();
}

export function pagesOf(video) {
  const run = latestRun(video);
  const caps = JSON.parse(fs.readFileSync(path.join(run, 'captures-0.5.json'), 'utf8'));
  let calib = null;
  try { calib = JSON.parse(fs.readFileSync(path.join(run, 'work-0.5', 'frames.json'), 'utf8')).calib; } catch { /* none */ }
  return caps.filter((c) => c.png).map((c) => {
    const file = path.join(run, 'work-0.5', c.png);
    const bytes = fs.readFileSync(file);
    return {
      id: c.png.replace(/\.png$/, '').replace(/^.*?-(cap-\d+)$/, '$1'),
      file,
      tStart: c.tStart,
      tEnd: c.tEnd,
      w: c.w,
      h: c.h,
      sha1: crypto.createHash('sha1').update(bytes).digest('hex'),
      // Calibration rows are half-resolution crop pixels; on the page they
      // are twice that, measured to within a pixel or two.
      lines: calib?.staff?.rows ? calib.staff.rows.map((r) => 2 * r + 0.5) : null,
    };
  });
}

// Evenly through the video, skipping pages whose pixels repeat an earlier one.
function pick(pages, n) {
  const uniq = [];
  const seen = new Set();
  for (const p of pages) if (!seen.has(p.sha1)) { seen.add(p.sha1); uniq.push(p); }
  if (uniq.length <= n) return uniq;
  const out = [];
  for (let i = 0; i < n; i++) out.push(uniq[Math.round((i * (uniq.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

function crops() {
  const only = arg('--video');
  const n = Number(arg('--pages', 6));
  const manifest = [];
  for (const video of videosWithPages()) {
    if (only && video !== only) continue;
    const per = Number(arg(`--pages-${video}`, video === '73HxHE5e2yY' || video === '9E9lOx6LfTk' ? Math.max(n, 8) : n));
    const out = path.join(CROPS, video);
    fs.mkdirSync(out, { recursive: true });
    for (const p of pick(pagesOf(video), per)) {
      const dest = path.join(out, `${p.id}.png`);
      // 2x, a white margin on the left, and a coloured tick there on each
      // string line, so a stacked chord cannot be read onto the wrong strings.
      const pad = 36;
      const boxes = (p.lines || []).slice(0, 6).map((y, i) => `drawbox=x=4:y=${Math.round(2 * y) - 4}:w=26:h=8:color=${TICKS[i]}:t=fill`);
      const vf = [`scale=iw*2:ih*2:flags=lanczos`, `pad=iw+${pad}:ih:${pad}:0:white`, ...boxes].join(',');
      execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', p.file, '-vf', vf, dest]);
      manifest.push({ video, page: p.id, tStart: p.tStart, tEnd: p.tEnd, w: p.w, h: p.h, sha1: p.sha1, crop: path.relative(ROOT, dest), original: path.relative(ROOT, p.file), ticked: Boolean(p.lines) });
    }
  }
  fs.mkdirSync(CROPS, { recursive: true });
  fs.writeFileSync(path.join(CROPS, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const byVideo = {};
  for (const m of manifest) byVideo[m.video] = (byVideo[m.video] || 0) + 1;
  console.log(`${manifest.length} pages →`, byVideo);
}

// ---------------------------------------------------------------- diff

const key = (n) => `${n.string}:${n.fret === null ? 'x' : n.fret}`;

// In-order alignment of two event lists (edit distance over events), so one
// missed event does not make everything after it look like a disagreement.
export function alignEvents(a, b) {
  const cost = (x, y) => {
    if (x.bar || y.bar) return x.bar && y.bar ? 0 : 1;
    const sx = new Set(x.notes.map(key));
    const sy = new Set(y.notes.map(key));
    const inter = [...sx].filter((k) => sy.has(k)).length;
    return 1 - inter / Math.max(1, Math.max(sx.size, sy.size));
  };
  const n = a.length;
  const m = b.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) D[i][0] = i * 0.6;
  for (let j = 1; j <= m; j++) D[0][j] = j * 0.6;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      D[i][j] = Math.min(D[i - 1][j - 1] + cost(a[i - 1], b[j - 1]), D[i - 1][j] + 0.6, D[i][j - 1] + 0.6);
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + cost(a[i - 1], b[j - 1])) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (i > 0 && D[i][j] === D[i - 1][j] + 0.6) { pairs.push([i - 1, null]); i--; }
    else { pairs.push([null, j - 1]); j--; }
  }
  return pairs.reverse();
}

function diff() {
  const only = arg('--video');
  let pages = 0;
  let agreeEvents = 0;
  let totalEvents = 0;
  const report = [];
  for (const video of fs.existsSync(TRUTH) ? fs.readdirSync(TRUTH) : []) {
    if (only && video !== only) continue;
    const dir = path.join(TRUTH, video);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.A.json'))) {
      const page = f.replace(/\.A\.json$/, '');
      const fb = path.join(dir, `${page}.B.json`);
      if (!fs.existsSync(fb)) continue;
      let A;
      let B;
      try { A = loadTruth(path.join(dir, f)); B = loadTruth(fb); } catch (e) { report.push({ video, page, error: e.message }); continue; }
      pages++;
      const lines = [];
      const sys = Math.max(A.parsed.length, B.parsed.length);
      if (A.parsed.length !== B.parsed.length) lines.push(`systems: A ${A.parsed.length}, B ${B.parsed.length}`);
      for (let s = 0; s < sys; s++) {
        const ea = A.parsed[s] || [];
        const eb = B.parsed[s] || [];
        for (const [i, j] of alignEvents(ea, eb)) {
          totalEvents++;
          const ta = i === null ? '—' : A.systems[s].events[i];
          const tb = j === null ? '—' : B.systems[s].events[j];
          const same = i !== null && j !== null && ta.split(/\s+/).map((t) => t.replace(/\?$/, '')).sort().join(' ') === tb.split(/\s+/).map((t) => t.replace(/\?$/, '')).sort().join(' ');
          if (same) agreeEvents++;
          else lines.push(`sys ${s} event A#${i ?? '-'} "${ta}"  vs  B#${j ?? '-'} "${tb}"`);
        }
      }
      if (lines.length) report.push({ video, page, disagreements: lines });
    }
  }
  const out = path.join(ROOT, '.cache', 'tabread', 'truth-diff.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const rate = totalEvents ? agreeEvents / totalEvents : 0;
  console.log(`${pages} pages compared, ${agreeEvents}/${totalEvents} events agree (${(rate * 100).toFixed(1)}%), ${report.length} pages to settle → ${path.relative(ROOT, out)}`);
}

// A page both transcribers read identically becomes final truth as is; the
// rest wait for a third reader (--final writes one of those by hand).
function promote() {
  let done = 0;
  let waiting = 0;
  for (const video of fs.existsSync(TRUTH) ? fs.readdirSync(TRUTH) : []) {
    const dir = path.join(TRUTH, video);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.A.json'))) {
      const page = f.replace(/\.A\.json$/, '');
      const fb = path.join(dir, `${page}.B.json`);
      const final = path.join(dir, `${page}.json`);
      if (!fs.existsSync(fb) || fs.existsSync(final)) continue;
      const A = loadTruth(path.join(dir, f));
      const B = loadTruth(fb);
      const norm = (t) => JSON.stringify(t.systems.map((sys) => (sys.events || []).map((e) => e.trim().split(/\s+/).map((x) => x.replace(/\?$/, '')).sort().join(' '))));
      if (norm(A) !== norm(B)) { waiting++; continue; }
      const { parsed, ...rest } = A;
      // Unsure marks from either reader stay: agreement on a guess is still a guess.
      const unsureB = new Set(B.systems.flatMap((sys) => sys.events).flatMap((e) => e.split(/\s+/)).filter((x) => x.endsWith('?')).map((x) => x.slice(0, -1)));
      const systems = rest.systems.map((sys) => ({ events: sys.events.map((e) => e.split(/\s+/).map((x) => (!x.endsWith('?') && unsureB.has(x) ? `${x}?` : x)).join(' ')) }));
      fs.writeFileSync(final, JSON.stringify({ ...rest, systems, by: ['A', 'B'], comments: [A.comments, B.comments].filter(Boolean).join(' / ') }, null, 2) + '\n');
      done++;
    }
  }
  console.log(`${done} pages promoted to final truth, ${waiting} still need settling`);
}

function check() {
  let ok = 0;
  let bad = 0;
  let events = 0;
  let notes = 0;
  for (const video of fs.existsSync(TRUTH) ? fs.readdirSync(TRUTH) : []) {
    for (const f of fs.readdirSync(path.join(TRUTH, video)).filter((x) => /^cap-\d+\.json$/.test(x))) {
      try {
        const t = loadTruth(path.join(TRUTH, video, f));
        for (const s of t.parsed) for (const e of s) { if (!e.bar) { events++; notes += e.notes.length; } }
        ok++;
      } catch (e) {
        bad++;
        console.log(`FAIL ${video}/${f}: ${e.message}`);
      }
    }
  }
  console.log(`${ok} transcriptions parse (${events} events, ${notes} notes), ${bad} broken`);
  if (bad) process.exitCode = 1;
}

// ---------------------------------------------------------------- self-check

export function selfCheck(assert) {
  assert.deepEqual(parseNote('3:5'), { string: 3, fret: 5, tech: [], bendTo: null, unsure: false });
  assert.deepEqual(parseNote('1:h12').tech, ['h']);
  assert.deepEqual(parseNote('3:7b9'), { string: 3, fret: 7, tech: ['b'], bendTo: 9, unsure: false });
  assert.deepEqual(parseNote('6:x'), { string: 6, fret: null, tech: ['x'], bendTo: null, unsure: false });
  assert.deepEqual(parseNote('1:<12>').tech, ['harm']);
  assert.equal(parseNote('2:(5)').fret, 5);
  assert.equal(parseNote('2:g3').tech[0], 'grace');
  assert.equal(parseNote('1:7?').unsure, true);
  assert.deepEqual(parseNote('2:\\4').tech, ['\\']);
  assert.deepEqual(parseNote('4:5~').tech, ['~']);
  assert.throws(() => parseNote('7:3'));
  assert.throws(() => parseNote('1:25'));
  assert.throws(() => parseEvent('1:3 1:5'), /twice/);
  assert.equal(parseEvent('|').bar, true);
  const ev = (s) => s.map(parseEvent);
  const pairs = alignEvents(ev(['1:0', '2:3', '3:2']), ev(['1:0', '3:2']));
  assert.deepEqual(pairs, [[0, 0], [1, null], [2, 1]], 'one missed event does not shift the rest');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (flag('--validate')) {
    // One transcription file, as the person writing it would check it.
    const t = loadTruth(path.resolve(arg('--validate')));
    const events = t.parsed.flat().filter((e) => !e.bar);
    console.log(`ok: ${t.parsed.length} system(s), ${events.length} events, ${events.reduce((n, e) => n + e.notes.length, 0)} notes, ${events.flatMap((e) => e.notes).filter((n) => n.unsure).length} unsure`);
  } else if (flag('--promote')) promote();
  else if (flag('--crops')) crops();
  else if (flag('--diff')) diff();
  else if (flag('--check')) check();
  else {
    const { strict: assert } = await import('node:assert');
    selfCheck(assert);
    console.log('tabread-truth.mjs self-check passed');
  }
}
