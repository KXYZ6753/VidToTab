// From what the tab says to what the microphone should hear.
//
// The tab reader (tabread.js) gives each page's events — the notes played
// together, as string and fret. Follow-along needs pitches: which MIDI notes
// make up each step, which of them must be heard and which may be missed
// (a ghost note, a grace note, a digit the reader was unsure of), and which
// notes from earlier steps are probably still ringing and must not be taken
// for new ones. All of it is pure, so the browser, the worker and the Node
// tests share it.

// Open-string MIDI notes, string 1 (high e) to string 6 (low E).
export const TUNINGS = [
  { id: 'standard', label: 'Standard (E A D G B E)', notes: [64, 59, 55, 50, 45, 40] },
  { id: 'dropD', label: 'Drop D', notes: [64, 59, 55, 50, 45, 38] },
  { id: 'halfDown', label: 'Half step down', notes: [63, 58, 54, 49, 44, 39] },
  { id: 'wholeDown', label: 'Whole step down', notes: [62, 57, 53, 48, 43, 38] },
  { id: 'dadgad', label: 'DADGAD', notes: [62, 57, 55, 50, 45, 38] },
  { id: 'openG', label: 'Open G', notes: [62, 59, 55, 50, 43, 38] },
  { id: 'openD', label: 'Open D', notes: [62, 57, 54, 50, 45, 38] },
  { id: 'custom', label: 'Custom', notes: null },
];

export const STRICTNESS = ['lenient', 'strict', 'bass'];
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const noteName = (midi) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
export const tuningById = (id) => TUNINGS.find((t) => t.id === id) || TUNINGS[0];

// Per-songsheet follow-along settings, bounded and defaulted — the same
// rules library.js and library-fs.cjs store them by.
export function normaliseListen(input = {}) {
  const preset = tuningById(input.tuningId);
  const custom = Array.isArray(input.tuning) && input.tuning.length === 6
    && input.tuning.every((n) => Number.isInteger(n) && n >= 28 && n <= 76);
  return {
    tuningId: preset.id,
    tuning: preset.notes ? [...preset.notes] : (custom ? [...input.tuning] : [...TUNINGS[0].notes]),
    capo: Math.min(12, Math.max(0, Math.round(Number(input.capo) || 0))),
    strictness: STRICTNESS.includes(input.strictness) ? input.strictness : 'lenient',
    mode: input.mode === 'play' ? 'play' : 'wait',
  };
}

// The settings that make a video's pitch come out right: every string
// `shift` semitones from these settings, the low string `low` more (what the
// timing probe hears in the video). Up is a capo; down past the capo is the
// whole guitar tuned down. A preset is named when the strings match one.
export function settingsForShift(base, shift, low = 0) {
  const s = normaliseListen(base);
  let capo = s.capo + shift;
  let tuning = [...s.tuning];
  if (capo < 0) { tuning = tuning.map((m) => m + capo); capo = 0; }
  tuning[5] += low;
  const preset = TUNINGS.find((t) => t.notes && t.notes.every((m, i) => m === tuning[i]));
  return normaliseListen({ ...s, tuningId: preset ? preset.id : 'custom', tuning, capo });
}

// A natural harmonic sounds above the open string by the harmonic's interval:
// 12th fret an octave, 7th and 19th an octave and a fifth, 5th and 24th two
// octaves, 4th, 9th and 16th two octaves and a major third.
const HARMONIC = { 12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28 };

// The events of one read page as the listener wants them: every note with
// its pitch, and whether it has to be heard. Tab frets are counted from the
// capo, as tab is written for a capo.
export function buildEvents(reading, settings, { page = 0, minConf = 0.5 } = {}) {
  const { tuning, capo } = normaliseListen(settings);
  const out = [];
  if (!reading?.found) return out;
  reading.systems.forEach((sys, si) => {
    sys.events.forEach((ev, ei) => {
      const notes = [];
      for (const n of ev.notes) {
        if (!(n.string >= 1 && n.string <= 6)) continue;
        const open = tuning[n.string - 1] + capo;
        const tech = n.tech || [];
        if (n.fret === null || tech.includes('x')) {
          notes.push({ string: n.string, fret: null, midi: null, required: false, tech: ['x'], conf: n.conf });
          continue;
        }
        const harm = tech.includes('harm') && HARMONIC[n.fret] !== undefined;
        const midi = harm ? open + HARMONIC[n.fret] : open + n.fret;
        const optional = tech.includes('ghost') || tech.includes('grace') || (n.conf ?? 1) < minConf;
        const note = { string: n.string, fret: n.fret, midi, required: !optional, tech: [...tech], conf: n.conf ?? 1 };
        if (tech.includes('b') && Number.isFinite(n.bendTo)) note.bendTo = open + n.bendTo;
        // the reader's runner-up, for the recording to try (shared/timing.js)
        if (Number.isInteger(n.alt)) note.alt = n.alt;
        notes.push(note);
      }
      if (!notes.length) return;
      const pitched = notes.filter((n) => n.midi !== null);
      out.push({
        id: `${page}:${si}:${ei}`,
        page,
        system: si,
        index: ei,
        x0: ev.x0,
        x1: ev.x1,
        xc: ev.xc,
        // the staff's line spacing: how near a stored time's place must be
        spacing: sys.spacing || 0,
        notes,
        // Muted strokes and events the reader could not vouch for accept any
        // fresh attack: there is no pitch to insist on.
        pitchless: !pitched.some((n) => n.required),
        conf: ev.conf ?? 1,
      });
    });
  });
  return out;
}

// Notes likely still sounding when an event comes up: the latest note on each
// string from the few events before it, unless that string has been played
// again since or it is long past. The listener takes these as known
// distractors, so a sustained chord is not mistaken for a fresh one.
export function ringing(events, i, { back = 4 } = {}) {
  const last = new Map();
  for (let k = Math.max(0, i - back); k < i; k++) {
    for (const n of events[k].notes) if (n.midi !== null) last.set(n.string, n.midi);
  }
  const now = new Set(events[i]?.notes.map((n) => n.string) || []);
  return [...last.entries()].filter(([s]) => !now.has(s)).map(([, m]) => m);
}

// Play mode: when, within a page's time, each event comes. Tab spacing is not
// rhythm, so without more to go on this is an even spread across where the
// notes are — the scoring windows allow for it.
//
// timed: the times heard in the video's own recording at scan time
// ([system, x, t] per event, t seconds from when the page appeared; see
// shared/timing.js). They are matched by place, not by index, because a
// correction in the editor adds, removes and splits events: an event takes
// the nearest stored time on its system within 0.35 of a line spacing (8 px
// when the spacing is unknown), each stored time once. Times are clamped to
// the page; a stored time that runs backwards against the others is dropped
// (the longest run of them in order is kept). The events between two known
// ones are placed between them in proportion to the even spread, and the
// page's start and end bound the ones before the first and after the last.
export function playTimes(events, dur, timed = null) {
  if (!events.length) return [];
  const bySys = new Map();
  for (const e of events) {
    const s = bySys.get(e.system) || { x0: Infinity, x1: -Infinity };
    s.x0 = Math.min(s.x0, e.x0);
    s.x1 = Math.max(s.x1, e.x1);
    bySys.set(e.system, s);
  }
  const order = [...bySys.keys()].sort((a, b) => a - b);
  const widths = order.map((k) => Math.max(1, bySys.get(k).x1 - bySys.get(k).x0));
  const total = widths.reduce((a, b) => a + b, 0);
  const even = events.map((e) => {
    const k = order.indexOf(e.system);
    const before = widths.slice(0, k).reduce((a, b) => a + b, 0);
    const s = bySys.get(e.system);
    return ((before + (e.x0 - s.x0)) / total) * dur;
  });
  if (!Array.isArray(timed) || !timed.length) return even;

  const pairs = [];
  events.forEach((e, i) => {
    const x = Number.isFinite(e.xc) ? e.xc : (e.x0 + e.x1) / 2;
    const tol = e.spacing > 0 ? 0.35 * e.spacing : 8;
    timed.forEach((row, j) => {
      if (!Array.isArray(row) || row[0] !== e.system || !Number.isFinite(row[1]) || !Number.isFinite(row[2])) return;
      const d = Math.abs(x - row[1]);
      if (d <= tol) pairs.push({ i, j, d });
    });
  });
  pairs.sort((a, b) => a.d - b.d || a.i - b.i);
  const known = new Array(events.length).fill(null);
  const used = new Set();
  for (const { i, j } of pairs) {
    if (known[i] !== null || used.has(j)) continue;
    known[i] = Math.min(dur, Math.max(0, timed[j][2]));
    used.add(j);
  }
  // The longest run of known times that never goes backwards (O(n²) is
  // plenty for a page's events).
  const idx = known.map((t, i) => (t === null ? -1 : i)).filter((i) => i >= 0);
  const len = idx.map(() => 1);
  const from = idx.map(() => -1);
  let end = -1;
  for (let a = 0; a < idx.length; a++) {
    for (let b = 0; b < a; b++) {
      if (known[idx[b]] <= known[idx[a]] && len[b] + 1 > len[a]) { len[a] = len[b] + 1; from[a] = b; }
    }
    if (end < 0 || len[a] > len[end]) end = a;
  }
  const anchors = [];
  for (let a = end; a >= 0; a = from[a]) anchors.unshift(idx[a]);
  // Interpolated against the even spread between neighbouring anchors; the
  // page's own start and end (0 and dur) are anchors too.
  const pts = [{ p: 0, t: 0 }, ...anchors.map((i) => ({ p: even[i], t: known[i], i })), { p: dur, t: dur }];
  const out = new Array(events.length);
  for (const pt of pts) if (pt.i !== undefined) out[pt.i] = pt.t;
  let q = 0;
  for (let i = 0; i < events.length; i++) {
    if (out[i] !== undefined) continue;
    while (q + 1 < pts.length - 1 && pts[q + 1].i !== undefined && pts[q + 1].i < i) q++;
    const a = pts[q];
    const b = pts[q + 1];
    const span = b.p - a.p;
    const f = span > 1e-9 ? Math.min(1, Math.max(0, (even[i] - a.p) / span)) : 0;
    out[i] = a.t + f * (b.t - a.t);
  }
  // Even spread and anchors can still disagree by a hair at the seams.
  for (let i = 1; i < out.length; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];
  return out;
}

// ---------------------------------------------------------------- self-check

export function selfCheck(assert) {
  {
    const std = normaliseListen();
    const at = (sh, lo) => { const r = settingsForShift(std, sh, lo); return `${r.tuningId} ${r.tuning.join(',')} capo ${r.capo}`; };
    assert.equal(at(3, 0), 'standard 64,59,55,50,45,40 capo 3', 'up is a capo');
    assert.equal(at(5, 1), 'custom 64,59,55,50,45,41 capo 5', 'and a low string tuned up to F (yT9gKKwBeVw)');
    assert.equal(at(0, -2), 'dropD 64,59,55,50,45,38 capo 0', 'a dropped low string is Drop D');
    assert.equal(at(-1, 0), 'halfDown 63,58,54,49,44,39 capo 0', 'down is a tuning down');
    assert.equal(settingsForShift({ capo: 2 }, -1).capo, 1, 'down from a capo lowers the capo first');
  }
  assert.equal(noteName(40), 'E2');
  assert.equal(noteName(64), 'E4');
  assert.equal(noteName(61), 'C♯4');

  const d = normaliseListen({});
  assert.deepEqual(d, { tuningId: 'standard', tuning: [64, 59, 55, 50, 45, 40], capo: 0, strictness: 'lenient', mode: 'wait' });
  assert.equal(normaliseListen({ capo: 30 }).capo, 12);
  assert.deepEqual(normaliseListen({ tuningId: 'dropD' }).tuning, [64, 59, 55, 50, 45, 38]);
  assert.deepEqual(normaliseListen({ tuningId: 'custom', tuning: [62, 57, 55, 50, 45, 38] }).tuning, [62, 57, 55, 50, 45, 38]);
  assert.deepEqual(normaliseListen({ tuningId: 'custom', tuning: [1, 2] }).tuning, [64, 59, 55, 50, 45, 40], 'nonsense custom → standard');
  assert.equal(normaliseListen({ strictness: 'weird' }).strictness, 'lenient');

  const reading = { found: true, systems: [{ events: [
    { x0: 10, x1: 20, xc: 15, conf: 0.9, notes: [
      { string: 1, fret: 0, tech: [], conf: 0.9 }, { string: 2, fret: 1, tech: [], conf: 0.9 }, { string: 5, fret: 3, tech: [], conf: 0.9 },
    ] },
    { x0: 40, x1: 50, xc: 45, conf: 0.3, notes: [{ string: 3, fret: 7, tech: [], conf: 0.3 }] },
    { x0: 70, x1: 80, xc: 75, conf: 0.9, notes: [{ string: 6, fret: null, tech: ['x'], conf: 0.9 }] },
    { x0: 100, x1: 110, xc: 105, conf: 0.9, notes: [{ string: 1, fret: 12, tech: ['harm'], conf: 0.9 }, { string: 2, fret: 5, tech: ['ghost'], conf: 0.9 }] },
    { x0: 130, x1: 140, xc: 135, conf: 0.9, notes: [{ string: 3, fret: 7, tech: ['b'], bendTo: 9, conf: 0.9 }] },
  ] }] };
  let ev = buildEvents(reading, { capo: 2 });
  assert.deepEqual(ev[0].notes.map((n) => n.midi), [66, 62, 50], 'C chord shape with capo 2 sounds a D chord');
  assert.equal(ev[1].pitchless, true, 'an event the reader was unsure of accepts any attack');
  assert.equal(ev[1].notes[0].required, false);
  assert.equal(ev[2].pitchless, true, 'muted strokes have no pitch');
  assert.equal(ev[3].notes[0].midi, 64 + 2 + 12, '12th-fret harmonic is an octave over the open string');
  assert.equal(ev[3].notes[1].required, false, 'ghost notes are optional');
  assert.equal(ev[4].notes[0].bendTo, 55 + 2 + 9);
  assert.equal(buildEvents({ found: false }, {}).length, 0);

  // Ringing: the latest note per string from the events before, minus the
  // strings being played now.
  ev = buildEvents({ found: true, systems: [{ events: [
    { x0: 0, x1: 1, xc: 0, notes: [{ string: 6, fret: 0, tech: [], conf: 1 }, { string: 1, fret: 0, tech: [], conf: 1 }] },
    { x0: 2, x1: 3, xc: 2, notes: [{ string: 3, fret: 2, tech: [], conf: 1 }] },
    { x0: 4, x1: 5, xc: 4, notes: [{ string: 1, fret: 3, tech: [], conf: 1 }] },
  ] }] }, {});
  assert.deepEqual(ringing(ev, 2).sort(), [40, 57], 'low E and the G-string note ring on; string 1 is played again');

  // Play-mode times: spread across where the notes are.
  const t = playTimes([{ system: 0, x0: 0, x1: 10 }, { system: 0, x0: 90, x1: 100 }, { system: 1, x0: 0, x1: 10 }, { system: 1, x0: 90, x1: 100 }], 20);
  assert.deepEqual(t.map((x) => Math.round(x)), [0, 9, 10, 19]);

  // …and with the times heard in the video's recording. Five events on one
  // system, 20 px apart, spacing 10 (a stored place matches within 3.5 px).
  const row = (xs, spacing = 10) => xs.map((x) => ({ system: 0, x0: x - 3, x1: x + 3, xc: x, spacing }));
  const r2 = (ts) => ts.map((x) => Math.round(x * 100) / 100);
  const five = row([10, 30, 50, 70, 90]);
  assert.deepEqual(r2(playTimes(five, 10, [])), r2(playTimes(five, 10)), 'nothing stored: the even spread');
  // Stored for the 1st, 3rd and 5th: those exactly, the others halfway (the
  // even spread puts them halfway too).
  assert.deepEqual(r2(playTimes(five, 10, [[0, 11, 1], [0, 49, 2], [0, 91, 8]])), [1, 1.5, 2, 5, 8]);
  // Matched by place, not order: an event added in the editor between the
  // first two takes no stored time and goes between its neighbours.
  const six = row([10, 20, 30, 50, 70, 90]);
  const stored = [[0, 10, 1], [0, 30, 2], [0, 50, 3], [0, 70, 4], [0, 90, 5]];
  assert.deepEqual(r2(playTimes(six, 10, stored)), [1, 1.5, 2, 3, 4, 5]);
  // Another system's time, or one too far off, is no match (8 px with no spacing).
  assert.deepEqual(r2(playTimes(five, 10, [[1, 30, 6]])), r2(playTimes(five, 10)));
  assert.deepEqual(r2(playTimes(row([10, 30], 0), 10, [[0, 39, 6]])), r2(playTimes(row([10, 30], 0), 10)), '9 px away is not this event');
  assert.equal(playTimes(row([10, 30], 0), 10, [[0, 37, 6]])[1], 6, '7 px away is');
  // Clamped to the page: a note heard before the page appeared is due at once.
  assert.deepEqual(r2(playTimes(five, 10, [[0, 10, -1.2], [0, 90, 12]])), [0, 2.5, 5, 7.5, 10]);
  // One stored time that runs backwards against the rest is dropped; times
  // never go backwards.
  const back = playTimes(five, 10, [[0, 10, 1], [0, 30, 9], [0, 50, 3], [0, 70, 4], [0, 90, 5]]);
  assert.deepEqual(r2(back), [1, 2, 3, 4, 5]);
  for (let i = 1; i < back.length; i++) assert.ok(back[i] >= back[i - 1]);
  // Before the first known time the page's start bounds them; after the last, its end.
  // (the even spread has the last event at 9.3 s of 10, so after a known 3 s
  // at 4.65 the rest are placed in proportion between there and 10 s)
  assert.deepEqual(r2(playTimes(five, 10, [[0, 50, 3]])), [0, 1.5, 3, 6.04, 9.09]);
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
  console.log('follow.js self-check passed');
}
