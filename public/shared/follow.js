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
// rhythm, so this is only an even spread across where the notes are — the
// scoring windows allow for it — until the video's audio supplies real times.
export function playTimes(events, dur) {
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
  return events.map((e) => {
    const k = order.indexOf(e.system);
    const before = widths.slice(0, k).reduce((a, b) => a + b, 0);
    const s = bySys.get(e.system);
    return ((before + (e.x0 - s.x0)) / total) * dur;
  });
}

// ---------------------------------------------------------------- self-check

export function selfCheck(assert) {
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
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
  console.log('follow.js self-check passed');
}
