// When each note of a page sounds in its video, heard from the video's own
// recording — and which of the reader's unsure digits that recording settles.
//
// A scanned page knows when it was on screen (tStart–tEnd), and for most tab
// videos the soundtrack is the tab being played. So once a scan is done, each
// page's stretch of audio is run through the listening engine (listen.js)
// offline: Wait mode, lenient, the page's events armed one after another,
// exactly as someone playing along is followed. Every event it accepts gets
// the time its attack began, and Play mode scores against those times instead
// of an even spread across the page (follow.js playTimes).
//
// The page on screen and the notes being played are not in step: notes often
// sound up to a second and a half before the page appears and run on after it
// goes. The window is therefore [tStart − 1.5 s, tEnd + 3 s], the one the
// real-audio benchmark (scripts/eval-listen.mjs) follows about 81 % of each
// page's events in. Times are stored relative to tStart, so they can be
// negative.
//
// Unsure digits: a note the reader could not vouch for (confidence under 0.5)
// is tried against the recording with a few frets — the one read, the
// classifier's runner-up (note.alt) and one either side. Each is listened for
// as the one required note, over a short stretch from just before the event's
// attack to the next event's. A different fret is adopted only when exactly
// one candidate is heard struck there and the fret read is not.
//
// Pure: the scan-time worker (public/timing-worker.js) and the Node evals
// (scripts/tabread-eval.mjs --audio) share it. The engine comes in as `make`
// (listen.js createEngine) rather than by import, so the page — which only
// needs applyFixes — does not load the listener to get it.

export const LEAD = 1.5;
export const TAIL = 3;
export const MAX_WINDOW = 90; // the most /api/audio serves at once
export const SAMPLE_RATE = 48000;
const UNSURE = 0.5;
const PREROLL = 1.5; // audio the engine hears before a candidate is armed
const AROUND = 0.15; // a candidate must be struck this near the event's attack

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// The stretch of video audio a page is timed in, in video seconds.
export function pageWindow(tStart, tEnd) {
  const from = Math.max(0, (Number(tStart) || 0) - LEAD);
  const to = Math.max(from, (Number(tEnd) || 0) + TAIL);
  return { from, to: Math.min(to, from + MAX_WINDOW) };
}

// An event as the engine takes it (what follow-ui.js sends the worker).
const targetOf = (e) => ({
  id: e.id,
  pitchless: e.pitchless,
  notes: e.notes.map((n) => ({ midi: n.midi, string: n.string, required: n.required, tech: n.tech, bendTo: n.bendTo })),
});

function engineFor(make, sampleRate, targets) {
  const eng = make({ sampleRate });
  eng.setMode('wait');
  eng.setStrictness('lenient');
  eng.setTargets(targets);
  return eng;
}

// Feeds pcm[a, b) a hop at a time (so the caller can arm right after an
// accept, as a live listener would); stops early when onMsg returns true.
function feed(eng, pcm, a, b, onMsg) {
  for (let off = a; off < b; off += eng.hop) {
    for (const m of eng.push(pcm.subarray(off, Math.min(b, off + eng.hop)))) if (onMsg(m)) return true;
  }
  return false;
}

// When each event's attack began, in seconds into pcm, or null where it was
// not heard. As scripts/eval-listen.mjs follow(): an accept may be for the
// event after the armed one (lenient listens one ahead) — it counts, the one
// passed over gets no time, and the event after it is armed.
export function followTimes(pcm, sampleRate, events, { make }) {
  const at = new Array(events.length).fill(null);
  if (!events.length || !pcm.length) return at;
  const eng = engineFor(make, sampleRate, events.map(targetOf));
  let current = 0;
  eng.arm(0);
  feed(eng, pcm, 0, pcm.length, (m) => {
    if (m.type !== 'accept' || m.index < current) return false;
    at[m.index] = Math.max(0, m.t - (Number(m.latencyMs) || 0) / 1000);
    current = m.index + 1;
    if (current >= events.length) return true;
    eng.arm(current);
    return false;
  });
  return at;
}

// A note worth putting to the recording: unsure, fretted, not set or
// confirmed by hand, and an ordinary pitch (a harmonic's is not open + fret).
const unsure = (n) => (n.conf ?? 1) < UNSURE && Number.isInteger(n.fret) && Number.isFinite(n.midi)
  && !(n.flags & 3) && !(n.tech || []).some((t) => t === 'harm' || t === 'x');

export function candidates(n) {
  const out = [n.fret, n.alt, n.fret - 1, n.fret + 1].filter((f) => Number.isInteger(f) && f >= 0 && f <= 24);
  return [...new Set(out)];
}

// Where to listen for event i: from just before its attack to the next
// event's, or, if it was not heard, between the events either side that were.
function stretch(i, at, dur) {
  const prev = (() => { for (let k = i - 1; k >= 0; k--) if (at[k] !== null) return at[k]; return null; })();
  const next = (() => { for (let k = i + 1; k < at.length; k++) if (at[k] !== null && (at[i] === null || at[k] > at[i] + 0.05)) return at[k]; return null; })();
  if (at[i] !== null) {
    const until = Math.max(at[i] + 0.25, Math.min(at[i] + 0.7, next !== null ? next - 0.02 : dur));
    return { arm: Math.max(0, at[i] - 0.1), until: Math.min(dur, until), near: at[i] };
  }
  const arm = prev !== null ? prev + 0.05 : 0;
  const until = next !== null ? next - 0.02 : dur;
  return until - arm >= 0.2 ? { arm, until, near: null } : null;
}

// Is this candidate event heard, struck within the stretch (and near the
// event's attack when that is known)?
function hears(pcm, sampleRate, targets, { arm, until, near }, make) {
  const eng = engineFor(make, sampleRate, targets);
  const idx = targets.length - 1;
  const a = Math.max(0, Math.round((arm - PREROLL) * sampleRate));
  const b = Math.round(arm * sampleRate);
  const c = Math.min(pcm.length, Math.round(until * sampleRate));
  feed(eng, pcm, a, b, () => false);
  eng.arm(idx);
  let ok = false;
  feed(eng, pcm, b, c, (m) => {
    if (m.type !== 'accept' || m.index !== idx) return false;
    const attack = a / sampleRate + m.t - (Number(m.latencyMs) || 0) / 1000;
    ok = near === null || Math.abs(attack - near) <= AROUND;
    return true;
  });
  return ok;
}

// The unsure digits of a page's events, put to the recording (at: from
// followTimes). Returns fixes, [system, x, string, fret] each.
export function checkDigits(pcm, sampleRate, events, at, { make }) {
  const fixes = [];
  const dur = pcm.length / sampleRate;
  events.forEach((e, i) => {
    e.notes.forEach((n, ni) => {
      if (!unsure(n)) return;
      const open = n.midi - n.fret;
      // A candidate another string of the same chord is sounding anyway
      // proves nothing.
      const others = new Set(e.notes.filter((m, k) => k !== ni && Number.isFinite(m.midi)).map((m) => m.midi));
      const cands = candidates(n).filter((f) => f === n.fret || !others.has(open + f));
      if (cands.length < 2) return;
      const where = stretch(i, at, dur);
      if (!where) return;
      // The event before is what may still be ringing; the rest of the chord
      // may or may not be heard.
      const before = i > 0 ? [targetOf(events[i - 1])] : [];
      const heard = cands.filter((f) => hears(pcm, sampleRate, [...before, {
        id: `${e.id}:${f}`,
        pitchless: false,
        notes: e.notes.map((m, k) => (k === ni
          ? { midi: open + f, string: m.string, required: true, tech: m.tech, bendTo: Number.isFinite(m.bendTo) ? m.bendTo + f - n.fret : undefined }
          : { midi: m.midi, string: m.string, required: false, tech: m.tech, bendTo: m.bendTo })),
      }], where, make));
      if (heard.length === 1 && heard[0] !== n.fret) fixes.push([e.system, r1(e.xc), n.string, heard[0]]);
    });
  });
  return fixes;
}

// The pitch the recording is in, against the one the Listen settings give.
// A fresh scan has the default settings — standard tuning, no capo — and most
// tab videos are played with a capo, which moves every note up: followed at
// the wrong pitch, almost nothing is heard (scripts/eval-listen.mjs's
// one-semitone control gets about 3 %). So the first pages are followed at
// each shift from two semitones down to seven up, and the shift that follows
// clearly the most of their events is used for every page; otherwise the
// settings' own (0). Then the low E string alone, which is the one retuned
// most often (drop D, or tuned up to F as in one of the eval videos): two
// semitones either way, judged on the events with a note on it — over more
// pages, as fewer events have one. pages: [{ pcm, events }], the first
// `first` of them for the shift. Returns { shift, low, scores, lowScores }.
export const SHIFTS = [0, 1, 2, 3, 4, 5, 6, 7, -1, -2];
const LOW_SHIFTS = [0, -1, -2, 1, 2];
export function shiftEvents(events, semis = 0, low = 0) {
  if (!semis && !low) return events;
  const up = (m, d) => (Number.isFinite(m) ? m + d : m);
  return events.map((e) => ({
    ...e,
    notes: e.notes.map((n) => {
      const d = semis + (n.string === 6 ? low : 0);
      return d ? { ...n, midi: up(n.midi, d), bendTo: up(n.bendTo, d) } : n;
    }),
  }));
}
export function probeShift(pages, { make, sampleRate = SAMPLE_RATE, shifts = SHIFTS, margin = 0.1, first = 3 }) {
  // Only what has a pitch tells shifts apart: an event with none is accepted
  // on any attack, at every shift alike.
  const pitched = pages.map(({ pcm, events }) => ({ pcm, events: events.filter((e) => !e.pitchless) }));
  const share = (semis, low, counts, upTo = pitched.length) => {
    let got = 0;
    let total = 0;
    for (const { pcm, events } of pitched.slice(0, upTo)) {
      if (!events.length) continue;
      const at = followTimes(pcm, sampleRate, shiftEvents(events, semis, low), { make });
      events.forEach((e, i) => { if (counts(e)) { total++; if (at[i] !== null) got++; } });
    }
    return { got, total, share: total ? got / total : 0 };
  };
  const pick = (scores) => {
    const base = scores[0];
    const best = scores.reduce((a, b) => (b.share > a.share ? b : a), base);
    return best.share >= base.share + margin ? best : base;
  };
  const scores = shifts.map((s) => ({ shift: s, ...share(s, 0, () => true, first) }));
  const { shift } = pick([scores.find((x) => x.shift === 0) || { shift: 0, share: 0 }, ...scores.filter((x) => x.shift !== 0)]);
  // Retuned only when it plainly is: most of the low string's notes go
  // unheard at the shift found, and another tuning of it hears a quarter of
  // them more (three at the least) and half of them in all. On the eval
  // videos that is +13 to +16 of 25 for the one tuned up to F, and at most +1
  // for the rest; a rule on fewer notes retuned a standard-tuned one.
  const onLow = (e) => e.notes.some((n) => n.string === 6 && Number.isFinite(n.midi));
  if (pitched.reduce((k, p) => k + p.events.filter(onLow).length, 0) < 3) return { shift, low: 0, scores, lowScores: [] };
  const lowScores = LOW_SHIFTS.map((l) => ({ low: l, ...share(shift, l, onLow) }));
  const base = lowScores[0];
  const bestLow = lowScores.reduce((a, b) => (b.got > a.got ? b : a), base);
  const low = base.share < 0.5 && bestLow.got >= base.got + Math.max(3, bestLow.total / 4) && bestLow.share >= 0.5 ? bestLow.low : 0;
  return { shift, low, scores, lowScores };
}

// One page: pcm is its window's audio, offset where that window starts
// relative to the page's tStart (from − tStart). events from follow.js
// buildEvents, heard shift semitones up (and the low E string low more: see
// probeShift). Returns the stored form's events ([system, x, t]) and fixes.
export function timePage({ pcm, sampleRate = SAMPLE_RATE, events: given, offset = 0, shift = 0, low = 0, digits = false, make }) {
  const events = shiftEvents(given, shift, low);
  const at = followTimes(pcm, sampleRate, events, { make });
  const timed = [];
  events.forEach((e, i) => { if (at[i] !== null) timed.push([e.system, r1(e.xc), r2(offset + at[i])]); });
  const fixes = digits ? checkDigits(pcm, sampleRate, events, at, { make }) : [];
  return { events: timed, fixes, total: events.length };
}

// Fixes found at scan time, applied to a fresh reading of the page: the note
// on that string in the nearest event at that place takes the fret the
// recording settled, if the reader is still unsure of it — certain enough
// (0.9) not to be asked about again, and marked as from the audio. A reading
// from the stored corrections never gets here (readings.js): what a person
// fixed wins. Returns the same reading when nothing applies.
export function applyFixes(reading, fixes) {
  if (!reading?.found || !Array.isArray(fixes) || !fixes.length) return reading;
  const out = { ...reading, systems: reading.systems.map((sys) => ({ ...sys, events: sys.events.map((ev) => ({ ...ev, notes: ev.notes.map((n) => ({ ...n })) })) })) };
  let changed = false;
  for (const [s, x, string, fret] of fixes) {
    const sys = out.systems[s];
    if (!sys) continue;
    const tol = sys.spacing > 0 ? 0.35 * sys.spacing : 8;
    let best = null;
    for (const ev of sys.events) {
      const d = Math.abs(ev.xc - x);
      if (d <= tol && (!best || d < best.d)) best = { ev, d };
    }
    const n = best?.ev.notes.find((m) => m.string === string);
    if (!n || !((n.conf ?? 1) < UNSURE) || n.fret === null || (n.flags & 3)) continue;
    n.fret = fret;
    n.conf = 0.9;
    n.audio = true;
    delete n.alt;
    best.ev.conf = Math.min(...best.ev.notes.map((m) => m.conf ?? 1));
    changed = true;
  }
  return changed ? out : reading;
}

// ---------------------------------------------------------------- self-check

export async function selfCheck(assert) {
  const { buildEvents } = await import('./follow.js');
  const { createEngine: make } = await import('./listen.js');
  const sr = SAMPLE_RATE;
  const TAU = Math.PI * 2;
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  // A plucked string: decaying harmonics (as listen.js checks itself with).
  const pluck = (midi, dur) => {
    const n = Math.round(dur * sr);
    const out = new Float32Array(n);
    for (let h = 1; h <= 14; h++) {
      const f = h * hz(midi) * Math.sqrt(1 + 5e-5 * h * h);
      if (f > sr * 0.45) break;
      const amp = (0.2 / h) * (h % 7 === 0 ? 0.2 : 1);
      const tau = 1.5 / (1 + 0.25 * h);
      for (let i = 0; i < n; i++) out[i] += amp * Math.exp(-i / sr / tau) * Math.sin((TAU * f * i) / sr + h);
    }
    return out;
  };
  const song = (dur, plucks) => {
    const out = new Float32Array(Math.round(dur * sr));
    for (const [t, midi] of plucks) {
      const x = pluck(midi, dur - t); // rings to the end: a cut-off tail clicks like an onset
      const s = Math.round(t * sr);
      for (let i = 0; i < x.length && s + i < out.length; i++) out[s + i] += x[i];
    }
    return out;
  };
  // The page: open E, A, D, then the G string at the 2nd fret (A3), each
  // 25 px apart on one system. Played at 0.6, 1.3, 2.0 and 2.7 s.
  const page = (third) => ({ found: true, w: 200, h: 100, systems: [{ spacing: 12, lines: [], events: [
    { x0: 10, x1: 20, xc: 15, notes: [{ string: 6, fret: 0, tech: [], conf: 0.95 }] },
    { x0: 35, x1: 45, xc: 40, notes: [{ string: 5, fret: 0, tech: [], conf: 0.95 }] },
    { x0: 60, x1: 70, xc: 65, notes: [{ string: 4, fret: 0, tech: [], conf: 0.95 }] },
    { x0: 85, x1: 95, xc: 90, notes: [{ string: 3, tech: [], ...third }] },
  ] }] });
  const plucks = [[0.6, 40], [1.3, 45], [2.0, 50], [2.7, 57]];
  const pcm = song(4, plucks);

  // Timed: every event, at its attack (within 60 ms), relative to the page.
  const sure = timePage({ pcm, events: buildEvents(page({ fret: 2, conf: 0.95 }), {}), offset: -1.5, make });
  assert.equal(sure.events.length, 4, `all four timed (${JSON.stringify(sure.events)})`);
  sure.events.forEach(([s, x, t], i) => {
    assert.equal(s, 0);
    assert.ok(Math.abs(t - (plucks[i][0] - 1.5)) <= 0.06, `event ${i} at ${t}, played at ${plucks[i][0] - 1.5}`);
  });
  assert.deepEqual(sure.events.map((e) => e[1]), [15, 40, 65, 90]);
  assert.deepEqual(sure.fixes, [], 'nothing unsure, nothing tried');

  // Played three semitones up — a capo the settings do not know about: at
  // the settings' pitch little is followed, the probe finds the shift, and
  // timed at it every event is heard again.
  const capo = song(4, plucks.map(([t, m]) => [t, m + 3]));
  const plain = buildEvents(page({ fret: 2, conf: 0.95 }), {});
  assert.ok(timePage({ pcm: capo, events: plain, make }).events.length <= 1, 'the wrong pitch is not followed');
  // (a few shifts rather than all ten keep the self-check quick)
  const probe = probeShift([{ pcm: capo, events: plain }], { make, shifts: [0, 2, 3, 4] });
  assert.equal(probe.shift, 3, `capo 3 found (${JSON.stringify(probe.scores)})`);
  assert.equal(probeShift([{ pcm, events: plain }], { make, shifts: [0, 3, -1] }).shift, 0, 'and none where there is none');
  assert.equal(timePage({ pcm: capo, events: plain, shift: 3, make }).events.length, 4);
  // Drop D: the low string's notes sound two semitones down, the rest as
  // written. The global shift stays 0 (most notes are on other strings);
  // the low string's own stage finds the −2.
  const notes = [[6, 0], [3, 2], [2, 3], [6, 3], [3, 4], [2, 1], [6, 5], [3, 2], [1, 0]];
  const mixed = { found: true, w: 400, h: 100, systems: [{ spacing: 12, lines: [], events: notes
    .map(([string, fret], i) => ({ x0: 10 + 40 * i, x1: 20 + 40 * i, xc: 15 + 40 * i, notes: [{ string, fret, tech: [], conf: 0.95 }] })) }] };
  const OPEN = [64, 59, 55, 50, 45, 38];
  const dropD = song(6, notes.map(([string, fret], i) => [0.5 + 0.6 * i, OPEN[string - 1] + fret]));
  const mixedEvents = buildEvents(mixed, {});
  const dp = probeShift([{ pcm: dropD, events: mixedEvents }], { make, shifts: [0, -2, 2] });
  assert.deepEqual([dp.shift, dp.low], [0, -2], `drop D found (${JSON.stringify(dp.scores.slice(0, 3))} ${JSON.stringify(dp.lowScores)})`);
  assert.ok(timePage({ pcm: dropD, events: mixedEvents, make }).events.length < 9);
  assert.equal(timePage({ pcm: dropD, events: mixedEvents, low: -2, make }).events.length, 9);

  // The last digit read as a 3, unsure, with an 8 as the runner-up: the
  // recording has a 2, and says so.
  const misread = buildEvents(page({ fret: 3, conf: 0.35, alt: 8 }), {});
  const got = timePage({ pcm, events: misread, digits: true, make });
  assert.deepEqual(got.fixes, [[0, 90, 3, 2]], `the 2 is heard (${JSON.stringify(got.fixes)})`);
  // Read right but unsure: kept.
  assert.deepEqual(timePage({ pcm, events: buildEvents(page({ fret: 2, conf: 0.35 }), {}), digits: true, make }).fixes, []);
  // Read as a 7 with nothing near it heard: no candidate is, nothing changes.
  assert.deepEqual(timePage({ pcm, events: buildEvents(page({ fret: 7, conf: 0.35 }), {}), digits: true, make }).fixes, []);
  assert.deepEqual(candidates({ fret: 0, alt: 6 }), [0, 6, 1]);
  assert.deepEqual(candidates({ fret: 24, alt: null }), [24, 23]);

  // Applying a fix: the unsure note takes the fret, certain and from the audio.
  const read = page({ fret: 3, conf: 0.35, alt: 8 });
  const fixed = applyFixes(read, [[0, 90.4, 3, 2]]);
  const n = fixed.systems[0].events[3].notes[0];
  assert.deepEqual([n.fret, n.conf, n.audio, n.alt], [2, 0.9, true, undefined]);
  assert.equal(read.systems[0].events[3].notes[0].fret, 3, 'the reading it was given is untouched');
  assert.equal(applyFixes(read, [[0, 96, 3, 2]]), read, 'too far from the place (spacing 12 → 4.2 px): no match');
  assert.equal(applyFixes(read, [[0, 90, 2, 2]]), read, 'no note on that string there');
  assert.equal(applyFixes(page({ fret: 3, conf: 0.95 }), [[0, 90, 3, 2]]).systems[0].events[3].notes[0].fret, 3,
    'a note the reader is now sure of is left alone');
  assert.equal(applyFixes(page({ fret: 3, conf: 0.35, flags: 1 }), [[0, 90, 3, 2]]).systems[0].events[3].notes[0].fret, 3,
    'nor one set by hand');
  assert.deepEqual(pageWindow(1, 5), { from: 0, to: 8 });
  assert.deepEqual(pageWindow(100, 300), { from: 98.5, to: 188.5 }, 'at most 90 s');
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  await selfCheck(assert);
  console.log('timing.js self-check passed');
}
