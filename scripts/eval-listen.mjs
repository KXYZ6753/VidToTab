// Real-audio benchmark for follow-along: does the listener hear the guitar in
// the eval videos play exactly what the hand-checked tab says?
//
//   node scripts/eval-listen.mjs [--only id] [--repeats] [--strict] [--degrade] [--verbose]
//
// Every eval video's soundtrack is a recording of the tab being played, and
// every page knows when it was on screen. So for each ground-truth page
// (scripts/tabread-truth/) the page's window of audio is fed through the
// engine in Wait mode, arming the page's events one after another, and the
// score is how far it gets: the share of events accepted in order.
//
// Two controls keep a lenient listener honest. The same audio against the
// page's notes moved up a semitone, and against a different page's notes,
// must get almost nowhere — a listener that accepts anything passes the main
// test and fails these. --degrade adds what a laptop microphone does to a
// guitar (low end cut, room noise, a little reverb) as a second column.
//
// Tuning and capo per video come from scripts/listen-set.json; videos marked
// `backing` (the soundtrack is the song, not a guitar) are reported but left
// out of the median. Floors there are gated like the page-detection eval.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTruth, pagesOf } from './tabread-truth.mjs';
import { buildEvents, normaliseListen } from '../public/shared/follow.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'eval');
const TRUTH = path.join(ROOT, 'scripts', 'tabread-truth');
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'listen-set.json'), 'utf8')).videos;
const FFMPEG = process.env.VIDTOTAB_FFMPEG || 'ffmpeg';
const SR = 48000;
// The page on screen and its notes being played are not in step in these
// videos: on 21 of 51 pages the first note sounds over a second before the
// page appears, and pages holding 16–24 notes are often shown for only 2–3 s
// while the playing runs on after them. Wider windows than that let a page
// match the same riff played again elsewhere; the +1-semitone control is what
// shows they are not buying a free pass (it stays at about 2%).
const LEAD = 1.5;
const TAIL = 3;

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const flag = (n) => argv.includes(n);
const only = arg('--only');
const verbose = flag('--verbose');

const { createEngine } = await import('../public/shared/listen.js');

function audioOf(video) {
  const file = path.join(CACHE, video, 'audio-48k.f32');
  if (!fs.existsSync(file)) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', path.join(CACHE, video, 'video.mp4'), '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', file]);
  }
  const buf = fs.readFileSync(file);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

// What a laptop mic and a room do: low end gone below ~150 Hz, room noise at
// about 15 dB below the playing, a short reverb tail. Deterministic.
function degrade(pcm) {
  const out = new Float32Array(pcm.length);
  let rms = 0;
  for (let i = 0; i < pcm.length; i++) rms += pcm[i] * pcm[i];
  rms = Math.sqrt(rms / Math.max(1, pcm.length)) || 1e-3;
  const noiseAmp = rms / Math.pow(10, 15 / 20);
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  let b0 = 0; let b1 = 0; let b2 = 0; // pink-ish noise
  const a = Math.exp(-2 * Math.PI * 150 / SR); // one-pole high-pass
  let hpIn = 0; let hpOut = 0;
  const delays = [1723, 2519, 3301].map((d) => ({ d, g: 0.18 }));
  for (let i = 0; i < pcm.length; i++) {
    const w = rand();
    b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048;
    let x = pcm[i];
    for (const { d, g } of delays) if (i >= d) x += g * out[i - d];
    hpOut = a * (hpOut + x - hpIn);
    hpIn = x;
    out[i] = hpOut + noiseAmp * 3 * (b0 + b1 + b2);
  }
  return out;
}

// Truth page → the reading shape buildEvents takes.
function truthReading(truth) {
  return {
    found: true,
    systems: truth.parsed.map((events) => ({
      events: events.filter((e) => !e.bar).map((e, i) => ({
        x0: i * 10, x1: i * 10 + 8, xc: i * 10 + 4, conf: e.notes.some((n) => n.unsure) ? 0.3 : 1,
        notes: e.notes.map((n) => ({ string: n.string, fret: n.fret, tech: n.tech, bendTo: n.bendTo, conf: n.unsure ? 0.3 : 1 })),
      })),
    })),
  };
}

const shift = (events, semis) => events.map((e) => ({ ...e, notes: e.notes.map((n) => ({ ...n, midi: n.midi === null ? null : n.midi + semis, bendTo: n.bendTo ? n.bendTo + semis : n.bendTo })) }));

// One wait-mode pass: how many events are accepted, in order, from this audio.
// An accept may come for the event after the armed one (the engine listens
// ahead and skips an event nobody played): it counts, the skipped one does
// not, and the next one after it is armed.
function follow(pcm, events, strictness) {
  const eng = createEngine({ sampleRate: SR });
  eng.setMode('wait');
  eng.setStrictness(strictness);
  const targets = events.map((e) => ({ id: e.id, notes: e.notes.map((n) => ({ midi: n.midi, string: n.string, required: n.required, tech: n.tech, bendTo: n.bendTo })), pitchless: e.pitchless }));
  eng.setTargets(targets);
  let current = 0;
  let accepted = 0;
  let skipped = 0;
  eng.arm(0);
  const lat = [];
  for (let off = 0; off < pcm.length && current < targets.length; off += eng.hop) {
    const msgs = eng.push(pcm.subarray(off, Math.min(pcm.length, off + eng.hop)));
    for (const m of msgs) {
      if (m.type === 'accept' && m.index >= current) {
        skipped += m.index - current;
        accepted++;
        current = m.index + 1;
        if (Number.isFinite(m.latencyMs)) lat.push(m.latencyMs);
        if (current < targets.length) eng.arm(current);
      }
    }
  }
  return { accepted, skipped, reached: current, total: targets.length };
}

const strictness = flag('--strict') ? 'strict' : 'lenient';
const rows = [];
const t0 = Date.now();
for (const video of fs.readdirSync(TRUTH).sort()) {
  if (only && video !== only) continue;
  const conf = SET[video];
  if (!conf) { console.log(`skip ${video}: no tuning in listen-set.json`); continue; }
  const settings = normaliseListen({ tuningId: conf.tuning ? 'custom' : 'standard', tuning: conf.tuning, capo: conf.capo });
  const pages = Object.fromEntries(pagesOf(video).map((p) => [p.id, p]));
  const audio = audioOf(video);
  const truths = fs.readdirSync(path.join(TRUTH, video)).filter((f) => /^cap-\d+\.json$/.test(f)).sort()
    .map((f) => ({ id: f.replace('.json', ''), truth: loadTruth(path.join(TRUTH, video, f)) }))
    .filter((t) => pages[t.id]);
  const stat = { video, backing: Boolean(conf.backing), pages: 0, progress: [], semitone: [], other: [], degraded: [] };
  truths.forEach(({ id, truth }, k) => {
    const page = pages[id];
    // --shift n: the expected notes moved n semitones, to check a video's
    // tuning and capo (the right ones score best).
    const events = shift(buildEvents(truthReading(truth), settings, { page: k }), Number(arg('--shift')) || 0);
    if (!events.length) return;
    const starts = [page.tStart, ...(flag('--repeats') ? [] : [])];
    const dur = Math.max(1, page.tEnd - page.tStart);
    for (const start of starts) {
      const a = Math.max(0, Math.floor((start - LEAD) * SR));
      const b = Math.min(audio.length, Math.ceil((start + dur + TAIL) * SR));
      const pcm = audio.subarray(a, b);
      const main = follow(pcm, events, strictness);
      const up = follow(pcm, shift(events, 1), strictness);
      const other = truths[(k + Math.ceil(truths.length / 2)) % truths.length];
      const otherEvents = other && other.id !== id ? buildEvents(truthReading(other.truth), settings) : [];
      const cross = otherEvents.length ? follow(pcm, otherEvents, strictness) : null;
      stat.pages++;
      stat.progress.push(main.accepted / main.total);
      stat.semitone.push(up.accepted / up.total);
      if (cross) stat.other.push(cross.accepted / cross.total);
      if (flag('--degrade')) { const d = follow(degrade(pcm), events, strictness); stat.degraded.push(d.accepted / d.total); }
      if (verbose) console.log(`${video} ${id}: ${main.accepted}/${main.total}${main.skipped ? ` (${main.skipped} skipped)` : ''}  +1 semitone ${up.accepted}/${up.total}${cross ? `  other page ${cross.accepted}/${cross.total}` : ''}`);
    }
  });
  rows.push(stat);
}

const SEMITONE_MAX = 0.15;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');
console.log(`\nfollow-along on real recordings (${strictness}, Wait mode)`);
console.log('video           pages  progress  +1 semitone  other page' + (flag('--degrade') ? '  degraded' : '') + '  floor');
let failed = 0;
for (const r of rows) {
  const floor = SET[r.video]?.floor;
  const p = mean(r.progress);
  const below = Number.isFinite(floor) && p < floor - 1e-9;
  // A listener that hears what it is told to expect would pass the floors;
  // the same audio against the notes a semitone up must get almost nowhere.
  const lax = mean(r.semitone) > SEMITONE_MAX;
  if (below || lax) failed++;
  console.log(`${r.video.padEnd(15)} ${String(r.pages).padStart(5)}  ${pct(p).padStart(8)}  ${pct(mean(r.semitone)).padStart(11)}  ${pct(mean(r.other)).padStart(10)}${flag('--degrade') ? `  ${pct(mean(r.degraded)).padStart(8)}` : ''}  ${Number.isFinite(floor) ? pct(floor) : '—'}${r.backing ? '  (backing)' : ''}${below ? '  BELOW FLOOR' : ''}${lax ? '  ACCEPTS WRONG NOTES' : ''}`);
}
const solo = rows.filter((r) => !r.backing);
console.log(`\nsolo guitar: median progress ${pct(median(solo.map((r) => mean(r.progress))))}, +1 semitone ${pct(median(solo.map((r) => mean(r.semitone))))}, other page ${pct(median(solo.map((r) => mean(r.other))))}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const out = path.join(ROOT, '.cache', 'eval', `summary-listen-${strictness}.json`);
fs.writeFileSync(out, JSON.stringify(rows, null, 2));
if (failed) { console.log(`${failed} video(s) below their floor`); process.exitCode = 1; }
