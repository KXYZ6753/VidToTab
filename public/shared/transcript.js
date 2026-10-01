// Corrections to a page's reading: the compact form they are stored in, and
// the edits the fix-by-click editor makes.
//
// A reading (tabread.js) is systems → events → notes with boxes and
// confidences. Only pages someone corrected are stored (library.js
// cleanTranscript bounds the stored form); everything else is read again.
// Every edit returns a new reading and leaves the old one untouched, which is
// all undo needs: keep the old one.

// Techniques in the stored note, one character each (bends carry their
// target fret): h p s / \ ~ x, g grace, ( ghost, < harmonic, b9 bend, r7 release.
const SINGLE = { h: 'h', p: 'p', s: 's', '/': '/', '\\': '\\', '~': '~', x: 'x', grace: 'g', ghost: '(', harm: '<' };
const BACK = Object.fromEntries(Object.entries(SINGLE).map(([k, v]) => [v, k]));

export const FLAG = { SET: 1, CONFIRMED: 2, WAS_UNSURE: 4 };
const UNSURE = 0.5;

export function encodeTech(tech = [], bendTo = null) {
  let out = '';
  for (const t of tech) {
    if (t === 'b' || t === 'r') out += t + (Number.isInteger(bendTo) ? bendTo : '');
    else if (SINGLE[t]) out += SINGLE[t];
  }
  return out;
}

export function decodeTech(str = '') {
  const tech = [];
  let bendTo = null;
  const re = /([br])(\d{1,2})?|./g;
  let m;
  while ((m = re.exec(str))) {
    if (m[1]) { tech.push(m[1]); if (m[2]) bendTo = Number(m[2]); }
    else if (BACK[m[0]]) tech.push(BACK[m[0]]);
  }
  return { tech, bendTo };
}

const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

// Reading → the stored page.
export function toStored(reading, { model = '', at = Date.now() } = {}) {
  return {
    at,
    model,
    w: reading.w,
    h: reading.h,
    systems: reading.systems.map((sys) => ({
      lines: sys.lines.map(r1),
      events: sys.events.map((ev) => ({
        x: r1(ev.xc),
        n: ev.notes.map((n) => [n.string, n.fret, encodeTech(n.tech, n.bendTo), r1(n.box.x), r1(n.box.y), r1(n.box.w), r1(n.box.h), n.flags || 0]),
      })),
    })),
  };
}

// Stored page → a reading the listener and the editor can use. Corrected
// notes are certain; notes nobody touched keep "unsure" if they were.
export function fromStored(page) {
  return {
    found: true,
    flags: ['corrected'],
    w: page.w,
    h: page.h,
    systems: page.systems.map((sys) => {
      const events = sys.events.map((ev) => {
        const notes = ev.n.map(([string, fret, t, x, y, w, h, flags]) => {
          const { tech, bendTo } = decodeTech(t);
          const note = { string, fret, tech, conf: flags & (FLAG.SET | FLAG.CONFIRMED) ? 1 : (flags & FLAG.WAS_UNSURE ? 0.4 : 0.9), box: { x, y, w, h }, flags };
          if (bendTo !== null) note.bendTo = bendTo;
          return note;
        });
        return withSpan({ notes });
      });
      const s = sys.lines.length > 1 ? (sys.lines[sys.lines.length - 1] - sys.lines[0]) / (sys.lines.length - 1) : 0;
      return { lines: sys.lines, spacing: s, x0: 0, x1: page.w, barlines: [], events };
    }),
  };
}

// An event's extent and centre follow its notes.
function withSpan(ev) {
  const x0 = Math.min(...ev.notes.map((n) => n.box.x));
  const x1 = Math.max(...ev.notes.map((n) => n.box.x + n.box.w));
  ev.notes.sort((a, b) => a.string - b.string);
  return { ...ev, x0, x1, xc: (x0 + x1) / 2, conf: Math.min(...ev.notes.map((n) => n.conf)) };
}

const clone = (reading) => ({ ...reading, systems: reading.systems.map((s) => ({ ...s, events: s.events.map((e) => ({ ...e, notes: e.notes.map((n) => ({ ...n, tech: [...(n.tech || [])], box: { ...n.box } })) })) })) });

// Where a note is: system, event, note index.
export function find(reading, fn) {
  const out = [];
  reading.systems.forEach((sys, s) => sys.events.forEach((ev, e) => ev.notes.forEach((n, i) => { if (fn(n, ev, sys)) out.push({ s, e, n: i }); })));
  return out;
}

export const unsureNotes = (reading) => find(reading, (n) => (n.conf ?? 1) < UNSURE && !(n.flags & (FLAG.SET | FLAG.CONFIRMED)));

// Change a note: fret, string, techniques, bend target. Marked as set by hand.
export function setNote(reading, at, patch) {
  const r = clone(reading);
  const ev = r.systems[at.s].events[at.e];
  const n = ev.notes[at.n];
  const wasUnsure = (n.conf ?? 1) < UNSURE;
  if (patch.string !== undefined && patch.string !== n.string) {
    if (ev.notes.some((m, i) => i !== at.n && m.string === patch.string)) throw new Error('That string already has a note here.');
    const lines = r.systems[at.s].lines;
    const dy = (lines[patch.string - 1] ?? 0) - (lines[n.string - 1] ?? 0);
    n.box.y += dy;
    n.string = patch.string;
  }
  if (patch.fret !== undefined) {
    if (patch.fret !== null && !(Number.isInteger(patch.fret) && patch.fret >= 0 && patch.fret <= 24)) throw new Error('Fret must be 0 to 24.');
    n.fret = patch.fret;
    if (patch.fret === null && !n.tech.includes('x')) n.tech.push('x');
    if (patch.fret !== null) n.tech = n.tech.filter((t) => t !== 'x');
  }
  if (patch.tech !== undefined) n.tech = [...patch.tech];
  if (patch.bendTo !== undefined) n.bendTo = patch.bendTo;
  n.conf = 1;
  n.flags = (n.flags || 0) | FLAG.SET | (wasUnsure ? FLAG.WAS_UNSURE : 0);
  r.systems[at.s].events[at.e] = withSpan(ev);
  return r;
}

// "Looks right": certain from now on, without changing anything.
export function confirmNote(reading, at) {
  const r = clone(reading);
  const n = r.systems[at.s].events[at.e].notes[at.n];
  n.flags = (n.flags || 0) | FLAG.CONFIRMED | ((n.conf ?? 1) < UNSURE ? FLAG.WAS_UNSURE : 0);
  n.conf = 1;
  r.systems[at.s].events[at.e] = withSpan(r.systems[at.s].events[at.e]);
  return r;
}

export function deleteNote(reading, at) {
  const r = clone(reading);
  const evs = r.systems[at.s].events;
  evs[at.e].notes.splice(at.n, 1);
  if (!evs[at.e].notes.length) evs.splice(at.e, 1);
  else evs[at.e] = withSpan(evs[at.e]);
  return r;
}

// A note the reader missed, placed on a string at x. It joins the chord at
// that place if there is one (and that string is free), otherwise it is an
// event of its own, in order.
export function addNote(reading, s, { string, fret, x, box }) {
  const r = clone(reading);
  const sys = r.systems[s];
  const sp = sys.spacing || 20;
  const nb = box || { x: x - sp * 0.2, y: sys.lines[string - 1] - sp * 0.35, w: sp * 0.4, h: sp * 0.7 };
  const note = { string, fret, tech: fret === null ? ['x'] : [], conf: 1, box: nb, flags: FLAG.SET };
  const cx = nb.x + nb.w / 2;
  const join = sys.events.findIndex((ev) => Math.abs(ev.xc - cx) <= 0.4 * sp && !ev.notes.some((n) => n.string === string));
  if (join >= 0) {
    sys.events[join].notes.push(note);
    sys.events[join] = withSpan(sys.events[join]);
  } else {
    sys.events.push(withSpan({ notes: [note] }));
    sys.events.sort((a, b) => a.xc - b.xc);
  }
  return r;
}

// Take a note out of its chord into an event of its own, just after it.
export function separate(reading, at) {
  const r = clone(reading);
  const evs = r.systems[at.s].events;
  const ev = evs[at.e];
  if (ev.notes.length < 2) return r;
  const [note] = ev.notes.splice(at.n, 1);
  note.flags = (note.flags || 0) | FLAG.SET;
  evs[at.e] = withSpan(ev);
  evs.splice(at.e + 1, 0, withSpan({ notes: [note] }));
  return r;
}

// Put a note into the chord before it (if that string is free there).
export function joinPrevious(reading, at) {
  const r = clone(reading);
  const evs = r.systems[at.s].events;
  if (at.e === 0) return r;
  const prev = evs[at.e - 1];
  const note = evs[at.e].notes[at.n];
  if (prev.notes.some((n) => n.string === note.string)) throw new Error('That chord already has a note on this string.');
  evs[at.e].notes.splice(at.n, 1);
  note.flags = (note.flags || 0) | FLAG.SET;
  prev.notes.push(note);
  evs[at.e - 1] = withSpan(prev);
  if (!evs[at.e].notes.length) evs.splice(at.e, 1);
  else evs[at.e] = withSpan(evs[at.e]);
  return r;
}

// Whether a page carries anything the reader would not reproduce.
export const edited = (reading) => find(reading, (n) => n.flags & (FLAG.SET | FLAG.CONFIRMED)).length > 0;

// ---------------------------------------------------------------- self-check

export function selfCheck(assert) {
  assert.equal(encodeTech(['h', 'grace', 'b'], 9), 'hgb9');
  assert.deepEqual(decodeTech('hgb9'), { tech: ['h', 'grace', 'b'], bendTo: 9 });
  assert.deepEqual(decodeTech('x(<'), { tech: ['x', 'ghost', 'harm'], bendTo: null });

  const note = (string, fret, x, conf = 0.9, tech = []) => ({ string, fret, tech, conf, box: { x, y: string * 20, w: 8, h: 14 } });
  const base = {
    found: true, flags: [], w: 600, h: 200,
    systems: [{ lines: [20, 40, 60, 80, 100, 120], spacing: 20, x0: 0, x1: 600, barlines: [], events: [
      withSpan({ notes: [note(1, 0, 50), note(2, 1, 50), note(3, 0, 51)] }),
      withSpan({ notes: [note(4, 7, 150, 0.3)] }),
    ] }],
  };
  assert.equal(unsureNotes(base).length, 1);

  let r = setNote(base, { s: 0, e: 1, n: 0 }, { fret: 2 });
  assert.equal(r.systems[0].events[1].notes[0].fret, 2);
  assert.equal(r.systems[0].events[1].notes[0].flags, FLAG.SET | FLAG.WAS_UNSURE);
  assert.equal(base.systems[0].events[1].notes[0].fret, 7, 'edits never change the reading they were given');
  assert.equal(unsureNotes(r).length, 0);
  assert.throws(() => setNote(base, { s: 0, e: 0, n: 0 }, { string: 2 }), /already/);
  assert.throws(() => setNote(base, { s: 0, e: 0, n: 0 }, { fret: 25 }), /0 to 24/);

  r = addNote(base, 0, { string: 5, fret: 3, x: 54 });
  assert.deepEqual(r.systems[0].events[0].notes.map((n) => n.string), [1, 2, 3, 5], 'a note placed at a chord joins it');
  r = addNote(base, 0, { string: 6, fret: 0, x: 100 });
  assert.deepEqual(r.systems[0].events.map((e) => e.notes.length), [3, 1, 1], 'elsewhere it is an event of its own, in order');
  assert.equal(r.systems[0].events[1].notes[0].string, 6);

  r = separate(base, { s: 0, e: 0, n: 2 });
  assert.deepEqual(r.systems[0].events.map((e) => e.notes.length), [2, 1, 1]);
  r = joinPrevious(r, { s: 0, e: 1, n: 0 });
  assert.deepEqual(r.systems[0].events.map((e) => e.notes.length), [3, 1]);

  r = deleteNote(base, { s: 0, e: 1, n: 0 });
  assert.equal(r.systems[0].events.length, 1, 'an event with no notes left goes');

  // Stored and back: what was set stays set and certain.
  r = setNote(confirmNote(base, { s: 0, e: 0, n: 0 }), { s: 0, e: 1, n: 0 }, { fret: 5, tech: ['h'] });
  const stored = toStored(r, { model: 'm', at: 1 });
  const back = fromStored(stored);
  assert.equal(back.systems[0].events[1].notes[0].fret, 5);
  assert.deepEqual(back.systems[0].events[1].notes[0].tech, ['h']);
  assert.equal(back.systems[0].events[0].notes[0].conf, 1, 'confirmed stays certain');
  assert.equal(edited(back), true);
  assert.equal(edited(base), false);
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
  console.log('transcript.js self-check passed');
}
