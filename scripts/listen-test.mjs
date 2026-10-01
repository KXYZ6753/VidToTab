// Benchmark for the follow-along listener (public/shared/listen.js) on
// synthetic guitar recordings (scripts/guitar-synth.mjs).
//
// Every scenario is a timed list of trials. A trial is an event the engine is
// armed with and what the player actually does around it: the right notes
// (positive) or a mistake / nothing (negative). Audio goes through the engine
// in hop-sized chunks (512 samples at 48 kHz) in wait mode, the way the
// listening worker feeds it, and the next event is armed as soon as the engine
// accepts — or, if it never does, 50 ms before the player plays the next one.
// Positive scenarios run clean and at 10 dB SNR (room noise calibrated for
// 1.5 s first); a few also at 20 dB and through a laptop-microphone filter.
// Every target is printed with PASS/FAIL; the exit code is 1 if any fails.
//
//   node scripts/listen-test.mjs                 run everything
//   node scripts/listen-test.mjs --wav out/      also write every scenario as WAV
//   node scripts/listen-test.mjs --verbose       list failed and slow trials
//   node scripts/listen-test.mjs --only chords   scenarios whose name contains this
//   node scripts/listen-test.mjs --timing        time each scenario
//   node scripts/listen-test.mjs --params '{"freshShare":0.6}'   engine overrides
//   node scripts/listen-test.mjs --debug restrike/clean@4.6      candidates per
//                                                frame around that time

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { synth, writeWav, roomNoise, mulberry32, biquad, standardMidi as sm } from './guitar-synth.mjs';

// LISTEN_ENGINE=<path>: benchmark another copy of the engine (an
// instrumented one while tuning)
const { createEngine } = await import(process.env.LISTEN_ENGINE ? path.resolve(process.env.LISTEN_ENGINE) : '../public/shared/listen.js');

const SR = 48000;
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const wavDir = opt('--wav');
const only = opt('--only');
const verbose = argv.includes('--verbose');
const engineParams = JSON.parse(opt('--params') || '{}'); // engine overrides, for tuning
// --debug <scenario>/<condition>@<seconds>: print the engine's candidates
// frame by frame around that time (e.g. --debug restrike/clean@4.6)
const debugAt = (() => {
  const d = opt('--debug');
  const m = d && d.match(/^(.+)\/(.+)@([\d.]+)$/);
  return m ? { sc: m[1], cond: m[2], t: Number(m[3]) } : null;
})();
if (wavDir) mkdirSync(wavDir, { recursive: true });

// ------------------------------------------------------------ building blocks

const N = (string, fret, tech = []) => ({ string, fret, midi: sm(string, fret), tech: [].concat(tech) });
const SHAPES = {
  E: [[6, 0], [5, 2], [4, 2], [3, 1], [2, 0], [1, 0]],
  Em: [[6, 0], [5, 2], [4, 2], [3, 0], [2, 0], [1, 0]],
  A: [[5, 0], [4, 2], [3, 2], [2, 2], [1, 0]],
  Am: [[5, 0], [4, 2], [3, 2], [2, 1], [1, 0]],
  C: [[5, 3], [4, 2], [3, 0], [2, 1], [1, 0]],
  D: [[4, 0], [3, 2], [2, 3], [1, 2]],
  Dm: [[4, 0], [3, 2], [2, 3], [1, 1]],
  G: [[6, 3], [5, 2], [4, 0], [3, 0], [2, 0], [1, 3]],
  F: [[6, 1], [5, 3], [4, 3], [3, 2], [2, 1], [1, 1]],
  Fmaj7: [[4, 3], [3, 2], [2, 1], [1, 0]],
  E5: [[6, 0], [5, 2]],
  A5: [[5, 0], [4, 2]],
  G5: [[6, 3], [5, 5]],
  A5x3: [[6, 5], [5, 7], [4, 7]],
  D5x3: [[5, 5], [4, 7], [3, 7]],
};
const chord = (name, shift = 0) => SHAPES[name].map(([s, f]) => N(s, f + shift));
const barreE = (k) => [[6, k], [5, k + 2], [4, k + 2], [3, k + 1], [2, k], [1, k]].map(([s, f]) => N(s, f));
const barreA = (k) => [[5, k], [4, k + 2], [3, k + 2], [2, k + 2], [1, k]].map(([s, f]) => N(s, f));
const power = (s, k) => [N(s, k), N(s - 1, k + 2)];
const name = (notes) => (notes || []).map((n) => n.midi).join(',');

// A trial: expect → what the engine is armed with; play → what the synth plays
// at t (null: nothing). kind 'pos' | 'neg'; cls: negative class; tags: technique.
const pos = (t, notes, o = {}) => ({ t, expect: notes, play: o.play ?? notes, kind: 'pos', tags: o.tags || [], strumMs: o.strumMs ?? 0, dir: o.dir || 'down', ...o });
const neg = (t, expect, play, cls, o = {}) => ({ t, expect, play, kind: 'neg', cls, tags: [], strumMs: o.strumMs ?? 0, dir: o.dir || 'down', ...o });

// Play times: space trials by gap seconds starting at lead.
function spaced(list, gap, lead = 0.6) {
  return list.map((tr, i) => ({ ...tr, t: lead + i * gap }));
}

// ------------------------------------------------------------ scenarios

function scenarios() {
  const out = [];
  const add = (sc) => out.push({ strictness: 'lenient', calib: 0, tail: 1.0, ...sc });

  // -- positives ---------------------------------------------------------
  add({
    name: 'single-low', pos: true,
    trials: spaced([N(6, 0), N(5, 0), N(6, 3), N(5, 3), N(4, 0), N(6, 1), N(5, 2), N(4, 2), N(6, 5), N(5, 7)].map((n) => pos(0, [n], { tags: ['single'] })), 0.7),
  });
  add({
    name: 'single-high', pos: true,
    trials: spaced([N(3, 0), N(3, 2), N(2, 0), N(2, 1), N(2, 3), N(1, 0), N(1, 3), N(1, 5), N(1, 8), N(1, 12), N(2, 10), N(3, 9)].map((n) => pos(0, [n], { tags: ['single'] })), 0.6),
  });
  add({
    name: 'melody-fast', pos: true,
    trials: spaced([N(5, 3), N(4, 0), N(4, 2), N(4, 3), N(3, 0), N(3, 2), N(2, 0), N(2, 1), N(2, 0), N(3, 2), N(3, 0), N(4, 3)].map((n) => pos(0, [n], { tags: ['single'] })), 0.33),
  });
  // Fingerstyle: a pedal bass and repeated treble notes, each re-plucked
  // while it still rings (4–5 notes a second).
  add({
    name: 'repeat-fast', pos: true,
    trials: spaced([
      [N(6, 0)], [N(2, 0)], [N(6, 0)], [N(2, 0)], [N(6, 0)], [N(1, 0)], [N(6, 0)], [N(1, 0)],
      [N(5, 0)], [N(3, 2)], [N(3, 2)], [N(5, 0)], [N(3, 2)], [N(2, 1)], [N(2, 1)], [N(2, 1)],
    ].map((notes) => pos(0, notes, { tags: ['repeat'] })), 0.24),
  });
  add({
    name: 'dyads', pos: true,
    trials: spaced([
      pos(0, chord('E5'), { strumMs: 10 }), pos(0, chord('A5'), { strumMs: 15, dir: 'up' }),
      pos(0, chord('G5'), { strumMs: 20 }), pos(0, [N(3, 2), N(2, 3)], { strumMs: 5 }),
      pos(0, power(5, 3), { strumMs: 12 }), pos(0, [N(2, 5), N(1, 5)], { strumMs: 8 }),
    ].map((tr) => ({ ...tr, tags: ['chord2'] })), 0.9),
  });
  const strums = [5, 15, 30, 55];
  add({
    name: 'chords-strum', pos: true,
    trials: spaced(['A5x3', 'D', 'Fmaj7', 'C', 'A', 'E', 'G', 'Em', 'F', 'Am', 'Dm', 'D5x3'].map((c, i) => pos(0, chord(c), {
      strumMs: strums[i % 4], dir: i % 2 ? 'up' : 'down', tags: [`chord${SHAPES[c].length}`, `strum${strums[i % 4]}`],
    })), 1.1),
  });
  add({
    name: 'progression', pos: true,
    trials: spaced(['C', 'G', 'Am', 'F', 'C', 'Em', 'Am', 'D', 'G'].map((c) => pos(0, chord(c), { strumMs: 20, tags: ['change'] })), 1.0),
  });
  add({
    name: 'restrike', pos: true,
    trials: spaced(['G', 'G', 'G', 'Am', 'Am', 'E', 'E', 'E'].map((c, i, a) => pos(0, chord(c), { strumMs: 15, tags: i && a[i - 1] === c ? ['restrike'] : [] })), 0.8),
  });
  {
    // Arpeggios in wait mode: one event, notes one at a time.
    const arps = [['C', 0.15], ['Am', 0.2], ['G', 0.12], ['D', 0.18]];
    const trials = [];
    let t = 0.6;
    for (const [c, step] of arps) {
      const notes = chord(c);
      trials.push(pos(t, notes, { arpStep: step, tags: ['arpeggio'], latencyFrom: t + step * (notes.length - 1) }));
      t += step * notes.length + 1.0;
    }
    add({ name: 'arpeggio', pos: true, trials });
  }
  {
    // Hammer-ons and pull-offs: pick a note, then change it without picking.
    const licks = [
      [3, 2, [[4, 'h'], [2, 'p']]], [1, 5, [[7, 'h'], [5, 'p']]], [2, 5, [[7, 'h'], [8, 'h']]],
      [5, 2, [[3, 'h']]], [4, 2, [[4, 'h'], [2, 'p'], [0, 'p']]], [1, 8, [[10, 'h'], [8, 'p'], [7, 'p']]],
    ];
    const trials = [];
    let t = 0.6;
    for (const [s, f0, moves] of licks) {
      trials.push(pos(t, [N(s, f0)], { tags: ['pluck'] }));
      t += 0.45;
      for (const [f, tech] of moves) {
        trials.push(pos(t, [N(s, f, tech)], { tags: [tech] }));
        t += 0.45;
      }
      t += 0.5;
    }
    add({ name: 'legato', pos: true, trials });
  }
  {
    const slides = [[2, 5, 7, '/'], [4, 2, 5, '/'], [1, 7, 5, '\\'], [3, 4, 9, '/'], [5, 7, 5, '\\'], [2, 10, 12, 's']];
    const trials = [];
    let t = 0.6;
    for (const [s, a, b, tech] of slides) {
      trials.push(pos(t, [N(s, a)], { tags: ['pluck'] }));
      trials.push(pos(t + 0.5, [N(s, b, tech)], { tags: ['slide'] }));
      t += 1.5;
    }
    add({ name: 'slides', pos: true, trials });
  }
  {
    const bends = [[2, 8, 2], [3, 7, 2], [1, 10, 1], [2, 10, 2], [3, 9, 1]];
    add({
      name: 'bends', pos: true,
      trials: spaced(bends.map(([s, f, st]) => pos(0, [{ ...N(s, f, 'b'), bend: st, bendTo: sm(s, f) + st }], { tags: ['bend'] })), 1.2),
    });
  }
  add({
    name: 'harmonics', pos: true,
    trials: spaced([6, 5, 4, 3, 2, 1].map((s) => pos(0, [{ string: s, fret: 12, midi: sm(s, 12), tech: ['harm'] }], { tags: ['harm'] })), 1.0),
  });
  {
    const mute = () => [6, 5, 4, 3, 2, 1].map((s) => ({ string: s, fret: 3, midi: sm(s, 3), tech: ['x'] }));
    add({
      name: 'muted', pos: true,
      trials: spaced([
        pos(0, mute(), { strumMs: 15, tags: ['x'] }), pos(0, chord('C'), { strumMs: 15 }),
        pos(0, mute(), { strumMs: 10, tags: ['x'] }), pos(0, chord('G'), { strumMs: 20 }),
        pos(0, mute(), { strumMs: 20, dir: 'up', tags: ['x'] }), pos(0, chord('Em'), { strumMs: 10 }),
        pos(0, mute(), { strumMs: 12, tags: ['x'] }),
      ], 0.8),
    });
  }
  // The browser end-to-end song (scripts/listen-e2e.mjs): single notes, a
  // stray wrong note while A2 is armed, a 30 ms strum, then single notes over
  // the ringing chord — each must wait for its own pluck.
  add({
    name: 'song', pos: true,
    trials: [
      pos(2.5, [N(6, 0)]), pos(4.9, [N(5, 0)]), pos(6.1, chord('C'), { strumMs: 30, dir: 'down', tags: ['chord5'] }),
      pos(7.6, [N(4, 0)]), pos(8.8, [N(3, 0)]), pos(10.0, [N(2, 0)]), pos(11.2, [N(1, 0)]),
    ],
    stray: [{ t: 3.7, notes: [N(6, 1)] }],
  });
  // Strict and bass mode on correct playing (reported, not in the headline
  // recall: strict asks for every string, which some voicings cannot prove).
  add({
    name: 'strict-chords', pos: true, strictness: 'strict', info: 'strict',
    trials: spaced(['C', 'G', 'D', 'Am', 'E', 'A', 'Em', 'F'].map((c) => pos(0, chord(c), { strumMs: 15 })), 1.0),
  });
  add({
    name: 'bass-voicings', pos: true, strictness: 'bass', info: 'bass',
    trials: spaced([
      // expected open shape; played with the upper notes in other octaves
      [chord('G'), [N(6, 3), N(4, 5), N(3, 4), N(2, 3)]],
      [chord('C'), [N(5, 3), N(3, 5), N(2, 5), N(1, 3)]],
      [chord('D'), [N(4, 0), N(3, 7), N(2, 7), N(1, 5)]],
      [chord('A'), [N(5, 0), N(4, 7), N(3, 6), N(2, 5)]],
      [chord('E'), [N(6, 0), N(5, 7), N(4, 6), N(3, 4)]],
    ].map(([ex, pl]) => pos(0, ex, { play: pl, strumMs: 15 })), 1.0),
  });
  for (const d of [20, -20]) {
    add({
      name: `detune${d > 0 ? '+' : ''}${d}`, pos: true, detune: d, offset: d,
      trials: spaced(['G', 'C', 'D', 'Em'].map((c) => pos(0, chord(c), { strumMs: 15 }))
        .concat([N(6, 0), N(5, 3), N(3, 2), N(1, 5)].map((n) => pos(0, [n]))), 0.8),
    });
  }

  // -- negatives ---------------------------------------------------------
  {
    // Single notes a fret off, on every string, both ways.
    const rnd = mulberry32(7);
    const trials = [];
    const picks = [[6, 0], [6, 3], [5, 0], [5, 3], [4, 2], [4, 5], [3, 0], [3, 2], [2, 1], [2, 3], [1, 0], [1, 3], [1, 7], [2, 8], [3, 5], [4, 7], [5, 5], [6, 7]];
    for (const [s, f] of picks) {
      for (const d of [1, -1]) {
        const g = f + d < 0 ? f + 1 : f + d;
        trials.push(neg(0, [N(s, f)], [N(s, g)], 'fret'));
      }
    }
    for (let i = trials.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [trials[i], trials[j]] = [trials[j], trials[i]]; }
    add({ name: 'neg-fret-single', trials: spaced(trials, 0.6) });
  }
  add({
    name: 'neg-fret-chord',
    trials: spaced([
      neg(0, barreE(1), barreE(2), 'fret', { strumMs: 15 }), neg(0, barreE(3), barreE(2), 'fret', { strumMs: 20 }),
      neg(0, barreA(2), barreA(3), 'fret', { strumMs: 10 }), neg(0, barreA(5), barreA(4), 'fret', { strumMs: 25 }),
      neg(0, power(6, 5), power(6, 6), 'fret', { strumMs: 10 }), neg(0, power(5, 3), power(5, 2), 'fret', { strumMs: 10 }),
      neg(0, power(6, 1), power(6, 0), 'fret', { strumMs: 12 }), neg(0, chord('A5x3'), chord('A5x3', 1), 'fret', { strumMs: 15 }),
      neg(0, chord('D5x3'), chord('D5x3', -1), 'fret', { strumMs: 15 }), neg(0, [N(3, 2), N(2, 3)], [N(3, 3), N(2, 4)], 'fret', { strumMs: 5 }),
    ], 1.0),
  });
  {
    // Strict: one string of the chord a fret off.
    const swap = (c, s, d) => chord(c).map((n) => (n.string === s ? N(s, n.fret + d) : n));
    add({
      name: 'neg-fret-strict', strictness: 'strict',
      trials: spaced([
        neg(0, chord('C'), swap('C', 2, 1), 'fret', { strumMs: 15 }), neg(0, chord('C'), swap('C', 4, 1), 'fret', { strumMs: 15 }),
        neg(0, chord('G'), swap('G', 5, 1), 'fret', { strumMs: 15 }), neg(0, chord('G'), swap('G', 1, -1), 'fret', { strumMs: 15 }),
        neg(0, chord('D'), swap('D', 1, 1), 'fret', { strumMs: 10 }), neg(0, chord('Am'), swap('Am', 2, 1), 'fret', { strumMs: 10 }),
        neg(0, chord('E'), swap('E', 3, 1), 'fret', { strumMs: 20 }), neg(0, chord('A'), swap('A', 2, -1), 'fret', { strumMs: 15 }),
      ], 1.0),
    });
  }
  {
    // Octave errors, down and up, on another string as a player would.
    const pairs = [
      [[3, 2], [5, 0]], [[3, 2], [1, 5]], [[4, 2], [6, 0]], [[4, 2], [1, 0]], [[3, 0], [6, 3]], [[3, 0], [1, 3]],
      [[2, 1], [5, 3]], [[2, 1], [1, 8]], [[2, 3], [4, 0]], [[2, 3], [1, 10]], [[2, 0], [5, 2]], [[2, 0], [1, 7]],
      [[1, 0], [4, 2]], [[1, 0], [1, 12]], [[5, 0], [3, 2]], [[6, 0], [4, 2]], [[6, 3], [3, 0]], [[4, 0], [2, 3]],
      [[5, 3], [2, 1]], [[4, 3], [6, 1]], [[4, 3], [1, 1]], [[1, 5], [3, 2]],
    ];
    const trials = pairs.map(([[s, f], [s2, f2]]) => neg(0, [N(s, f)], [N(s2, f2)], 'octave'));
    trials.push(neg(0, chord('E5'), [N(4, 2), N(3, 4)], 'octave', { strumMs: 10 }));
    trials.push(neg(0, [N(4, 2), N(3, 4)], chord('E5'), 'octave', { strumMs: 10 }));
    trials.push(neg(0, chord('A5'), [N(3, 2), N(2, 5)], 'octave', { strumMs: 10 }));
    trials.push(neg(0, [N(3, 2), N(2, 5)], chord('A5'), 'octave', { strumMs: 10 }));
    add({ name: 'neg-octave', trials: spaced(trials, 0.65) });
  }
  {
    // Strict: a string left out. Only omissions a microphone can tell apart
    // (the missing note has partials of its own) count toward the target; the
    // rest are reported separately.
    const drop = (c, s) => chord(c).filter((n) => n.string !== s);
    const decidable = [['C', 5], ['C', 4], ['C', 3], ['G', 6], ['G', 5], ['G', 4], ['E', 6], ['E', 3], ['E', 5], ['D', 1], ['D', 3], ['Am', 2], ['A', 2], ['Em', 3]];
    const ambiguous = [['C', 2], ['C', 1], ['G', 1], ['E', 1], ['D', 2]];
    add({
      name: 'neg-missing-strict', strictness: 'strict',
      trials: spaced([
        ...decidable.map(([c, s]) => neg(0, chord(c), drop(c, s), 'missing', { strumMs: 15 })),
        ...ambiguous.map(([c, s]) => neg(0, chord(c), drop(c, s), 'missing-octave', { strumMs: 15 })),
      ], 1.0),
    });
  }
  {
    // Last chord still ringing; the next event wants it (or part of it) again
    // and the player has not struck anything.
    const pairs = [['E', 'E'], ['G', 'G'], ['C', 'C'], ['Am', 'Am'], ['D', 'D'], ['E5', 'E5'], ['C', 'Am'], ['G', 'Em'], ['Em', 'E5']];
    const trials = [];
    let t = 0.6;
    for (const [a, b] of pairs) {
      trials.push(pos(t, chord(a), { strumMs: 15 }));
      trials.push(neg(t + 0.9, chord(b), null, 'ring'));
      t += 1.9;
    }
    for (const n of [N(3, 2), N(6, 0), N(1, 3)]) {
      trials.push(pos(t, [n]));
      trials.push(neg(t + 0.7, [n], null, 'ring'));
      t += 1.6;
    }
    // …or another string is plucked while it rings: that pluck is not its attack
    // (ordered so the wrong pluck is never the next pair's note: playing the
    // next event is a different story, and lenient mode listens ahead for it)
    const others = [[N(4, 0), N(3, 0)], [N(2, 0), N(1, 0)], [N(5, 0), N(4, 2)], [N(3, 0), N(2, 0)], [N(6, 0), N(5, 2)], [N(5, 3), N(3, 0)], [N(6, 0), N(4, 2)]];
    for (const [a, b] of others) {
      trials.push(pos(t, [a]));
      trials.push(neg(t + 0.8, [a], [b], 'ring'));
      t += 1.5;
    }
    add({ name: 'neg-ringing', trials });
  }
  {
    const targets = [[N(6, 0)], [N(3, 2)], chord('C'), chord('G'), [N(1, 0)], chord('E5'), chord('D'), [N(2, 0)], [N(5, 3)], chord('Am')];
    add({ name: 'neg-noise', calib: 1.5, noiseOnly: 0.01, trials: spaced(targets.map((x) => neg(0, x, null, 'noise')), 0.8, 2.0) });
    add({ name: 'neg-noise-loud-uncal', noiseOnly: 0.03, trials: spaced(targets.map((x) => neg(0, x, null, 'noise')), 0.8, 1.0) });
    add({ name: 'neg-speech', calib: 1.5, noiseOnly: 0.005, speech: 'unvoiced', trials: spaced(targets.map((x) => neg(0, x, null, 'noise')), 0.8, 2.0) });
    add({ name: 'info-voice', calib: 1.5, noiseOnly: 0.005, speech: 'voiced', trials: spaced(targets.map((x) => neg(0, x, null, 'voice')), 0.8, 2.0) });
  }
  return out.filter((sc) => !only || sc.name.includes(only));
}

// ------------------------------------------------------------ audio

// Speech-like bursts: syllables 80–300 ms with gaps, either speech-shaped
// noise (unvoiced) or a gliding glottal pulse train through three formants
// (voiced; its pitch can wander across a guitar note).
function speech(n, rnd, kind, rms) {
  const out = new Float64Array(n);
  let i = Math.round(SR * 0.2);
  let phase = 0;
  while (i < n) {
    const len = Math.round(SR * (0.08 + 0.22 * rnd()));
    const f0a = 95 + 130 * rnd();
    const f0b = f0a * (0.8 + 0.4 * rnd());
    const amp = 0.5 + rnd();
    for (let k = 0; k < len && i + k < n; k++) {
      const u = k / len;
      const env = Math.sin(Math.PI * u) ** 0.6 * amp;
      let v;
      if (kind === 'voiced') {
        phase += (f0a + (f0b - f0a) * u) / SR;
        v = 2 * (phase - Math.floor(phase)) - 1; // sawtooth: all harmonics
      } else v = rnd() * 2 - 1;
      out[i + k] = v * env;
    }
    i += len + Math.round(SR * (0.05 + 0.25 * rnd()));
  }
  // formant-ish shaping
  const f32 = Float32Array.from(out);
  const a = biquad(Float32Array.from(f32), SR, 'lp', 700, 4);
  const b = biquad(Float32Array.from(f32), SR, 'lp', 1500, 5);
  const c = biquad(Float32Array.from(f32), SR, 'lp', 2600, 5);
  const y = new Float32Array(n);
  for (let k = 0; k < n; k++) y[k] = a[k] + 0.5 * b[k] + 0.25 * c[k];
  biquad(y, SR, 'hp', 120);
  let p = 0;
  let cnt = 0;
  for (let k = 0; k < n; k++) if (y[k] !== 0) { p += y[k] * y[k]; cnt++; }
  const g = rms / Math.sqrt(p / Math.max(1, cnt) || 1);
  for (let k = 0; k < n; k++) y[k] *= g;
  return y;
}

function render(sc, cond, seed) {
  const lead = sc.calib ? Math.max(0, sc.calib) : 0;
  const last = sc.trials.reduce((m, tr) => Math.max(m, tr.t + (tr.arpStep ? tr.arpStep * tr.expect.length : 0)), 0);
  const duration = lead + last + sc.tail;
  const events = (sc.stray || []).map((x) => ({ t: lead + x.t, notes: x.notes.map((n) => ({ midi: n.midi, string: n.string, tech: n.tech })) }));
  for (const tr of sc.trials) {
    if (!tr.play) continue;
    const notes = tr.play.map((n) => ({ midi: n.midi, string: n.string, tech: n.tech, bend: n.bend }));
    if (tr.arpStep) notes.forEach((n, k) => events.push({ t: lead + tr.t + k * tr.arpStep, notes: [n] }));
    else events.push({ t: lead + tr.t, notes, strumMs: tr.strumMs, dir: tr.dir });
  }
  let pcm;
  if (sc.noiseOnly) {
    const rnd = mulberry32(seed);
    pcm = roomNoise(Math.ceil(duration * SR), SR, rnd, sc.noiseOnly);
    if (sc.speech) {
      const sp = speech(pcm.length, rnd, sc.speech, 0.05);
      const start = Math.round((lead + 0.3) * SR);
      for (let i = start; i < pcm.length; i++) pcm[i] += sp[i];
    }
  } else {
    pcm = synth({ sampleRate: SR, duration, events, detuneCents: sc.detune || 0, noiseDb: cond.noiseDb ?? null, laptopMic: Boolean(cond.laptop), seed });
  }
  return { pcm, lead };
}

// ------------------------------------------------------------ running

// Per-hop cost: CPU time of this process (what the hop costs, whatever else
// the machine is doing), and wall-clock time for reference.
const hopTimes = [];
const wallTimes = [];

function run(sc, cond, seed) {
  const { pcm, lead } = render(sc, cond, seed);
  if (wavDir) writeWav(path.join(wavDir, `${sc.name}${cond.tag ? `-${cond.tag}` : ''}.wav`), pcm, SR);
  const eng = createEngine({ sampleRate: SR, params: engineParams });
  eng.setMode('wait');
  eng.setStrictness(sc.strictness);
  if (sc.offset) eng.setOffsetCents(sc.offset);
  const trials = sc.trials.map((tr) => ({
    ...tr,
    tt: lead + tr.t,
    accepted: null,
    armedAt: null,
    wrongs: [],
  }));
  eng.setTargets(trials.map((tr, i) => ({
    id: `e${i}`,
    notes: tr.expect.map((n) => ({ midi: n.midi, string: n.string, required: true, tech: n.tech || [], bendTo: n.bendTo })),
  })));
  if (sc.calib) eng.calibrateNoise(sc.calib);
  let cur = -1;
  const armNext = (at) => {
    cur++;
    if (cur < trials.length) { trials[cur].armedAt = at; eng.arm(cur); }
  };
  // arm the first event once calibration is over
  let started = false;
  const hop = eng.hop;
  for (let i = 0; i < pcm.length; i += hop) {
    const t = i / SR;
    if (!started && t >= lead) { started = true; armNext(t); }
    // the player moves on: give up on the armed event just before the next
    if (started && cur < trials.length - 1 && t >= trials[cur + 1].tt - 0.05) armNext(t);
    const chunk = pcm.subarray(i, i + hop);
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    const msgs = eng.push(chunk);
    wallTimes.push(performance.now() - t0);
    const c1 = process.cpuUsage(c0);
    hopTimes.push((c1.user + c1.system) / 1000);
    if (debugAt && debugAt.sc === sc.name && debugAt.cond === cond.name && Math.abs(t - debugAt.t) < 0.35) {
      const st = eng.state();
      const f = (x, d = 2) => (x == null ? '-' : Number(x).toFixed(d));
      console.log(`${t.toFixed(3)} #${st.index}${st.done ? ' done' : ''} ${st.candidates.filter((c) => c.role !== 'near' || c.c > 0.05).map((c) => `${c.midi}${c.role[0]} c${f(c.c)} s${f(c.share)} d${f(c.dres, 3)} sup${f(c.support)}/${f(c.unique)} n${f(Math.min(c.snr, 999), 0)} t${f(Math.min(c.tonal, 99), 1)} o${f(c.octave)} ${c.present ? 'P' : '-'}${c.held ? 'H' : '-'}`).join(' | ')}`);
      for (const m of msgs) if (m.type !== 'level') console.log('   ', JSON.stringify(m));
      if (engineParams.debug) for (const c of st.candidates) if (c.role === 'exp') console.log(`      ${c.midi}: ${JSON.stringify(c.partials)}`);
      if (engineParams.debug && st.peaks) console.log(`      peaks: ${JSON.stringify(st.peaks.filter((p) => p[0] < 1300))}`);
      if (engineParams.debug && st.rows) console.log(`      rows: ${JSON.stringify(st.rows.filter((r) => r.lo < 1300))}`);
    }
    for (const m of msgs) {
      if (m.type === 'accept' && m.index >= cur && m.index < trials.length) {
        // an accept of the event after the armed one (lenient look-ahead)
        // skips the armed one, as the UI does
        for (let k = cur; k < m.index; k++) trials[k].skippedBy = m.index;
        cur = m.index;
        trials[cur].accepted = m;
        armNext(m.t);
      } else if (m.type === 'wrong' && trials[m.index]) trials[m.index].wrongs.push(m);
    }
  }
  return trials;
}

// ------------------------------------------------------------ scoring

const results = [];
const conds = {
  clean: { tag: '' },
  noisy10: { tag: '10dB', noiseDb: 10, calib: 1.5 },
  noisy20: { tag: '20dB', noiseDb: 20, calib: 1.5 },
  laptop: { tag: 'laptop', laptop: true },
  laptop20: { tag: 'laptop20dB', laptop: true, noiseDb: 20, calib: 1.5 },
};
const tStart = performance.now();
for (const sc0 of scenarios()) {
  const extra = { 'single-low': ['noisy20', 'laptop'], progression: ['laptop', 'laptop20'] }[sc0.name] || [];
  const plan = sc0.pos && !sc0.info ? ['clean', 'noisy10', ...extra] : ['clean'];
  if (['neg-fret-single', 'neg-octave'].includes(sc0.name)) plan.push('noisy10');
  for (const c of plan) {
    const cond = { ...conds[c], name: c };
    const sc = { ...sc0, calib: sc0.calib || cond.calib || 0 };
    // seed from the scenario and condition, so --only reproduces a full run
    const seed = [...`${sc.name}/${c}`].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
    const w0 = performance.now();
    const trials = run(sc, cond, seed);
    if (argv.includes('--timing')) console.log(`${sc.name}/${c}: ${(performance.now() - w0).toFixed(0)} ms`);
    for (const tr of trials) results.push({ sc: sc.name, cond: c, info: sc.info, ...tr });
  }
}
const elapsed = (performance.now() - tStart) / 1000;

function judge(tr) {
  const a = tr.accepted;
  if (tr.kind === 'neg') return { ok: !a, fa: Boolean(a) };
  if (!a) return { ok: false, why: tr.skippedBy != null ? `skipped (accepted #${tr.skippedBy} instead)` : 'missed' };
  const start = tr.tt - 0.02;
  if (a.t < start) return { ok: false, why: `premature (${(a.t - tr.tt).toFixed(3)}s)` };
  const last = tr.tt + (tr.arpStep ? tr.arpStep * (tr.expect.length - 1) : 0);
  if (a.t > last + 1.0) return { ok: false, why: 'late' };
  const from = tr.latencyFrom != null ? tr.latencyFrom + (tr.tt - tr.t) : tr.tt;
  return { ok: true, latency: (a.t - from) * 1000 };
}
for (const r of results) Object.assign(r, judge(r));

const pct = (arr, q) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};
const rate = (rs, f) => (rs.length ? rs.filter(f).length / rs.length : NaN);
const posIn = (conds) => results.filter((r) => r.kind === 'pos' && !r.info && conds.includes(r.cond));
const negOf = (cls, conds = ['clean']) => results.filter((r) => r.kind === 'neg' && r.cls === cls && conds.includes(r.cond));

const rows = [];
let failed = 0;
const row = (label, n, value, target, pass, fmt = (v) => v.toFixed(3)) => {
  const ok = pass == null ? null : pass(value);
  if (ok === false) failed++;
  rows.push([label, String(n), Number.isFinite(value) ? fmt(value) : '—', target, ok == null ? 'info' : ok ? 'PASS' : 'FAIL']);
};
const ge = (x) => (v) => v >= x;
const le = (x) => (v) => v <= x;

const clean = posIn(['clean']);
const n10 = posIn(['noisy10']);
row('event recall, clean', clean.length, rate(clean, (r) => r.ok), '≥ 0.97', ge(0.97));
row('event recall, 10 dB SNR', n10.length, rate(n10, (r) => r.ok), '≥ 0.92', ge(0.92));
for (const c of ['noisy20', 'laptop', 'laptop20']) {
  const rs = posIn([c]);
  if (rs.length) row(`event recall, ${conds[c].tag}`, rs.length, rate(rs, (r) => r.ok), '', null);
}
for (const mode of ['strict', 'bass']) {
  const rs = results.filter((r) => r.kind === 'pos' && r.info === mode && r.cond === 'clean');
  if (rs.length) row(`event recall, ${mode} mode (clean)`, rs.length, rate(rs, (r) => r.ok), '', null);
}
const faRow = (label, cls, target, conds = ['clean']) => {
  const rs = negOf(cls, conds);
  if (rs.length) row(label, rs.length, rate(rs, (r) => r.fa), target == null ? '' : `≤ ${target}`, target == null ? null : le(target));
};
faRow('false accept, ±1 fret', 'fret', 0.02);
faRow('false accept, octave', 'octave', 0.05);
faRow('false accept, missing string (strict)', 'missing', 0.03);
faRow('false accept, missing octave-doubled string', 'missing-octave', null);
faRow('false accept, ringing, no re-strike', 'ring', 0.02);
faRow('false accept, noise / speech-shaped bursts', 'noise', 0);
faRow('false accept, ±1 fret at 10 dB', 'fret', null, ['noisy10']);
faRow('false accept, octave at 10 dB', 'octave', null, ['noisy10']);
faRow('false accept, voiced babble', 'voice', null);
const wrongNamed = results.filter((r) => r.kind === 'neg' && (r.cls === 'fret' || r.cls === 'octave') && r.cond === 'clean' && r.play && r.play.length === 1);
row('wrong note named (single-note mistakes)', wrongNamed.length, rate(wrongNamed, (r) => r.wrongs.some((w) => w.heard[0] === r.play[0].midi)), '', null);
const big = clean.filter((r) => r.expect.length >= 5 && r.strumMs > 0 && !r.arpStep && !r.tags.includes('x'));
row('strummed 5–6 note chords accepted ≤ 250 ms', big.length, rate(big, (r) => r.ok && r.latency <= 250), '≥ 0.95', ge(0.95));
const lat = clean.filter((r) => r.ok && r.latency != null).map((r) => r.latency);
row('latency median (ms)', lat.length, pct(lat, 0.5), '≤ 120', le(120), (v) => v.toFixed(0));
row('latency p95 (ms)', lat.length, pct(lat, 0.95), '≤ 250', le(250), (v) => v.toFixed(0));
for (const tech of ['h', 'p', 'slide', 'bend', 'harm', 'x', 'arpeggio', 'restrike', 'repeat']) {
  const rs = posIn(['clean', 'noisy10']).filter((r) => r.tags.includes(tech));
  const gate = ['h', 'p', 'slide', 'bend', 'harm', 'x'].includes(tech);
  if (rs.length) row(`technique recall: ${tech}`, rs.length, rate(rs, (r) => r.ok), gate ? '≥ 0.9' : '', gate ? ge(0.9) : null);
}
row('hop cost p95, CPU time (ms, 48 kHz)', hopTimes.length, pct(hopTimes, 0.95), '< 1.5', (v) => v < 1.5, (v) => v.toFixed(3));
row('hop cost mean, CPU time (ms)', hopTimes.length, hopTimes.reduce((a, b) => a + b, 0) / hopTimes.length, '', null, (v) => v.toFixed(3));
row('hop cost p95, wall clock (ms)', wallTimes.length, pct(wallTimes, 0.95), '', null, (v) => v.toFixed(3));

const widths = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length), ['metric', 'n', 'value', 'target', ''][i].length));
const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
console.log(line(['metric', 'n', 'value', 'target', '']));
for (const r of rows) console.log(line(r));
console.log(`\n${results.length} trials in ${elapsed.toFixed(1)} s`);

if (verbose) {
  const slow = results.filter((r) => r.kind === 'pos' && r.ok && r.latency > 200);
  if (slow.length) console.log('\nslow accepts (> 200 ms):');
  for (const r of slow) console.log(`  ${r.sc}/${r.cond} @${r.tt.toFixed(2)}s expect ${name(r.expect)} [${r.tags.join(' ')}] ${r.latency.toFixed(0)} ms`);
}
if (verbose || failed) {
  const bad = results.filter((r) => !r.ok && (verbose || r.kind === 'pos' || !String(r.cls).startsWith('info')));
  const show = verbose ? bad : bad.slice(0, 40);
  if (show.length) console.log('\nfailed trials:');
  for (const r of show) {
    const what = r.kind === 'pos' ? `expect ${name(r.expect)} [${r.tags.join(' ')}] ${r.why}` : `${r.cls}: expect ${name(r.expect)} played ${name(r.play) || '—'} → accepted at +${(r.accepted.t - r.tt).toFixed(2)}s heard ${r.accepted.heard}`;
    console.log(`  ${r.sc}/${r.cond} @${r.tt.toFixed(2)}s ${what}`);
  }
  if (!verbose && bad.length > show.length) console.log(`  … ${bad.length - show.length} more (--verbose)`);
}
process.exit(failed ? 1 : 0);
